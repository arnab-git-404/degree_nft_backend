import mongoose from "mongoose";
import { colorFromSeed, HEX_COLOR } from "../utils/color.js";

const year = {
  type: Number,
  required: true,
  immutable: true,
  min: 1950,
  max: 2100,
  validate: [Number.isInteger, "Year must be a whole number"],
};

export const yearColor = colorFromSeed;

// A college's academic year (2024-25, or a calendar year 2024), set up once in Administration.
// Programs take intakes in these; each intake is a program session (batch) linked by academicSessionId.
const AcademicSessionSchema = new mongoose.Schema(
  {
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", required: true, immutable: true },
    startYear: year,
    endYear: year,
    // Inactive years can't take new batches; existing batches are untouched.
    isActive: { type: Boolean, default: true },
    // The year the college is running now; at most one per college (index below).
    isCurrent: { type: Boolean, default: false },
    // Hex colour set automatically on creation (see yearColor), used to tell years apart in the UI.
    color: { type: String, match: HEX_COLOR },
  },
  { timestamps: true }
);

// One session per start year, so an intake year always means one session.
AcademicSessionSchema.index({ institutionId: 1, startYear: 1 }, { unique: true });
AcademicSessionSchema.index({ institutionId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });

AcademicSessionSchema.pre("validate", function checkYears() {
  if (!this.color && this.startYear != null) this.color = yearColor(this.startYear);
  if (this.startYear != null && this.endYear != null && ![this.startYear, this.startYear + 1].includes(this.endYear)) {
    this.invalidate("endYear", "An academic session ends in its start year or the next year (e.g. 2024-25)");
  }
});

export default mongoose.model("AcademicSession", AcademicSessionSchema);
