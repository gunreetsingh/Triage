"""Export finished runs for the static web frontend in web/.

The site is plain HTML/JS with no server: it reads ``web/data/apps.json`` plus
one ``web/data/apps/<slug>.json`` per app, and app icons from
``web/data/icons/``. This module writes all of those from ``data/runs/``:

* each run, trimmed to what the site renders;
* each app's icon, fetched from its store listing and re-encoded as a 256px PNG
  (so the site never hotlinks a store CDN, and nothing but pixels is kept);
* a brand color sampled from that icon, used to tint the app's page;
* a 2-D map of every review, from t-SNE over its stored embedding, so the
  "islands" the site draws are reviews that actually say similar things.

Icons and maps are cached and only rebuilt when a run changes. The pipeline and
relabel.py call :func:`export_all` when they finish; ``python -m triage.web``
rebuilds by hand.
"""
from __future__ import annotations

import colorsys
import io
import json
import re
import sys
from datetime import datetime, timezone

import numpy as np
import requests

from .config import DATA_DIR, ROOT, RUNS_DIR

WEB_DATA = ROOT / "web" / "data"
APPS_DIR = WEB_DATA / "apps"
ICONS_DIR = WEB_DATA / "icons"
LAYOUT_CACHE = DATA_DIR / "layout"  # t-SNE coordinates; regenerable, not shipped

# Mirrors the frontend's tiering (web/assets/lib/data.js) so the overview
# counts agree with what each app page shows.
POSITIVE_AT = 3.75
CRITICAL_AT = 75

# The site uses no em dashes, including inside quoted reviews and model output.
_EM_DASH = re.compile(r"\s*\u2014\s*")


def _plain(text: str) -> str:
    return _EM_DASH.sub(" - ", text or "").strip()


UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
MAX_ICON_BYTES = 4 * 1024 * 1024


def _market(params: dict) -> str:
    raw = str(params.get("ios_countries") or "us")
    return raw.replace(",", "/").split("/")[0].strip().lower() or "us"


# --------------------------------------------------------------------------
# icons + brand color
# --------------------------------------------------------------------------
def _icon_url(listing: dict, market: str) -> str | None:
    ident = listing.get("ident")
    if not ident:
        return None
    if listing.get("platform") == "iOS":
        r = requests.get(
            "https://itunes.apple.com/lookup",
            params={"id": ident, "country": market}, headers=UA, timeout=20,
        )
        r.raise_for_status()
        results = r.json().get("results") or []
        return (results[0].get("artworkUrl512") or results[0].get("artworkUrl100")) if results else None
    from google_play_scraper import app as gp_app

    return gp_app(ident, lang="en", country=market).get("icon")


def _download_icon(url: str):
    """Fetch an icon and return it as a decoded PIL image, or None."""
    from PIL import Image

    r = requests.get(url, headers=UA, timeout=20, stream=True)
    r.raise_for_status()
    if not r.headers.get("content-type", "").startswith("image/"):
        return None
    data = r.raw.read(MAX_ICON_BYTES + 1, decode_content=True)
    if len(data) > MAX_ICON_BYTES:
        return None
    img = Image.open(io.BytesIO(data))
    img.load()  # decode fully here so a corrupt file fails now, not later
    return img.convert("RGBA")


def _brand_color(img) -> str | None:
    """The icon's dominant saturated hue, nudged to glow on a dark page.

    Returns None for monochrome icons (black/white logos), which then fall
    back to the site accent rather than an arbitrary gray.
    """
    small = img.convert("RGB").resize((48, 48))
    buckets: dict[int, list[float]] = {}
    for r, g, b in np.asarray(small, dtype=np.uint8).reshape(-1, 3).tolist():
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.35 or v < 0.25:
            continue
        acc = buckets.setdefault(int(h * 24) % 24, [0.0, 0.0, 0.0, 0.0])
        w = s * v
        acc[0] += r * w
        acc[1] += g * w
        acc[2] += b * w
        acc[3] += w
    if not buckets:
        return None
    best = max(buckets.values(), key=lambda a: a[3])
    if best[3] < 48 * 48 * 0.04:  # a few colored pixels in a mostly-mono icon
        return None
    r, g, b = (best[i] / best[3] / 255 for i in range(3))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    r, g, b = colorsys.hls_to_rgb(h, min(max(l, 0.48), 0.62), max(s, 0.6))
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


def _icon_and_brand(slug: str, listings: list[dict], market: str, cache: dict) -> tuple[str | None, str | None]:
    """Ensure web/data/icons/<slug>.png exists; return (relative path, brand hex)."""
    from PIL import Image

    out = ICONS_DIR / f"{slug}.png"
    if out.exists() and slug in cache:
        return f"data/icons/{slug}.png", cache[slug]

    img = None
    if out.exists():
        img = Image.open(out).convert("RGBA")
    else:
        # Prefer the App Store artwork (512px), fall back to Play.
        for listing in sorted(listings, key=lambda l: l.get("platform") != "iOS"):
            try:
                url = _icon_url(listing, market)
                img = _download_icon(url) if url else None
            except Exception:
                img = None
            if img is not None:
                break
        if img is None:
            return None, None
        ICONS_DIR.mkdir(parents=True, exist_ok=True)
        img.resize((256, 256), Image.LANCZOS).save(out, "PNG", optimize=True)

    brand = _brand_color(img)
    cache[slug] = brand
    return f"data/icons/{slug}.png", brand


# --------------------------------------------------------------------------
# 2-D review map
# --------------------------------------------------------------------------
def _layout(payload: dict) -> dict[str, list[float]] | None:
    """t-SNE positions for every review, scaled to roughly [-1, 1]. Cached."""
    slug = payload["slug"]
    ids = [r["review_id"] for r in payload["reviews"]]
    key = f"{payload['generated_at']}:{len(ids)}"
    cache = LAYOUT_CACHE / f"{slug}.json"
    if cache.exists():
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if saved.get("key") == key:
                return saved["xy"]
        except (OSError, json.JSONDecodeError):
            pass

    try:
        from sklearn.manifold import TSNE

        from . import store

        col = store.client().get_collection(store.collection_name(slug))
        got = col.get(ids=ids, include=["embeddings"])
        order = {rid: i for i, rid in enumerate(got["ids"])}
        if any(rid not in order for rid in ids):
            return None
        emb = np.asarray([got["embeddings"][order[rid]] for rid in ids], dtype=np.float32)
    except Exception:
        return None
    if len(ids) < 10:
        return None

    emb /= np.clip(np.linalg.norm(emb, axis=1, keepdims=True), 1e-12, None)
    xy = TSNE(
        n_components=2,
        perplexity=min(30.0, (len(ids) - 1) / 3),
        init="pca",
        learning_rate="auto",
        random_state=42,
    ).fit_transform(emb)
    xy -= xy.mean(axis=0)
    radius = np.percentile(np.linalg.norm(xy, axis=1), 98) or 1.0
    xy = np.clip(xy / radius, -1.2, 1.2)
    result = {rid: [round(float(x), 3), round(float(y), 3)] for rid, (x, y) in zip(ids, xy)}

    LAYOUT_CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"key": key, "xy": result}), encoding="utf-8")
    return result


# --------------------------------------------------------------------------
# files
# --------------------------------------------------------------------------
def _app_file(payload: dict, icon: str | None, brand: str | None) -> dict:
    assignments = payload["assignments"]
    params = payload["params"]
    keywords = payload.get("keywords", {})
    xy = _layout(payload) or {}
    return {
        "slug": payload["slug"],
        "name": payload["app_name"],
        "generated_at": payload["generated_at"],
        "market": _market(params),
        "ios_sort": params.get("ios_sort", "recent"),
        "android_sort": params.get("android_sort", "newest"),
        "llm": bool(params.get("llm")),
        "icon": icon,
        "brand": brand,
        "has_map": bool(xy),
        "listings": [
            {k: ref.get(k) for k in ("platform", "title", "url", "publisher", "ratings", "rating")}
            for ref in (payload.get("resolved") or {}).values()
            if ref
        ],
        "themes": [
            {
                "id": int(t["cluster_id"]),
                "label": _plain(t.get("label", "")),
                "summary": _plain(t.get("summary", "")),
                "recommendation": _plain(t.get("recommendation", "")),
                "kw": (keywords.get(str(t["cluster_id"])) or t.get("keywords") or [])[:3],
            }
            for t in payload["themes"]
        ],
        # Short keys: reviews are ~95% of each file.
        "reviews": [
            {
                "i": r["review_id"],
                "p": r["platform"],
                "r": int(r["rating"]),
                "ts": int(r["ts"]),
                "t": _plain(r.get("title", "")),
                "x": _plain(r["text"]),
                "v": r.get("app_version", "") or "",
                "h": int(r.get("helpful", 0) or 0),
                "a": _plain(r.get("author", "")),
                "o": int(r.get("position", -1)),
                "c": int(assignments[r["review_id"]]),
                **({"g": xy[r["review_id"]]} if r["review_id"] in xy else {}),
            }
            for r in payload["reviews"]
            if r["review_id"] in assignments
        ],
    }


def _summary(payload: dict, app: dict) -> dict:
    reviews = app["reviews"]
    n = len(reviews)
    dist = [sum(1 for r in reviews if r["r"] == s) for s in range(1, 6)]
    platforms: dict[str, int] = {}
    for r in reviews:
        platforms[r["p"]] = platforms.get(r["p"], 0) + 1

    themes = payload["themes"]  # already ranked by priority
    problems = [t for t in themes if t.get("avg_rating", 0) < POSITIVE_AT]
    top = (problems or themes or [None])[0]
    idents = {ref.get("platform"): ref.get("ident") for ref in (payload.get("resolved") or {}).values() if ref}
    return {
        "slug": app["slug"],
        "name": app["name"],
        "market": app["market"],
        "ios_id": idents.get("iOS"),
        "android_id": idents.get("Android"),
        "icon": app["icon"],
        "brand": app["brand"],
        "has_map": app["has_map"],
        "reviews": n,
        # Each store's own rating for the whole app; "avg" is only the reviews read.
        "store": [
            {"p": ref.get("platform"), "rating": round(float(ref.get("rating") or 0), 2), "ratings": int(ref.get("ratings") or 0)}
            for ref in (payload.get("resolved") or {}).values()
            if ref and ref.get("rating")
        ],
        "avg": round(sum(r["r"] for r in reviews) / n, 2) if n else 0,
        "unhappy": round((dist[0] + dist[1]) / n, 3) if n else 0,
        "themes": len(themes),
        "critical": sum(1 for t in problems if t.get("priority", 0) >= CRITICAL_AT),
        "dist": dist,
        "platforms": platforms,
        "ts_min": min((r["ts"] for r in reviews), default=0),
        "ts_max": max((r["ts"] for r in reviews), default=0),
        "llm": app["llm"],
        "generated_at": app["generated_at"],
        "top_issue": None if top is None else {
            "id": int(top["cluster_id"]),
            "label": _plain(top.get("label", "")),
            "priority": top.get("priority", 0),
            "avg_rating": top.get("avg_rating", 0),
            "n_reviews": top.get("n_reviews", 0),
        },
    }


def export_all(verbose: bool = False) -> int:
    """Rewrite web/data from every run in data/runs. Returns the app count."""
    APPS_DIR.mkdir(parents=True, exist_ok=True)
    brand_cache_path = LAYOUT_CACHE / "brands.json"
    try:
        brand_cache = json.loads(brand_cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        brand_cache = {}

    entries: list[dict] = []
    written: set[str] = set()
    for path in sorted(RUNS_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            if verbose:
                print(f"  skipped {path.name}: {e}")
            continue
        if not payload.get("reviews") or not payload.get("themes"):
            continue

        listings = [
            {**ref, "ident": ref.get("ident")}
            for ref in (payload.get("resolved") or {}).values()
            if ref
        ]
        icon, brand = _icon_and_brand(payload["slug"], listings, _market(payload["params"]), brand_cache)
        app = _app_file(payload, icon, brand)
        out = APPS_DIR / f"{app['slug']}.json"
        out.write_text(json.dumps(app, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written.add(out.name)
        entries.append(_summary(payload, app))
        if verbose:
            print(f"  {app['name']}: {len(app['reviews'])} reviews, {len(app['themes'])} themes, "
                  f"icon {'yes' if icon else 'no'}, brand {brand or 'none'}, map {'yes' if app['has_map'] else 'no'}")

    # web/data is generated output: drop files whose run no longer exists.
    for stale in APPS_DIR.glob("*.json"):
        if stale.name not in written:
            stale.unlink()
    slugs = {name[:-5] for name in written}
    for stale in ICONS_DIR.glob("*.png") if ICONS_DIR.exists() else []:
        if stale.stem not in slugs:
            stale.unlink()

    LAYOUT_CACHE.mkdir(parents=True, exist_ok=True)
    brand_cache_path.write_text(json.dumps(brand_cache), encoding="utf-8")

    entries.sort(key=lambda e: -((e["top_issue"] or {}).get("priority", 0)))
    # The homepage story animates one app's reviews: the most urgent app with
    # enough reviews and a map to make the islands legible. Once chosen it
    # stays put, so apps added later by visitors don't swap the homepage.
    try:
        previous = json.loads((WEB_DATA / "apps.json").read_text(encoding="utf-8")).get("featured")
    except (OSError, json.JSONDecodeError):
        previous = None
    usable = {e["slug"] for e in entries if e["has_map"] and e["reviews"] >= 300}
    featured = previous if previous in usable else next((e["slug"] for e in entries if e["slug"] in usable), None)
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "featured": featured or (entries[0]["slug"] if entries else None),
        "apps": entries,
    }
    (WEB_DATA / "apps.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    return len(entries)


if __name__ == "__main__":
    count = export_all(verbose=True)
    print(f"Exported {count} app(s) to {WEB_DATA.relative_to(ROOT)}/")
    print("Serve it with:  python -m http.server 8600 -d web")
    sys.exit(0 if count else 1)
