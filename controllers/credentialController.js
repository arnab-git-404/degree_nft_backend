import { audit } from "../utils/audit.js";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import Credential from "../models/credential.js";
import CredentialType, { ensureCredentialTypes } from "../models/credentialType.js";
import Enrollment from "../models/enrollment.js";
import Reports from "../models/reports.js";
import Institution from "../models/institution.js";
import Wallet from "../models/wallet.js";
import StudentDetails from "../models/studentDetails.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import { verifyCredentialMint } from "../utils/solana.js";
import { hasPermission } from "../middleware/auth.js";
import { findOrCreateUserByWallet } from "../services/userWalletService.js";

const getStudentWallet = async (user, walletAddress) => {
  if (walletAddress) {
    if (!isValidSolanaAddress(walletAddress)) {
      throw new AppError("Invalid Solana wallet address", 400);
    }

    const wallet = await Wallet.findOne({
      chain: "solana",
      address: walletAddress,
      userId: user._id,
    });

    if (wallet) {
      return wallet;
    }

    if (hasPermission(user, "platform:manage")) {
      const anyWallet = await Wallet.findOne({
        chain: "solana",
        address: walletAddress,
      });

      return anyWallet || { address: walletAddress, _id: null, userId: null };
    }

    throw new AppError("Wallet is not linked to your account", 403);
  }

  const wallet = await Wallet.findOne({ userId: user._id }).sort({
    isPrimary: -1,
    createdAt: 1,
  });

  if (!wallet) {
    throw new AppError("No wallet is linked to this account", 400);
  }

  return wallet;
};

const walletFilter = (wallet) => {
  const conditions = [{ studentWallet: wallet.address }];

  if (wallet._id) {
    conditions.push({ studentWalletId: wallet._id });
  }

  return { $or: conditions };
};

const resolveInstitutionReferences = async (credential) => {
  let institutionId = credential.institutionId;
  let institutionWalletId = credential.institutionWalletId;

  if (!institutionId && credential.institutionWallet) {
    const institution = await Institution.findOne({
      walletAddress: credential.institutionWallet,
    });

    if (institution) {
      institutionId = institution._id;
    }
  }

  if (!institutionWalletId && credential.institutionWallet) {
    const wallet = await Wallet.findOne({
      chain: "solana",
      address: credential.institutionWallet,
    });

    if (wallet) {
      institutionWalletId = wallet._id;
    }
  }

  return { institutionId, institutionWalletId };
};

export const issueCredential = asyncHandler(async (req, res) => {
  const {
    studentWallet,
    name,
    symbol,
    uri,
    ipfsHash,
    sellerFeeBasisPoints,
  } = req.body;

  if (!studentWallet || !name || !symbol || !uri || !ipfsHash) {
    throw new AppError("Missing required fields for the credential", 400);
  }

  if (!isValidSolanaAddress(studentWallet)) {
    throw new AppError("Invalid student wallet address", 400);
  }

  // Verified by requireInstitution: the caller's active membership, never a body field.
  const institution = req.institution;

  if (institution.verificationStatus !== "VERIFIED" || institution.status !== "ACTIVE") {
    throw new AppError(
      "Institution must be verified and active before issuing credentials",
      403
    );
  }

  // P06-02: an enrollment may be named (P06-04 makes the UI send it, then it becomes required).
  // The enrollment is looked up inside the caller's own college, so a foreign id is just "not found".
  // The type must be an Active entry of the college's own master list (Credential types page).
  await ensureCredentialTypes(institution._id);
  const credentialType = String(req.body.credentialType || "DEGREE").toUpperCase();
  if (!(await CredentialType.exists({ institutionId: institution._id, code: credentialType, status: "ACTIVE" }))) {
    throw new AppError(`"${credentialType}" is not an active credential type of this college`, 400);
  }
  let enrollment = null;
  if (req.body.enrollmentId) {
    if (!mongoose.isValidObjectId(req.body.enrollmentId)) {
      throw new AppError("Invalid enrollmentId", 400);
    }
    enrollment = await Enrollment.findOne({ _id: req.body.enrollmentId, institutionId: institution._id });
    if (!enrollment) throw new AppError("Enrollment not found at this institution", 404);
    if (enrollment.status === "CANCELLED") {
      throw new AppError("Cannot issue a credential for a cancelled enrollment", 409);
    }
  }

  const existingCredential = await Credential.findOne({
    ipfsHash,
    studentWallet,
    $or: [
      { institutionId: institution._id },
      { institutionWallet: institution.walletAddress },
    ],
  });

  if (existingCredential) {
    throw new AppError(
      "This credential has already been issued for this combination",
      409
    );
  }

  const { user: student, wallet: studentWalletDocument } =
    await findOrCreateUserByWallet(studentWallet);

  const institutionWallet = await Wallet.findOne({
    chain: "solana",
    address: institution.walletAddress,
  });

  if (institutionWallet && !institution.walletId) {
    institution.walletId = institutionWallet._id;
    await institution.save();
  }

  const credential = await Credential.create({
    name,
    symbol,
    uri,
    ipfsHash,
    institutionWallet: institution.walletAddress,
    studentWallet,
    institutionId: institution._id,
    userId: student._id,
    credentialType,
    contentHash: contentHashOf({ enrollmentId: enrollment?._id, credentialType, name, ipfsHash }),
    enrollmentId: enrollment?._id,
    studentId: enrollment?.studentId,
    institutionWalletId: institutionWallet?._id,
    studentWalletId: studentWalletDocument._id,
    sellerFeeBasisPoints,
    allocated: true,
    allocatedAt: new Date(),
    minted: false,
  });

  await StudentDetails.findOneAndUpdate(
    { institutionId: institution._id, userId: student._id },
    {
      $setOnInsert: {
        studentName: student.name,
        studentWalletAddress: studentWallet,
        userId: student._id,
        institutionId: institution._id,
        studentWalletId: studentWalletDocument._id,
        institutionWalletId: institutionWallet?._id,
        institutionWalletAddress: institution.walletAddress,
        institutionName: institution.name,
      },
      $inc: { totalAllocatedNFTs: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await Institution.updateOne(
    { _id: institution._id },
    { $inc: { totalAllocated: 1 } }
  );
  await audit(req, { action: "credential.allocate", scope: "INSTITUTION", targetType: "Credential", targetId: credential._id, summary: `Issued "${name}" to ${studentWallet}`, details: { ipfsHash } });

  res.status(201).json({
    success: true,
    message: "Credential issued successfully",
    credential,
  });
});

export const getNextCredential = asyncHandler(async (req, res) => {
  const { walletAddress } = req.params;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const pendingCredential = await Credential.findOne({
    allocated: true,
    minted: false,
    ...walletFilter(wallet),
  })
    .sort({ allocatedAt: 1 })
    .populate("institutionId", "name code walletAddress");

  const existingReport = await Reports.findOne(walletFilter(wallet));

  if (pendingCredential) {
    res.status(200).json({
      authorized: true,
      existingReport: Boolean(await Reports.exists(openReportsOf(pendingCredential))),
      nftInfo: {
        _id: pendingCredential._id,
        name: pendingCredential.name,
        symbol: pendingCredential.symbol,
        uri: pendingCredential.uri,
        ipfsHash: pendingCredential.ipfsHash,
        confirmationStatus: pendingCredential.status,
        revision: pendingCredential.revision,
        revisionNote: pendingCredential.previousRevisions.at(-1)?.reason || null,
        credentialType: pendingCredential.credentialType,
        sellerFeeBasisPoints: pendingCredential.sellerFeeBasisPoints,
        institutionName: pendingCredential.institutionId?.name || null,
      },
      confirmationDeadline: pendingCredential.confirmationDeadline,
    });
    return;
  }

  const anyCredential = await Credential.findOne(walletFilter(wallet));

  if (anyCredential) {
    res.status(200).json({
      authorized: false,
      existingReport: Boolean(existingReport),
      message:
        "All credentials have already been minted for this wallet, or none are ready for minting.",
    });
    return;
  }

  res.status(200).json({
    authorized: false,
    existingReport: Boolean(existingReport),
    message: "No credential found for this wallet.",
  });
});

// Open reports about one credential: by its id, or (reports filed before ids were stored) by its metadata hash.
const openReportsOf = (credential) => ({
  resolved: false,
  $or: [{ credentialId: credential._id }, { credentialId: { $exists: false }, ipfsHash: credential.ipfsHash, studentWallet: credential.studentWallet }],
});

const contentHashOf = (credential) =>
  createHash("sha256")
    .update(JSON.stringify([String(credential.enrollmentId ?? ""), credential.credentialType, credential.name, credential.ipfsHash]))
    .digest("hex");

// P06-03 / P06-07: the college corrects a credential that is not minted yet. The old revision is kept,
// the revision number goes up and the student's confirmation no longer applies: they must confirm again.
export const reviseCredential = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.credentialId)) throw new AppError("Invalid credential id", 400);
  // Scoped to the caller's own college, so another college's id is just "not found".
  const credential = await Credential.findOne({ _id: req.params.credentialId, institutionId: req.institution._id });
  if (!credential) throw new AppError("Credential not found", 404);
  if (credential.minted) throw new AppError("This credential is already minted and can no longer be changed", 409);

  const { name, uri, ipfsHash, reason } = req.body || {};
  if (typeof reason !== "string" || reason.trim().length < 3) {
    throw new AppError("Say why the credential is being corrected", 400);
  }
  for (const [label, value] of Object.entries({ name, uri, ipfsHash })) {
    if (typeof value !== "string" || !value.trim()) throw new AppError(`${label} is required`, 400);
  }
  // The pinned metadata and its public link must be the same file.
  if (!uri.trim().endsWith(`/${ipfsHash.trim()}`)) throw new AppError("uri must point to the given ipfsHash", 400);
  if (await Credential.exists({ _id: { $ne: credential._id }, ipfsHash: ipfsHash.trim(), studentWallet: credential.studentWallet, institutionId: credential.institutionId })) {
    throw new AppError("This credential has already been issued for this combination", 409);
  }

  const openReports = openReportsOf(credential); // built from the old ipfsHash, before it changes
  credential.previousRevisions.push({
    revision: credential.revision,
    name: credential.name,
    uri: credential.uri,
    ipfsHash: credential.ipfsHash,
    contentHash: credential.contentHash,
    confirmedAt: credential.confirmedAt,
    reason: reason.trim(),
    revisedAt: new Date(),
  });
  credential.set({ name: name.trim(), uri: uri.trim(), ipfsHash: ipfsHash.trim() });
  credential.revision += 1;
  credential.contentHash = contentHashOf(credential);
  credential.isConfirmed = false;
  credential.wasAutoConfirmed = false;
  credential.confirmedAt = undefined;
  credential.status = "PENDING_CONFIRMATION";
  credential.confirmationDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await credential.save();

  // Only when the college says so: the correction answers the student's report. Otherwise the report keeps blocking the mint.
  let resolvedReports = 0;
  if (req.body.resolveReports === true) {
    ({ modifiedCount: resolvedReports } = await Reports.updateMany(openReports, {
      resolved: true,
      resolvedDate: new Date(),
      solutionDetails: `Corrected in revision ${credential.revision}: ${reason.trim()}`,
    }));
  }

  await audit(req, {
    action: "credential.revise",
    scope: "INSTITUTION",
    targetType: "Credential",
    targetId: credential._id,
    summary: `Revised "${credential.name}" to revision ${credential.revision}`,
    details: { reason: reason.trim(), revision: credential.revision, resolvedReports },
  });
  res.status(200).json({ success: true, credential: credential, resolvedReports });
});

// The college's own credentials, newest first, with the student/enrollment each belongs to and any open reports.
// shortcut: latest 200 only, no server-side search; add paging/search when a college issues more than that.
export const listCollegeCredentials = asyncHandler(async (req, res) => {
  const { _id, walletAddress } = req.institution;
  const match = walletAddress ? { $or: [{ institutionId: _id }, { institutionWallet: walletAddress }] } : { institutionId: _id };
  const credentials = await Credential.find(match)
    .select("-previousRevisions.contentHash")
    .populate({
      path: "enrollmentId",
      select: "programId programSessionId",
      populate: [
        { path: "programId", select: "code name" },
        { path: "programSessionId", select: "startYear endYear" },
      ],
    })
    .populate("studentId", "fullName registrationNo")
    .sort({ allocatedAt: -1 })
    .limit(200)
    .lean();

  const reports = await Reports.find({ resolved: false, $or: [{ credentialId: { $in: credentials.map((c) => c._id) } }, { credentialId: { $exists: false }, studentWallet: { $in: credentials.map((c) => c.studentWallet) } }] })
    .select("credentialId ipfsHash studentWallet reportType")
    .lean();
  const openReportCount = (credential) =>
    reports.filter((r) => (r.credentialId ? String(r.credentialId) === String(credential._id) : r.ipfsHash === credential.ipfsHash && r.studentWallet === credential.studentWallet)).length;

  res.status(200).json({
    success: true,
    credentials: credentials.map((credential) => ({ ...credential, openReports: openReportCount(credential) })),
  });
});

// P06-06: confirm and mint act on ONE named credential (and revision), never "the oldest one".
// A plain id only: an object like {"$ne": null} would act as a query operator.
const findOwnCredential = async (wallet, { credentialId, revision }) => {
  if (!credentialId || !mongoose.isValidObjectId(credentialId)) {
    throw new AppError("A valid credentialId is required", 400);
  }
  const credential = await Credential.findOne({ _id: credentialId, allocated: true, minted: false, ...walletFilter(wallet) });
  if (!credential) throw new AppError("Credential not found", 404);
  if (Number(revision) !== credential.revision) {
    throw new AppError("This credential was changed. Reload it and review the latest revision.", 409);
  }
  return credential;
};

export const confirmCredential = asyncHandler(async (req, res) => {
  const wallet = await getStudentWallet(req.user, req.body.walletAddress);
  const credential = await findOwnCredential(wallet, req.body);

  if (!credential.userId && wallet.userId) {
    credential.userId = wallet.userId;
  }

  if (!credential.studentWalletId && wallet._id) {
    credential.studentWalletId = wallet._id;
  }

  credential.status = "CONFIRMED";
  credential.isConfirmed = true;
  credential.confirmedAt = new Date();

  await credential.save();
  await audit(req, { action: "credential.confirm", scope: "INSTITUTION", institutionId: credential.institutionId, targetType: "Credential", targetId: credential._id, summary: `Student confirmed "${credential.name}"` });

  res.status(200).json({
    success: true,
    message: "Credential details are confirmed",
  });
});

// Pins credential metadata server-side so Pinata keys never reach the browser.
export const pinMetadata = asyncHandler(async (req, res) => {
  const metadata = req.body;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !metadata.name) {
    throw new AppError("Metadata JSON with a name is required", 400);
  }

  if (!process.env.PINATA_API_KEY || !process.env.PINATA_API_SECRET) {
    throw new AppError("IPFS pinning is not configured on the server", 503);
  }

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      pinata_api_key: process.env.PINATA_API_KEY,
      pinata_secret_api_key: process.env.PINATA_API_SECRET,
    },
    body: JSON.stringify(metadata),
  });

  if (!response.ok) {
    console.error("Pinata pin failed:", response.status, await response.text());
    throw new AppError("Failed to upload metadata to IPFS", 502);
  }

  const { IpfsHash } = await response.json();
  await audit(req, { action: "credential.metadata.pin", scope: "INSTITUTION", targetType: "IPFS", targetId: IpfsHash, summary: `Pinned metadata for "${metadata.name}"` });
  res.status(200).json({ success: true, IpfsHash });
});

export const recordMint = asyncHandler(async (req, res) => {
  const { walletAddress, nft_Mint_Address } = req.body;

  if (!nft_Mint_Address || !isValidSolanaAddress(nft_Mint_Address)) {
    throw new AppError("A valid nft_Mint_Address is required", 400);
  }

  const wallet = await getStudentWallet(req.user, walletAddress);
  const credential = await findOwnCredential(wallet, req.body);

  // A student's open report on this credential stops the mint until the college resolves or corrects it.
  if (await Reports.exists(openReportsOf(credential))) {
    throw new AppError("An open report on this credential blocks minting", 409);
  }

  // Same rule the student screen shows: confirmed by the student, or the review window has passed.
  if (!credential.isConfirmed && credential.confirmationDeadline > new Date()) {
    throw new AppError("Confirm this credential before minting it", 403);
  }

  if (await Credential.exists({ nftAddress: nft_Mint_Address })) {
    throw new AppError("This mint address is already recorded", 409);
  }

  // Never trust the client's word that a mint happened: check the chain.
  try {
    await verifyCredentialMint({
      mintAddress: nft_Mint_Address,
      ownerAddress: wallet.address,
      expectedUri: credential.uri,
    });
  } catch (error) {
    throw new AppError(`Mint could not be verified: ${error.message}`, 400);
  }

  if (!credential.userId && wallet.userId) {
    credential.userId = wallet.userId;
  }

  if (!credential.studentWalletId && wallet._id) {
    credential.studentWalletId = wallet._id;
  }

  const { institutionId, institutionWalletId } =
    await resolveInstitutionReferences(credential);

  if (!credential.institutionId && institutionId) {
    credential.institutionId = institutionId;
  }

  if (!credential.institutionWalletId && institutionWalletId) {
    credential.institutionWalletId = institutionWalletId;
  }

  credential.status = "MINTED";
  credential.minted = true;
  credential.mintedAt = new Date();
  credential.nftAddress = nft_Mint_Address;

  await credential.save();

  if (credential.institutionId) {
    await Institution.updateOne(
      { _id: credential.institutionId },
      { $inc: { totalMinted: 1 } }
    );
  }

  if (credential.institutionId && credential.userId) {
    await StudentDetails.updateOne(
      {
        institutionId: credential.institutionId,
        userId: credential.userId,
      },
      { $inc: { studentTotalMintedNFT: 1 } }
    );
  }

  await audit(req, { action: "credential.mint", scope: "INSTITUTION", institutionId: credential.institutionId, targetType: "Credential", targetId: credential._id, summary: `Minted "${credential.name}" as ${nft_Mint_Address}` });

  res.status(200).json({
    success: true,
    message: "Mint recorded successfully",
  });
});

export const getMintedCredentials = asyncHandler(async (req, res) => {
  const { walletAddress } = req.params;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const mintedNfts = await Credential.find({
    minted: true,
    ...walletFilter(wallet),
  })
    .sort({ mintedAt: -1 })
    .populate("institutionId", "name code walletAddress");

  const formattedNfts = mintedNfts.map((credential, index) => ({
    id: index + 1,
    credentialId: credential._id,
    name: credential.name,
    issueDate: credential.allocatedAt,
    mintedDate: credential.mintedAt,
    nftAddress: credential.nftAddress,
    symbol: credential.symbol,
    uri: credential.uri,
    ipfsHash: credential.ipfsHash,
    institutionName: credential.institutionId?.name || null,
  }));

  res.status(200).json({ nfts: formattedNfts });
});

export const createReport = asyncHandler(async (req, res) => {
  const { walletAddress, credentialId, reportType, reportDetails } = req.body;

  const studentWalletAddress = req.body.studentWallet || walletAddress;

  if (!credentialId || !reportType || !reportDetails) {
    throw new AppError("Missing required fields", 400);
  }
  if (!mongoose.isValidObjectId(credentialId)) throw new AppError("Invalid credentialId", 400);

  const wallet = await getStudentWallet(req.user, studentWalletAddress);

  // The report is about one credential the student owns, named by its id.
  const credential = await Credential.findOne({ _id: credentialId, ...walletFilter(wallet) });

  if (!credential) {
    throw new AppError("No matching credential was found for this report", 404);
  }

  const existingReport = await Reports.findOne({ credentialId: credential._id, reportType, resolved: false });

  if (existingReport) {
    throw new AppError("Report already exists", 409);
  }

  const { institutionId, institutionWalletId } =
    await resolveInstitutionReferences(credential);

  const report = await Reports.create({
    institutionWallet: credential.institutionWallet,
    studentWallet: wallet.address,
    institutionId: institutionId || undefined,
    userId: credential.userId || wallet.userId || req.user._id,
    institutionWalletId: institutionWalletId || undefined,
    studentWalletId: credential.studentWalletId || wallet._id || undefined,
    credentialId: credential._id,
    ipfsHash: credential.ipfsHash,
    reportType,
    reportDetails,
    reportedOn: new Date(),
  });
  await audit(req, { action: "report.create", scope: "INSTITUTION", institutionId: report.institutionId, targetType: "Report", targetId: report._id, summary: `Reported issue "${reportType}" on "${credential.name}"` });

  res.status(201).json({
    success: true,
    message: "Report created successfully",
    report,
  });
});
