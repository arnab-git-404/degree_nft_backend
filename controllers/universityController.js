import University from "../models/university.js";
import Wallet from "../models/wallet.js";
import Role from "../models/role.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { backfillUniversityReferences } from "../services/userWalletService.js";

const ensureUniversityRole = async (user) => {
  const currentRole = user.roleId?.name;

  if (currentRole === "university" || currentRole === "admin") {
    return;
  }

  const universityRole = await Role.findOne({
    name: "university",
    isActive: true,
  });

  if (!universityRole) {
    throw new AppError("Role 'university' is not configured", 500);
  }

  user.roleId = universityRole._id;
  await user.save();
};

export const createProfile = asyncHandler(async (req, res) => {
  const {
    name,
    code,
    walletAddress,
    email,
    phone,
    website,
    logoUrl,
    address,
    accreditation,
  } = req.body;

  const existingProfile = await University.findOne({ userId: req.user._id });

  if (existingProfile) {
    await ensureUniversityRole(req.user);
    await req.user.populate("roleId");

    res.status(200).json({
      success: true,
      university: existingProfile,
      user: req.user.toJSON(),
    });
    return;
  }

  if (!name || !code) {
    throw new AppError("name and code are required", 400);
  }

  const normalizedCode = String(code).trim().toUpperCase();
  const duplicateCode = await University.findOne({ code: normalizedCode });

  if (duplicateCode) {
    throw new AppError("A university with this code already exists", 409);
  }

  let wallet;

  if (walletAddress) {
    wallet = await Wallet.findOne({
      chain: "solana",
      address: walletAddress,
      userId: req.user._id,
    });

    if (!wallet) {
      throw new AppError("Wallet is not linked to your account", 403);
    }
  } else {
    wallet = await Wallet.findOne({ userId: req.user._id }).sort({
      isPrimary: -1,
      createdAt: 1,
    });
  }

  if (!wallet) {
    throw new AppError(
      "Link a wallet to your account before creating a university profile",
      400
    );
  }

  const profile = await University.create({
    userId: req.user._id,
    name: String(name).trim(),
    code: normalizedCode,
    walletAddress: wallet.address,
    walletId: wallet._id,
    email,
    phone,
    website,
    logoUrl,
    address,
    accreditation,
  });

  await ensureUniversityRole(req.user);
  await req.user.populate("roleId");
  await backfillUniversityReferences(profile, wallet);

  res.status(201).json({
    success: true,
    university: profile,
    user: req.user.toJSON(),
  });
});

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await University.findOne({ userId: req.user._id });

  if (!profile) {
    throw new AppError("University profile not found", 404);
  }

  res.status(200).json({
    success: true,
    university: profile,
  });
});

export const batchUpload = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const getAllReports = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const getAllUploadedData = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};

export const updateNftAllocations = async (req, res) => {
  res
    .status(200)
    .json({ message: "This function is in the early stage of development..." });
};
