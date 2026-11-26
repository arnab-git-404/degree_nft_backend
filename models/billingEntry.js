import mongoose from "mongoose";

export const BILLING_CURRENCIES = ["SOL", "USDC"];
export const BILLING_KINDS = ["DEPOSIT", "CHARGE", "REFUND", "ADJUSTMENT"];
// Amounts are whole base units: lamports for SOL (1 SOL = 1e9), micro-USDC for USDC (1 USDC = 1e6).
export const UNITS = { SOL: 1e9, USDC: 1e6 };

// Append-only ledger of a college's prepaid balance. Balance = sum of amounts per currency.
const BillingEntrySchema = new mongoose.Schema(
  {
    institutionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Institution",
      required: true,
      immutable: true,
    },
    currency: {
      type: String,
      enum: BILLING_CURRENCIES,
      required: true,
      immutable: true,
    },
    kind: {
      type: String,
      enum: BILLING_KINDS,
      required: true,
      immutable: true,
    },
    // Positive for DEPOSIT / REFUND, negative for CHARGE.
    amount: {
      type: Number,
      required: true,
      immutable: true,
      validate: Number.isInteger,
    },
    signature: { type: String, immutable: true }, // the on-chain payment (deposits)
    fromWallet: { type: String, immutable: true },
    credentialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Credential",
      immutable: true,
    }, // what a charge was for
    note: { type: String, trim: true, maxlength: 300, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// One on-chain payment is credited once; one credential is charged once.
BillingEntrySchema.index(
  { signature: 1, currency: 1 },
  { unique: true, partialFilterExpression: { kind: "DEPOSIT" } },
);
BillingEntrySchema.index(
  { credentialId: 1 },
  { unique: true, partialFilterExpression: { kind: "CHARGE" } },
);
BillingEntrySchema.index({ institutionId: 1, createdAt: -1 });

export default mongoose.model("BillingEntry", BillingEntrySchema);
