const mongoose = require("mongoose");

const UniversitySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    walletAddress: {
      type: String,
      required: true,
      trim: true,
    },
    walletId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Wallet",
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    website: {
      type: String,
      trim: true,
    },
    logoUrl: {
      type: String,
      trim: true,
    },
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true },
      postalCode: { type: String, trim: true },
    },
    accreditation: {
      type: String,
      trim: true,
    },
    verificationStatus: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    totalAllocated: {
      type: Number,
      default: 0,
    },
    totalMinted: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

UniversitySchema.index({ name: 1 });

module.exports = mongoose.model("University", UniversitySchema);
