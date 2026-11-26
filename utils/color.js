// Default colour for a new record: hue steps by the golden angle at fixed saturation/lightness,
// so different seeds (a year, a hashed code) get clearly different, pleasant colours.
// Mirrored in degree_nft_frontend/src/lib/admin.js for the form preview; keep both in sync.
export function colorFromSeed(seed) {
  const hue = (seed * 137.508) % 360;
  const [s, l] = [0.65, 0.5];
  const a = s * Math.min(l, 1 - l);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// Stable number from a text (e.g. a program code) to use as a seed.
export const hashString = (text) => [...String(text)].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
