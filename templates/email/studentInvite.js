import { STUDENT_INVITE_DAYS } from "../../utils/activationToken.js";

// A college invites a student to link their wallet: data { name, collegeName, claimUrl }
export default ({ name, collegeName, claimUrl }) => ({
  subject: `${collegeName} invites you to claim your DegreeNFT credentials`,
  title: "Claim your credentials.",
  paragraphs: [
    `Hello ${name || "there"}, ${collegeName} has added you to DegreeNFT. Connect your Solana wallet and sign a short message to prove it is yours. Your credentials will be issued to that wallet.`,
  ],
  button: { label: "Connect my wallet", url: claimUrl },
  note: `This link expires in ${STUDENT_INVITE_DAYS} days and works once. If you did not expect this email, you can ignore it.`,
});
