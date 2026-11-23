import mongoose from "mongoose";
import CredentialRequest from "../models/credentialRequest.js";
import Credential, { ACADEMIC_STATUSES } from "../models/credential.js";
import Student from "../models/student.js";
import Nft from "../models/nft.js";
import Wallet from "../models/wallet.js";
import CollegeChain from "../models/collegeChain.js";
import { chain } from "../utils/chain.js";
import { decryptSecret } from "../utils/secretBox.js";
import { buildRecoveryUrl, createActivationToken, STUDENT_INVITE_DAYS } from "../utils/activationToken.js";
import { trySendTemplateEmail } from "../services/emailService.js";
import { audit } from "../utils/audit.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

const APPROVAL_PERMISSIONS = ["approval:first", "approval:final", "credential:recover", "credential:burn"];

// Permissions come from the member's role at THIS college (set by requireInstitution), never the account role.
const memberCan = (req, permission) => {
  const permissions = req.membership?.roleId?.permissions || [];
  return permissions.includes("*") || permissions.includes(permission);
};
const who = (req) => ({ userId: req.user._id, name: req.user.name, at: new Date() });
const reasonFrom = (body) => {
  const reason = String(body?.reason ?? "").trim();
  if (reason.length < 3) throw new AppError("Give a reason (at least 3 characters)", 400);
  if (reason.length > 500) throw new AppError("The reason is too long (500 characters at most)", 400);
  return reason;
};
const idParam = (value, label) => {
  if (!mongoose.isValidObjectId(value)) throw new AppError(`Invalid ${label}`, 400);
  return value;
};
const ownRequest = async (req) => {
  const request = await CredentialRequest.findOne({ _id: idParam(req.params.requestId, "request id"), institutionId: req.institution._id });
  if (!request) throw new AppError("Request not found", 404);
  return request;
};

// ---------------------------------------------------------------- academic status (one person, with a reason)

export const changeAcademicStatus = asyncHandler(async (req, res) => {
  const status = String(req.body?.status || "");
  if (!ACADEMIC_STATUSES.includes(status)) throw new AppError(`status must be one of ${ACADEMIC_STATUSES.join(", ")}`, 400);
  const reason = reasonFrom(req.body);
  const credential = await Credential.findOne({ _id: idParam(req.params.credentialId, "credential id"), institutionId: req.institution._id });
  if (!credential) throw new AppError("Credential not found", 404);
  const from = credential.academicStatus || "ACTIVE";
  if (from === status) throw new AppError(`The credential is already ${status.toLowerCase()}`, 409);

  credential.academicStatus = status;
  credential.statusHistory.push({ status, reason, by: req.user._id, byName: req.user.name, at: new Date() });
  await credential.save();
  await audit(req, {
    action: "credential.status",
    scope: "INSTITUTION",
    targetType: "Credential",
    targetId: credential._id,
    summary: `${credential.name}: ${from} → ${status}`,
    details: { from, to: status, reason },
  });
  res.status(200).json({ success: true, academicStatus: credential.academicStatus, statusHistory: credential.statusHistory });
});

// ---------------------------------------------------------------- starting requests

// The student lost their wallet: email them a link to prove the NEW wallet. Approvals come after that.
export const startRecovery = asyncHandler(async (req, res) => {
  const reason = reasonFrom(req.body);
  const student = await Student.findOne({ _id: idParam(req.params.studentId, "student id"), institutionId: req.institution._id });
  if (!student) throw new AppError("Student not found", 404);
  if (!student.userId) throw new AppError("This student has not linked a wallet yet; send a normal invite instead", 409);
  if (!student.email) throw new AppError("Add the student's email first: the recovery link is sent there", 400);

  const { token, hash, expiresAt } = createActivationToken(STUDENT_INVITE_DAYS * 24);
  let request;
  try {
    request = await CredentialRequest.create({
      institutionId: req.institution._id,
      kind: "RECOVERY",
      status: "WAITING_FOR_WALLET",
      reason,
      requestedBy: who(req),
      studentId: student._id,
      fromUserId: student.userId,
      tokenHash: hash,
      tokenExpiresAt: expiresAt,
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError("This student already has an open recovery request", 409);
    throw error;
  }

  const recoveryUrl = buildRecoveryUrl(token);
  const delivery = await trySendTemplateEmail("walletRecovery", student.email, { name: student.fullName, collegeName: req.institution.name, recoveryUrl });
  await audit(req, {
    action: "credential.recovery.start",
    scope: "INSTITUTION",
    targetType: "Student",
    targetId: student._id,
    summary: `Started wallet recovery for ${student.fullName}`,
    details: { requestId: request._id, reason, delivery },
  });
  res.status(201).json({ success: true, request, delivery, ...(process.env.NODE_ENV !== "production" && { recoveryUrl }) });
});

export const requestBurn = asyncHandler(async (req, res) => {
  const reason = reasonFrom(req.body);
  const credential = await Credential.findOne({ _id: idParam(req.params.credentialId, "credential id"), institutionId: req.institution._id });
  if (!credential) throw new AppError("Credential not found", 404);
  if (!(await Nft.exists({ credentialId: credential._id, status: "MINTED" }))) throw new AppError("Only a minted credential can be burned", 409);
  let request;
  try {
    request = await CredentialRequest.create({
      institutionId: req.institution._id,
      kind: "BURN",
      status: "PENDING_APPROVAL",
      reason,
      requestedBy: who(req),
      credentialId: credential._id,
    });
  } catch (error) {
    if (error.code === 11000) throw new AppError("This credential already has an open burn request", 409);
    throw error;
  }
  await audit(req, {
    action: "credential.burn.request",
    scope: "INSTITUTION",
    targetType: "Credential",
    targetId: credential._id,
    summary: `Requested burning ${credential.name}`,
    details: { requestId: request._id, reason },
  });
  res.status(201).json({ success: true, request });
});

// ---------------------------------------------------------------- listing and approving

export const listRequests = asyncHandler(async (req, res) => {
  if (!APPROVAL_PERMISSIONS.some((permission) => memberCan(req, permission))) throw new AppError("Forbidden", 403);
  const requests = await CredentialRequest.find({ institutionId: req.institution._id })
    .populate("studentId", "fullName registrationNo email")
    .populate("credentialId", "name credentialType studentWallet")
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.status(200).json({ success: true, requests });
});

export const approveFirst = asyncHandler(async (req, res) => {
  const request = await ownRequest(req);
  if (request.status !== "PENDING_APPROVAL") throw new AppError(waitingMessage(request), 409);
  if (request.approvals?.first?.userId) throw new AppError("The first approval is already given", 409);
  request.approvals.first = who(req);
  await request.save();
  await audit(req, approvalLog(request, "first"));
  res.status(200).json({ success: true, request });
});

// The second approval, by a different person, runs the action on-chain straight away.
export const approveFinal = asyncHandler(async (req, res) => {
  const request = await ownRequest(req);
  if (request.status !== "PENDING_APPROVAL") throw new AppError(waitingMessage(request), 409);
  if (!request.approvals?.first?.userId) throw new AppError("The first approval is needed before the final one", 409);
  if (String(request.approvals.first.userId) === String(req.user._id)) {
    throw new AppError("The final approval must come from a different person than the first", 403);
  }
  if (request.kind === "BURN" && req.body?.confirmIrreversible !== true) {
    throw new AppError("Burning cannot be undone: confirm it explicitly", 400);
  }
  request.approvals.final = who(req);
  await request.save();
  await audit(req, approvalLog(request, "final"));
  await execute(req, request);
  res.status(200).json({ success: true, request });
});

// A request whose on-chain step failed (RPC trouble) can be run again by a final approver; approvals stay.
export const retryRequest = asyncHandler(async (req, res) => {
  const request = await ownRequest(req);
  if (request.status !== "FAILED") throw new AppError("Only a failed request can be run again", 409);
  await execute(req, request);
  res.status(200).json({ success: true, request });
});

export const rejectRequest = asyncHandler(async (req, res) => {
  if (!memberCan(req, "approval:first") && !memberCan(req, "approval:final")) throw new AppError("Forbidden", 403);
  const reason = reasonFrom(req.body);
  const request = await ownRequest(req);
  if (!["WAITING_FOR_WALLET", "PENDING_APPROVAL", "FAILED"].includes(request.status)) throw new AppError("This request is already closed", 409);
  request.set({ status: "REJECTED", open: false, rejection: { ...who(req), reason }, tokenHash: undefined });
  await request.save();
  await audit(req, {
    action: `credential.${request.kind.toLowerCase()}.reject`,
    scope: "INSTITUTION",
    targetType: "CredentialRequest",
    targetId: request._id,
    summary: `Rejected the ${request.kind.toLowerCase()} request`,
    details: { reason },
  });
  res.status(200).json({ success: true, request });
});

const waitingMessage = (request) =>
  request.status === "WAITING_FOR_WALLET" ? "The student has not proved the new wallet yet" : `This request is ${request.status.toLowerCase().replace(/_/g, " ")}`;
const approvalLog = (request, stage) => ({
  action: `credential.${request.kind.toLowerCase()}.approve`,
  scope: "INSTITUTION",
  targetType: "CredentialRequest",
  targetId: request._id,
  summary: `Gave the ${stage} approval for a ${request.kind.toLowerCase()} request`,
  details: { stage },
});

// ---------------------------------------------------------------- running the action on-chain

const execute = async (req, request) => {
  const college = await CollegeChain.findOne({ institutionId: request.institutionId }).select("+keys.recovery.secretEncrypted +keys.burn.secretEncrypted");
  if (!college) throw new AppError("This college has no on-chain collection", 409);
  const ok = request.kind === "RECOVERY" ? await runRecovery(request, college) : await runBurn(request, college);
  request.status = ok ? "EXECUTED" : "FAILED";
  if (ok) request.set({ open: false, executedAt: new Date(), tokenHash: undefined });
  await request.save();
  await audit(req, {
    action: `credential.${request.kind.toLowerCase()}.execute`,
    scope: "INSTITUTION",
    outcome: ok ? "SUCCESS" : "FAILURE",
    targetType: "CredentialRequest",
    targetId: request._id,
    summary: `${request.kind === "RECOVERY" ? "Wallet recovery" : "Burn"} ${ok ? "done" : "failed; can be retried"}`,
    details: { results: request.results.slice(-10) },
  });
};

// Moves every minted credential of this student at this college to the proved wallet, keeps the history,
// re-points unminted credentials, and links the student profile to the new account (old link kept in walletHistory).
const runRecovery = async (request, college) => {
  const recoverySecret = decryptSecret(college.keys.recovery.secretEncrypted);
  // This college's credentials of this student: by profile, or (issued without an enrollment) by the old account's wallets.
  const oldWallets = (await Wallet.find({ userId: request.fromUserId }).lean()).map((wallet) => wallet.address);
  const credentials = await Credential.find({
    institutionId: request.institutionId,
    $or: [{ studentId: request.studentId }, { studentWallet: { $in: oldWallets } }],
  });
  const newWallet = await Wallet.findOne({ chain: "solana", address: request.toWallet });
  let ok = true;

  for (const credential of credentials) {
    const nft = await Nft.findOne({ credentialId: credential._id, status: "MINTED" });
    if (nft && nft.ownerWallet !== request.toWallet) {
      try {
        const onChain = await chain.getAsset(nft.assetAddress);
        let signature;
        if (onChain?.owner !== request.toWallet) {
          ({ signature } = await chain.transferAsset({
            assetAddress: nft.assetAddress,
            collectionAddress: nft.collectionAddress,
            recoverySecret,
            newOwner: request.toWallet,
          }));
        }
        const after = await chain.getAsset(nft.assetAddress);
        if (after?.owner !== request.toWallet) throw new Error("the asset is not owned by the new wallet after the transfer");
        nft.ownerWallet = request.toWallet;
        nft.userId = request.toUserId;
        nft.ownerHistory.push({ wallet: request.toWallet, at: new Date(), reason: `RECOVERED: ${request.reason}`, signature });
        await nft.save();
        request.results.push({ assetAddress: nft.assetAddress, signature, at: new Date() });
      } catch (error) {
        ok = false;
        request.results.push({ assetAddress: nft.assetAddress, error: String(error.message).slice(0, 300), at: new Date() });
        continue; // leave this credential on the old wallet; a retry picks it up
      }
    }
    credential.set({ studentWallet: request.toWallet, userId: request.toUserId, ...(newWallet && { studentWalletId: newWallet._id }) });
    await credential.save();
  }

  if (ok) {
    const student = await Student.findById(request.studentId);
    if (String(student.userId) !== String(request.toUserId)) {
      student.walletHistory.push({
        userId: student.userId,
        wallet: (await Wallet.findOne({ userId: student.userId, isPrimary: true }))?.address,
        linkedAt: student.claimedAt,
        unlinkedAt: new Date(),
        reason: request.reason,
        requestId: request._id,
      });
      student.set({ userId: request.toUserId, claimedAt: new Date() });
      await student.save();
    }
  }
  return ok;
};

const runBurn = async (request, college) => {
  const nft = await Nft.findOne({ credentialId: request.credentialId, status: "MINTED" });
  if (!nft) {
    request.results.push({ error: "no minted credential to burn", at: new Date() });
    return false;
  }
  try {
    let signature;
    if (await chain.getAsset(nft.assetAddress)) {
      ({ signature } = await chain.burnAsset({
        assetAddress: nft.assetAddress,
        collectionAddress: nft.collectionAddress,
        burnSecret: decryptSecret(college.keys.burn.secretEncrypted),
      }));
    }
    if (await chain.getAsset(nft.assetAddress)) throw new Error("the asset still exists after the burn");
    nft.status = "BURNED";
    nft.ownerHistory.push({ wallet: nft.ownerWallet, at: new Date(), reason: `BURNED: ${request.reason}`, signature });
    await nft.save();
    // The academic record stays (history is never deleted); it is no longer valid.
    const credential = await Credential.findById(request.credentialId);
    credential.academicStatus = "REVOKED";
    credential.statusHistory.push({ status: "REVOKED", reason: `Burned on-chain: ${request.reason}`, at: new Date() });
    await credential.save();
    request.results.push({ assetAddress: nft.assetAddress, signature, at: new Date() });
    return true;
  } catch (error) {
    request.results.push({ assetAddress: nft.assetAddress, error: String(error.message).slice(0, 300), at: new Date() });
    return false;
  }
};
