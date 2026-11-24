import mongoose from "mongoose";

// A college's on-chain setup: its Metaplex Core collection, the minting key, and the officials' multisig.
// Created once by the Super Admin; the collection's permissions are fixed at creation (see solana-poc/FINDINGS.md):
// frozen forever with no freeze key, and only the multisig vault can move (recover) or burn a credential.
const CollegeChainSchema = new mongoose.Schema(
  {
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", required: true, unique: true, immutable: true },
    network: { type: String, enum: ["devnet", "mainnet"], required: true, immutable: true },
    collectionAddress: { type: String, required: true, unique: true, immutable: true },
    setupSignature: { type: String },
    keys: {
      // Collection update authority: mints and updates metadata, cannot move or burn. The only key the server holds.
      minting: {
        address: { type: String, required: true },
        // Encrypted with utils/secretBox. shortcut: server-held hot key; acceptable because it cannot move or burn.
        secretEncrypted: { type: String, required: true, select: false },
      },
    },
    // Squads v4 multisig of the college's officials: any `threshold` of them must approve a recovery or burn.
    multisig: {
      address: { type: String, required: true },
      vault: { type: String, required: true }, // the recovery + burn authority on the collection
      threshold: { type: Number, required: true, min: 2 },
      members: { type: [String], required: true },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export default mongoose.model("CollegeChain", CollegeChainSchema);
