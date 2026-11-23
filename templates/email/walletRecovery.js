import { STUDENT_INVITE_DAYS } from "../../utils/activationToken.js";

// The college started moving a student's credentials to a new wallet: data { name, collegeName, recoveryUrl }
export default ({ name, collegeName, recoveryUrl }) => ({
  subject: `${collegeName}: connect your new wallet to recover your DegreeNFT credentials`,
  title: "Recover your credentials.",
  paragraphs: [
    `Hello ${name || "there"}, ${collegeName} has started moving your DegreeNFT credentials to a new wallet, because the old one can no longer be used.`,
    "Open the link, connect your NEW Solana wallet and sign a short message to prove it is yours. Two college officials then approve the move.",
  ],
  button: { label: "Connect my new wallet", url: recoveryUrl },
  note: `This link expires in ${STUDENT_INVITE_DAYS} days and works once. If you did not ask your college for this, contact them before doing anything.`,
});
