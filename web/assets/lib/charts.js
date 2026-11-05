/* Hand-built SVG charts and the shared tooltip. Colors are CSS variables, so
 * a theme switch repaints them without a redraw. Mark specs follow the dataviz
 * reference: <=24px bars with 4px rounded data-ends, 2px surface gaps between
 * stacked segments, hairline grid, and a table view for every chart. */
import { $, $$, esc, clamp, int, pct, compact, MONTHS, utc, starsText, niceTicks } from "./util.js";
import { TIERS, tierChip } from "./data.js";

export const PLATFORM_COLOR = { iOS: "var(--s-ios)", Android: "var(--s-android)" };

// --------------------------------------------------------------------------
// tooltip
// --------------------------------------------------------------------------
const tip = () => $(".tooltip");

export function placeTip(x, y) {
  const el = tip();
  const r = el.getBoundingClientRect();
  let left = x + 18;
  let top = y + 18;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 18;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 18;
  el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}

export function showTip(html, x, y) {
  const el = tip();
  el.innerHTML = html;
  el.classList.add("on");
  el.setAttribute("aria-hidden", "false");
  placeTip(x, y);
}

export function hideTip() {
  const el = tip();
  el.classList.remove("on");
  el.setAttribute("aria-hidden", "true");
}

export function bindTip(el, html) {
  el.addEventListener("pointerenter", (e) => { el.classList.add("on"); showTip(html(), e.clientX, e.clientY); });
  el.addEventListener("pointermove", (e) => placeTip(e.clientX, e.clientY));
  el.addEventListener("pointerleave", () => { el.classList.remove("on"); hideTip(); });
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    el.classList.add("on");
    showTip(html(), r.right, r.top);
  });
  el.addEventListener("blur", () => { el.classList.remove("on"); hideTip(); });
}

export const themeTip = (t) => `<div class="tt-title">#${t.rank} · ${esc(t.label)}</div>
  <div class="tt-row"><span>Priority</span><b>${Math.round(t.priority)}</b></div>
  <div class="tt-row"><span>Reviews</span><b>${int(t.n)}</b></div>
  <div class="tt-row"><span>Average rating</span><b>${t.avg.toFixed(1)} ★</b></div>
  <div class="tt-foot">${tierChip(t.tier)}</div>`;

// --------------------------------------------------------------------------
// chart primitives
// --------------------------------------------------------------------------
const svgOpen = (w, h, label) =>
  `<svg class="viz" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">`;

function barRight(x, y, w, h, r = 4) {
  r = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x}Z`;
}

function colTop(x, y, w, h, r = 4) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}

export function drawMatrix(el, themes, onOpen) {
  const W = Math.max(300, el.clientWidth);
  const H = W < 560 ? 340 : 460;
  const m = { l: 48, r: 20, t: 28, b: 48 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const maxN = Math.max(1, ...themes.map((t) => t.n));
  const { ticks, max: xMax } = niceTicks(maxN * 1.08, W < 560 ? 3 : 5);
  const X = (v) => m.l + (v / xMax) * iw;
  const Y = (v) => m.t + ((5 - v) / 4) * ih;
  const right = m.l + iw;
  const bottom = m.t + ih;
  const sx = X(maxN / 2);
  const sy = Y(3);

  let s = svgOpen(W, H, `Priority map of ${themes.length} themes by number of reviews and average rating`);
  s += `<rect class="q-hot" x="${sx}" y="${sy}" width="${right - sx}" height="${bottom - sy}" rx="2"/>`;
  for (const v of [1, 2, 3, 4, 5]) {
    s += `<line class="grid" x1="${m.l}" x2="${right}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    s += `<text class="tick" x="${m.l - 12}" y="${Y(v)}" dy="0.32em" text-anchor="end">${v}★</text>`;
  }
  for (const v of ticks) s += `<text class="tick" x="${X(v)}" y="${bottom + 22}" text-anchor="middle">${compact(v)}</text>`;
  s += `<line class="split" x1="${sx}" x2="${sx}" y1="${m.t}" y2="${bottom}"/>`;
  s += `<text class="q-label hot" x="${right - 14}" y="${bottom - 14}" text-anchor="end">Fix first</text>`;
  s += `<text class="q-label" x="${right - 14}" y="${m.t + 20}" text-anchor="end">Protect</text>`;
  s += `<text class="q-label" x="${m.l + 14}" y="${bottom - 14}">Watch</text>`;
  s += `<text class="q-label" x="${m.l + 14}" y="${m.t + 20}">Low signal</text>`;
  s += `<text class="axis-title" x="${right}" y="${H - 6}" text-anchor="end">Number of reviews →</text>`;
  s += `<text class="axis-title" x="${m.l - 40}" y="${m.t - 12}">Avg rating</text>`;

  for (const t of [...themes].sort((a, b) => b.rank - a.rank)) {
    const tier = TIERS[t.tier];
    const x = clamp(X(t.n), m.l + 14, right - 14);
    const y = clamp(Y(t.avg), m.t + 14, bottom - 14);
    const label = `Rank ${t.rank}, ${t.label}: ${t.n} reviews, ${t.avg.toFixed(1)} stars, priority ${Math.round(t.priority)}`;
    s += `<g class="pt" data-id="${t.id}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})" tabindex="0" role="button" aria-label="${esc(label)}">
      <g class="anim-pop" style="--d:${200 + t.rank * 70}ms">
        <circle class="hit" r="22"/>
        <circle class="dot" r="12" style="fill:${tier.color}"/>
        <text class="dot-label" text-anchor="middle" dy="0.35em" style="fill:${tier.ink}">${t.rank}</text>
      </g>
    </g>`;
  }
  el.innerHTML = `${s}</svg>`;

  for (const g of $$(".pt", el)) {
    const t = themes.find((x) => x.id === Number(g.dataset.id));
    bindTip(g, () => themeTip(t));
    const open = () => { hideTip(); onOpen(t.id); };
    g.addEventListener("click", open);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }
}

export function drawRatings(el, dist, { compactMode = false } = {}) {
  const W = Math.max(220, el.clientWidth);
  const rowH = compactMode ? 30 : 46;
  const bar = compactMode ? 14 : 20;
  const labelW = 38;
  const valueW = compactMode ? 74 : 104;
  const H = rowH * 5;
  const x0 = labelW;
  const iw = Math.max(40, W - labelW - valueW);
  const total = dist.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(1, ...dist);

  let s = svgOpen(W, H, `Rating distribution: ${dist.map((n, i) => `${i + 1} star ${n}`).join(", ")}`);
  s += `<line class="base" x1="${x0}" x2="${x0}" y1="2" y2="${H - 2}"/>`;
  for (let star = 5; star >= 1; star--) {
    const n = dist[star - 1];
    const y = (5 - star) * rowH + (rowH - bar) / 2;
    const w = (n / max) * iw;
    s += `<g class="row" data-star="${star}"><rect class="hit" x="0" y="${(5 - star) * rowH}" width="${W}" height="${rowH}"/>`;
    s += `<text class="tick" x="${x0 - 12}" y="${y + bar / 2}" dy="0.32em" text-anchor="end">${star}★</text>`;
    if (w > 0.5) {
      s += `<path class="anim-grow-x" d="${barRight(x0 + 1, y, w, bar)}" style="fill:var(--r${star});transform-origin:${x0}px 0px;--d:${(5 - star) * 80}ms"/>`;
    }
    s += `<text class="val" x="${x0 + w + 12}" y="${y + bar / 2}" dy="0.32em">${int(n)}<tspan class="val-sub"> · ${pct(n / total)}</tspan></text></g>`;
  }
  el.innerHTML = `${s}</svg>`;

  for (const row of $$(".row", el)) {
    const star = Number(row.dataset.star);
    const n = dist[star - 1];
    bindTip(row, () => `<div class="tt-title">${starsText(star)}</div>
      <div class="tt-row"><span>Reviews</span><b>${int(n)}</b></div>
      <div class="tt-row"><span>Share</span><b>${pct(n / total)}</b></div>`);
  }
}

export function monthlyBuckets(reviews) {
  const key = (ts) => { const d = utc(ts); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const map = new Map();
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of reviews) {
    const k = key(r.ts);
    lo = Math.min(lo, k);
    hi = Math.max(hi, k);
    const b = map.get(k) || { iOS: 0, Android: 0, n: 0, sum: 0 };
    b[r.p] += 1;
    b.n += 1;
    b.sum += r.r;
    map.set(k, b);
  }
  const months = [];
  for (let k = lo; k <= hi; k++) {
    months.push({ k, year: Math.floor(k / 12), month: k % 12, ...(map.get(k) || { iOS: 0, Android: 0, n: 0, sum: 0 }) });
  }
  return months;
}

export function drawVolume(el, reviews, platforms) {
  const months = monthlyBuckets(reviews);
  const W = Math.max(280, el.clientWidth);
  const H = W < 560 ? 240 : 270;
  const m = { l: 40, r: 8, t: 12, b: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const base = m.t + ih;
  const { ticks, max } = niceTicks(Math.max(1, ...months.map((b) => b.n)), 4);
  const Y = (v) => base - (v / max) * ih;
  const band = iw / Math.max(1, months.length);
  const cw = Math.min(24, Math.max(6, band * 0.58));
  const labelEvery = Math.max(1, Math.ceil(months.length / Math.floor(iw / 56)));
  const GAP = 2;

  let s = svgOpen(W, H, `Reviews per month across ${months.length} months`);
  for (const v of ticks) {
    s += `<line class="${v === 0 ? "base" : "grid"}" x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    s += `<text class="tick" x="${m.l - 10}" y="${Y(v)}" dy="0.32em" text-anchor="end">${compact(v)}</text>`;
  }
  months.forEach((b, i) => {
    const cx = m.l + band * (i + 0.5);
    const x = cx - cw / 2;
    s += `<rect class="band" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" rx="2"/>`;
    const segs = platforms.map((p) => ({ p, v: b[p] })).filter((sg) => sg.v > 0);
    let cursor = base;
    let col = "";
    segs.forEach((sg, j) => {
      const h = (sg.v / max) * ih;
      const bottom = j === 0 ? cursor : cursor - GAP;
      const top = cursor - h;
      const height = bottom - top;
      if (height > 0.4) {
        col += j === segs.length - 1
          ? `<path d="${colTop(x, top, cw, height)}" style="fill:${PLATFORM_COLOR[sg.p]}"/>`
          : `<rect x="${x}" y="${top}" width="${cw}" height="${height}" style="fill:${PLATFORM_COLOR[sg.p]}"/>`;
      }
      cursor = top;
    });
    s += `<g class="anim-grow-y" style="transform-origin:0px ${base}px;--d:${i * 45}ms">${col}</g>`;
    if (i % labelEvery === 0) {
      s += `<text class="tick" x="${cx}" y="${base + 20}" text-anchor="middle">${MONTHS[b.month]}</text>`;
      if (i === 0 || b.month === 0) s += `<text class="tick" x="${cx}" y="${base + 34}" text-anchor="middle">${b.year}</text>`;
    }
  });
  el.innerHTML = `${s}</svg>`;

  for (const rect of $$(".band", el)) {
    const b = months[Number(rect.dataset.i)];
    bindTip(rect, () => {
      const rows = platforms
        .map((p) => `<div class="tt-row"><span><i style="--sc:${PLATFORM_COLOR[p]}"></i>${p}</span><b>${int(b[p])}</b></div>`)
        .join("");
      const avg = b.n ? `${(b.sum / b.n).toFixed(1)} ★` : "none";
      return `<div class="tt-title">${MONTHS[b.month]} ${b.year}</div>${rows}
        <div class="tt-row"><span>Total</span><b>${int(b.n)}</b></div>
        <div class="tt-row"><span>Average rating</span><b>${avg}</b></div>`;
    });
  }
}

/** Draw now, redraw on resize, wire the chart/table toggle. */
export function mountChart(card, scope, draw, tableHtml) {
  const holder = $(".chart", card);
  const table = $(".chart-table", card);
  const toggle = $(".table-toggle", card);
  draw(holder);
  if (table && tableHtml) table.innerHTML = tableHtml;
  toggle?.addEventListener("click", () => {
    const showTable = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(showTable));
    toggle.textContent = showTable ? "Chart" : "Table";
    holder.hidden = showTable;
    table.hidden = !showTable;
  });
  let width = holder.clientWidth;
  let timer = 0;
  const ro = new ResizeObserver(() => {
    const w = holder.clientWidth;
    if (Math.abs(w - width) < 2) return;
    width = w;
    clearTimeout(timer);
    timer = setTimeout(() => draw(holder), 120);
  });
  ro.observe(holder);
  scope.add(() => ro.disconnect());
}

export const tableOf = (head, rows) =>
  `<table><thead><tr>${head.map((h, i) => `<th${i ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr></thead>
   <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
