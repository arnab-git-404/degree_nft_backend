import mongoose from "mongoose";

const NftSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  symbol: {
    type: String,
    required: true,
    trim: true,
  },
  uri: {
    type: String,
    required: true,
    trim: true,
  },
  ipfsHash: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  institutionWallet: {
    type: String,
    required: true,
    trim: true,
  },
  studentWallet: {
    type: String,
    required: true,
    trim: true,
  },
  institutionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Institution",
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
  },
  // P06: the college student profile + enrollment this credential belongs to.
  // Optional only for legacy rows; deliberately NOT unique, one enrollment holds many credentials.
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Student",
    index: true,
  },
  enrollmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Enrollment",
    index: true,
  },
  // What the student confirmed. A later change to the credential bumps it (P06-03), so an old confirmation cannot apply.
  revision: {
    type: Number,
    default: 1,
  },
  // sha256 of what the student reviews (enrollment, type, name, metadata CID) for the current revision.
  contentHash: { type: String },
  // Earlier revisions, kept as they were when replaced. Append-only: nothing edits an entry.
  previousRevisions: [
    {
      _id: false,
      revision: Number,
      name: String,
      uri: String,
      ipfsHash: String,
      contentHash: String,
      confirmedAt: Date,
      reason: String,
      revisedAt: Date,
    },
  ],
  credentialType: {
    type: String,
    default: "DEGREE",
  },
  institutionWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    index: true,
  },
  studentWalletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Wallet",
    index: true,
  },
  sellerFeeBasisPoints: {
    type: Number,
    default: 500,
  },
  minted: {
    type: Boolean,
    default: false,
  },
  allocated: {
    type: Boolean,
    default: true,
  },
  allocatedAt: {
    type: Date,
    default: Date.now,
  },
  mintedAt: {
    type: Date,
  },
  nftAddress: {
    type: String,
  },
  status: {
    type: String,
    enum: ["PENDING_CONFIRMATION", "CONFIRMED", "AUTO_CONFIRMED", "MINTED"],
    default: "PENDING_CONFIRMATION",
  },
  confirmationDeadline: {
    type: Date,
    default: function () {
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 7);
      return deadline;
    },
  },
  isConfirmed: {
    type: Boolean,
    default: false,
  },
  confirmedAt: {
    type: Date,
  },
  wasAutoConfirmed: {
    type: Boolean,
    default: false,
  },
});

export default mongoose.model("Credential", NftSchema);
