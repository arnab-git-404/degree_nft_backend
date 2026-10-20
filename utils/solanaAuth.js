import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

export const buildAuthMessage = (walletAddress, nonce) =>
  [
    "DegreeNFT Authentication",
    "",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    "",
    "Sign this message to prove ownership of this wallet.",
    "This will not trigger a blockchain transaction or cost any fees.",
  ].join("\n");

export const isValidSolanaAddress = (address) => {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
};

const decodeSignature = (signature, encoding = "base64") => {
  if (encoding === "bs58") {
    return bs58.decode(signature);
  }

  return Buffer.from(signature, "base64");
};

export const verifyWalletSignature = ({
  walletAddress,
  message,
  signature,
  encoding = "base64",
}) => {
  const publicKey = new PublicKey(walletAddress).toBytes();
  const signatureBytes = decodeSignature(signature, encoding);

  return nacl.sign.detached.verify(
    Buffer.from(message, "utf8"),
    signatureBytes,
    publicKey
  );
};
