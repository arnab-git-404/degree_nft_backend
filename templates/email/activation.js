import { activationHours } from "./layout.js";

// New account (resend activation, staff invite): data { name, activationUrl }
export default ({ name, activationUrl }) => ({
  subject: "Activate your DegreeNFT account",
  title: "Activate your account.",
  paragraphs: [
    `Hello ${name || "there"}, your DegreeNFT account has been created. Confirm your email address to activate the account and sign in.`,
  ],
  button: { label: "Activate account", url: activationUrl },
  note: `This link expires in ${activationHours()} hours and works once. If you did not expect this email, you can ignore it.`,
});
