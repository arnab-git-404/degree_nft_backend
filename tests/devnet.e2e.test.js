// Phase 4: the whole on-chain flow through the app's HTTP API against REAL Solana Devnet, with the real driver and keys.
// Opt-in (costs a little Devnet SOL, ~1 minute):  DEVNET_E2E=true node --test tests/devnet.e2e.test.js
// Needs in .env: MONGODB_URI, SETTINGS_ENCRYPTION_KEY, PLATFORM_FEE_PAYER_SECRET_KEY, DEGREENFT_TREASURY_ADDRESS.
// Writes transaction ids (no secrets) to ../solana-poc/devnet-e2e-results.json as QA evidence.
import "dotenv/config";
import fs from "node:fs";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createSignerFromKeypair, signerIdentity } from "@metaplex-foundation/umi";
import { mplCore, fetchAsset, fetchCollection, transfer, burn } from "@metaplex-foundation/mpl-core";
import app from "../app.js";
import seedRoles from "../utils/seedRoles.js";
import { signToken } from "../utils/jwt.js";
import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
import Institution from "../models/institution.js";
import InstitutionMembership from "../models/institutionMembership.js";
import Student from "../models/student.js";
import Credential from "../models/credential.js";
import CollegeChain from "../models/collegeChain.js";
import BillingEntry from "../models/billingEntry.js";
import Nft from "../models/nft.js";
import CredentialRequest from "../models/credentialRequest.js";
import PlatformSetting from "../models/platformSetting.js";
import Program from "../models/program.js";
import ProgramSession from "../models/programSession.js";
import Enrollment from "../models/enrollment.js";
import PinnedMetadata from "../models/pinnedMetadata.js";
import AuditLog from "../models/auditLog.js";

const enabled = process.env.DEVNET_E2E === "true";
const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

describe("Devnet end-to-end through the API (Phase 4)", { skip: !enabled && "set DEVNET_E2E=true to run against real Devnet" }, () => {
  let server, base, savedBilling;
  const created = { users: [], wallets: [], unis: [] };
  const evidence = { ranAt: new Date().toISOString(), network: "devnet", steps: [] };
  const record = (step, data) => evidence.steps.push({ step, ...data });
  const connection = new Connection(rpc, "confirmed");
  const raw = (process.env.PLATFORM_FEE_PAYER_SECRET_KEY || "").trim();
  const feePayer = enabled ? Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw)) : null;

  const call = async (method, path, { token, body, institution } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(institution && { "X-Institution-Id": String(institution._id) }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const makeUser = async (roleName, keypair = Keypair.generate()) => {
    const user = await User.create({ name: `e2e-${roleName}`, roleId: (await Role.findOne({ name: roleName }))._id });
    const wallet = await Wallet.create({ userId: user._id, address: keypair.publicKey.toBase58(), isPrimary: true, isVerified: true });
    created.users.push(user._id);
    created.wallets.push(wallet._id);
    return { user, wallet, keypair, token: signToken(user) };
  };
  const sign = async (keypair) => {
    const walletAddress = keypair.publicKey.toBase58();
    const nonce = await call("POST", "/auth/nonce", { body: { walletAddress } });
    return { walletAddress, signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce.body.message), keypair.secretKey)).toString("base64") };
  };
  const sendSol = (from, to, sol) =>
    sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [from]);

  before(async () => {
    process.env.RATE_LIMIT_DISABLED = "true";
    delete process.env.CHAIN_DRIVER; // the real Solana driver
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB_NAME || "DegreeNft" });
    await seedRoles();
    savedBilling = (await PlatformSetting.findOne({ key: "platform" }).lean())?.billing;
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    await PlatformSetting.updateOne({ key: "platform" }, savedBilling ? { $set: { billing: savedBilling } } : { $unset: { billing: 1 } });
    const unis = { institutionId: { $in: created.unis } };
    for (const model of [Credential, CollegeChain, BillingEntry, Nft, CredentialRequest, Student, InstitutionMembership, AuditLog, Program, ProgramSession, Enrollment, PinnedMetadata]) await model.deleteMany(unis);
    await Institution.deleteMany({ _id: { $in: created.unis } });
    await Wallet.deleteMany({ _id: { $in: created.wallets } });
    await User.deleteMany({ _id: { $in: created.users } });
    fs.writeFileSync(new URL("../../solana-poc/devnet-e2e-results.json", import.meta.url), JSON.stringify(evidence, null, 2));
    server?.close();
    await mongoose.disconnect();
  });

  test("college setup → payment → claim → recovery → revoke → burn, all on Devnet", { timeout: 300_000 }, async () => {
    // People: Super Admin, a college with its own wallet (we hold the key), a second admin, a student.
    const admin = await makeUser("admin");
    const collegeKey = Keypair.generate();
    const head = await makeUser("institution", collegeKey);
    const college = await Institution.create({ userId: head.user._id, name: "E2E Devnet College", code: `E2E${Date.now()}`, walletAddress: collegeKey.publicKey.toBase58(), walletId: head.wallet._id, verificationStatus: "VERIFIED" });
    created.unis.push(college._id);
    const adminRole = await Role.findOne({ name: "institution_admin" });
    await InstitutionMembership.create({ userId: head.user._id, institutionId: college._id, roleId: adminRole._id, status: "ACTIVE" });
    const second = await makeUser("institution");
    await InstitutionMembership.create({ userId: second.user._id, institutionId: college._id, roleId: adminRole._id, status: "ACTIVE" });
    const student = await makeUser("student");
    const profile = await Student.create({ institutionId: college._id, fullName: "Devnet Student", email: `e2e-${college._id}@example.com`, userId: student.user._id });
    const as = (who) => (method, path, body) => call(method, path, { token: who.token, institution: college, body });

    // 1. Price, and the college's collection created by the Super Admin (real transaction).
    assert.equal((await call("PUT", "/admin/settings/billing", { token: admin.token, body: { priceSol: "0.001", priceUsdc: "1" } })).status, 200);
    // Three college officials (we hold their keys here, as their wallet apps would); any 2 must approve.
    const officials = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const setup = await call("POST", `/admin/institutions/${college._id}/chain`, {
      token: admin.token,
      body: { members: officials.map((official) => official.publicKey.toBase58()), threshold: 2 },
    });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    const { collectionAddress, setupSignature, mintingAddress, multisig } = setup.body.chain;
    record("collection created", { collectionAddress, signature: setupSignature });

    // The permanent rules are really on the collection: no freeze key, the officials' vault moves and burns.
    const umi = createUmi(rpc, "confirmed").use(mplCore());
    const collection = await fetchCollection(umi, collectionAddress);
    assert.equal(String(collection.updateAuthority), mintingAddress);
    assert.equal(collection.permanentFreezeDelegate?.frozen, true);
    assert.equal(collection.permanentFreezeDelegate?.authority.type, "None");
    assert.equal(String(collection.permanentTransferDelegate?.authority.address), multisig.vault);
    assert.equal(String(collection.permanentBurnDelegate?.authority.address), multisig.vault);
    record("permanent plugins checked", { freezeAuthority: "None", recoveryAndBurnAuthority: multisig.vault, multisig: multisig.address });

    // An official approves: the app builds the approval, the official's wallet signs it, the app sends it.
    const approveWith = async (user, requestId, official, extra = {}) => {
      const query = new URLSearchParams({ wallet: official.publicKey.toBase58(), ...extra }).toString();
      const built = await as(user)("GET", `/institution/credential-requests/${requestId}/approval-tx?${query}`);
      if (built.status !== 200) return built;
      const transaction = VersionedTransaction.deserialize(Buffer.from(built.body.transaction, "base64"));
      transaction.sign([official]);
      return as(user)("POST", `/institution/credential-requests/${requestId}/approval-tx`, {
        wallet: official.publicKey.toBase58(),
        signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
        ...extra,
      });
    };

    // 2. The college pays the treasury from its own wallet; the app credits it once.
    await sendSol(feePayer, college.walletAddress, 0.01);
    const paySig = await sendSol(collegeKey, process.env.DEGREENFT_TREASURY_ADDRESS, 0.002);
    const synced = await as(head)("POST", "/institution/billing/sync");
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.equal(synced.body.balances.SOL, 2_000_000);
    const resync = await as(head)("POST", "/institution/billing/sync");
    assert.equal(resync.body.added, 0, JSON.stringify(resync.body).slice(0, 400));
    record("college payment credited", { signature: paySig, lamports: 2_000_000 });

    // 3. Issue, confirm, claim: the backend mints into the student's wallet; the college is charged once.
    // The student's enrollment, and the metadata as if pinned through DegreeNFT (Pinata itself is not part of this test).
    const program = await Program.create({ institutionId: college._id, code: "E2E", name: "E2E Program" });
    const batch = await ProgramSession.create({ institutionId: college._id, programId: program._id, startYear: 2022, endYear: 2026, code: "E2E-2022" });
    const enrollment = await Enrollment.create({ institutionId: college._id, studentId: profile._id, programSessionId: batch._id, programId: program._id });
    const ipfsHash = `QmE2E${Date.now()}`;
    await PinnedMetadata.create({ institutionId: college._id, cid: ipfsHash, sha256: "e2e" });
    const issued = await as(head)("POST", "/institution/credentials", { enrollmentId: String(enrollment._id), name: "B.Tech (E2E)", symbol: "DEG", uri: `https://ipfs.io/ipfs/${ipfsHash}`, ipfsHash });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    const credentialId = issued.body.credential?._id || (await Credential.findOne({ institutionId: college._id }))._id;
    await Credential.updateOne({ _id: credentialId }, { studentId: profile._id, isConfirmed: true });
    const credential = await Credential.findById(credentialId);
    const claim = () => call("POST", "/student/credentials/claim", { token: student.token, body: { walletAddress: student.wallet.address, credentialId: String(credentialId), revision: credential.revision } });
    const claimed = await claim();
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    const { assetAddress, mintSignature } = claimed.body.nft;
    record("claimed and minted", { assetAddress, signature: mintSignature });
    let asset = await fetchAsset(umi, assetAddress);
    assert.equal(String(asset.owner), student.wallet.address);
    assert.equal(String(asset.updateAuthority.address), collectionAddress);
    assert.equal((await claim()).body.nft.assetAddress, assetAddress); // a second click: same asset
    assert.equal((await BillingEntry.find({ institutionId: college._id, kind: "CHARGE" })).length, 1);
    assert.equal((await call("GET", `/verify/${assetAddress}`)).body.status, "VERIFIED");

    // 4. The student cannot move or burn it themselves (frozen, real chain).
    const studentUmi = createUmi(rpc, "confirmed").use(mplCore());
    studentUmi.use(signerIdentity(createSignerFromKeypair(studentUmi, studentUmi.eddsa.createKeypairFromSecretKey(feePayer.secretKey))));
    const studentSigner = createSignerFromKeypair(studentUmi, studentUmi.eddsa.createKeypairFromSecretKey(student.keypair.secretKey));
    await assert.rejects(transfer(studentUmi, { asset, collection, newOwner: Keypair.generate().publicKey.toBase58(), authority: studentSigner }).sendAndConfirm(studentUmi));
    await assert.rejects(burn(studentUmi, { asset, collection, authority: studentSigner }).sendAndConfirm(studentUmi));
    record("student transfer and burn refused on-chain", {});

    // 5. Lost wallet: proof of the new wallet, two approvals by two people, same asset moves.
    const started = await as(head)("POST", `/institution/students/${profile._id}/recovery`, { reason: "E2E: phone lost" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const newKey = Keypair.generate();
    assert.equal((await call("POST", `/auth/recovery/${started.body.recoveryUrl.split("/recover/")[1]}/prove`, { body: await sign(newKey) })).status, 200);
    const newWalletDoc = await Wallet.findOne({ address: newKey.publicKey.toBase58() });
    created.users.push(newWalletDoc.userId);
    created.wallets.push(newWalletDoc._id);
    const requestId = started.body.request._id;
    const one = await approveWith(head, requestId, officials[0]);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.request.status, "PENDING_APPROVAL"); // one official is not enough
    assert.equal((await approveWith(head, requestId, officials[0])).status, 409); // nor the same one twice
    const recovered = await approveWith(second, requestId, officials[1]);
    assert.equal(recovered.body.request?.status, "EXECUTED", JSON.stringify(recovered.body));
    asset = await fetchAsset(umi, assetAddress);
    assert.equal(String(asset.owner), newKey.publicKey.toBase58()); // same asset address, new owner
    assert.equal((await call("GET", `/verify/${assetAddress}`)).body.status, "VERIFIED");
    record("recovered to a new wallet", { assetAddress, newOwner: newKey.publicKey.toBase58(), signature: recovered.body.request.results.at(-1)?.signature });

    // 6. Revoke by status: the asset stays, verification says REVOKED.
    await as(head)("POST", `/institution/credentials/${credentialId}/status`, { status: "REVOKED", reason: "E2E revoke" });
    assert.equal((await call("GET", `/verify/${assetAddress}`)).body.status, "REVOKED");
    assert.ok(await fetchAsset(umi, assetAddress));
    record("revoked without burning", { assetAddress });

    // 7. Exceptional burn: two approvals and explicit confirmation; the asset is gone on-chain.
    const burnRequest = await as(head)("POST", `/institution/credentials/${credentialId}/burn`, { reason: "E2E burn" });
    assert.equal(burnRequest.status, 201, JSON.stringify(burnRequest.body));
    await approveWith(head, burnRequest.body.request._id, officials[1], { confirmIrreversible: "true" });
    const burned = await approveWith(second, burnRequest.body.request._id, officials[2], { confirmIrreversible: "true" });
    assert.equal(burned.body.request?.status, "EXECUTED", JSON.stringify(burned.body));
    await assert.rejects(fetchAsset(umi, assetAddress));
    assert.equal((await call("GET", `/verify/${assetAddress}`)).body.status, "REVOKED");
    record("burned", { assetAddress, signature: burned.body.request.results.at(-1)?.signature });
  });
});
