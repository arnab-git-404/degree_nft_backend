import { audit, auditFailures } from "../utils/audit.js";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import User, { SUPER_ADMIN_ACCOUNT } from "../models/user.js";
import InstitutionMembership from "../models/institutionMembership.js";
import Wallet from "../models/wallet.js";
import Student from "../models/student.js";
import AuthNonce from "../models/authNonce.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { signToken } from "../utils/jwt.js";
import {
  buildAuthMessage,
  isValidSolanaAddress,
  verifyWalletSignature,
} from "../utils/solanaAuth.js";
import {
  backfillWalletReferences,
  findOrCreateUserByWallet,
} from "../services/userWalletService.js";
import {
  buildActivationUrl,
  createActivationToken,
  hashActivationToken,
} from "../utils/activationToken.js";
import { sendActivationEmail } from "../services/emailService.js";

const normalizeEmail = (email) => String(email).trim().toLowerCase();

const getAdminWalletAddresses = () =>
  [process.env.ADMIN_WALLET_ADDRESSES, process.env.ADMIN_WALLET_ADDRESS]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((address) => address.trim())
    .filter(Boolean);

const consumeNonce = async ({
  walletAddress,
  signature,
  signatureEncoding,
}) => {
  const nonceDoc = await AuthNonce.findOne({
    walletAddress,
    used: false,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!nonceDoc) {
    throw new AppError("Nonce not found or expired. Request a new nonce.", 400);
  }

  let isValid = false;

  try {
    isValid = verifyWalletSignature({
      walletAddress,
      message: nonceDoc.message,
      signature,
      encoding: signatureEncoding,
    });
  } catch {
    isValid = false;
  }

  if (!isValid) {
    throw new AppError("Invalid wallet signature", 401);
  }

  // Atomic claim: two concurrent requests replaying one signature cannot both succeed.
  const claimed = await AuthNonce.findOneAndUpdate(
    { _id: nonceDoc._id, used: false },
    { used: true },
    { new: true }
  );

  if (!claimed) {
    throw new AppError("Invalid wallet signature", 401);
  }

  return claimed;
};

const populateUser = async (user) => {
  await user.populate([
    { path: "roleId" },
    { path: "wallets" },
    { path: "primaryWallet" },
    { path: "institution" },
    { path: "studentProfiles" },
    {
      // Colleges this user can switch to; the server re-checks each request in requireInstitution.
      path: "memberships",
      match: { status: "ACTIVE" },
      populate: [
        { path: "institutionId", select: "name code status verificationStatus" },
        { path: "roleId", select: "name displayName permissions scope isActive" },
      ],
    },
  ]);

  return user;
};

const issueActivation = async (user) => {
  const { token, hash, expiresAt } = createActivationToken();

  user.activationTokenHash = hash;
  user.activationExpiresAt = expiresAt;
  await user.save();

  const activationUrl = buildActivationUrl(token);
  let delivery = "not_configured";

  try {
    const result = await sendActivationEmail({
      to: user.email,
      name: user.name,
      activationUrl,
    });

    delivery = result.delivered ? "sent" : result.provider;
  } catch (error) {
    delivery = "failed";
    console.error("Activation email delivery failed:", error.message);
  }

  return { activationUrl, delivery };
};

const activationPayload = ({ activationUrl, delivery }) => ({
  requiresActivation: true,
  emailDelivery: delivery,
  ...(process.env.NODE_ENV !== "production" && { activationUrl }),
});

export const requestNonce = asyncHandler(async (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress) {
    throw new AppError("walletAddress is required", 400);
  }

  if (!isValidSolanaAddress(walletAddress)) {
    throw new AppError("Invalid Solana wallet address", 400);
  }

  const nonce = randomBytes(32).toString("hex");
  const message = buildAuthMessage(walletAddress, nonce);
  const ttlMinutes = Number(process.env.AUTH_NONCE_TTL_MINUTES) || 5;
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await AuthNonce.create({ walletAddress, nonce, message, expiresAt });

  res.status(200).json({
    success: true,
    walletAddress,
    nonce,
    message,
    expiresAt,
  });
});

export const walletLogin = asyncHandler(auditFailures("auth.login.wallet", "ACCOUNT", (req) => ({ details: { walletAddress: req.body?.walletAddress } }))(async (req, res) => {
  const {
    walletAddress,
    signature,
    signatureEncoding = "base64",
    name,
  } = req.body;

  if (!walletAddress || !signature) {
    throw new AppError("walletAddress and signature are required", 400);
  }

  if (!isValidSolanaAddress(walletAddress)) {
    throw new AppError("Invalid Solana wallet address", 400);
  }

  await consumeNonce({ walletAddress, signature, signatureEncoding });

  const isAdminWallet = getAdminWalletAddresses().includes(walletAddress);

  // No self-signup: only wallets already on an account (or configured admin wallets) may sign in.
  if (
    !isAdminWallet &&
    !(await Wallet.exists({ chain: "solana", address: walletAddress }))
  ) {
    throw new AppError(
      "This wallet is not registered with DegreeNFT.",
      403,
      "WALLET_NOT_REGISTERED"
    );
  }

  const roleName = isAdminWallet ? "admin" : undefined;
  const { user, wallet } = await findOrCreateUserByWallet(walletAddress, {
    name,
    verified: true,
    roleName,
    account: isAdminWallet ? SUPER_ADMIN_ACCOUNT : undefined,
  });

  if (!user.isActive) {
    throw new AppError("User account is inactive", 403);
  }

  await backfillWalletReferences(user._id, wallet);
  user.lastLoginAt = new Date();
  await user.save();
  await populateUser(user);

  if (!user.roleId?.isActive) {
    throw new AppError("Your access has been revoked: your role is inactive", 403, "ACCESS_REVOKED");
  }

  await audit(req, { action: "auth.login.wallet", scope: "ACCOUNT", actor: user, targetType: "Wallet", targetId: wallet._id, summary: `Signed in with wallet ${walletAddress}` });

  res.status(200).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
  });
}));

// The student behind an emailed wallet-invite link, or a plain 400 when it is wrong, used or expired.
const findStudentInvite = async (token) => {
  const student = await Student.findOne({
    inviteTokenHash: hashActivationToken(token),
    inviteExpiresAt: { $gt: new Date() },
    userId: null,
  })
    .select("+inviteTokenHash")
    .populate("institutionId", "name code status");

  if (!student || student.institutionId?.status !== "ACTIVE" || student.studentStatus !== "ACTIVE") {
    throw new AppError("This invite link is invalid or has expired. Ask your college to send a new one.", 400, "INVALID_INVITE");
  }

  return student;
};

// Public: what the claim page shows before the student connects a wallet.
export const getStudentInvite = asyncHandler(async (req, res) => {
  const student = await findStudentInvite(req.params.token);

  res.status(200).json({
    success: true,
    invite: {
      studentName: student.fullName,
      registrationNo: student.registrationNo || null,
      collegeName: student.institutionId.name,
      walletHint: student.walletHint || null,
      expiresAt: student.inviteExpiresAt,
    },
  });
});

/**
 * Public: the student signs the challenge with their wallet. That proves they hold it, so the wallet is
 * saved (verified) on their account and the college's profile is linked to that account. Signs them in.
 * The link is single-use; the wallet the college guessed (walletHint) is never trusted, only the signed one.
 */
export const claimStudentInvite = asyncHandler(auditFailures("student.claim", "ACCOUNT", (req) => ({ details: { walletAddress: req.body?.walletAddress } }))(async (req, res) => {
  const { walletAddress, signature, signatureEncoding = "base64" } = req.body;

  if (!walletAddress || !signature) {
    throw new AppError("walletAddress and signature are required", 400);
  }

  if (!isValidSolanaAddress(walletAddress)) {
    throw new AppError("Invalid Solana wallet address", 400);
  }

  const student = await findStudentInvite(req.params.token);
  await consumeNonce({ walletAddress, signature, signatureEncoding });

  const { user, wallet } = await findOrCreateUserByWallet(walletAddress, { name: student.fullName, verified: true });

  if (!user.isActive) {
    throw new AppError("User account is inactive", 403);
  }

  // The link went to the student's email, so that address counts as verified unless another account already uses it.
  if (!user.email && !(await User.exists({ email: student.email, _id: { $ne: user._id } }))) {
    user.email = student.email;
    user.emailVerified = true;
  }

  // Atomic: two people racing on one link cannot both win.
  const claimed = await Student.findOneAndUpdate(
    { _id: student._id, userId: null, inviteTokenHash: student.inviteTokenHash },
    { $set: { userId: user._id, claimedAt: new Date() }, $unset: { inviteTokenHash: "", inviteExpiresAt: "" } }
  );

  if (!claimed) {
    throw new AppError("This invite has already been used.", 409, "INVALID_INVITE");
  }

  await backfillWalletReferences(user._id, wallet);
  user.lastLoginAt = new Date();
  await user.save();
  await populateUser(user);

  if (!user.roleId?.isActive) {
    throw new AppError("Your access has been revoked: your role is inactive", 403, "ACCESS_REVOKED");
  }

  await audit(req, {
    action: "student.claim",
    scope: "INSTITUTION",
    actor: user,
    institutionId: student.institutionId._id,
    targetType: "Student",
    targetId: student._id,
    summary: `${student.fullName} linked wallet ${walletAddress}`,
    details: { walletAddress, matchedHint: !student.walletHint || student.walletHint === walletAddress },
  });

  res.status(200).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
  });
}));

export const activateAccount = asyncHandler(async (req, res) => {
  const token = req.params.token || req.body.token;

  if (!token) {
    throw new AppError("Activation token is required", 400);
  }

  const user = await User.findOne({
    activationTokenHash: hashActivationToken(token),
    activationExpiresAt: { $gt: new Date() },
  });

  if (!user) {
    throw new AppError(
      "This activation link is invalid or has expired. Request a new link.",
      400,
      "INVALID_ACTIVATION_TOKEN"
    );
  }

  user.emailVerified = true;
  user.activationTokenHash = null;
  user.activationExpiresAt = null;
  user.lastLoginAt = new Date();
  await user.save();
  // Accepting the invite: the one-time link proves the invited person, so their college invites become ACTIVE.
  await InstitutionMembership.updateMany(
    { userId: user._id, status: "INVITED" },
    { status: "ACTIVE", acceptedAt: new Date() }
  );
  await populateUser(user);
  await audit(req, { action: "auth.account.activate", scope: "ACCOUNT", actor: user, targetType: "User", targetId: user._id, summary: "Activated account" });

  res.status(200).json({
    success: true,
    message: "Your account is now active.",
    token: signToken(user),
    user: user.toJSON(),
  });
});

export const resendActivation = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new AppError("Please provide a valid email address", 400);
  }

  const user = await User.findOne({ email: normalizeEmail(email) }).select(
    "+passwordHash"
  );
  let activation = null;

  if (user && !user.emailVerified && user.passwordHash) {
    activation = await issueActivation(user);
  }

  res.status(200).json({
    success: true,
    message:
      "If an inactive account exists for this address, a new activation link has been sent.",
    ...(activation ? activationPayload(activation) : { requiresActivation: true }),
  });
});

export const login = asyncHandler(auditFailures("auth.login.email", "ACCOUNT", (req) => ({ details: { email: String(req.body?.email || "").slice(0, 200) } }))(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new AppError("email and password are required", 400);
  }

  const user = await User.findOne({ email: normalizeEmail(email) })
    .select("+passwordHash")
    .populate("roleId");

  if (!user || !user.passwordHash) {
    throw new AppError("Invalid email or password", 401);
  }

  const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

  if (!isPasswordValid) {
    throw new AppError("Invalid email or password", 401);
  }

  if (!user.isActive) {
    throw new AppError("User account is inactive", 403);
  }

  if (!user.roleId?.isActive) {
    throw new AppError("Your access has been revoked: your role is inactive", 403, "ACCESS_REVOKED");
  }

  if (!user.emailVerified) {
    throw new AppError(
      "Please activate your account from the link we sent to your email.",
      403,
      "EMAIL_NOT_VERIFIED"
    );
  }

  user.lastLoginAt = new Date();
  await user.save();
  await populateUser(user);
  await audit(req, { action: "auth.login.email", scope: "ACCOUNT", actor: user, targetType: "User", targetId: user._id, summary: "Signed in with email" });

  res.status(200).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
  });
}));

export const getMe = asyncHandler(async (req, res) => {
  await populateUser(req.user);

  res.status(200).json({
    success: true,
    user: req.user.toJSON(),
  });
});

export const linkWallet = asyncHandler(async (req, res) => {
  const {
    walletAddress,
    signature,
    signatureEncoding = "base64",
    isPrimary = false,
  } = req.body;

  if (!walletAddress || !signature) {
    throw new AppError("walletAddress and signature are required", 400);
  }

  if (!isValidSolanaAddress(walletAddress)) {
    throw new AppError("Invalid Solana wallet address", 400);
  }

  await consumeNonce({ walletAddress, signature, signatureEncoding });

  let wallet = await Wallet.findOne({ chain: "solana", address: walletAddress });

  if (wallet && !wallet.userId.equals(req.user._id)) {
    throw new AppError("Wallet is already linked to another account", 409);
  }

  if (wallet) {
    wallet.isVerified = true;
    wallet.verifiedAt = new Date();

    if (isPrimary) {
      await Wallet.updateMany(
        { userId: req.user._id, isPrimary: true, _id: { $ne: wallet._id } },
        { isPrimary: false }
      );
      wallet.isPrimary = true;
    }
  } else {
    const hasWallet = await Wallet.exists({ userId: req.user._id });
    const makePrimary = Boolean(isPrimary) || !hasWallet;

    if (makePrimary) {
      await Wallet.updateMany(
        { userId: req.user._id, isPrimary: true },
        { isPrimary: false }
      );
    }

    wallet = new Wallet({
      userId: req.user._id,
      address: walletAddress,
      isPrimary: makePrimary,
      isVerified: true,
      verifiedAt: new Date(),
    });
  }

  await wallet.save();
  await backfillWalletReferences(req.user._id, wallet);
  await populateUser(req.user);
  await audit(req, { action: "account.wallet.link", scope: "ACCOUNT", targetType: "Wallet", targetId: wallet._id, summary: `Linked wallet ${wallet.address}` });

  res.status(200).json({
    success: true,
    wallet,
    user: req.user.toJSON(),
  });
});

export const setPrimaryWallet = asyncHandler(async (req, res) => {
  const wallet = await Wallet.findOne({
    _id: req.params.walletId,
    userId: req.user._id,
  });

  if (!wallet) {
    throw new AppError("Wallet not found", 404);
  }

  await Wallet.updateMany(
    { userId: req.user._id, isPrimary: true, _id: { $ne: wallet._id } },
    { isPrimary: false }
  );

  wallet.isPrimary = true;
  await wallet.save();
  await populateUser(req.user);
  await audit(req, { action: "account.wallet.primary", scope: "ACCOUNT", targetType: "Wallet", targetId: wallet._id, summary: `Set primary wallet ${wallet.address}` });

  res.status(200).json({
    success: true,
    wallet,
    user: req.user.toJSON(),
  });
});

export const unlinkWallet = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("+passwordHash");
  const wallet = await Wallet.findOne({
    _id: req.params.walletId,
    userId: req.user._id,
  });

  if (!wallet) {
    throw new AppError("Wallet not found", 404);
  }

  const walletCount = await Wallet.countDocuments({ userId: req.user._id });

  if (!user.passwordHash && walletCount <= 1) {
    throw new AppError(
      "This wallet is your sign-in method. Add another wallet before removing it.",
      400
    );
  }

  if (wallet.isPrimary) {
    await Wallet.updateMany(
      { userId: req.user._id, isPrimary: true },
      { isPrimary: false }
    );

    const replacement = await Wallet.findOne({
      userId: req.user._id,
      _id: { $ne: wallet._id },
    }).sort({ createdAt: 1 });

    if (replacement) {
      replacement.isPrimary = true;
      await replacement.save();
    }
  }

  await wallet.deleteOne();
  await populateUser(req.user);
  await audit(req, { action: "account.wallet.unlink", scope: "ACCOUNT", targetType: "Wallet", targetId: wallet._id, summary: `Unlinked wallet ${wallet.address}` });

  res.status(200).json({
    success: true,
    user: req.user.toJSON(),
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const fields = ["name", "phone", "bio", "avatarUrl"];
  const updates = {};

  for (const field of fields) {
    if (req.body[field] !== undefined) {
      updates[field] = String(req.body[field]).trim();
    }
  }

  if (updates.name !== undefined && !updates.name) {
    throw new AppError("Name cannot be empty", 400);
  }

  if (updates.bio && updates.bio.length > 280) {
    throw new AppError("Bio must be 280 characters or fewer", 400);
  }

  if (Object.keys(updates).length === 0) {
    throw new AppError("No profile fields to update", 400);
  }

  Object.assign(req.user, updates);
  await req.user.save();
  await populateUser(req.user);
  await audit(req, { action: "account.profile.update", scope: "ACCOUNT", targetType: "User", targetId: req.user._id, summary: "Updated profile", details: { fields: Object.keys(updates) } });

  res.status(200).json({
    success: true,
    user: req.user.toJSON(),
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || String(newPassword).length < 8) {
    throw new AppError(
      "New password must be at least 8 characters long",
      400
    );
  }

  const user = await User.findById(req.user._id).select("+passwordHash");

  if (!user.passwordHash) {
    throw new AppError(
      "This account signs in with a wallet and does not have a password.",
      400
    );
  }

  const isValid = await bcrypt.compare(
    String(currentPassword || ""),
    user.passwordHash
  );

  if (!isValid) {
    throw new AppError("Current password is incorrect", 401);
  }

  user.passwordHash = await bcrypt.hash(String(newPassword), 12);
  await user.save();
  await audit(req, { action: "account.password.change", scope: "ACCOUNT", targetType: "User", targetId: user._id, summary: "Changed password" });

  res.status(200).json({
    success: true,
    message: "Password updated successfully",
  });
});
