import { audit } from "../utils/audit.js";
import mongoose from "mongoose";
import User, { USER_TYPES } from "../models/user.js";
import Role, { ROLE_SCOPES } from "../models/role.js";
import Institution from "../models/institution.js";
import { INSTITUTION_STATUSES } from "../models/institution.js";
import NFT from "../models/nft.js";
import Reports from "../models/reports.js";
import InstitutionApplication from "../models/institutionApplication.js";
import InstitutionMembership from "../models/institutionMembership.js";
import * as staffService from "../services/staffService.js";
import { listAuditLogs } from "../services/auditService.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  PERMISSION_GROUPS,
  PERMISSION_KEY_SET,
} from "../utils/permissions.js";

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const assertValidRoleId = (roleId) => {
  if (!mongoose.isValidObjectId(roleId)) {
    throw new AppError("Role not found", 404);
  }
};

const normalizePermissions = (permissions, { allowWildcard = false } = {}) => {
  if (!Array.isArray(permissions)) {
    throw new AppError("permissions must be an array", 400);
  }

  const normalized = [
    ...new Set(
      permissions
        .map((permission) => String(permission).trim())
        .filter(Boolean)
    ),
  ];

  const invalid = normalized.filter((permission) => {
    if (permission === "*") {
      return !allowWildcard;
    }

    return !PERMISSION_KEY_SET.has(permission);
  });

  if (invalid.length > 0) {
    throw new AppError(
      `Unknown or restricted permission: ${invalid.join(", ")}`,
      400
    );
  }

  return normalized.includes("*") ? ["*"] : normalized;
};

const serializeRole = (role, userCount = 0) => {
  const value = role.toObject ? role.toObject() : role;

  return {
    _id: value._id,
    name: value.name,
    displayName: value.displayName,
    description: value.description || "",
    permissions: value.permissions || [],
    scope: value.scope || "PLATFORM",
    // A college's own role: { _id, name, code } when populated, else the id; null = shared.
    institution: value.institutionId || null,
    isSystem: Boolean(value.isSystem),
    isActive: Boolean(value.isActive),
    userCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

// Holders of a role: accounts for PLATFORM roles, college memberships for INSTITUTION roles.
const getRoleUserCounts = async (roleIds) => {
  if (!roleIds.length) return new Map();

  const group = [{ $match: { roleId: { $in: roleIds } } }, { $group: { _id: "$roleId", count: { $sum: 1 } } }];
  const [users, members] = await Promise.all([User.aggregate(group), InstitutionMembership.aggregate(group)]);
  const counts = new Map();
  for (const entry of [...users, ...members]) {
    counts.set(String(entry._id), (counts.get(String(entry._id)) || 0) + entry.count);
  }
  return counts;
};

const countRoleHolders = (role) =>
  role.scope === "INSTITUTION"
    ? InstitutionMembership.countDocuments({ roleId: role._id })
    : User.countDocuments({ roleId: role._id });

const getPagination = (query) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(query.limit, 10) || 20)
  );

  return { page, limit, skip: (page - 1) * limit };
};

const paginationMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit) || 1,
});

export const getDashboardStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    activeUsers,
    totalInstitutions,
    pendingInstitutions,
    verifiedInstitutions,
    totalAllocations,
    totalMinted,
    totalReports,
    openReports,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    Institution.countDocuments(),
    Institution.countDocuments({ verificationStatus: "PENDING" }),
    Institution.countDocuments({ verificationStatus: "VERIFIED" }),
    NFT.countDocuments({ allocated: true }),
    NFT.countDocuments({ minted: true }),
    Reports.countDocuments(),
    Reports.countDocuments({ resolved: false }),
  ]);

  res.status(200).json({
    success: true,
    stats: {
      totalUsers,
      activeUsers,
      totalInstitutions,
      pendingInstitutions,
      verifiedInstitutions,
      totalAllocations,
      totalMinted,
      totalReports,
      openReports,
    },
  });
});

export const getRoles = asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const roles = await Role.find(includeInactive ? {} : { isActive: true })
    .populate("institutionId", "name code")
    .sort({ isSystem: -1, name: 1 })
    .lean();
  const counts = await getRoleUserCounts(roles.map((role) => role._id));

  res.status(200).json({
    success: true,
    roles: roles.map((role) =>
      serializeRole(role, counts.get(String(role._id)) || 0)
    ),
  });
});

export const getPermissionCatalog = asyncHandler(async (req, res) => {
  res.status(200).json({
    success: true,
    groups: PERMISSION_GROUPS,
    total: PERMISSION_KEY_SET.size,
  });
});

export const getRoleUsers = asyncHandler(async (req, res) => {
  assertValidRoleId(req.params.roleId);

  const role = await Role.findById(req.params.roleId);

  if (!role) {
    throw new AppError("Role not found", 404);
  }

  const { page, limit, skip } = getPagination(req.query);
  const search = String(req.query.search || "").trim();
  const filter = { roleId: role._id };

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: regex }, { email: regex }];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("name email isActive createdAt lastLoginAt")
      .populate("primaryWallet", "address")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    users,
    pagination: paginationMeta(page, limit, total),
  });
});

export const createRole = asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim().toLowerCase();
  const displayName = String(req.body.displayName || "").trim();
  const description = String(req.body.description || "").trim();
  const permissions = normalizePermissions(req.body.permissions || []);
  const isActive = req.body.isActive ?? true;
  // Fixed at creation: PLATFORM roles go on accounts, INSTITUTION roles on college memberships.
  const scope = req.body.scope ?? "PLATFORM";

  if (!ROLE_SCOPES.includes(scope)) {
    throw new AppError("scope must be PLATFORM or INSTITUTION", 400);
  }

  if (!ROLE_NAME_PATTERN.test(name)) {
    throw new AppError(
      "name must start with a letter and contain only lowercase letters, numbers, hyphens, or underscores",
      400
    );
  }

  if (!displayName) {
    throw new AppError("displayName is required", 400);
  }

  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be a boolean", 400);
  }

  const existingRole = await Role.findOne({ name });

  if (existingRole) {
    throw new AppError("A role with this name already exists", 409);
  }

  const role = await Role.create({
    name,
    displayName,
    description,
    permissions,
    isActive,
    scope,
    isSystem: false,
  });
  await audit(req, { action: "admin.role.create", targetType: "Role", targetId: role._id, summary: `Created role ${role.name}`, details: { permissions: role.permissions } });

  res.status(201).json({
    success: true,
    role: serializeRole(role),
  });
});

export const updateRole = asyncHandler(async (req, res) => {
  assertValidRoleId(req.params.roleId);

  const role = await Role.findById(req.params.roleId);

  if (!role) {
    throw new AppError("Role not found", 404);
  }

  const { displayName, description, permissions, isActive } = req.body;

  if (displayName !== undefined) {
    const nextDisplayName = String(displayName).trim();

    if (!nextDisplayName) {
      throw new AppError("displayName cannot be empty", 400);
    }

    role.displayName = nextDisplayName;
  }

  if (description !== undefined) {
    role.description = String(description).trim();
  }

  if (permissions !== undefined) {
    if (role.name === "admin") {
      const normalized = normalizePermissions(permissions, {
        allowWildcard: true,
      });

      if (!normalized.includes("*")) {
        throw new AppError(
          "The admin role must retain full access to every permission",
          400
        );
      }

      role.permissions = ["*"];
    } else {
      role.permissions = normalizePermissions(permissions);
    }
  }

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      throw new AppError("isActive must be a boolean", 400);
    }

    if (!isActive) {
      if (role.isSystem) {
        throw new AppError("System roles cannot be deactivated", 400);
      }

      // People holding an inactive role lose access (they see the "access revoked" page), but never the person doing this.
      if (req.user.roleId?._id?.equals(role._id)) {
        throw new AppError("You hold this role; deactivating it would lock you out", 409);
      }
    }

    role.isActive = isActive;
  }

  await role.save();
  await audit(req, { action: "admin.role.update", targetType: "Role", targetId: role._id, summary: `Updated role ${role.name}`, details: { changed: Object.keys(req.body || {}), permissions: role.permissions, isActive: role.isActive } });

  const userCount = await countRoleHolders(role);

  res.status(200).json({
    success: true,
    role: serializeRole(role, userCount),
  });
});

export const getUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, role } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: regex }, { email: regex }];
  }

  if (role) {
    const roleDocument = await Role.findOne({ name: role });

    if (!roleDocument) {
      throw new AppError("Role not found", 404);
    }

    filter.roleId = roleDocument._id;
  }

  // Accounts stay global; ?institutionId= narrows the list to people with a membership in that college.
  if (req.query.institutionId) {
    if (!/^[a-f0-9]{24}$/i.test(String(req.query.institutionId))) {
      throw new AppError("Invalid institutionId", 400);
    }
    filter._id = { $in: await InstitutionMembership.distinct("userId", { institutionId: String(req.query.institutionId) }) };
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .populate("roleId")
      .populate("primaryWallet")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  // Each user's colleges (any status), so the global list shows who belongs where.
  const memberships = await InstitutionMembership.find({ userId: { $in: users.map((user) => user._id) } })
    .populate("institutionId", "name code")
    .populate("roleId", "displayName")
    .select("userId institutionId roleId status")
    .lean();

  res.status(200).json({
    success: true,
    users: users.map((user) => ({
      ...user.toJSON(),
      memberships: memberships
        .filter((membership) => String(membership.userId) === String(user._id) && membership.institutionId)
        .map(({ _id, institutionId, roleId, status }) => ({ _id, institution: institutionId, role: roleId, status })),
    })),
    pagination: paginationMeta(page, limit, total),
  });
});

export const updateUserRole = asyncHandler(async (req, res) => {
  const { role } = req.body;

  if (!role) {
    throw new AppError("role is required", 400);
  }

  const roleDocument = await Role.findOne({ name: role, isActive: true });

  if (!roleDocument) {
    throw new AppError("Role not found", 404);
  }

  // A college role on the global account would grant its rights at every college.
  if (roleDocument.scope === "INSTITUTION") {
    throw new AppError("College roles are assigned through a college membership, not to the account", 400);
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const isSelf = user._id.equals(req.user._id);

  if (isSelf && role !== "admin") {
    throw new AppError("You cannot remove your own admin role", 400);
  }

  if (role !== "admin") {
    const currentRole = await Role.findById(user.roleId);

    if (currentRole?.name === "admin") {
      const adminRole = await Role.findOne({ name: "admin" });
      const adminCount = adminRole
        ? await User.countDocuments({ roleId: adminRole._id })
        : 0;

      if (adminCount <= 1) {
        throw new AppError("At least one admin account is required", 400);
      }
    }
  }

  const previousRoleId = String(user.roleId);
  user.roleId = roleDocument._id;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);
  await audit(req, { action: "admin.user.role", targetType: "User", targetId: user._id, summary: `Changed role of ${user.name} to ${roleDocument.name}`, details: { previousRoleId, role: roleDocument.name } });

  res.status(200).json({ success: true, user: user.toJSON() });
});

// Admin sets the userType label explicitly; it is never derived from roles and grants nothing.
export const updateUserAccount = asyncHandler(async (req, res) => {
  const { userType } = req.body;

  if (!USER_TYPES.includes(userType)) {
    throw new AppError(`userType must be one of ${USER_TYPES.join(", ")}`, 400);
  }

  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
    throw new AppError("Invalid user id", 400);
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const previousUserType = user.userType;
  user.userType = userType;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);
  await audit(req, { action: "admin.user.userType", targetType: "User", targetId: user._id, summary: `Changed user type of ${user.name} to ${userType}`, details: { from: previousUserType, to: userType } });

  res.status(200).json({ success: true, user: user.toJSON() });
});

export const updateUserStatus = asyncHandler(async (req, res) => {
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    throw new AppError("isActive must be a boolean", 400);
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    throw new AppError("User not found", 404);
  }

  if (user._id.equals(req.user._id) && !isActive) {
    throw new AppError("You cannot deactivate your own account", 400);
  }

  user.isActive = isActive;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);
  await audit(req, { action: "admin.user.status", targetType: "User", targetId: user._id, summary: `${isActive ? "Activated" : "Deactivated"} ${user.name}`, details: { isActive } });

  res.status(200).json({ success: true, user: user.toJSON() });
});

export const getInstitutions = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, status } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: regex },
      { code: regex },
      { walletAddress: regex },
    ];
  }

  if (status) {
    if (!["PENDING", "VERIFIED", "REJECTED"].includes(status)) {
      throw new AppError("Invalid verification status", 400);
    }

    filter.verificationStatus = status;
  }

  const [institutions, total] = await Promise.all([
    Institution.find(filter)
      .populate("userId", "name email isActive")
      .populate("walletId", "address isVerified")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Institution.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    institutions,
    pagination: paginationMeta(page, limit, total),
  });
});

export const updateInstitutionStatus = asyncHandler(async (req, res) => {
  const { verificationStatus, status } = req.body;

  if (!["PENDING", "VERIFIED", "REJECTED"].includes(verificationStatus)) {
    throw new AppError(
      "verificationStatus must be PENDING, VERIFIED or REJECTED",
      400
    );
  }

  const update = { verificationStatus };

  if (status !== undefined) {
    if (!INSTITUTION_STATUSES.includes(status)) {
      throw new AppError(`status must be one of ${INSTITUTION_STATUSES.join(", ")}`, 400);
    }
    update.status = status;
  }

  const institution = await Institution.findByIdAndUpdate(
    req.params.institutionId,
    update,
    { new: true, runValidators: true }
  )
    .populate("userId", "name email isActive")
    .populate("walletId", "address isVerified");

  if (!institution) {
    throw new AppError("Institution not found", 404);
  }

  await audit(req, { action: "admin.institution.status", institutionId: institution._id, targetType: "Institution", targetId: institution._id, summary: `Set ${institution.name} to ${update.verificationStatus}${update.status ? ` / ${update.status}` : ""}`, details: update });

  res.status(200).json({ success: true, institution });
});

export const getNftAllocations = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { search, minted } = req.query;
  const filter = {};

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { name: regex },
      { ipfsHash: regex },
      { studentWallet: regex },
      { institutionWallet: regex },
      { nftAddress: regex },
    ];
  }

  if (minted === "true" || minted === "false") {
    filter.minted = minted === "true";
  }

  const [allocations, total] = await Promise.all([
    NFT.find(filter)
      .populate("institutionId", "name code")
      .populate("studentId", "name email")
      .sort({ allocatedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    NFT.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    allocations,
    pagination: paginationMeta(page, limit, total),
  });
});

// Activity log. `type` is a scope (PLATFORM / INSTITUTION / ACCOUNT) or FAILURE for rejected attempts;
// `method` is POST / PUT / PATCH / DELETE. `stats` always covers the whole log, not the current filter.
export const getAuditLogs = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, ...(await listAuditLogs(req)) });
});

export const getApplications = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { status, search } = req.query;
  const filter = {};

  if (["PENDING", "APPROVED", "REJECTED"].includes(status)) {
    filter.status = status;
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [{ name: regex }, { code: regex }, { email: regex }, { contactName: regex }];
  }

  const [applications, total] = await Promise.all([
    InstitutionApplication.find(filter)
      .populate("linkId", "label")
      .populate("reviewedBy", "name")
      .populate("institutionId", "name code status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    InstitutionApplication.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    applications,
    pagination: paginationMeta(page, limit, total),
  });
});

export const getReports = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { resolved, search } = req.query;
  const filter = {};

  if (resolved === "true" || resolved === "false") {
    filter.resolved = resolved === "true";
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { nftIpfsHash: regex },
      { reportType: regex },
      { reportDetails: regex },
      { studentWallet: regex },
      { institutionWallet: regex },
    ];
  }

  const [reports, total] = await Promise.all([
    Reports.find(filter)
      .populate("institutionId", "name code")
      .populate("studentId", "name email")
      .sort({ reportedOn: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Reports.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    reports,
    pagination: paginationMeta(page, limit, total),
  });
});

export const resolveReport = asyncHandler(async (req, res) => {
  const { solutionDetails } = req.body;

  if (!solutionDetails || !String(solutionDetails).trim()) {
    throw new AppError("solutionDetails is required", 400);
  }

  const report = await Reports.findById(req.params.reportId);

  if (!report) {
    throw new AppError("Report not found", 404);
  }

  report.resolved = true;
  report.solutionDetails = String(solutionDetails).trim();
  report.resolvedDate = new Date();
  await report.save();
  await audit(req, { action: "admin.report.resolve", institutionId: report.institutionId, targetType: "Report", targetId: report._id, summary: `Resolved report: ${report.reportType}` });
  await report.populate([
    { path: "institutionId", select: "name code" },
    { path: "studentId", select: "name email" },
  ]);

  res.status(200).json({ success: true, report });
});

// P04-04: Super Admin manages any college's members, including admin roles and the primary head.
const loadInstitution = async (institutionId) => {
  if (!/^[a-f0-9]{24}$/i.test(String(institutionId || ""))) {
    throw new AppError("Invalid institutionId", 400);
  }
  const institution = await Institution.findById(institutionId);
  if (!institution) throw new AppError("Institution not found", 404);
  return institution;
};

export const getInstitutionMembers = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  res.status(200).json({ success: true, ...(await staffService.listMembers(institution, { asSuperAdmin: true })) });
});

export const inviteInstitutionMember = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  res.status(201).json({ success: true, ...(await staffService.inviteMember(req, institution, req.body, { asSuperAdmin: true })) });
});

export const updateInstitutionMember = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  const membership = await staffService.updateMember(req, institution, req.params.membershipId, req.body, { asSuperAdmin: true });
  res.status(200).json({ success: true, membership });
});

export const transferInstitutionHead = asyncHandler(async (req, res) => {
  const institution = await loadInstitution(req.params.institutionId);
  res.status(200).json({ success: true, institution: await staffService.transferHead(req, institution, req.body) });
});
