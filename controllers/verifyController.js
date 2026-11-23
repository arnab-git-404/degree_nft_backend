import Nft from "../models/nft.js";
import Credential from "../models/credential.js";
import CollegeChain from "../models/collegeChain.js";
import Institution from "../models/institution.js";
import CredentialType from "../models/credentialType.js";
import { chain, network } from "../utils/chain.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

// Owning the NFT proves nothing by itself: a credential is VERIFIED only when our record, the issuing college's
// collection, the on-chain asset, its content and the official academic status all agree.
// Never VERIFIED when a check could not run (VERIFICATION_UNAVAILABLE).
const STATUS_BY_ACADEMIC = { ACTIVE: "VERIFIED", SUSPENDED: "SUSPENDED", REVOKED: "REVOKED" };

// "Rahul Sharma" -> "Rahul S.": enough to match the holder, not a public directory of students.
const maskName = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts.at(-1)[0]}.`;
};

// Public, no login. shortcut: no rate limit yet; add one (e.g. per IP) before Mainnet.
export const verifyCredential = asyncHandler(async (req, res) => {
  const { assetAddress } = req.params;
  if (!isValidSolanaAddress(assetAddress)) throw new AppError("That is not a valid Solana address", 400);

  const checkedAt = new Date();
  const nft = await Nft.findOne({ assetAddress }).lean();
  if (!nft) return res.status(200).json({ status: "NOT_FOUND", assetAddress, checkedAt });

  const [credential, college, institution] = await Promise.all([
    Credential.findById(nft.credentialId).populate("studentId", "fullName").lean(),
    CollegeChain.findOne({ institutionId: nft.institutionId }).lean(),
    Institution.findById(nft.institutionId).select("name code").lean(),
  ]);
  const type = credential && (await CredentialType.findOne({ institutionId: nft.institutionId, code: credential.credentialType }).select("name").lean());

  let onChain;
  let chainError = false;
  if (nft.status !== "BURNED") {
    try {
      onChain = await chain.getAsset(assetAddress);
    } catch {
      chainError = true;
    }
  }

  const checks = [
    { key: "record", label: "Issued by a DegreeNFT college", ok: Boolean(credential && college && institution) },
    { key: "network", label: `Recorded on Solana ${network()}`, ok: nft.network === network() },
    { key: "collection", label: "Belongs to the college's official collection", ok: Boolean(college) && nft.collectionAddress === college.collectionAddress && (!onChain || onChain.collection === college.collectionAddress) },
    { key: "chain", label: "Exists on-chain", ok: chainError ? null : Boolean(onChain) },
    { key: "owner", label: "Held by the wallet it was issued to", ok: chainError || !onChain ? null : onChain.owner === nft.ownerWallet },
    { key: "content", label: "Content matches the issued record", ok: Boolean(credential) && credential.revision === nft.revision && credential.contentHash === nft.contentHash },
  ];

  let status;
  if (nft.status === "BURNED" || credential?.academicStatus === "REVOKED") status = "REVOKED";
  else if (chainError) status = "VERIFICATION_UNAVAILABLE";
  else if (nft.status !== "MINTED" || !onChain) status = "NOT_FOUND";
  else if (checks.some((check) => check.ok === false && check.key !== "content")) status = "VERIFICATION_UNAVAILABLE";
  else if (checks.find((check) => check.key === "content").ok === false) status = "SUPERSEDED"; // corrected after minting
  else status = STATUS_BY_ACADEMIC[credential.academicStatus || "ACTIVE"];

  res.status(200).json({
    status,
    assetAddress,
    checkedAt,
    checks,
    credential: credential && {
      title: credential.name,
      type: type?.name || credential.credentialType,
      holder: maskName(credential.studentId?.fullName),
      issuedAt: nft.mintedAt,
      revision: nft.revision,
      academicStatus: credential.academicStatus || "ACTIVE",
      // The latest status change only, so a verifier knows why; the full history stays private.
      statusChangedAt: credential.statusHistory?.at(-1)?.at || null,
    },
    college: institution && { name: institution.name, code: institution.code },
    chain: { network: nft.network, collectionAddress: nft.collectionAddress, ownerWallet: nft.ownerWallet, mintSignature: nft.mintSignature },
  });
});
