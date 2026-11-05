/* The theme drawer: the theme's summary and fix, the theme's rating mix and
 * platform split, and every review behind it (searchable, sortable). Each
 * theme has its own URL (#/app/<slug>/<id>), so findings can be linked. */
import { $, $$, esc, int, pct, fmtDate, starsText, appIcon, brandOf } from "./util.js";
import { tierChip } from "./data.js";
import { drawRatings, hideTip, PLATFORM_COLOR } from "./charts.js";
import { scroller } from "./motion.js";

export const drawerContext = { app: null, view: null };

const el = () => $(".drawer");
const backdrop = () => $(".drawer-backdrop");
let current = null; // { returnFocus, pushed, themeId, query, sort, limit, observers }

const ICON = {
  prev: '<svg viewBox="0 0 24 24"><path d="m14.5 6-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="m9.5 6 6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.6 17.2a1.9 1.9 0 0 0 2.7 2.7l5.7-5.7a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.5-.5-2.4Z"/></svg>',
};

export const isDrawerOpen = () => el().classList.contains("open");

function segHTML(id, label, options, value) {
  return `<div class="seg" id="${id}" role="group" aria-label="${label}">
    <span class="seg-thumb" aria-hidden="true"></span>
    ${options.map(([v, text]) => `<button type="button" data-v="${v}" aria-pressed="${v === value}">${text}</button>`).join("")}
  </div>`;
}

export function bindSeg(seg, onChange, observers) {
  const thumb = $(".seg-thumb", seg);
  const buttons = $$("button", seg);
  const place = () => {
    const active = buttons.find((b) => b.getAttribute("aria-pressed") === "true");
    if (!active || !thumb) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  };
  buttons.forEach((b) => b.addEventListener("click", () => {
    if (b.getAttribute("aria-pressed") === "true") return;
    buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    place();
    onChange(b.dataset.v);
  }));
  requestAnimationFrame(place);
  document.fonts?.ready.then(place);
  const ro = new ResizeObserver(place);
  ro.observe(seg);
  observers?.push(ro);
  return ro;
}

function drawerHTML(app, t, v) {
  const idx = v.themes.findIndex((x) => x.id === t.id);
  const prev = idx > 0 ? v.themes[idx - 1] : null;
  const next = idx >= 0 && idx < v.themes.length - 1 ? v.themes[idx + 1] : null;
  const platforms = app.platforms.filter((p) => t.platforms[p]);
  return `
    <div class="drawer-head">
      <div class="drawer-crumbs">
        ${appIcon(app, "drawer-icon")}
        <span class="drawer-app">${esc(app.name)}</span>
        ${tierChip(t.tier)}
        <span class="muted">${idx >= 0 ? `#${t.rank} of ${v.themes.length}` : "Positive theme"}</span>
      </div>
      <div class="drawer-actions">
        <button class="icon-btn" type="button" ${prev ? `data-goto="${prev.id}"` : "disabled"} aria-label="Previous theme">${ICON.prev}</button>
        <button class="icon-btn" type="button" ${next ? `data-goto="${next.id}"` : "disabled"} aria-label="Next theme">${ICON.next}</button>
        <button class="icon-btn" type="button" data-close aria-label="Close">${ICON.close}</button>
      </div>
    </div>
    <div class="drawer-scroll" data-lenis-prevent>
      <h2 class="drawer-title" id="drawer-title">${esc(t.label)}</h2>
      <div class="drawer-stats">
        <div><b>${Math.round(t.priority)}</b><span>Priority</span></div>
        <div><b>${int(t.n)}</b><span>${pct(t.share)} of reviews</span></div>
        <div><b>${t.avg.toFixed(1)}★</b><span>Average rating</span></div>
        <div><b>${pct(t.recent)}</b><span>Last 90 days</span></div>
      </div>
      ${t.summary ? `<div class="drawer-block"><h3>What users are saying</h3><p>${esc(t.summary)}</p></div>` : ""}
      ${t.recommendation ? `<div class="fix"><span class="fix-icon">${ICON.wrench}</span><div><p class="eyebrow">Recommended fix</p><p>${esc(t.recommendation)}</p></div></div>` : ""}
      <div class="drawer-grid">
        <div class="mini"><h3>Ratings in this theme</h3><div class="chart" id="d-ratings"></div></div>
        <div class="mini">
          <h3>Where it comes from</h3>
          <div class="split-bar" role="img" aria-label="${esc(platforms.map((p) => `${p} ${t.platforms[p]}`).join(", "))}">
            ${platforms.map((p) => `<i style="flex:${t.platforms[p]};--sc:${PLATFORM_COLOR[p]}"></i>`).join("")}
          </div>
          <div class="split-legend">
            ${platforms.map((p) => `<div><i style="--sc:${PLATFORM_COLOR[p]}"></i>${p}<b>${int(t.platforms[p])} · ${pct(t.platforms[p] / t.n)}</b></div>`).join("")}
          </div>
        </div>
      </div>
      <section aria-label="Reviews">
        <div class="rv-toolbar">
          <h3>Reviews <span id="rv-count">${int(t.n)}</span></h3>
          ${segHTML("rv-sort", "Sort reviews", [["store", "Store order"], ["low", "Lowest rated"], ["new", "Newest"]], "store")}
          <label class="search">${ICON.search}<span class="sr-only">Search these reviews</span><input type="search" id="rv-search" placeholder="Search these reviews" autocomplete="off"></label>
        </div>
        <div class="rv-list" id="rv-list"></div>
        <button type="button" class="btn btn-sm rv-more" id="rv-more" hidden>Show more</button>
      </section>
    </div>`;
}

function highlight(text, q) {
  if (!q) return esc(text);
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += `${esc(text.slice(last, m.index))}<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
    if (!m[0].length) re.lastIndex += 1;
  }
  return out + esc(text.slice(last));
}

/** The order the stores themselves show: App Store "Most Helpful", Google Play
 *  "Most relevant". With both platforms in view, their lists interleave. */
export const byStoreOrder = (a, b) => (a.o ?? -1) - (b.o ?? -1) || (a.p === b.p ? 0 : a.p === "iOS" ? -1 : 1);

/** One review card. `extra` goes at the end of the header line. */
export function reviewHTML(r, { q = "", i = 0, extra = "" } = {}) {
  return `
      <article class="review" style="--d:${Math.min(i, 8) * 35}ms">
        <div class="rv-head">
          <span class="rv-stars" aria-label="${r.r} out of 5 stars">${starsText(r.r)}</span>
          ${r.a ? `<span class="rv-author">${esc(r.a)}</span>` : ""}
          <span class="rv-plat"><i style="--sc:${PLATFORM_COLOR[r.p]}"></i>${esc(r.p)}</span>
          <span>${fmtDate(r.ts)}</span>
          ${r.v ? `<span>v${esc(r.v)}</span>` : ""}
          ${r.h ? `<span>${int(r.h)} found helpful</span>` : ""}
          ${extra}
        </div>
        ${r.t ? `<h4>${highlight(r.t, q)}</h4>` : ""}
        <p>${highlight(r.x, q)}</p>
      </article>`;
}

function bindReviews(t) {
  const root = el();
  drawRatings($("#d-ratings", root), t.dist, { compactMode: true });
  const grid = $(".drawer-grid", root);
  requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.add("in")));

  const list = $("#rv-list", root);
  const more = $("#rv-more", root);
  const count = $("#rv-count", root);
  const search = $("#rv-search", root);
  const d = current;

  const render = (fromIndex = 0) => {
    const q = d.query.trim().toLowerCase();
    let rows = t.reviews;
    if (q) rows = rows.filter((r) => `${r.t} ${r.x}`.toLowerCase().includes(q));
    rows = [...rows].sort(
      d.sort === "low" ? (a, b) => a.r - b.r || b.ts - a.ts
        : d.sort === "new" ? (a, b) => b.ts - a.ts
          : byStoreOrder,
    );
    const shown = rows.slice(0, d.limit);
    const html = shown.slice(fromIndex).map((r, i) => reviewHTML(r, { q, i })).join("");
    if (fromIndex) list.insertAdjacentHTML("beforeend", html);
    else list.innerHTML = html || `<p class="drawer-empty">No reviews mention “${esc(d.query)}”.</p>`;
    count.textContent = q ? `${int(rows.length)} of ${int(t.n)}` : int(t.n);
    const left = rows.length - shown.length;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(20, left)} more`;
  };

  bindSeg($("#rv-sort", root), (v) => { d.sort = v; d.limit = 20; render(); }, d.observers);
  search.addEventListener("input", () => { d.query = search.value; d.limit = 20; render(); });
  more.addEventListener("click", () => { const from = d.limit; d.limit += 20; render(from); });
  render();
}

export function openDrawer(themeId, { pushed }) {
  const { app, view } = drawerContext;
  if (!app || !view) return;
  const root = el();
  const theme = view.themes.find((t) => t.id === themeId) || view.all.find((t) => t.id === themeId);
  const wasOpen = isDrawerOpen();

  current?.observers?.forEach((o) => o.disconnect());
  current = {
    returnFocus: wasOpen ? current?.returnFocus : document.activeElement,
    pushed: wasOpen ? current?.pushed || pushed : pushed,
    themeId, query: "", sort: "store", limit: 20, observers: [],
  };

  const brand = brandOf(app);
  root.style.setProperty("--brand", brand || "var(--accent)");
  root.innerHTML = theme ? drawerHTML(app, theme, view) : `
    <div class="drawer-head"><span></span><div class="drawer-actions"><button class="icon-btn" type="button" data-close aria-label="Close">${ICON.close}</button></div></div>
    <div class="drawer-scroll" data-lenis-prevent><div class="drawer-empty"><h2 id="drawer-title">This theme isn't in the current view</h2><p>Its reviews are outside the selected platform or time period.</p></div></div>`;

  root.classList.add("open");
  root.setAttribute("aria-hidden", "false");
  backdrop().classList.add("open");
  document.documentElement.classList.add("locked");
  scroller.stop();
  hideTip();

  $$("[data-close]", root).forEach((b) => b.addEventListener("click", () => closeDrawer()));
  $$("[data-goto]", root).forEach((b) => b.addEventListener("click", () => {
    const id = Number(b.dataset.goto);
    history.replaceState(null, "", `#/app/${encodeURIComponent(app.slug)}/${id}`);
    openDrawer(id, { pushed: false });
  }));
  if (theme) bindReviews(theme);
  $(".drawer-scroll", root).scrollTop = 0;
  ($("[data-close]", root) || root).focus({ preventScroll: true });
}

export function closeDrawer({ silent = false } = {}) {
  if (!isDrawerOpen()) return;
  const root = el();
  root.classList.remove("open");
  root.setAttribute("aria-hidden", "true");
  backdrop().classList.remove("open");
  document.documentElement.classList.remove("locked");
  scroller.start();
  const d = current;
  d?.observers?.forEach((o) => o.disconnect());
  current = null;
  if (silent) return;
  if (d?.pushed) {
    history.back(); // undo the theme's history entry so Back doesn't reopen it
  } else if (drawerContext.app) {
    history.replaceState(null, "", `#/app/${encodeURIComponent(drawerContext.app.slug)}`);
  }
  if (d?.returnFocus?.isConnected) d.returnFocus.focus({ preventScroll: true });
}

export function initDrawer() {
  backdrop().addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    if (!isDrawerOpen()) return;
    const root = el();
    const typing = e.target.matches?.("input, select, textarea");
    if (e.key === "Escape") { e.preventDefault(); closeDrawer(); return; }
    if (!typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      const btn = $(`.drawer-actions [aria-label="${e.key === "ArrowRight" ? "Next" : "Previous"} theme"]`, root);
      if (btn && !btn.disabled) btn.click();
    }
    if (e.key === "Tab") {
      const focusables = $$('button:not([disabled]), input, a[href], [tabindex="0"]', root).filter((x) => x.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}
