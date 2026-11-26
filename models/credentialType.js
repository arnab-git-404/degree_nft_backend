import mongoose from "mongoose";
import { colorFromSeed, hashString, HEX_COLOR } from "../utils/color.js";

export const CREDENTIAL_TYPE_STATUSES = ["ACTIVE", "INACTIVE"];

// Master entry of the kinds of credential a college issues (Degree, Provisional, Marksheet...).
// Each college keeps its own list; codes are unique per college, not globally.
const CredentialTypeSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Stored on every credential issued with this type, so it never changes.
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      immutable: true,
      match: [/^[A-Z0-9][A-Z0-9_-]{0,19}$/, "Code must be 1-20 letters, digits, - or _"],
    },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    color: { type: String, match: HEX_COLOR },
    status: { type: String, enum: CREDENTIAL_TYPE_STATUSES, default: "ACTIVE", required: true },
  },
  { timestamps: true },
);

CredentialTypeSchema.index({ institutionId: 1, code: 1 }, { unique: true });

CredentialTypeSchema.pre("validate", function setColor() {
  if (!this.color && this.code) this.color = colorFromSeed(hashString(this.code));
});

const DEFAULTS = [
  ["DEGREE", "Degree"],
  ["PROVISIONAL", "Provisional certificate"],
  ["MARKSHEET", "Marksheet"],
  ["TRANSCRIPT", "Transcript"],
  ["CERTIFICATE", "Certificate"],
];

const CredentialType = mongoose.model("CredentialType", CredentialTypeSchema);

// A college that has no types yet starts with the usual ones; after that the list is theirs to edit.
export const ensureCredentialTypes = async (institutionId) => {
  if (await CredentialType.exists({ institutionId })) return;
  try {
    await CredentialType.insertMany(DEFAULTS.map(([code, name]) => ({ institutionId, code, name })), { ordered: false });
  } catch (error) {
    if (error.code !== 11000 && !error.writeErrors) throw error; // a parallel request already seeded them
  }
};

export default CredentialType;
