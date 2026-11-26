import mongoose from "mongoose";
import PlatformSetting from "../models/platformSetting.js";
import Institution from "../models/institution.js";
import CollegeChain from "../models/collegeChain.js";
import BillingEntry, { UNITS } from "../models/billingEntry.js";
import { getBalances, getPrices, syncDeposits } from "../services/billingService.js";
import { chain, network, treasuryAddress, usdcMint, assertSigningAllowed, signingLocked, FEE_PAYER_MIN_LAMPORTS } from "../utils/chain.js";
import { encryptSecret } from "../utils/secretBox.js";
import { audit } from "../utils/audit.js";
import AppError from "../utils/AppError.js";
import { isValidSolanaAddress } from "../utils/solanaAuth.js";
import asyncHandler from "../utils/asyncHandler.js";

const DECIMALS = { SOL: 9, USDC: 6 };

// "0.05" SOL -> 50000000 lamports, without floating-point rounding.
export const toUnits = (value, currency) => {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new AppError(`${currency} price must be a positive number`, 400);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > DECIMALS[currency]) throw new AppError(`${currency} price has too many decimal places`, 400);
  const units = Number(whole) * UNITS[currency] + Number(fraction.padEnd(DECIMALS[currency], "0"));
  if (!Number.isSafeInteger(units) || units <= 0) throw new AppError(`${currency} price must be greater than 0`, 400);
  return units;
};

const optional = (read) => {
  try {
    return read();
  } catch {
    return null;
  }
};

const publicChain = (record) =>
  record && {
    network: record.network,
    collectionAddress: record.collectionAddress,
    setupSignature: record.setupSignature,
    createdAt: record.createdAt,
    mintingAddress: record.keys?.minting?.address,
    multisig: record.multisig && {
      address: record.multisig.address,
      vault: record.multisig.vault,
      threshold: record.multisig.threshold,
      members: record.multisig.members,
    },
  };

// ---------------------------------------------------------------- Super Admin

export const getBillingSettings = asyncHandler(async (req, res) => {
  let feePayer = null;
  try {
    feePayer = await chain.feePayerBalance();
    feePayer.low = feePayer.lamports < FEE_PAYER_MIN_LAMPORTS * 10; // warn well before claims pause
    feePayer.pauseBelowSol = FEE_PAYER_MIN_LAMPORTS / 1e9;
  } catch (error) {
    feePayer = { error: error.message };
  }
  res.status(200).json({
    success: true,
    prices: await getPrices(),
    network: network(),
    treasuryAddress: optional(treasuryAddress),
    usdcMint: usdcMint(),
    feePayer,
    writesLocked: signingLocked(),
  });
});

export const updateBillingSettings = asyncHandler(async (req, res) => {
  const priceSol = toUnits(req.body?.priceSol, "SOL");
  const priceUsdc = toUnits(req.body?.priceUsdc, "USDC");
  const settings = (await PlatformSetting.findOne({ key: "platform" })) || new PlatformSetting({ key: "platform" });
  const before = { priceSol: settings.billing?.priceSol, priceUsdc: settings.billing?.priceUsdc };
  settings.billing = { priceSol, priceUsdc };
  settings.updatedBy = req.user._id;
  await settings.save();
  await audit(req, {
    action: "admin.settings.billing.update",
    targetType: "PlatformSetting",
    targetId: settings._id,
    summary: `Set the credential price to ${priceSol / UNITS.SOL} SOL / ${priceUsdc / UNITS.USDC} USDC`,
    details: { before, after: { priceSol, priceUsdc } },
  });
  res.status(200).json({ success: true, prices: await getPrices() });
});

export const getInstitutionChain = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.institutionId)) throw new AppError("Invalid institution id", 400);
  const record = await CollegeChain.findOne({ institutionId: req.params.institutionId });
  res.status(200).json({ success: true, chain: publicChain(record) });
});

// Creates the college's Metaplex Core collection. Irreversible: its permissions can never be changed afterwards.
export const setupInstitutionChain = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.institutionId)) throw new AppError("Invalid institution id", 400);
  const institution = await Institution.findById(req.params.institutionId);
  if (!institution) throw new AppError("Institution not found", 404);
  if (institution.verificationStatus !== "VERIFIED" || institution.status !== "ACTIVE") {
    throw new AppError("Only a verified, active college can be set up on-chain", 409);
  }
  // The college officials who will approve recoveries and burns (their wallets), and how many must agree.
  const members = Array.isArray(req.body?.members) ? [...new Set(req.body.members.map((member) => String(member).trim()).filter(Boolean))] : [];
  if (members.length < 2 || members.length > 10) throw new AppError("Give 2 to 10 different official wallets", 400);
  const invalid = members.find((member) => !isValidSolanaAddress(member));
  if (invalid) throw new AppError(`Not a valid Solana wallet: ${invalid}`, 400);
  const threshold = req.body?.threshold === undefined ? 2 : Number(req.body.threshold);
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > members.length) {
    throw new AppError(`Approvals needed must be between 2 and ${members.length}`, 400);
  }
  assertSigningAllowed(); // before anything: Mainnet stays locked until key custody is approved
  if (await CollegeChain.exists({ institutionId: institution._id })) {
    throw new AppError("This college already has an on-chain collection", 409);
  }

  const minting = chain.newKeypair();
  const multisig = await chain.createMultisig({ members, threshold });
  const { collectionAddress, signature } = await chain.createCollection({
    name: institution.name.slice(0, 32),
    uri: `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/verify?college=${encodeURIComponent(institution.code)}`,
    mintingAddress: minting.address,
    vaultAddress: multisig.vaultAddress,
  });

  const record = await CollegeChain.create({
    institutionId: institution._id,
    network: network(),
    collectionAddress,
    setupSignature: signature,
    keys: { minting: { address: minting.address, secretEncrypted: encryptSecret(minting.secret) } },
    multisig: { address: multisig.multisigAddress, vault: multisig.vaultAddress, threshold, members },
    createdBy: req.user._id,
  });

  await audit(req, {
    action: "admin.institution.chain.setup",
    targetType: "Institution",
    targetId: institution._id,
    institutionId: institution._id,
    summary: `Created the ${network()} credential collection for ${institution.name}`,
    details: { collectionAddress, signature, multisig: multisig.multisigAddress, threshold, members },
  });
  res.status(201).json({ success: true, chain: publicChain(record) });
});

// ---------------------------------------------------------------- College

export const getCollegeBilling = asyncHandler(async (req, res) => {
  const institutionId = req.institution._id;
  const [record, balances, prices, entries] = await Promise.all([
    CollegeChain.findOne({ institutionId }),
    getBalances(institutionId),
    getPrices(),
    BillingEntry.find({ institutionId }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  res.status(200).json({
    success: true,
    chain: publicChain(record),
    balances,
    prices,
    network: network(),
    treasuryAddress: optional(treasuryAddress),
    usdcMint: usdcMint(),
    payFromWallet: req.institution.walletAddress,
    entries,
  });
});

export const syncCollegeDeposits = asyncHandler(async (req, res) => {
  const added = await syncDeposits(req.institution);
  if (added.length) {
    await audit(req, {
      action: "institution.billing.deposit",
      scope: "INSTITUTION",
      targetType: "Institution",
      targetId: req.institution._id,
      summary: `Credited ${added.length} new payment${added.length > 1 ? "s" : ""}`,
      details: { signatures: added.map((entry) => entry.signature) },
    });
  }
  res.status(200).json({ success: true, added: added.length, balances: await getBalances(req.institution._id) });
});
