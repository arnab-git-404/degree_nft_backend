import mongoose from "mongoose";
import CredentialRequest from "../models/credentialRequest.js";
import Credential, { ACADEMIC_STATUSES } from "../models/credential.js";
import Student from "../models/student.js";
import Nft from "../models/nft.js";
import Wallet from "../models/wallet.js";
import CollegeChain from "../models/collegeChain.js";
import { chain, assertSameNetwork } from "../utils/chain.js";
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
  // Who can approve, and how many must: the page shows "1 of 2" and which wallets may sign.
  const college = await CollegeChain.findOne({ institutionId: req.institution._id }).lean();
  const multisig = college?.multisig && { threshold: college.multisig.threshold, members: college.multisig.members };
  res.status(200).json({ success: true, requests, multisig });
});

// Officials approve with their own wallets: the college's Squads multisig counts the approvals on-chain, so a
// recovery or burn needs `threshold` different officials even if this server were compromised. The app only builds
// the approval for the official to sign, sends it, and runs the action once the chain says it is approved.
const canApprove = (req) => memberCan(req, "approval:first") || memberCan(req, "approval:final");

const collegeFor = async (request) => {
  const college = await CollegeChain.findOne({ institutionId: request.institutionId });
  if (!college?.multisig?.address) throw new AppError("This college's collection has no officials' multisig; it must be set up again", 409);
  assertSameNetwork(college);
  return college;
};

const approverChecks = async (req, request) => {
  if (!canApprove(req)) throw new AppError("Forbidden", 403);
  if (request.status !== "PENDING_APPROVAL") throw new AppError(waitingMessage(request), 409);
  const wallet = String(req.query.wallet || req.body?.wallet || "");
  const college = await collegeFor(request);
  if (!college.multisig.members.includes(wallet)) throw new AppError("This wallet is not one of the college's approving officials", 403);
  if (request.walletApprovals.some((approval) => approval.wallet === wallet)) throw new AppError("This wallet has already approved", 409);
  if (request.kind === "BURN" && String(req.query.confirmIrreversible ?? req.body?.confirmIrreversible) !== "true") {
    throw new AppError("Burning cannot be undone: confirm it explicitly", 400);
  }
  return { wallet, college };
};

// The minted assets a request acts on: the student's credentials (recovery) or the one credential (burn).
const assetsFor = async (request) => {
  if (request.kind === "BURN") return Nft.find({ credentialId: request.credentialId, status: "MINTED" });
  const oldWallets = (await Wallet.find({ userId: request.fromUserId }).lean()).map((wallet) => wallet.address);
  const credentials = await Credential.find({
    institutionId: request.institutionId,
    $or: [{ studentId: request.studentId }, { studentWallet: { $in: oldWallets } }],
  }).select("_id");
  return Nft.find({ credentialId: { $in: credentials.map((credential) => credential._id) }, status: "MINTED", ownerWallet: { $ne: request.toWallet } });
};

// The on-chain proposal holding exactly what this request does; made once, when the first official asks to approve.
// shortcut: all assets go in one vault transaction (fine for a few credentials); split it if a student holds many.
const ensureProposal = async (request, college) => {
  if (request.proposal?.transactionIndex) return;
  const nfts = await assetsFor(request);
  if (!nfts.length) throw new AppError("There is no minted credential for this request to act on", 409);
  const actions = nfts.map((nft) =>
    request.kind === "RECOVERY"
      ? { kind: "transfer", assetAddress: nft.assetAddress, collectionAddress: nft.collectionAddress, newOwner: request.toWallet }
      : { kind: "burn", assetAddress: nft.assetAddress, collectionAddress: nft.collectionAddress },
  );
  const { transactionIndex } = await chain.proposeVaultActions({ multisigAddress: college.multisig.address, vaultAddress: college.multisig.vault, actions });
  request.proposal = { transactionIndex, assets: nfts.map((nft) => nft.assetAddress) };
  await request.save();
};

// Step 1: the approval transaction for one official's wallet to sign (the platform pays its fee).
export const getApprovalTx = asyncHandler(async (req, res) => {
  const request = await ownRequest(req);
  const { wallet, college } = await approverChecks(req, request);
  await ensureProposal(request, college);
  const transaction = await chain.buildApprovalTx({ multisigAddress: college.multisig.address, transactionIndex: request.proposal.transactionIndex, member: wallet });
  res.status(200).json({ success: true, transaction, approvals: request.walletApprovals.length, threshold: college.multisig.threshold });
});

// Step 2: the official's signed approval. Once enough officials approved on-chain, the action runs.
export const submitApprovalTx = asyncHandler(async (req, res) => {
  const request = await ownRequest(req);
  const { wallet, college } = await approverChecks(req, request);
  if (!request.proposal?.transactionIndex) throw new AppError("Ask for the approval transaction first", 409);
  const { signature } = await chain.submitApprovalTx({
    multisigAddress: college.multisig.address,
    transactionIndex: request.proposal.transactionIndex,
    member: wallet,
    signedTransaction: String(req.body?.signedTransaction || ""),
  });
  const approval = { wallet, userId: req.user._id, name: req.user.name, at: new Date(), signature };
  request.walletApprovals.push(approval);
  // Kept for the request history: who approved first, and whose approval completed it.
  if (!request.approvals?.first?.userId) request.approvals.first = approval;
  else request.approvals.final = approval;
  await request.save();
  await audit(req, {
    action: `credential.${request.kind.toLowerCase()}.approve`,
    scope: "INSTITUTION",
    targetType: "CredentialRequest",
    targetId: request._id,
    summary: `Approved a ${request.kind.toLowerCase()} request with wallet ${wallet}`,
    details: { wallet, signature, approvals: request.walletApprovals.length, threshold: college.multisig.threshold },
  });
  await execute(req, request, college);
  res.status(200).json({ success: true, request, threshold: college.multisig.threshold });
});

// The on-chain step failed (RPC trouble) after the officials approved: run it again; approvals stay.
export const retryRequest = asyncHandler(async (req, res) => {
  if (!canApprove(req)) throw new AppError("Forbidden", 403);
  const request = await ownRequest(req);
  if (request.status !== "FAILED") throw new AppError("Only a failed request can be run again", 409);
  await execute(req, request, await collegeFor(request));
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

// ---------------------------------------------------------------- running the action on-chain

// Runs the approved proposal (if not already run), then records what the chain now shows.
const execute = async (req, request, college) => {
  const ref = { multisigAddress: college.multisig.address, transactionIndex: request.proposal.transactionIndex };
  const proposal = await chain.getProposal(ref);
  if (!proposal || !["Approved", "Executed"].includes(proposal.status)) return; // still waiting for more officials
  let ok = true;
  if (proposal.status === "Approved") {
    try {
      const { signature } = await chain.executeProposal(ref);
      request.results.push({ signature, at: new Date() });
    } catch (error) {
      // It may have landed anyway (timeout): the records below are only updated from what the chain shows.
      request.results.push({ error: String(error.message).slice(0, 300), at: new Date() });
      ok = (await chain.getProposal(ref))?.status === "Executed";
    }
  }
  if (ok) ok = request.kind === "RECOVERY" ? await applyRecovery(request) : await applyBurn(request);
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

// After the vault moved the assets: record the new owner (history kept), re-point the student's credentials, and link
// the student profile to the new account (the old link is kept in walletHistory).
const applyRecovery = async (request) => {
  const signature = request.results.at(-1)?.signature;
  for (const assetAddress of request.proposal.assets) {
    const onChain = await chain.getAsset(assetAddress);
    if (onChain?.owner !== request.toWallet) {
      request.results.push({ assetAddress, error: "not owned by the new wallet on-chain", at: new Date() });
      return false;
    }
    const nft = await Nft.findOne({ assetAddress });
    if (nft.ownerWallet !== request.toWallet) {
      nft.set({ ownerWallet: request.toWallet, userId: request.toUserId });
      nft.ownerHistory.push({ wallet: request.toWallet, at: new Date(), reason: `RECOVERED: ${request.reason}`, signature });
      await nft.save();
    }
  }
  const oldWallets = (await Wallet.find({ userId: request.fromUserId }).lean()).map((wallet) => wallet.address);
  const newWallet = await Wallet.findOne({ chain: "solana", address: request.toWallet });
  await Credential.updateMany(
    { institutionId: request.institutionId, $or: [{ studentId: request.studentId }, { studentWallet: { $in: oldWallets } }] },
    { $set: { studentWallet: request.toWallet, userId: request.toUserId, ...(newWallet && { studentWalletId: newWallet._id }) } },
  );
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
  return true;
};

const applyBurn = async (request) => {
  const signature = request.results.at(-1)?.signature;
  for (const assetAddress of request.proposal.assets) {
    if (await chain.getAsset(assetAddress)) {
      request.results.push({ assetAddress, error: "the asset still exists on-chain", at: new Date() });
      return false;
    }
    const nft = await Nft.findOne({ assetAddress });
    if (nft.status !== "BURNED") {
      nft.status = "BURNED";
      nft.ownerHistory.push({ wallet: nft.ownerWallet, at: new Date(), reason: `BURNED: ${request.reason}`, signature });
      await nft.save();
    }
  }
  // The academic record stays (history is never deleted); it is no longer valid.
  const credential = await Credential.findById(request.credentialId);
  if (credential.academicStatus !== "REVOKED") {
    credential.academicStatus = "REVOKED";
    credential.statusHistory.push({ status: "REVOKED", reason: `Burned on-chain: ${request.reason}`, at: new Date() });
    await credential.save();
  }
  return true;
};
