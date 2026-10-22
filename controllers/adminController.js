import mongoose from "mongoose";
import User from "../models/user.js";
import Role from "../models/role.js";
import University from "../models/university.js";
import NFT from "../models/nft.js";
import Reports from "../models/reports.js";
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
    isSystem: Boolean(value.isSystem),
    isActive: Boolean(value.isActive),
    userCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};

const getRoleUserCounts = async (roleIds) => {
  if (!roleIds.length) return new Map();

  const counts = await User.aggregate([
    { $match: { roleId: { $in: roleIds } } },
    { $group: { _id: "$roleId", count: { $sum: 1 } } },
  ]);

  return new Map(counts.map((entry) => [String(entry._id), entry.count]));
};

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
    totalUniversities,
    pendingUniversities,
    verifiedUniversities,
    totalAllocations,
    totalMinted,
    totalReports,
    openReports,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ isActive: true }),
    University.countDocuments(),
    University.countDocuments({ verificationStatus: "PENDING" }),
    University.countDocuments({ verificationStatus: "VERIFIED" }),
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
      totalUniversities,
      pendingUniversities,
      verifiedUniversities,
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
    isSystem: false,
  });

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

      const assignedUsers = await User.countDocuments({ roleId: role._id });

      if (assignedUsers > 0) {
        throw new AppError(
          `Reassign ${assignedUsers} user${
            assignedUsers === 1 ? "" : "s"
          } before deactivating this role`,
          400
        );
      }
    }

    role.isActive = isActive;
  }

  await role.save();

  const userCount = await User.countDocuments({ roleId: role._id });

  res.status(200).json({
    success: true,
    role: serializeRole(role, userCount),
  });
});

export const deleteRole = asyncHandler(async (req, res) => {
  assertValidRoleId(req.params.roleId);

  const role = await Role.findById(req.params.roleId);

  if (!role) {
    throw new AppError("Role not found", 404);
  }

  if (role.isSystem) {
    throw new AppError("System roles cannot be deleted", 400);
  }

  const assignedUsers = await User.countDocuments({ roleId: role._id });

  if (assignedUsers > 0) {
    throw new AppError(
      `Reassign ${assignedUsers} user${
        assignedUsers === 1 ? "" : "s"
      } before deleting this role`,
      400
    );
  }

  await role.deleteOne();

  res.status(200).json({
    success: true,
    message: "Role deleted",
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

  const [users, total] = await Promise.all([
    User.find(filter)
      .populate("roleId")
      .populate("primaryWallet")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    users: users.map((user) => user.toJSON()),
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

  user.roleId = roleDocument._id;
  await user.save();
  await user.populate(["roleId", "primaryWallet"]);

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

  res.status(200).json({ success: true, user: user.toJSON() });
});

export const getUniversities = asyncHandler(async (req, res) => {
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

  const [universities, total] = await Promise.all([
    University.find(filter)
      .populate("userId", "name email isActive")
      .populate("walletId", "address isVerified")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    University.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    universities,
    pagination: paginationMeta(page, limit, total),
  });
});

export const updateUniversityStatus = asyncHandler(async (req, res) => {
  const { verificationStatus, isActive } = req.body;

  if (!["PENDING", "VERIFIED", "REJECTED"].includes(verificationStatus)) {
    throw new AppError(
      "verificationStatus must be PENDING, VERIFIED or REJECTED",
      400
    );
  }

  const update = { verificationStatus };

  if (typeof isActive === "boolean") {
    update.isActive = isActive;
  }

  const university = await University.findByIdAndUpdate(
    req.params.universityId,
    update,
    { new: true, runValidators: true }
  )
    .populate("userId", "name email isActive")
    .populate("walletId", "address isVerified");

  if (!university) {
    throw new AppError("University not found", 404);
  }

  res.status(200).json({ success: true, university });
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
      { universityWallet: regex },
      { nftAddress: regex },
    ];
  }

  if (minted === "true" || minted === "false") {
    filter.minted = minted === "true";
  }

  const [allocations, total] = await Promise.all([
    NFT.find(filter)
      .populate("universityId", "name code")
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
      { universityWallet: regex },
    ];
  }

  const [reports, total] = await Promise.all([
    Reports.find(filter)
      .populate("universityId", "name code")
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
  await report.populate([
    { path: "universityId", select: "name code" },
    { path: "studentId", select: "name email" },
  ]);

  res.status(200).json({ success: true, report });
});
