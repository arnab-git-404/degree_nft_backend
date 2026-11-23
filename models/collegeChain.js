import mongoose from "mongoose";

// A college's on-chain setup: its Metaplex Core collection and the four keys that control it.
// Created once by the Super Admin; the collection's permissions are fixed at creation (see solana-poc/FINDINGS.md).
const key = {
  address: { type: String, required: true },
  // Encrypted with utils/secretBox. shortcut: platform-held keys in the DB; move to a KMS/HSM before Mainnet.
  secretEncrypted: { type: String, required: true, select: false },
};

const CollegeChainSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      unique: true,
      immutable: true,
    },
    network: {
      type: String,
      enum: ["devnet", "mainnet"],
      required: true,
      immutable: true,
    },
    collectionAddress: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
    },
    setupSignature: { type: String },
    keys: {
      minting: key, // collection update authority: mints and updates metadata, cannot move or burn
      freeze: key, // can unfreeze the WHOLE collection: the most sensitive key
      recovery: key, // moves a frozen asset to a new wallet (lost wallet)
      burn: key, // exceptional destruction
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export default mongoose.model("CollegeChain", CollegeChainSchema);
