import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
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

const findRole = async (name) => {
  const role = await Role.findOne({ name, isActive: true });

  if (!role) {
    throw new AppError(`Role '${name}' is not configured`, 500);
  }

  return role;
};

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

  nonceDoc.used = true;
  await nonceDoc.save();

  return nonceDoc;
};

const populateUser = async (user) => {
  await user.populate([
    { path: "roleId" },
    { path: "wallets" },
    { path: "primaryWallet" },
    { path: "university" },
    { path: "studentProfiles" },
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

export const walletLogin = asyncHandler(async (req, res) => {
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

  const roleName = getAdminWalletAddresses().includes(walletAddress)
    ? "admin"
    : undefined;
  const { user, wallet } = await findOrCreateUserByWallet(walletAddress, {
    name,
    verified: true,
    roleName,
  });

  if (!user.isActive) {
    throw new AppError("User account is inactive", 403);
  }

  await backfillWalletReferences(user._id, wallet);
  user.lastLoginAt = new Date();
  await user.save();
  await populateUser(user);

  if (!user.roleId?.isActive) {
    throw new AppError("Your assigned role is inactive", 403);
  }

  res.status(200).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
  });
});

export const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const roleName = req.body.role || "student";

  if (!name || !email || !password) {
    throw new AppError("name, email and password are required", 400);
  }

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new AppError("Please provide a valid email address", 400);
  }

  if (String(password).length < 8) {
    throw new AppError("Password must be at least 8 characters long", 400);
  }

  if (!["student", "university"].includes(roleName)) {
    throw new AppError("role must be either student or university", 400);
  }

  const normalizedEmail = normalizeEmail(email);
  const existingUser = await User.findOne({ email: normalizedEmail });

  if (existingUser) {
    throw new AppError("Email is already registered", 409);
  }

  const role = await findRole(roleName);
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({
    name: String(name).trim(),
    email: normalizedEmail,
    passwordHash,
    roleId: role._id,
  });

  const activation = await issueActivation(user);
  await populateUser(user);

  res.status(201).json({
    success: true,
    message:
      "Account created. We sent an activation link to your email address.",
    user: user.toJSON(),
    ...activationPayload(activation),
  });
});

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
  await populateUser(user);

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

export const login = asyncHandler(async (req, res) => {
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
    throw new AppError("Your assigned role is inactive", 403);
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

  res.status(200).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
  });
});

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

  res.status(200).json({
    success: true,
    message: "Password updated successfully",
  });
});
