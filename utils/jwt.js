import jwt from "jsonwebtoken";

const getSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required");
  }

  return process.env.JWT_SECRET;
};

export const signToken = (user) =>
  jwt.sign(
    {
      sub: user._id.toString(),
      role: user.roleId?.name,
    },
    getSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );

export const verifyToken = (token) => jwt.verify(token, getSecret());
