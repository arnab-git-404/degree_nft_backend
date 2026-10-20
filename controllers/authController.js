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

  await populateUser(user);

  res.status(201).json({
    success: true,
    token: signToken(user),
    user: user.toJSON(),
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
