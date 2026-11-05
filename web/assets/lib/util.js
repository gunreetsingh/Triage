/* Small shared helpers. Every string that came from a review, a store listing
 * or a model goes through esc() before it reaches innerHTML. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
/** 0 below a, 1 above b, smooth in between. */
export const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Linear 0..1 position of x within [a, b]. */
export const span = (a, b, x) => clamp((x - a) / (b - a), 0, 1);
export const ease = {
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
};

export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
export const coarsePointer = window.matchMedia("(pointer: coarse)");

export const DAY = 86400;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const int = (n) => Math.round(n).toLocaleString("en-US");
export const pct = (x) => `${Math.round(x * 100)}%`;
export const pad2 = (n) => String(n).padStart(2, "0");
export const utc = (ts) => new Date(ts * 1000);
export const fmtDate = (ts) => { const d = utc(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };
export const fmtMonthYear = (ts) => { const d = utc(ts); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const starsText = (r) => "★".repeat(Math.round(r)) + "☆".repeat(5 - Math.round(r));
export const firstSentence = (s) => ((s || "").match(/^.*?[.!?](\s|$)/) || [s || ""])[0].trim();
export const compact = (n) => (n >= 1e7 ? `${Math.round(n / 1e6)}M` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 10000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

const MARKETS = {
  us: "United States", ca: "Canada", gb: "United Kingdom", au: "Australia", in: "India",
  de: "Germany", fr: "France", jp: "Japan", ie: "Ireland", nz: "New Zealand",
};
export const marketName = (cc) => MARKETS[cc] || String(cc || "").toUpperCase();

export function safeStoreUrl(raw) {
  try {
    const url = new URL(raw);
    const trusted = /(^|\.)(apple\.com|google\.com)$/.test(url.hostname);
    return url.protocol === "https:" && trusted ? url.href : null;
  } catch {
    return null;
  }
}

/** Icon paths come from our own export ("data/icons/<slug>.png"); refuse anything else. */
export const safeIcon = (p) => (typeof p === "string" && /^data\/icons\/[a-z0-9-]+\.png$/.test(p) ? p : null);

export function appIcon(app, cls = "app-icon", { alt = "" } = {}) {
  const src = safeIcon(app.icon);
  const initial = esc((app.name || "?").trim().charAt(0).toUpperCase());
  return src
    ? `<img class="${cls}" src="${src}" alt="${esc(alt)}" decoding="async" draggable="false">`
    : `<span class="${cls} app-icon--letter" aria-hidden="true">${initial}</span>`;
}

export const brandOf = (app) => (/^#[0-9a-f]{6}$/i.test(app?.brand || "") ? app.brand : null);

export function niceTicks(max, count) {
  const raw = Math.max(max, 1) / count;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * 10 ** exp;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v));
  return { ticks, max: top };
}

/** Deterministic PRNG so particle layouts are identical on every visit. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Read a CSS custom property off :root as an [r,g,b] triple. */
export function cssRgb(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v.startsWith("#")) return hexToRgb(v);
  const m = v.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
}

// Dark is the default; light only when the viewer has chosen it.
export const isDark = () => document.documentElement.dataset.theme === "dark";

/** Ink that stays readable on top of a given brand color. */
export function inkOn(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? "#0b0b0b" : "#ffffff";
}
