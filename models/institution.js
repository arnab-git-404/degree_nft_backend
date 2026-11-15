import mongoose from "mongoose";

export const INSTITUTION_TYPES = ["COLLEGE"];
export const INSTITUTION_STATUSES = ["ACTIVE", "SUSPENDED"];

// Tenant registry: one document per college. Every tenant-owned record carries its _id as institutionId.
const InstitutionSchema = new mongoose.Schema(
  {
    // Legacy owner from the self-serve profile flow; access now comes from institutionMemberships.
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
    institutionType: {
      type: String,
      enum: INSTITUTION_TYPES,
      default: "COLLEGE",
      required: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    status: {
      type: String,
      enum: INSTITUTION_STATUSES,
      default: "ACTIVE",
      required: true,
      index: true,
    },
    // Onboarding state until P03 replaces it with application approval.
    verificationStatus: {
      type: String,
      enum: ["PENDING", "VERIFIED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstitutionApplication",
    },
    primaryAdminMembershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstitutionMembership",
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

InstitutionSchema.index({ name: 1 });

export default mongoose.model("Institution", InstitutionSchema);
