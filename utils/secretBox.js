import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import AppError from "./AppError.js";

// Secrets stored in the DB (e.g. the SMTP password) are encrypted with SETTINGS_ENCRYPTION_KEY,
// 32 bytes as 64 hex characters. The key lives only in .env, never in the database.
const getKey = () => {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY || "";
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw new AppError("SETTINGS_ENCRYPTION_KEY is missing or invalid (need 64 hex characters) on the server", 500);
  }
  return Buffer.from(hex, "hex");
};

// Output: iv.tag.ciphertext, each base64.
export const encryptSecret = (plain) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(".");
};

export const decryptSecret = (box) => {
  const [iv, tag, data] = String(box).split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};
