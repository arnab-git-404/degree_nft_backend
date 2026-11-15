import test from "node:test";
import assert from "node:assert/strict";
import { parseMetadataUri } from "../utils/solana.js";

// Builds a Metaplex Metadata v1 prefix the way the program stores it (fields null-padded).
const encode = (value, padTo) => {
  const bytes = Buffer.alloc(padTo);
  bytes.write(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(padTo);
  return Buffer.concat([length, bytes]);
};

test("parseMetadataUri reads the padded URI after name and symbol", () => {
  const data = Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(64, 7),
    encode("B.Tech CSE", 32),
    encode("DEG", 10),
    encode("https://ipfs.io/ipfs/QmTest", 200),
    Buffer.alloc(20),
  ]);

  assert.equal(parseMetadataUri(data), "https://ipfs.io/ipfs/QmTest");
});
