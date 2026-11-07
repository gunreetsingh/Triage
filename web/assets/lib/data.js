/* Data loading and scoring. scoreThemes is a port of triage/score.py, so the
 * filters re-rank themes exactly as the pipeline would. */
import { DAY, clamp } from "./util.js";

export const state = {
  manifest: null,
  cache: new Map(),
  live: new Map(),
};

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  return res.json();
}

export async function loadManifest() {
  if (!state.manifest) state.manifest = await getJSON("data/apps.json");
  return state.manifest;
}

// --------------------------------------------------------------------------
// live reports (the Vercel deployment): built in the browser, never saved on
// the server, so they're kept for this tab in sessionStorage.
// --------------------------------------------------------------------------
const LIVE_KEY = "triage-live:";
export const isLiveSlug = (slug) => /^live-\d{1,12}-[a-z]{2}$/.test(slug);

export function saveLive(raw) {
  state.cache.delete(raw.slug);
  state.live.set(raw.slug, raw);
  try { sessionStorage.setItem(LIVE_KEY + raw.slug, JSON.stringify(raw)); } catch { /* full or blocked: memory only */ }
}

function liveRaw(slug) {
  if (state.live.has(slug)) return state.live.get(slug);
  try {
    const raw = JSON.parse(sessionStorage.getItem(LIVE_KEY + slug) || "null");
    if (raw) state.live.set(slug, raw);
    return raw;
  } catch {
    return null;
  }
}

/** The manifest entry for a built report, or a stand-in for a live one. */
export async function findApp(slug) {
  if (isLiveSlug(slug)) {
    const raw = liveRaw(slug);
    return raw && { slug, name: raw.name, icon: raw.icon, brand: raw.brand, market: raw.market };
  }
  return (await loadManifest()).apps.find((a) => a.slug === slug) || null;
}

export async function loadApp(slug) {
  if (state.cache.has(slug)) return state.cache.get(slug);
  const raw = isLiveSlug(slug) ? liveRaw(slug) : await getJSON(`data/apps/${encodeURIComponent(slug)}.json`);
  if (!raw) throw new Error("This report was made in another tab or has expired. Search for the app again.");
  let minTs = Infinity;
  let maxTs = -Infinity;
  const present = new Set();
  for (const r of raw.reviews) {
    if (r.ts < minTs) minTs = r.ts;
    if (r.ts > maxTs) maxTs = r.ts;
    present.add(r.p);
  }
  const app = {
    ...raw,
    minTs,
    maxTs,
    themeMeta: new Map(raw.themes.map((t) => [t.id, t])),
    platforms: ["iOS", "Android"].filter((p) => present.has(p)),
  };
  state.cache.set(slug, app);
  return app;
}

export const POSITIVE_AT = 3.75; // themes averaging this or better read as praise

export const RANKINGS = {
  balanced: { reach: 0.5, pain: 0.5, label: "Balanced" },
  volume: { reach: 0.8, pain: 0.2, label: "Most mentioned" },
  severity: { reach: 0.2, pain: 0.8, label: "Most severe" },
};

// Status palette (fixed, never themed) + a distinct shape per tier, so the
// tier never depends on color alone.
export const TIERS = {
  critical: { label: "Critical", color: "var(--critical)", hex: "#e0301e", ink: "#fff8ec",
    icon: '<path class="f" d="M6 .6 11.4 6 6 11.4.6 6Z"/>' },
  high: { label: "High", color: "var(--serious)", hex: "#f07a1a", ink: "#15130f",
    icon: '<path class="f" d="M6 1.2 11.2 10.6H.8Z"/>' },
  medium: { label: "Medium", color: "var(--warning)", hex: "#e3aa00", ink: "#15130f",
    icon: '<circle class="f" cx="6" cy="6" r="4.8"/>' },
  low: { label: "Low", color: "var(--low)", hex: "#978e7b", ink: "#15130f",
    icon: '<rect class="f" x=".8" y="4.4" width="10.4" height="3.2" rx="1.6"/>' },
  positive: { label: "Positive", color: "var(--good)", hex: "#138a4b", ink: "#fff8ec",
    icon: '<path class="s" d="M1.8 6.4 4.6 9.2 10.2 2.8"/>' },
};
export const TIER_ORDER = Object.keys(TIERS);

export function tierOf(priority, avg) {
  if (avg >= POSITIVE_AT) return "positive";
  if (priority >= 75) return "critical";
  if (priority >= 60) return "high";
  if (priority >= 45) return "medium";
  return "low";
}

export const tierIcon = (key) =>
  `<svg viewBox="0 0 12 12" aria-hidden="true" style="--tc:${TIERS[key].color}">${TIERS[key].icon}</svg>`;

export const tierChip = (key) =>
  `<span class="tier" style="--tc:${TIERS[key].color}">${tierIcon(key)}<span>${TIERS[key].label}</span></span>`;

export function scoreThemes(reviews, themeMeta, weights, anchorTs) {
  const buckets = new Map();
  for (const r of reviews) {
    if (!buckets.has(r.c)) buckets.set(r.c, []);
    buckets.get(r.c).push(r);
  }
  if (!buckets.size) return [];

  let total = 0;
  let maxN = 0;
  for (const list of buckets.values()) {
    total += list.length;
    maxN = Math.max(maxN, list.length);
  }
  const recentCutoff = anchorTs - 90 * DAY;

  const themes = [];
  for (const [id, members] of buckets) {
    const n = members.length;
    let sum = 0;
    let recent = 0;
    let low = 0;
    const dist = [0, 0, 0, 0, 0];
    const platforms = {};
    for (const r of members) {
      sum += r.r;
      dist[r.r - 1] += 1;
      platforms[r.p] = (platforms[r.p] || 0) + 1;
      if (r.ts >= recentCutoff) recent += 1;
      if (r.r <= 2) low += 1;
    }
    const avg = sum / n;
    const reach = n / maxN;
    const pain = clamp((5 - avg) / 4, 0, 1);
    const priority = Math.round(100 * (weights.reach * reach + weights.pain * pain) * 10) / 10;
    const meta = themeMeta.get(id) || {};
    themes.push({
      id, n, avg, reach, pain, priority, dist, platforms, low,
      share: n / total,
      recent: recent / n,
      reviews: members,
      label: meta.label || `Theme ${id}`,
      summary: meta.summary || "",
      recommendation: meta.recommendation || "",
      kw: meta.kw || [],
      tier: tierOf(priority, avg),
    });
  }
  themes.sort((a, b) => b.priority - a.priority || b.n - a.n);
  return themes;
}

export const DEFAULT_FILTERS = { platform: "all", period: "all", rank: "balanced", problems: false };

export function computeView(app, f = DEFAULT_FILTERS) {
  let reviews = app.reviews;
  if (f.platform !== "all") reviews = reviews.filter((r) => r.p === f.platform);
  if (f.period !== "all") {
    const cutoff = app.maxTs - Number(f.period) * DAY;
    reviews = reviews.filter((r) => r.ts >= cutoff);
  }
  const all = scoreThemes(reviews, app.themeMeta, RANKINGS[f.rank], app.maxTs);
  const themes = f.problems ? all.filter((t) => t.tier !== "positive") : all;
  themes.forEach((t, i) => { t.rank = i + 1; });
  return { reviews, themes, all };
}

/** Forget cached data so a newly analyzed app shows up. */
export function invalidate(slug) {
  state.manifest = null;
  if (slug) state.cache.delete(slug);
}

// --------------------------------------------------------------------------
// live analysis API. server.py (mode "server") queues jobs and saves reports;
// vercel_app.py (mode "live") collects reviews and themes on request and the
// browser builds the report. On a plain static host neither exists, and the
// site sticks to the apps it was built with.
// --------------------------------------------------------------------------
async function apiFetch(path, init) {
  const res = await fetch(path, { cache: "no-store", ...init });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(body?.detail && typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const api = {
  available: null, // null = not checked yet
  info: null,
  async check() {
    if (this.available !== null) return this.available;
    try {
      this.info = await apiFetch("api/health");
      this.available = Boolean(this.info?.ok);
    } catch {
      this.available = false;
    }
    return this.available;
  },
  search(q, country, signal) {
    return apiFetch(`api/search?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`, { signal });
  },
  analyze(iosId, country) {
    return apiFetch("api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ios_id: String(iosId), country }),
    });
  },
  job(id) {
    return apiFetch(`api/jobs/${encodeURIComponent(id)}`);
  },
  get live() { return this.info?.mode === "live"; },
  collect(iosId, country) {
    return apiFetch("api/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ios_id: String(iosId), country }),
    });
  },
  themes(name, reviews, token) {
    return apiFetch("api/themes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, reviews, token }),
    });
  },
};
