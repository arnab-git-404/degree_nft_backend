import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";

test("gzip compression runs before the API routes", () => {
  const names = app._router.stack.map((layer) => layer.name);
  const gzip = names.indexOf("gzip");
  assert.ok(gzip !== -1, "compression middleware is not mounted");
  assert.ok(gzip < names.indexOf("router"), "compression must come before /api");
});
