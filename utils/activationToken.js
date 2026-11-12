import { createHash, randomBytes } from "node:crypto";

export const createActivationToken = () => {
  const token = randomBytes(32).toString("hex");

  return {
    token,
    hash: hashActivationToken(token),
    expiresAt: new Date(
      Date.now() +
        (Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 24) * 60 * 60 * 1000
    ),
  };
};

export const hashActivationToken = (token) =>
  createHash("sha256").update(String(token)).digest("hex");

export const buildActivationUrl = (token) => {
  const base = (process.env.FRONTEND_URL || "http://localhost:5173").replace(
    /\/+$/,
    ""
  );

  return `${base}/activate/${token}`;
};
