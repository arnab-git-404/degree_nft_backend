import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import RegistrationLink from "../models/registrationLink.js";
import UniversityApplication from "../models/universityApplication.js";
import University from "../models/university.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";

const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;
const CODE_PATTERN = /^[A-Z0-9-]{2,20}$/;

const field = (body, key, { required = false, max = 200 } = {}) => {
  const value = String(body?.[key] ?? "").trim();

  if (required && !value) {
    throw new AppError(`${key} is required`, 400);
  }

  if (value.length > max) {
    throw new AppError(`${key} must be ${max} characters or fewer`, 400);
  }

  return value;
};

// Public input: validate every field here, the request comes from an unauthenticated visitor.
export const parseApplication = (body) => {
  const application = {
    name: field(body, "name", { required: true }),
    code: field(body, "code", { required: true, max: 20 }).toUpperCase(),
    email: field(body, "email", { required: true }).toLowerCase(),
    contactName: field(body, "contactName", { required: true, max: 120 }),
    walletAddress: field(body, "walletAddress", { required: true, max: 64 }),
    phone: field(body, "phone", { max: 30 }),
    website: field(body, "website"),
    accreditation: field(body, "accreditation"),
    address: {
      city: field(body, "city", { max: 100 }),
      state: field(body, "state", { max: 100 }),
      country: field(body, "country", { max: 100 }),
    },
  };

  if (!CODE_PATTERN.test(application.code)) {
    throw new AppError(
      "code must be 2-20 characters: letters, numbers or hyphens",
      400
    );
  }

  if (!EMAIL_PATTERN.test(application.email)) {
    throw new AppError("Please provide a valid email address", 400);
  }

  if (!isValidSolanaAddress(application.walletAddress)) {
    throw new AppError("walletAddress must be a valid Solana address", 400);
  }

  // Admins will click this, so only allow http(s) links.
  if (application.website && !/^https?:\/\/\S+$/i.test(application.website)) {
    throw new AppError("website must start with http:// or https://", 400);
  }

  return application;
};

const findActiveLink = async (token) => {
  const link =
    typeof token === "string" && token.length <= 64
      ? await RegistrationLink.findOne({ token })
      : null;

  if (!link || !link.isActive) {
    throw new AppError(
      "This registration link is invalid or no longer active.",
      404,
      "REGISTRATION_LINK_INACTIVE"
    );
  }

  return link;
};

export const getPublicLink = asyncHandler(async (req, res) => {
  const link = await findActiveLink(req.params.token);

  res.status(200).json({ success: true, link: { label: link.label } });
});

export const submitApplication = asyncHandler(async (req, res) => {
  const link = await findActiveLink(req.params.token);
  const application = parseApplication(req.body);

  const [registeredUniversity, openApplication] = await Promise.all([
    University.exists({
      $or: [
        { code: application.code },
        { walletAddress: application.walletAddress },
      ],
    }),
    UniversityApplication.exists({
      status: { $ne: "REJECTED" },
      $or: [
        { code: application.code },
        { email: application.email },
        { walletAddress: application.walletAddress },
      ],
    }),
  ]);

  if (registeredUniversity || openApplication) {
    throw new AppError(
      "An application or university with this code, email or wallet address already exists.",
      409
    );
  }

  await UniversityApplication.create({ ...application, linkId: link._id });
  await RegistrationLink.updateOne(
    { _id: link._id },
    { $inc: { submissionCount: 1 } }
  );

  res.status(201).json({
    success: true,
    message:
      "Application received. You will be contacted once it has been reviewed.",
  });
});

export const getRegistrationLinks = asyncHandler(async (req, res) => {
  // shortcut: no pagination, fine while admins create a handful of links; paginate if it grows past ~100.
  const links = await RegistrationLink.find()
    .sort({ createdAt: -1 })
    .populate("createdBy", "name email");

  res.status(200).json({ success: true, links });
});

export const createRegistrationLink = asyncHandler(async (req, res) => {
  const label = field(req.body, "label", { required: true, max: 100 });

  const link = await RegistrationLink.create({
    token: randomBytes(24).toString("base64url"),
    label,
    createdBy: req.user._id,
  });
  await link.populate("createdBy", "name email");

  res.status(201).json({ success: true, link });
});

export const updateRegistrationLink = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.linkId)) {
    throw new AppError("Registration link not found", 404);
  }

  const link = await RegistrationLink.findById(req.params.linkId);

  if (!link) {
    throw new AppError("Registration link not found", 404);
  }

  const { isActive } = req.body;

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      throw new AppError("isActive must be a boolean", 400);
    }

    link.isActive = isActive;
  }

  if (req.body.label !== undefined) {
    link.label = field(req.body, "label", { required: true, max: 100 });
  }

  await link.save();
  await link.populate("createdBy", "name email");

  res.status(200).json({ success: true, link });
});
