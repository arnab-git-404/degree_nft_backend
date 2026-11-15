import PlatformSetting from "../models/platformSetting.js";
import { createSmtpTransport, loadSmtpSettings, smtpFrom } from "../services/emailService.js";
import { encryptSecret } from "../utils/secretBox.js";
import { audit } from "../utils/audit.js";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

const SMTP_PORTS = [25, 465, 587, 2525];
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

const loadSettings = async () =>
  (await PlatformSetting.findOne({ key: "platform" }).select("+smtp.passwordEncrypted")) ||
  new PlatformSetting({ key: "platform" });

// The password never leaves the server: the page only learns whether one is saved.
const publicSmtp = (settings) => {
  const { passwordEncrypted, ...smtp } = settings.smtp.toObject ? settings.smtp.toObject() : settings.smtp;
  return { ...smtp, hasPassword: Boolean(passwordEncrypted) };
};

const encryptionReady = () => /^[a-f0-9]{64}$/i.test(process.env.SETTINGS_ENCRYPTION_KEY || "");

export const getSmtpSettings = asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  res.status(200).json({ success: true, smtp: publicSmtp(settings), encryptionReady: encryptionReady() });
});

export const updateSmtpSettings = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const text = (key, max = 200) => {
    const value = String(body[key] ?? "").trim();
    if (value.length > max) throw new AppError(`${key} must be ${max} characters or fewer`, 400);
    return value;
  };

  const smtp = {
    enabled: body.enabled === true,
    host: text("host", 253).toLowerCase(),
    port: Number(body.port),
    secure: body.secure === true,
    username: text("username"),
    fromName: text("fromName", 100),
    fromEmail: text("fromEmail").toLowerCase(),
  };

  if (smtp.host && !HOST_PATTERN.test(smtp.host)) throw new AppError("host must be a server name like smtp.gmail.com", 400);
  if (!SMTP_PORTS.includes(smtp.port)) throw new AppError(`port must be one of ${SMTP_PORTS.join(", ")}`, 400);
  if (smtp.fromEmail && !EMAIL_PATTERN.test(smtp.fromEmail)) throw new AppError("fromEmail must be a valid email address", 400);
  if (smtp.enabled && (!smtp.host || !smtp.fromEmail)) {
    throw new AppError("host and fromEmail are required to turn SMTP on", 400);
  }

  const settings = await loadSettings();
  const password = typeof body.password === "string" ? body.password : "";

  // Empty password = keep the saved one; clearPassword removes it.
  let passwordEncrypted = settings.smtp.passwordEncrypted || "";
  if (password) {
    if (password.length > 500) throw new AppError("password is too long", 400);
    passwordEncrypted = encryptSecret(password);
  } else if (body.clearPassword === true) {
    passwordEncrypted = "";
  }

  // Any change makes the last test result stale.
  settings.smtp = { ...smtp, passwordEncrypted, lastTestAt: null, lastTestOk: null, lastTestError: "" };
  settings.updatedBy = req.user._id;
  await settings.save();

  await audit(req, {
    action: "admin.settings.smtp.update",
    targetType: "PlatformSetting",
    targetId: settings._id,
    summary: `${smtp.enabled ? "Enabled" : "Saved (disabled)"} SMTP ${smtp.host || "(no host)"}:${smtp.port}`,
    details: { ...smtp, passwordChanged: Boolean(password) || body.clearPassword === true },
  });

  res.status(200).json({ success: true, smtp: publicSmtp(settings), encryptionReady: encryptionReady() });
});

// Sends a real email with the saved settings (even when SMTP is still off), and records the result.
export const testSmtpSettings = asyncHandler(async (req, res) => {
  const to = String(req.body?.to || "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(to)) throw new AppError("Provide a valid email address to send the test to", 400);

  const smtp = await loadSmtpSettings();
  if (!smtp) throw new AppError("Save the SMTP settings first", 400);
  if (!smtp.fromEmail) throw new AppError("Set a From email first", 400);

  let error = "";
  try {
    await createSmtpTransport(smtp).sendMail({
      from: smtpFrom(smtp),
      to,
      subject: "DegreeNFT SMTP test",
      text: "This is a test email from DegreeNFT. Your SMTP settings work.",
      html: "<p>This is a test email from <strong>DegreeNFT</strong>. Your SMTP settings work.</p>",
    });
  } catch (sendError) {
    error = String(sendError.message || sendError).slice(0, 500);
  }

  await PlatformSetting.updateOne(
    { key: "platform" },
    { "smtp.lastTestAt": new Date(), "smtp.lastTestOk": !error, "smtp.lastTestError": error }
  );

  await audit(req, {
    action: "admin.settings.smtp.test",
    outcome: error ? "FAILURE" : "SUCCESS",
    targetType: "PlatformSetting",
    summary: `SMTP test to ${to} ${error ? "failed" : "succeeded"}`,
    details: { to, host: smtp.host, port: smtp.port, ...(error && { error }) },
  });

  if (error) throw new AppError(`SMTP test failed: ${error}`, 502);
  res.status(200).json({ success: true, message: `Test email sent to ${to}` });
});
