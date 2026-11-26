import mongoose from "mongoose";

export const NFT_STATUSES = ["MINTING", "MINTED", "FAILED", "BURNED"];

// The on-chain side of one credential: its Metaplex Core asset. Created when the student claims.
// The academic record stays in Credential; this keeps what was actually minted, to whom, and what happened since.
const NftSchema = new mongoose.Schema(
  {
    credentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Credential",
      required: true,
      unique: true,
      immutable: true,
    },
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    network: {
      type: String,
      enum: ["devnet", "mainnet"],
      required: true,
      immutable: true,
    },
    collectionAddress: { type: String, required: true, immutable: true },
    // Chosen before sending, so a timed-out mint can be checked on-chain instead of minted twice.
    assetAddress: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
    },
    assetSecretEncrypted: { type: String, select: false }, // only until minted, to retry the same asset
    ownerWallet: { type: String, required: true },
    // What was minted: the credential revision and metadata at that moment.
    revision: { type: Number, required: true, immutable: true },
    uri: { type: String, required: true, immutable: true },
    contentHash: { type: String, immutable: true },
    status: {
      type: String,
      enum: NFT_STATUSES,
      default: "MINTING",
      required: true,
      index: true,
    },
    mintSignature: { type: String },
    mintedAt: { type: Date },
    charge: { currency: String, amount: Number },
    attempts: [
      {
        _id: false,
        at: Date,
        outcome: { type: String, enum: ["SENT", "FAILED", "FOUND_ON_CHAIN"] },
        signature: String,
        error: String,
      },
    ],
    ownerHistory: [
      {
        _id: false,
        wallet: String,
        at: Date,
        reason: String,
        signature: String,
      },
    ],
  },
  { timestamps: true },
);

NftSchema.index({ institutionId: 1, createdAt: -1 });

export default mongoose.model("Nft", NftSchema);
