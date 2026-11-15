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

    test("creating a college profile makes the creator its ACTIVE head", async () => {
      const owner = await makeUser("institution");
      const response = await call("POST", "/institution/profile", {
        token: owner.token,
        body: { name: "Head U", code: `HEAD${Date.now()}`, walletAddress: owner.wallet.address },
      });
      assert.equal(response.status, 201);
      created.unis.push(response.body.institution._id);

      const institution = await Institution.findById(response.body.institution._id);
      assert.equal(institution.institutionType, "COLLEGE");
      assert.equal(institution.status, "ACTIVE");

      const membership = await InstitutionMembership.findById(institution.primaryAdminMembershipId).populate("roleId");
      assert.ok(membership.userId.equals(owner.user._id));
      assert.ok(membership.institutionId.equals(institution._id));
      assert.equal(membership.roleId.name, "institution_admin");
      assert.equal(membership.status, "ACTIVE");
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

  describe("no self-promotion (P00-04)", () => {
    test("student cannot create an institution profile and keeps the student role", async () => {
      const student = await makeUser("student");
      const response = await call("POST", "/institution/profile", {
        token: student.token,
        body: { name: "Evil U", code: `EVIL${Date.now()}`, walletAddress: student.wallet.address },
      });
      assert.equal(response.status, 403);
      const reloaded = await User.findById(student.user._id).populate("roleId");
      assert.equal(reloaded.roleId.name, "student");
    });

    test("institution-role user can still create a profile", async () => {
      const institution = await makeUser("institution");
      const response = await call("POST", "/institution/profile", {
        token: institution.token,
        body: { name: "Smoke U", code: `SMOKEP${Date.now()}`, walletAddress: institution.wallet.address },
      });
      assert.equal(response.status, 201);
      created.unis.push(response.body.institution._id);
    });

    test("a custom-named role with nft:create can create a profile (name never matters)", async () => {
      const customRole = await Role.create({
        name: `smoke-registrar-${Date.now()}`,
        displayName: "Smoke Registrar",
        permissions: ["nft:create"],
      });
      created.roles.push(customRole._id);
      const registrar = await makeUser(customRole.name);
      const response = await call("POST", "/institution/profile", {
        token: registrar.token,
        body: { name: "Smoke Reg U", code: `SMOKER${Date.now()}`, walletAddress: registrar.wallet.address },
      });
      assert.equal(response.status, 201);
      created.unis.push(response.body.institution._id);
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
