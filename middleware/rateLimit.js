import mongoose from "mongoose";
import AppError from "../utils/AppError.js";
import asyncHandler from "../utils/asyncHandler.js";

// Counters live in MongoDB, not in memory: on Vercel each request may hit a different instance.
// One document per (bucket, IP, time window); MongoDB deletes it after the window (TTL index).
const RateLimitHit = mongoose.model(
  "RateLimitHit",
  new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    expireAt: { type: Date, required: true, index: { expires: 0 } },
  }),
);

/**
 * At most `max` requests per `windowSeconds` per client IP for this bucket; then 429 with Retry-After.
 * RATE_LIMIT_DISABLED=true turns it off (tests).
 */
export const rateLimit = ({ bucket, max, windowSeconds = 60 }) =>
  asyncHandler(async (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === "true") return next();
    const windowMs = windowSeconds * 1000;
    const window = Math.floor(Date.now() / windowMs);
    const key = `${bucket}:${req.ip}:${window}`;
    const update = { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date((window + 1) * windowMs + 60_000) } };
    let hit;
    try {
      hit = await RateLimitHit.findOneAndUpdate({ key }, update, { upsert: true, new: true });
    } catch (error) {
      if (error.code !== 11000) throw error;
      hit = await RateLimitHit.findOneAndUpdate({ key }, update, { new: true }); // two first requests raced on the upsert
    }
    if (hit.count > max) {
      res.set("Retry-After", String(Math.ceil(((window + 1) * windowMs - Date.now()) / 1000)));
      throw new AppError("Too many requests. Please wait a moment and try again.", 429, "RATE_LIMITED");
    }
    next();
  });
