import mongoose from "mongoose";

export const STUDENT_STATUSES = ["ACTIVE", "INACTIVE"];

// Empty strings become "not set", so optional fields can be cleared and the unique index ignores them.
const optional = (value) =>
  value == null || String(value).trim() === ""
    ? undefined
    : String(value).trim();

// One profile per student per college (design §8.11). Courses are enrollments (P05-04), not new profiles.
// Not the same as the legacy StudentDetails collection, which only caches wallet/NFT allocation counts.
const StudentSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    // Linked only after a verified identity claim (P05-06); never set from a name or email match.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Plain messages: they are shown as-is next to each row of an Excel import.
    fullName: {
      type: String,
      required: [true, "Full name is required"],
      trim: true,
      maxlength: [120, "Full name is too long (120 characters at most)"],
    },
    // The college's own registration / roll number; unique within the college when given.
    registrationNo: {
      type: String,
      set: optional,
      uppercase: true,
      maxlength: [40, "Registration no. is too long (40 characters at most)"],
    },
    // Required when a student is added (the wallet invite goes here). Older students may have none.
    email: {
      type: String,
      set: optional,
      lowercase: true,
      required: [function requiredWhenNew() { return this.isNew; }, "Email is required"],
      maxlength: [200, "Email is too long"],
      match: [/^\S+@\S+\.\S+$/, "Enter a valid email address"],
    },
    // The wallet the college expects (optional, unverified). The student's own signed wallet is what counts.
    walletHint: {
      type: String,
      set: optional,
      match: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Enter a valid Solana wallet address"],
    },
    // Wallet invite: only the hash of the emailed link is kept. Linked (userId set) once the student signs with a wallet.
    inviteTokenHash: { type: String, select: false, index: true, sparse: true },
    invitedAt: { type: Date },
    inviteExpiresAt: { type: Date },
    claimedAt: { type: Date },
    phone: {
      type: String,
      set: optional,
      match: [/^[+0-9 ()-]{6,20}$/, "Enter a valid phone number"],
    },
    studentStatus: {
      type: String,
      enum: {
        values: STUDENT_STATUSES,
        message: "Status must be Active or Inactive",
      },
      default: "ACTIVE",
      required: true,
    },
  },
  { timestamps: true },
);

StudentSchema.index(
  { institutionId: 1, registrationNo: 1 },
  {
    unique: true,
    partialFilterExpression: { registrationNo: { $type: "string" } },
  },
);
StudentSchema.index({ institutionId: 1, createdAt: -1 });

export default mongoose.model("Student", StudentSchema);
