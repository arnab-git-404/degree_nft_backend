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
import University from "../models/university.js";
import NFT from "../models/nft.js";
import StudentDetails from "../models/studentDetails.js";

describe("baseline smoke", { skip: !process.env.MONGODB_URI && "MONGODB_URI not set" }, () => {
  let server;
  let base;
  const created = { users: [], wallets: [], unis: [], roles: [] };

  const call = async (method, path, { token, body } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token && { authorization: `Bearer ${token}` }),
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

  const makeUniversity = async (owner, verificationStatus) => {
    const university = await University.create({
      userId: owner.user._id,
      name: "Smoke University",
      code: `SMOKE${Date.now()}${Math.floor(Math.random() * 1000)}`,
      walletAddress: owner.wallet.address,
      walletId: owner.wallet._id,
      verificationStatus,
    });
    created.unis.push(university._id);
    return university;
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
    await NFT.deleteMany({ universityId: { $in: created.unis } });
    await StudentDetails.deleteMany({ universityId: { $in: created.unis } });
    await University.deleteMany({ _id: { $in: created.unis } });
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
      const owner = await makeUser("university");
      await makeUniversity(owner, "VERIFIED");
      const studentWallet = Keypair.generate().publicKey.toBase58();
      await call("POST", "/create-nft-ipfsHash-allocation", { token: owner.token, body: allocation(studentWallet) });
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

  describe("no self-promotion (P00-04)", () => {
    test("student cannot create a university profile and keeps the student role", async () => {
      const student = await makeUser("student");
      const response = await call("POST", "/university/profile", {
        token: student.token,
        body: { name: "Evil U", code: `EVIL${Date.now()}`, walletAddress: student.wallet.address },
      });
      assert.equal(response.status, 403);
      const reloaded = await User.findById(student.user._id).populate("roleId");
      assert.equal(reloaded.roleId.name, "student");
    });

    test("university-role user can still create a profile", async () => {
      const university = await makeUser("university");
      const response = await call("POST", "/university/profile", {
        token: university.token,
        body: { name: "Smoke U", code: `SMOKEP${Date.now()}`, walletAddress: university.wallet.address },
      });
      assert.equal(response.status, 201);
      created.unis.push(response.body.university._id);
    });

    test("a custom-named role with nft:create can create a profile (name never matters)", async () => {
      const customRole = await Role.create({
        name: `smoke-registrar-${Date.now()}`,
        displayName: "Smoke Registrar",
        permissions: ["nft:create"],
      });
      created.roles.push(customRole._id);
      const registrar = await makeUser(customRole.name);
      const response = await call("POST", "/university/profile", {
        token: registrar.token,
        body: { name: "Smoke Reg U", code: `SMOKER${Date.now()}`, walletAddress: registrar.wallet.address },
      });
      assert.equal(response.status, 201);
      created.unis.push(response.body.university._id);
    });

    test("only a VERIFIED university can allocate credentials", async () => {
      const student = await makeUser("student");
      const pendingOwner = await makeUser("university");
      await makeUniversity(pendingOwner, "PENDING");
      const pending = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: pendingOwner.token,
        body: allocation(student.wallet.address),
      });
      assert.equal(pending.status, 403);

      const verifiedOwner = await makeUser("university");
      await makeUniversity(verifiedOwner, "VERIFIED");
      const verified = await call("POST", "/create-nft-ipfsHash-allocation", {
        token: verifiedOwner.token,
        body: allocation(student.wallet.address),
      });
      assert.equal(verified.status, 201);
    });
  });

  describe("secrets and mint handling (P00-05)", () => {
    test("IPFS pin endpoint requires login and nft:create", async () => {
      assert.equal((await call("POST", "/ipfs/pin-json", { body: { name: "x" } })).status, 401);
      const student = await makeUser("student");
      assert.equal(
        (await call("POST", "/ipfs/pin-json", { token: student.token, body: { name: "x" } })).status,
        403
      );
    });

    test("confirm-mint rejects a mint address that is not on-chain", async () => {
      const student = await makeUser("student");
      const owner = await makeUser("university");
      const university = await makeUniversity(owner, "VERIFIED");
      await call("POST", "/create-nft-ipfsHash-allocation", {
        token: owner.token,
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

      const row = await NFT.findOne({ universityId: university._id });
      assert.equal(row.minted, false);
    });
  });
});
