import { audit } from "../utils/audit.js";
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import RegistrationLink from "../models/registrationLink.js";
import InstitutionApplication from "../models/institutionApplication.js";
import Institution from "../models/institution.js";
import InstitutionMembership from "../models/institutionMembership.js";
import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
import { buildActivationUrl, createActivationToken } from "../utils/activationToken.js";
import { trySendTemplateEmail } from "../services/emailService.js";
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

  if (!link || !link.isActive || (link.expiresAt && link.expiresAt <= new Date())) {
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

export const WALLET_CONFLICT_MESSAGES = {
  WALLET_REGISTERED: "An institution is already registered with this wallet address.",
  WALLET_PENDING:
    "An application with this wallet address has already been submitted and is awaiting review.",
  // Approval refuses wallets owned by an existing account, so stop the application here.
  WALLET_IN_USE:
    "This wallet already belongs to a DegreeNFT account. Use a different wallet for your institution.",
};

// Why this wallet cannot apply (a WALLET_CONFLICT_MESSAGES key), or null when it is free.
export const walletConflict = ({ institution, application, account }) => {
  if (institution || application?.status === "APPROVED") return "WALLET_REGISTERED";
  if (application) return "WALLET_PENDING";
  if (account) return "WALLET_IN_USE";
  return null;
};

const findWalletConflict = async (walletAddress) => {
  const [institution, application, account] = await Promise.all([
    Institution.exists({ walletAddress }),
    InstitutionApplication.findOne({ walletAddress, status: { $ne: "REJECTED" } }).select("status"),
    Wallet.exists({ chain: "solana", address: walletAddress }),
  ]);

  return walletConflict({ institution, application, account });
};

// Live check while the applicant types; submitApplication repeats it, so this is only a hint.
export const checkApplicationWallet = asyncHandler(async (req, res) => {
  await findActiveLink(req.params.token);
  const walletAddress = String(req.params.walletAddress ?? "").trim();

  if (!isValidSolanaAddress(walletAddress)) {
    throw new AppError("walletAddress must be a valid Solana address", 400);
  }

  const conflict = await findWalletConflict(walletAddress);
  const previouslyRejected =
    !conflict && Boolean(await InstitutionApplication.exists({ walletAddress, status: "REJECTED" }));

  res.status(200).json({
    success: true,
    status: conflict ?? "AVAILABLE",
    message: conflict
      ? WALLET_CONFLICT_MESSAGES[conflict]
      : previouslyRejected
        ? "A previous application from this wallet was not approved. You can submit a new one."
        : "",
  });
});

export const submitApplication = asyncHandler(async (req, res) => {
  const link = await findActiveLink(req.params.token);
  const application = parseApplication(req.body);

  const conflict = await findWalletConflict(application.walletAddress);

  if (conflict) {
    throw new AppError(WALLET_CONFLICT_MESSAGES[conflict], 409, conflict);
  }

  const [registeredInstitution, openApplication] = await Promise.all([
    Institution.exists({ code: application.code }),
    InstitutionApplication.exists({
      status: { $ne: "REJECTED" },
      $or: [{ code: application.code }, { email: application.email }],
    }),
  ]);

  if (registeredInstitution || openApplication) {
    throw new AppError(
      "An application or institution with this code or email already exists.",
      409
    );
  }

  const created = await InstitutionApplication.create({ ...application, linkId: link._id });
  await audit(req, { action: "registration.application.submit", targetType: "InstitutionApplication", targetId: created._id, summary: `Application from ${application.name} (${application.code})` });
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
  const expiresInDays = Number(req.body?.expiresInDays ?? 30);

  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    throw new AppError("expiresInDays must be a whole number from 1 to 365", 400);
  }

  const link = await RegistrationLink.create({
    token: randomBytes(24).toString("base64url"),
    label,
    createdBy: req.user._id,
    expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
  });
  await link.populate("createdBy", "name email");
  await audit(req, { action: "admin.registrationLink.create", targetType: "RegistrationLink", targetId: link._id, summary: `Created registration link "${link.label}"` });

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
  await audit(req, { action: "admin.registrationLink.update", targetType: "RegistrationLink", targetId: link._id, summary: `Updated registration link "${link.label}"`, details: { isActive: link.isActive } });

  res.status(200).json({ success: true, link });
});

const loadApplication = async (applicationId) => {
  if (!/^[a-f0-9]{24}$/i.test(String(applicationId))) {
    throw new AppError("Application not found", 404);
  }

  const application = await InstitutionApplication.findById(applicationId);

  if (!application) {
    throw new AppError("Application not found", 404);
  }

  return application;
};

/**
 * Super Admin approval (design §10.2). One transaction creates the head's account and wallet,
 * the ACTIVE institution, an INVITED institution_admin membership (the head) and marks the
 * application APPROVED. Repeating the call returns the same institution instead of a new tenant.
 */
export const approveApplication = asyncHandler(async (req, res) => {
  const application = await loadApplication(req.params.applicationId);

  if (application.status === "APPROVED") {
    const institution = await Institution.findById(application.institutionId);
    res.status(200).json({ success: true, alreadyApproved: true, application, institution });
    return;
  }

  if (application.status !== "PENDING") {
    throw new AppError(`Only PENDING applications can be approved (this one is ${application.status})`, 409);
  }

  // Never attach college-admin rights to an account that already exists (design §10.2).
  const [codeTaken, emailTaken, walletTaken] = await Promise.all([
    Institution.exists({ code: application.code }),
    User.exists({ email: application.email }),
    Wallet.exists({ chain: "solana", address: application.walletAddress }),
  ]);

  if (codeTaken) throw new AppError(`An institution with code ${application.code} already exists`, 409);
  if (emailTaken) throw new AppError("An account with this email already exists; ask the applicant for a new contact email", 409);
  if (walletTaken) throw new AppError("This wallet already belongs to an account; ask the applicant for a new wallet", 409);

  const [studentRole, headRole] = await Promise.all([
    Role.findOne({ name: "student", isActive: true }),
    Role.findOne({ name: "institution_admin", scope: "INSTITUTION", isActive: true }),
  ]);

  if (!studentRole || !headRole) {
    throw new AppError("Default roles are not configured", 500);
  }

  const activation = createActivationToken();
  let institution;
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Claim the application inside the transaction: a concurrent approve finds it no longer PENDING.
      const claimed = await InstitutionApplication.findOneAndUpdate(
        { _id: application._id, status: "PENDING" },
        { status: "APPROVED", reviewedBy: req.user._id, reviewedAt: new Date() },
        { new: true, session }
      );

      if (!claimed) {
        throw new AppError("This application was just reviewed by someone else", 409);
      }

      const [head] = await User.create(
        [
          {
            name: application.contactName,
            email: application.email,
            roleId: studentRole._id,
            userType: "ADMIN",
            activationTokenHash: activation.hash,
            activationExpiresAt: activation.expiresAt,
          },
        ],
        { session }
      );

      const [wallet] = await Wallet.create(
        [{ userId: head._id, address: application.walletAddress, isPrimary: true, isVerified: false }],
        { session }
      );

      [institution] = await Institution.create(
        [
          {
            userId: head._id,
            name: application.name,
            code: application.code,
            status: "ACTIVE",
            verificationStatus: "VERIFIED",
            applicationId: application._id,
            walletAddress: wallet.address,
            walletId: wallet._id,
            email: application.email,
            phone: application.phone,
            website: application.website,
            accreditation: application.accreditation,
            address: application.address,
          },
        ],
        { session }
      );

      const [membership] = await InstitutionMembership.create(
        [
          {
            userId: head._id,
            institutionId: institution._id,
            roleId: headRole._id,
            status: "INVITED",
            invitedBy: req.user._id,
            invitedAt: new Date(),
          },
        ],
        { session }
      );

      institution.primaryAdminMembershipId = membership._id;
      await institution.save({ session });

      claimed.institutionId = institution._id;
      await claimed.save({ session });
    });
  } catch (error) {
    // A concurrent approve that won the race created the tenant: answer with it (idempotent).
    const current = await InstitutionApplication.findById(application._id);
    if (current?.status === "APPROVED" && current.institutionId) {
      const existing = await Institution.findById(current.institutionId);
      res.status(200).json({ success: true, alreadyApproved: true, application: current, institution: existing });
      return;
    }
    throw error;
  } finally {
    await session.endSession();
  }

  // shortcut: email is sent right after commit, not through an outbox worker; if it fails the admin
  // still sees the link (non-production). Add an outbox before production (P09).
  const activationUrl = buildActivationUrl(activation.token);
  const delivery = await trySendTemplateEmail("applicationApproved", application.email, {
    contactName: application.contactName,
    institutionName: application.name,
    code: application.code,
    activationUrl,
  });

  await audit(req, {
    action: "admin.application.approve",
    institutionId: institution._id,
    targetType: "InstitutionApplication",
    targetId: application._id,
    summary: `Approved ${application.name} (${application.code}); invited ${application.contactName} as head`,
    details: { emailDelivery: delivery },
  });

  const approved = await InstitutionApplication.findById(application._id);
  res.status(201).json({
    success: true,
    application: approved,
    institution,
    emailDelivery: delivery,
    ...(process.env.NODE_ENV !== "production" && { activationUrl }),
  });
});

export const rejectApplication = asyncHandler(async (req, res) => {
  const reason = field(req.body, "reason", { required: true, max: 1000 });
  const { _id } = await loadApplication(req.params.applicationId);
  const application = await InstitutionApplication.findOneAndUpdate(
    { _id, status: "PENDING" },
    { status: "REJECTED", reviewedBy: req.user._id, reviewedAt: new Date(), reviewNote: reason },
    { new: true }
  );

  if (!application) {
    throw new AppError("Only PENDING applications can be rejected", 409);
  }

  // Tell the applicant why, so they can fix it and apply again.
  const delivery = await trySendTemplateEmail("applicationRejected", application.email, {
    contactName: application.contactName,
    institutionName: application.name,
    code: application.code,
    reason,
  });

  await audit(req, {
    action: "admin.application.reject",
    targetType: "InstitutionApplication",
    targetId: application._id,
    summary: `Rejected ${application.name} (${application.code})`,
    details: { reason, emailDelivery: delivery },
  });

  res.status(200).json({ success: true, application, emailDelivery: delivery });
});
