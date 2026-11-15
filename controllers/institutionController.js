import { audit } from "../utils/audit.js";
import Institution from "../models/institution.js";
import Wallet from "../models/wallet.js";
import Role from "../models/role.js";
import InstitutionMembership from "../models/institutionMembership.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { backfillInstitutionReferences } from "../services/userWalletService.js";

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

  const existingProfile = await Institution.findOne({ userId: req.user._id });

  if (existingProfile) {
    res.status(200).json({
      success: true,
      institution: existingProfile,
      user: req.user.toJSON(),
    });
    return;
  }

  if (!name || !code) {
    throw new AppError("name and code are required", 400);
  }

  const normalizedCode = String(code).trim().toUpperCase();
  const duplicateCode = await Institution.findOne({ code: normalizedCode });

  if (duplicateCode) {
    throw new AppError("An institution with this code already exists", 409);
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
      "Link a wallet to your account before creating an institution profile",
      400
    );
  }

  const profile = await Institution.create({
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

  // shortcut: the self-serve creator becomes the college head; P03 replaces this with Super Admin appointment on approval.
  const adminRole = await Role.findOne({ name: "institution_admin", scope: "INSTITUTION" });
  if (!adminRole) {
    throw new AppError("Role 'institution_admin' is not configured", 500);
  }
  const membership = await InstitutionMembership.create({
    userId: req.user._id,
    institutionId: profile._id,
    roleId: adminRole._id,
    status: "ACTIVE",
    acceptedAt: new Date(),
  });
  profile.primaryAdminMembershipId = membership._id;
  await profile.save();
  await audit(req, { action: "institution.create", scope: "INSTITUTION", institutionId: profile._id, targetType: "Institution", targetId: profile._id, summary: `Created institution ${profile.name} (${profile.code}); creator is its head` });

  await backfillInstitutionReferences(profile, wallet);

  res.status(201).json({
    success: true,
    institution: profile,
    user: req.user.toJSON(),
  });
});

export const getProfile = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    institution: req.institution,
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
