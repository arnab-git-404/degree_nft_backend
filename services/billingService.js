import mongoose from "mongoose";
import BillingEntry, { BILLING_CURRENCIES } from "../models/billingEntry.js";
import PlatformSetting from "../models/platformSetting.js";
import { chain } from "../utils/chain.js";

// The global price per credential, in base units: { SOL: lamports | null, USDC: micro-USDC | null }.
export const getPrices = async () => {
  const settings = await PlatformSetting.findOne({ key: "platform" }).lean();
  return { SOL: settings?.billing?.priceSol ?? null, USDC: settings?.billing?.priceUsdc ?? null };
};

// A college's balances, in base units, from the ledger.
export const getBalances = async (institutionId) => {
  const rows = await BillingEntry.aggregate([
    { $match: { institutionId: new mongoose.Types.ObjectId(String(institutionId)) } },
    { $group: { _id: "$currency", total: { $sum: "$amount" } } },
  ]);
  return Object.fromEntries(BILLING_CURRENCIES.map((currency) => [currency, rows.find((row) => row._id === currency)?.total ?? 0]));
};

// Which balance pays for the next mint: USDC first (stable price), then SOL. null = cannot pay.
export const pickPayment = (balances, prices) => {
  for (const currency of ["USDC", "SOL"]) {
    if (prices[currency] && balances[currency] >= prices[currency]) return { currency, amount: prices[currency] };
  }
  return null;
};

// Credits new on-chain payments from the college's registered wallet. Safe to run any number of times.
export const syncDeposits = async (institution) => {
  const deposits = await chain.findDeposits({ from: institution.walletAddress });
  const added = [];
  for (const deposit of deposits) {
    try {
      added.push(
        await BillingEntry.create({
          institutionId: institution._id,
          currency: deposit.currency,
          kind: "DEPOSIT",
          amount: deposit.amount,
          signature: deposit.signature,
          fromWallet: deposit.from,
          note: "On-chain payment to the DegreeNFT treasury",
        }),
      );
    } catch (error) {
      if (error.code !== 11000) throw error; // already credited
    }
  }
  return added;
};
