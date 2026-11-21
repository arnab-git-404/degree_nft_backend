// Super Admin rejected an application: data { contactName, institutionName, code, reason }
export default ({ contactName, institutionName, code, reason }) => ({
  subject: `Your DegreeNFT application for ${institutionName}`,
  title: "Your application was not approved.",
  paragraphs: [
    `Hello ${contactName || "there"}, we reviewed the application for ${institutionName} (${code}) and could not approve it at this time.`,
  ],
  quote: { label: "Reason", text: reason },
  paragraphs2: ["If you can fix the issue, ask the DegreeNFT team for a new registration link and apply again."],
  note: "This is an automated message about your institution application.",
});
