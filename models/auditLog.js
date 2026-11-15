import mongoose from "mongoose";

// PLATFORM: admin-panel changes. INSTITUTION: actions inside one college (institutionId set).
// ACCOUNT: a user's own sign-in, profile and wallet activity.
export const AUDIT_SCOPES = ["PLATFORM", "INSTITUTION", "ACCOUNT"];
export const AUDIT_OUTCOMES = ["SUCCESS", "FAILURE"];

// Append-only: written by utils/audit.js, never updated or deleted by the app.
const AuditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, index: true },
    scope: { type: String, enum: AUDIT_SCOPES, required: true, index: true },
    outcome: { type: String, enum: AUDIT_OUTCOMES, default: "SUCCESS", index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    // Snapshot so the log stays readable if the account is renamed or removed.
    actorName: { type: String, default: "" },
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", index: true },
    targetType: { type: String, default: "" },
    targetId: { type: String, default: "" },
    summary: { type: String, default: "" },
    details: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ institutionId: 1, createdAt: -1 });

export default mongoose.model("AuditLog", AuditLogSchema);
