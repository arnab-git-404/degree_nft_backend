// Shared look for every email. Every value is escaped, so applicant- or admin-typed text
// (names, rejection reasons) can never inject HTML.

export const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const activationHours = () => Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 24;

const paragraph = (text) =>
  `<p style="margin:16px 0 0;font-size:15px;line-height:1.7;color:#3d3a34">${escapeHtml(text)}</p>`;

/**
 * Content blocks a template returns (all optional except subject and title):
 *   subject, title, paragraphs[], details [[label, value]], quote { label, text },
 *   paragraphs2[] (after the details/quote), button { label, url }, note
 */
export const renderHtml = (content) => {
  const details = content.details?.length
    ? `<table role="presentation" style="margin:22px 0 0;width:100%;border-collapse:collapse;font-size:14px">${content.details
        .map(
          ([label, value]) =>
            `<tr><td style="padding:8px 0;border-top:1px solid rgba(17,16,14,0.1);color:#6b665c;width:38%">${escapeHtml(label)}</td><td style="padding:8px 0;border-top:1px solid rgba(17,16,14,0.1);color:#11100e;font-weight:600">${escapeHtml(value)}</td></tr>`
        )
        .join("")}</table>`
    : "";

  const quote = content.quote
    ? `<div style="margin:20px 0 0;border-left:3px solid #c0392b;background:#fbf1ef;padding:12px 16px">
         <p style="margin:0;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#8a8478">${escapeHtml(content.quote.label)}</p>
         <p style="margin:6px 0 0;font-size:15px;line-height:1.6;color:#11100e;white-space:pre-wrap">${escapeHtml(content.quote.text)}</p>
       </div>`
    : "";

  const button = content.button
    ? `<p style="margin:26px 0 0">
         <a href="${escapeHtml(content.button.url)}" style="display:inline-block;background:#2b2bea;color:#f3efe6;padding:13px 22px;text-decoration:none;font-size:11px;letter-spacing:0.16em;text-transform:uppercase">${escapeHtml(content.button.label)}</a>
       </p>
       <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#6b665c">If the button does not work, copy this address into your browser:</p>
       <p style="margin:6px 0 0;font-size:11px;line-height:1.6;word-break:break-all;color:#2b2bea">${escapeHtml(content.button.url)}</p>`
    : "";

  return `
    <div style="background:#f3efe6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#11100e">
      <div style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid rgba(17,16,14,0.2);padding:32px">
        <p style="margin:0;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#6b665c">DegreeNFT / Academic registry</p>
        <h1 style="margin:18px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.1;font-weight:400;letter-spacing:-0.02em">${escapeHtml(content.title)}</h1>
        ${(content.paragraphs || []).map(paragraph).join("")}
        ${details}
        ${quote}
        ${(content.paragraphs2 || []).map(paragraph).join("")}
        ${button}
        <p style="margin:28px 0 0;border-top:1px solid rgba(17,16,14,0.15);padding-top:16px;font-size:11px;line-height:1.6;color:#8a8478">${escapeHtml(content.note || "")}</p>
      </div>
    </div>`;
};

// Plain-text version for clients that do not show HTML.
export const renderText = (content) =>
  [
    content.title,
    ...(content.paragraphs || []),
    ...(content.details || []).map(([label, value]) => `${label}: ${value}`),
    content.quote && `${content.quote.label}: ${content.quote.text}`,
    ...(content.paragraphs2 || []),
    content.button && `${content.button.label}: ${content.button.url}`,
    content.note,
  ]
    .filter(Boolean)
    .join("\n\n");
