import mongoose from "mongoose";

// Metadata files DegreeNFT pinned to IPFS for a college. A credential may only point to one of these:
// never to a file someone else uploaded, and the stored fingerprint shows what exactly was pinned.
const PinnedMetadataSchema = new mongoose.Schema(
  {
    institutionId: { type: mongoose.Schema.Types.ObjectId, ref: "Institution", required: true, immutable: true },
    cid: { type: String, required: true, immutable: true }, // the IPFS hash Pinata returned
    sha256: { type: String, required: true, immutable: true }, // of the exact JSON text that was pinned
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

PinnedMetadataSchema.index({ institutionId: 1, cid: 1 }, { unique: true });

export default mongoose.model("PinnedMetadata", PinnedMetadataSchema);
