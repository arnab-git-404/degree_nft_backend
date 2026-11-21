import mongoose from "mongoose";
import { colorFromSeed, hashString, HEX_COLOR } from "../utils/color.js";

export const PROGRAM_STATUSES = ["ACTIVE", "INACTIVE"];

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
    description: { type: String, trim: true, maxlength: 500, default: "" },
    // Hex colour: set automatically from the code on creation unless the user picks one.
    color: { type: String, match: HEX_COLOR },
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

ProgramSchema.pre("validate", function setColor() {
  if (!this.color && this.code) this.color = colorFromSeed(hashString(this.code));
});

export default mongoose.model("Program", ProgramSchema);
