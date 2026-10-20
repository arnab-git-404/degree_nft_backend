import mongoose from "mongoose";

const NftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  symbol: {
    type: String,
    required: true,
    trim: true,
  },
  uri: {
    type: String,
    required: true,
    trim: true,
  },
  universityWallet: {
    type: String,
    required: true,
    trim: true,
  },
  studentWallet: {
    type: String,
    required: true,
    trim: true,
  },
  universityId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "University",
    index: true,
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  universityWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    index: true,
  },
  studentWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    index: true,
  },
  sellerFeeBasisPoints: {
    type: Number,
    default: 500,
  },
  minted: {
    type: Boolean,
    default: false,
  },
  allocated: {
    type: Boolean,
    default: true,
  },
  allocatedAt: {
    type: Date,
    default: Date.now,
  },
  mintedAt: {
    type: Date,
  },
  nftAddress: {
    type: String,
  },
  nftStatus: {
    type: String,
    enum: ["PENDING_CONFIRMATION", "CONFIRMED", "AUTO_CONFIRMED", "MINTED"],
    default: "PENDING_CONFIRMATION",
  },
  confirmationDeadline: {
    type: Date,
    default: function () {
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 7);
      return deadline;
    },
  },
  isConfirmed: {
    type: Boolean,
    default: false,
  },
  confirmedAt: {
    type: Date,
  },
  wasAutoConfirmed: {
    type: Boolean,
    default: false,
  },
});

export default mongoose.model("Allocated NFT Detalis", NftSchema);
