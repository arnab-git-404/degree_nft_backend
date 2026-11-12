import "dotenv/config";
import bcrypt from "bcryptjs";
import bs58 from "bs58";
import mongoose from "mongoose";
import { Keypair } from "@solana/web3.js";
import User from "../models/user.js";
import Role from "../models/role.js";
import Wallet from "../models/wallet.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import seedRoles from "../utils/seedRoles.js";

const dbName = process.env.SEED_DB_NAME || process.env.MONGODB_DB_NAME || "DegreeNft";

const normalizeEmail = (value) => String(value).trim().toLowerCase();

const getConfiguredWallet = () => {
  const cliWallet = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const single = process.env.ADMIN_WALLET_ADDRESS;
  const multiple = (process.env.ADMIN_WALLET_ADDRESSES || "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);

  return cliWallet || single || multiple[0] || null;
};

const main = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  await mongoose.connect(process.env.MONGODB_URI, { dbName });
  await seedRoles();

  const role = await Role.findOne({ name: "admin", isActive: true });

  if (!role) {
    throw new Error("Admin role is not configured");
  }

  const name = process.env.ADMIN_NAME || "DegreeNFT Admin";
  const email = normalizeEmail(process.env.ADMIN_EMAIL || "admin@degreenft.local");
  const configuredWallet = getConfiguredWallet();

  if (configuredWallet && !isValidSolanaAddress(configuredWallet)) {
    throw new Error("Admin wallet address is not a valid Solana address");
  }

  const keypair = configuredWallet ? null : Keypair.fromSeed(new Uint8Array(32).fill(11));
  const walletAddress = configuredWallet || keypair.publicKey.toBase58();

  const update = {
    $set: {
      name,
      email,
      roleId: role._id,
      isActive: true,
      emailVerified: true,
    },
  };

  if (process.env.ADMIN_PASSWORD) {
    if (String(process.env.ADMIN_PASSWORD).length < 8) {
      throw new Error("ADMIN_PASSWORD must be at least 8 characters long");
    }

    update.$set.passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  }

  const user = await User.findOneAndUpdate({ email }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  await Wallet.updateMany(
    { userId: user._id, isPrimary: true, address: { $ne: walletAddress } },
    { $set: { isPrimary: false } }
  );

  await Wallet.findOneAndUpdate(
    { chain: "solana", address: walletAddress },
    {
      $set: {
        userId: user._id,
        address: walletAddress,
        chain: "solana",
        label: "Admin wallet",
        isPrimary: true,
        isVerified: true,
        verifiedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await user.populate(["roleId", "primaryWallet"]);

  const totalUsers = await User.countDocuments();
  const totalAdmins = await User.countDocuments({ roleId: role._id });

  console.log(`\nAdmin account seeded into database: ${dbName}`);
  console.log(`Name: ${user.name}`);
  console.log(`Email: ${user.email}`);
  console.log(`Role: ${user.roleId?.name || "admin"}`);
  console.log(`Wallet: ${walletAddress}`);
  console.log(`Total users: ${totalUsers}`);
  console.log(`Total admins: ${totalAdmins}`);

  if (keypair) {
    console.log("\nDEV ONLY generated wallet. Import this secret key into a devnet wallet:");
    console.log(`Secret key: ${bs58.encode(keypair.secretKey)}`);
    console.log("Never use this key on mainnet.");
  } else {
    console.log("\nSign in with the wallet that controls the address above.");
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error("Admin seed failed:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
