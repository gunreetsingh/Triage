/* #/analyze/<job>: live progress while the server analyzes an app nobody has
 * asked for before. Polls the job, lights up each step, and draws a ring of
 * particles that fills as reviews arrive and gathers into themes as they form.
 * When the report is ready it swaps itself for the app page. */
import { $, $$, esc, int, clamp, lerp, marketName, reducedMotion, rng, cssRgb, isDark } from "../lib/util.js";
import { api, invalidate } from "../lib/data.js";

const STEPS = [
  { key: "resolve", label: "Finding it on the App Store and Google Play" },
  { key: "scrape", label: "Reading the latest reviews" },
  { key: "embed", label: "Mapping what each review means" },
  { key: "cluster", label: "Grouping similar reviews into themes" },
  { key: "analyze", label: "Triage names each theme and writes a fix" },
  { key: "score", label: "Ranking themes and building the report" },
];
const STEP_OF = { queued: -1, resolve: 0, scrape: 1, scraped: 1, embed: 2, cluster: 3, analyze: 4, score: 5, publish: 5, done: 6 };
const TAU = Math.PI * 2;

const icon = (job) => (/^https:\/\/[a-z0-9.-]+\.mzstatic\.com\//.test(job.icon || "")
  ? `<img class="an-icon" src="${esc(job.icon)}" alt="${esc(job.name)} logo" referrerpolicy="no-referrer">`
  : `<span class="an-icon app-icon--letter" aria-hidden="true">${esc((job.name || "?").charAt(0))}</span>`);

export async function renderAnalyzing(main, scope, jobId) {
  let job;
  try {
    job = await api.job(jobId);
  } catch (e) {
    main.innerHTML = goneHTML(e.status === 404 ? "That analysis isn't running any more." : e.message);
    return;
  }

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
            ${STEPS.map((s, i) => `<li data-i="${i}"><span class="an-dot" aria-hidden="true"></span><span class="an-label">${s.label}<small></small></span></li>`).join("")}
          </ol>
          <div class="an-foot"><span class="an-time">0:00</span><span>Usually about a minute. Keep this page open and the report opens on its own.</span></div>
        </div>
        <div class="an-error" hidden></div>
      </div>
    </section>`;

  const section = $(".analyzing", main);
  const ring = setupRing($(".an-canvas", section), scope);
  const started = job.created ? job.created * 1000 : Date.now();
  const timeEl = $(".an-time", section);
  const tick = setInterval(() => {
    const s = Math.max(0, Math.round((Date.now() - started) / 1000));
    timeEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  scope.add(() => clearInterval(tick));

  let stopped = false;
  let timer = 0;
  scope.add(() => { stopped = true; clearTimeout(timer); });

  const paint = (j) => {
    const step = STEP_OF[j.stage] ?? -1;
    $$(".an-steps li", section).forEach((li, i) => {
      li.classList.toggle("done", i < step || j.status === "done");
      li.classList.toggle("now", i === step && j.status === "running");
    });
    const small = (i) => $(`.an-steps li[data-i="${i}"] small`, section);
    if (j.reviews != null) small(1).textContent = `: ${int(j.reviews)} reviews${j.android ? " from both stores" : " from the App Store"}`;
    if (j.themes != null) small(3).textContent = `: ${int(j.themes)} themes`;
    if (j.stage === "analyze" && !j.llm) small(4).textContent = ": no API key on this server, so themes keep keyword labels";
    const wait = $(".an-wait", section);
    wait.hidden = j.status !== "queued";
    if (j.status === "queued") wait.textContent = j.ahead ? `Waiting in line. ${j.ahead} ${j.ahead === 1 ? "analysis" : "analyses"} ahead of you.` : "Starting…";
    ring.update(j, step);
  };

  const fail = (message) => {
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
  };

  const poll = async () => {
    if (stopped) return;
    try {
      job = await api.job(jobId);
    } catch (e) {
      fail(e.status === 404 ? "The server restarted before this analysis finished. Search for the app again to retry." : e.message);
      return;
    }
    paint(job);
    if (job.status === "done" && job.slug) {
      invalidate(job.slug);
      // Replace this entry so Back goes to wherever the search started.
      timer = setTimeout(() => { if (!stopped) location.replace(`#/app/${encodeURIComponent(job.slug)}`); }, 700);
      return;
    }
    if (job.status === "failed") { fail(job.error || "Something went wrong."); return; }
    timer = setTimeout(poll, 1000);
  };
  paint(job);
  timer = setTimeout(poll, 800);
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
