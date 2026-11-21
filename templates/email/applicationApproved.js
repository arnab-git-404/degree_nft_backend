import { activationHours } from "./layout.js";

// Super Admin approved an application: data { contactName, institutionName, code, activationUrl }
export default ({ contactName, institutionName, code, activationUrl }) => ({
  subject: `${institutionName} is approved on DegreeNFT`,
  title: "Your institution is approved.",
  paragraphs: [
    `Hello ${contactName || "there"}, the application for ${institutionName} has been approved. You are its head (Institution Admin).`,
    "Activate your account to start: then sign in with the wallet you gave in the application, invite your staff and issue credentials.",
  ],
  details: [
    ["Institution", institutionName],
    ["Code", code],
    ["Your role", "Institution Admin (head)"],
  ],
  button: { label: "Activate account", url: activationUrl },
  note: `This link expires in ${activationHours()} hours and works once. If it expires, ask the DegreeNFT team for a new one.`,
});
