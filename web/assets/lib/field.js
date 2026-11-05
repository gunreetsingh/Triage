/* ReviewField: one particle per review, drawn on a canvas.
 *
 * Every particle has four homes, and the scene interpolates between them:
 *   galaxy - a slowly turning disc (the homepage hero)
 *   cloud  - a loose ball: "all the reviews, unsorted"
 *   map    - its real t-SNE position, so neighbours really are similar reviews
 *   bars   - its slot in its theme's bar in the ranked backlog
 *
 * mode "story" maps scroll progress onto that sequence; mode "map" is the
 * interactive per-app version (explode-in, hover to read, click to open). */
import { clamp, lerp, ease, rng, span, cssRgb, hexToRgb, isDark, reducedMotion } from "./util.js";
import { TIERS } from "./data.js";

const TAU = Math.PI * 2;

// Story timeline, as fractions of the pinned section's scroll.
export const STORY = {
  hero: [0, 0.075],
  cloud: [0.1, 0.24],
  map: [0.27, 0.42],
  color: [0.46, 0.56],
  name: [0.6, 0.68],
  bars: [0.72, 0.86],
  final: [0.9, 0.97],
};

/** Staggered per-particle progress through [a, b]. */
function stagger(p, a, b, delay) {
  const local = (p - a) / (b - a);
  return ease.inOutCubic(clamp((local - delay * 0.42) / 0.58, 0, 1));
}

export class ReviewField {
  constructor(canvas, { reviews, themes, mode = "story", seed = 7 }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = mode;
    this.themes = themes; // ranked
    this.mouse = { x: -9999, y: -9999, active: false };
    this.p = 0;
    this.intro = mode === "map" ? 0 : 1;
    this.hover = -1;
    this.dim = null; // Uint8Array: 1 = in scope

    const N = (this.n = reviews.length);
    this.reviews = reviews;
    const rand = rng(seed);
    const themeIndex = new Map(themes.map((t, i) => [t.id, i]));
    this.theme = new Int16Array(N);
    this.gx = new Float32Array(N);
    this.gy = new Float32Array(N);
    this.hr = new Float32Array(N); // galaxy radius
    this.ha = new Float32Array(N); // galaxy angle
    this.hs = new Float32Array(N); // galaxy angular speed
    this.cr = new Float32Array(N); // cloud polar
    this.ca = new Float32Array(N);
    this.delay = new Float32Array(N);
    this.size = new Float32Array(N);
    this.rating = new Uint8Array(N);
    this.ox = new Float32Array(N); // mouse displacement
    this.oy = new Float32Array(N);
    this.x = new Float32Array(N); // last drawn position (hit-testing)
    this.y = new Float32Array(N);

    // Fallback map positions for apps without embeddings: blobs on a ring.
    const K = Math.max(1, themes.length);
    for (let i = 0; i < N; i++) {
      const r = reviews[i];
      const ti = themeIndex.get(r.c) ?? 0;
      this.theme[i] = ti;
      if (r.g) {
        this.gx[i] = r.g[0];
        this.gy[i] = r.g[1];
      } else {
        const a = (ti / K) * TAU;
        const g = () => (rand() + rand() + rand() - 1.5) * 0.24;
        this.gx[i] = Math.cos(a) * 0.62 + g();
        this.gy[i] = Math.sin(a) * 0.62 + g();
      }
      this.hr[i] = 0.12 + Math.sqrt(rand()) * 0.95;
      this.ha[i] = rand() * TAU;
      this.hs[i] = (0.05 + rand() * 0.05) / (0.35 + this.hr[i]);
      this.cr[i] = Math.sqrt(rand());
      this.ca[i] = rand() * TAU;
      this.delay[i] = rand();
      this.size[i] = 0.75 + rand() * 0.6;
      this.rating[i] = r.r;
    }

    // Members of each theme, ordered left-to-right on the map, so the move
    // into the bars keeps particles roughly in place.
    this.members = themes.map(() => []);
    for (let i = 0; i < N; i++) this.members[this.theme[i]].push(i);
    this.members.forEach((list) => list.sort((a, b) => this.gx[a] - this.gx[b]));

    this.bx = new Float32Array(N);
    this.by = new Float32Array(N);
    this.mx = new Float32Array(N);
    this.my = new Float32Array(N);
    this.readColors();
    this.resize();
  }

  readColors() {
    this.dark = isDark();
    this.ratingRgb = [0, 1, 2, 3, 4, 5].map((s) => (s ? cssRgb(`--r${s}`) : [128, 128, 128]));
    this.tierRgb = this.themes.map((t) => hexToRgb(TIERS[t.tier].hex));
    this.ink = cssRgb("--ink");
  }

  setThemes(themes) {
    // Tiers can change when filters re-score; ids and members do not.
    const byId = new Map(themes.map((t) => [t.id, t]));
    this.themes = this.themes.map((t) => byId.get(t.id) || t);
    this.tierRgb = this.themes.map((t) => hexToRgb(TIERS[t.tier].hex));
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.mobile = this.w < 900;
    this.layout();
  }

  /** Where the map/bars live inside the canvas. */
  area() {
    const { w, h } = this;
    if (this.mode === "map") return { x: 24, y: 24, w: w - 48, h: h - 48 };
    return this.mobile
      ? { x: w * 0.05, y: h * 0.38, w: w * 0.9, h: h * 0.5 }
      : { x: w * 0.42, y: h * 0.14, w: w * 0.5, h: h * 0.74 };
  }

  layout() {
    const a = (this.areaRect = this.area());
    const cx = a.x + a.w / 2;
    const cy = a.y + a.h / 2;
    const sx = Math.min(a.w * 0.47, a.h * 0.47 * 1.45);
    const sy = a.h * 0.47;
    for (let i = 0; i < this.n; i++) {
      this.mx[i] = cx + this.gx[i] * sx;
      this.my[i] = cy + this.gy[i] * sy;
    }

    // Theme centroids on the map (label anchors), nudged apart so labels
    // don't sit on top of each other.
    this.centroids = this.members.map((list) => {
      let x = 0, y = 0;
      for (const i of list) { x += this.mx[i]; y += this.my[i]; }
      return list.length ? { x: x / list.length, y: y / list.length } : { x: cx, y: cy };
    });
    for (let pass = 0; pass < 40; pass++) {
      for (let i = 0; i < this.centroids.length; i++) {
        for (let j = i + 1; j < this.centroids.length; j++) {
          const A = this.centroids[i];
          const B = this.centroids[j];
          const dx = B.x - A.x;
          const dy = B.y - A.y;
          if (Math.abs(dx) < 215 && Math.abs(dy) < 46) {
            const push = (46 - Math.abs(dy)) / 2 + 0.5;
            const dir = dy >= 0 ? 1 : -1;
            A.y -= push * dir;
            B.y += push * dir;
          }
        }
      }
    }

    // Ranked bars.
    const T = this.themes.length;
    const rowsPer = 3;
    const labelW = this.mobile ? 0 : Math.min(300, a.w * 0.44);
    const x0 = a.x + labelW + (this.mobile ? 0 : 22);
    const maxCols = Math.ceil(Math.max(...this.members.map((m) => m.length), 1) / rowsPer);
    const room = a.x + a.w - x0 - (this.mobile ? 44 : 70);
    const s = clamp(room / maxCols, 2.4, 6.5);
    const rowH = Math.min(a.h / T, this.mobile ? 56 : 66);
    const top = a.y + (a.h - rowH * T) / 2 + rowH / 2;
    this.dot = s;
    this.rows = this.members.map((list, ti) => {
      const y = top + ti * rowH + (this.mobile ? 10 : 0);
      list.forEach((i, k) => {
        this.bx[i] = x0 + Math.floor(k / rowsPer) * s + s / 2;
        this.by[i] = y + ((k % rowsPer) - 1) * s;
      });
      return { y, x0, x1: x0 + Math.ceil(list.length / rowsPer) * s, labelY: this.mobile ? y - 18 : y };
    });
  }

  setMouse(x, y, active) {
    this.mouse.x = x;
    this.mouse.y = y;
    this.mouse.active = active;
  }

  /** Index of the particle under (x, y), or -1. */
  pick(x, y, radius = 9) {
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < this.n; i++) {
      if (this.dim && !this.dim[i]) continue;
      const dx = this.x[i] - x;
      const dy = this.y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  draw(time) {
    const { ctx, w, h, dpr } = this;
    const t = time / 1000;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = this.dark ? "lighter" : "source-over";

    const p = this.p;
    const story = this.mode === "story";
    const a = this.areaRect;
    // Galaxy disc, centred on the whole viewport.
    const gcx = w * 0.5;
    const gcy = h * (this.mobile ? 0.62 : 0.6);
    const R = Math.max(w, h) * (this.mobile ? 0.62 : 0.5);
    const heroWeight = story ? 1 - span(STORY.hero[1], STORY.cloud[0] + 0.03, p) : 0;
    const mouseOn = this.mouse.active && heroWeight > 0.01 && !reducedMotion.matches;
    const cloudR = Math.min(a.w, a.h) * 0.36;
    const ccx = a.x + a.w / 2;
    const ccy = a.y + a.h / 2;

    for (let i = 0; i < this.n; i++) {
      let x, y, size, alpha, rgb;
      if (story) {
        // galaxy
        const ang = this.ha[i] + t * this.hs[i];
        const z = 0.55 + 0.45 * Math.sin(ang);
        x = gcx + Math.cos(ang) * this.hr[i] * R;
        y = gcy + Math.sin(ang) * this.hr[i] * R * 0.36;
        size = this.size[i] * (1.15 + 2.2 * z);
        alpha = 0.32 + 0.68 * z;

        if (mouseOn) {
          const dx = x - this.mouse.x;
          const dy = y - this.mouse.y;
          const d = Math.hypot(dx, dy) || 1;
          const f = Math.max(0, 1 - d / 160) * 46;
          this.ox[i] = lerp(this.ox[i], (dx / d) * f, 0.12);
          this.oy[i] = lerp(this.oy[i], (dy / d) * f, 0.12);
        } else {
          this.ox[i] = lerp(this.ox[i], 0, 0.08);
          this.oy[i] = lerp(this.oy[i], 0, 0.08);
        }
        x += this.ox[i] * heroWeight;
        y += this.oy[i] * heroWeight;

        const d = this.delay[i];
        const e1 = stagger(p, ...STORY.cloud, d);
        const e2 = stagger(p, ...STORY.map, d);
        const e3 = stagger(p, ...STORY.color, d);
        const e5 = stagger(p, ...STORY.bars, d);

        const cx = ccx + Math.cos(this.ca[i] + t * 0.05) * this.cr[i] * cloudR;
        const cy = ccy + Math.sin(this.ca[i] + t * 0.05) * this.cr[i] * cloudR * 0.92;
        x = lerp(x, cx, e1);
        y = lerp(y, cy, e1);
        size = lerp(size, this.size[i] * 2.5, e1);
        alpha = lerp(alpha, 0.85, e1);

        // gentle breathing while on the map
        const wob = (1 - e5) * e2 * 1.2;
        x = lerp(x, this.mx[i] + Math.sin(t * 0.8 + this.ca[i]) * wob, e2);
        y = lerp(y, this.my[i] + Math.cos(t * 0.7 + this.ha[i]) * wob, e2);
        size = lerp(size, this.size[i] * 2.7, e2);

        x = lerp(x, this.bx[i], e5);
        y = lerp(y, this.by[i], e5);
        size = lerp(size, this.dot * 0.4, e5);
        alpha = lerp(alpha, 0.95, e5);

        const rr = this.ratingRgb[this.rating[i]];
        const tr = this.tierRgb[this.theme[i]];
        rgb = [lerp(rr[0], tr[0], e3), lerp(rr[1], tr[1], e3), lerp(rr[2], tr[2], e3)];
      } else {
        // interactive map: burst out from the centre, then breathe
        const e = ease.outExpo(clamp((this.intro - this.delay[i] * 0.35) / 0.65, 0, 1));
        x = lerp(ccx, this.mx[i] + Math.sin(t * 0.6 + this.ca[i]) * 1.4, e);
        y = lerp(ccy, this.my[i] + Math.cos(t * 0.5 + this.ha[i]) * 1.4, e);
        size = this.size[i] * 2.3 * (0.4 + 0.6 * e);
        alpha = 0.9 * e;
        rgb = this.tierRgb[this.theme[i]];
        if (this.dim && !this.dim[i]) alpha *= 0.12;
        if (this.hoverTheme != null && this.theme[i] !== this.hoverTheme) alpha *= 0.35;
      }

      this.x[i] = x;
      this.y[i] = y;
      if (alpha <= 0.01) continue;
      const color = `rgb(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0})`;
      ctx.fillStyle = color;
      if (size > 2.6 && this.delay[i] > 0.8) {
        ctx.globalAlpha = alpha * 0.1;
        ctx.beginPath();
        ctx.arc(x, y, size * 3.2, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }

    // hovered review: a ring in ink
    if (this.hover >= 0) {
      const i = this.hover;
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = `rgb(${this.ink.join(",")})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], 7, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }
}
