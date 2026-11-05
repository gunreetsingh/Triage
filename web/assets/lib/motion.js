/* Motion engine: one rAF loop drives smooth scrolling (Lenis, when it loaded),
 * scroll-linked scenes, and every per-frame effect. Views register work in a
 * Scope so leaving a page tears all of it down.
 *
 * Only the homepage is a show. Reports and the progress page run in "tool"
 * mode (html[data-mode="tool"]): native scrolling, no pointer effects, no
 * cursor ring or grain, and content that is simply there.
 *
 * Everything degrades: without Lenis it's native scrolling; with
 * prefers-reduced-motion there's no smoothing, no scrubbing and no curtain. */
import { $, $$, clamp, lerp, ease, reducedMotion, coarsePointer } from "./util.js";

// --------------------------------------------------------------------------
// scroll + frame loop
// --------------------------------------------------------------------------
let lenis = null;
const frameSubs = new Set();
let lastY = window.scrollY;
let velocity = 0;

export const scroller = {
  get velocity() { return velocity; },
  get smooth() { return Boolean(lenis); },
  to(target, { offset = 0, immediate = false } = {}) {
    const instant = immediate || reducedMotion.matches;
    if (lenis) {
      lenis.scrollTo(target, { offset, immediate: instant, duration: 1.6, easing: ease.inOutQuart, force: true });
      return;
    }
    const y = typeof target === "number" ? target : target.getBoundingClientRect().top + window.scrollY + offset;
    window.scrollTo({ top: y, behavior: instant ? "instant" : "smooth" });
  },
  stop() { lenis?.stop(); },
  start() { lenis?.start(); },
  resize() { lenis?.resize(); },
  /** Smooth scrolling on (the homepage) or off (the tool pages). */
  setSmooth(on) {
    if (on && !lenis && window.Lenis && !reducedMotion.matches) {
      lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.95, smoothWheel: true });
      document.documentElement.classList.add("lenis");
    } else if (!on && lenis) {
      lenis.destroy();
      lenis = null;
      document.documentElement.classList.remove("lenis", "lenis-smooth", "lenis-stopped");
    }
  },
};

const toolMode = () => document.documentElement.dataset.mode === "tool";

/** "show" for the homepage, "tool" for reports and progress. */
export function setMode(mode) {
  document.documentElement.dataset.mode = mode;
  scroller.setSmooth(mode === "show");
}

export function initScroll() {
  const loop = (t) => {
    lenis?.raf(t);
    const y = window.scrollY;
    velocity = lerp(velocity, y - lastY, 0.18);
    lastY = y;
    for (const fn of frameSubs) fn(t, y, velocity);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export function onFrame(fn) {
  frameSubs.add(fn);
  return () => frameSubs.delete(fn);
}

/** 0 when el's top reaches the top of the viewport, 1 when its bottom does. */
export function progressOf(el) {
  const r = el.getBoundingClientRect();
  const total = r.height - window.innerHeight;
  if (total <= 0) return r.top <= 0 ? 1 : 0;
  return clamp(-r.top / total, 0, 1);
}

/** 0 when el enters from the bottom, 1 when it leaves through the top. */
export function passOf(el) {
  const r = el.getBoundingClientRect();
  return clamp((window.innerHeight - r.top) / (window.innerHeight + r.height), 0, 1);
}

// --------------------------------------------------------------------------
// scopes: everything a view sets up, torn down together
// --------------------------------------------------------------------------
export class Scope {
  constructor() { this.fns = []; }
  add(fn) { this.fns.push(fn); return fn; }
  frame(fn) { return this.add(onFrame(fn)); }
  on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.add(() => target.removeEventListener(type, fn, opts));
  }
  resize(fn) {
    let timer = 0;
    const handler = () => { clearTimeout(timer); timer = setTimeout(fn, 120); };
    this.on(window, "resize", handler);
  }
  dispose() {
    for (const fn of this.fns.splice(0).reverse()) {
      try { fn(); } catch { /* best effort */ }
    }
  }
}

// --------------------------------------------------------------------------
// reveal on scroll, split text, counters
// --------------------------------------------------------------------------
export function runCount(el, animate, duration = 1600) {
  const to = Number(el.dataset.to);
  const from = Number(el.dataset.from || 0);
  const dec = Number(el.dataset.dec || 0);
  const suffix = el.dataset.suffix || "";
  const render = (v) => {
    el.textContent = `${v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}${suffix}`;
  };
  if (!animate || reducedMotion.matches || from === to) return render(to);
  const start = performance.now();
  const tick = (now) => {
    const t = clamp((now - start) / duration, 0, 1);
    render(from + (to - from) * ease.outExpo(t));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Wrap each word (and, for "chars", each letter) so CSS can stagger them.
 *  Inline elements such as <em> are preserved around their words. */
export function splitText(el, by = "chars") {
  if (el.dataset.splitDone) return;
  const label = el.textContent.replace(/\s+/g, " ").trim();
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const node of Array.from(el.childNodes)) {
    const wrapper = node.nodeType === 1 ? node : null;
    for (const part of node.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.append(document.createTextNode(" ")); continue; }
      const word = document.createElement("span");
      word.className = "w";
      if (by === "chars") {
        for (const ch of part) {
          const c = document.createElement("span");
          c.className = "c";
          c.style.setProperty("--i", i++);
          c.textContent = ch;
          word.append(c);
        }
      } else {
        word.style.setProperty("--i", i++);
        word.textContent = part;
      }
      if (wrapper) {
        const shell = wrapper.cloneNode(false);
        shell.append(word);
        frag.append(shell);
      } else {
        frag.append(word);
      }
    }
  }
  el.textContent = "";
  el.append(frag);
  for (const child of el.children) child.setAttribute("aria-hidden", "true");
  el.setAttribute("aria-label", label);
  el.style.setProperty("--n", i);
  el.dataset.splitDone = "1";
}

export function reveal(root, scope, { instant = false, countUp = instant } = {}) {
  $$("[data-split]", root).forEach((el) => splitText(el, el.dataset.split || "chars"));
  const targets = $$(".reveal, [data-split]", root);
  if (instant || reducedMotion.matches) {
    for (const el of targets) {
      el.classList.add("in");
      $$(".count", el).forEach((c) => runCount(c, countUp && !reducedMotion.matches, 700));
    }
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
        $$(".count", e.target).forEach((c) => runCount(c, true));
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  targets.forEach((el) => io.observe(el));
  scope.add(() => io.disconnect());
}

/** Light words up one by one as `section` scrolls past (Apple-style). */
export function scrubWords(section, textEl, scope, { from = 0.05, to = 0.75 } = {}) {
  splitText(textEl, "words");
  const words = $$(".w", textEl);
  if (reducedMotion.matches) { words.forEach((w) => { w.style.opacity = 1; }); return; }
  const last = new Float32Array(words.length).fill(-1);
  scope.frame(() => {
    const p = clamp((progressOf(section) - from) / (to - from), 0, 1);
    const lit = p * (words.length + 2);
    for (let i = 0; i < words.length; i++) {
      const o = 0.14 + 0.86 * clamp(lit - i, 0, 1);
      if (Math.abs(o - last[i]) > 0.004) {
        words[i].style.opacity = o.toFixed(3);
        words[i].style.filter = o < 0.98 ? `blur(${((1 - o) * 3).toFixed(2)}px)` : "";
        last[i] = o;
      }
    }
  });
}

// --------------------------------------------------------------------------
// pointer effects: magnetic buttons, 3D tilt, cursor-follow glow
// (delegated, so they work on anything rendered later)
// --------------------------------------------------------------------------
export function initPointerFx() {
  if (coarsePointer.matches) return;

  let tiltEl = null;
  let magEl = null;
  document.addEventListener("pointermove", (e) => {
    if (toolMode()) return;
    const t = e.target.closest?.("[data-tilt]") || null;
    if (tiltEl && tiltEl !== t) resetTilt(tiltEl);
    tiltEl = t;
    if (t && !reducedMotion.matches) {
      const r = t.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const max = Number(t.dataset.tilt) || 8;
      t.style.setProperty("--rx", `${((0.5 - py) * max).toFixed(2)}deg`);
      t.style.setProperty("--ry", `${((px - 0.5) * max).toFixed(2)}deg`);
      t.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
      t.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
      t.classList.add("tilting");
    }

    const m = e.target.closest?.(".magnetic") || null;
    if (magEl && magEl !== m) magEl.style.transform = "";
    magEl = m;
    if (m && !reducedMotion.matches) {
      const r = m.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      m.style.transform = `translate(${(dx * 0.22).toFixed(1)}px, ${(dy * 0.3).toFixed(1)}px)`;
    }

    const g = e.target.closest?.(".glow-hover");
    if (g) {
      const r = g.getBoundingClientRect();
      g.style.setProperty("--gx", `${e.clientX - r.left}px`);
      g.style.setProperty("--gy", `${e.clientY - r.top}px`);
    }
  }, { passive: true });

  document.addEventListener("pointerleave", () => {
    if (tiltEl) resetTilt(tiltEl);
    if (magEl) magEl.style.transform = "";
    tiltEl = null;
    magEl = null;
  });
}

function resetTilt(el) {
  el.style.setProperty("--rx", "0deg");
  el.style.setProperty("--ry", "0deg");
  el.classList.remove("tilting");
}

/** A soft ring that trails the pointer and swells over anything clickable. */
export function initCursor() {
  if (coarsePointer.matches || reducedMotion.matches) return;
  const ring = document.createElement("div");
  ring.className = "cursor";
  ring.setAttribute("aria-hidden", "true");
  ring.innerHTML = '<span class="cursor-label"></span>';
  document.body.append(ring);
  const label = ring.firstElementChild;
  let x = -100, y = -100, tx = -100, ty = -100;
  let visible = false;

  document.addEventListener("pointermove", (e) => {
    tx = e.clientX;
    ty = e.clientY;
    if (!visible) { x = tx; y = ty; visible = true; ring.classList.add("on"); }
    const hit = e.target.closest?.("a, button, [role=button], input, select, [data-cursor]");
    const text = hit?.closest("[data-cursor]")?.dataset.cursor || "";
    ring.classList.toggle("hover", Boolean(hit));
    ring.classList.toggle("labelled", Boolean(text));
    if (label.textContent !== text) label.textContent = text;
  }, { passive: true });
  document.addEventListener("pointerleave", () => { visible = false; ring.classList.remove("on"); });

  onFrame(() => {
    x = lerp(x, tx, 0.2);
    y = lerp(y, ty, 0.2);
    ring.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  });
}

// --------------------------------------------------------------------------
// page curtain
// --------------------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const curtain = {
  el: null,
  async cover({ color, mark = "", ink = "#ffffff" } = {}) {
    const el = this.el || (this.el = $(".curtain"));
    if (!el || reducedMotion.matches) return;
    el.style.setProperty("--cc", color || "var(--curtain)");
    el.style.setProperty("--ct", ink);
    $(".curtain-mark", el).innerHTML = mark;
    el.classList.remove("out", "boot");
    void el.offsetWidth;
    el.classList.add("in");
    await wait(560);
  },
  /** Drop the boot curtain at once, for a first load that lands on a tool page. */
  hide() {
    const el = this.el || (this.el = $(".curtain"));
    if (!el) return;
    el.style.transition = "none";
    el.classList.remove("in", "out", "boot");
    void el.offsetWidth;
    el.style.transition = "";
  },
  async uncover() {
    const el = this.el || (this.el = $(".curtain"));
    if (!el) return;
    if (reducedMotion.matches) { el.classList.remove("in", "boot"); return; }
    el.classList.remove("boot");
    el.classList.add("in", "out");
    await wait(30);
    el.classList.remove("in");
    await wait(760);
    el.classList.remove("out");
  },
};
