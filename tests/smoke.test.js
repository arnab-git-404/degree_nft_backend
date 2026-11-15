// Baseline smoke tests (P00-08): run the real app in-process against the dev DB from .env.
// Each test makes its own throwaway users and everything is deleted in after().
import "dotenv/config";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import nacl from "tweetnacl";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Keypair } from "@solana/web3.js";
import app from "../app.js";
import seedRoles from "../utils/seedRoles.js";
import { signToken } from "../utils/jwt.js";
import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
import Institution from "../models/institution.js";
import InstitutionMembership from "../models/institutionMembership.js";
import AuditLog from "../models/auditLog.js";
import InstitutionApplication from "../models/institutionApplication.js";
import RegistrationLink from "../models/registrationLink.js";
import { audit } from "../utils/audit.js";
import NFT from "../models/nft.js";
import StudentDetails from "../models/studentDetails.js";

describe("baseline smoke", { skip: !process.env.MONGODB_URI && "MONGODB_URI not set" }, () => {
  let server;
  let base;
  const created = { users: [], wallets: [], unis: [], roles: [] };

  const call = async (method, path, { token, body, institution } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
        ...(institution && { "X-Institution-Id": String(institution._id || institution) }),
      },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const makeUser = async (roleName, fields = {}) => {
    const role = await Role.findOne({ name: roleName });
    const user = await User.create({ name: `smoke-${roleName}`, roleId: role._id, ...fields });
    const wallet = await Wallet.create({
      userId: user._id,
      address: Keypair.generate().publicKey.toBase58(),
      isPrimary: true,
      isVerified: true,
    });
    created.users.push(user._id);
    created.wallets.push(wallet._id);
    await user.populate("roleId");
    return { user, wallet, token: signToken(user) };
  };

  const makeInstitution = async (owner, verificationStatus) => {
    const institution = await Institution.create({
      userId: owner.user._id,
      name: "Smoke Institution",
      code: `SMOKE${Date.now()}${Math.floor(Math.random() * 1000)}`,
      walletAddress: owner.wallet.address,
      walletId: owner.wallet._id,
      verificationStatus,
    });
    created.unis.push(institution._id);
    // Same as the real profile flow: the owner is the ACTIVE head.
    const head = await Role.findOne({ name: "institution_admin" });
    await InstitutionMembership.create({ userId: owner.user._id, institutionId: institution._id, roleId: head._id, status: "ACTIVE" });
    return institution;
  };

  const allocation = (studentWallet) => ({
    studentWallet,
    name: "Smoke Degree",
    symbol: "DEG",
    uri: "https://ipfs.io/ipfs/QmSmoke",
    ipfsHash: "QmSmoke",
  });

  before(async () => {
    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: process.env.MONGODB_DB_NAME || "DegreeNft",
    });
    await seedRoles();
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    await AuditLog.deleteMany({ $or: [{ actorId: { $in: created.users } }, { institutionId: { $in: created.unis } }, { "details.email": /^smoke-/ }, { actorId: { $exists: false }, userAgent: "node" }] });
    await InstitutionMembership.deleteMany({ $or: [{ institutionId: { $in: created.unis } }, { userId: { $in: created.users } }] });
    await NFT.deleteMany({ institutionId: { $in: created.unis } });
    await StudentDetails.deleteMany({ institutionId: { $in: created.unis } });
    await Institution.deleteMany({ _id: { $in: created.unis } });
    await Wallet.deleteMany({ _id: { $in: created.wallets } });
    await User.deleteMany({ _id: { $in: created.users } });
    await Role.deleteMany({ _id: { $in: created.roles } });
    server?.close();
    await mongoose.disconnect();
  });

  describe("auth", () => {
    test("protected route without token is 401", async () => {
      assert.equal((await call("GET", "/auth/me")).status, 401);
    });

    test("wallet login: unregistered wallet is refused, forged and replayed signatures fail", async () => {
      const keypair = Keypair.generate();
      const walletAddress = keypair.publicKey.toBase58();
      const nonce = await call("POST", "/auth/nonce", { body: { walletAddress } });
      assert.equal(nonce.status, 200);

      const signature = Buffer.from(
        nacl.sign.detached(new TextEncoder().encode(nonce.body.message), keypair.secretKey)
      ).toString("base64");

      const unregistered = await call("POST", "/auth/login/wallet", { body: { walletAddress, signature } });
      assert.equal(unregistered.status, 403);
      assert.equal(unregistered.body.code, "WALLET_NOT_REGISTERED");

      await call("POST", "/auth/nonce", { body: { walletAddress } });
      const forged = await call("POST", "/auth/login/wallet", {
        body: { walletAddress, signature: Buffer.alloc(64).toString("base64") },
      });
      assert.equal(forged.status, 401);

      const replayed = await call("POST", "/auth/login/wallet", { body: { walletAddress, signature } });
      assert.equal(replayed.status, 401);
    });
  });

  describe("userType label and permission-based admin access (P01-01/P01-02)", () => {
    test("admin API needs the platform:manage permission; userType alone grants nothing", async () => {
      const labelOnly = await makeUser("student", { userType: "SUPER_ADMIN" });
      assert.equal((await call("GET", "/admin/stats", { token: labelOnly.token })).status, 403);

      const customRole = await Role.create({
        name: `smoke-ops-${Date.now()}`,
        displayName: "Smoke Ops",
        permissions: ["platform:manage"],
      });
      created.roles.push(customRole._id);
      const operator = await makeUser(customRole.name);
      assert.equal((await call("GET", "/admin/stats", { token: operator.token })).status, 200);

      const admin = await makeUser("admin");
      assert.equal((await call("GET", "/admin/stats", { token: admin.token })).status, 200);
    });

    test("profile PATCH cannot set userType", async () => {
      const student = await makeUser("student");
      const response = await call("PATCH", "/auth/profile", {
        token: student.token,
        body: { name: "still a student", userType: "SUPER_ADMIN" },
      });
      assert.equal(response.status, 200);
      assert.equal((await User.findById(student.user._id)).userType, "STUDENT");
    });

    test("role change does not touch userType", async () => {
      const admin = await makeUser("admin");
      const target = await makeUser("student");
      const response = await call("PATCH", `/admin/users/${target.user._id}/role`, {
        token: admin.token,
        body: { role: "admin", userType: "SUPER_ADMIN" },
      });
      assert.equal(response.status, 200);
      assert.equal((await User.findById(target.user._id)).userType, "STUDENT");
    });

    test("only the admin panel sets userType, with validation", async () => {
      const admin = await makeUser("admin");
      const target = await makeUser("student");
      const path = `/admin/users/${target.user._id}/account`;

      assert.equal((await call("PATCH", path, { token: target.token, body: { userType: "STAFF" } })).status, 403);
      assert.equal((await call("PATCH", path, { token: admin.token, body: { userType: "GOD" } })).status, 400);
      assert.equal((await call("PATCH", path, { token: admin.token, body: { userType: "STAFF" } })).status, 200);
      assert.equal((await User.findById(target.user._id)).userType, "STAFF");
    });

    test("users created from a wallet are STUDENT", async () => {
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      const studentWallet = Keypair.generate().publicKey.toBase58();
      await call("POST", "/create-nft-ipfsHash-allocation", { token: owner.token, institution, body: allocation(studentWallet) });
      const wallet = await Wallet.findOne({ address: studentWallet });
      created.wallets.push(wallet._id);
      created.users.push(wallet.userId);
      assert.equal((await User.findById(wallet.userId)).userType, "STUDENT");
    });
  });

  describe("login hardening (P01-03)", () => {
    test("expired token is rejected", async () => {
      const student = await makeUser("student");
      const expired = jwt.sign(
        { sub: student.user._id.toString(), exp: Math.floor(Date.now() / 1000) - 60 },
        process.env.JWT_SECRET
      );
      assert.equal((await call("GET", "/auth/me", { token: expired })).status, 401);
    });

    test("deactivated user's existing token stops working", async () => {
      const student = await makeUser("student");
      assert.equal((await call("GET", "/auth/me", { token: student.token })).status, 200);
      await User.updateOne({ _id: student.user._id }, { isActive: false });
      assert.equal((await call("GET", "/auth/me", { token: student.token })).status, 401);
    });

    test("email login: right password works; wrong, inactive and unverified are refused", async () => {
      const email = `smoke-${Date.now()}@example.test`;
      const password = "correct-horse-battery";
      const user = await makeUser("student", {
        email,
        passwordHash: await bcrypt.hash(password, 4),
        emailVerified: true,
      });

      const ok = await call("POST", "/auth/login", { body: { email, password } });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.token);

      assert.equal((await call("POST", "/auth/login", { body: { email, password: "wrong-password" } })).status, 401);

      await User.updateOne({ _id: user.user._id }, { emailVerified: false });
      assert.equal((await call("POST", "/auth/login", { body: { email, password } })).status, 403);

      await User.updateOne({ _id: user.user._id }, { emailVerified: true, isActive: false });
      assert.equal((await call("POST", "/auth/login", { body: { email, password } })).status, 403);
    });
  });

  describe("wallet ownership proof (P01-04)", () => {
    const signNonce = async (keypair) => {
      const walletAddress = keypair.publicKey.toBase58();
      const { body } = await call("POST", "/auth/nonce", { body: { walletAddress } });
      const signature = Buffer.from(
        nacl.sign.detached(new TextEncoder().encode(body.message), keypair.secretKey)
      ).toString("base64");
      return { walletAddress, signature };
    };

    test("linking a wallet needs a signature from that wallet's key", async () => {
      const student = await makeUser("student");
      const target = Keypair.generate();
      const walletAddress = target.publicKey.toBase58();

      // Nonce for the target wallet, signed by a different key.
      const { body } = await call("POST", "/auth/nonce", { body: { walletAddress } });
      const wrongSignature = Buffer.from(
        nacl.sign.detached(new TextEncoder().encode(body.message), Keypair.generate().secretKey)
      ).toString("base64");
      const forged = await call("POST", "/auth/wallet/link", {
        token: student.token,
        body: { walletAddress, signature: wrongSignature },
      });
      assert.equal(forged.status, 401);

      const linked = await call("POST", "/auth/wallet/link", { token: student.token, body: await signNonce(target) });
      assert.equal(linked.status, 200);
      const wallet = await Wallet.findOne({ address: walletAddress });
      created.wallets.push(wallet._id);
      assert.equal(wallet.isVerified, true);
      assert.ok(wallet.userId.equals(student.user._id));
    });

    test("a wallet already on another account cannot be linked", async () => {
      const owner = await makeUser("student");
      const thief = await makeUser("student");
      const keypair = Keypair.generate();
      const linked = await call("POST", "/auth/wallet/link", { token: owner.token, body: await signNonce(keypair) });
      assert.equal(linked.status, 200);
      created.wallets.push((await Wallet.findOne({ address: keypair.publicKey.toBase58() }))._id);

      const stolen = await call("POST", "/auth/wallet/link", { token: thief.token, body: await signNonce(keypair) });
      assert.equal(stolen.status, 409);
    });

    test("one signed nonce logs in once, even when replayed concurrently", async () => {
      const student = await makeUser("student");
      const keypair = Keypair.generate();
      await call("POST", "/auth/wallet/link", { token: student.token, body: await signNonce(keypair) });
      created.wallets.push((await Wallet.findOne({ address: keypair.publicKey.toBase58() }))._id);

      const proof = await signNonce(keypair);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => call("POST", "/auth/login/wallet", { body: proof }))
      );
      assert.equal(results.filter((r) => r.status === 200).length, 1);
    });
  });

  describe("institutions and memberships (P02-01/P02-02)", () => {
    test("college roles are seeded with INSTITUTION scope", async () => {
      const names = (await Role.find({ scope: "INSTITUTION" })).map((role) => role.name);
      for (const name of ["institution_admin", "registrar", "staff"]) assert.ok(names.includes(name), name);
    });

    test("membership rejects a platform role and duplicate (user, institution)", async () => {
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      const other = await makeUser("student");
      const platformRole = await Role.findOne({ name: "admin" });
      await assert.rejects(
        InstitutionMembership.create({ userId: other.user._id, institutionId: institution._id, roleId: platformRole._id }),
        /INSTITUTION-scoped/
      );

      const registrar = await Role.findOne({ name: "registrar" });
      await InstitutionMembership.create({ userId: other.user._id, institutionId: institution._id, roleId: registrar._id });
      await assert.rejects(
        InstitutionMembership.create({ userId: other.user._id, institutionId: institution._id, roleId: registrar._id }),
        /duplicate key/
      );
    });

    test("a college role cannot be put on a user's account", async () => {
      const admin = await makeUser("admin");
      const target = await makeUser("student");
      const response = await call("PATCH", `/admin/users/${target.user._id}/role`, {
        token: admin.token,
        body: { role: "registrar" },
      });
      assert.equal(response.status, 400);
    });

    test("a SUSPENDED college cannot issue credentials", async () => {
      const student = await makeUser("student");
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      await Institution.updateOne({ _id: institution._id }, { status: "SUSPENDED" });
      const response = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: owner.token,
        institution,
        body: allocation(student.wallet.address),
      });
      assert.equal(response.status, 403);
    });
  });

  describe("tenant context (P02-03)", () => {
    const addMember = async (institution, roleName, status = "ACTIVE") => {
      const member = await makeUser("student");
      const role = await Role.findOne({ name: roleName });
      await InstitutionMembership.create({ userId: member.user._id, institutionId: institution._id, roleId: role._id, status });
      return member;
    };

    test("college endpoints need a selected institution", async () => {
      const owner = await makeUser("institution");
      await makeInstitution(owner, "VERIFIED");
      const response = await call("GET", "/institution/profile", { token: owner.token });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, "INSTITUTION_REQUIRED");
    });

    test("ABC's head cannot act at XYZ by sending XYZ's id", async () => {
      const student = await makeUser("student");
      const abcHead = await makeUser("institution");
      const abc = await makeInstitution(abcHead, "VERIFIED");
      const xyz = await makeInstitution(await makeUser("institution"), "VERIFIED");

      assert.equal((await call("GET", "/institution/profile", { token: abcHead.token, institution: abc })).body.institution._id, String(abc._id));
      assert.equal((await call("GET", "/institution/profile", { token: abcHead.token, institution: xyz })).status, 403);
      const forged = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: abcHead.token,
        institution: xyz,
        body: { ...allocation(student.wallet.address), institutionId: String(xyz._id) },
      });
      assert.equal(forged.status, 403);
      assert.equal(await NFT.countDocuments({ institutionId: xyz._id }), 0);
    });

    test("permissions come from the membership role at that college", async () => {
      const student = await makeUser("student");
      const abc = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const registrar = await addMember(abc, "registrar");
      const staff = await addMember(abc, "staff");

      // Both accounts have the plain student role; only the registrar membership grants nft:create at ABC.
      assert.equal((await call("POST", "/create-nft-ipfsHash-allocation", { token: registrar.token, institution: abc, body: allocation(student.wallet.address) })).status, 201);
      assert.equal((await call("POST", "/create-nft-ipfsHash-allocation", { token: staff.token, institution: abc, body: { ...allocation(student.wallet.address), ipfsHash: "QmOther" } })).status, 403);
    });

    test("INVITED and SUSPENDED memberships grant nothing", async () => {
      const abc = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const invited = await addMember(abc, "registrar", "INVITED");
      const suspended = await addMember(abc, "registrar", "SUSPENDED");
      assert.equal((await call("GET", "/institution/profile", { token: invited.token, institution: abc })).status, 403);
      assert.equal((await call("GET", "/institution/profile", { token: suspended.token, institution: abc })).status, 403);
    });

    test("a platform admin ('*' account role) gets no college access without a membership", async () => {
      const admin = await makeUser("admin");
      const abc = await makeInstitution(await makeUser("institution"), "VERIFIED");
      assert.equal((await call("GET", "/institution/profile", { token: admin.token, institution: abc })).status, 403);
    });

    test("/auth/me lists the user's active memberships", async () => {
      const head = await makeUser("institution");
      const abc = await makeInstitution(head, "VERIFIED");
      const { body } = await call("GET", "/auth/me", { token: head.token });
      const membership = body.user.memberships.find((m) => m.institutionId._id === String(abc._id));
      assert.equal(membership.roleId.name, "institution_admin");
      assert.ok(membership.roleId.permissions.includes("nft:create"));
    });
  });

  describe("cross-college and cross-student attacks (P02-04/P02-05)", () => {
    // ABC issues a credential to student B; attacker A is another student; XYZ is another college.
    const setup = async () => {
      const abcHead = await makeUser("institution");
      const abc = await makeInstitution(abcHead, "VERIFIED");
      const xyzHead = await makeUser("institution");
      const xyz = await makeInstitution(xyzHead, "VERIFIED");
      const victim = await makeUser("student");
      const attacker = await makeUser("student");
      const issued = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: abcHead.token,
        institution: abc,
        body: allocation(victim.wallet.address),
      });
      assert.equal(issued.status, 201);
      const nft = await NFT.findOne({ institutionId: abc._id });
      return { abc, xyz, xyzHead, victim, attacker, nft };
    };

    test("XYZ's head cannot reach ABC through any college endpoint", async () => {
      const { abc, xyzHead } = await setup();
      for (const [method, path] of [
        ["GET", "/institution/profile"],
        ["GET", "/get-all-uploaded-data"],
        ["GET", "/get-reports"],
        ["POST", "/ipfs/pin-json"],
        ["POST", "/update-nft-allocations/11111111111111111111111111111111"],
      ]) {
        const body = method === "POST" ? { name: "x" } : undefined;
        const response = await call(method, path, { token: xyzHead.token, institution: abc, body });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    });

    test("a malformed or injected institution header is refused", async () => {
      const { xyzHead } = await setup();
      for (const header of ["not-an-id", '{"$ne":null}', ""]) {
        const response = await fetch(`${base}/institution/profile`, {
          headers: { authorization: `Bearer ${xyzHead.token}`, "X-Institution-Id": header },
        });
        assert.equal(response.status, 400, JSON.stringify(header));
      }
    });

    test("a student cannot use another student's wallet on any student endpoint", async () => {
      const { victim, attacker } = await setup();
      const wallet = victim.wallet.address;
      const attempts = [
        ["GET", `/check-authorization/${wallet}`],
        ["GET", `/minted-nfts/${wallet}`],
        ["POST", "/confirm-nft-credential", { walletAddress: wallet }],
        ["POST", "/confirm-mint", { walletAddress: wallet, nft_Mint_Address: Keypair.generate().publicKey.toBase58() }],
        ["POST", "/report-issue", { walletAddress: wallet, nftIpfsHash: "QmSmoke", reportType: "x", reportDetails: "y" }],
      ];
      for (const [method, path, body] of attempts) {
        const response = await call(method, path, { token: attacker.token, body });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    });

    test("a student cannot confirm another student's credential by its id", async () => {
      const { attacker, nft } = await setup();
      const byId = await call("POST", "/confirm-nft-credential", { token: attacker.token, body: { nftId: String(nft._id) } });
      assert.equal(byId.status, 404);
      const injected = await call("POST", "/confirm-nft-credential", { token: attacker.token, body: { nftId: { $ne: null } } });
      assert.equal(injected.status, 400);
      assert.equal((await NFT.findById(nft._id)).isConfirmed, false);
    });

    test("the owner can still confirm their own credential", async () => {
      const { victim, nft } = await setup();
      const response = await call("POST", "/confirm-nft-credential", {
        token: victim.token,
        body: { walletAddress: victim.wallet.address, nftId: String(nft._id) },
      });
      assert.equal(response.status, 200);
      assert.equal((await NFT.findById(nft._id)).isConfirmed, true);
    });
  });

  describe("activity log (P02-06)", () => {
    const latest = (filter) => AuditLog.findOne(filter).sort({ createdAt: -1 });

    test("admin role change is logged as PLATFORM with the actor", async () => {
      const admin = await makeUser("admin");
      const target = await makeUser("student");
      await call("PATCH", `/admin/users/${target.user._id}/role`, { token: admin.token, body: { role: "admin" } });
      const log = await latest({ action: "admin.user.role", targetId: String(target.user._id) });
      assert.equal(log.scope, "PLATFORM");
      assert.ok(log.actorId.equals(admin.user._id));
      assert.equal(log.details.role, "admin");
      assert.equal(log.method, "PATCH");
      assert.ok(log.path.endsWith("/admin/users/:userId/role"), log.path);
    });

    test("a failed email login is logged as FAILURE without the password", async () => {
      const email = `smoke-audit-${Date.now()}@example.test`;
      await call("POST", "/auth/login", { body: { email, password: "secret-guess" } });
      const log = await latest({ action: "auth.login.email", "details.email": email });
      assert.equal(log.outcome, "FAILURE");
      assert.equal(log.scope, "ACCOUNT");
      assert.ok(!JSON.stringify(log).includes("secret-guess"));
    });

    test("issuing a credential is logged against that college", async () => {
      const student = await makeUser("student");
      const head = await makeUser("institution");
      const abc = await makeInstitution(head, "VERIFIED");
      await call("POST", "/create-nft-ipfsHash-allocation", { token: head.token, institution: abc, body: allocation(student.wallet.address) });
      const log = await latest({ action: "credential.allocate", institutionId: abc._id });
      assert.equal(log.scope, "INSTITUTION");
      assert.ok(log.actorId.equals(head.user._id));
    });

    test("activity log API: admin only, paginated, filterable", async () => {
      const admin = await makeUser("admin");
      const student = await makeUser("student");
      assert.equal((await call("GET", "/admin/audit-logs", { token: student.token })).status, 403);

      const page = await call("GET", "/admin/audit-logs?limit=2&page=1", { token: admin.token });
      assert.equal(page.status, 200);
      assert.equal(page.body.logs.length, 2);
      assert.equal(page.body.pagination.limit, 2);
      assert.ok(page.body.pagination.total >= 2);
      assert.ok(new Date(page.body.logs[0].createdAt) >= new Date(page.body.logs[1].createdAt));

      const failures = await call("GET", "/admin/audit-logs?type=FAILURE&limit=50", { token: admin.token });
      assert.ok(failures.body.logs.every((log) => log.outcome === "FAILURE"));

      const patches = await call("GET", "/admin/audit-logs?method=PATCH&limit=50", { token: admin.token });
      assert.ok(patches.body.logs.every((log) => log.method === "PATCH"));
      // stats ignore the filter
      assert.equal(patches.body.stats.total, page.body.stats.total);
      assert.equal(patches.body.stats.methods.PATCH, patches.body.pagination.total);

      assert.equal((await call("GET", "/admin/audit-logs?institutionId=bad", { token: admin.token })).status, 400);
    });

    test("a broken log write never breaks the request", async () => {
      await assert.doesNotReject(audit({ ip: "", get: () => "" }, { action: "x", scope: "NOT_A_SCOPE" }));
    });
  });

  describe("college onboarding: apply → approve → head activation (P03)", () => {
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
    let seq = 0;

    after(async () => {
      const codes = new RegExp(`^SMKP3${tag}`, "i");
      const users = await User.find({ email: new RegExp(`^smoke-p3-${tag}`) }).select("_id");
      const institutions = await Institution.find({ code: codes }).select("_id");
      const userIds = users.map((u) => u._id);
      const institutionIds = institutions.map((i) => i._id);
      await AuditLog.deleteMany({ $or: [{ actorId: { $in: userIds } }, { institutionId: { $in: institutionIds } }, { summary: codes }] });
      await InstitutionMembership.deleteMany({ institutionId: { $in: institutionIds } });
      await Institution.deleteMany({ _id: { $in: institutionIds } });
      await Wallet.deleteMany({ userId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
      await InstitutionApplication.deleteMany({ code: codes });
      await RegistrationLink.deleteMany({ label: new RegExp(`^smoke-p3-${tag}`) });
    });

    const newLink = async (admin) => {
      const response = await call("POST", "/admin/registration-links", { token: admin.token, body: { label: `smoke-p3-${tag}` } });
      assert.equal(response.status, 201);
      return response.body.link;
    };

    const apply = async (link, overrides = {}) => {
      seq += 1;
      const body = {
        name: `Smoke College ${seq}`,
        code: `SMKP3${tag}${seq}`,
        email: `smoke-p3-${tag}-${seq}@example.test`,
        contactName: `Head ${seq}`,
        walletAddress: Keypair.generate().publicKey.toBase58(),
        ...overrides,
      };
      const response = await call("POST", `/registration/${link.token}/apply`, { body });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return InstitutionApplication.findOne({ code: body.code.toUpperCase() });
    };

    const tokenFor = async (userId) => signToken(await User.findById(userId).populate("roleId"));

    test("full flow: approval creates an INVITED head; activation makes them ACTIVE; the link is single-use", async () => {
      const admin = await makeUser("admin");
      const application = await apply(await newLink(admin));
      assert.equal(application.status, "PENDING");

      const outsider = await makeUser("institution");
      assert.equal((await call("POST", `/admin/applications/${application._id}/approve`, { token: outsider.token })).status, 403);

      const approved = await call("POST", `/admin/applications/${application._id}/approve`, { token: admin.token });
      assert.equal(approved.status, 201, JSON.stringify(approved.body));
      assert.ok(approved.body.activationUrl);

      const institution = await Institution.findById(approved.body.institution._id);
      assert.equal(institution.status, "ACTIVE");
      assert.equal(institution.verificationStatus, "VERIFIED");
      assert.ok(institution.applicationId.equals(application._id));

      const membership = await InstitutionMembership.findById(institution.primaryAdminMembershipId).populate("roleId");
      assert.equal(membership.status, "INVITED");
      assert.equal(membership.roleId.name, "institution_admin");
      const head = await User.findById(membership.userId);
      assert.equal(head.userType, "ADMIN");
      assert.equal(head.email, application.email);

      const reviewed = await InstitutionApplication.findById(application._id);
      assert.equal(reviewed.status, "APPROVED");
      assert.ok(reviewed.reviewedBy.equals(admin.user._id));
      assert.ok(reviewed.institutionId.equals(institution._id));

      // INVITED: no college access yet.
      const headToken = await tokenFor(head._id);
      assert.equal((await call("GET", "/institution/profile", { token: headToken, institution })).status, 403);

      const activationToken = approved.body.activationUrl.split("/").pop();
      assert.equal((await call("POST", `/auth/activate/${activationToken}`)).status, 200);
      assert.equal((await InstitutionMembership.findById(membership._id)).status, "ACTIVE");
      assert.equal((await call("GET", "/institution/profile", { token: headToken, institution })).status, 200);

      assert.equal((await call("POST", `/auth/activate/${activationToken}`)).status, 400);
    });

    test("approving again, even concurrently, never creates a second college", async () => {
      const admin = await makeUser("admin");
      const link = await newLink(admin);

      const first = await apply(link);
      const once = await call("POST", `/admin/applications/${first._id}/approve`, { token: admin.token });
      const twice = await call("POST", `/admin/applications/${first._id}/approve`, { token: admin.token });
      assert.equal(twice.status, 200);
      assert.equal(twice.body.alreadyApproved, true);
      assert.equal(twice.body.institution._id, once.body.institution._id);

      const second = await apply(link);
      const results = await Promise.all(
        [1, 2, 3].map(() => call("POST", `/admin/applications/${second._id}/approve`, { token: admin.token }))
      );
      assert.ok(results.every((r) => r.status === 200 || r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status)));
      assert.equal(await Institution.countDocuments({ code: second.code }), 1);
      assert.equal(await InstitutionMembership.countDocuments({ institutionId: (await Institution.findOne({ code: second.code }))._id }), 1);
    });

    test("rejection needs a reason, creates nothing, and blocks a later approval", async () => {
      const admin = await makeUser("admin");
      const application = await apply(await newLink(admin));
      assert.equal((await call("POST", `/admin/applications/${application._id}/reject`, { token: admin.token, body: {} })).status, 400);
      const rejected = await call("POST", `/admin/applications/${application._id}/reject`, { token: admin.token, body: { reason: "Not accredited" } });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.application.reviewNote, "Not accredited");
      assert.equal((await call("POST", `/admin/applications/${application._id}/approve`, { token: admin.token })).status, 409);
      assert.equal(await Institution.countDocuments({ code: application.code }), 0);
    });

    test("approval refuses to attach a college to an existing account", async () => {
      const admin = await makeUser("admin");
      const email = `smoke-p3-${tag}-taken@example.test`;
      await makeUser("student", { email });
      const application = await apply(await newLink(admin), { email });
      const response = await call("POST", `/admin/applications/${application._id}/approve`, { token: admin.token });
      assert.equal(response.status, 409);
      assert.equal((await InstitutionApplication.findById(application._id)).status, "PENDING");
    });

    test("an expired registration link stops accepting applications", async () => {
      const admin = await makeUser("admin");
      const link = await newLink(admin);
      assert.ok(new Date(link.expiresAt) > new Date());
      await RegistrationLink.updateOne({ _id: link._id }, { expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await call("GET", `/registration/${link.token}`)).status, 404);
    });

    test("applications list is admin-only, paginated and filterable by status", async () => {
      const admin = await makeUser("admin");
      const application = await apply(await newLink(admin));
      const student = await makeUser("student");
      assert.equal((await call("GET", "/admin/applications", { token: student.token })).status, 403);
      const list = await call("GET", `/admin/applications?status=PENDING&search=${application.code}`, { token: admin.token });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.equal(list.body.applications.length, 1);
      assert.equal(list.body.pagination.total, 1);
    });
  });

  describe("staff delegation (P04)", () => {
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
    let seq = 0;
    const email = () => `smoke-p4-${tag}-${(seq += 1)}@example.test`;
    const roleId = async (name) => String((await Role.findOne({ name }))._id);
    const tokenFor = async (userId) => signToken(await User.findById(userId).populate("roleId"));

    after(async () => {
      const users = await User.find({ email: new RegExp(`^smoke-p4-${tag}`) }).select("_id");
      const userIds = users.map((u) => u._id);
      await AuditLog.deleteMany({ actorId: { $in: userIds } });
      await InstitutionMembership.deleteMany({ userId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    });

    // A college whose owner is the primary head, as after P03 approval.
    const college = async () => {
      const head = await makeUser("student", { userType: "ADMIN" });
      const institution = await makeInstitution(head, "VERIFIED");
      const membership = await InstitutionMembership.findOne({ userId: head.user._id, institutionId: institution._id });
      institution.primaryAdminMembershipId = membership._id;
      await institution.save();
      return { head, institution, headMembership: membership };
    };

    // Invite a new email and activate it, like the real flow; returns the new member's token and membership.
    const inviteAndActivate = async ({ head, institution }, roleName) => {
      const invited = await call("POST", "/institution/staff", {
        token: head.token,
        institution,
        body: { email: email(), name: "Smoke Staff", roleId: await roleId(roleName) },
      });
      assert.equal(invited.status, 201, JSON.stringify(invited.body));
      const token = invited.body.activationUrl.split("/").pop();
      assert.equal((await call("POST", `/auth/activate/${token}`)).status, 200);
      const membership = await InstitutionMembership.findById(invited.body.membership._id);
      return { membership, token: await tokenFor(membership.userId) };
    };

    test("head invites a new person as Registrar; access starts only after activation", async () => {
      const tenant = await college();
      const invited = await call("POST", "/institution/staff", {
        token: tenant.head.token,
        institution: tenant.institution,
        body: { email: email(), name: "Reg One", roleId: await roleId("registrar") },
      });
      assert.equal(invited.status, 201, JSON.stringify(invited.body));
      assert.equal(invited.body.existingAccount, false);
      assert.equal(invited.body.membership.status, "INVITED");

      const user = await User.findById(invited.body.membership.userId);
      assert.equal(user.userType, "STAFF");
      const early = await tokenFor(user._id);
      assert.equal((await call("GET", "/institution/profile", { token: early, institution: tenant.institution })).status, 403);

      assert.equal((await call("POST", `/auth/activate/${invited.body.activationUrl.split("/").pop()}`)).status, 200);
      const membership = await InstitutionMembership.findById(invited.body.membership._id);
      assert.equal(membership.status, "ACTIVE");
      assert.ok(membership.invitedBy.equals(tenant.head.user._id));

      // A Registrar works in the college but cannot see or manage its staff.
      const registrar = await tokenFor(user._id);
      assert.equal((await call("GET", "/institution/profile", { token: registrar, institution: tenant.institution })).status, 200);
      assert.equal((await call("GET", "/institution/staff", { token: registrar, institution: tenant.institution })).status, 403);
      const reInvite = await call("POST", "/institution/staff", {
        token: registrar,
        institution: tenant.institution,
        body: { email: email(), name: "X", roleId: await roleId("staff") },
      });
      assert.equal(reInvite.status, 403);

      const list = await call("GET", "/institution/staff", { token: tenant.head.token, institution: tenant.institution });
      assert.equal(list.status, 200);
      assert.equal(list.body.members.length, 2);
      assert.equal(String(list.body.primaryAdminMembershipId), String(tenant.headMembership._id));
      assert.ok(!list.body.roles.some((role) => role.name === "institution_admin"), "head is not offered the admin role");
    });

    test("head cannot grant admin roles, platform roles, or invite into another college", async () => {
      const tenant = await college();
      const other = await college();
      const body = (id) => ({ email: email(), name: "X", roleId: id });

      const admin = await call("POST", "/institution/staff", { token: tenant.head.token, institution: tenant.institution, body: body(await roleId("institution_admin")) });
      assert.equal(admin.status, 403);
      const platform = await call("POST", "/institution/staff", { token: tenant.head.token, institution: tenant.institution, body: body(await roleId("admin")) });
      assert.equal(platform.status, 400);
      const foreign = await call("POST", "/institution/staff", { token: tenant.head.token, institution: other.institution, body: body(await roleId("staff")) });
      assert.equal(foreign.status, 403);

      // A custom INSTITUTION role that can manage staff counts as an admin role too.
      const superAdmin = await makeUser("admin");
      const custom = await call("POST", "/admin/roles", {
        token: superAdmin.token,
        body: { name: `smokep4${tag}`, displayName: "Deputy", permissions: ["staff:invite"], scope: "INSTITUTION" },
      });
      assert.equal(custom.status, 201, JSON.stringify(custom.body));
      created.roles.push(custom.body.role._id);
      assert.equal(custom.body.role.scope, "INSTITUTION");
      const deputy = await call("POST", "/institution/staff", { token: tenant.head.token, institution: tenant.institution, body: body(custom.body.role._id) });
      assert.equal(deputy.status, 403);
      assert.equal((await call("POST", "/admin/roles", { token: superAdmin.token, body: { name: `smokep4b${tag}`, displayName: "Bad", scope: "TENANT" } })).status, 400);
    });

    test("an existing account is invited only with a verified email and must accept it itself", async () => {
      const tenant = await college();
      const unverifiedEmail = email();
      await makeUser("student", { email: unverifiedEmail, emailVerified: false });
      const refused = await call("POST", "/institution/staff", {
        token: tenant.head.token,
        institution: tenant.institution,
        body: { email: unverifiedEmail, roleId: await roleId("staff") },
      });
      assert.equal(refused.status, 409);

      const verifiedEmail = email();
      const person = await makeUser("student", { email: verifiedEmail, emailVerified: true });
      const invited = await call("POST", "/institution/staff", {
        token: tenant.head.token,
        institution: tenant.institution,
        body: { email: verifiedEmail.toUpperCase(), roleId: await roleId("staff") },
      });
      assert.equal(invited.status, 201, JSON.stringify(invited.body));
      assert.equal(invited.body.existingAccount, true);
      assert.equal(invited.body.activationUrl, undefined);
      assert.equal(await User.countDocuments({ email: verifiedEmail }), 1, "no duplicate account");

      const id = invited.body.membership._id;
      const stranger = await makeUser("student");
      assert.equal((await call("POST", `/memberships/${id}/accept`, { token: stranger.token })).status, 404);
      assert.equal((await call("POST", "/institution/staff", { token: tenant.head.token, institution: tenant.institution, body: { email: verifiedEmail, roleId: await roleId("staff") } })).status, 409);

      const inbox = await call("GET", "/memberships/invitations", { token: person.token });
      assert.equal(inbox.body.invitations.length, 1);
      assert.equal(inbox.body.invitations[0].institutionId.code, tenant.institution.code);

      assert.equal((await call("POST", `/memberships/${id}/accept`, { token: person.token })).status, 200);
      assert.equal((await InstitutionMembership.findById(id)).status, "ACTIVE");
      assert.equal((await call("GET", "/institution/profile", { token: person.token, institution: tenant.institution })).status, 200);
      assert.equal((await call("POST", `/memberships/${id}/accept`, { token: person.token })).status, 404, "accept is single-use");

      // Declining removes the invitation.
      const other = await college();
      const second = await call("POST", "/institution/staff", { token: other.head.token, institution: other.institution, body: { email: verifiedEmail, roleId: await roleId("staff") } });
      assert.equal((await call("POST", `/memberships/${second.body.membership._id}/decline`, { token: person.token })).status, 200);
      assert.equal(await InstitutionMembership.exists({ _id: second.body.membership._id }), null);
    });

    test("role changes and suspension take effect at once and stay inside the college", async () => {
      const tenant = await college();
      const registrar = await inviteAndActivate(tenant, "registrar");
      const student = await makeUser("student");
      const allocate = () => call("POST", "/create-nft-ipfsHash-allocation", { token: registrar.token, institution: tenant.institution, body: allocation(student.wallet.address) });
      const patch = (id, body) => call("PATCH", `/institution/staff/${id}`, { token: tenant.head.token, institution: tenant.institution, body });

      assert.equal((await allocate()).status, 201);
      assert.equal((await patch(registrar.membership._id, { roleId: await roleId("staff") })).status, 200);
      assert.equal((await allocate()).status, 403, "Staff role has no nft:create");

      assert.equal((await patch(registrar.membership._id, { status: "SUSPENDED" })).status, 200);
      assert.equal((await call("GET", "/institution/profile", { token: registrar.token, institution: tenant.institution })).status, 403);
      assert.equal((await patch(registrar.membership._id, { status: "ACTIVE" })).status, 200);
      assert.equal((await call("GET", "/institution/profile", { token: registrar.token, institution: tenant.institution })).status, 200);

      // Limits: not themselves, not an admin, not another college, no skipping acceptance.
      assert.equal((await patch(tenant.headMembership._id, { status: "SUSPENDED" })).status, 403);
      assert.equal((await patch(registrar.membership._id, { roleId: await roleId("institution_admin") })).status, 403);
      const other = await college();
      const foreign = await inviteAndActivate(other, "staff");
      assert.equal((await patch(foreign.membership._id, { status: "SUSPENDED" })).status, 404);
      assert.equal((await InstitutionMembership.findById(foreign.membership._id)).status, "ACTIVE");

      const pending = await call("POST", "/institution/staff", { token: tenant.head.token, institution: tenant.institution, body: { email: email(), name: "P", roleId: await roleId("staff") } });
      assert.equal((await patch(pending.body.membership._id, { status: "ACTIVE" })).status, 409);
      assert.equal((await patch(pending.body.membership._id, { status: "SUSPENDED" })).status, 200, "an invite can be cancelled");
      assert.equal((await patch(pending.body.membership._id, { status: "ACTIVE" })).status, 409);
    });

    test("only the Super Admin promotes admins and transfers the head; the head is never left removable", async () => {
      const tenant = await college();
      const superAdmin = await makeUser("admin");
      const deputy = await inviteAndActivate(tenant, "registrar");
      const base = `/admin/institutions/${tenant.institution._id}`;
      const transfer = (body, token = superAdmin.token) => call("POST", `${base}/head`, { token, body });

      assert.equal((await transfer({ membershipId: deputy.membership._id, reason: "x" }, tenant.head.token)).status, 403);
      assert.equal((await transfer({ membershipId: deputy.membership._id, reason: "handover" })).status, 400, "must be an admin first");
      assert.equal((await transfer({ membershipId: deputy.membership._id })).status, 400, "reason required");

      const promote = await call("PATCH", `${base}/members/${deputy.membership._id}`, { token: superAdmin.token, body: { roleId: await roleId("institution_admin") } });
      assert.equal(promote.status, 200, JSON.stringify(promote.body));

      // The current head cannot be demoted or suspended while they are the head.
      const demoteHead = await call("PATCH", `${base}/members/${tenant.headMembership._id}`, { token: superAdmin.token, body: { roleId: await roleId("staff") } });
      assert.equal(demoteHead.status, 409);
      assert.equal((await call("PATCH", `${base}/members/${tenant.headMembership._id}`, { token: superAdmin.token, body: { status: "SUSPENDED" } })).status, 409);

      const moved = await transfer({ membershipId: deputy.membership._id, reason: "handover" });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const institution = await Institution.findById(tenant.institution._id);
      assert.ok(institution.primaryAdminMembershipId.equals(deputy.membership._id));
      const log = await AuditLog.findOne({ action: "admin.institution.head.transfer", targetId: deputy.membership._id });
      assert.equal(log.details.reason, "handover");
      assert.equal(String(log.details.from), String(tenant.headMembership._id));

      // The old head keeps their admin membership until separately changed; now that is allowed.
      assert.equal((await call("PATCH", `${base}/members/${tenant.headMembership._id}`, { token: superAdmin.token, body: { roleId: await roleId("staff") } })).status, 200);
      const members = await call("GET", `${base}/members`, { token: superAdmin.token });
      assert.ok(members.body.roles.some((role) => role.name === "institution_admin"), "Super Admin is offered admin roles");
      // The demoted old head can no longer manage anyone, least of all the new head.
      assert.equal((await call("PATCH", `/institution/staff/${deputy.membership._id}`, { token: tenant.head.token, institution: tenant.institution, body: { status: "SUSPENDED" } })).status, 403);
    });
  });

  describe("no self-promotion (P00-04)", () => {
    test("no account can create a college by itself; the self-serve endpoint is gone (P03-06)", async () => {
      for (const roleName of ["student", "institution", "admin"]) {
        const user = await makeUser(roleName);
        const response = await call("POST", "/institution/profile", {
          token: user.token,
          body: { name: "Self U", code: `SELF${Date.now()}`, walletAddress: user.wallet.address },
        });
        assert.equal(response.status, 404, roleName);
        const reloaded = await User.findById(user.user._id).populate("roleId");
        assert.equal(reloaded.roleId.name, roleName);
      }
    });

    test("only a VERIFIED institution can allocate credentials", async () => {
      const student = await makeUser("student");
      const pendingOwner = await makeUser("institution");
      const pendingInstitution = await makeInstitution(pendingOwner, "PENDING");
      const pending = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: pendingOwner.token,
        institution: pendingInstitution,
        body: allocation(student.wallet.address),
      });
      assert.equal(pending.status, 403);

      const verifiedOwner = await makeUser("institution");
      const verifiedInstitution = await makeInstitution(verifiedOwner, "VERIFIED");
      const verified = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: verifiedOwner.token,
        institution: verifiedInstitution,
        body: allocation(student.wallet.address),
      });
      assert.equal(verified.status, 201);
    });
  });

  describe("secrets and mint handling (P00-05)", () => {
    test("IPFS pin endpoint requires login and nft:create", async () => {
      assert.equal((await call("POST", "/ipfs/pin-json", { body: { name: "x" } })).status, 401);
      const student = await makeUser("student");
      const institution = await makeInstitution(await makeUser("institution"), "VERIFIED");
      assert.equal(
        (await call("POST", "/ipfs/pin-json", { token: student.token, institution, body: { name: "x" } })).status,
        403
      );
    });

    test("confirm-mint rejects a mint address that is not on-chain", async () => {
      const student = await makeUser("student");
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      await call("POST", "/create-nft-ipfsHash-allocation", {
        token: owner.token,
        institution,
        body: allocation(student.wallet.address),
      });

      const response = await call("POST", "/confirm-mint", {
        token: student.token,
        body: {
          walletAddress: student.wallet.address,
          nft_Mint_Address: Keypair.generate().publicKey.toBase58(),
        },
      });
      assert.equal(response.status, 400);

      const row = await NFT.findOne({ institutionId: institution._id });
      assert.equal(row.minted, false);
    });
  });
});
