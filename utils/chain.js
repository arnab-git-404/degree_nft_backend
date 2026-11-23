// Everything DegreeNFT does on Solana goes through here: college collections, credential assets, treasury deposits.
// CHAIN_DRIVER=fake swaps in an in-memory chain for tests (read per call, so tests can set it after import).
import { randomBytes } from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity } from "@metaplex-foundation/umi";
import { mplCore, createCollection, create, fetchAsset, fetchCollection, transfer, burn } from "@metaplex-foundation/mpl-core";
import AppError from "./AppError.js";

export const network = () => (process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet");
const rpcUrl = () =>
  process.env.SOLANA_RPC_URL || (network() === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
// Circle USDC. Devnet test USDC comes from faucet.circle.com.
export const usdcMint = () =>
  process.env.USDC_MINT ||
  (network() === "mainnet" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

export const treasuryAddress = () => {
  const address = process.env.DEGREENFT_TREASURY_ADDRESS;
  if (!address) throw new AppError("DEGREENFT_TREASURY_ADDRESS is not configured on the server", 503);
  return address;
};

// The platform wallet that pays every chain fee and rent. Base58 secret key, or a JSON byte array.
const feePayerSecret = () => {
  const raw = (process.env.PLATFORM_FEE_PAYER_SECRET_KEY || "").trim();
  if (!raw) throw new AppError("PLATFORM_FEE_PAYER_SECRET_KEY is not configured on the server", 503);
  return raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
};

// A Solana secret key is 64 bytes: the 32-byte seed followed by the 32-byte public key.
export const addressOfSecret = (secret) => bs58.encode(bs58.decode(secret).subarray(32));

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const tokenAccountOf = (owner, mint) =>
  PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0].toBase58();

// ---------------------------------------------------------------- real Solana
const umiWithFeePayer = () => {
  const umi = createUmi(rpcUrl(), "confirmed").use(mplCore());
  const payer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(feePayerSecret()));
  return umi.use(signerIdentity(payer));
};
const signerFrom = (umi, secret) => createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(bs58.decode(secret)));
const confirmed = { confirm: { commitment: "confirmed" } };

const real = {
  newKeypair() {
    const umi = createUmi(rpcUrl());
    const keypair = umi.eddsa.generateKeypair();
    return { address: String(keypair.publicKey), secret: bs58.encode(keypair.secretKey) };
  },

  async feePayerBalance() {
    const umi = umiWithFeePayer();
    return { address: String(umi.identity.publicKey), lamports: Number((await umi.rpc.getBalance(umi.identity.publicKey)).basisPoints) };
  },

  // The college collection, configured as proven on Devnet (solana-poc/FINDINGS.md): students can't move or burn,
  // the recovery key can move a frozen asset, only the burn key can burn, the minting key can do neither.
  async createCollection({ name, uri, keys }) {
    const umi = umiWithFeePayer();
    const collection = createSignerFromKeypair(umi, umi.eddsa.generateKeypair());
    const address = (key) => ({ type: "Address", address: keys[key] });
    const { signature } = await createCollection(umi, {
      collection,
      name,
      uri,
      updateAuthority: keys.minting,
      plugins: [
        { type: "PermanentFreezeDelegate", frozen: true, authority: address("freeze") },
        { type: "PermanentTransferDelegate", authority: address("recovery") },
        { type: "PermanentBurnDelegate", authority: address("burn") },
      ],
    }).sendAndConfirm(umi, confirmed);
    return { collectionAddress: String(collection.publicKey), signature: bs58.encode(signature) };
  },

  async mintAsset({ assetSecret, collectionAddress, mintingSecret, owner, name, uri }) {
    const umi = umiWithFeePayer();
    const { signature } = await create(umi, {
      asset: signerFrom(umi, assetSecret),
      collection: await fetchCollection(umi, collectionAddress),
      authority: signerFrom(umi, mintingSecret),
      owner,
      name,
      uri,
    }).sendAndConfirm(umi, confirmed);
    return { signature: bs58.encode(signature) };
  },

  // Lost wallet: the recovery key moves the (frozen) asset; the old owner does not sign.
  async transferAsset({ assetAddress, collectionAddress, recoverySecret, newOwner }) {
    const umi = umiWithFeePayer();
    const { signature } = await transfer(umi, {
      asset: await fetchAsset(umi, assetAddress),
      collection: await fetchCollection(umi, collectionAddress),
      newOwner,
      authority: signerFrom(umi, recoverySecret),
    }).sendAndConfirm(umi, confirmed);
    return { signature: bs58.encode(signature) };
  },

  async burnAsset({ assetAddress, collectionAddress, burnSecret }) {
    const umi = umiWithFeePayer();
    const { signature } = await burn(umi, {
      asset: await fetchAsset(umi, assetAddress),
      collection: await fetchCollection(umi, collectionAddress),
      authority: signerFrom(umi, burnSecret),
    }).sendAndConfirm(umi, confirmed);
    return { signature: bs58.encode(signature) };
  },

  // null when the asset does not exist (never minted, or burned). An RPC failure throws, so callers never
  // mistake "the chain is unreachable" for "the credential does not exist".
  async getAsset(address) {
    try {
      const asset = await fetchAsset(umiWithFeePayer(), address);
      return { owner: String(asset.owner), collection: String(asset.updateAuthority.address) };
    } catch (error) {
      if (error?.name === "AccountNotFoundError") return null;
      throw error;
    }
  },

  // Payments into the treasury from one wallet: SOL transfers and USDC token transfers, newest first.
  // shortcut: reads the latest 100 transactions per account; page further back if a college pays very often.
  async findDeposits({ from }) {
    const connection = new Connection(rpcUrl(), "confirmed");
    const treasury = treasuryAddress();
    const treasuryUsdc = tokenAccountOf(treasury, usdcMint());
    const found = new Map(); // `${signature}:${currency}` -> deposit

    for (const account of [treasury, treasuryUsdc]) {
      const signatures = await connection.getSignaturesForAddress(new PublicKey(account), { limit: 100 });
      const ok = signatures.filter((entry) => !entry.err).map((entry) => entry.signature);
      for (let i = 0; i < ok.length; i += 25) {
        const transactions = await connection.getParsedTransactions(ok.slice(i, i + 25), { maxSupportedTransactionVersion: 0 });
        transactions.forEach((transaction, index) => {
          if (!transaction || transaction.meta?.err) return;
          const signature = ok[i + index];
          const instructions = [
            ...transaction.transaction.message.instructions,
            ...(transaction.meta?.innerInstructions || []).flatMap((inner) => inner.instructions),
          ];
          for (const { program, parsed } of instructions) {
            const info = parsed?.info;
            let currency, amount;
            if (program === "system" && parsed.type === "transfer" && info.source === from && info.destination === treasury) {
              [currency, amount] = ["SOL", Number(info.lamports)];
            } else if (
              program === "spl-token" &&
              ["transfer", "transferChecked"].includes(parsed.type) &&
              info.destination === treasuryUsdc &&
              (info.authority === from || info.multisigAuthority === from) &&
              (parsed.type === "transfer" || info.mint === usdcMint())
            ) {
              [currency, amount] = ["USDC", Number(info.tokenAmount?.amount ?? info.amount)];
            }
            if (!currency || !(amount > 0)) continue;
            const key = `${signature}:${currency}`;
            const deposit = found.get(key) || { signature, currency, amount: 0, from, at: transaction.blockTime ? new Date(transaction.blockTime * 1000) : new Date() };
            deposit.amount += amount;
            found.set(key, deposit);
          }
        });
      }
    }
    return [...found.values()];
  },
};

// ---------------------------------------------------------------- in-memory chain for tests
const fakeAddress = () => bs58.encode(randomBytes(32));
export const fakeChain = {
  assets: new Map(),
  deposits: [], // tests push { signature, currency, amount, from }
  failNextMint: false,
  newKeypair() {
    const secret = bs58.encode(randomBytes(64));
    return { address: addressOfSecret(secret), secret };
  },
  feePayerBalance: async () => ({ address: "FakeFeePayer", lamports: 5e9 }),
  createCollection: async () => ({ collectionAddress: fakeAddress(), signature: fakeAddress() }),
  async mintAsset({ assetSecret, collectionAddress, owner }) {
    if (fakeChain.failNextMint) {
      fakeChain.failNextMint = false;
      throw new Error("fake RPC failure");
    }
    fakeChain.assets.set(addressOfSecret(assetSecret), { owner: String(owner), collection: collectionAddress });
    return { signature: fakeAddress() };
  },
  async transferAsset({ assetAddress, newOwner }) {
    const asset = fakeChain.assets.get(assetAddress);
    if (!asset) throw new Error("fake: asset not found");
    asset.owner = String(newOwner);
    return { signature: fakeAddress() };
  },
  async burnAsset({ assetAddress }) {
    if (!fakeChain.assets.delete(assetAddress)) throw new Error("fake: asset not found");
    return { signature: fakeAddress() };
  },
  rpcDown: false, // tests: the chain is unreachable
  async getAsset(address) {
    if (fakeChain.rpcDown) throw new Error("fake: RPC unreachable");
    return fakeChain.assets.has(address) ? { ...fakeChain.assets.get(address) } : null;
  },
  findDeposits: async ({ from }) => fakeChain.deposits.filter((deposit) => deposit.from === from),
};

export const chain = new Proxy({}, { get: (_, key) => (process.env.CHAIN_DRIVER === "fake" ? fakeChain : real)[key] });
