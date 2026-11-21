import mongoose from "mongoose";
import { colorFromSeed, hashString, HEX_COLOR } from "../utils/color.js";

// Nothing is ever deleted: a batch that is no longer used is set to INACTIVE.
export const PROGRAM_SESSION_STATUSES = ["ACTIVE", "INACTIVE"];

const year = {
  type: Number,
  required: true,
  min: 1950,
  max: 2100,
  validate: [Number.isInteger, "Year must be a whole number"],
};

// One intake (cohort) of a program, e.g. CSE 2022-2026. The program must belong to the same college.
const ProgramSessionSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    programId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: true,
      immutable: true,
    },
    // The intake (Administration › Academic Sessions) this batch belongs to; startYear is copied from it.
    academicSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AcademicSession",
      immutable: true,
    },
    startYear: year,
    endYear: year,
    // Shown in lists and used in enrollment. The controller fills defaults from the program (CSE-2026, "CSE 2026–2030").
    name: { type: String, trim: true, maxlength: 200 },
    code: {
      type: String,
      trim: true,
      uppercase: true,
      immutable: true,
      match: [/^[A-Z0-9][A-Z0-9_-]{0,29}$/, "Code must be 1-30 letters, digits, - or _"],
    },
    // Hex colour: generated from the code unless the user picks one.
    color: { type: String, match: HEX_COLOR },
    status: {
      type: String,
      enum: PROGRAM_SESSION_STATUSES,
      default: "ACTIVE",
      required: true,
    },
  },
  { timestamps: true },
);

// The same program can run 2022-2026 and 2023-2027, but never the exact same cohort twice (design §8.10).
ProgramSessionSchema.index(
  { institutionId: 1, programId: 1, startYear: 1, endYear: 1 },
  { unique: true },
);

// One batch per program per intake.
ProgramSessionSchema.index(
  { programId: 1, academicSessionId: 1 },
  { unique: true, partialFilterExpression: { academicSessionId: { $exists: true } } },
);

// Batch codes are unique per college (partial: batches saved before codes existed have none).
ProgramSessionSchema.index({ institutionId: 1, code: 1 }, { unique: true, partialFilterExpression: { code: { $exists: true } } });

ProgramSessionSchema.pre("validate", function checkYears() {
  if (!this.color && this.code) this.color = colorFromSeed(hashString(this.code));
  if (
    this.startYear != null &&
    this.endYear != null &&
    this.endYear <= this.startYear
  ) {
    this.invalidate("endYear", "End year must be after the start year");
  }
});

export default mongoose.model("ProgramSession", ProgramSessionSchema);
