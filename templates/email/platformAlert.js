// Something on the platform needs a person: data { subject, message, details, everyMinutes }
export default ({ subject, message, details, everyMinutes }) => ({
  subject: `DegreeNFT alert: ${subject}`,
  title: subject,
  paragraphs: [message],
  ...(details && { quote: { label: "Details", text: details } }),
  note: `Automatic alert to the DegreeNFT Super Admins. The same alert is sent at most once every ${Math.round(everyMinutes / 60) || 1} hour(s).`,
});
