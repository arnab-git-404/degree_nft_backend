import mongoose from "mongoose";

export const PROGRAM_STATUSES = ["ACTIVE", "INACTIVE"];
export const DURATION_UNITS = ["YEARS", "MONTHS"];

// A course a college offers (e.g. B.Tech CSE). Codes are unique per college, not globally.
const ProgramSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    // Fixed after creation: it will appear in enrollment codes (design §8.9).
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      immutable: true,
      match: [
        /^[A-Z0-9][A-Z0-9_-]{0,19}$/,
        "Code must be 1-20 letters, digits, - or _",
      ],
    },
    degreeLevel: { type: String, trim: true, maxlength: 60, default: "" },
    // Kept as the college entered it (4 YEARS, 18 MONTHS), never converted; checked together below.
    durationValue: { type: Number },
    durationUnit: { type: String, uppercase: true, enum: DURATION_UNITS },
    status: {
      type: String,
      enum: PROGRAM_STATUSES,
      default: "ACTIVE",
      required: true,
    },
  },
  { timestamps: true },
);

ProgramSchema.index({ institutionId: 1, code: 1 }, { unique: true });

// Both or neither. Years may be halves (MBBS is 5.5 years); months are whole.
ProgramSchema.pre("validate", function checkDuration() {
  const { durationValue: value, durationUnit: unit } = this;
  if (value == null && !unit) return;
  if (value == null || !unit) {
    this.invalidate("durationValue", "Give both a duration and its unit");
  } else if (
    unit === "YEARS" &&
    !(value >= 0.5 && value <= 20 && Number.isInteger(value * 2))
  ) {
    this.invalidate(
      "durationValue",
      "Years must be from 0.5 to 20, in steps of 0.5",
    );
  } else if (
    unit === "MONTHS" &&
    !(value >= 1 && value <= 240 && Number.isInteger(value))
  ) {
    this.invalidate(
      "durationValue",
      "Months must be a whole number from 1 to 240",
    );
  }
});

export default mongoose.model("Program", ProgramSchema);
