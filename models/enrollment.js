import mongoose from "mongoose";

export const ENROLLMENT_STATUSES = ["ENROLLED", "COMPLETED", "CANCELLED"];

const optional = (value) =>
  value == null || String(value).trim() === ""
    ? undefined
    : String(value).trim();

// One student profile in one batch (design §8.12). Credentials (P06) will hang off an enrollment.
// Student, batch and program never change: a wrong enrollment is cancelled and a new one made.
const EnrollmentSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      immutable: true,
    },
    programSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProgramSession",
      required: true,
      immutable: true,
    },
    // Copied from the batch so lists can filter by program without a join.
    programId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: true,
      immutable: true,
    },
    // P05-05: optional while the numbering policy is open; no generator (proposed format ABC-CSE-2022-0001).
    enrollmentCode: {
      type: String,
      set: optional,
      uppercase: true,
      maxlength: [40, "Enrollment code is too long"],
    },
    // P05-05: the university/official number, null until the college provides one.
    officialEnrollmentNo: {
      type: String,
      set: (value) => optional(value) ?? null,
      default: null,
      maxlength: [60, "Official enrollment no. is too long"],
    },
    status: {
      type: String,
      enum: {
        values: ENROLLMENT_STATUSES,
        message: "Status must be Enrolled, Completed or Cancelled",
      },
      default: "ENROLLED",
      required: true,
    },
  },
  { timestamps: true },
);

// A student is in a given batch once (design §8.12 MVP safeguard; re-admission policy is still open).
EnrollmentSchema.index({ studentId: 1, programSessionId: 1 }, { unique: true });
EnrollmentSchema.index(
  { institutionId: 1, enrollmentCode: 1 },
  {
    unique: true,
    partialFilterExpression: { enrollmentCode: { $type: "string" } },
  },
);
EnrollmentSchema.index({ institutionId: 1, programSessionId: 1 });
EnrollmentSchema.index({ institutionId: 1, createdAt: -1 });

export default mongoose.model("Enrollment", EnrollmentSchema);
