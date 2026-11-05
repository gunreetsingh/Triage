/* Home: a pinned scroll story (one app's real reviews become a ranked backlog),
 * a scroll-lit statement, a horizontal gallery of every app, the method, and
 * a giant footer. */
import {
  $, $$, esc, int, pct, pad2, clamp, lerp, smooth, span, compact, marketName, appIcon, brandOf,
  reducedMotion, coarsePointer,
} from "../lib/util.js";
import { loadManifest, loadApp, computeView, tierOf, tierChip, tierIcon, TIERS, api } from "../lib/data.js";
import { progressOf, scrubWords, scroller } from "../lib/motion.js";
import { ReviewField, STORY } from "../lib/field.js";

const CAPTIONS = [
  { win: [0.085, 0.255], title: "Collect",
    body: (a) => `${int(a.reviews.length)} reviews from the ${marketName(a.market)} App Store and Google Play, the ones each store shows first. Every dot is one of them, colored by its star rating: blue is happy, red is not.` },
  { win: [0.255, 0.445], title: "Understand",
    body: () => "Each review becomes a point on a map of meaning. Reviews that say the same thing land next to each other, in any words, even in another language." },
  { win: [0.445, 0.585], title: "Group",
    body: () => "Neighbouring reviews become themes. On their own, all a theme has is a few repeated words." },
  { win: [0.585, 0.705], title: "Explain",
    body: () => "Triage reads every theme, gives it a name a product team would recognise, and writes a fix they could ship." },
  { win: [0.705, 0.885], title: "Rank",
    body: () => "Each theme is scored on how many people raise it and how unhappy they are. Biggest and most painful goes first." },
];
const FINAL_AT = 0.885;

export async function renderHome(main, scope) {
  const manifest = await loadManifest();
  const apps = manifest.apps;
  const featured = manifest.featured ? await loadApp(manifest.featured) : null;
  const view = featured ? computeView(featured) : null;
  const totalReviews = apps.reduce((s, a) => s + a.reviews, 0);
  const totalThemes = apps.reduce((s, a) => s + a.themes, 0);
  const critical = apps.reduce((s, a) => s + (a.critical || 0), 0);

  main.innerHTML = `
    ${storyHTML(featured, view, apps, totalReviews)}
    ${statementHTML()}
    ${galleryHTML(apps)}
    ${methodHTML(totalReviews, totalThemes, critical)}
    ${footerHTML()}`;

  if (featured) setupStory(main, scope, featured, view);
  // On a plain static host there's no analysis server: search only finds
  // the apps already here, so say that instead of promising "any app".
  api.check().then((live) => {
    if (live) return;
    const text = $(".hero-search-text", main);
    if (text) text.textContent = `Find one of the ${apps.length} analyzed apps…`;
    $(".gcard-wrap--search", main)?.remove();
    window.dispatchEvent(new Event("resize")); // re-measure the gallery without that card
  });
  scrubWords($(".statement", main), $(".statement-text", main), scope, { from: 0.08, to: 0.7 });
  setupGallery(main, scope);
  setupFooter(main, scope);
  setupNavSpy(main, scope);

  $$("[data-jump]", main).forEach((b) => b.addEventListener("click", () => {
    const target = $(`#${b.dataset.jump}`);
    if (target) scroller.to(target);
  }));
}

// --------------------------------------------------------------------------
// story
// --------------------------------------------------------------------------
function storyHTML(app, view, apps, totalReviews) {
  if (!app) return "";
  const top = view.themes.find((t) => t.tier !== "positive") || view.themes[0];
  const marquee = (list) => `<div class="marquee-row"><div class="marquee-inner">${
    [...list, ...list].map((a) => `<a class="mq-item" href="#/app/${encodeURIComponent(a.slug)}" tabindex="-1" style="--brand:${brandOf(a) || "var(--accent)"}">${appIcon(a, "mq-icon")}<span>${esc(a.name)}</span></a>`).join("")
  }</div></div>`;
  const half = Math.ceil(apps.length / 2);

  return `
  <section class="story" id="story" aria-label="How Triage works, told with ${esc(app.name)}'s reviews">
    <div class="story-stage">
      <canvas class="story-canvas" aria-hidden="true"></canvas>
      <div class="story-vignette" aria-hidden="true"></div>
      <div class="story-labels" aria-hidden="true">
        ${view.themes.map((t, i) => `
          <div class="isl" data-i="${i}">
            <span class="isl-kw">${esc((t.kw || []).join(" · ") || "…")}</span>
            <span class="isl-name">${esc(t.label)}</span>
          </div>
          <div class="row-label" data-i="${i}">
            <span class="rl-name">${esc(t.label)}</span>
            <span class="rl-meta">${tierIcon(t.tier)}${TIERS[t.tier].label} · ${int(t.n)} reviews</span>
          </div>
          <div class="row-score" data-i="${i}">${Math.round(t.priority)}</div>`).join("")}
      </div>

      <div class="story-hero">
        <div class="container hero-copy">
          <p class="pill reveal"><span class="pulse"></span>Real App Store &amp; Google Play reviews · any app</p>
          <h1 class="hero-title" data-split="chars">Your users already told you what to <em>fix.</em></h1>
          <p class="hero-sub reveal" style="--d:500ms">Triage reads every App Store and Google Play review, finds the themes, and ranks what to fix first. Scroll, and watch it happen to ${esc(app.name)}'s ${int(app.reviews.length)} reviews.</p>
          <div class="hero-cta reveal" style="--d:650ms">
            <button type="button" class="hero-search" data-palette data-cursor="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg><span class="hero-search-text">Search any app: Spotify, Uber, Notion…</span><kbd>⌘K</kbd>
            </button>
            <button type="button" class="btn btn-glass magnetic" data-jump="story-steps-anchor">Watch it work <span class="arrow" aria-hidden="true">↓</span></button>
          </div>
        </div>
        <div class="marquee reveal" style="--d:800ms" aria-hidden="true">
          ${marquee(apps.slice(0, half))}
          ${marquee(apps.slice(half).concat(apps.slice(0, Math.max(0, half - (apps.length - half)))))}
        </div>
        <div class="scroll-cue" aria-hidden="true"><span></span></div>
      </div>

      <div class="story-captions">
        ${CAPTIONS.map((c, i) => `
          <article class="cap" data-cap="${i}">
            <span class="cap-num">${pad2(i + 1)}<i>/ 05</i></span>
            <h2>${c.title}</h2>
            <p>${esc(c.body(app))}</p>
          </article>`).join("")}
      </div>

      <div class="story-final">
        <p class="eyebrow">${esc(app.name)} · ${int(app.reviews.length)} reviews · ${view.themes.length} themes</p>
        <h2>All of that, down to <em>one thing</em> to fix first.</h2>
        <a class="final-issue glow-hover" href="#/app/${encodeURIComponent(app.slug)}/${top.id}" style="--tc:${TIERS[top.tier].color}">
          ${appIcon(app, "final-icon")}
          <span><b>${esc(top.label)}</b><small>${tierChip(top.tier)} ${int(top.n)} reviews · ${top.avg.toFixed(1)}★ · priority ${Math.round(top.priority)}</small></span>
          <span class="arrow" aria-hidden="true">→</span>
        </a>
        <div class="final-cta">
          <a class="btn btn-primary magnetic" href="#/app/${encodeURIComponent(app.slug)}">Open the full report <span class="arrow" aria-hidden="true">→</span></a>
          <button type="button" class="btn btn-glass magnetic" data-jump="apps">See every app</button>
        </div>
      </div>

      <nav class="story-steps" aria-label="Story steps">
        ${CAPTIONS.map((c, i) => `<button type="button" data-step="${i}" aria-label="Step ${i + 1}: ${c.title}"><span>${c.title}</span></button>`).join("")}
      </nav>
      <div class="story-progress" aria-hidden="true"><span></span></div>
    </div>
    <span id="story-steps-anchor" class="story-anchor" aria-hidden="true"></span>
  </section>`;
}

function setupStory(main, scope, app, view) {
  const section = $(".story", main);
  const stage = $(".story-stage", section);
  const canvas = $(".story-canvas", section);
  const hero = $(".story-hero", section);
  const caps = $$(".cap", section);
  const final = $(".story-final", section);
  const steps = $$(".story-steps button", section);
  const bar = $(".story-progress span", section);
  const isl = $$(".isl", section);
  const rowLabels = $$(".row-label", section);
  const rowScores = $$(".row-score", section);
  const isls = isl.map((el) => ({ el, kw: $(".isl-kw", el), name: $(".isl-name", el) }));

  // The anchor for "Watch it work" sits where step 1 begins.
  const anchor = $("#story-steps-anchor", section);
  const placeAnchor = () => {
    const total = section.offsetHeight - window.innerHeight;
    anchor.style.top = `${Math.round(total * (CAPTIONS[0].win[0] + 0.05))}px`;
  };

  const field = new ReviewField(canvas, { reviews: app.reviews, themes: view.themes, mode: "story" });
  if (reducedMotion.matches) {
    section.classList.add("static");
    const still = () => { field.resize(); field.p = 0; field.draw(0); };
    still();
    scope.resize(still);
    scope.on(window, "themechange", () => { field.readColors(); still(); });
    return;
  }
  const staticMode = false;

  const onResize = () => { field.resize(); placeAnchor(); };
  scope.resize(onResize);
  scope.on(window, "themechange", () => field.readColors());
  requestAnimationFrame(placeAnchor);

  if (!coarsePointer.matches) {
    scope.on(stage, "pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      field.setMouse(e.clientX - r.left, e.clientY - r.top, true);
    });
    scope.on(stage, "pointerleave", () => field.setMouse(-9999, -9999, false));
  }

  steps.forEach((b) => b.addEventListener("click", () => {
    const i = Number(b.dataset.step);
    const total = section.offsetHeight - window.innerHeight;
    const target = section.offsetTop + total * (CAPTIONS[i].win[0] + (CAPTIONS[i].win[1] - CAPTIONS[i].win[0]) * 0.55);
    scroller.to(target);
  }));

  let visible = true;
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { rootMargin: "200px" });
  io.observe(section);
  scope.add(() => io.disconnect());

  const setOpacity = (el, o) => {
    const v = o < 0.005 ? 0 : o > 0.995 ? 1 : o;
    if (el._o !== v) { el.style.opacity = v; el._o = v; el.style.visibility = v ? "visible" : "hidden"; }
  };

  scope.frame((time) => {
    if (!visible) return;
    const p = staticMode ? 1 : progressOf(section);
    field.p = p;
    field.draw(time);
    bar.style.transform = `scaleX(${p.toFixed(4)})`;

    // hero copy lifts and blurs away
    const h = span(0, STORY.hero[1] + 0.012, p);
    if (!staticMode) {
      hero.style.transform = `translate3d(0, ${(-h * 120).toFixed(1)}px, 0) scale(${(1 - h * 0.06).toFixed(4)})`;
      hero.style.filter = h > 0.01 ? `blur(${(h * 10).toFixed(1)}px)` : "";
      setOpacity(hero, 1 - h);
    }

    // captions
    let activeStep = -1;
    caps.forEach((cap, i) => {
      const [a, b] = CAPTIONS[i].win;
      const inn = smooth(a, a + 0.03, p);
      const out = i === caps.length - 1 ? 1 - smooth(b - 0.02, b, p) : 1 - smooth(b - 0.03, b, p);
      const o = staticMode ? 1 : inn * out;
      setOpacity(cap, o);
      if (!staticMode) cap.style.transform = `translate3d(0, ${((1 - inn) * 40 - (1 - out) * 40).toFixed(1)}px, 0)`;
      if (p >= a && p < b) activeStep = i;
    });
    steps.forEach((b, i) => b.classList.toggle("active", i === activeStep));
    stage.classList.toggle("steps-on", p > CAPTIONS[0].win[0] && p < FINAL_AT);

    // final
    const f = smooth(FINAL_AT, FINAL_AT + 0.04, p);
    setOpacity(final, f);
    final.style.transform = `translate3d(0, ${((1 - f) * 40).toFixed(1)}px, 0)`;
    final.style.pointerEvents = f > 0.5 ? "auto" : "none";

    // island labels: keywords, then the theme names, gone when the bars form
    const islOn = smooth(STORY.color[0], STORY.color[0] + 0.07, p) * (1 - smooth(STORY.bars[0], STORY.bars[0] + 0.05, p));
    const named = smooth(STORY.name[0], STORY.name[1], p);
    isls.forEach(({ el, kw, name }, i) => {
      const c = field.centroids[i];
      setOpacity(el, islOn);
      if (islOn > 0) {
        el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${(0.9 + 0.1 * islOn).toFixed(3)})`;
        kw.style.opacity = 1 - named;
        name.style.opacity = named;
        kw.style.filter = named > 0.01 && named < 0.99 ? `blur(${(named * 4).toFixed(1)}px)` : "";
      }
    });

    // ranked rows
    const rowsOn = smooth(STORY.bars[1] - 0.04, STORY.bars[1] + 0.02, p);
    rowLabels.forEach((el, i) => {
      const row = field.rows[i];
      const o = rowsOn * smooth(0, 1, clamp(rowsOn * 1.6 - i * 0.07, 0, 1));
      setOpacity(el, o);
      if (o > 0) {
        const x = field.mobile ? field.areaRect.x : row.x0 - 18;
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${row.labelY.toFixed(1)}px, 0) translate(${field.mobile ? "0" : "-100%"}, -50%) translateX(${((1 - o) * -16).toFixed(1)}px)`;
      }
      const s = rowScores[i];
      setOpacity(s, o);
      if (o > 0) s.style.transform = `translate3d(${(row.x1 + 12).toFixed(1)}px, ${row.y.toFixed(1)}px, 0) translateY(-50%)`;
    });
  });
}

// --------------------------------------------------------------------------
// statement
// --------------------------------------------------------------------------
function statementHTML() {
  return `
  <section class="statement" aria-label="Why it matters">
    <div class="statement-stage container">
      <p class="statement-text">Every app on the App Store and Google Play. Every review is a person telling you <em>exactly</em> what's broken, in words nobody has time to read.</p>
    </div>
  </section>`;
}

// --------------------------------------------------------------------------
// horizontal gallery
// --------------------------------------------------------------------------
function cardHTML(a, i) {
  const t = a.top_issue;
  const tier = t ? tierOf(t.priority, t.avg_rating) : null;
  const total = a.dist.reduce((s, n) => s + n, 0) || 1;
  const strip = [5, 4, 3, 2, 1].map((s) => (a.dist[s - 1] ? `<i style="flex:${a.dist[s - 1]};background:var(--r${s})"></i>` : "")).join("");
  const distLabel = [5, 4, 3, 2, 1].map((s) => `${s} stars ${pct(a.dist[s - 1] / total)}`).join(", ");
  return `
    <div class="gcard-wrap">
      <a class="gcard glow-hover" data-tilt="10" data-cursor="Open" href="#/app/${encodeURIComponent(a.slug)}" style="--brand:${brandOf(a) || "var(--accent)"}">
        <span class="gcard-sheen" aria-hidden="true"></span>
        <div class="gcard-top"><span class="gcard-idx">${pad2(i + 1)}</span><span class="gcard-market">${esc(marketName(a.market))}</span></div>
        <div class="gcard-logo">${appIcon(a, "gcard-icon")}<span class="gcard-halo" aria-hidden="true"></span></div>
        <h3 class="gcard-name">${esc(a.name)}</h3>
        ${ratingsHTML(a)}
        <div class="dist-strip" role="img" aria-label="${esc(distLabel)}">${strip}</div>
        ${t ? `<div class="gcard-issue">
          <div class="gcard-issue-head"><span class="eyebrow">Fix first</span>${tierChip(tier)}</div>
          <p>${esc(t.label)}</p>
        </div>` : ""}
        <div class="gcard-foot"><span>${int(a.themes)} themes${a.critical ? ` · ${a.critical} critical` : ""}</span><span class="gcard-go" aria-hidden="true">→</span></div>
      </a>
    </div>`;
}

const STORE_NAME = { iOS: "App Store", Android: "Google Play" };
const starRow = (r) => `<span class="stars" aria-hidden="true">${"★".repeat(Math.round(r))}<s>${"★".repeat(5 - Math.round(r))}</s></span>`;

/** Each store's own rating, as its listing shows it (one decimal). */
function ratingsHTML(a) {
  if (!a.store?.length) {
    return `<div class="gcard-rating"><div class="gcard-store"><b>${Number(a.avg).toFixed(1)}</b>${starRow(a.avg)}<small>avg of ${int(a.reviews)} reviews read</small></div></div>`;
  }
  return `<div class="gcard-rating">${a.store.map((s) => `
    <div class="gcard-store"><b>${s.rating.toFixed(1)}</b>${starRow(s.rating)}<small>${STORE_NAME[s.p]} · ${compact(s.ratings)} ratings</small></div>`).join("")}
  </div>`;
}

// The gallery stays a showcase; everything else is one search away.
const GALLERY_MAX = 15;

function searchCardHTML(total) {
  const heading = total > GALLERY_MAX
    ? `${total - GALLERY_MAX} more in search, plus <em>any app</em> you can think of.`
    : "Not here? Try <em>any app</em> you can think of.";
  return `
    <div class="gcard-wrap gcard-wrap--search">
      <button type="button" class="gcard gcard--search glow-hover" data-palette data-tilt="10" data-cursor="Search">
        <span class="gcard-sheen" aria-hidden="true"></span>
        <span class="gcard-plus" aria-hidden="true"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg></span>
        <h3 class="gcard-name">${heading}</h3>
        <p class="gcard-search-copy">Search the App Store for any app. Triage reads its reviews and builds the report in about a minute.</p>
        <span class="gcard-foot"><span>Search any app</span><span class="gcard-go" aria-hidden="true">→</span></span>
      </button>
    </div>`;
}

function galleryHTML(apps) {
  return `
  <section class="gallery" id="apps" aria-labelledby="apps-title">
    <div class="gallery-stage">
      <header class="gallery-head container">
        <div>
          <p class="eyebrow reveal">The apps</p>
          <h2 id="apps-title" data-split="chars">Pick an app. <em>See what's broken.</em></h2>
        </div>
        <div class="gallery-meta reveal" style="--d:300ms">
          <span class="gallery-count" aria-hidden="true"><b>01</b> / <span class="gallery-inf">∞</span></span>
          <div class="gallery-arrows">
            <button type="button" class="icon-btn gal-prev" aria-label="Previous apps"><span aria-hidden="true">←</span></button>
            <button type="button" class="icon-btn gal-next" aria-label="Next apps"><span aria-hidden="true">→</span></button>
          </div>
          <button type="button" class="btn btn-glass btn-sm" data-palette>Analyze any app <kbd>⌘K</kbd></button>
        </div>
      </header>
      <div class="gallery-viewport" role="region" aria-label="Analyzed apps" tabindex="0"><div class="gallery-track">${apps.slice(0, GALLERY_MAX).map(cardHTML).join("")}${searchCardHTML(apps.length)}</div></div>
      <div class="gallery-bar container" aria-hidden="true"><span></span></div>
    </div>
  </section>`;
}

/** A row that scrolls sideways on its own: a sideways swipe (or the arrows)
 *  moves the apps, an up/down scroll keeps moving the page. */
function setupGallery(main, scope) {
  const section = $(".gallery", main);
  const viewport = $(".gallery-viewport", section);
  const track = $(".gallery-track", section);
  const wraps = $$(".gcard-wrap", section);
  const appCards = Math.max(1, wraps.filter((w) => !w.classList.contains("gcard-wrap--search")).length);
  const count = $(".gallery-count b", section);
  const bar = $(".gallery-bar span", section);
  const prev = $(".gal-prev", section);
  const next = $(".gal-next", section);

  const pad = () => {
    const px = `${Math.max(16, (window.innerWidth - 1280) / 2 + 40)}px`;
    track.style.paddingLeft = px;
    track.style.paddingRight = px;
  };
  pad();
  scope.resize(pad);

  // Smooth scrolling owns the page's wheel events; keep sideways ones here so
  // the browser scrolls the row natively.
  scope.on(viewport, "wheel", (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.stopPropagation();
  }, { passive: true });

  const step = () => (wraps[0]?.offsetWidth || 380) + 28;
  scope.on(prev, "click", () => viewport.scrollBy({ left: -step() * 2, behavior: reducedMotion.matches ? "auto" : "smooth" }));
  scope.on(next, "click", () => viewport.scrollBy({ left: step() * 2, behavior: reducedMotion.matches ? "auto" : "smooth" }));

  let lastLeft = viewport.scrollLeft;
  let skew = 0;
  let lastIdx = -1;
  scope.frame(() => {
    const r = section.getBoundingClientRect();
    if (r.bottom < -100 || r.top > window.innerHeight + 100) return;
    const left = viewport.scrollLeft;
    const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    bar.style.transform = `scaleX(${(0.04 + (max ? left / max : 0) * 0.96).toFixed(4)})`;
    prev.disabled = left <= 2;
    next.disabled = left >= max - 2;

    const mid = window.innerWidth / 2;
    let best = 0;
    let bestD = Infinity;
    wraps.forEach((w, i) => {
      const b = w.getBoundingClientRect();
      const d = (b.left + b.width / 2 - mid) / window.innerWidth;
      if (Math.abs(d) < bestD) { bestD = Math.abs(d); best = i; }
      if (reducedMotion.matches) return;
      const ad = Math.min(Math.abs(d), 1.2);
      w.style.transform = `perspective(1400px) rotateY(${(d * -16).toFixed(2)}deg) translateZ(${(-ad * 90).toFixed(1)}px) translateY(${(ad * ad * 26).toFixed(1)}px)`;
      w.style.opacity = (1 - Math.max(0, ad - 0.55) * 0.9).toFixed(3);
    });
    if (!reducedMotion.matches) {
      skew = lerp(skew, clamp((left - lastLeft) * -0.25, -7, 7), 0.12);
      track.style.transform = Math.abs(skew) > 0.01 ? `skewX(${skew.toFixed(2)}deg)` : "";
    }
    lastLeft = left;
    // The trailing search card isn't an app, so the counter stops at the last one.
    const shownIdx = Math.min(best, appCards - 1);
    if (shownIdx !== lastIdx) { count.textContent = pad2(shownIdx + 1); lastIdx = shownIdx; }
  });
}

// --------------------------------------------------------------------------
// method + footer
// --------------------------------------------------------------------------
function methodHTML(reviews, themes, critical) {
  return `
  <section class="method container" id="how" aria-labelledby="how-title">
    <div class="method-head">
      <p class="eyebrow reveal">The method</p>
      <h2 id="how-title" data-split="chars">Big and painful <em>rises to the top.</em></h2>
      <p class="lede reveal" style="--d:200ms">A theme matters when lots of people raise it and they're unhappy about it. Priority weighs both equally, on a scale of 0 to 100.</p>
    </div>
    <div class="method-grid">
      <div class="quad reveal" style="--d:100ms" aria-label="Priority quadrants">
        <div><b>Low signal</b><span>Few mentions, rated well</span></div>
        <div><b>Protect</b><span>Many mentions, rated well</span></div>
        <div><b>Watch</b><span>Few mentions, rated badly</span></div>
        <div class="hot"><b>Fix first</b><span>Many mentions, rated badly</span></div>
        <span class="quad-x">More reviews →</span>
        <span class="quad-y">Higher rating →</span>
      </div>
      <div class="method-stats">
        <div class="mstat reveal"><b class="count" data-to="${reviews}">0</b><span>reviews read</span></div>
        <div class="mstat reveal" style="--d:100ms"><b class="count" data-to="${themes}">0</b><span>themes found</span></div>
        <div class="mstat reveal" style="--d:200ms"><b class="count" data-to="${critical}">0</b><span>critical issues</span></div>
        <div class="mstat reveal" style="--d:300ms"><b>∞</b><span>apps you can search</span></div>
      </div>
    </div>
  </section>`;
}

function footerHTML() {
  const word = "Triage";
  return `
  <footer class="bigfoot">
    <div class="container bigfoot-row">
      <span>Reviews from the public App Store and Google Play. Themes found and written up by Triage.</span>
      <nav aria-label="Footer"><a href="#/">Story</a><a href="#/apps">Apps</a><button type="button" class="link-btn" data-palette>Search</button></nav>
    </div>
    <div class="bigfoot-word" aria-hidden="true">${[...word].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</div>
  </footer>`;
}

/** Highlight Story / Apps / Method in the top nav for whichever is on screen. */
function setupNavSpy(main, scope) {
  const links = $$(".nav-links a");
  const map = { story: "story", apps: "apps", how: "how" };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.toggle("active", a.dataset.nav === map[e.target.id]));
    }
  }, { rootMargin: "-50% 0px -50% 0px" });
  ["story", "apps", "how"].forEach((id) => { const el = $(`#${id}`, main); if (el) io.observe(el); });
  scope.add(() => io.disconnect());
}

function setupFooter(main, scope) {
  const foot = $(".bigfoot", main);
  const letters = $$(".bigfoot-word span", foot);
  if (reducedMotion.matches) return;
  scope.frame(() => {
    const r = foot.getBoundingClientRect();
    if (r.top > window.innerHeight) return;
    const p = clamp((window.innerHeight - r.top) / r.height, 0, 1);
    letters.forEach((l, i) => {
      const t = clamp((p - 0.15 - i * 0.06) / 0.5, 0, 1);
      l.style.transform = `translate3d(0, ${((1 - t) * 105).toFixed(1)}%, 0) rotate(${((1 - t) * 8).toFixed(2)}deg)`;
    });
  });
}
