import mongoose from "mongoose";

// An application exists before any account or wallet, so it is kept apart from University.
const UniversityApplicationSchema = new mongoose.Schema(
  {
    linkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RegistrationLink",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    contactName: { type: String, required: true, trim: true },
    walletAddress: { type: String, required: true, trim: true, index: true },
    phone: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    accreditation: { type: String, trim: true, default: "" },
    address: {
      city: { type: String, trim: true, default: "" },
      state: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model(
  "UniversityApplication",
  UniversityApplicationSchema,
);
