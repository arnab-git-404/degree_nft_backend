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
import app, { allowedOrigins } from "../app.js";
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
import Credential from "../models/credential.js";
import CredentialType from "../models/credentialType.js";
import Reports from "../models/reports.js";
import PlatformSetting from "../models/platformSetting.js";
import { decryptSecret } from "../utils/secretBox.js";
import { sendMail } from "../services/emailService.js";
import StudentDetails from "../models/studentDetails.js";
import Program from "../models/program.js";
import ProgramSession from "../models/programSession.js";
import AcademicSession from "../models/academicSession.js";
import Student from "../models/student.js";
import Enrollment from "../models/enrollment.js";
import CollegeChain from "../models/collegeChain.js";
import BillingEntry from "../models/billingEntry.js";
import Nft from "../models/nft.js";
import CredentialRequest from "../models/credentialRequest.js";
import { fakeChain, addressOfSecret } from "../utils/chain.js";
import { pickPayment } from "../services/billingService.js";
import { toUnits } from "../controllers/chainController.js";
import PinnedMetadata from "../models/pinnedMetadata.js";
import { findOrCreateUserByWallet } from "../services/userWalletService.js";
import { alertAdmins } from "../services/alertService.js";

describe("baseline smoke", { skip: !process.env.MONGODB_URI && "MONGODB_URI not set" }, () => {
  let server;
  let base;
  const created = { users: [], wallets: [], unis: [], roles: [] };

  // Issuing needs (1) metadata pinned through DegreeNFT for the college and (2) an enrollment of a student who linked
  // the wallet. Tests that are about something else get both prepared here, the way a real college would have them;
  // tests about those two rules pass raw: true.
  const prepareIssue = async (institution, path, body) => {
    const institutionId = String(institution._id || institution);
    await PinnedMetadata.updateOne({ institutionId, cid: body.ipfsHash }, { $setOnInsert: { sha256: "test" } }, { upsert: true });
    if (path !== "/institution/credentials") return body; // revise tests check their own links
    body = { ...body, uri: `https://ipfs.io/ipfs/${body.ipfsHash}` }; // allocation() has a fixed QmSmoke link; tests override only the hash
    if (body.enrollmentId || !body.studentWallet) return body;
    const { user, wallet } = await findOrCreateUserByWallet(body.studentWallet);
    created.users.push(user._id);
    created.wallets.push(wallet._id);
    const profile =
      (await Student.findOne({ institutionId, userId: user._id })) ||
      (await Student.create({ institutionId, userId: user._id, fullName: "Smoke Student", email: `smoke-${wallet._id}@example.com` }));
    const program = (await Program.findOne({ institutionId, code: "SMK" })) || (await Program.create({ institutionId, code: "SMK", name: "Smoke Program" }));
    const batch =
      (await ProgramSession.findOne({ institutionId, programId: program._id })) ||
      (await ProgramSession.create({ institutionId, programId: program._id, startYear: 2020, endYear: 2024, code: "SMK-2020" }));
    const enrollment =
      (await Enrollment.findOne({ institutionId, studentId: profile._id, programSessionId: batch._id })) ||
      (await Enrollment.create({ institutionId, studentId: profile._id, programSessionId: batch._id, programId: program._id }));
    return { ...body, enrollmentId: String(enrollment._id) };
  };

  const call = async (method, path, { token, body, institution, raw } = {}) => {
    if (!raw && method === "POST" && institution && body?.ipfsHash && (path === "/institution/credentials" || path.endsWith("/revise"))) {
      body = await prepareIssue(institution, path, body);
    }
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

  // A college's approving officials (their wallets): any 2 of 3 must approve recoveries and burns.
  const officials = () => [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((keypair) => keypair.publicKey.toBase58());
  const chainBody = (members = officials()) => ({ members, threshold: 2 });

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
    process.env.RATE_LIMIT_DISABLED = "true";
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
  });

  after(async () => {
    await AuditLog.deleteMany({ $or: [{ actorId: { $in: created.users } }, { institutionId: { $in: created.unis } }, { "details.email": /^smoke-/ }, { actorId: { $exists: false }, userAgent: "node" }] });
    await InstitutionMembership.deleteMany({ $or: [{ institutionId: { $in: created.unis } }, { userId: { $in: created.users } }] });
    await Credential.deleteMany({ institutionId: { $in: created.unis } });
    await StudentDetails.deleteMany({ institutionId: { $in: created.unis } });
    await Program.deleteMany({ institutionId: { $in: created.unis } });
    await ProgramSession.deleteMany({ institutionId: { $in: created.unis } });
    await AcademicSession.deleteMany({ institutionId: { $in: created.unis } });
    await Student.deleteMany({ institutionId: { $in: created.unis } });
    await Enrollment.deleteMany({ institutionId: { $in: created.unis } });
    await CredentialType.deleteMany({ institutionId: { $in: created.unis } });
    await Reports.deleteMany({ institutionId: { $in: created.unis } });
    await CollegeChain.deleteMany({ institutionId: { $in: created.unis } });
    await BillingEntry.deleteMany({ institutionId: { $in: created.unis } });
    await Nft.deleteMany({ institutionId: { $in: created.unis } });
    await CredentialRequest.deleteMany({ institutionId: { $in: created.unis } });
    await PinnedMetadata.deleteMany({ institutionId: { $in: created.unis } });
    // Test alerts must not throttle real alerts in this database.
    await mongoose.connection.collection("alertsents").deleteMany({ $or: [{ key: { $in: ["fee-payer-paused", "fee-payer-low", "mint-failed"] } }, { key: /^request-failed-/ }] });
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
      await call("POST", "/institution/credentials", { token: owner.token, institution, body: allocation(studentWallet) });
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
      const response = await call("POST", "/institution/credentials", {
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
      const forged = await call("POST", "/institution/credentials", {
        token: abcHead.token,
        institution: xyz,
        body: { ...allocation(student.wallet.address), institutionId: String(xyz._id) },
      });
      assert.equal(forged.status, 403);
      assert.equal(await Credential.countDocuments({ institutionId: xyz._id }), 0);
    });

    test("permissions come from the membership role at that college", async () => {
      const student = await makeUser("student");
      const abc = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const registrar = await addMember(abc, "registrar");
      const staff = await addMember(abc, "staff");

      // Both accounts have the plain student role; only the registrar membership grants credential:create at ABC.
      assert.equal((await call("POST", "/institution/credentials", { token: registrar.token, institution: abc, body: allocation(student.wallet.address) })).status, 201);
      assert.equal((await call("POST", "/institution/credentials", { token: staff.token, institution: abc, body: { ...allocation(student.wallet.address), ipfsHash: "QmOther" } })).status, 403);
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
      assert.ok(membership.roleId.permissions.includes("credential:create"));
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
      const issued = await call("POST", "/institution/credentials", {
        token: abcHead.token,
        institution: abc,
        body: allocation(victim.wallet.address),
      });
      assert.equal(issued.status, 201);
      const nft = await Credential.findOne({ institutionId: abc._id });
      return { abc, xyz, xyzHead, victim, attacker, nft };
    };

    test("XYZ's head cannot reach ABC through any college endpoint", async () => {
      const { abc, xyzHead } = await setup();
      for (const [method, path] of [
        ["GET", "/institution/profile"],
        ["GET", "/get-all-uploaded-data"],
        ["GET", "/get-reports"],
        ["POST", "/ipfs/pin-json"],
        ["POST", "/institution/credentials/111111111111111111111111/revise"],
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
        ["GET", `/student/credentials/next/${wallet}`],
        ["GET", `/student/credentials/minted/${wallet}`],
        ["POST", "/student/credentials/confirm", { walletAddress: wallet }],
        ["POST", "/student/credentials/claim", { walletAddress: wallet, credentialId: "111111111111111111111111", revision: 1 }],
        ["POST", "/student/credentials/report", { walletAddress: wallet, credentialId: "111111111111111111111111", reportType: "x", reportDetails: "y" }],
      ];
      for (const [method, path, body] of attempts) {
        const response = await call(method, path, { token: attacker.token, body });
        assert.equal(response.status, 403, `${method} ${path}`);
      }
    });

    test("a student cannot confirm another student's credential by its id", async () => {
      const { attacker, nft } = await setup();
      const byId = await call("POST", "/student/credentials/confirm", { token: attacker.token, body: { credentialId: String(nft._id) } });
      assert.equal(byId.status, 404);
      const injected = await call("POST", "/student/credentials/confirm", { token: attacker.token, body: { credentialId: { $ne: null } } });
      assert.equal(injected.status, 400);
      assert.equal((await Credential.findById(nft._id)).isConfirmed, false);
    });

    test("the owner can still confirm their own credential", async () => {
      const { victim, nft } = await setup();
      const response = await call("POST", "/student/credentials/confirm", {
        token: victim.token,
        body: { walletAddress: victim.wallet.address, credentialId: String(nft._id), revision: 1 },
      });
      assert.equal(response.status, 200);
      assert.equal((await Credential.findById(nft._id)).isConfirmed, true);
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
      await call("POST", "/institution/credentials", { token: head.token, institution: abc, body: allocation(student.wallet.address) });
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
      assert.ok(["sent", "console", "failed"].includes(rejected.body.emailDelivery), "the applicant is emailed the reason");
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
      const allocate = () => call("POST", "/institution/credentials", { token: registrar.token, institution: tenant.institution, body: allocation(student.wallet.address) });
      const patch = (id, body) => call("PATCH", `/institution/staff/${id}`, { token: tenant.head.token, institution: tenant.institution, body });

      assert.equal((await allocate()).status, 201);
      assert.equal((await patch(registrar.membership._id, { roleId: await roleId("staff") })).status, 200);
      assert.equal((await allocate()).status, 403, "Staff role has no credential:create");

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

  describe("college programs (P05-01)", () => {
    const addMember = async (institution, roleName) => {
      const member = await makeUser("student");
      const role = await Role.findOne({ name: roleName });
      await InstitutionMembership.create({ userId: member.user._id, institutionId: institution._id, roleId: role._id, status: "ACTIVE" });
      return member;
    };
    const create = (actor, institution, body) => call("POST", "/institution/programs", { token: actor.token, institution, body });

    before(() => Program.init()); // the unique index must exist before the duplicate checks

    test("ABC offers CSE and MBA; XYZ may also use CSE; ABC cannot add CSE twice", async () => {
      const abcHead = await makeUser("institution");
      const abc = await makeInstitution(abcHead, "VERIFIED");
      const xyzHead = await makeUser("institution");
      const xyz = await makeInstitution(xyzHead, "VERIFIED");

      const cse = await create(abcHead, abc, { code: "cse", name: "B.Tech Computer Science", description: "Four-year engineering degree" });
      assert.equal(cse.status, 201, JSON.stringify(cse.body));
      assert.equal(cse.body.program.code, "CSE");
      assert.equal(cse.body.program.status, "ACTIVE");
      assert.equal(cse.body.program.description, "Four-year engineering degree");
      // A colour is generated when none is given, and a chosen one is kept.
      assert.match(cse.body.program.color, /^#[0-9a-f]{6}$/i);
      const mba = await create(abcHead, abc, { code: "MBA", name: "Master of Business Administration", color: "#ef4444" });
      assert.equal(mba.status, 201, JSON.stringify(mba.body));
      assert.equal(mba.body.program.color, "#ef4444");
      assert.equal((await create(abcHead, abc, { code: " CSE ", name: "Duplicate" })).status, 409);
      assert.equal((await create(xyzHead, xyz, { code: "CSE", name: "XYZ Computer Science" })).status, 201);

      const list = await call("GET", "/institution/programs", { token: abcHead.token, institution: abc });
      assert.deepEqual(list.body.programs.map((p) => p.code), ["CSE", "MBA"]);
      assert.ok(await AuditLog.exists({ action: "institution.program.create", institutionId: abc._id, targetId: cse.body.program._id }));
    });

    test("the body cannot choose the college or change the code; input is validated", async () => {
      const head = await makeUser("institution");
      const abc = await makeInstitution(head, "VERIFIED");
      const xyz = await makeInstitution(await makeUser("institution"), "VERIFIED");

      const created = await create(head, abc, { code: "ECE", name: "Electronics", institutionId: String(xyz._id) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.program.institutionId, String(abc._id));

      for (const bad of [
        { code: "C S E", name: "x" },
        { code: "BBA" },
        { code: "BBA", name: "x", status: "DELETED" },
        { code: "BBA", name: "x", color: "red" },
        { code: "BBA", name: "x", color: "#12345" },
        { code: "BBA", name: "x", description: "x".repeat(501) },
      ]) {
        assert.equal((await create(head, abc, bad)).status, 400, JSON.stringify(bad));
      }

      const path = `/institution/programs/${created.body.program._id}`;
      assert.equal((await call("PATCH", path, { token: head.token, institution: abc, body: { code: "EEE" } })).status, 400);
      const updated = await call("PATCH", path, { token: head.token, institution: abc, body: { name: "Electronics & Comm.", status: "INACTIVE", color: "#0ea5e9", institutionId: String(xyz._id) } });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.program.color, "#0ea5e9");
      assert.equal(updated.body.program.status, "INACTIVE");
      assert.equal(updated.body.program.code, "ECE");
      assert.equal(updated.body.program.institutionId, String(abc._id));
      assert.ok(await AuditLog.exists({ action: "institution.program.update", institutionId: abc._id, "details.after.status": "INACTIVE" }));
    });

    test("staff only read; another college can neither read nor edit ABC's programs", async () => {
      const head = await makeUser("institution");
      const abc = await makeInstitution(head, "VERIFIED");
      const xyzHead = await makeUser("institution");
      const xyz = await makeInstitution(xyzHead, "VERIFIED");
      const program = (await create(head, abc, { code: "CSE", name: "Computer Science" })).body.program;
      const path = `/institution/programs/${program._id}`;

      for (const roleName of ["registrar", "staff"]) {
        const member = await addMember(abc, roleName);
        assert.equal((await call("GET", "/institution/programs", { token: member.token, institution: abc })).body.programs.length, 1);
        assert.equal((await create(member, abc, { code: "NEW", name: "x" })).status, 403);
        assert.equal((await call("PATCH", path, { token: member.token, institution: abc, body: { name: "x" } })).status, 403);
      }

      assert.equal((await call("GET", "/institution/programs", { token: xyzHead.token, institution: abc })).status, 403);
      assert.equal((await call("PATCH", path, { token: xyzHead.token, institution: xyz, body: { name: "Hijacked" } })).status, 404);
      assert.equal((await call("GET", "/institution/programs", { token: xyzHead.token, institution: xyz })).body.programs.length, 0);
      assert.equal((await Program.findById(program._id)).name, "Computer Science");
    });
  });

  describe("program sessions (P05-02)", () => {
    const path = "/institution/program-sessions";
    const tenant = async () => {
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      const program = (await call("POST", "/institution/programs", { token: head.token, institution, body: { code: "CSE", name: "Computer Science" } })).body.program;
      return { head, institution, program };
    };
    const add = ({ head, institution }, body) => call("POST", path, { token: head.token, institution, body });

    before(() => ProgramSession.init()); // the unique index must exist before the duplicate checks

    test("CSE 2022-2026 and 2023-2027 coexist; the exact cohort cannot be added twice; years are checked", async () => {
      const abc = await tenant();
      const first = await add(abc, { programId: abc.program._id, startYear: 2022, endYear: 2026 });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.session.status, "ACTIVE");
      assert.equal(first.body.session.institutionId, String(abc.institution._id));
      // Name, code and colour default from the program and years; a chosen one is kept.
      assert.deepEqual([first.body.session.code, first.body.session.name], ["CSE-2022", "CSE 2022–2026"]);
      assert.match(first.body.session.color, /^#[0-9a-f]{6}$/i);
      const custom = await add(abc, { programId: abc.program._id, startYear: 2023, endYear: 2027, status: "INACTIVE", code: "cse-b", name: "CSE Batch B", color: "#ef4444" });
      assert.equal(custom.status, 201, JSON.stringify(custom.body));
      assert.deepEqual([custom.body.session.code, custom.body.session.name, custom.body.session.color], ["CSE-B", "CSE Batch B", "#ef4444"]);
      assert.equal((await call("PATCH", `${path}/${custom.body.session._id}`, { token: abc.head.token, institution: abc.institution, body: { code: "X" } })).status, 400);
      assert.equal((await add(abc, { programId: abc.program._id, startYear: 2022, endYear: 2026 })).status, 409);

      for (const bad of [
        { startYear: 2026, endYear: 2022 },
        { startYear: 2022, endYear: 2022 },
        { startYear: 2022.5, endYear: 2026 },
        { startYear: 2022 },
        { startYear: 2024, endYear: 2028, status: "DONE" },
      ]) {
        assert.equal((await add(abc, { programId: abc.program._id, ...bad })).status, 400, JSON.stringify(bad));
      }
      assert.equal((await add(abc, { startYear: 2024, endYear: 2028 })).status, 400);
      assert.equal((await add(abc, { programId: { $ne: null }, startYear: 2024, endYear: 2028 })).status, 400);

      const list = await call("GET", `${path}?programId=${abc.program._id}`, { token: abc.head.token, institution: abc.institution });
      assert.deepEqual(list.body.sessions.map((s) => `${s.programId.code} ${s.startYear}-${s.endYear}`), ["CSE 2023-2027", "CSE 2022-2026"]);
      assert.ok(await AuditLog.exists({ action: "institution.programSession.create", institutionId: abc.institution._id }));

      // Another program at the same college may reuse the same years.
      const mba = (await call("POST", "/institution/programs", { token: abc.head.token, institution: abc.institution, body: { code: "MBA", name: "MBA" } })).body.program;
      assert.equal((await add(abc, { programId: mba._id, startYear: 2022, endYear: 2026 })).status, 201);
    });

    test("updates stay inside the program and college; staff only read", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      const session = (await add(abc, { programId: abc.program._id, startYear: 2022, endYear: 2026 })).body.session;
      await add(abc, { programId: abc.program._id, startYear: 2023, endYear: 2027 });
      const sessionPath = `${path}/${session._id}`;
      const patch = (actor, institution, body) => call("PATCH", sessionPath, { token: actor.token, institution, body });

      // XYZ cannot use ABC's program, nor touch ABC's session.
      assert.equal((await add(xyz, { programId: abc.program._id, startYear: 2022, endYear: 2026 })).status, 404);
      assert.equal((await patch(xyz.head, xyz.institution, { status: "INACTIVE" })).status, 404);
      assert.equal((await call("GET", path, { token: xyz.head.token, institution: xyz.institution })).body.sessions.length, 0);

      assert.equal((await patch(abc.head, abc.institution, { programId: xyz.program._id })).status, 400);
      assert.equal((await patch(abc.head, abc.institution, { startYear: 2023, endYear: 2027 })).status, 409);
      const closed = await patch(abc.head, abc.institution, { status: "INACTIVE", institutionId: String(xyz.institution._id) });
      assert.equal(closed.status, 200, JSON.stringify(closed.body));
      assert.equal(closed.body.session.status, "INACTIVE");
      assert.equal(closed.body.session.institutionId, String(abc.institution._id));
      assert.ok(await AuditLog.exists({ action: "institution.programSession.update", targetId: session._id, "details.after.status": "INACTIVE" }));

      const staff = await makeUser("student");
      await InstitutionMembership.create({ userId: staff.user._id, institutionId: abc.institution._id, roleId: (await Role.findOne({ name: "staff" }))._id, status: "ACTIVE" });
      assert.equal((await call("GET", path, { token: staff.token, institution: abc.institution })).body.sessions.length, 2);
      assert.equal((await call("POST", path, { token: staff.token, institution: abc.institution, body: { programId: abc.program._id, startYear: 2030, endYear: 2034 } })).status, 403);
      assert.equal((await patch(staff, abc.institution, { status: "ACTIVE" })).status, 403);
    });
  });

  describe("academic sessions and program intakes (P05-02 owner revision)", () => {
    const tenant = async () => {
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution, body });
      const program = (await as("POST", "/institution/programs", { code: "CSE", name: "Computer Science" })).body.program;
      return { head, institution, program, as };
    };

    before(() => Promise.all([AcademicSession.init(), ProgramSession.init()]));

    test("a college keeps its own academic sessions; years are checked; duplicates refused", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      const created = await abc.as("POST", "/institution/academic-sessions", { startYear: 2024, endYear: 2025 });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.academicSession.institutionId, String(abc.institution._id));
      assert.equal((await abc.as("POST", "/institution/academic-sessions", { startYear: 2023, endYear: 2023 })).status, 201); // calendar year
      assert.equal((await abc.as("POST", "/institution/academic-sessions", { startYear: 2024, endYear: 2025 })).status, 409);
      for (const bad of [{ startYear: 2025, endYear: 2027 }, { startYear: 2025, endYear: 2024 }, { startYear: 2025 }]) {
        assert.equal((await abc.as("POST", "/institution/academic-sessions", bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await xyz.as("POST", "/institution/academic-sessions", { startYear: 2024, endYear: 2025 })).status, 201);

      const list = await abc.as("GET", "/institution/academic-sessions");
      assert.deepEqual(list.body.academicSessions.map((s) => `${s.startYear}-${s.endYear}`), ["2024-2025", "2023-2023"]);
      // Academic years are never deleted, only set inactive.
      assert.equal((await xyz.as("DELETE", `/institution/academic-sessions/${created.body.academicSession._id}`)).status, 404);
      assert.equal((await xyz.as("PATCH", `/institution/academic-sessions/${created.body.academicSession._id}`, { isActive: false })).status, 404);

      const staff = await makeUser("student");
      await InstitutionMembership.create({ userId: staff.user._id, institutionId: abc.institution._id, roleId: (await Role.findOne({ name: "staff" }))._id, status: "ACTIVE" });
      assert.equal((await call("GET", "/institution/academic-sessions", { token: staff.token, institution: abc.institution })).status, 200);
      assert.equal((await call("POST", "/institution/academic-sessions", { token: staff.token, institution: abc.institution, body: { startYear: 2030, endYear: 2031 } })).status, 403);
    });

    test("an intake becomes a batch starting in the session's year; nothing is deleted, only set inactive", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      const session = (await abc.as("POST", "/institution/academic-sessions", { startYear: 2024, endYear: 2025 })).body.academicSession;
      const xyzSession = (await xyz.as("POST", "/institution/academic-sessions", { startYear: 2024, endYear: 2025 })).body.academicSession;

      // The body's startYear is ignored: the intake's year wins.
      const batch = await abc.as("POST", "/institution/program-sessions", { programId: abc.program._id, academicSessionId: session._id, startYear: 1999, endYear: 2028 });
      assert.equal(batch.status, 201, JSON.stringify(batch.body));
      assert.deepEqual([batch.body.session.startYear, batch.body.session.endYear, batch.body.session.academicSessionId], [2024, 2028, session._id]);
      assert.equal((await abc.as("POST", "/institution/program-sessions", { programId: abc.program._id, academicSessionId: session._id, endYear: 2029 })).status, 409);
      assert.equal((await abc.as("POST", "/institution/program-sessions", { programId: abc.program._id, academicSessionId: xyzSession._id, endYear: 2028 })).status, 404);
      assert.equal((await abc.as("POST", "/institution/program-sessions", { programId: abc.program._id, academicSessionId: { $ne: null }, endYear: 2028 })).status, 400);

      const batchPath = `/institution/program-sessions/${batch.body.session._id}`;
      assert.equal((await abc.as("PATCH", batchPath, { startYear: 2025 })).status, 400);
      assert.equal((await abc.as("PATCH", batchPath, { endYear: 2029 })).body.session.endYear, 2029);
      assert.equal((await abc.as("GET", "/institution/academic-sessions")).body.academicSessions[0].batchCount, 1);

      // Nothing is deleted: batches and academic years are set inactive instead, and inactive years take no new batches.
      const sessionPath = `/institution/academic-sessions/${session._id}`;
      assert.equal((await abc.as("DELETE", sessionPath)).status, 404);
      assert.equal((await abc.as("DELETE", batchPath)).status, 404);
      assert.equal((await abc.as("PATCH", batchPath, { status: "INACTIVE" })).body.session.status, "INACTIVE");
      assert.equal((await abc.as("PATCH", sessionPath, { isActive: false })).status, 200);
      assert.equal(await ProgramSession.countDocuments({ _id: batch.body.session._id }), 1);
      const inactiveYear = await abc.as("POST", "/institution/program-sessions", { programId: abc.program._id, academicSessionId: session._id, endYear: 2028 });
      assert.equal(inactiveYear.status, 409);
      assert.match(JSON.stringify(inactiveYear.body), /inactive/i);
    });
  });

  describe("college-made roles", () => {
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
    let seq = 0;
    const email = () => `smoke-cr-${tag}-${(seq += 1)}@example.test`;
    const tenant = async () => {
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution, body });
      return { head, institution, as };
    };

    after(async () => {
      const users = await User.find({ email: new RegExp(`^smoke-cr-${tag}`) }).select("_id");
      await InstitutionMembership.deleteMany({ userId: { $in: users.map((u) => u._id) } });
      await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
      await Role.deleteMany({ institutionId: { $in: created.unis } });
    });

    test("a college makes its own role, assigns it, and permission changes apply at once", async () => {
      const abc = await tenant();
      const role = await abc.as("POST", "/institution/roles", { displayName: "Exam Cell", permissions: ["program:read", "credential:read"] });
      assert.equal(role.status, 201, JSON.stringify(role.body));
      assert.equal(role.body.role.shared, false);

      const list = await abc.as("GET", "/institution/roles");
      assert.ok(list.body.roles.some((r) => r.displayName === "Registrar" && r.shared));
      assert.ok(list.body.permissionGroups.every((g) => g.permissions.every((p) => !["platform:manage", "staff:invite", "staff:manage", "role:manage"].includes(p.key))));

      // Offered on the Staff page and assignable there.
      assert.ok((await abc.as("GET", "/institution/staff")).body.roles.some((r) => r._id === role.body.role._id));
      const invited = await abc.as("POST", "/institution/staff", { email: email(), name: "Exam Clerk", roleId: role.body.role._id });
      assert.equal(invited.status, 201, JSON.stringify(invited.body));
      await call("POST", `/auth/activate/${invited.body.activationUrl.split("/").pop()}`);
      const clerk = signToken(await User.findById(invited.body.membership.userId).populate("roleId"));
      const asClerk = (path) => call("GET", path, { token: clerk, institution: abc.institution });
      assert.equal((await asClerk("/institution/programs")).status, 200);

      // Removing a permission takes effect on the very next request.
      assert.equal((await abc.as("PATCH", `/institution/roles/${role.body.role._id}`, { permissions: ["credential:read"] })).status, 200);
      assert.equal((await asClerk("/institution/programs")).status, 403);
      assert.ok(await AuditLog.exists({ action: "institution.role.update", institutionId: abc.institution._id }));

      // An inactive role revokes its members' access at once (code ACCESS_REVOKED); active again restores it. Nothing is deleted.
      const rolePath = `/institution/roles/${role.body.role._id}`;
      assert.equal((await abc.as("PATCH", rolePath, { permissions: ["program:read"] })).status, 200);
      assert.equal((await asClerk("/institution/programs")).status, 200);
      assert.equal((await abc.as("PATCH", rolePath, { isActive: false })).status, 200);
      const revoked = await asClerk("/institution/programs");
      assert.equal(revoked.status, 403);
      assert.equal(revoked.body.code, "ACCESS_REVOKED");
      assert.equal((await abc.as("PATCH", rolePath, { isActive: true })).status, 200);
      assert.equal((await asClerk("/institution/programs")).status, 200);
      assert.equal((await abc.as("DELETE", rolePath)).status, 404);
    });

    test("guard rails: college permissions only, no admin powers, own roles only, no clashes", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      for (const permissions of [["platform:manage"], ["staff:invite"], ["staff:manage"], ["role:manage"], ["*"], ["credential:confirm"], ["made:up"]]) {
        assert.equal((await abc.as("POST", "/institution/roles", { displayName: "Bad", permissions })).status, 400, permissions[0]);
      }
      assert.equal((await abc.as("POST", "/institution/roles", { displayName: "registrar", permissions: [] })).status, 409);

      const own = (await abc.as("POST", "/institution/roles", { displayName: "Accounts", permissions: ["report:read"] })).body.role;
      assert.equal((await abc.as("POST", "/institution/roles", { displayName: "ACCOUNTS", permissions: [] })).status, 409);
      // XYZ may reuse the name, but cannot see, edit or assign ABC's role.
      assert.equal((await xyz.as("POST", "/institution/roles", { displayName: "Accounts", permissions: [] })).status, 201);
      assert.ok(!(await xyz.as("GET", "/institution/roles")).body.roles.some((r) => r._id === own._id));
      assert.equal((await xyz.as("PATCH", `/institution/roles/${own._id}`, { displayName: "Hijacked" })).status, 404);
      assert.equal((await xyz.as("POST", "/institution/staff", { email: email(), name: "X", roleId: own._id })).status, 400);
      const stranger = await makeUser("student");
      await assert.rejects(
        InstitutionMembership.create({ userId: stranger.user._id, institutionId: xyz.institution._id, roleId: own._id, status: "ACTIVE" }),
        /another college/
      );

      // Shared roles are read-only for a college.
      const registrar = await Role.findOne({ name: "registrar" });
      assert.equal((await abc.as("PATCH", `/institution/roles/${registrar._id}`, { permissions: [] })).status, 403);
      assert.deepEqual((await Role.findById(registrar._id)).permissions, registrar.permissions);

      // Only people with role:manage (the head) may use these endpoints.
      const staff = await makeUser("student");
      await InstitutionMembership.create({ userId: staff.user._id, institutionId: abc.institution._id, roleId: registrar._id, status: "ACTIVE" });
      assert.equal((await call("GET", "/institution/roles", { token: staff.token, institution: abc.institution })).status, 403);

      // Nothing is deleted: a role is set inactive and stays in the list.
      assert.equal((await abc.as("PATCH", `/institution/roles/${own._id}`, { isActive: "no" })).status, 400);
      assert.equal((await abc.as("PATCH", `/institution/roles/${own._id}`, { isActive: false })).status, 200);
      assert.equal((await abc.as("GET", "/institution/roles")).body.roles.find((r) => r._id === own._id).isActive, false);
      assert.equal((await abc.as("DELETE", `/institution/roles/${own._id}`)).status, 404);
      assert.equal(await Role.countDocuments({ _id: own._id }), 1);
    });
  });

  describe("college student profiles (P05-03)", () => {
    const tenant = async () => {
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution, body });
      return { head, institution, as };
    };

    before(() => Student.init()); // the unique index must exist before the duplicate checks

    test("one profile per student; registration no. unique per college; fields validated", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      const rahul = await abc.as("POST", "/institution/students", { fullName: "Rahul Sharma", registrationNo: " bcet/2022/0142 ", email: "Rahul@Example.com", phone: "+91 98765 43210", institutionId: String(xyz.institution._id) });
      assert.equal(rahul.status, 201, JSON.stringify(rahul.body));
      assert.deepEqual(
        [rahul.body.student.registrationNo, rahul.body.student.email, rahul.body.student.studentStatus, rahul.body.student.institutionId],
        ["BCET/2022/0142", "rahul@example.com", "ACTIVE", String(abc.institution._id)]
      );
      assert.equal((await abc.as("POST", "/institution/students", { fullName: "Other", registrationNo: "BCET/2022/0142", email: "other@example.com" })).status, 409);
      assert.equal((await xyz.as("POST", "/institution/students", { fullName: "Same no. elsewhere", registrationNo: "BCET/2022/0142", email: "same@example.com" })).status, 201);
      // The registration number is optional: many students may leave it empty without clashing.
      assert.equal((await abc.as("POST", "/institution/students", { fullName: "No Reg A", registrationNo: "", email: "a@example.com" })).status, 201);
      assert.equal((await abc.as("POST", "/institution/students", { fullName: "No Reg B", email: "b@example.com" })).status, 201);
      // The email is required (the wallet invite goes there), and a wallet hint must be a real address.
      for (const bad of [
        {},
        { fullName: "x" },
        { fullName: "x", email: "not-an-email" },
        { fullName: "x", email: "x@example.com", phone: "abc" },
        { fullName: "x", email: "x@example.com", studentStatus: "GONE" },
        { fullName: "x", email: "x@example.com", walletHint: "not-a-wallet" },
      ]) {
        assert.equal((await abc.as("POST", "/institution/students", bad)).status, 400, JSON.stringify(bad));
      }

      const list = await abc.as("GET", "/institution/students?search=bcet/2022");
      assert.deepEqual(list.body.students.map((s) => s.fullName), ["Rahul Sharma"]);
      assert.deepEqual(list.body.stats, { total: 3, active: 3, inactive: 0 });

      // Editing clears a field and changes status; the activity log keeps no email or phone.
      const path = `/institution/students/${rahul.body.student._id}`;
      const edited = await abc.as("PATCH", path, { phone: "", studentStatus: "INACTIVE" });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.student.phone, undefined);
      assert.equal((await abc.as("PATCH", path, { email: "" })).status, 400); // the email can change but not be cleared
      const entry = await AuditLog.findOne({ action: "institution.student.create", targetId: rahul.body.student._id }).lean();
      assert.ok(entry && !JSON.stringify(entry.details).includes("example.com") && !JSON.stringify(entry.details).includes("98765"));
    });

    test("the college invites a student, who proves a wallet to link their profile", async () => {
      const abc = await tenant();
      const hint = Keypair.generate().publicKey.toBase58();
      const added = await abc.as("POST", "/institution/students", { fullName: "Claire", registrationNo: "C-1", email: `claire-${Date.now().toString(36)}@example.com`, walletHint: hint });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const student = added.body.student;
      assert.equal(student.walletHint, hint);

      const invite = await abc.as("POST", `/institution/students/${student._id}/invite`);
      assert.equal(invite.status, 200, JSON.stringify(invite.body));
      const token = invite.body.claimUrl.split("/").pop();
      const row = (await abc.as("GET", "/institution/students")).body.students.find((s) => s._id === student._id);
      assert.equal(row.claimStatus, "INVITED");
      assert.equal(row.inviteTokenHash, undefined); // only the hash is stored, and never sent out

      // The public page data, and a bad link.
      const page = await call("GET", `/auth/student-invite/${token}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.deepEqual([page.body.invite.studentName, page.body.invite.walletHint], ["Claire", hint]);
      assert.equal((await call("GET", "/auth/student-invite/not-a-real-token")).status, 400);

      // A forged signature fails; the wallet's real key links the profile and signs the student in.
      const keypair = Keypair.generate();
      const walletAddress = keypair.publicKey.toBase58();
      const nonce = await call("POST", "/auth/nonce", { body: { walletAddress } });
      const forged = await call("POST", `/auth/student-invite/${token}/claim`, { body: { walletAddress, signature: Buffer.alloc(64).toString("base64") } });
      assert.equal(forged.status, 401);
      const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce.body.message), keypair.secretKey)).toString("base64");
      const claimed = await call("POST", `/auth/student-invite/${token}/claim`, { body: { walletAddress, signature } });
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.ok(claimed.body.token);
      created.users.push(claimed.body.user._id);
      const wallet = await Wallet.findOne({ address: walletAddress });
      created.wallets.push(wallet._id);
      assert.equal(wallet.isVerified, true);

      // Linked, showing the wallet they proved (which differs from the college's hint here).
      const linked = (await abc.as("GET", "/institution/students")).body.students.find((s) => s._id === student._id);
      assert.deepEqual([linked.claimStatus, linked.wallet, linked.walletMismatch], ["LINKED", walletAddress, true]);
      assert.ok(await AuditLog.exists({ action: "student.claim", institutionId: abc.institution._id }));

      // The link works once, and a linked student cannot be invited again.
      assert.equal((await call("GET", `/auth/student-invite/${token}`)).status, 400);
      assert.equal((await abc.as("POST", `/institution/students/${student._id}/invite`)).status, 409);
    });

    test("bulk import saves good rows and reports the rest by row number", async () => {
      const abc = await tenant();
      await abc.as("POST", "/institution/students", { fullName: "Already here", registrationNo: "R-1", email: "here@example.com" });
      const result = await abc.as("POST", "/institution/students/import", {
        students: [
          { row: 2, fullName: "Asha", registrationNo: "r-2", email: "asha@example.com" },
          { row: 3, fullName: "Bina", registrationNo: "R-1", email: "bina@example.com" }, // used in the college
          { row: 4, fullName: "", registrationNo: "R-3", email: "x@example.com" }, // no name
          { row: 5, fullName: "Chetan", registrationNo: "R-2", email: "chetan@example.com" }, // repeats row 2 (case-insensitive)
          { row: 6, fullName: "Divya", email: "bad" },
          { row: 7, fullName: "Esha", email: "esha@example.com", studentStatus: "INACTIVE", institutionId: "000000000000000000000000" },
          { row: 8, fullName: "Farah" }, // no email
        ],
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.created, 2);
      assert.deepEqual(result.body.failed.map((f) => f.row), [3, 4, 5, 6, 8]);
      assert.match(result.body.failed.find((f) => f.row === 5).message, /also on row 2/);
      const saved = await Student.find({ institutionId: abc.institution._id }).sort({ fullName: 1 }).lean();
      assert.deepEqual(saved.map((s) => s.fullName), ["Already here", "Asha", "Esha"]);
      assert.ok(await AuditLog.exists({ action: "institution.student.import", institutionId: abc.institution._id, "details.created": 2 }));

      assert.equal((await abc.as("POST", "/institution/students/import", { students: [] })).status, 400);
      assert.equal((await abc.as("POST", "/institution/students/import", { students: Array.from({ length: 501 }, () => ({ fullName: "x", email: "x@example.com" })) })).status, 400);
    });

    test("profiles stay inside the college; staff can only read", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      const student = (await abc.as("POST", "/institution/students", { fullName: "Rahul Sharma", email: "rahul@example.com" })).body.student;
      assert.equal((await xyz.as("PATCH", `/institution/students/${student._id}`, { fullName: "Hijacked" })).status, 404);
      assert.equal((await xyz.as("POST", `/institution/students/${student._id}/invite`)).status, 404);
      assert.equal((await xyz.as("GET", "/institution/students")).body.students.length, 0);

      const add = async (roleName) => {
        const member = await makeUser("student");
        await InstitutionMembership.create({ userId: member.user._id, institutionId: abc.institution._id, roleId: (await Role.findOne({ name: roleName }))._id, status: "ACTIVE" });
        return (method, path, body) => call(method, path, { token: member.token, institution: abc.institution, body });
      };
      const staff = await add("staff");
      assert.equal((await staff("GET", "/institution/students")).body.students.length, 1);
      assert.equal((await staff("POST", "/institution/students", { fullName: "x", email: "x@example.com" })).status, 403);
      assert.equal((await staff("PATCH", `/institution/students/${student._id}`, { fullName: "x" })).status, 403);
      assert.equal((await staff("POST", `/institution/students/${student._id}/invite`)).status, 403);
      const registrar = await add("registrar");
      assert.equal((await registrar("POST", "/institution/students", { fullName: "Added by registrar", email: "reg@example.com" })).status, 201);
      assert.equal((await Student.findById(student._id)).fullName, "Rahul Sharma");
    });
  });

  describe("enrollments (P05-04/P05-05)", () => {
    // A college with CSE and MBA, one batch each, and Rahul's single profile.
    const tenant = async () => {
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution, body });
      const program = async (code) => (await as("POST", "/institution/programs", { code, name: code })).body.program;
      const batch = async (programId, startYear, endYear) =>
        (await as("POST", "/institution/program-sessions", { programId, startYear, endYear })).body.session;
      const cse = await program("CSE");
      const mba = await program("MBA");
      const cse22 = await batch(cse._id, 2022, 2026);
      const mba27 = await batch(mba._id, 2027, 2029);
      const rahul = (await as("POST", "/institution/students", { fullName: "Rahul Sharma", registrationNo: "R-1", email: "rahul@example.com" })).body.student;
      return { head, institution, as, cse, mba, cse22, mba27, rahul };
    };

    before(() => Enrollment.init());

    test("one profile, two courses: Rahul in CSE 2022-2026 and MBA 2027-2029; codes optional, official no. null", async () => {
      const abc = await tenant();
      const first = await abc.as("POST", "/institution/enrollments", { studentId: abc.rahul._id, programSessionId: abc.cse22._id });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.enrollment.status, "ENROLLED");
      assert.equal(first.body.enrollment.officialEnrollmentNo, null);
      assert.equal(first.body.enrollment.enrollmentCode, undefined); // no generator (P05-05)
      assert.equal(first.body.enrollment.programId.code, "CSE");
      const second = await abc.as("POST", "/institution/enrollments", { studentId: abc.rahul._id, programSessionId: abc.mba27._id, enrollmentCode: "abc-mba-2027-0001" });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.enrollment.enrollmentCode, "ABC-MBA-2027-0001");
      assert.equal(await Student.countDocuments({ institutionId: abc.institution._id }), 1);

      assert.equal((await abc.as("POST", "/institution/enrollments", { studentId: abc.rahul._id, programSessionId: abc.cse22._id })).status, 409);
      const priya = (await abc.as("POST", "/institution/students", { fullName: "Priya", email: "priya@example.com" })).body.student;
      const clash = await abc.as("POST", "/institution/enrollments", { studentId: priya._id, programSessionId: abc.cse22._id, enrollmentCode: "ABC-MBA-2027-0001" });
      assert.equal(clash.status, 409);
      assert.match(clash.body.message, /enrollment code/);

      const list = await abc.as("GET", `/institution/enrollments?studentIds=${abc.rahul._id}`);
      assert.deepEqual(list.body.enrollments.map((e) => `${e.programId.code} ${e.programSessionId.startYear}-${e.programSessionId.endYear}`).sort(), ["CSE 2022-2026", "MBA 2027-2029"]);
      assert.equal((await abc.as("GET", "/institution/enrollments?search=rahul")).body.pagination.total, 2);

      // Status and codes change; student and batch never do.
      const path = `/institution/enrollments/${first.body.enrollment._id}`;
      assert.equal((await abc.as("PATCH", path, { status: "COMPLETED", officialEnrollmentNo: "WBUT/2022/7788" })).body.enrollment.status, "COMPLETED");
      assert.equal((await abc.as("PATCH", path, { programSessionId: abc.mba27._id })).status, 400);
      assert.equal((await abc.as("PATCH", path, { status: "GRADUATED" })).status, 400);
      assert.ok(await AuditLog.exists({ action: "institution.enrollment.update", institutionId: abc.institution._id }));

      // Once students are enrolled, the batch's years are locked; it can still be set inactive, and can never be deleted.
      assert.equal((await abc.as("PATCH", `/institution/program-sessions/${abc.cse22._id}`, { endYear: 2027 })).status, 409);
      assert.equal((await abc.as("PATCH", `/institution/program-sessions/${abc.cse22._id}`, { status: "INACTIVE" })).status, 200);
      assert.equal((await abc.as("DELETE", `/institution/program-sessions/${abc.cse22._id}`)).status, 404);
    });

    test("guessed ids from another college are rejected (P05-07); staff can only read", async () => {
      const abc = await tenant();
      const xyz = await tenant();
      assert.equal((await abc.as("POST", "/institution/enrollments", { studentId: xyz.rahul._id, programSessionId: abc.cse22._id })).status, 404);
      assert.equal((await abc.as("POST", "/institution/enrollments", { studentId: abc.rahul._id, programSessionId: xyz.cse22._id })).status, 404);
      assert.equal((await abc.as("POST", "/institution/enrollments", { studentId: { $ne: null }, programSessionId: abc.cse22._id })).status, 400);
      const own = (await xyz.as("POST", "/institution/enrollments", { studentId: xyz.rahul._id, programSessionId: xyz.cse22._id })).body.enrollment;
      assert.equal((await abc.as("PATCH", `/institution/enrollments/${own._id}`, { status: "CANCELLED" })).status, 404);
      assert.equal((await abc.as("GET", "/institution/enrollments")).body.enrollments.length, 0);

      const staff = await makeUser("student");
      await InstitutionMembership.create({ userId: staff.user._id, institutionId: abc.institution._id, roleId: (await Role.findOne({ name: "staff" }))._id, status: "ACTIVE" });
      const asStaff = (method, path, body) => call(method, path, { token: staff.token, institution: abc.institution, body });
      assert.equal((await asStaff("GET", "/institution/enrollments")).status, 200);
      assert.equal((await asStaff("POST", "/institution/enrollments", { studentId: abc.rahul._id, programSessionId: abc.cse22._id })).status, 403);
    });

    test("Excel import finds students by registration no. and batches by program code + start year", async () => {
      const abc = await tenant();
      const as = abc.as;
      await as("POST", "/institution/students", { fullName: "Asha", registrationNo: "R-2", email: "asha@example.com" });
      // A second CSE batch starting in 2022 (lateral entry) makes "CSE 2022" ambiguous without an end year.
      await as("POST", "/institution/program-sessions", { programId: abc.cse._id, startYear: 2022, endYear: 2025 });
      const result = await as("POST", "/institution/enrollments/import", {
        enrollments: [
          { row: 2, registrationNo: "r-1", programCode: "mba", startYear: "2027" },
          { row: 3, registrationNo: "R-2", programCode: "CSE", startYear: "2022" }, // ambiguous
          { row: 4, registrationNo: "R-2", programCode: "CSE", startYear: "2022", endYear: "2026", enrollmentCode: "C-1" },
          { row: 5, registrationNo: "R-9", programCode: "CSE", startYear: "2022", endYear: "2026" }, // unknown student
          { row: 6, registrationNo: "R-1", programCode: "BBA", startYear: "2022" }, // unknown program
          { row: 7, registrationNo: "R-1", programCode: "MBA", startYear: "2027" }, // repeats row 2
          { row: 8, registrationNo: "R-1", programCode: "CSE", startYear: "2022", endYear: "2026", status: "Dropped" },
        ],
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.created, 2);
      assert.deepEqual(result.body.failed.map((f) => f.row), [3, 5, 6, 7, 8]);
      assert.match(result.body.failed[0].message, /several batches/);
      assert.match(result.body.failed.find((f) => f.row === 7).message, /row 2/);
      // Importing the same rows again: already enrolled.
      const again = await as("POST", "/institution/enrollments/import", { enrollments: [{ row: 2, registrationNo: "R-1", programCode: "MBA", startYear: 2027 }] });
      assert.deepEqual([again.body.created, again.body.failed[0]?.message], [0, "This student is already enrolled in that batch"]);
    });
  });

  describe("credential types (P06-02)", () => {
    test("each college keeps its own master list; only an Active type can be issued; one enrollment holds several credentials", async () => {
      const head = await makeUser("institution");
      const abc = await makeInstitution(head, "VERIFIED");
      const otherHead = await makeUser("institution");
      const xyz = await makeInstitution(otherHead, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution: abc, body });

      // A new college starts with the usual types, then the list is its own.
      const list = await as("GET", "/institution/credential-types");
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.ok(list.body.credentialTypes.some((type) => type.code === "DEGREE"));

      const created = await as("POST", "/institution/credential-types", { code: "bonafide", name: "Bonafide letter" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.credentialType.code, "BONAFIDE");
      assert.match(created.body.credentialType.color, /^#[0-9a-f]{6}$/i);
      assert.equal((await as("POST", "/institution/credential-types", { code: "BONAFIDE", name: "Again" })).status, 409);
      assert.equal((await as("PATCH", `/institution/credential-types/${created.body.credentialType._id}`, { code: "X" })).status, 400);
      // The same code in another college is fine, and lists never cross.
      assert.equal((await call("POST", "/institution/credential-types", { token: otherHead.token, institution: xyz, body: { code: "BONAFIDE", name: "XYZ bonafide" } })).status, 201);
      assert.equal((await as("GET", "/institution/credential-types")).body.credentialTypes.filter((type) => type.code === "BONAFIDE").length, 1);

      // Issue two credential types for one enrollment: allowed. Inactive or unknown types: refused.
      const program = (await as("POST", "/institution/programs", { code: "CSE", name: "CSE" })).body.program;
      const batch = (await as("POST", "/institution/program-sessions", { programId: program._id, startYear: 2022, endYear: 2026 })).body.session;
      const rahul = (await as("POST", "/institution/students", { fullName: "Rahul", email: "rahul@example.com" })).body.student;
      const enrollment = (await as("POST", "/institution/enrollments", { studentId: rahul._id, programSessionId: batch._id })).body.enrollment;
      const student = await makeUser("student");
      await Student.updateOne({ _id: rahul._id }, { userId: student.user._id }); // the student has linked their wallet
      const issue = (credentialType, ipfsHash) => as("POST", "/institution/credentials", { ...allocation(student.wallet.address), ipfsHash, enrollmentId: enrollment._id, credentialType });
      assert.equal((await issue("DEGREE", "QmDeg")).status, 201);
      assert.equal((await issue("provisional", "QmProv")).status, 201);
      assert.equal(await Credential.countDocuments({ enrollmentId: enrollment._id }), 2);
      assert.equal((await issue("NOPE", "QmNope")).status, 400);
      await as("PATCH", `/institution/credential-types/${created.body.credentialType._id}`, { status: "INACTIVE" });
      assert.equal((await issue("BONAFIDE", "QmBon")).status, 400);
    });
  });

  describe("college activity log", () => {
    test("a college sees only its own history, without IP or browser; needs audit:read", async () => {
      const abcHead = await makeUser("institution");
      const abc = await makeInstitution(abcHead, "VERIFIED");
      const xyzHead = await makeUser("institution");
      const xyz = await makeInstitution(xyzHead, "VERIFIED");
      await call("POST", "/institution/programs", { token: abcHead.token, institution: abc, body: { code: "ABCLOG", name: "ABC only" } });
      await call("POST", "/institution/programs", { token: xyzHead.token, institution: xyz, body: { code: "XYZLOG", name: "XYZ only" } });

      // institutionId in the query cannot widen the view to another college.
      const log = await call("GET", `/institution/activity?institutionId=${xyz._id}&limit=100`, { token: abcHead.token, institution: abc });
      assert.equal(log.status, 200, JSON.stringify(log.body));
      assert.ok(log.body.logs.length > 0);
      assert.ok(log.body.logs.every((entry) => entry.institutionId?._id === String(abc._id)));
      assert.ok(log.body.logs.some((entry) => entry.summary === "Created program ABCLOG"));
      assert.ok(log.body.logs.every((entry) => !("ip" in entry) && !("userAgent" in entry)));
      assert.equal(log.body.stats.total, await AuditLog.countDocuments({ institutionId: abc._id }));

      const registrar = await makeUser("student");
      await InstitutionMembership.create({ userId: registrar.user._id, institutionId: abc._id, roleId: (await Role.findOne({ name: "registrar" }))._id, status: "ACTIVE" });
      assert.equal((await call("GET", "/institution/activity", { token: registrar.token, institution: abc })).status, 403);

      // The Super Admin's log still has IPs and can be filtered by college.
      const admin = await makeUser("admin");
      const platform = await call("GET", `/admin/audit-logs?institutionId=${xyz._id}`, { token: admin.token });
      assert.ok(platform.body.logs.every((entry) => entry.institutionId?._id === String(xyz._id)));
      assert.ok(platform.body.logs.some((entry) => "ip" in entry));
    });
  });

  describe("admin users by college", () => {
    test("the global user list shows each user's colleges and can be narrowed to one college", async () => {
      const admin = await makeUser("admin");
      const abcHead = await makeUser("institution");
      const abc = await makeInstitution(abcHead, "VERIFIED");
      const xyz = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const both = await makeUser("student");
      const staffRole = await Role.findOne({ name: "staff" });
      await InstitutionMembership.create({ userId: both.user._id, institutionId: abc._id, roleId: staffRole._id, status: "ACTIVE" });
      await InstitutionMembership.create({ userId: both.user._id, institutionId: xyz._id, roleId: staffRole._id, status: "INVITED" });

      const list = await call("GET", `/admin/users?institutionId=${abc._id}&limit=100`, { token: admin.token });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const ids = list.body.users.map((user) => user._id);
      assert.deepEqual(ids.sort(), [String(abcHead.user._id), String(both.user._id)].sort());
      const row = list.body.users.find((user) => user._id === String(both.user._id));
      assert.deepEqual(
        row.memberships.map((m) => `${m.institution._id === String(abc._id) ? "ABC" : "XYZ"} ${m.role.displayName} ${m.status}`).sort(),
        ["ABC Staff ACTIVE", "XYZ Staff INVITED"]
      );

      assert.equal((await call("GET", "/admin/users?institutionId=nope", { token: admin.token })).status, 400);
      assert.equal((await call("GET", `/admin/users?institutionId=${abc._id}`, { token: abcHead.token })).status, 403);
    });
  });

  describe("platform SMTP settings", () => {
    let saved;

    // The settings document is shared with the real dev setup: keep it and put it back.
    before(async () => {
      saved = await PlatformSetting.collection.findOne({ key: "platform" });
    });

    after(async () => {
      await PlatformSetting.collection.deleteOne({ key: "platform" });
      if (saved) await PlatformSetting.collection.insertOne(saved);
    });

    const valid = { enabled: false, host: "127.0.0.1", port: 2525, secure: false, username: "smoke", fromName: "Smoke", fromEmail: "smoke-smtp@example.test" };

    test("only platform admins can read or change SMTP settings", async () => {
      const staff = await makeUser("institution");
      assert.equal((await call("GET", "/admin/settings/smtp", { token: staff.token })).status, 403);
      assert.equal((await call("PUT", "/admin/settings/smtp", { token: staff.token, body: valid })).status, 403);
    });

    test("input is validated", async () => {
      const admin = await makeUser("admin");
      const put = (body) => call("PUT", "/admin/settings/smtp", { token: admin.token, body: { ...valid, ...body } });
      assert.equal((await put({ port: 8080 })).status, 400);
      assert.equal((await put({ host: "smtp.example.com/evil" })).status, 400);
      assert.equal((await put({ fromEmail: "nope" })).status, 400);
      assert.equal((await put({ enabled: true, host: "" })).status, 400);
    });

    test("the password is stored encrypted and never returned", async () => {
      const admin = await makeUser("admin");
      const saveWith = (body) => call("PUT", "/admin/settings/smtp", { token: admin.token, body: { ...valid, ...body } });

      const first = await saveWith({ password: "s3cret-pass" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.smtp.hasPassword, true);
      assert.ok(!JSON.stringify(first.body).includes("s3cret-pass"));
      assert.equal(first.body.smtp.passwordEncrypted, undefined);

      const stored = await PlatformSetting.findOne({ key: "platform" }).select("+smtp.passwordEncrypted");
      assert.notEqual(stored.smtp.passwordEncrypted, "s3cret-pass");
      assert.equal(decryptSecret(stored.smtp.passwordEncrypted), "s3cret-pass");

      const read = await call("GET", "/admin/settings/smtp", { token: admin.token });
      assert.ok(!JSON.stringify(read.body).includes(stored.smtp.passwordEncrypted));

      // Saving without a password keeps it; clearPassword removes it.
      assert.equal((await saveWith({ fromName: "Renamed" })).body.smtp.hasPassword, true);
      assert.equal((await saveWith({ clearPassword: true })).body.smtp.hasPassword, false);
    });

    test("a failing test email is reported and recorded; enabled SMTP is used for all mail", async () => {
      const admin = await makeUser("admin");
      // Nothing listens on 127.0.0.1:2525, so the connection is refused at once.
      await call("PUT", "/admin/settings/smtp", { token: admin.token, body: valid });
      const tested = await call("POST", "/admin/settings/smtp/test", { token: admin.token, body: { to: "smoke-smtp@example.test" } });
      assert.equal(tested.status, 502);
      const read = await call("GET", "/admin/settings/smtp", { token: admin.token });
      assert.equal(read.body.smtp.lastTestOk, false);
      assert.ok(read.body.smtp.lastTestError);

      await call("PUT", "/admin/settings/smtp", { token: admin.token, body: { ...valid, enabled: true } });
      await assert.rejects(sendMail({ to: "smoke-smtp@example.test", subject: "x", text: "x", html: "x" }));
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
      const pending = await call("POST", "/institution/credentials", {
        token: pendingOwner.token,
        institution: pendingInstitution,
        body: allocation(student.wallet.address),
      });
      assert.equal(pending.status, 403);

      const verifiedOwner = await makeUser("institution");
      const verifiedInstitution = await makeInstitution(verifiedOwner, "VERIFIED");
      const verified = await call("POST", "/institution/credentials", {
        token: verifiedOwner.token,
        institution: verifiedInstitution,
        body: allocation(student.wallet.address),
      });
      assert.equal(verified.status, 201);
    });
  });

  describe("secrets and mint handling (P00-05)", () => {
    test("IPFS pin endpoint requires login and credential:create", async () => {
      assert.equal((await call("POST", "/ipfs/pin-json", { body: { name: "x" } })).status, 401);
      const student = await makeUser("student");
      const institution = await makeInstitution(await makeUser("institution"), "VERIFIED");
      assert.equal(
        (await call("POST", "/ipfs/pin-json", { token: student.token, institution, body: { name: "x" } })).status,
        403
      );
    });

    test("claim: the backend mints into the student's wallet and charges the college once, only on success", async () => {
      process.env.CHAIN_DRIVER = "fake";
      const saved = (await PlatformSetting.findOne({ key: "platform" }).lean())?.billing;
      await PlatformSetting.updateOne({ key: "platform" }, { $set: { billing: { priceSol: 10_000_000, priceUsdc: 2_000_000 } } }, { upsert: true });
      try {
        const student = await makeUser("student");
        const owner = await makeUser("institution");
        const admin = await makeUser("admin");
        const institution = await makeInstitution(owner, "VERIFIED");
        const issue = async (ipfsHash) => {
          await call("POST", "/institution/credentials", { token: owner.token, institution, body: { ...allocation(student.wallet.address), ipfsHash } });
          return Credential.findOne({ institutionId: institution._id, ipfsHash });
        };
        const claim = (credential) =>
          call("POST", "/student/credentials/claim", { token: student.token, body: { walletAddress: student.wallet.address, credentialId: String(credential._id), revision: credential.revision } });
        const charges = () => BillingEntry.countDocuments({ institutionId: institution._id, kind: "CHARGE" });
        const balances = async () => (await call("GET", "/institution/billing", { token: owner.token, institution })).body.balances;

        const degree = await issue("QmClaimA");
        assert.equal((await claim(degree)).status, 403); // not confirmed and the review window is open
        await Credential.updateOne({ _id: degree._id }, { isConfirmed: true });
        const notSetUp = await claim(degree);
        assert.equal(notSetUp.status, 409);
        assert.match(notSetUp.body.message, /not set up/);

        assert.equal((await call("POST", `/admin/institutions/${institution._id}/chain`, { token: admin.token, body: chainBody() })).status, 201);
        const broke = await claim(degree);
        assert.equal(broke.status, 409);
        assert.match(broke.body.message, /balance is too low/);
        assert.equal(await Nft.countDocuments({ credentialId: degree._id }), 0); // nothing reserved without money

        fakeChain.deposits.push({ signature: `claim-usdc-${institution._id}`, currency: "USDC", amount: 3_000_000, from: institution.walletAddress });
        await call("POST", "/institution/billing/sync", { token: owner.token, institution });

        fakeChain.failNextMint = true; // the RPC fails and nothing landed
        assert.equal((await claim(degree)).status, 502);
        assert.equal(await charges(), 0);
        assert.equal((await Nft.findOne({ credentialId: degree._id })).status, "FAILED");

        const ok = await claim(degree);
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.nft.status, "MINTED");
        const asset = fakeChain.assets.get(ok.body.nft.assetAddress);
        const college = await CollegeChain.findOne({ institutionId: institution._id });
        assert.deepEqual(asset, { owner: student.wallet.address, collection: college.collectionAddress });
        const minted = await Credential.findById(degree._id);
        assert.equal(minted.minted, true);
        assert.equal(minted.nftAddress, ok.body.nft.assetAddress);
        assert.equal(await charges(), 1);
        assert.deepEqual(await balances(), { SOL: 0, USDC: 1_000_000 }); // USDC pays first
        assert.equal((await Nft.findOne({ credentialId: degree._id }).select("+assetSecretEncrypted")).assetSecretEncrypted, undefined);

        // Clicking Claim again is harmless: same asset, no second charge.
        assert.equal((await claim(degree)).body.nft.assetAddress, ok.body.nft.assetAddress);
        assert.equal(await charges(), 1);

        // A second credential: USDC is now too low and there is no SOL.
        const provisional = await issue("QmClaimB");
        await Credential.updateOne({ _id: provisional._id }, { isConfirmed: true });
        assert.equal((await claim(provisional)).status, 409);

        // SOL arrives; the mint lands but the response times out. The retry finds it on-chain and charges once.
        fakeChain.deposits.push({ signature: `claim-sol-${institution._id}`, currency: "SOL", amount: 10_000_000, from: institution.walletAddress });
        await call("POST", "/institution/billing/sync", { token: owner.token, institution });
        const realMint = fakeChain.mintAsset;
        fakeChain.mintAsset = async (args) => {
          await realMint(args);
          throw new Error("timeout after the mint landed");
        };
        try {
          const landed = await claim(provisional);
          assert.equal(landed.status, 200, JSON.stringify(landed.body));
        } finally {
          fakeChain.mintAsset = realMint;
        }
        assert.equal(await charges(), 2);
        assert.deepEqual(await balances(), { SOL: 0, USDC: 1_000_000 });
      } finally {
        await PlatformSetting.updateOne({ key: "platform" }, saved ? { $set: { billing: saved } } : { $unset: { billing: 1 } });
      }
    });

    test("revising a credential keeps the old revision, voids the confirmation, and an open report blocks the mint (P06-03/P06-07)", async () => {
      const student = await makeUser("student");
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      const otherOwner = await makeUser("institution");
      const other = await makeInstitution(otherOwner, "VERIFIED");
      await call("POST", "/institution/credentials", { token: owner.token, institution, body: allocation(student.wallet.address) });
      const nft = await Credential.findOne({ institutionId: institution._id });
      assert.match(nft.contentHash, /^[a-f0-9]{64}$/);
      const wallet = student.wallet.address;
      const confirm = (revision) => call("POST", "/student/credentials/confirm", { token: student.token, body: { walletAddress: wallet, credentialId: String(nft._id), revision } });
      assert.equal((await confirm(1)).status, 200);

      const corrected = { name: "Corrected Degree", uri: "https://ipfs.io/ipfs/QmFixed", ipfsHash: "QmFixed", reason: "Wrong CGPA" };
      const revise = (as, body) => call("POST", `/institution/credentials/${nft._id}/revise`, { token: as.owner.token, institution: as.institution, body });
      assert.equal((await revise({ owner, institution }, { ...corrected, reason: "" })).status, 400);
      assert.equal((await revise({ owner, institution }, { ...corrected, uri: "https://ipfs.io/ipfs/QmElse" })).status, 400);
      assert.equal((await revise({ owner: otherOwner, institution: other }, corrected)).status, 404); // another college
      assert.equal((await revise({ owner, institution }, corrected)).status, 200);

      const revised = await Credential.findById(nft._id);
      assert.equal(revised.revision, 2);
      assert.equal(revised.isConfirmed, false);
      assert.equal(revised.status, "PENDING_CONFIRMATION");
      assert.notEqual(revised.contentHash, nft.contentHash);
      assert.equal(revised.previousRevisions.length, 1);
      assert.equal(revised.previousRevisions[0].ipfsHash, "QmSmoke");
      assert.equal((await confirm(1)).status, 409); // the old confirmation cannot be reused
      assert.equal((await confirm(2)).status, 200);

      // A student's open report blocks the mint until the college resolves it.
      const report = await call("POST", "/student/credentials/report", { token: student.token, body: { walletAddress: wallet, credentialId: String(nft._id), reportType: "Wrong grade", reportDetails: "CGPA is wrong" } });
      assert.equal(report.status, 201, JSON.stringify(report.body));
      const mint = () => call("POST", "/student/credentials/claim", { token: student.token, body: { walletAddress: wallet, credentialId: String(nft._id), revision: 2 } });
      assert.equal((await mint()).status, 409);
      assert.equal((await Reports.findOne({ institutionId: institution._id })).credentialId.toString(), String(nft._id));

      // The college's list shows the open report.
      const list = await call("GET", "/institution/credentials", { token: owner.token, institution });
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.equal(list.body.credentials.find((c) => c._id === String(nft._id)).openReports, 1);

      // Revising alone does not clear the report (new metadata hash, same credential): the mint stays blocked.
      const again = { name: "Corrected twice", uri: "https://ipfs.io/ipfs/QmTwice", ipfsHash: "QmTwice", reason: "Typo in title" };
      assert.equal((await revise({ owner, institution }, again)).status, 200);
      assert.equal((await confirm(3)).status, 200);
      const mintAt = (revision) => call("POST", "/student/credentials/claim", { token: student.token, body: { walletAddress: wallet, credentialId: String(nft._id), revision } });
      assert.equal((await mintAt(3)).status, 409);

      // Only when the college says so does the correction resolve the report.
      const third = { name: "Final", uri: "https://ipfs.io/ipfs/QmFinal", ipfsHash: "QmFinal", reason: "Grade fixed", resolveReports: true };
      const done = await revise({ owner, institution }, third);
      assert.equal(done.status, 200);
      assert.equal(done.body.resolvedReports, 1);
      assert.equal((await Reports.findOne({ institutionId: institution._id })).resolved, true);
      assert.equal((await confirm(4)).status, 200);
      const past = await mintAt(4); // past the report check: the college has no collection yet
      assert.equal(past.status, 409);
      assert.match(past.body.message, /not set up/);

      await Credential.updateOne({ _id: nft._id }, { minted: true });
      assert.equal((await revise({ owner, institution }, { ...corrected, ipfsHash: "QmAgain", uri: "https://ipfs.io/ipfs/QmAgain" })).status, 409);
    });

    test("confirming one credential leaves the student's other credentials pending (P06-06)", async () => {
      const student = await makeUser("student");
      const owner = await makeUser("institution");
      const institution = await makeInstitution(owner, "VERIFIED");
      for (const [type, hash] of [["DEGREE", "QmD"], ["PROVISIONAL", "QmP"]]) {
        const issued = await call("POST", "/institution/credentials", {
          token: owner.token,
          institution,
          body: { ...allocation(student.wallet.address), ipfsHash: hash, credentialType: type },
        });
        assert.equal(issued.status, 201, JSON.stringify(issued.body));
      }
      const [degree, provisional] = [await Credential.findOne({ institutionId: institution._id, ipfsHash: "QmD" }), await Credential.findOne({ institutionId: institution._id, ipfsHash: "QmP" })];
      const confirm = (nft, extra = {}) =>
        call("POST", "/student/credentials/confirm", {
          token: student.token,
          body: { walletAddress: student.wallet.address, credentialId: String(nft._id), revision: nft.revision, ...extra },
        });

      // An id and revision are both required: no "confirm the oldest one".
      assert.equal((await call("POST", "/student/credentials/confirm", { token: student.token, body: { walletAddress: student.wallet.address } })).status, 400);
      assert.equal((await confirm(degree, { revision: 99 })).status, 409);
      assert.equal((await confirm(degree)).status, 200);
      assert.equal((await Credential.findById(degree._id)).isConfirmed, true);
      assert.equal((await Credential.findById(provisional._id)).isConfirmed, false);
      assert.equal((await Credential.findById(provisional._id)).status, "PENDING_CONFIRMATION");
    });
  });

  describe("on-chain setup and billing (stage 1)", () => {
    let savedBilling;
    before(async () => {
      process.env.CHAIN_DRIVER = "fake";
      savedBilling = (await PlatformSetting.findOne({ key: "platform" }).lean())?.billing;
    });
    after(async () => {
      await PlatformSetting.updateOne({ key: "platform" }, savedBilling ? { $set: { billing: savedBilling } } : { $unset: { billing: 1 } });
    });

    test("prices convert exactly and the cheaper-to-reason USDC balance pays first", () => {
      assert.equal(toUnits("0.01", "SOL"), 10_000_000);
      assert.equal(toUnits("2", "USDC"), 2_000_000);
      assert.equal(toUnits("0.000001", "USDC"), 1);
      for (const bad of ["", "-1", "0", "1e3", "abc", "0.0000001"]) assert.throws(() => toUnits(bad, "USDC"), bad);
      const prices = { SOL: 10, USDC: 2 };
      assert.deepEqual(pickPayment({ SOL: 100, USDC: 5 }, prices), { currency: "USDC", amount: 2 });
      assert.deepEqual(pickPayment({ SOL: 100, USDC: 1 }, prices), { currency: "SOL", amount: 10 });
      assert.equal(pickPayment({ SOL: 9, USDC: 1 }, prices), null);
      assert.equal(pickPayment({ SOL: 100, USDC: 100 }, { SOL: null, USDC: null }), null); // no price set = cannot mint
    });

    test("CORS: only the configured frontend may call the API from a browser", { skip: !allowedOrigins.length && "no CORS_ORIGINS / FRONTEND_URL in .env" }, async () => {
      const preflight = (origin) =>
        fetch(`${base}/verify/11111111111111111111111111111111`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
      assert.equal((await preflight(allowedOrigins[0])).headers.get("access-control-allow-origin"), allowedOrigins[0]);
      assert.equal((await preflight("https://evil.example")).headers.get("access-control-allow-origin"), null);
    });

    test("alerts: the same alert is sent once, then held back for its quiet period", async () => {
      const key = `test-alert-${Date.now()}`;
      try {
        const first = await alertAdmins({ key, subject: "Test", message: "Test alert", everyMinutes: 60 });
        assert.notEqual(first, "throttled");
        assert.equal(await alertAdmins({ key, subject: "Test", message: "Test alert", everyMinutes: 60 }), "throttled");
      } finally {
        await mongoose.connection.collection("alertsents").deleteOne({ key });
      }
    });

    test("only the Super Admin sets the global price", async () => {
      const admin = await makeUser("admin");
      const head = await makeUser("institution");
      const institution = await makeInstitution(head, "VERIFIED");
      assert.equal((await call("PUT", "/admin/settings/billing", { token: head.token, institution, body: { priceSol: "1", priceUsdc: "1" } })).status, 403);
      assert.equal((await call("PUT", "/admin/settings/billing", { token: admin.token, body: { priceSol: "0", priceUsdc: "2" } })).status, 400);
      const saved = await call("PUT", "/admin/settings/billing", { token: admin.token, body: { priceSol: "0.01", priceUsdc: "2" } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body.prices, { SOL: 10_000_000, USDC: 2_000_000 });
      const read = await call("GET", "/admin/settings/billing", { token: admin.token });
      assert.equal(read.body.prices.USDC, 2_000_000);
    });

    test("the Super Admin creates a college collection once, with the officials' multisig; only the minting key is held, encrypted", async () => {
      const admin = await makeUser("admin");
      const head = await makeUser("institution");
      const college = await makeInstitution(head, "VERIFIED");
      const pending = await makeInstitution(await makeUser("institution"), "PENDING");
      const setup = (institution, body = chainBody(), token = admin.token) => call("POST", `/admin/institutions/${institution._id}/chain`, { token, body });

      assert.equal((await setup(college, chainBody(), head.token)).status, 403);
      assert.equal((await setup(college, { members: officials().slice(0, 1) })).status, 400); // one official is not a multisig
      assert.equal((await setup(college, { members: officials(), threshold: 1 })).status, 400); // one approval is not enough
      assert.equal((await setup(college, { members: officials(), threshold: 4 })).status, 400); // more than the officials
      assert.equal((await setup(college, { members: ["not-a-wallet", ...officials()] })).status, 400);
      assert.equal((await setup(pending)).status, 409); // not verified yet
      const members = officials();
      const first = await setup(college, { members, threshold: 2 });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.ok(first.body.chain.collectionAddress && first.body.chain.mintingAddress);
      assert.deepEqual(first.body.chain.multisig.members, members);
      assert.equal(first.body.chain.multisig.threshold, 2);
      assert.ok(first.body.chain.multisig.vault);
      assert.ok(!JSON.stringify(first.body).includes("secret")); // no secret ever leaves the server
      assert.equal((await setup(college)).status, 409); // once only: the permissions are fixed

      const stored = await CollegeChain.findOne({ institutionId: college._id }).select("+keys.minting.secretEncrypted");
      assert.equal(addressOfSecret(decryptSecret(stored.keys.minting.secretEncrypted)), stored.keys.minting.address);
    });

    test("a college's on-chain payments become its balance, once each, and only from its own wallet", async () => {
      const head = await makeUser("institution");
      const college = await makeInstitution(head, "VERIFIED");
      const other = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const as = (method, path) => call(method, path, { token: head.token, institution: college });

      const empty = await as("GET", "/institution/billing");
      assert.equal(empty.status, 200, JSON.stringify(empty.body));
      assert.deepEqual(empty.body.balances, { SOL: 0, USDC: 0 });
      assert.equal(empty.body.payFromWallet, college.walletAddress);

      fakeChain.deposits.push(
        { signature: `sig-sol-${college._id}`, currency: "SOL", amount: 50_000_000, from: college.walletAddress },
        { signature: `sig-usdc-${college._id}`, currency: "USDC", amount: 5_000_000, from: college.walletAddress },
        { signature: `sig-other-${other._id}`, currency: "SOL", amount: 1, from: other.walletAddress },
      );
      const synced = await as("POST", "/institution/billing/sync");
      assert.equal(synced.status, 200, JSON.stringify(synced.body));
      assert.equal(synced.body.added, 2);
      assert.deepEqual(synced.body.balances, { SOL: 50_000_000, USDC: 5_000_000 });
      assert.equal((await as("POST", "/institution/billing/sync")).body.added, 0); // same payments: not credited twice

      const ledger = await as("GET", "/institution/billing");
      assert.equal(ledger.body.entries.length, 2);
      // another college's staff only ever see their own
      assert.deepEqual((await call("GET", "/institution/billing", { token: (await makeUser("institution")).token, institution: other })).status, 403);
    });
  });

  describe("credential lifecycle: status, wallet recovery, burn (stage 4)", () => {
    let saved;
    before(async () => {
      process.env.CHAIN_DRIVER = "fake";
      saved = (await PlatformSetting.findOne({ key: "platform" }).lean())?.billing;
      await PlatformSetting.updateOne({ key: "platform" }, { $set: { billing: { priceSol: 10, priceUsdc: 2 } } }, { upsert: true });
    });
    after(() => PlatformSetting.updateOne({ key: "platform" }, saved ? { $set: { billing: saved } } : { $unset: { billing: 1 } }));

    // A college with a collection and money, a second admin and a plain staff member, and a student who can claim.
    const world = async () => {
      const admin = await makeUser("admin");
      const head = await makeUser("institution");
      const college = await makeInstitution(head, "VERIFIED");
      const approvers = officials();
      await call("POST", `/admin/institutions/${college._id}/chain`, { token: admin.token, body: chainBody(approvers) });
      fakeChain.deposits.push({ signature: `life-${college._id}`, currency: "SOL", amount: 1000, from: college.walletAddress });
      await call("POST", "/institution/billing/sync", { token: head.token, institution: college });
      const member = async (roleName) => {
        const user = await makeUser("institution");
        const role = await Role.findOne({ name: roleName });
        await InstitutionMembership.create({ userId: user.user._id, institutionId: college._id, roleId: role._id, status: "ACTIVE" });
        return user;
      };
      const secondAdmin = await member("institution_admin");
      const staff = await member("staff");

      // The student's old wallet is one we hold the key for.
      const student = await makeUser("student");
      const oldKey = Keypair.generate();
      await Wallet.updateOne({ _id: student.wallet._id }, { address: oldKey.publicKey.toBase58() });
      const oldWallet = oldKey.publicKey.toBase58();
      const profile = await Student.create({ institutionId: college._id, fullName: "Rahul", email: `rahul-${college._id}@example.com`, userId: student.user._id });

      const issue = async (ipfsHash) => {
        await call("POST", "/institution/credentials", { token: head.token, institution: college, body: { ...allocation(oldWallet), ipfsHash } });
        const credential = await Credential.findOne({ institutionId: college._id, ipfsHash });
        await Credential.updateOne({ _id: credential._id }, { studentId: profile._id, isConfirmed: true });
        return Credential.findById(credential._id);
      };
      const claim = (credential, token = student.token, walletAddress = oldWallet) =>
        call("POST", "/student/credentials/claim", { token, body: { walletAddress, credentialId: String(credential._id), revision: credential.revision } });
      const as = (user) => (method, path, body) => call(method, path, { token: user.token, institution: college, body });
      // An official approves: get the transaction for their wallet, "sign" it (the fake chain takes it back as is), send it.
      const approveWith = async (user, requestId, wallet, extra = {}) => {
        const query = new URLSearchParams({ wallet, ...extra }).toString();
        const built = await as(user)("GET", `/institution/credential-requests/${requestId}/approval-tx?${query}`);
        if (built.status !== 200) return built;
        return as(user)("POST", `/institution/credential-requests/${requestId}/approval-tx`, { wallet, signedTransaction: built.body.transaction, ...extra });
      };
      return { admin, head, college, secondAdmin, staff, student, oldKey, oldWallet, profile, issue, claim, as, approvers, approveWith };
    };

    const sign = async (keypair) => {
      const walletAddress = keypair.publicKey.toBase58();
      const nonce = await call("POST", "/auth/nonce", { body: { walletAddress } });
      return { walletAddress, signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce.body.message), keypair.secretKey)).toString("base64") };
    };

    test("academic status changes need a reason, keep history, and a suspended credential cannot be claimed", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeStatus");
      const status = (body, user = w.head) => w.as(user)("POST", `/institution/credentials/${credential._id}/status`, body);
      assert.equal((await status({ status: "SUSPENDED" })).status, 400); // no reason
      assert.equal((await status({ status: "GONE", reason: "xxxxx" })).status, 400);
      assert.equal((await status({ status: "SUSPENDED", reason: "Fee dispute" }, w.staff)).status, 403); // plain staff
      const suspended = await status({ status: "SUSPENDED", reason: "Fee dispute" });
      assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
      assert.equal((await status({ status: "SUSPENDED", reason: "Again" })).status, 409);
      const claimBlocked = await w.claim(await Credential.findById(credential._id));
      assert.equal(claimBlocked.status, 409);
      assert.match(claimBlocked.body.message, /suspended/);
      const back = await status({ status: "ACTIVE", reason: "Dispute settled" });
      assert.deepEqual(back.body.statusHistory.map((entry) => entry.status), ["SUSPENDED", "ACTIVE"]);
      assert.equal((await w.claim(await Credential.findById(credential._id))).status, 200);
    });

    test("wallet recovery: the student proves the new wallet, two different people approve, the NFT moves and history is kept", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeRecover");
      const minted = await w.claim(credential);
      assert.equal(minted.status, 200, JSON.stringify(minted.body));
      const assetAddress = minted.body.nft.assetAddress;

      assert.equal((await w.as(w.staff)("POST", `/institution/students/${w.profile._id}/recovery`, { reason: "Phone stolen" })).status, 403);
      const started = await w.as(w.head)("POST", `/institution/students/${w.profile._id}/recovery`, { reason: "Phone stolen" });
      assert.equal(started.status, 201, JSON.stringify(started.body));
      assert.equal((await w.as(w.head)("POST", `/institution/students/${w.profile._id}/recovery`, { reason: "Again" })).status, 409); // one open request
      const requestId = started.body.request._id;
      const token = started.body.recoveryUrl.split("/recover/")[1];

      // Nothing can be approved before the student proves the new wallet.
      assert.equal((await w.approveWith(w.head, requestId, w.approvers[0])).status, 409);

      assert.equal((await call("GET", `/auth/recovery/${token}`)).body.recovery.studentName, "Rahul");
      assert.equal((await call("POST", `/auth/recovery/${token}/prove`, { body: await sign(w.oldKey) })).status, 409); // the wallet being replaced
      const newKey = Keypair.generate();
      const proved = await call("POST", `/auth/recovery/${token}/prove`, { body: await sign(newKey) });
      assert.equal(proved.status, 200, JSON.stringify(proved.body));
      assert.equal((await call("POST", `/auth/recovery/${token}/prove`, { body: await sign(Keypair.generate()) })).status, 400); // link used
      const newWallet = newKey.publicKey.toBase58();
      const newWalletDoc = await Wallet.findOne({ address: newWallet });
      created.users.push(newWalletDoc.userId);
      created.wallets.push(newWalletDoc._id);

      assert.equal((await w.approveWith(w.staff, requestId, w.approvers[0])).status, 403); // no approval permission in the app
      assert.equal((await w.approveWith(w.head, requestId, Keypair.generate().publicKey.toBase58())).status, 403); // not an official's wallet
      // A signed transaction must be exactly the one built for that wallet: swapping the member is refused.
      const built = await w.as(w.head)("GET", `/institution/credential-requests/${requestId}/approval-tx?wallet=${w.approvers[2]}`);
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(built.body.transaction, "base64").toString()), member: w.approvers[1] })).toString("base64");
      assert.equal((await w.as(w.head)("POST", `/institution/credential-requests/${requestId}/approval-tx`, { wallet: w.approvers[2], signedTransaction: forged })).status, 400);

      const first = await w.approveWith(w.head, requestId, w.approvers[0]);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.request.status, "PENDING_APPROVAL"); // 1 of 2: nothing happens yet
      assert.equal((await w.approveWith(w.head, requestId, w.approvers[0])).status, 409); // the same official twice
      assert.equal(fakeChain.assets.get(assetAddress).owner, w.oldWallet); // nothing moved yet
      const done = await w.approveWith(w.secondAdmin, requestId, w.approvers[1]);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.request.walletApprovals.length, 2);
      assert.equal(done.body.request.status, "EXECUTED");

      // On-chain and in our records: same asset, new owner, history kept.
      assert.equal(fakeChain.assets.get(assetAddress).owner, newWallet);
      const nft = await Nft.findOne({ assetAddress });
      assert.equal(nft.ownerWallet, newWallet);
      assert.deepEqual(nft.ownerHistory.map((entry) => entry.wallet), [w.oldWallet, newWallet]);
      const moved = await Credential.findById(credential._id);
      assert.equal(moved.studentWallet, newWallet);
      assert.equal(String(moved.userId), String(newWalletDoc.userId));
      const profile = await Student.findById(w.profile._id);
      assert.equal(String(profile.userId), String(newWalletDoc.userId));
      assert.equal(profile.walletHistory.length, 1);
      assert.equal(profile.walletHistory[0].wallet, w.oldWallet);
      assert.equal(String(profile.walletHistory[0].userId), String(w.student.user._id));

      // The student now sees it with the new wallet; the old account no longer does.
      const newToken = signToken(await User.findById(newWalletDoc.userId));
      const mine = await call("GET", `/student/credentials/minted/${newWallet}`, { token: newToken });
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      assert.equal(mine.body.nfts.length, 1);
      assert.equal((await call("GET", `/student/credentials/minted/${w.oldWallet}`, { token: w.student.token })).body.nfts.length, 0);
    });

    test("burn: needs a request, two different approvers and an explicit confirmation; the record stays, revoked", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeBurn");
      assert.equal((await w.as(w.head)("POST", `/institution/credentials/${credential._id}/burn`, { reason: "Issued by mistake" })).status, 409); // not minted
      const assetAddress = (await w.claim(credential)).body.nft.assetAddress;
      const requested = await w.as(w.head)("POST", `/institution/credentials/${credential._id}/burn`, { reason: "Issued by mistake" });
      assert.equal(requested.status, 201, JSON.stringify(requested.body));
      assert.equal((await w.as(w.head)("POST", `/institution/credentials/${credential._id}/burn`, { reason: "Again" })).status, 409);
      const requestId = requested.body.request._id;
      assert.equal((await w.approveWith(w.head, requestId, w.approvers[0])).status, 400); // must confirm it is irreversible
      assert.equal((await w.approveWith(w.head, requestId, w.approvers[0], { confirmIrreversible: "true" })).status, 200);
      assert.ok(fakeChain.assets.has(assetAddress));
      // The chain step fails after the second approval: nothing is lost, the request can be retried.
      fakeChain.failNextExecute = true;
      const failed = await w.approveWith(w.secondAdmin, requestId, w.approvers[1], { confirmIrreversible: "true" });
      assert.equal(failed.body.request.status, "FAILED", JSON.stringify(failed.body));
      assert.ok(await mongoose.connection.collection("alertsents").findOne({ key: `request-failed-${requestId}` })); // alerted once
      assert.ok(fakeChain.assets.has(assetAddress));
      const done = await w.as(w.secondAdmin)("POST", `/institution/credential-requests/${requestId}/retry`);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal(done.body.request.status, "EXECUTED");
      assert.equal(fakeChain.assets.has(assetAddress), false);
      assert.equal((await Nft.findOne({ assetAddress })).status, "BURNED");
      const record = await Credential.findById(credential._id);
      assert.equal(record.academicStatus, "REVOKED");
      assert.match(record.statusHistory.at(-1).reason, /Burned/);

      // The approvals list shows it; a plain staff member cannot see the queue.
      assert.equal((await w.as(w.head)("GET", "/institution/credential-requests")).body.requests.length, 1);
      assert.equal((await w.as(w.staff)("GET", "/institution/credential-requests")).status, 403);
    });

    test("public verification: VERIFIED only when record, collection, chain, content and status all agree", async () => {
      const w = await world();
      const verify = async (address) => (await call("GET", `/verify/${address}`)).body;
      assert.equal((await call("GET", "/verify/not-an-address")).status, 400);
      assert.equal((await verify(Keypair.generate().publicKey.toBase58())).status, "NOT_FOUND");

      await Student.updateOne({ _id: w.profile._id }, { fullName: "Rahul Kumar Sharma" });
      const credential = await w.issue("QmLifeVerify");
      const assetAddress = (await w.claim(credential)).body.nft.assetAddress;
      const ok = await verify(assetAddress);
      assert.equal(ok.status, "VERIFIED", JSON.stringify(ok));
      assert.ok(ok.checks.every((check) => check.ok === true));
      assert.equal(ok.credential.holder, "Rahul S."); // masked, not the full name
      assert.equal(ok.college.name, "Smoke Institution");
      assert.ok(!JSON.stringify(ok).includes("example.com")); // no email or other private data

      fakeChain.rpcDown = true;
      try {
        assert.equal((await verify(assetAddress)).status, "VERIFICATION_UNAVAILABLE"); // never VERIFIED when the chain can't be read
      } finally {
        fakeChain.rpcDown = false;
      }

      const status = (next, reason) => w.as(w.head)("POST", `/institution/credentials/${credential._id}/status`, { status: next, reason });
      await status("SUSPENDED", "Under review");
      assert.equal((await verify(assetAddress)).status, "SUSPENDED");
      await status("ACTIVE", "Review done");

      // Our record and the chain disagree about the owner: not verified.
      const realOwner = fakeChain.assets.get(assetAddress).owner;
      fakeChain.assets.get(assetAddress).owner = Keypair.generate().publicKey.toBase58();
      assert.equal((await verify(assetAddress)).status, "VERIFICATION_UNAVAILABLE");
      fakeChain.assets.get(assetAddress).owner = realOwner;

      // The record changed after minting: what the NFT says is no longer the current credential.
      await Credential.updateOne({ _id: credential._id }, { contentHash: "changed" });
      assert.equal((await verify(assetAddress)).status, "SUPERSEDED");
      await Credential.updateOne({ _id: credential._id }, { contentHash: (await Nft.findOne({ assetAddress })).contentHash });

      await status("REVOKED", "Degree withdrawn");
      const revoked = await verify(assetAddress);
      assert.equal(revoked.status, "REVOKED");
      assert.equal(revoked.credential.academicStatus, "REVOKED");
    });

    test("hardening: public endpoints are rate limited per IP", async () => {
      process.env.RATE_LIMIT_DISABLED = "false";
      try {
        const address = Keypair.generate().publicKey.toBase58();
        let limited;
        // 130 > 2 x 60: at least one full minute-window overflows even if the run crosses a window boundary.
        for (let i = 0; i < 130 && !limited; i++) {
          const response = await fetch(`${base}/verify/${address}`);
          if (response.status === 429) limited = response;
        }
        assert.ok(limited, "no 429 after 130 requests");
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
      } finally {
        process.env.RATE_LIMIT_DISABLED = "true";
      }
    });

    test("hardening: Mainnet writes stay locked, and a college's collection is never used on the wrong network", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeNetwork");
      const other = await makeInstitution(await makeUser("institution"), "VERIFIED");
      const cluster = process.env.SOLANA_CLUSTER;
      process.env.SOLANA_CLUSTER = "mainnet";
      try {
        assert.equal((await call("POST", `/admin/institutions/${other._id}/chain`, { token: w.admin.token, body: chainBody() })).status, 503);
        const wrongNetwork = await w.claim(credential); // the college collection was made on devnet
        assert.equal(wrongNetwork.status, 409);
        assert.match(wrongNetwork.body.message, /devnet/);
        assert.equal(await Nft.countDocuments({ credentialId: credential._id }), 0);
        const settings = await call("GET", "/admin/settings/billing", { token: w.admin.token });
        assert.equal(settings.body.writesLocked, true);
      } finally {
        process.env.SOLANA_CLUSTER = cluster;
      }
    });

    test("hardening: a low fee wallet pauses claims before anything is reserved or charged", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeFeeLow");
      const realBalance = fakeChain.feePayerBalance;
      fakeChain.feePayerBalance = async () => ({ address: "FakeFeePayer", lamports: 1000 });
      try {
        const paused = await w.claim(credential);
        assert.equal(paused.status, 503);
        assert.ok(await mongoose.connection.collection("alertsents").findOne({ key: "fee-payer-paused" })); // the Super Admins were alerted
        assert.equal(await Nft.countDocuments({ credentialId: credential._id }), 0);
        assert.equal(await BillingEntry.countDocuments({ institutionId: w.college._id, kind: "CHARGE" }), 0);
        assert.equal((await call("GET", "/admin/settings/billing", { token: w.admin.token })).body.feePayer.low, true);
      } finally {
        fakeChain.feePayerBalance = realBalance;
      }
      assert.equal((await w.claim(credential)).status, 200);
    });

    test("QA: five simultaneous claims (double clicks, retries) mint once and charge once", async () => {
      const w = await world();
      const credential = await w.issue("QmQaConcurrent");
      const responses = await Promise.all(Array.from({ length: 5 }, () => w.claim(credential)));
      const statuses = responses.map((response) => response.status);
      assert.ok(statuses.includes(200), JSON.stringify(statuses));
      assert.ok(statuses.every((status) => status === 200 || status === 409), JSON.stringify(statuses)); // the rest: "already being claimed"
      const nfts = await Nft.find({ credentialId: credential._id });
      assert.equal(nfts.length, 1);
      assert.equal(await BillingEntry.countDocuments({ credentialId: credential._id, kind: "CHARGE" }), 1);
      const minted = [...fakeChain.assets.entries()].filter(([address]) => address === nfts[0].assetAddress);
      assert.equal(minted.length, 1);
      // after the dust settles, claiming again returns the same NFT
      const again = await w.claim(await Credential.findById(credential._id));
      assert.equal(again.status, 200);
      assert.equal(again.body.nft.assetAddress, nfts[0].assetAddress);
      assert.equal((await Nft.findById(nfts[0]._id)).ownerHistory.length, 1);
    });

    test("QA: another college can neither see nor approve a request; revoking does not burn; a burn touches only its asset", async () => {
      const w = await world();
      const keep = await w.issue("QmQaKeep");
      const gone = await w.issue("QmQaGone");
      const keepAsset = (await w.claim(keep)).body.nft.assetAddress;
      const goneAsset = (await w.claim(gone)).body.nft.assetAddress;

      // revoking keeps the NFT on-chain (status lives in our records)
      await w.as(w.head)("POST", `/institution/credentials/${keep._id}/status`, { status: "REVOKED", reason: "Board decision" });
      assert.ok(fakeChain.assets.has(keepAsset));
      assert.equal((await call("GET", `/verify/${keepAsset}`)).body.status, "REVOKED");

      const requestId = (await w.as(w.head)("POST", `/institution/credentials/${gone._id}/burn`, { reason: "Duplicate" })).body.request._id;
      const outsider = await makeUser("institution");
      const elsewhere = await makeInstitution(outsider, "VERIFIED");
      const foreign = (path) => call("POST", `/institution/credential-requests/${requestId}/${path}`, { token: outsider.token, institution: elsewhere, body: { confirmIrreversible: true } });
      assert.equal((await foreign("approval-tx")).status, 404);
      assert.equal((await call("GET", "/institution/credential-requests", { token: outsider.token, institution: elsewhere })).body.requests.length, 0);

      await w.approveWith(w.head, requestId, w.approvers[0], { confirmIrreversible: "true" });
      await w.approveWith(w.secondAdmin, requestId, w.approvers[2], { confirmIrreversible: "true" });
      assert.equal(fakeChain.assets.has(goneAsset), false);
      assert.ok(fakeChain.assets.has(keepAsset)); // only the intended asset was burned
    });

    test("batch upload: rows are matched to enrollments, and credentials go only to the student's proved wallet", async () => {
      const head = await makeUser("institution");
      const college = await makeInstitution(head, "VERIFIED");
      const as = (method, path, body) => call(method, path, { token: head.token, institution: college, body });
      const program = (await as("POST", "/institution/programs", { code: "CSE", name: "Computer Science" })).body.program;
      const batch = (await as("POST", "/institution/program-sessions", { programId: program._id, startYear: 2022, endYear: 2026 })).body.session;
      const linkedUser = await makeUser("student");
      const linked = await Student.create({ institutionId: college._id, fullName: "Asha Linked", registrationNo: "B-1", email: `b1-${college._id}@example.com`, userId: linkedUser.user._id });
      const unlinked = await Student.create({ institutionId: college._id, fullName: "Ravi Unlinked", registrationNo: "B-2", email: `b2-${college._id}@example.com` });
      await Student.create({ institutionId: college._id, fullName: "Not Enrolled", registrationNo: "B-3", email: `b3-${college._id}@example.com` });
      const enroll = (student) => Enrollment.create({ institutionId: college._id, studentId: student._id, programSessionId: batch._id, programId: program._id });
      const linkedEnrollment = await enroll(linked);
      const unlinkedEnrollment = await enroll(unlinked);

      const resolved = await as("POST", "/institution/credentials/resolve", {
        rows: [
          { row: 2, registrationNo: "b-1", programCode: "cse", startYear: "2022" },
          { row: 3, registrationNo: "B-2", programCode: "CSE", startYear: "2022" },
          { row: 4, registrationNo: "B-3", programCode: "CSE", startYear: "2022" },
          { row: 5, registrationNo: "B-404", programCode: "CSE", startYear: "2022" },
        ],
      });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
      const [ok, notLinked, notEnrolled, unknown] = resolved.body.results;
      assert.equal(ok.error, undefined);
      assert.equal(ok.enrollmentId, String(linkedEnrollment._id));
      assert.equal(ok.wallet, linkedUser.wallet.address);
      assert.equal(ok.programName, "Computer Science");
      assert.match(notLinked.error, /not linked a wallet/);
      assert.match(notEnrolled.error, /not enrolled/);
      assert.match(unknown.error, /No student/);

      // A typed wallet is ignored for an enrollment: the credential goes to the proved wallet.
      const typed = Keypair.generate().publicKey.toBase58();
      const issued = await as("POST", "/institution/credentials", { ...allocation(typed), ipfsHash: "QmBatch1", enrollmentId: String(linkedEnrollment._id) });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      assert.equal(issued.body.credential.studentWallet, linkedUser.wallet.address);
      const refused = await as("POST", "/institution/credentials", { ...allocation(typed), ipfsHash: "QmBatch2", enrollmentId: String(unlinkedEnrollment._id) });
      assert.equal(refused.status, 409);
      assert.match(refused.body.message, /not linked a wallet/);
    });

    test("student screen: every pending credential is listed, oldest first, until it is claimed", async () => {
      const w = await world();
      const degree = await w.issue("QmPendingDegree");
      const provisional = await w.issue("QmPendingProvisional");
      await w.as(w.head)("POST", `/institution/credentials/${provisional._id}/status`, { status: "SUSPENDED", reason: "Fee dispute" });
      const list = async () => (await call("GET", `/student/credentials/next/${w.oldWallet}`, { token: w.student.token })).body;

      const before = await list();
      assert.equal(before.authorized, true, JSON.stringify(before));
      assert.deepEqual(before.credentials.map((credential) => credential._id), [String(degree._id), String(provisional._id)]);
      const [first, second] = before.credentials;
      assert.equal(first.revision, 1);
      assert.ok(first.confirmationDeadline);
      assert.equal(first.existingReport, false);
      assert.equal(first.academicStatus, "ACTIVE");
      assert.equal(second.academicStatus, "SUSPENDED"); // shown, so the student knows why it can't be claimed

      assert.equal((await w.claim(degree)).status, 200);
      const after = await list();
      assert.deepEqual(after.credentials.map((credential) => credential._id), [String(provisional._id)]);
    });

    test("issuing: every credential needs an enrollment and metadata pinned through DegreeNFT for that college", async () => {
      const w = await world();
      const profileEnrollment = await Enrollment.create({ institutionId: w.college._id, studentId: w.profile._id, programSessionId: (await ProgramSession.create({ institutionId: w.college._id, programId: (await Program.create({ institutionId: w.college._id, code: "PIN", name: "Pin" }))._id, startYear: 2021, endYear: 2025, code: "PIN-2021" }))._id, programId: (await Program.findOne({ institutionId: w.college._id, code: "PIN" }))._id });
      const body = { ...allocation(w.oldWallet), ipfsHash: "QmPinRule", uri: "https://ipfs.io/ipfs/QmPinRule" };
      const issue = (extra) => call("POST", "/institution/credentials", { token: w.head.token, institution: w.college, body: { ...body, ...extra }, raw: true });

      const noEnrollment = await issue({});
      assert.equal(noEnrollment.status, 400);
      assert.match(noEnrollment.body.message, /enrollment/);
      const notPinned = await issue({ enrollmentId: String(profileEnrollment._id) });
      assert.equal(notPinned.status, 400);
      assert.match(notPinned.body.message, /not pinned/);

      // pinned for ANOTHER college does not count
      const other = await makeInstitution(await makeUser("institution"), "VERIFIED");
      await PinnedMetadata.create({ institutionId: other._id, cid: "QmPinRule", sha256: "x" });
      assert.equal((await issue({ enrollmentId: String(profileEnrollment._id) })).status, 400);

      await PinnedMetadata.create({ institutionId: w.college._id, cid: "QmPinRule", sha256: "x" });
      assert.equal((await issue({ enrollmentId: String(profileEnrollment._id), uri: "https://evil.example/other.json" })).status, 400); // link to a different file
      const ok = await issue({ enrollmentId: String(profileEnrollment._id) });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(ok.body.credential.studentWallet, w.oldWallet);
    });

    test("P09-01 regression: one student, two colleges, two courses, several credential types, nothing crosses over", async () => {
      const admin = await makeUser("admin");
      const student = await makeUser("student");
      const setupCollege = async () => {
        const head = await makeUser("institution");
        const college = await makeInstitution(head, "VERIFIED");
        await call("POST", `/admin/institutions/${college._id}/chain`, { token: admin.token, body: chainBody() });
        fakeChain.deposits.push({ signature: `p09-${college._id}`, currency: "SOL", amount: 1000, from: college.walletAddress });
        const as = (method, path, body) => call(method, path, { token: head.token, institution: college, body });
        await as("POST", "/institution/billing/sync");
        const profile = await Student.create({ institutionId: college._id, fullName: "Rahul Sharma", email: `p09-${college._id}@example.com`, userId: student.user._id });
        const course = async (code, startYear, endYear) => {
          const program = (await as("POST", "/institution/programs", { code, name: code })).body.program;
          const batch = (await as("POST", "/institution/program-sessions", { programId: program._id, startYear, endYear })).body.session;
          return (await as("POST", "/institution/enrollments", { studentId: profile._id, programSessionId: batch._id })).body.enrollment;
        };
        const issue = async (enrollment, credentialType, ipfsHash) => {
          const response = await as("POST", "/institution/credentials", { ...allocation(student.wallet.address), ipfsHash, credentialType, enrollmentId: String(enrollment._id) });
          assert.equal(response.status, 201, JSON.stringify(response.body));
          await Credential.updateOne({ _id: response.body.credential._id }, { isConfirmed: true });
          return Credential.findById(response.body.credential._id);
        };
        return { head, college, as, course, issue };
      };
      const abc = await setupCollege();
      const xyz = await setupCollege();

      const cse = await abc.course("CSE", 2022, 2026);
      const mba = await abc.course("MBA", 2027, 2029);
      const abcDegree = await abc.issue(cse, "DEGREE", "QmP09CseDeg");
      const abcProvisional = await abc.issue(cse, "PROVISIONAL", "QmP09CseProv");
      const abcMba = await abc.issue(mba, "DEGREE", "QmP09MbaDeg");
      const xyzDegree = await xyz.issue(await xyz.course("CSE", 2022, 2026), "DEGREE", "QmP09XyzDeg");

      // The student sees all four, from both colleges.
      const mine = (await call("GET", `/student/credentials/next/${student.wallet.address}`, { token: student.token })).body.credentials;
      assert.equal(mine.length, 4);
      assert.deepEqual(new Set(mine.map((credential) => credential.credentialType)), new Set(["DEGREE", "PROVISIONAL"]));

      // Each college sees only its own credentials.
      const abcList = (await abc.as("GET", "/institution/credentials")).body.credentials.map((credential) => credential._id);
      assert.deepEqual(abcList.sort(), [abcDegree, abcProvisional, abcMba].map((credential) => String(credential._id)).sort());
      assert.deepEqual((await xyz.as("GET", "/institution/credentials")).body.credentials.map((credential) => credential._id), [String(xyzDegree._id)]);

      // XYZ cannot change, revoke or burn ABC's credential, nor issue on ABC's enrollment.
      assert.equal((await xyz.as("POST", `/institution/credentials/${abcDegree._id}/status`, { status: "REVOKED", reason: "Not ours" })).status, 404);
      assert.equal((await xyz.as("POST", `/institution/credentials/${abcDegree._id}/burn`, { reason: "Not ours" })).status, 404);
      assert.equal((await xyz.as("POST", "/institution/credentials", { ...allocation(student.wallet.address), ipfsHash: "QmP09Steal", enrollmentId: String(cse._id) })).status, 404);

      // Claiming all four: each in its own college's collection, each college charged only for its own.
      const claim = (credential) =>
        call("POST", "/student/credentials/claim", { token: student.token, body: { walletAddress: student.wallet.address, credentialId: String(credential._id), revision: credential.revision } });
      for (const credential of [abcDegree, abcProvisional, abcMba, xyzDegree]) assert.equal((await claim(credential)).status, 200);
      const collectionOf = async (college) => (await CollegeChain.findOne({ institutionId: college._id })).collectionAddress;
      const nfts = await Nft.find({ credentialId: { $in: [abcDegree, abcProvisional, abcMba, xyzDegree].map((credential) => credential._id) } });
      const abcCollection = await collectionOf(abc.college);
      const xyzCollection = await collectionOf(xyz.college);
      assert.equal(nfts.filter((nft) => nft.collectionAddress === abcCollection).length, 3);
      assert.equal(nfts.filter((nft) => nft.collectionAddress === xyzCollection).length, 1);
      assert.equal(await BillingEntry.countDocuments({ institutionId: abc.college._id, kind: "CHARGE" }), 3);
      assert.equal(await BillingEntry.countDocuments({ institutionId: xyz.college._id, kind: "CHARGE" }), 1);

      // Revoking ABC's provisional changes only that one.
      await abc.as("POST", `/institution/credentials/${abcProvisional._id}/status`, { status: "REVOKED", reason: "Superseded by the degree" });
      const verify = async (credential) => (await call("GET", `/verify/${(await Credential.findById(credential._id)).nftAddress}`)).body.status;
      assert.equal(await verify(abcProvisional), "REVOKED");
      assert.equal(await verify(abcDegree), "VERIFIED");
      assert.equal(await verify(xyzDegree), "VERIFIED");
    });

    test("a request can be rejected with a reason, and then nothing happens", async () => {
      const w = await world();
      const credential = await w.issue("QmLifeReject");
      await w.claim(credential);
      const requestId = (await w.as(w.head)("POST", `/institution/credentials/${credential._id}/burn`, { reason: "Wrong student" })).body.request._id;
      assert.equal((await w.as(w.secondAdmin)("POST", `/institution/credential-requests/${requestId}/reject`, {})).status, 400);
      const rejected = await w.as(w.secondAdmin)("POST", `/institution/credential-requests/${requestId}/reject`, { reason: "Checked: it is correct" });
      assert.equal(rejected.body.request.status, "REJECTED");
      assert.equal((await w.approveWith(w.head, requestId, w.approvers[0], { confirmIrreversible: "true" })).status, 409);
      // closed, so a new request for the same credential is allowed
      assert.equal((await w.as(w.head)("POST", `/institution/credentials/${credential._id}/burn`, { reason: "New reason" })).status, 201);
    });
  });
});
