/* ⌘K / Ctrl+K / "/" - search any app.
 *
 * Apps that already have a report open straight away. When the Triage server
 * is running, typing also searches the whole App Store; picking an app that
 * hasn't been analyzed starts an analysis and opens its progress page. On a
 * plain static host it falls back to the apps the site was built with.
 * A combobox: typing filters, arrows move, Enter goes. */
import { $, $$, esc, appIcon, brandOf } from "./util.js";
import { loadManifest, tierOf, tierChip, api } from "./data.js";
import { scroller } from "./motion.js";

const MARKETS = [["us", "US"], ["ca", "Canada"], ["gb", "UK"], ["au", "Australia"], ["in", "India"], ["ie", "Ireland"], ["nz", "NZ"]];

let manifest = { apps: [] };
let selectable = [];
let active = 0;
let returnFocus = null;
let market = "us";
let live = { state: "idle", results: [], error: "", query: "" };
let timer = 0;
let ctrl = null;
let busy = false;

// Store reviews differ by country, so default to the visitor's own store.
const localMarket = () => {
  const cc = (navigator.language || "").split("-")[1]?.toLowerCase();
  return MARKETS.some(([c]) => c === cc) ? cc : "us";
};
try { market = localStorage.getItem("triage-market") || localMarket(); } catch { market = localMarket(); }
if (!MARKETS.some(([cc]) => cc === market)) market = "us";

const root = () => $(".palette");
const input = () => $(".palette-input");
const list = () => $(".palette-list");
export const isPaletteOpen = () => root().classList.contains("open");

const storeIcon = (url) => (/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//.test(url || "")
  ? `<img class="pal-icon" src="${esc(url)}" alt="" decoding="async" referrerpolicy="no-referrer">`
  : '<span class="pal-glyph" aria-hidden="true">?</span>');

function localItems(q) {
  const score = (a) => {
    const name = a.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : (a.top_issue?.label || "").toLowerCase().includes(q) ? 2 : 9;
  };
  const apps = q ? manifest.apps.filter((a) => score(a) < 9).sort((a, b) => score(a) - score(b)) : manifest.apps;
  return apps.map((a) => {
    const t = a.top_issue;
    return {
      kind: "link",
      href: `#/app/${encodeURIComponent(a.slug)}`,
      key: `${a.ios_id}:${a.market}`,
      title: a.name,
      sub: t ? `Fix first: ${t.label}` : `${a.reviews} reviews`,
      brand: brandOf(a),
      iconHTML: appIcon(a, "pal-icon"),
      right: t ? tierChip(tierOf(t.priority, t.avg_rating)) : "",
    };
  });
}

function storeItems(shownKeys) {
  return live.results
    .filter((r) => !shownKeys.has(`${r.ios_id}:${market}`))
    .map((r) => ({
      kind: r.slug ? "link" : "analyze",
      href: r.slug ? `#/app/${encodeURIComponent(r.slug)}` : null,
      iosId: r.ios_id,
      pick: { name: r.name, publisher: r.publisher, icon: r.icon },
      title: r.title || r.name,
      sub: [r.publisher, r.ratings ? `${r.rating.toFixed(1)}★ · ${r.ratings.toLocaleString("en-US")} ratings` : "No ratings yet"].filter(Boolean).join(" · "),
      iconHTML: storeIcon(r.icon),
      right: r.slug ? '<span class="pal-tag ready">Open report</span>' : '<span class="pal-tag">Analyze <span aria-hidden="true">→</span></span>',
    }));
}

function render() {
  const q = input().value.trim().toLowerCase();
  const local = localItems(q);
  const shownKeys = new Set(local.map((i) => i.key));
  const store = api.available ? storeItems(shownKeys) : [];
  const home = !q ? [{ kind: "link", href: "#/", title: "Home", sub: "The story, from raw reviews to a ranked backlog", iconHTML: '<span class="pal-glyph" aria-hidden="true">↺</span>' }] : [];

  selectable = [...home, ...local, ...store];
  active = Math.min(active, Math.max(0, selectable.length - 1));

  let i = 0;
  const row = (it) => `
    <li id="pal-${i}" role="option" aria-selected="${i === active}" data-k="${i++}" style="--brand:${it.brand || "var(--accent)"}">
      ${it.iconHTML}
      <span class="pal-main"><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span>
      ${it.right || ""}
    </li>`;
  const group = (label) => `<li class="pal-group" role="presentation">${label}</li>`;

  let html = home.map(row).join("");
  if (local.length) html += group(q ? "Ready to open" : `Analyzed · ${manifest.apps.length}`) + local.map(row).join("");

  if (api.available) {
    if (q.length >= 2) {
      html += group(`From the App Store · ${esc(MARKETS.find(([cc]) => cc === market)[1])}`);
      if (live.state === "loading" && !store.length) html += '<li class="pal-status" role="presentation"><span class="pal-spin"></span>Searching the App Store…</li>';
      html += store.map(row).join("");
      if (live.state === "done" && !store.length && !local.length) html += `<li class="pal-status" role="presentation">No apps called “${esc(input().value.trim())}” in this market.</li>`;
    } else if (!q) {
      html += '<li class="pal-status hint" role="presentation">Type any app name to search the whole App Store.</li>';
    }
  } else if (q && !local.length) {
    html += `<li class="pal-status" role="presentation">No analyzed app matches “${esc(input().value.trim())}”.</li>`;
  }
  if (live.state === "error") html += `<li class="pal-status error" role="alert">${esc(live.error)}</li>`;

  list().innerHTML = html;
  input().setAttribute("aria-activedescendant", selectable.length ? `pal-${active}` : "");
  $$("li[data-k]", list()).forEach((li) => {
    const k = Number(li.dataset.k);
    li.addEventListener("pointermove", () => { if (active !== k) { active = k; mark(); } });
    li.addEventListener("click", () => choose(selectable[k]));
  });
}

function mark() {
  $$("li[data-k]", list()).forEach((li) => li.setAttribute("aria-selected", String(Number(li.dataset.k) === active)));
  input().setAttribute("aria-activedescendant", `pal-${active}`);
  $(`#pal-${active}`)?.scrollIntoView({ block: "nearest" });
}

function scheduleSearch() {
  clearTimeout(timer);
  ctrl?.abort();
  const q = input().value.trim();
  if (!api.available || q.length < 2) {
    live = { state: "idle", results: [], error: "", query: q };
    render();
    return;
  }
  live = { ...live, state: "loading", error: "" };
  render();
  timer = setTimeout(async () => {
    ctrl = new AbortController();
    try {
      const res = await api.search(q, market, ctrl.signal);
      if (input().value.trim() !== q) return;
      live = { state: "done", results: res.results || [], error: "", query: q };
    } catch (e) {
      if (e.name === "AbortError") return;
      live = { state: "error", results: [], error: e.message || "Search failed.", query: q };
    }
    render();
  }, 260);
}

async function choose(it) {
  if (!it || busy) return;
  if (it.kind === "link") { go(it.href); return; }
  if (api.live) {
    // Vercel: the progress page runs the analysis itself; hand it what we know.
    try { sessionStorage.setItem(`triage-pick:${it.iosId}`, JSON.stringify(it.pick)); } catch { /* optional */ }
    go(`#/live/${encodeURIComponent(it.iosId)}/${market}`);
    return;
  }
  busy = true;
  live = { ...live, state: "loading" };
  try {
    const res = await api.analyze(it.iosId, market);
    go(res.status === "done" && res.slug ? `#/app/${encodeURIComponent(res.slug)}` : `#/analyze/${encodeURIComponent(res.id)}`);
  } catch (e) {
    live = { ...live, state: "error", error: e.message || "Couldn't start the analysis." };
    render();
  } finally {
    busy = false;
  }
}

function go(href) {
  closePalette();
  if (location.hash !== href) location.hash = href;
}

export async function openPalette() {
  if (isPaletteOpen()) return;
  [manifest] = await Promise.all([loadManifest(), api.check()]);
  returnFocus = document.activeElement;
  input().value = "";
  input().placeholder = api.available ? "Search any app…" : "Jump to an app…";
  $(".palette-market").hidden = !api.available;
  $(".palette-market").value = market;
  active = 0;
  live = { state: "idle", results: [], error: "", query: "" };
  render();
  root().classList.add("open");
  root().setAttribute("aria-hidden", "false");
  scroller.stop();
  requestAnimationFrame(() => input().focus());
}

export function closePalette() {
  if (!isPaletteOpen()) return;
  root().classList.remove("open");
  root().setAttribute("aria-hidden", "true");
  scroller.start();
  clearTimeout(timer);
  ctrl?.abort();
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

export function initPalette() {
  const select = $(".palette-market");
  select.innerHTML = MARKETS.map(([cc, label]) => `<option value="${cc}">${label}</option>`).join("");
  select.addEventListener("change", () => {
    market = select.value;
    try { localStorage.setItem("triage-market", market); } catch { /* not persisted */ }
    scheduleSearch();
    input().focus();
  });
  input().addEventListener("input", () => { active = 0; scheduleSearch(); });
  input().addEventListener("keydown", (e) => {
    const n = Math.max(1, selectable.length);
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % n; mark(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + n) % n; mark(); }
    else if (e.key === "Enter") { e.preventDefault(); choose(selectable[active]); }
  });
  $(".palette-scrim").addEventListener("click", closePalette);
  document.addEventListener("click", (e) => {
    if (e.target.closest?.("[data-palette]")) { e.preventDefault(); openPalette(); }
  });
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches?.("input, select, textarea");
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      isPaletteOpen() ? closePalette() : openPalette();
    } else if (e.key === "/" && !typing && !isPaletteOpen()) {
      e.preventDefault();
      openPalette();
    } else if (e.key === "Escape" && isPaletteOpen()) {
      e.preventDefault();
      closePalette();
    }
  });
}
