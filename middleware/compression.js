import compression from "compression";
import mongoose from "mongoose";
import PlatformSetting from "../models/platformSetting.js";

export const DEFAULT_GZIP_LEVEL = 6;
const REFRESH_MS = 60_000;

// One compressor per level (1–9), built once.
const compressors = Array.from({ length: 9 }, (_, index) => compression({ level: index + 1 }));
let level = DEFAULT_GZIP_LEVEL;
let checkedAt = 0;

// Called after the Super Admin saves, so this server switches at once.
export const setGzipLevel = (value) => {
  level = value;
  checkedAt = Date.now();
};

// shortcut: other server instances re-read the level at most once a minute; push it (pub/sub) if instant change is ever needed.
const refresh = () => {
  if (mongoose.connection.readyState !== 1) return;
  checkedAt = Date.now();
  PlatformSetting.findOne({ key: "platform" })
    .select("performance")
    .lean()
    .then((settings) => {
      level = settings?.performance?.gzipLevel || DEFAULT_GZIP_LEVEL;
    })
    .catch(() => {});
};

// Gzips responses over 1 KB for clients that send Accept-Encoding: gzip, at the level set in Admin → Settings.
export function gzip(req, res, next) {
  if (Date.now() - checkedAt > REFRESH_MS) refresh();
  compressors[level - 1](req, res, next);
}
