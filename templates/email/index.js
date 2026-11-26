import { renderHtml, renderText } from "./layout.js";
import activation from "./activation.js";
import applicationApproved from "./applicationApproved.js";
import applicationRejected from "./applicationRejected.js";
import studentInvite from "./studentInvite.js";
import walletRecovery from "./walletRecovery.js";
import platformAlert from "./platformAlert.js";

// To add an email: create a file next to these that returns content blocks (see layout.js), register it here.
const TEMPLATES = { activation, applicationApproved, applicationRejected, studentInvite, walletRecovery, platformAlert };

export const renderEmail = (name, data) => {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown email template: ${name}`);
  const content = template(data);
  return { subject: content.subject, html: renderHtml(content), text: renderText(content) };
};
