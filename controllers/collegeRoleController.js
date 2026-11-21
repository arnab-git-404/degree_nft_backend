import Role from "../models/role.js";
import InstitutionMembership from "../models/institutionMembership.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { audit } from "../utils/audit.js";
import { COLLEGE_PERMISSION_GROUPS, COLLEGE_PERMISSION_KEY_SET } from "../utils/permissions.js";
import { collegeRoleFilter, isAdminRole } from "../services/staffService.js";

// College Admin › Roles: a college builds its own roles from college permissions (owner decision, 19 Nov 2026).
// Always for req.institution (requireInstitution); shared roles are read-only here.

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// College permissions only, and only ones the actor holds here, so nobody can hand out more than they have.
const collegePermissions = (req, permissions) => {
  if (!Array.isArray(permissions)) throw new AppError("permissions must be an array", 400);
  const keys = [...new Set(permissions.map((key) => String(key).trim()).filter(Boolean))];
  const refused = keys.filter((key) => !COLLEGE_PERMISSION_KEY_SET.has(key));
  if (refused.length) throw new AppError(`Not allowed in a college role: ${refused.join(", ")}`, 400);

  const own = req.membership.roleId.permissions || [];
  const notHeld = own.includes("*") ? [] : keys.filter((key) => !own.includes(key));
  if (notHeld.length) throw new AppError(`You can only give permissions you have: ${notHeld.join(", ")}`, 403);
  return keys;
};

const displayNameOf = (value) => {
  const name = String(value ?? "").trim();
  if (!name || name.length > 60) throw new AppError("Give the role a name (up to 60 characters)", 400);
  return name;
};

// A name must differ from every role this college can use (its own and the shared ones), ignoring case.
const assertNameFree = async (institutionId, displayName, exceptId) => {
  const clash = await Role.exists({
    ...collegeRoleFilter(institutionId),
    displayName: new RegExp(`^${escapeRegex(displayName)}$`, "i"),
    ...(exceptId && { _id: { $ne: exceptId } }),
  });
  if (clash) throw new AppError(`A role called "${displayName}" already exists for this college`, 409);
};

const memberCounts = async (institutionId, roleIds) => {
  const rows = await InstitutionMembership.aggregate([
    { $match: { institutionId, roleId: { $in: roleIds } } },
    { $group: { _id: "$roleId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
};

const serialize = (role, memberCount = 0) => ({
  _id: role._id,
  displayName: role.displayName,
  description: role.description || "",
  permissions: role.permissions || [],
  isActive: role.isActive,
  shared: !role.institutionId,
  isAdmin: isAdminRole(role),
  memberCount,
});

// The college's own role from the URL; another college's role is not found, a shared one cannot change.
const findOwnRole = async (req) => {
  if (!/^[a-f0-9]{24}$/i.test(String(req.params.roleId))) throw new AppError("Invalid roleId", 400);
  const role = await Role.findOne({ _id: req.params.roleId, ...collegeRoleFilter(req.institution._id) });
  if (!role) throw new AppError("Role not found", 404);
  if (!role.institutionId) throw new AppError("Shared roles cannot be changed by a college; copy it instead", 403);
  return role;
};

export const listCollegeRoles = asyncHandler(async (req, res) => {
  // Inactive roles stay in the list so they can be made active again.
  const roles = await Role.find(collegeRoleFilter(req.institution._id)).sort({ displayName: 1 }).lean();
  const counts = await memberCounts(req.institution._id, roles.map((role) => role._id));
  res.status(200).json({
    success: true,
    roles: roles.map((role) => serialize(role, counts.get(String(role._id)))),
    permissionGroups: COLLEGE_PERMISSION_GROUPS,
  });
});

export const createCollegeRole = asyncHandler(async (req, res) => {
  const displayName = displayNameOf(req.body?.displayName);
  const permissions = collegePermissions(req, req.body?.permissions ?? []);
  await assertNameFree(req.institution._id, displayName);

  const role = await Role.create({
    // Internal name can never equal a system role that code looks up by name ("staff", "student").
    name: `college-${req.institution._id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    displayName,
    description: String(req.body?.description ?? "").trim().slice(0, 240),
    permissions,
    scope: "INSTITUTION",
    institutionId: req.institution._id,
    isSystem: false,
    isActive: true,
  });

  await audit(req, {
    action: "institution.role.create",
    scope: "INSTITUTION",
    targetType: "Role",
    targetId: role._id,
    summary: `Created college role ${role.displayName}`,
    details: { permissions },
  });
  res.status(201).json({ success: true, role: serialize(role) });
});

export const updateCollegeRole = asyncHandler(async (req, res) => {
  const role = await findOwnRole(req);
  const before = { displayName: role.displayName, permissions: [...role.permissions], isActive: role.isActive };

  // Members of an inactive role lose access (they see the "access revoked" page), but never the person doing this.
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") throw new AppError("isActive must be true or false", 400);
    if (!req.body.isActive && role._id.equals(req.membership.roleId._id)) {
      throw new AppError("You hold this role; deactivating it would lock you out", 409);
    }
    role.isActive = req.body.isActive;
  }

  if (req.body?.displayName !== undefined) {
    role.displayName = displayNameOf(req.body.displayName);
    await assertNameFree(req.institution._id, role.displayName, role._id);
  }
  if (req.body?.description !== undefined) role.description = String(req.body.description).trim().slice(0, 240);
  // Takes effect for every member on their next request (requireInstitution reads the role each time).
  if (req.body?.permissions !== undefined) role.permissions = collegePermissions(req, req.body.permissions);

  await role.save();
  const count = (await memberCounts(req.institution._id, [role._id])).get(String(role._id)) || 0;

  await audit(req, {
    action: "institution.role.update",
    scope: "INSTITUTION",
    targetType: "Role",
    targetId: role._id,
    summary: `Updated college role ${role.displayName}`,
    details: { before, after: { displayName: role.displayName, permissions: role.permissions, isActive: role.isActive }, members: count },
  });
  res.status(200).json({ success: true, role: serialize(role, count) });
});

