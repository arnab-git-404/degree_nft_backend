import mongoose from "mongoose";

const AuthNonceSchema = new mongoose.Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    nonce: {
      type: String,
      required: true,
      unique: true,
    },
    message: {
      type: String,
      required: true,
    },
    used: {
      type: Boolean,
      default: false,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

AuthNonceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model("AuthNonce", AuthNonceSchema);
