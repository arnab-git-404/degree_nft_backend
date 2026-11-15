import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEmail } from "../templates/email/index.js";

test("approval email carries the college, code and activation link", () => {
  const email = renderEmail("applicationApproved", {
    contactName: "Ganesh",
    institutionName: "Bengal College",
    code: "BCET",
    activationUrl: "https://app.example/activate/abc123",
  });
  assert.match(email.subject, /Bengal College is approved/);
  for (const part of [email.html, email.text]) {
    assert.ok(part.includes("Bengal College"));
    assert.ok(part.includes("BCET"));
    assert.ok(part.includes("https://app.example/activate/abc123"));
  }
});

test("rejection email shows the reason, escaped so it cannot inject HTML", () => {
  const email = renderEmail("applicationRejected", {
    contactName: "Ganesh",
    institutionName: "Bengal <b>College</b>",
    code: "BCET",
    reason: 'Accreditation missing <script>alert("x")</script>',
  });
  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<b>College"));
  assert.ok(email.html.includes("Accreditation missing &lt;script&gt;"));
  assert.ok(email.text.includes('Reason: Accreditation missing <script>alert("x")</script>'), "plain text keeps the exact reason");
});

test("unknown template names fail loudly", () => {
  assert.throws(() => renderEmail("nope", {}), /Unknown email template/);
});
