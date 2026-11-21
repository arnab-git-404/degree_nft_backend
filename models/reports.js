import mongoose from "mongoose";

const ReportSchema = new mongoose.Schema({
  institutionWallet: {
    type: String,
    required: true,
  },
  studentWallet: {
    type: String,
    required: true,
  },
  institutionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Institution",
    index: true,
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    index: true,
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
  nftIpfsHash: {
    type: String,
    required: true,
  },
  reportType: {
    type: String,
    required: true,
  },
  reportDetails: {
    type: String,
    required: true,
  },
  reportedOn: {
    type: Date,
  },
  resolved: {
    type: Boolean,
    default: false,
  },
  solutionDetails: {
    type: String,
    default: "",
  },
  resolvedDate: {
    type: Date,
  },
});

export default mongoose.model("NFT Reports", ReportSchema);
