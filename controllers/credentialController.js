import { audit } from "../utils/audit.js";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import Credential from "../models/credential.js";
import CredentialType, { ensureCredentialTypes } from "../models/credentialType.js";
import Enrollment from "../models/enrollment.js";
import PinnedMetadata from "../models/pinnedMetadata.js";
import { matchStudentBatchRows } from "./enrollmentController.js";
import Student from "../models/student.js";
import Reports from "../models/reports.js";
import Institution from "../models/institution.js";
import Wallet from "../models/wallet.js";
import StudentDetails from "../models/studentDetails.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import Nft from "../models/nft.js";
import CollegeChain from "../models/collegeChain.js";
import BillingEntry from "../models/billingEntry.js";
import { getBalances, getPrices, pickPayment } from "../services/billingService.js";
import { chain, assertSameNetwork, FEE_PAYER_MIN_LAMPORTS } from "../utils/chain.js";
import { encryptSecret, decryptSecret } from "../utils/secretBox.js";
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

// A credential may only point to metadata DegreeNFT pinned for this college, through a link to that exact file.
const assertPinnedHere = async (institutionId, uri, ipfsHash) => {
  const cid = String(ipfsHash || "").trim();
  if (!String(uri || "").trim().endsWith(`/${cid}`)) throw new AppError("uri must point to the given ipfsHash", 400);
  if (!(await PinnedMetadata.exists({ institutionId, cid }))) {
    throw new AppError("The credential details must be uploaded through DegreeNFT first (this metadata was not pinned for your college)", 400);
  }
};

// The wallet a college student proved through the invite (their linked account's primary wallet).
export const linkedWalletOf = async (studentId) => {
  const profile = await Student.findById(studentId).select("userId fullName");
  if (!profile?.userId) {
    throw new AppError(`${profile?.fullName || "The student"} has not linked a wallet yet: send them the wallet invite first`, 409);
  }
  const wallet = await Wallet.findOne({ userId: profile.userId, chain: "solana" }).sort({ isPrimary: -1, createdAt: 1 });
  if (!wallet) throw new AppError(`${profile.fullName} has no wallet on their account`, 409);
  return wallet.address;
};

// Batch upload: checks every sheet row against the college's own records before anything is issued, and says
// which enrollment and which (proved) wallet each credential will go to, or why the row can't be issued.
export const resolveCredentialRows = asyncHandler(async (req, res) => {
  const rows = req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError("No rows to check", 400);
  if (rows.length > 200) throw new AppError("Send at most 200 rows at a time", 400);
  const institutionId = req.institution._id;
  const results = [];
  for (const match of await matchStudentBatchRows(institutionId, rows)) {
    if (match.error) {
      results.push({ row: match.rowNo, error: match.error });
      continue;
    }
    const { student, program, batch } = match;
    const enrollment = await Enrollment.findOne({ institutionId, studentId: student._id, programSessionId: batch._id });
    const batchName = `${program.code} ${batch.startYear}-${batch.endYear}`;
    let error;
    if (!enrollment) error = `${student.fullName} is not enrolled in ${batchName}`;
    else if (enrollment.status === "CANCELLED") error = `${student.fullName}'s enrollment in ${batchName} is cancelled`;
    let wallet;
    if (!error) {
      try {
        wallet = await linkedWalletOf(student._id);
      } catch (walletError) {
        error = walletError.message;
      }
    }
    results.push({
      row: match.rowNo,
      ...(error && { error }),
      enrollmentId: enrollment._id,
      studentName: student.fullName,
      registrationNo: student.registrationNo,
      programCode: program.code,
      programName: program.name,
      startYear: batch.startYear,
      endYear: batch.endYear,
      wallet,
    });
  }
  res.status(200).json({ success: true, results });
});

export const issueCredential = asyncHandler(async (req, res) => {
  const { name, symbol, uri, ipfsHash, sellerFeeBasisPoints } = req.body;

  if (!name || !symbol || !uri || !ipfsHash) {
    throw new AppError("Missing required fields for the credential", 400);
  }

  // Verified by requireInstitution: the caller's active membership, never a body field.
  const institution = req.institution;

  if (institution.verificationStatus !== "VERIFIED" || institution.status !== "ACTIVE") {
    throw new AppError(
      "Institution must be verified and active before issuing credentials",
      403
    );
  }

  // Every credential belongs to one enrollment, looked up inside the caller's own college (a foreign id is "not found").
  // The type must be an Active entry of the college's own master list (Credential types page).
  await ensureCredentialTypes(institution._id);
  const credentialType = String(req.body.credentialType || "DEGREE").toUpperCase();
  if (!(await CredentialType.exists({ institutionId: institution._id, code: credentialType, status: "ACTIVE" }))) {
    throw new AppError(`"${credentialType}" is not an active credential type of this college`, 400);
  }
  if (!req.body.enrollmentId) throw new AppError("Choose the student's enrollment", 400);
  if (!mongoose.isValidObjectId(req.body.enrollmentId)) throw new AppError("Invalid enrollmentId", 400);
  const enrollment = await Enrollment.findOne({ _id: req.body.enrollmentId, institutionId: institution._id });
  if (!enrollment) throw new AppError("Enrollment not found at this institution", 404);
  if (enrollment.status === "CANCELLED") throw new AppError("Cannot issue a credential for a cancelled enrollment", 409);
  await assertPinnedHere(institution._id, uri, ipfsHash);
  // Only to the wallet the student proved (invite claim), never a typed one.
  const studentWallet = await linkedWalletOf(enrollment.studentId);

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
    contentHash: contentHashOf({ enrollmentId: enrollment._id, credentialType, name, ipfsHash }),
    enrollmentId: enrollment._id,
    studentId: enrollment.studentId,
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

// Every credential waiting for this student (not minted yet), oldest first, each with what the review screen needs.
export const getNextCredential = asyncHandler(async (req, res) => {
  const { walletAddress } = req.params;
  const wallet = await getStudentWallet(req.user, walletAddress);

  const pending = await Credential.find({ allocated: true, minted: false, ...walletFilter(wallet) })
    .sort({ allocatedAt: 1 })
    .populate("institutionId", "name code");

  if (pending.length) {
    const credentials = await Promise.all(
      pending.map(async (credential) => ({
        _id: credential._id,
        name: credential.name,
        symbol: credential.symbol,
        uri: credential.uri,
        ipfsHash: credential.ipfsHash,
        confirmationStatus: credential.status,
        isConfirmed: credential.isConfirmed,
        confirmationDeadline: credential.confirmationDeadline,
        revision: credential.revision,
        revisionNote: credential.previousRevisions.at(-1)?.reason || null,
        credentialType: credential.credentialType,
        academicStatus: credential.academicStatus || "ACTIVE",
        institutionName: credential.institutionId?.name || null,
        existingReport: Boolean(await Reports.exists(openReportsOf(credential))),
      })),
    );
    res.status(200).json({ authorized: true, credentials });
    return;
  }

  res.status(200).json({
    authorized: false,
    credentials: [],
    message: (await Credential.exists(walletFilter(wallet)))
      ? "All your credentials are already in your wallet. New ones appear here when your college issues them."
      : "No credential found for this wallet.",
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
  await assertPinnedHere(credential.institutionId, uri, ipfsHash);
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

  const json = JSON.stringify(metadata);
  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      pinata_api_key: process.env.PINATA_API_KEY,
      pinata_secret_api_key: process.env.PINATA_API_SECRET,
    },
    body: json,
  });

  if (!response.ok) {
    console.error("Pinata pin failed:", response.status, await response.text());
    throw new AppError("Failed to upload metadata to IPFS", 502);
  }

  const { IpfsHash } = await response.json();
  await PinnedMetadata.updateOne(
    { institutionId: req.institution._id, cid: IpfsHash },
    { $setOnInsert: { sha256: createHash("sha256").update(json).digest("hex"), pinnedBy: req.user._id } },
    { upsert: true },
  );
  await audit(req, { action: "credential.metadata.pin", scope: "INSTITUTION", targetType: "IPFS", targetId: IpfsHash, summary: `Pinned metadata for "${metadata.name}"` });
  res.status(200).json({ success: true, IpfsHash });
});

// The student claims a confirmed credential; the backend mints it into the student's own (signed-in) wallet,
// in the college's collection, paid by the platform and charged to the college's balance only on success.
// Retries are safe: the asset address is fixed before sending, so a timed-out mint is checked on-chain, not minted again.
export const claimCredential = asyncHandler(async (req, res) => {
  const wallet = await getStudentWallet(req.user, req.body.walletAddress);
  // Claiming again after success just returns the NFT (a double click, a retried request).
  if (mongoose.isValidObjectId(req.body.credentialId)) {
    const done = await Nft.findOne({ credentialId: req.body.credentialId, status: "MINTED", ownerWallet: wallet.address });
    if (done) return res.status(200).json({ success: true, nft: publicNft(done) });
  }
  const credential = await findOwnCredential(wallet, req.body);

  if ((credential.academicStatus || "ACTIVE") !== "ACTIVE") {
    throw new AppError(`This credential is ${credential.academicStatus.toLowerCase()} by your college and cannot be claimed`, 409);
  }
  // A student's open report on this credential stops the mint until the college resolves or corrects it.
  if (await Reports.exists(openReportsOf(credential))) {
    throw new AppError("An open report on this credential blocks minting", 409);
  }
  // Confirmed by the student, or the review window has passed.
  if (!credential.isConfirmed && credential.confirmationDeadline > new Date()) {
    throw new AppError("Confirm this credential before claiming it", 403);
  }

  const college = await CollegeChain.findOne({ institutionId: credential.institutionId }).select("+keys.minting.secretEncrypted");
  if (!college) throw new AppError("Your college is not set up for on-chain credentials yet", 409);
  assertSameNetwork(college);

  let nft = await Nft.findOne({ credentialId: credential._id }).select("+assetSecretEncrypted");
  if (nft && nft.status === "MINTED") return res.status(200).json({ success: true, nft: publicNft(nft) });

  if (!nft) {
    if ((await chain.feePayerBalance()).lamports < FEE_PAYER_MIN_LAMPORTS) {
      throw new AppError("Issuing is paused for a moment: the platform's fee wallet needs topping up. Nothing was charged; please try later.", 503);
    }
    const payment = pickPayment(await getBalances(credential.institutionId), await getPrices());
    if (!payment) throw new AppError("Your college's DegreeNFT balance is too low to issue this credential. Please ask your college to top up.", 409);
    const asset = chain.newKeypair();
    try {
      nft = await Nft.create({
        credentialId: credential._id,
        institutionId: credential.institutionId,
        userId: wallet.userId,
        network: college.network,
        collectionAddress: college.collectionAddress,
        assetAddress: asset.address,
        assetSecretEncrypted: encryptSecret(asset.secret),
        ownerWallet: wallet.address,
        revision: credential.revision,
        uri: credential.uri,
        contentHash: credential.contentHash,
        charge: payment,
      });
    } catch (error) {
      if (error.code === 11000) throw new AppError("This credential is already being claimed. Refresh in a moment.", 409);
      throw error;
    }
  }

  // Already on-chain (an earlier attempt landed after a timeout)? Then only record it.
  if (!(await chain.getAsset(nft.assetAddress))) {
    try {
      const { signature } = await chain.mintAsset({
        assetSecret: decryptSecret(nft.assetSecretEncrypted),
        collectionAddress: nft.collectionAddress,
        mintingSecret: decryptSecret(college.keys.minting.secretEncrypted),
        owner: nft.ownerWallet,
        name: credential.name,
        uri: nft.uri,
      });
      nft.mintSignature = signature;
      nft.attempts.push({ at: new Date(), outcome: "SENT", signature });
    } catch (error) {
      nft.attempts.push({ at: new Date(), outcome: "FAILED", error: String(error.message).slice(0, 300) });
      if (!(await chain.getAsset(nft.assetAddress))) {
        nft.status = "FAILED";
        await nft.save();
        throw new AppError("Minting did not go through. Nothing was charged; please try again.", 502);
      }
    }
  } else {
    nft.attempts.push({ at: new Date(), outcome: "FOUND_ON_CHAIN" });
  }

  // Never trust the send alone: the asset must exist, in the college collection, owned by the student.
  const onChain = await chain.getAsset(nft.assetAddress);
  if (!onChain || onChain.owner !== nft.ownerWallet || onChain.collection !== nft.collectionAddress) {
    nft.status = "FAILED";
    await nft.save();
    throw new AppError("The minted credential could not be verified on-chain. Nothing was charged.", 502);
  }

  const now = new Date();
  nft.set({ status: "MINTED", mintedAt: now, assetSecretEncrypted: undefined });
  nft.ownerHistory.push({ wallet: nft.ownerWallet, at: now, reason: "MINTED", signature: nft.mintSignature });
  await nft.save();

  // shortcut: two claims at the same moment can each pass the balance check, leaving a small negative balance (owed); add a per-college lock if that matters.
  try {
    await BillingEntry.create({
      institutionId: nft.institutionId,
      currency: nft.charge.currency,
      kind: "CHARGE",
      amount: -nft.charge.amount,
      credentialId: credential._id,
      note: `Credential minted: ${credential.name}`,
    });
  } catch (error) {
    if (error.code !== 11000) throw error; // already charged (a retried request)
  }

  credential.set({ status: "MINTED", minted: true, mintedAt: now, nftAddress: nft.assetAddress });
  if (!credential.userId && wallet.userId) credential.userId = wallet.userId;
  if (!credential.studentWalletId && wallet._id) credential.studentWalletId = wallet._id;
  await credential.save();
  await Institution.updateOne({ _id: credential.institutionId }, { $inc: { totalMinted: 1 } });
  if (credential.userId) {
    await StudentDetails.updateOne({ institutionId: credential.institutionId, userId: credential.userId }, { $inc: { studentTotalMintedNFT: 1 } });
  }

  await audit(req, {
    action: "credential.mint",
    scope: "INSTITUTION",
    institutionId: credential.institutionId,
    targetType: "Credential",
    targetId: credential._id,
    summary: `Minted "${credential.name}" to ${nft.ownerWallet}`,
    details: { assetAddress: nft.assetAddress, collectionAddress: nft.collectionAddress, charge: nft.charge },
  });
  res.status(200).json({ success: true, nft: publicNft(nft) });
});

const publicNft = (nft) => ({
  assetAddress: nft.assetAddress,
  collectionAddress: nft.collectionAddress,
  network: nft.network,
  ownerWallet: nft.ownerWallet,
  status: nft.status,
  mintSignature: nft.mintSignature,
  mintedAt: nft.mintedAt,
  revision: nft.revision,
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
