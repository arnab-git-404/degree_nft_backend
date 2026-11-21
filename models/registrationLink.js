import mongoose from "mongoose";

const RegistrationLinkSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    // After this the link stops accepting applications (null = never, for links made before expiry existed).
    expiresAt: {
      type: Date,
      default: null,
    },
    submissionCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

export default mongoose.model("RegistrationLink", RegistrationLinkSchema);
