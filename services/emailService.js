const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const buildActivationHtml = ({ name, activationUrl }) => {
  const safeName = escapeHtml(name || "there");
  const safeUrl = escapeHtml(activationUrl);

  return `
    <div style="background:#f3efe6;padding:32px 16px;font-family:Helvetica,Arial,sans-serif;color:#11100e">
      <div style="max-width:560px;margin:0 auto;background:#fffdf8;border:1px solid rgba(17,16,14,0.2);padding:32px">
        <p style="margin:0;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#6b665c">
          DegreeNFT / Academic registry
        </p>
        <h1 style="margin:18px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:38px;line-height:1.05;font-weight:400;letter-spacing:-0.03em">
          Activate your account.
        </h1>
        <p style="margin:20px 0 0;font-size:15px;line-height:1.7;color:#3d3a34">
          Hello ${safeName}, your DegreeNFT account has been created. Confirm your email
          address to activate the account and sign in.
        </p>
        <p style="margin:26px 0 0">
          <a href="${safeUrl}" style="display:inline-block;background:#2b2bea;color:#f3efe6;padding:13px 22px;text-decoration:none;font-size:11px;letter-spacing:0.16em;text-transform:uppercase">
            Activate account
          </a>
        </p>
        <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#6b665c">
          This link expires in ${Number(process.env.ACTIVATION_TOKEN_TTL_HOURS) || 24} hours.
          If the button does not work, copy this address into your browser:
        </p>
        <p style="margin:8px 0 0;font-size:11px;line-height:1.6;word-break:break-all;color:#2b2bea">
          ${safeUrl}
        </p>
        <p style="margin:28px 0 0;border-top:1px solid rgba(17,16,14,0.15);padding-top:16px;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#8a8478">
          If you did not create this account, you can ignore this message.
        </p>
      </div>
    </div>
  `;
};

export const sendActivationEmail = async ({ to, name, activationUrl }) => {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.log(`[DegreeNFT] Activation link for ${to}: ${activationUrl}`);
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
      subject: "Activate your DegreeNFT account",
      html: buildActivationHtml({ name, activationUrl }),
      text: `Hello ${name || "there"}, activate your DegreeNFT account: ${activationUrl}`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Activation email failed (${response.status}): ${detail}`);
  }

  return { delivered: true, provider: "resend" };
};
