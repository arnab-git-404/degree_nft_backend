import mongoose from "mongoose";

const WalletSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    chain: {
      type: String,
      enum: ["solana"],
      default: "solana",
      required: true,
    },
    label: {
      type: String,
      trim: true,
      default: "",
    },
    isPrimary: {
      type: Boolean,
      default: false,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

WalletSchema.index({ chain: 1, address: 1 }, { unique: true });
WalletSchema.index(
  { userId: 1, isPrimary: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true } }
);

export default mongoose.model("Wallet", WalletSchema);
