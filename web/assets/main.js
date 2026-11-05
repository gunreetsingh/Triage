/* Entry point: boot the motion engine, then route.
 *   #/               home (story → apps → method)
 *   #/apps, #/how    home, scrolled to that section
 *   #/app/<slug>     an app's report
 *   #/app/<slug>/<n> the same, with theme n open in the drawer
 *   #/analyze/<job>  live progress while the server analyzes a new app
 * The homepage is the show: a curtain on first load, smooth scrolling, scroll
 * reveals. Reports and progress pages are the tool: they swap in at once. */
import { $, $$, esc, reducedMotion } from "./lib/util.js";
import { loadManifest, loadApp } from "./lib/data.js";
import { initScroll, initPointerFx, initCursor, onFrame, Scope, reveal, curtain, scroller, setMode } from "./lib/motion.js";
import { initDrawer, openDrawer, closeDrawer } from "./lib/drawer.js";
import { initPalette, closePalette } from "./lib/palette.js";
import { hideTip } from "./lib/charts.js";
import { renderHome } from "./views/home.js";
import { renderApp } from "./views/appview.js";
import { renderAnalyzing } from "./views/analyzing.js";

const main = $("#main");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let scope = null;
let viewKey = null;
let booted = false;
const bootFloor = wait(reducedMotion.matches ? 0 : 1100);

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "analyze" && parts[1]) return { view: "analyze", job: parts[1] };
  if (parts[0] === "app" && parts[1]) {
    const theme = parts[2] !== undefined && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
    return { view: "app", slug: parts[1], theme };
  }
  return { view: "home", section: parts[0] === "how" || parts[0] === "apps" ? parts[0] : null };
}

function setNav(key) {
  $$(".nav-links a").forEach((a) => a.classList.toggle("active", a.dataset.nav === key));
}

function renderState(title, body, extra = "") {
  main.innerHTML = `<section class="state"><div><h1>${title}</h1><p>${body}</p>${extra}</div></section>`;
}

function renderLoadError(err) {
  if (location.protocol === "file:") {
    renderState(
      "Open this through a local server",
      "Browsers block reading data files from a page opened straight from disk. From the project folder, run:",
      "<code>python -m http.server 8600 -d web</code><p>then visit <b>localhost:8600</b>.</p>",
    );
    return;
  }
  renderState("No data yet", `The site couldn't load its data (${esc(err.message)}). Build it from your runs with:`, "<code>python -m triage.web</code>");
}

/** Swap the page. mode "show" is the homepage; "tool" pages appear at once. */
async function show(key, render, mode = "tool") {
  hideTip();
  closeDrawer({ silent: true });
  closePalette();
  scope?.dispose();
  scope = new Scope();
  viewKey = key;
  setMode(mode);
  main.innerHTML = "";
  scroller.to(0, { immediate: true });
  window.scrollTo(0, 0);
  try {
    await render(scope);
  } catch (err) {
    console.error(err);
    renderLoadError(err);
  }
  scroller.resize();
  const tool = mode === "tool";
  if (tool) reveal(main, scope, { instant: true, countUp: false });

  if (!booted) {
    booted = true;
    if (tool) { curtain.hide(); return; }
    await bootFloor;
    curtain.uncover();
    await wait(reducedMotion.matches ? 0 : 260);
  } else {
    main.classList.remove("page-in");
    void main.offsetWidth;
    main.classList.add("page-in");
  }
  if (!tool) reveal(main, scope);
}

async function route() {
  const r = parseRoute();
  hideTip();

  if (r.view === "analyze") {
    await show(`analyze:${r.job}`, (s) => renderAnalyzing(main, s, r.job));
    setNav("");
    return;
  }

  if (r.view === "app") {
    const key = `app:${r.slug}`;
    if (viewKey === key) {
      if (r.theme !== null) openDrawer(r.theme, { pushed: true });
      else closeDrawer({ silent: true });
      return;
    }
    let meta = null;
    try { meta = (await loadManifest()).apps.find((a) => a.slug === r.slug); } catch { /* handled below */ }
    if (!meta) {
      await show("missing", async () => {
        renderState("App not found", "There's no analysis for that app yet.", '<a class="btn btn-primary" href="#/apps">All apps</a>');
      });
      return;
    }
    await show(key, async (s) => {
      const app = await loadApp(r.slug);
      await renderApp(main, s, app);
      setNav("");
    });
    if (r.theme !== null) openDrawer(r.theme, { pushed: false });
    return;
  }

  closeDrawer({ silent: true });
  const fresh = viewKey !== "home";
  if (fresh) await show("home", (s) => renderHome(main, s), "show");
  setNav(r.section || "story");
  if (r.section) {
    const target = $(`#${r.section}`);
    if (target) scroller.to(target, { immediate: fresh });
  } else if (!fresh) {
    scroller.to(0);
  }
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
initScroll();
initPointerFx();
initCursor();
initDrawer();
initPalette();

const nav = $(".nav");
const progress = $(".progress span");
onFrame((_, y) => {
  nav.classList.toggle("scrolled", y > 8);
  const max = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max).toFixed(4) : 0})`;
});

$(".theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("triage-theme-v3", next); } catch { /* private mode: just won't persist */ }
  window.dispatchEvent(new Event("themechange"));
});

let queue = Promise.resolve();
const enqueue = () => { queue = queue.then(route).catch((err) => console.error(err)); };
window.addEventListener("hashchange", enqueue);
enqueue();
