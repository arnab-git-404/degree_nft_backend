import mongoose from "mongoose";

export const REQUEST_KINDS = ["RECOVERY", "BURN"];
// RECOVERY starts at WAITING_FOR_WALLET (the student must prove the new wallet); BURN starts at PENDING_APPROVAL.
export const REQUEST_STATUSES = [
  "WAITING_FOR_WALLET",
  "PENDING_APPROVAL",
  "EXECUTED",
  "FAILED",
  "REJECTED",
];

const approval = {
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name: String,
  at: Date,
};

// A high-impact on-chain action that needs two approvals from two different people:
// RECOVERY moves a student's credentials to a new wallet; BURN destroys one credential.
const CredentialRequestSchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    kind: {
      type: String,
      enum: REQUEST_KINDS,
      required: true,
      immutable: true,
    },
    status: { type: String, enum: REQUEST_STATUSES, required: true },
    // true until EXECUTED or REJECTED: one open request at a time per student (recovery) or credential (burn).
    open: { type: Boolean, default: true },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
      immutable: true,
    },
    requestedBy: { ...approval, at: { type: Date, default: Date.now } },

    // RECOVERY: the college student profile and the wallet change.
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      immutable: true,
    },
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    toWallet: String,
    toUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    walletProvedAt: Date,
    tokenHash: { type: String, select: false, index: true, sparse: true }, // emailed link for the new wallet
    tokenExpiresAt: Date,

    // BURN: the one credential.
    credentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Credential",
      immutable: true,
    },

    approvals: { first: approval, final: approval },
    // The Squads proposal holding the on-chain action, and the officials' wallet approvals on it (append-only).
    proposal: { transactionIndex: String, assets: [String] },
    walletApprovals: [{ _id: false, wallet: String, userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, name: String, at: Date, signature: String }],
    rejection: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: String,
      reason: String,
      at: Date,
    },
    // One line per asset acted on, with its transaction or error.
    results: [
      {
        _id: false,
        assetAddress: String,
        signature: String,
        error: String,
        at: Date,
      },
    ],
    executedAt: Date,
  },
  { timestamps: true },
);

CredentialRequestSchema.index({ institutionId: 1, createdAt: -1 });
CredentialRequestSchema.index({ studentId: 1 }, { unique: true, partialFilterExpression: { kind: "RECOVERY", open: true } });
CredentialRequestSchema.index({ credentialId: 1 }, { unique: true, partialFilterExpression: { kind: "BURN", open: true } });

export default mongoose.model("CredentialRequest", CredentialRequestSchema);
