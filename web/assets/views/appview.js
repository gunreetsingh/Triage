/* App report. This is the working tool, so it is calm and answer-first: a
 * compact header, the issue to fix first, the ranked backlog, charts, every
 * review in the stores' own order, and the review map last. Nothing waits on
 * scrolling to appear.
 *
 * Filters re-score in the browser and re-render the dynamic sections; the
 * review map is kept alive across re-renders and simply dims what's out of
 * scope. */
import {
  $, $$, esc, int, pct, pad2, clamp, compact, fmtDate, fmtMonthYear, starsText, firstSentence,
  marketName, safeStoreUrl, appIcon, brandOf, reducedMotion, coarsePointer, MONTHS,
} from "../lib/util.js";
import {
  computeView, DEFAULT_FILTERS, RANKINGS, TIERS, TIER_ORDER, tierChip, tierIcon,
} from "../lib/data.js";
import { reveal, scroller } from "../lib/motion.js";
import { ReviewField } from "../lib/field.js";
import {
  drawMatrix, drawRatings, drawVolume, monthlyBuckets, mountChart, tableOf,
  showTip, hideTip, placeTip, PLATFORM_COLOR,
} from "../lib/charts.js";
import { drawerContext, bindSeg, reviewHTML, byStoreOrder } from "../lib/drawer.js";

const ICON = {
  wrench: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.6 17.2a1.9 1.9 0 0 0 2.7 2.7l5.7-5.7a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.4-.5-.5-2.4Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>',
};

const themeHref = (app, id) => `#/app/${encodeURIComponent(app.slug)}/${id}`;

export async function renderApp(main, scope, app) {
  const filters = { ...DEFAULT_FILTERS };
  const brand = brandOf(app) || "var(--accent)";
  const base = computeView(app, filters);
  const kpiPrev = {};
  drawerContext.app = app;
  drawerContext.view = base;

  main.innerHTML = `
    <div class="appview" style="--brand:${brand}">
      ${headerHTML(app, base)}
      ${toolbarHTML(app)}
      <div id="dyn-top"></div>
      <div id="dyn-bottom"></div>
      ${storeReviewsHTML(app)}
      ${galaxyHTML(app)}
      ${sourceHTML(app)}
    </div>`;

  setupHeader(main, scope);
  setupStoreReviews(main, scope, app, base);
  const galaxy = setupGalaxy(main, scope, app, base);
  bindToolbar(main, scope, app, filters, () => renderDynamic(true));
  setupScrollspy(main, scope);

  // `changed`: a filter moved, so numbers roll from their previous value.
  function renderDynamic(changed) {
    const v = computeView(app, filters);
    drawerContext.view = v;
    galaxy?.update(v);
    const top = $("#dyn-top", main);
    const bottom = $("#dyn-bottom", main);
    const y = window.scrollY;

    if (!v.reviews.length || !v.themes.length) {
      top.innerHTML = `<section class="section container" id="overview"><div class="card empty-card">
        <h3>Nothing matches these filters</h3>
        <p class="muted">${v.reviews.length ? "Every theme in this selection is positive feedback." : "There are no reviews in this period for this platform."}</p>
      </div></section>`;
      bottom.innerHTML = "";
      return;
    }
    top.innerHTML = overviewHTML(app, v);
    bottom.innerHTML = backlogHTML(app, v) + chartsHTML(app, v, filters);
    mountCharts(main, scope, app, v, filters);
    $$(".count[data-key]", top).forEach((el) => {
      if (changed) el.dataset.from = kpiPrev[el.dataset.key] ?? 0;
      kpiPrev[el.dataset.key] = Number(el.dataset.to);
    });
    reveal(top, scope, { instant: true, countUp: changed });
    reveal(bottom, scope, { instant: true, countUp: changed });
    if (changed) {
      scroller.resize();
      scroller.to(y, { immediate: true });
    }
  }
  renderDynamic(false);
}

// --------------------------------------------------------------------------
// header
// --------------------------------------------------------------------------
function headerHTML(app, v) {
  const n = v.reviews.length;
  const avg = v.reviews.reduce((s, r) => s + r.r, 0) / n;
  const unhappy = v.reviews.filter((r) => r.r <= 2).length;
  const links = app.listings.map((l) => {
    const url = safeStoreUrl(l.url);
    if (!url) return "";
    const store = l.platform === "iOS" ? "App Store" : "Google Play";
    return `<a class="store-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><i style="--sc:${PLATFORM_COLOR[l.platform]}"></i>${store}<span aria-hidden="true">↗</span></a>`;
  }).join("");
  const stat = (value, label) => `<div class="rstat"><b>${value}</b><span>${label}</span></div>`;
  // The stores' own ratings for the whole app; the reviews read are a sample.
  const ratings = app.listings.filter((l) => l.rating > 0)
    .map((l) => stat(`${l.rating.toFixed(1)}<small>★</small>`, `${STORE[l.platform].name} · ${compact(l.ratings)} ratings`)).join("");

  return `
  <header class="rhead" id="top">
    <div class="container">
      <a class="back-link" href="#/apps"><span class="arrow" aria-hidden="true">←</span> All apps</a>
      <div class="rhead-main">
        ${appIcon(app, "rhead-icon", { alt: `${app.name} logo` })}
        <div class="rhead-id">
          <p class="eyebrow">${esc(marketName(app.market))} · ${fmtMonthYear(app.minTs)} – ${fmtMonthYear(app.maxTs)}</p>
          <h1 class="rhead-title">${esc(app.name)}</h1>
          <div class="store-links">${links}</div>
        </div>
        <div class="rhead-stats">
          ${ratings || stat(avg.toFixed(1), `avg of the ${int(n)} reviews read`)}
          ${stat(int(n), "reviews read")}
          ${stat(`${Math.round((unhappy / n) * 100)}%`, "of those rated 1–2 stars")}
          ${stat(v.themes.length, "themes found")}
        </div>
      </div>
    </div>
  </header>`;
}

/** The app's name joins the toolbar once the header has scrolled away. */
function setupHeader(main, scope) {
  const head = $(".rhead", main);
  const tbId = $(".tb-id", main);
  scope.frame((_, y) => tbId.classList.toggle("on", y > head.offsetHeight - 40));
}

// --------------------------------------------------------------------------
// toolbar + scrollspy
// --------------------------------------------------------------------------
function toolbarHTML(app) {
  const seg = (id, label, options) => `<div class="seg" id="${id}" role="group" aria-label="${label}">
    <span class="seg-thumb" aria-hidden="true"></span>
    ${options.map(([v, text], i) => `<button type="button" data-v="${v}" aria-pressed="${i === 0}">${text}</button>`).join("")}
  </div>`;
  return `
  <div class="toolbar-wrap">
    <div class="container toolbar">
      <a class="tb-id" href="#/app/${encodeURIComponent(app.slug)}" aria-label="${esc(app.name)}: back to top" data-top>${appIcon(app, "tb-icon")}<span>${esc(app.name)}</span></a>
      <nav class="subnav" aria-label="Sections">
        <button type="button" data-target="overview">Fix first</button>
        <button type="button" data-target="backlog">Backlog</button>
        <button type="button" data-target="trends">Trends</button>
        <button type="button" data-target="reviews">Reviews</button>
        <button type="button" data-target="galaxy">Review map</button>
      </nav>
      <div class="filters">
        ${app.platforms.length > 1 ? seg("f-platform", "Platform", [["all", "All"], ...app.platforms.map((p) => [p, p])]) : ""}
        ${seg("f-period", "Time period", [["all", "All time"], ["90", "90 days"], ["30", "30 days"]])}
        <label class="sr-only" for="f-rank">Rank themes by</label>
        <select class="select" id="f-rank">${Object.entries(RANKINGS).map(([k, v]) => `<option value="${k}">Rank: ${v.label}</option>`).join("")}</select>
        <button type="button" class="switch" id="f-problems" role="switch" aria-checked="false"><span class="switch-track" aria-hidden="true"></span>Problems only</button>
      </div>
    </div>
  </div>`;
}

function bindToolbar(main, scope, app, filters, rerender) {
  const observers = [];
  scope.add(() => observers.forEach((o) => o.disconnect()));
  const platform = $("#f-platform", main);
  if (platform) bindSeg(platform, (v) => { filters.platform = v; rerender(); }, observers);
  bindSeg($("#f-period", main), (v) => { filters.period = v; rerender(); }, observers);
  const rank = $("#f-rank", main);
  rank.addEventListener("change", () => { filters.rank = rank.value; rerender(); });
  const problems = $("#f-problems", main);
  problems.addEventListener("click", () => {
    filters.problems = !filters.problems;
    problems.setAttribute("aria-checked", String(filters.problems));
    rerender();
  });
  $$(".subnav button", main).forEach((b) => b.addEventListener("click", () => {
    const target = $(`#${b.dataset.target}`, main);
    if (target) scroller.to(target, { offset: -130 });
  }));
  $("[data-top]", main)?.addEventListener("click", (e) => { e.preventDefault(); scroller.to(0); });
}

function setupScrollspy(main, scope) {
  const buttons = $$(".subnav button", main);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) buttons.forEach((b) => b.classList.toggle("active", b.dataset.target === e.target.id));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  const watch = () => ["overview", "backlog", "trends", "reviews", "galaxy"].forEach((id) => { const s = $(`#${id}`, main); if (s) io.observe(s); });
  watch();
  const mo = new MutationObserver(watch);
  mo.observe(main, { childList: true, subtree: true });
  scope.add(() => { io.disconnect(); mo.disconnect(); });
}

// --------------------------------------------------------------------------
// overview: fix first + next up
// --------------------------------------------------------------------------
function overviewHTML(app, v) {
  const problems = v.themes.filter((t) => t.tier !== "positive");
  const top = problems[0] || v.themes[0];
  const nextUp = (problems.length ? problems : v.themes).filter((t) => t !== top).slice(0, 2);
  const tier = TIERS[top.tier];
  const C = 2 * Math.PI * 70;
  const off = C * (1 - clamp(top.priority / 100, 0, 1));
  return `
  <section class="section container" id="overview" aria-labelledby="spot-title">
    <div class="section-head">
      <p class="eyebrow reveal">${top.tier === "positive" ? "Top theme" : "Fix this first"}</p>
    </div>
    <article class="spotlight glow-hover reveal" style="--tc:${tier.color}">
      <div class="spot-main">
        <div class="spot-head">${tierChip(top.tier)}<span class="muted">#1 of ${v.themes.length} themes</span></div>
        <h2 class="spot-title" id="spot-title">${esc(top.label)}</h2>
        ${top.summary ? `<p class="spot-summary">${esc(top.summary)}</p>` : ""}
        ${top.recommendation ? `<div class="fix"><span class="fix-icon">${ICON.wrench}</span><div><p class="eyebrow">Recommended fix</p><p>${esc(top.recommendation)}</p></div></div>` : ""}
        <a class="btn btn-primary spot-btn" href="${themeHref(app, top.id)}">Read the ${int(top.n)} reviews <span class="arrow" aria-hidden="true">→</span></a>
      </div>
      <div class="spot-side">
        <div class="ring" style="--c:${C.toFixed(1)};--off:${off.toFixed(1)};--tc:${tier.color}">
          <svg viewBox="0 0 160 160" aria-hidden="true"><circle class="track" cx="80" cy="80" r="70"/><circle class="fill" cx="80" cy="80" r="70"/></svg>
          <div class="ring-label"><div><b class="count" data-key="pri" data-to="${Math.round(top.priority)}">0</b><span>Priority</span></div></div>
        </div>
        <div class="spot-facts">
          <div><span>Reviews</span><b>${int(top.n)} · ${pct(top.share)}</b></div>
          <div><span>Average rating</span><b>${top.avg.toFixed(1)} ★</b></div>
          <div><span>In the last 90 days</span><b>${pct(top.recent)}</b></div>
        </div>
      </div>
    </article>
    ${nextUp.length ? `<div class="nextup">
      ${nextUp.map((t, i) => `
        <a class="nextup-card glow-hover reveal" style="--d:${120 + i * 90}ms;--tc:${TIERS[t.tier].color}" href="${themeHref(app, t.id)}" data-cursor="Read">
          <div class="nextup-head"><span class="eyebrow">Then · #${t.rank}</span>${tierChip(t.tier)}</div>
          <h3>${esc(t.label)}</h3>
          <p>${esc(firstSentence(t.summary))}</p>
          <div class="nextup-foot"><span>${int(t.n)} reviews · ${t.avg.toFixed(1)}★</span><b>${Math.round(t.priority)}</b></div>
        </a>`).join("")}
    </div>` : ""}
  </section>`;
}

// --------------------------------------------------------------------------
// every review, in the order the store shows it
// --------------------------------------------------------------------------
const STORE = {
  iOS: { name: "App Store", order: "Most Helpful" },
  Android: { name: "Google Play", order: "Most relevant" },
};

function storeReviewsHTML(app) {
  const order = app.platforms.map((p) => `${STORE[p].name}'s “${STORE[p].order}”`).join(" and ");
  return `
  <section class="section container store-reviews" id="reviews" aria-labelledby="reviews-title">
    <div class="section-head split">
      <div>
        <p class="eyebrow">Reviews</p>
        <h2 id="reviews-title">As the stores show them</h2>
      </div>
      <p class="lede">The same reviews in the same order as ${order} in ${esc(marketName(app.market))}, the order the store apps open with. Captured ${esc(fmtDate(Date.parse(app.generated_at) / 1000))}; the stores re-rank over time.</p>
    </div>
    ${app.platforms.length > 1 ? `<div class="seg" id="sr-platform" role="group" aria-label="Store">
      <span class="seg-thumb" aria-hidden="true"></span>
      ${app.platforms.map((p, i) => `<button type="button" data-v="${p}" aria-pressed="${i === 0}">${STORE[p].name}</button>`).join("")}
    </div>` : ""}
    <div class="rv-list" id="sr-list"></div>
    <button type="button" class="btn btn-sm rv-more" id="sr-more" hidden>Show more</button>
  </section>`;
}

function setupStoreReviews(main, scope, app, v) {
  const list = $("#sr-list", main);
  const more = $("#sr-more", main);
  const themes = new Map(v.all.map((t) => [t.id, t]));
  let platform = app.platforms[0];
  let limit = 10;

  const card = (r) => {
    const t = themes.get(r.c);
    const chip = t ? `<a class="rv-theme" href="${themeHref(app, t.id)}" style="color:${TIERS[t.tier].color}">${tierIcon(t.tier)}<span>${esc(t.label)}</span></a>` : "";
    return reviewHTML(r, { extra: `${r.o >= 0 ? `<span class="rv-pos">#${int(r.o + 1)} on ${STORE[r.p].name}</span>` : ""}${chip}` });
  };
  const render = () => {
    const rows = app.reviews.filter((r) => r.p === platform).sort(byStoreOrder);
    list.innerHTML = rows.slice(0, limit).map(card).join("");
    const left = rows.length - limit;
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(20, left)} more of ${int(rows.length)}`;
  };

  const seg = $("#sr-platform", main);
  if (seg) {
    const observers = [];
    scope.add(() => observers.forEach((o) => o.disconnect()));
    bindSeg(seg, (p) => { platform = p; limit = 10; render(); }, observers);
  }
  more.addEventListener("click", () => { limit += 20; render(); });
  render();
}

// --------------------------------------------------------------------------
// review map
// --------------------------------------------------------------------------
function galaxyHTML(app) {
  return `
  <section class="section container" id="galaxy" aria-labelledby="galaxy-title">
    <div class="section-head split">
      <div>
        <p class="eyebrow reveal">Review map</p>
        <h2 id="galaxy-title">Every review, <em>mapped by meaning.</em></h2>
      </div>
      <p class="lede reveal" style="--d:200ms">Each dot is one review. Reviews that say similar things sit close together, and the colors are the themes. Hover a dot to read it; click to open its theme.</p>
    </div>
    <div class="galaxy reveal">
      <canvas class="galaxy-canvas" role="img" aria-label="Map of ${int(app.reviews.length)} reviews for ${esc(app.name)}, grouped by theme. The same themes are listed in the backlog below."></canvas>
      <div class="galaxy-labels"></div>
      <div class="galaxy-legend">${TIER_ORDER.map((k) => `<span data-tier="${k}">${tierIcon(k)}${TIERS[k].label}</span>`).join("")}</div>
    </div>
  </section>`;
}

function setupGalaxy(main, scope, app, v) {
  const wrap = $(".galaxy", main);
  const canvas = $(".galaxy-canvas", wrap);
  const labels = $(".galaxy-labels", wrap);
  const legend = $(".galaxy-legend", wrap);
  const field = new ReviewField(canvas, { reviews: app.reviews, themes: v.all, mode: "map", seed: 11 });
  const index = new Map(app.reviews.map((r, i) => [r.i, i]));

  const renderLabels = () => {
    labels.innerHTML = field.themes.map((t, i) => {
      const c = field.centroids[i];
      return `<a class="glabel" data-i="${i}" href="${themeHref(app, t.id)}" style="left:${c.x.toFixed(1)}px;top:${c.y.toFixed(1)}px;--tc:${TIERS[t.tier].color}">${tierIcon(t.tier)}<span>${esc(t.label)}</span></a>`;
    }).join("");
    $$(".glabel", labels).forEach((el) => {
      const i = Number(el.dataset.i);
      el.addEventListener("pointerenter", () => { field.hoverTheme = i; });
      el.addEventListener("pointerleave", () => { field.hoverTheme = null; });
      el.addEventListener("focus", () => { field.hoverTheme = i; });
      el.addEventListener("blur", () => { field.hoverTheme = null; });
    });
    const present = new Set(field.themes.map((t) => t.tier));
    $$("[data-tier]", legend).forEach((s) => { s.hidden = !present.has(s.dataset.tier); });
  };
  renderLabels();

  const onResize = () => { field.resize(); renderLabels(); };
  scope.resize(onResize);
  scope.on(window, "themechange", () => field.readColors());

  // explode in when scrolled to
  let visible = false;
  let introStart = null;
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && introStart === null) {
      introStart = performance.now();
      wrap.classList.add("lit");
    }
  }, { threshold: 0.2 });
  io.observe(wrap);
  scope.add(() => io.disconnect());

  scope.frame((time) => {
    if (!visible) return;
    field.intro = reducedMotion.matches ? 1 : clamp((time - (introStart ?? time)) / 1200, 0, 1);
    field.draw(time);
  });

  if (!coarsePointer.matches) {
    scope.on(canvas, "pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      const i = field.pick(e.clientX - r.left, e.clientY - r.top);
      field.hover = i;
      canvas.style.cursor = i >= 0 ? "pointer" : "";
      if (i < 0) { hideTip(); return; }
      const rv = app.reviews[i];
      const t = field.themes[field.theme[i]];
      const text = rv.x.length > 220 ? `${rv.x.slice(0, 220).trimEnd()}…` : rv.x;
      showTip(`<div class="tt-review">
          <div class="rv-head"><span class="rv-stars">${starsText(rv.r)}</span><span class="rv-plat"><i style="--sc:${PLATFORM_COLOR[rv.p]}"></i>${esc(rv.p)}</span><span>${fmtDate(rv.ts)}</span></div>
          ${rv.t ? `<b>${esc(rv.t)}</b>` : ""}
          <p>${esc(text)}</p>
          <div class="tt-theme">${tierIcon(t.tier)}${esc(t.label)}</div>
        </div>`, e.clientX, e.clientY);
      placeTip(e.clientX, e.clientY);
    });
    scope.on(canvas, "pointerleave", () => { field.hover = -1; hideTip(); });
  }
  scope.on(canvas, "click", (e) => {
    const r = canvas.getBoundingClientRect();
    const i = field.pick(e.clientX - r.left, e.clientY - r.top, coarsePointer.matches ? 18 : 9);
    if (i < 0) return;
    hideTip();
    location.hash = themeHref(app, field.themes[field.theme[i]].id);
  });

  return {
    update(view) {
      const inScope = new Set(view.reviews.map((r) => r.i));
      const shown = new Set(view.themes.map((t) => t.id));
      const dim = new Uint8Array(app.reviews.length);
      for (const id of inScope) {
        const i = index.get(id);
        if (i !== undefined && shown.has(app.reviews[i].c)) dim[i] = 1;
      }
      field.dim = dim;
      field.setThemes(view.all);
      $$(".glabel", labels).forEach((el) => {
        const t = field.themes[Number(el.dataset.i)];
        el.classList.toggle("off", !shown.has(t.id));
        el.style.setProperty("--tc", TIERS[t.tier].color);
        el.querySelector("svg").outerHTML = tierIcon(t.tier);
      });
    },
  };
}

// --------------------------------------------------------------------------
// backlog + charts
// --------------------------------------------------------------------------
function backlogHTML(app, v) {
  return `
  <section class="section container" id="backlog" aria-labelledby="backlog-title">
    <div class="section-head split">
      <div>
        <p class="eyebrow reveal">Backlog</p>
        <h2 id="backlog-title">Every theme, <em>ranked.</em></h2>
      </div>
      <p class="lede reveal" style="--d:200ms">Priority combines how many people raise a theme with how unhappy they are. Click any theme for the summary, the fix and every review behind it.</p>
    </div>
    <ol class="theme-list">
      ${v.themes.map((t, i) => {
        const tier = TIERS[t.tier];
        const d = Math.min(i, 10) * 50;
        return `
        <li class="reveal" style="--d:${d}ms">
          <a class="theme-row glow-hover" href="${themeHref(app, t.id)}" style="--tc:${tier.color}" data-cursor="Open">
            <span class="tr-rank">${pad2(t.rank)}</span>
            <span class="tr-main">
              <span class="tr-label">${esc(t.label)}</span>
              <span class="tr-sub">${esc(firstSentence(t.summary))}</span>
              <span class="tr-mobile">${tier.label} · ${int(t.n)} reviews · ${t.avg.toFixed(1)}★</span>
            </span>
            <span class="tr-tier">${tierChip(t.tier)}</span>
            <span class="tr-stat"><b>${int(t.n)}</b><small>reviews</small></span>
            <span class="tr-stat"><b>${t.avg.toFixed(1)}★</b><small>rating</small></span>
            <span class="meter" aria-label="Priority ${Math.round(t.priority)} of 100">
              <span class="meter-track"><span class="meter-fill" style="--w:${clamp(t.priority, 2, 100)}%;--d:${d}ms"></span></span>
              <b>${Math.round(t.priority)}</b>
            </span>
          </a>
        </li>`;
      }).join("")}
    </ol>
  </section>`;
}

function chartsHTML(app, v, filters) {
  const both = filters.platform === "all" && app.platforms.length > 1;
  const present = [...new Set(v.themes.map((t) => t.tier))].sort((a, b) => TIER_ORDER.indexOf(a) - TIER_ORDER.indexOf(b));
  return `
  <section class="section container" id="trends" aria-labelledby="trends-title">
    <div class="section-head split">
      <div>
        <p class="eyebrow reveal">Priority map &amp; trends</p>
        <h2 id="trends-title">Where it hurts, <em>and when.</em></h2>
      </div>
      <p class="lede reveal" style="--d:200ms">Each numbered dot is a theme: further right means more people raise it, lower means they rate the app worse. Start in the bottom-right.</p>
    </div>
    <div class="card chart-card reveal" id="matrix-card">
      <div class="chart-head">
        <div class="legend">${present.map((k) => `<span>${tierIcon(k)}${TIERS[k].label}</span>`).join("")}</div>
        <button type="button" class="table-toggle" aria-pressed="false">Table</button>
      </div>
      <div class="chart"></div><div class="chart-table" hidden></div>
    </div>
    <div class="grid-2">
      <div class="card chart-card reveal" id="ratings-card">
        <div class="chart-head"><div><h3>Star ratings</h3><p>Share of reviews at each rating</p></div><button type="button" class="table-toggle" aria-pressed="false">Table</button></div>
        <div class="chart"></div><div class="chart-table" hidden></div>
      </div>
      <div class="card chart-card reveal" id="volume-card" style="--d:90ms">
        <div class="chart-head">
          <div><h3>Reviews per month</h3><p>${both ? "By platform" : "All reviews in view"}</p></div>
          <div class="chart-tools">
            ${both ? `<div class="legend">${app.platforms.map((p) => `<span><i style="--sc:${PLATFORM_COLOR[p]}"></i>${p}</span>`).join("")}</div>` : ""}
            <button type="button" class="table-toggle" aria-pressed="false">Table</button>
          </div>
        </div>
        <div class="chart"></div><div class="chart-table" hidden></div>
      </div>
    </div>
  </section>`;
}

function mountCharts(main, scope, app, v, filters) {
  const n = v.reviews.length;
  const shown = filters.platform === "all" ? app.platforms : [filters.platform];
  mountChart($("#matrix-card", main), scope, (el) => drawMatrix(el, v.themes, (id) => { location.hash = themeHref(app, id); }),
    tableOf(["Rank", "Theme", "Reviews", "Avg rating", "Priority", "Tier"],
      v.themes.map((t) => [t.rank, t.label, t.n, t.avg.toFixed(2), Math.round(t.priority), TIERS[t.tier].label])));
  const dist = [1, 2, 3, 4, 5].map((s) => v.reviews.filter((r) => r.r === s).length);
  mountChart($("#ratings-card", main), scope, (el) => drawRatings(el, dist),
    tableOf(["Rating", "Reviews", "Share"], [5, 4, 3, 2, 1].map((s) => [`${s} stars`, dist[s - 1], pct(dist[s - 1] / n)])));
  const months = monthlyBuckets(v.reviews);
  mountChart($("#volume-card", main), scope, (el) => drawVolume(el, v.reviews, shown),
    tableOf(["Month", ...shown, "Total"], months.map((b) => [`${MONTHS[b.month]} ${b.year}`, ...shown.map((p) => b[p]), b.n])));
}

// --------------------------------------------------------------------------
// footer bits
// --------------------------------------------------------------------------
function sourceHTML(app) {
  return `
  <section class="container source">
    <div class="source-note reveal">
      ${ICON.info}
      <p>Based on ${int(app.reviews.length)} reviews: the first ones ${app.platforms.map((p) => STORE[p].name).join(" and ")} show${app.platforms.length > 1 ? "" : "s"} in ${esc(marketName(app.market))}, in ${app.platforms.length > 1 ? "their" : "its"} default order, collected ${esc(fmtDate(Date.parse(app.generated_at) / 1000))}. It's the feedback users actually see, not every review ever written, so treat priority as a ranking, not a headcount.</p>
    </div>
  </section>`;
}
