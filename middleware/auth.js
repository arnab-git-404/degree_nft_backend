import User from "../models/user.js";
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

  req.user = user;
  next();
});

export const authorize = (...roleNames) => (req, res, next) => {
  const roleName = req.user?.roleId?.name;

  if (!roleName || !roleNames.includes(roleName)) {
    return next(new AppError("Forbidden", 403));
  }

  next();
};

export const requirePermission = (permission) => (req, res, next) => {
  const permissions = req.user?.roleId?.permissions || [];

  if (permissions.includes("*") || permissions.includes(permission)) {
    return next();
  }

  next(new AppError("Forbidden", 403));
};
