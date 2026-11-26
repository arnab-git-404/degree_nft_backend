import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApplication, walletConflict } from "../controllers/registrationController.js";

const valid = {
  name: " Example Institution ",
  code: "exu-01",
  email: "Admissions@Example.edu",
  contactName: "Registrar",
  walletAddress: "11111111111111111111111111111111",
  website: "https://example.edu",
};

test("normalises a valid application", () => {
  const result = parseApplication(valid);
  assert.equal(result.name, "Example Institution");
  assert.equal(result.code, "EXU-01");
  assert.equal(result.email, "admissions@example.edu");
});

test("rejects missing required fields", () => {
  assert.throws(() => parseApplication({ ...valid, contactName: "" }), /contactName is required/);
  assert.throws(() => parseApplication({ ...valid, walletAddress: "" }), /walletAddress is required/);
});

test("rejects an invalid wallet address", () => {
  assert.throws(
    () => parseApplication({ ...valid, walletAddress: "not-a-wallet" }),
    /valid Solana address/
  );
});

test("rejects bad code, email and non-http website", () => {
  assert.throws(() => parseApplication({ ...valid, code: "A" }), /code must be/);
  assert.throws(() => parseApplication({ ...valid, email: "nope" }), /valid email/);
  assert.throws(
    () => parseApplication({ ...valid, website: "javascript:alert(1)" }),
    /website must start/
  );
});

test("classifies wallet conflicts, registered first", () => {
  assert.equal(walletConflict({}), null);
  assert.equal(walletConflict({ institution: { _id: 1 }, application: { status: "PENDING" } }), "WALLET_REGISTERED");
  assert.equal(walletConflict({ application: { status: "APPROVED" } }), "WALLET_REGISTERED");
  assert.equal(walletConflict({ application: { status: "PENDING" }, account: { _id: 1 } }), "WALLET_PENDING");
  assert.equal(walletConflict({ account: { _id: 1 } }), "WALLET_IN_USE");
});

test("rejects oversized input", () => {
  assert.throws(() => parseApplication({ ...valid, name: "x".repeat(201) }), /200 characters/);
});
