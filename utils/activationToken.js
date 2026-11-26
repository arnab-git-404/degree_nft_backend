import { createHash, randomBytes } from "node:crypto";

// A college's invite to a student to claim their profile with a wallet stays valid this long.
export const STUDENT_INVITE_DAYS = 7;

export const createActivationToken = (
  ttlHours = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 24
) => {
  const token = randomBytes(32).toString("hex");

  return {
    token,
    hash: hashActivationToken(token),
    expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
  };
};

export const hashActivationToken = (token) =>
  createHash("sha256").update(String(token)).digest("hex");

const frontendBase = () =>
  (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

export const buildActivationUrl = (token) => `${frontendBase()}/activate/${token}`;

export const buildClaimUrl = (token) => `${frontendBase()}/claim/${token}`;

export const buildRecoveryUrl = (token) => `${frontendBase()}/recover/${token}`;
