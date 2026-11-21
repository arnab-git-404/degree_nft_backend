import User from "../models/user.js";
import InstitutionMembership from "../models/institutionMembership.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";
import { verifyToken } from "../utils/jwt.js";

export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    throw new AppError("Authentication required", 401);
  }

  let payload;
  try {
    payload = verifyToken(header.slice(7));
  } catch {
    throw new AppError("Invalid or expired token", 401);
  }

  const user = await User.findById(payload.sub).populate("roleId");

  if (!user || !user.isActive) {
    throw new AppError("User not found or inactive", 401);
  }

  if (!user.roleId || !user.roleId.isActive) {
    throw new AppError("Your access has been revoked: your role is inactive", 403, "ACCESS_REVOKED");
  }

  req.user = user;
  next();
});

// Access is decided by the role's permissions, never by the role's name.
export const hasPermission = (user, permission) => {
  const permissions = user?.roleId?.permissions || [];
  return permissions.includes("*") || permissions.includes(permission);
};

export const requirePermission = (permission) => (req, res, next) =>
  hasPermission(req.user, permission)
    ? next()
    : next(new AppError("Forbidden", 403));

/**
 * Trusted tenant context. The client only *selects* a college with the X-Institution-Id header;
 * access is granted by the user's ACTIVE membership there, the college being ACTIVE, and the
 * membership role (never the account role) holding `permission`. Sets req.institution / req.membership.
 */
export const requireInstitution = (permission) =>
  asyncHandler(async (req, res, next) => {
    const institutionId = req.get("X-Institution-Id");

    // Strict 24-hex check: mongoose.isValidObjectId also accepts any 12-character string.
    if (!/^[a-f0-9]{24}$/i.test(institutionId || "")) {
      throw new AppError("Select an institution (X-Institution-Id header)", 400, "INSTITUTION_REQUIRED");
    }

    const membership = await InstitutionMembership.findOne({
      userId: req.user._id,
      institutionId,
      status: "ACTIVE",
    }).populate(["roleId", "institutionId"]);

    if (!membership) {
      throw new AppError("You are not an active member of this institution", 403);
    }

    const role = membership.roleId;
    const institution = membership.institutionId;

    if (!role?.isActive || role.scope !== "INSTITUTION") {
      throw new AppError("Your access has been revoked: your role at this institution is inactive", 403, "ACCESS_REVOKED");
    }

    if (!institution || institution.status !== "ACTIVE") {
      throw new AppError("This institution is suspended", 403);
    }

    const permissions = role.permissions || [];
    if (permission && !permissions.includes("*") && !permissions.includes(permission)) {
      throw new AppError("Forbidden", 403);
    }

    req.membership = membership;
    req.institution = institution;
    next();
  });
