// Everything DegreeNFT does on Solana goes through here: college collections, credential assets, treasury deposits.
// CHAIN_DRIVER=fake swaps in an in-memory chain for tests (read per call, so tests can set it after import).
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import bs58 from "bs58";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createNoopSigner, createSignerFromKeypair, publicKey, signerIdentity } from "@metaplex-foundation/umi";
import { mplCore, createCollection, create, fetchAsset, fetchCollection, transfer, burn } from "@metaplex-foundation/mpl-core";
import AppError from "./AppError.js";

export const network = () => (process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet" : "devnet");
const rpcUrl = () =>
  process.env.SOLANA_RPC_URL || (network() === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
// Circle USDC. Devnet test USDC comes from faucet.circle.com.
export const usdcMint = () =>
  process.env.USDC_MINT ||
  (network() === "mainnet" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// A college collection lives on one network; never act on it while the server points at another.
export const assertSameNetwork = (record) => {
  if (record.network !== network()) {
    throw new AppError(`This college's collection is on ${record.network}, but the server is running on ${network()}`, 409);
  }
};

// Below this the fee wallet cannot be trusted to finish a mint: claims pause instead of failing half-way.
export const FEE_PAYER_MIN_LAMPORTS = Math.round(Number(process.env.FEE_PAYER_MIN_SOL || 0.05) * 1e9);

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
const readUmi = () => createUmi(rpcUrl(), "confirmed").use(mplCore());

// Every on-chain WRITE signs here. On Mainnet the college keys are still platform-held in the database
// (see models/collegeChain.js), so writes stay locked until proper key custody is in place and approved.
export const signingLocked = () => network() === "mainnet" && process.env.MAINNET_KEY_CUSTODY_APPROVED !== "true";
export const assertSigningAllowed = () => {
  if (signingLocked()) {
    throw new AppError("Mainnet writes are locked until MAINNET_KEY_CUSTODY_APPROVED=true is set on the server", 503);
  }
};

const umiWithFeePayer = () => {
  assertSigningAllowed();
  const umi = readUmi();
  const payer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(feePayerSecret()));
  return umi.use(signerIdentity(payer));
};
const feePayerKeypair = () => {
  assertSigningAllowed();
  return Keypair.fromSecretKey(feePayerSecret());
};
// confirmTransaction resolves even when the transaction failed on-chain: check its error too.
const confirmOk = async (connection, signature) => {
  const { value } = await connection.confirmTransaction(signature, "confirmed");
  if (value.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(value.err)}`);
};
const signerFrom = (umi, secret) => createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(bs58.decode(secret)));
const confirmed = { confirm: { commitment: "confirmed" } };

// Public RPCs answer 429 when called too fast: wait and try again (1s, 2s, 4s) before giving up.
const withRpcRetry = async (call) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const limited = error?.code === 429 || /429|Too many requests/i.test(String(error?.message));
      if (!limited || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
};

const real = {
  newKeypair() {
    const umi = createUmi(rpcUrl());
    const keypair = umi.eddsa.generateKeypair();
    return { address: String(keypair.publicKey), secret: bs58.encode(keypair.secretKey) };
  },

  async feePayerBalance() {
    const umi = readUmi();
    const { publicKey } = umi.eddsa.createKeypairFromSecretKey(feePayerSecret());
    return { address: String(publicKey), lamports: Number((await umi.rpc.getBalance(publicKey)).basisPoints) };
  },

  // The college collection, as proven on Devnet (solana-poc/FINDINGS.md, custody-check.mjs):
  // frozen forever with NO freeze key; only the college's multisig vault (officials' 2-of-N approvals) can move or
  // burn a credential; the minting key can only mint and update metadata.
  async createCollection({ name, uri, mintingAddress, vaultAddress }) {
    const umi = umiWithFeePayer();
    const collection = createSignerFromKeypair(umi, umi.eddsa.generateKeypair());
    const vault = { type: "Address", address: vaultAddress };
    const { signature } = await createCollection(umi, {
      collection,
      name,
      uri,
      updateAuthority: mintingAddress,
      plugins: [
        { type: "PermanentFreezeDelegate", frozen: true, authority: { type: "None" } },
        { type: "PermanentTransferDelegate", authority: vault },
        { type: "PermanentBurnDelegate", authority: vault },
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

  // ---- Squads v4 multisig: the college officials who approve recoveries and burns.
  // Officials may vote and execute; the platform may only propose and execute (never approve), so it cannot act alone.
  async createMultisig({ members, threshold }) {
    const payer = feePayerKeypair();
    const connection = new Connection(rpcUrl(), "confirmed");
    const createKey = Keypair.generate();
    const [multisigPda] = squads.getMultisigPda({ createKey: createKey.publicKey });
    const [vault] = squads.getVaultPda({ multisigPda, index: 0 });
    const programConfig = await squads.accounts.ProgramConfig.fromAccountAddress(connection, squads.getProgramConfigPda({})[0]);
    const { Permission, Permissions } = squads.types;
    const signature = await squads.rpc.multisigCreateV2({
      connection,
      treasury: programConfig.treasury,
      createKey,
      creator: payer,
      multisigPda,
      configAuthority: null,
      threshold,
      members: [
        { key: payer.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Execute]) },
        ...members.map((member) => ({ key: new PublicKey(member), permissions: Permissions.fromPermissions([Permission.Vote, Permission.Execute]) })),
      ],
      timeLock: 0,
      rentCollector: null,
    });
    await confirmOk(connection, signature);
    // The vault signs the Core instructions it runs; a little SOL covers any account reallocation.
    await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 5_000_000 })), [payer]);
    return { multisigAddress: multisigPda.toBase58(), vaultAddress: vault.toBase58(), signature };
  },

  // Puts the actions (move to a new wallet / burn) in one vault transaction and opens a proposal for the officials.
  async proposeVaultActions({ multisigAddress, vaultAddress, actions }) {
    const payer = feePayerKeypair();
    const connection = new Connection(rpcUrl(), "confirmed");
    const multisigPda = new PublicKey(multisigAddress);
    const umi = readUmi();
    const vault = createNoopSigner(publicKey(vaultAddress));
    const instructions = [];
    for (const action of actions) {
      const asset = await fetchAsset(umi, action.assetAddress);
      const collection = await fetchCollection(umi, action.collectionAddress);
      const builder =
        action.kind === "transfer"
          ? transfer(umi, { asset, collection, newOwner: publicKey(action.newOwner), authority: vault, payer: vault })
          : burn(umi, { asset, collection, authority: vault, payer: vault });
      instructions.push(...builder.getInstructions().map(toWeb3JsInstruction));
    }
    const account = await squads.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const transactionIndex = BigInt(account.transactionIndex.toString()) + 1n;
    const { blockhash } = await connection.getLatestBlockhash();
    await confirmOk(
      connection,
      await squads.rpc.vaultTransactionCreate({
        connection,
        feePayer: payer,
        multisigPda,
        transactionIndex,
        creator: payer.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: new TransactionMessage({ payerKey: new PublicKey(vaultAddress), recentBlockhash: blockhash, instructions }),
      }),
    );
    await confirmOk(connection, await squads.rpc.proposalCreate({ connection, feePayer: payer, multisigPda, transactionIndex, creator: payer }));
    return { transactionIndex: transactionIndex.toString() };
  },

  // An approval transaction for one official: the platform pays the fee (signs now), the official signs in their wallet.
  async buildApprovalTx({ multisigAddress, transactionIndex, member }) {
    const payer = feePayerKeypair();
    const connection = new Connection(rpcUrl(), "confirmed");
    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = squads.transactions.proposalApprove({
      blockhash,
      feePayer: payer.publicKey,
      multisigPda: new PublicKey(multisigAddress),
      transactionIndex: BigInt(transactionIndex),
      member: new PublicKey(member),
    });
    transaction.sign([payer]);
    return Buffer.from(transaction.serialize()).toString("base64");
  },

  // Sends an official's signed approval, but only if it is exactly the approval we built (nothing added or changed).
  async submitApprovalTx({ multisigAddress, transactionIndex, member, signedTransaction }) {
    const payer = feePayerKeypair();
    const connection = new Connection(rpcUrl(), "confirmed");
    const transaction = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
    const expected = squads.transactions.proposalApprove({
      blockhash: transaction.message.recentBlockhash,
      feePayer: payer.publicKey,
      multisigPda: new PublicKey(multisigAddress),
      transactionIndex: BigInt(transactionIndex),
      member: new PublicKey(member),
    });
    if (!Buffer.from(transaction.message.serialize()).equals(Buffer.from(expected.message.serialize()))) {
      throw new AppError("That is not the approval transaction for this request", 400);
    }
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await confirmOk(connection, signature);
    return { signature };
  },

  // { status: "Active" | "Approved" | "Executed" | ..., approved: [addresses] }, or null when there is no proposal.
  async getProposal({ multisigAddress, transactionIndex }) {
    const connection = new Connection(rpcUrl(), "confirmed");
    const [proposalPda] = squads.getProposalPda({ multisigPda: new PublicKey(multisigAddress), transactionIndex: BigInt(transactionIndex) });
    try {
      const proposal = await squads.accounts.Proposal.fromAccountAddress(connection, proposalPda);
      return { status: proposal.status.__kind, approved: proposal.approved.map((key) => key.toBase58()) };
    } catch (error) {
      if (/Unable to find|could not find|account.*not.*found/i.test(String(error?.message))) return null;
      throw error;
    }
  },

  // Runs an approved proposal (the platform may execute, never approve).
  async executeProposal({ multisigAddress, transactionIndex }) {
    const payer = feePayerKeypair();
    const connection = new Connection(rpcUrl(), "confirmed");
    const signature = await squads.rpc.vaultTransactionExecute({
      connection,
      feePayer: payer,
      multisigPda: new PublicKey(multisigAddress),
      transactionIndex: BigInt(transactionIndex),
      member: payer.publicKey,
    });
    await confirmOk(connection, signature);
    return { signature };
  },

  // null when the asset does not exist (never minted, or burned). An RPC failure throws, so callers never
  // mistake "the chain is unreachable" for "the credential does not exist".
  async getAsset(address) {
    const umi = readUmi();
    try {
      const asset = await fetchAsset(umi, address);
      return { owner: String(asset.owner), collection: String(asset.updateAuthority.address) };
    } catch (error) {
      if (error?.name === "AccountNotFoundError") return null;
      // A burned Core asset leaves a tiny marker account that is no longer an asset: that is "gone", not an RPC failure.
      const account = await umi.rpc.getAccount(address); // throws if the RPC is really down
      if (!account.exists || account.data.length <= 1) return null;
      throw error;
    }
  },

  // Payments into the treasury from one college wallet: SOL transfers and USDC token transfers.
  // Reads the COLLEGE wallet's own history (every payment is signed by it), not the shared treasury's, and skips
  // transactions already credited, so a routine check costs almost no RPC calls.
  // shortcut: looks at the wallet's latest 100 transactions; page further back if a college wallet is very busy.
  async findDeposits({ from, knownSignatures = new Set() }) {
    const connection = new Connection(rpcUrl(), "confirmed");
    const treasury = treasuryAddress();
    const treasuryUsdc = tokenAccountOf(treasury, usdcMint());
    const found = new Map(); // `${signature}:${currency}` -> deposit

    {
      const signatures = await withRpcRetry(() => connection.getSignaturesForAddress(new PublicKey(from), { limit: 100 }));
      const ok = signatures.filter((entry) => !entry.err && !knownSignatures.has(entry.signature)).map((entry) => entry.signature);
      for (let i = 0; i < ok.length; i += 5) {
        const transactions = await withRpcRetry(() => connection.getParsedTransactions(ok.slice(i, i + 5), { maxSupportedTransactionVersion: 0 }));
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
  multisigs: new Map(), // address -> { members, threshold, proposals: Map(index -> { actions, approved:Set, status }) }
  async createMultisig({ members, threshold }) {
    const multisigAddress = fakeAddress();
    fakeChain.multisigs.set(multisigAddress, { members, threshold, next: 1, proposals: new Map() });
    return { multisigAddress, vaultAddress: fakeAddress(), signature: fakeAddress() };
  },
  async proposeVaultActions({ multisigAddress, actions }) {
    const multisig = fakeChain.multisigs.get(multisigAddress);
    const transactionIndex = String(multisig.next++);
    multisig.proposals.set(transactionIndex, { actions, approved: new Set(), status: "Active" });
    return { transactionIndex };
  },
  // A fake "transaction" is the JSON of what it approves; the test "signs" it by sending it back.
  buildApprovalTx: async ({ multisigAddress, transactionIndex, member }) =>
    Buffer.from(JSON.stringify({ multisigAddress, transactionIndex, member })).toString("base64"),
  async submitApprovalTx({ multisigAddress, transactionIndex, member, signedTransaction }) {
    const sent = JSON.parse(Buffer.from(signedTransaction, "base64").toString());
    if (sent.multisigAddress !== multisigAddress || sent.transactionIndex !== String(transactionIndex) || sent.member !== member) {
      throw new AppError("That is not the approval transaction for this request", 400);
    }
    const multisig = fakeChain.multisigs.get(multisigAddress);
    const proposal = multisig.proposals.get(String(transactionIndex));
    if (!multisig.members.includes(member)) throw new Error("fake: not a member");
    if (proposal.approved.has(member)) throw new Error("fake: AlreadyApproved");
    proposal.approved.add(member);
    if (proposal.approved.size >= multisig.threshold) proposal.status = "Approved";
    return { signature: fakeAddress() };
  },
  async getProposal({ multisigAddress, transactionIndex }) {
    const proposal = fakeChain.multisigs.get(multisigAddress)?.proposals.get(String(transactionIndex));
    return proposal ? { status: proposal.status, approved: [...proposal.approved] } : null;
  },
  async executeProposal({ multisigAddress, transactionIndex }) {
    const proposal = fakeChain.multisigs.get(multisigAddress).proposals.get(String(transactionIndex));
    if (proposal.status !== "Approved") throw new Error("fake: InvalidProposalStatus");
    if (fakeChain.failNextExecute) {
      fakeChain.failNextExecute = false;
      throw new Error("fake RPC failure");
    }
    for (const action of proposal.actions) {
      if (action.kind === "transfer") fakeChain.assets.get(action.assetAddress).owner = String(action.newOwner);
      else fakeChain.assets.delete(action.assetAddress);
    }
    proposal.status = "Executed";
    return { signature: fakeAddress() };
  },
  failNextExecute: false,
  rpcDown: false, // tests: the chain is unreachable
  async getAsset(address) {
    if (fakeChain.rpcDown) throw new Error("fake: RPC unreachable");
    return fakeChain.assets.has(address) ? { ...fakeChain.assets.get(address) } : null;
  },
  findDeposits: async ({ from }) => fakeChain.deposits.filter((deposit) => deposit.from === from),
};

export const chain = new Proxy({}, { get: (_, key) => (process.env.CHAIN_DRIVER === "fake" ? fakeChain : real)[key] });
