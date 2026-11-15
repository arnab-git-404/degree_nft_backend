// Baseline smoke tests (P00-08): run the real app in-process against the dev DB from .env.
// Each test makes its own throwaway users and everything is deleted in after().
import "dotenv/config";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import nacl from "tweetnacl";
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
  const created = { users: [], wallets: [], unis: [] };

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

  const makeUser = async (roleName) => {
    const role = await Role.findOne({ name: roleName });
    const user = await User.create({ name: `smoke-${roleName}`, roleId: role._id });
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
