/* Progress while an app nobody has asked for before is analyzed.
 *   #/analyze/<job>  server.py runs the pipeline; this page polls the job.
 *   #/live/<id>/<cc> Vercel: this page calls each step itself, builds the
 *                    report in the browser and keeps it for this tab.
 * Both light up each step and draw a ring of particles that fills as reviews
 * arrive and gathers into themes as they form, then swap in the report. */
import { $, $$, esc, int, clamp, lerp, marketName, reducedMotion, rng, cssRgb, isDark } from "../lib/util.js";
import { api, invalidate, saveLive } from "../lib/data.js";

const STEPS = [
  { key: "resolve", label: "Finding it on the App Store and Google Play" },
  { key: "scrape", label: "Reading the latest reviews" },
  { key: "embed", label: "Mapping what each review means" },
  { key: "cluster", label: "Grouping similar reviews into themes" },
  { key: "analyze", label: "Triage names each theme and writes a fix" },
  { key: "score", label: "Ranking themes and building the report" },
];
const STEP_OF = { queued: -1, resolve: 0, scrape: 1, scraped: 1, embed: 2, cluster: 3, analyze: 4, score: 5, publish: 5, done: 6 };
const LIVE_STEPS = [
  { label: "Finding it on the App Store and Google Play" },
  { label: "Reading the reviews each store shows first" },
  { label: "Triage groups them into themes and writes a fix" },
  { label: "Ranking themes and building the report" },
];
const TAU = Math.PI * 2;

const icon = (job) => (/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//.test(job.icon || "")
  ? `<img class="an-icon" src="${esc(job.icon)}" alt="${esc(job.name)} logo" referrerpolicy="no-referrer">`
  : `<span class="an-icon app-icon--letter" aria-hidden="true">${esc((job.name || "?").charAt(0))}</span>`);

/** The page both modes share: header, step list, timer, ring and error box. */
function layout(main, scope, job, steps, started) {
  main.innerHTML = `
    <section class="analyzing" aria-live="polite">
      <canvas class="an-canvas" aria-hidden="true"></canvas>
      <div class="container an-inner">
        <div class="an-icon-wrap">${icon(job)}</div>
        <p class="eyebrow an-eyebrow">Analyzing · ${esc(marketName(job.country))} App Store</p>
        <h1 class="an-title">${esc(job.name)}</h1>
        <p class="an-sub">${esc(job.publisher || "")}</p>
        <div class="an-panel">
          <p class="an-wait" hidden></p>
          <ol class="an-steps">
            ${steps.map((s, i) => `<li data-i="${i}"><span class="an-dot" aria-hidden="true"></span><span class="an-label">${s.label}<small></small></span></li>`).join("")}
          </ol>
          <div class="an-foot"><span class="an-time">0:00</span><span>Usually about a minute. Keep this page open and the report opens on its own.</span></div>
        </div>
        <div class="an-error" hidden></div>
      </div>
    </section>`;

  const section = $(".analyzing", main);
  const ring = setupRing($(".an-canvas", section), scope);
  const timeEl = $(".an-time", section);
  const tick = setInterval(() => {
    const s = Math.max(0, Math.round((Date.now() - started) / 1000));
    timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  scope.add(() => clearInterval(tick));

  return {
    section,
    ring,
    small: (i) => $(`.an-steps li[data-i="${i}"] small`, section),
    /** Mark the steps before `step` done and `step` itself in progress. */
    steps(step, running = true) {
      $$(".an-steps li", section).forEach((li, i) => {
        li.classList.toggle("done", i < step);
        li.classList.toggle("now", i === step && running);
      });
    },
    fail(message) {
      $(".an-panel", section).hidden = true;
      const box = $(".an-error", section);
      box.hidden = false;
      box.innerHTML = `
        <h2>Couldn't analyze this one</h2>
        <p>${esc(message)}</p>
        <div class="an-actions">
          <button type="button" class="btn btn-primary" data-palette>Search another app</button>
          <a class="btn btn-glass" href="#/apps">See analyzed apps</a>
        </div>`;
      ring.update({ status: "failed" }, -1);
    },
  };
}

export async function renderAnalyzing(main, scope, jobId) {
  let job;
  try {
    job = await api.job(jobId);
  } catch (e) {
    main.innerHTML = goneHTML(e.status === 404 ? "That analysis isn't running any more." : e.message);
    return;
  }

  const page = layout(main, scope, job, STEPS, job.created ? job.created * 1000 : Date.now());
  const { section, ring, small } = page;

  let stopped = false;
  let timer = 0;
  scope.add(() => { stopped = true; clearTimeout(timer); });

  const paint = (j) => {
    const step = j.status === "done" ? STEPS.length : STEP_OF[j.stage] ?? -1;
    page.steps(step, j.status === "running");
    if (j.reviews != null) small(1).textContent = `: ${int(j.reviews)} reviews${j.android ? " from both stores" : " from the App Store"}`;
    if (j.themes != null) small(3).textContent = `: ${int(j.themes)} themes`;
    if (j.stage === "analyze" && !j.llm) small(4).textContent = ": no API key on this server, so themes keep keyword labels";
    const wait = $(".an-wait", section);
    wait.hidden = j.status !== "queued";
    if (j.status === "queued") wait.textContent = j.ahead ? `Waiting in line. ${j.ahead} ${j.ahead === 1 ? "analysis" : "analyses"} ahead of you.` : "Starting…";
    ring.update(j, STEP_OF[j.stage] ?? -1);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      job = await api.job(jobId);
    } catch (e) {
      page.fail(e.status === 404 ? "The server restarted before this analysis finished. Search for the app again to retry." : e.message);
      return;
    }
    paint(job);
    if (job.status === "done" && job.slug) {
      invalidate(job.slug);
      // Replace this entry so Back goes to wherever the search started.
      timer = setTimeout(() => { if (!stopped) location.replace(`#/app/${encodeURIComponent(job.slug)}`); }, 700);
      return;
    }
    if (job.status === "failed") { page.fail(job.error || "Something went wrong."); return; }
    timer = setTimeout(poll, 1000);
  };
  paint(job);
  timer = setTimeout(poll, 800);
}

export async function renderLive(main, scope, iosId, country) {
  let pick = {};
  try { pick = JSON.parse(sessionStorage.getItem(`triage-pick:${iosId}`) || "{}") || {}; } catch { /* optional */ }
  const job = { name: pick.name || "This app", publisher: pick.publisher || "", icon: pick.icon, country };
  const page = layout(main, scope, job, LIVE_STEPS, Date.now());
  const { section, ring, small } = page;

  let stopped = false;
  scope.add(() => { stopped = true; });

  await api.check();
  if (!api.live) {
    page.fail("Live analysis isn't available on this site. Open one of the analyzed apps instead.");
    return;
  }

  try {
    page.steps(0);
    ring.update({}, 0);
    const data = await api.collect(iosId, country);
    if (stopped) return;
    $(".an-title", section).textContent = data.name;
    $(".an-sub", section).textContent = data.publisher || "";
    const both = data.listings.length > 1;
    small(1).textContent = `: ${int(data.reviews.length)} reviews${both ? " from both stores" : " from the App Store"}`;
    page.steps(2);
    ring.update({ reviews: data.reviews.length }, 3);

    const res = await api.themes(data.name, data.reviews, data.token);
    if (stopped) return;
    const assign = res.assign || {};
    small(2).textContent = `: ${int(res.themes.length)} themes`;
    page.steps(3);
    ring.update({ reviews: data.reviews.length, themes: res.themes.length }, 5);

    saveLive({
      slug: data.slug,
      name: data.name,
      generated_at: data.generated_at,
      market: data.market,
      ios_sort: "helpful",
      android_sort: "relevant",
      llm: true,
      icon: data.icon,
      brand: null,
      has_map: false,
      listings: data.listings,
      themes: res.themes,
      reviews: data.reviews.filter((r) => r.i in assign).map((r) => ({ ...r, c: assign[r.i] })),
    });
    page.steps(LIVE_STEPS.length, false);
    ring.update({ status: "done", reviews: data.reviews.length, themes: res.themes.length }, 6);
    // Replace this entry so Back goes to wherever the search started.
    setTimeout(() => { if (!stopped) location.replace(`#/app/${encodeURIComponent(data.slug)}`); }, 600);
  } catch (e) {
    if (!stopped) page.fail(e.message || "Something went wrong.");
  }
}

function goneHTML(message) {
  return `<section class="state"><div>
    <h1>Nothing to show here</h1>
    <p>${esc(message)}</p>
    <button type="button" class="btn btn-primary" data-palette>Search for an app</button>
  </div></section>`;
}

/** A ring of particles: more join as reviews arrive; they gather into theme
 *  clusters once grouping starts, and settle when the report is ready. */
function setupRing(canvas, scope) {
  const ctx = canvas.getContext("2d");
  const rand = rng(29);
  const parts = [];
  let w = 1, h = 1, dpr = 1;
  let target = 36;
  let step = -1;
  let groups = 8;
  let finished = false;
  let colors = { a: cssRgb("--accent"), b: cssRgb("--hero-em"), ink: cssRgb("--ink") };

  const resize = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  };
  resize();
  scope.resize(resize);
  scope.on(window, "themechange", () => { colors = { a: cssRgb("--accent"), b: cssRgb("--hero-em"), ink: cssRgb("--ink") }; });

  const spawn = () => parts.push({
    a: rand() * TAU,
    r: 0.55 + rand() * 0.9,          // starts outside, falls inward
    home: 0.78 + rand() * 0.44,       // resting band around the ring
    speed: (0.0012 + rand() * 0.0018) * (rand() < 0.5 ? 1 : 1),
    size: 0.8 + rand() * 1.6,
    mix: rand(),
    born: performance.now(),
  });

  scope.frame((time) => {
    while (parts.length < target && parts.length < 650) spawn();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = isDark() ? "lighter" : "source-over";
    const cx = w / 2;
    const cy = h * 0.36;
    const R = Math.min(w, h) * (w < 700 ? 0.42 : 0.3);
    const gather = step >= 3 ? 1 : 0;
    const pace = reducedMotion.matches ? 0 : finished ? 0.25 : 1 + step * 0.25;

    for (const p of parts) {
      p.a += p.speed * pace;
      p.r = lerp(p.r, p.home, 0.02);
      if (gather) {
        const slot = Math.round(p.a / (TAU / groups)) * (TAU / groups);
        p.a = lerp(p.a, slot, 0.012);
      }
      const age = clamp((time - p.born) / 900, 0, 1);
      const x = cx + Math.cos(p.a) * p.r * R;
      const y = cy + Math.sin(p.a) * p.r * R * 0.62;
      const c = p.mix < 0.5 ? colors.a : colors.b;
      ctx.globalAlpha = age * (0.35 + 0.5 * (0.5 + 0.5 * Math.sin(p.a)));
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath();
      ctx.arc(x, y, p.size * (1 + 0.6 * (0.5 + 0.5 * Math.sin(p.a))), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  });

  return {
    update(job, s) {
      step = s;
      if (job.reviews != null) target = Math.min(650, Math.max(60, job.reviews));
      else if (s >= 1) target = Math.max(target, 140);
      if (job.themes) groups = job.themes;
      finished = job.status === "done" || job.status === "failed";
    },
  };
}
