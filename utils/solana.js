import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

const getConnection = () =>
  new Connection(
    process.env.SOLANA_RPC_URL ||
      clusterApiUrl(process.env.SOLANA_CLUSTER === "mainnet" ? "mainnet-beta" : "devnet"),
    "confirmed"
  );

// Metaplex Metadata v1 layout: key(1) updateAuthority(32) mint(32) then u32-length-prefixed name, symbol, uri.
export const parseMetadataUri = (data) => {
  let offset = 1 + 32 + 32;
  const readString = () => {
    const length = data.readUInt32LE(offset);
    offset += 4;
    const value = data.subarray(offset, offset + length).toString("utf8");
    offset += length;
    return value.replace(/\0/g, "").trim();
  };
  readString(); // name
  readString(); // symbol
  return readString();
};

/**
 * Reads the chain (never the client) to prove `mintAddress` is a 1-of-1 NFT,
 * held by `ownerAddress`, whose Metaplex metadata URI is `expectedUri`.
 * Throws an Error with a user-safe message when any check fails.
 */
export const verifyCredentialMint = async ({ mintAddress, ownerAddress, expectedUri }) => {
  const connection = getConnection();
  const mint = new PublicKey(mintAddress);

  const mintInfo = (await connection.getParsedAccountInfo(mint)).value;
  const parsedMint = mintInfo?.data?.parsed;
  if (parsedMint?.type !== "mint") throw new Error("Mint account not found on-chain");
  if (parsedMint.info.decimals !== 0 || parsedMint.info.supply !== "1") {
    throw new Error("Mint is not a single NFT");
  }

  const holdings = await connection.getParsedTokenAccountsByOwner(
    new PublicKey(ownerAddress),
    { mint }
  );
  const held = holdings.value.some(
    (account) => account.account.data.parsed.info.tokenAmount.amount === "1"
  );
  if (!held) throw new Error("NFT is not held by the student wallet");

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  const metadataAccount = await connection.getAccountInfo(metadataPda);
  if (!metadataAccount) throw new Error("NFT metadata not found on-chain");
  if (parseMetadataUri(metadataAccount.data) !== expectedUri) {
    throw new Error("NFT metadata does not match the allocated credential");
  }
};
