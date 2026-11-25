import mongoose from "mongoose";
import User from "../models/user.js";
import Role from "../models/role.js";
import { trySendTemplateEmail } from "./emailService.js";

// When each kind of alert was last emailed. Kept in MongoDB so the "once every N minutes" rule holds across
// Vercel instances: a burst of 100 failures sends one email, not 100.
const AlertSent = mongoose.model(
  "AlertSent",
  new mongoose.Schema({ key: { type: String, required: true, unique: true }, lastSentAt: { type: Date, required: true } }),
);

// Super Admin accounts with an email, plus ADMIN_EMAIL from the server settings.
const recipients = async () => {
  const roles = await Role.find({ scope: "PLATFORM", permissions: { $in: ["platform:manage", "*"] } }).select("_id").lean();
  const users = await User.find({ roleId: { $in: roles.map((role) => role._id) }, email: { $exists: true, $ne: "" }, isActive: { $ne: false } })
    .select("email")
    .lean();
  return [...new Set([...users.map((user) => user.email), process.env.ADMIN_EMAIL].filter(Boolean).map((email) => email.toLowerCase()))];
};

/**
 * Emails the Super Admins about something that needs a person (low fee wallet, a failed on-chain step).
 * Each `key` is sent at most once every `everyMinutes`. Never throws: an alert must not break the request that raised it.
 * Returns "sent", "throttled", "no-recipient" or "failed".
 */
export const alertAdmins = async ({ key, subject, message, details = "", everyMinutes = 360 }) => {
  try {
    const now = new Date();
    let claimed = await AlertSent.findOneAndUpdate({ key, lastSentAt: { $lt: new Date(now - everyMinutes * 60_000) } }, { lastSentAt: now });
    if (!claimed) {
      try {
        claimed = await AlertSent.create({ key, lastSentAt: now });
      } catch (error) {
        if (error.code !== 11000) throw error; // sent recently (or another request is sending it right now)
      }
    }
    if (!claimed) return "throttled";
    const to = await recipients();
    if (!to.length) return "no-recipient";
    await Promise.all(to.map((email) => trySendTemplateEmail("platformAlert", email, { subject, message, details, everyMinutes })));
    return "sent";
  } catch (error) {
    console.error(`Alert "${key}" could not be sent:`, error.message);
    return "failed";
  }
};
