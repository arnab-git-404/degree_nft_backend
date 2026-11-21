import nodemailer from "nodemailer";
import PlatformSetting from "../models/platformSetting.js";
import { decryptSecret } from "../utils/secretBox.js";
import { renderEmail } from "../templates/email/index.js";

// SMTP from Admin → Settings, with its decrypted password. Null when SMTP is not usable.
export const loadSmtpSettings = async () => {
  const settings = await PlatformSetting.findOne({ key: "platform" }).select("+smtp.passwordEncrypted");
  return settings?.smtp?.host ? settings.smtp : null;
};

export const createSmtpTransport = (smtp) =>
  nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.username ? { user: smtp.username, pass: smtp.passwordEncrypted ? decryptSecret(smtp.passwordEncrypted) : "" } : undefined,
    // Fail fast instead of hanging a request on an unreachable server.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

export const smtpFrom = (smtp) => ({ name: smtp.fromName || "DegreeNFT", address: smtp.fromEmail });

/**
 * Send one email. Order: platform SMTP (if enabled in Admin → Settings) → Resend (RESEND_API_KEY in .env)
 * → print to the server log. Returns { delivered, provider }; throws when the chosen provider fails.
 */
export const sendMail = async ({ to, subject, html, text }) => {
  const smtp = await loadSmtpSettings();

  if (smtp?.enabled) {
    await createSmtpTransport(smtp).sendMail({ from: smtpFrom(smtp), to, subject, html, text });
    return { delivered: true, provider: "smtp" };
  }

  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(`[DegreeNFT] Email to ${to} (${subject}):\n${text}`);
    return { delivered: false, provider: "console" };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "DegreeNFT <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Email failed (${response.status}): ${detail}`);
  }

  return { delivered: true, provider: "resend" };
};

// Render a named template from templates/email with this email's data, then send it.
export const sendTemplateEmail = (name, to, data) => sendMail({ to, ...renderEmail(name, data) });

export const sendActivationEmail = ({ to, name, activationUrl }) =>
  sendTemplateEmail("activation", to, { name, activationUrl });

// For flows that must not fail because of email: returns the delivery label the UI shows
// ("sent", "console" = printed to the server log, or "failed").
export const trySendTemplateEmail = async (name, to, data) => {
  try {
    const result = await sendTemplateEmail(name, to, data);
    return result.delivered ? "sent" : result.provider;
  } catch (error) {
    console.error(`Email "${name}" to ${to} failed:`, error.message);
    return "failed";
  }
};
