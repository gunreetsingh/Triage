#!/usr/bin/env python3
"""Triage web server: the website, plus live analysis of any app.

    python server.py                      # http://localhost:8600
    HOST=0.0.0.0 PORT=8000 python server.py

Endpoints
    GET  /api/health                      is analysis available? queue length
    GET  /api/search?q=&country=          live App Store search, analyzed apps marked
    POST /api/analyze {ios_id, country}   start (or reuse) an analysis -> job
    GET  /api/jobs/<id>                   a job's progress
Everything else is the static site in web/.

Analyses run one at a time on a background worker (the pipeline shares one
ChromaDB directory on disk), so requests queue. Because anyone can trigger
scraping and Claude calls, a public deployment is protected by: reusing any
existing report for the same app and market, a per-visitor hourly limit, a
daily cap, and a queue cap. All limits are environment variables (below).
"""
from __future__ import annotations

import os
import re
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

import pipeline  # noqa: E402  (after load_dotenv so the API key is visible)
from triage import analyze, web  # noqa: E402
from triage.config import ROOT, slugify  # noqa: E402
from triage.models import AppRef  # noqa: E402
from triage.scrape import pick_same_app, resolve_android  # noqa: E402

COUNTRIES = {"us", "ca", "gb", "au", "in", "ie", "nz"}
PER_IP_PER_HOUR = int(os.environ.get("TRIAGE_PER_IP_PER_HOUR", "4"))
DAILY_LIMIT = int(os.environ.get("TRIAGE_DAILY_LIMIT", "60"))
MAX_QUEUE = int(os.environ.get("TRIAGE_MAX_QUEUE", "12"))
PER_PLATFORM = int(os.environ.get("TRIAGE_PER_PLATFORM", "500"))
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

jobs: dict[str, dict] = {}
pending: deque[str] = deque()
# Re-entrant: public() reads the queue under the lock and is also called while it's held.
lock = threading.RLock()
export_lock = threading.Lock()
wake = threading.Event()
recent_by_ip: dict[str, deque] = defaultdict(deque)
daily = {"day": date.today(), "count": 0}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def analyzed() -> dict[tuple[str, str], str]:
    """(ios_id, market) -> slug for every report the site already has."""
    try:
        import json
        manifest = json.loads((web.WEB_DATA / "apps.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {(a.get("ios_id"), a.get("market")): a["slug"] for a in manifest.get("apps", []) if a.get("ios_id")}


def existing_slugs() -> dict[str, tuple[str | None, str | None]]:
    try:
        import json
        manifest = json.loads((web.WEB_DATA / "apps.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {a["slug"]: (a.get("ios_id"), a.get("market")) for a in manifest.get("apps", [])}


def short_name(title: str) -> str:
    """Drop the marketing subtitle: 'Spotify: Music and Podcasts' -> 'Spotify'.

    Only the colon (and '|') mark a subtitle. A dash often carries meaning --
    'Uber - Request a ride' and 'Uber - Driver' are different apps -- so it stays.
    """
    head = re.split(r"\s*[:|]\s*", title.strip(), maxsplit=1)[0].strip()
    return head if len(head) >= 2 else title.strip()


def safe_artwork(url: str | None) -> str | None:
    return url if isinstance(url, str) and re.match(r"^https://[a-z0-9.-]+\.mzstatic\.com/", url) else None


def itunes(path: str, **params) -> list[dict]:
    r = requests.get(f"https://itunes.apple.com/{path}", params=params, headers=UA, timeout=15)
    r.raise_for_status()
    return r.json().get("results") or []


def client_ip(request: Request) -> str:
    # Behind a proxy (Render, Fly, Railway...) the visitor is the first hop.
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def public(job: dict) -> dict:
    out = {k: job.get(k) for k in (
        "id", "status", "stage", "name", "title", "publisher", "icon", "country",
        "reviews", "themes", "android", "slug", "error", "created", "started", "finished",
    )}
    out["llm"] = analyze.have_api_key()
    if job["status"] == "queued":
        with lock:
            out["ahead"] = list(pending).index(job["id"]) if job["id"] in pending else 0
    return out


def prune() -> None:
    cutoff = time.time() - 3600
    for jid in [j for j, job in jobs.items() if job.get("finished") and job["finished"] < cutoff]:
        jobs.pop(jid, None)


# --------------------------------------------------------------------------
# worker
# --------------------------------------------------------------------------
def unique_name(job: dict) -> str:
    """A run name whose slug won't overwrite a different app's report."""
    taken = existing_slugs()
    name = job["name"]
    owner = taken.get(slugify(name))
    if owner and owner != (job["ios_id"], job["country"]):
        name = f"{name} ({job['country'].upper()})" if owner[0] == job["ios_id"] else job["title"]
        owner = taken.get(slugify(name))
        if owner and owner != (job["ios_id"], job["country"]):
            name = f"{name} {job['ios_id']}"
    return name


def run(job: dict) -> None:
    job.update(status="running", stage="resolve", started=time.time())
    try:
        ios = AppRef("iOS", job["ios_id"], job["title"], job["publisher"], job["ratings"])
        name = unique_name(job)

        # Only pool Android reviews when the Play listing is clearly the same
        # product (same publisher or title) -- see same_app_confidence.
        android = None
        try:
            android = pick_same_app(ios, resolve_android(job["name"], country=job["country"]))
        except Exception:
            android = None
        job["android"] = bool(android)

        argv = [name, "--country", job["country"], "--ios-id", job["ios_id"], "--per-platform", str(PER_PLATFORM)]
        argv += ["--android-pkg", android.ident] if android else ["--skip-android"]
        args = pipeline.parse_args(argv)

        def report(stage: str, **data) -> None:
            if stage == "failed":
                job["error"] = data.get("reason")
                return
            job["stage"] = stage
            if "reviews" in data:
                job["reviews"] = data["reviews"]
            if "themes" in data:
                job["themes"] = data["themes"]

        payload = pipeline.run_one(name, args, report=report)
        if not payload:
            raise RuntimeError(job.get("error") or "This app couldn't be analyzed.")
        job["stage"] = "publish"
        with export_lock:
            web.export_all()
        job.update(status="done", stage="done", slug=payload["slug"], finished=time.time())
    except requests.RequestException:
        job.update(status="failed", finished=time.time(),
                   error="Couldn't reach the app stores just now. Try again in a minute.")
    except Exception as e:  # report, don't crash the worker
        job.update(status="failed", finished=time.time(), error=job.get("error") or str(e) or "Analysis failed.")


def worker() -> None:
    while True:
        wake.wait()
        with lock:
            job_id = pending.popleft() if pending else None
            if job_id is None:
                wake.clear()
                continue
        job = jobs.get(job_id)
        if job:
            run(job)


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=worker, name="triage-worker", daemon=True).start()
    yield


app = FastAPI(title="Triage", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "llm": analyze.have_api_key(), "queue": len(pending), "countries": sorted(COUNTRIES)}


@app.get("/api/search")
def search(q: str = "", country: str = "us"):
    q = q.strip()[:60]
    country = country.lower()
    if country not in COUNTRIES:
        raise HTTPException(400, "Unsupported market.")
    if len(q) < 2:
        return {"results": []}
    try:
        results = itunes("search", term=q, country=country, entity="software", limit=8)
    except requests.RequestException:
        raise HTTPException(502, "Couldn't reach the App Store.")
    done = analyzed()
    return {"results": [
        {
            "ios_id": str(r["trackId"]),
            "title": r.get("trackName", ""),
            "name": short_name(r.get("trackName", "")),
            "publisher": r.get("sellerName", ""),
            "icon": safe_artwork(r.get("artworkUrl100")),
            "rating": round(float(r.get("averageUserRating") or 0), 2),
            "ratings": int(r.get("userRatingCount") or 0),
            "genre": r.get("primaryGenreName", ""),
            "slug": done.get((str(r["trackId"]), country)),
        }
        for r in results if r.get("trackId")
    ]}


class AnalyzeRequest(BaseModel):
    ios_id: str = Field(pattern=r"^\d{1,12}$")
    country: str = Field(default="us", pattern=r"^[a-z]{2}$")


@app.post("/api/analyze")
def start(req: AnalyzeRequest, request: Request):
    country = req.country.lower()
    if country not in COUNTRIES:
        raise HTTPException(400, "Unsupported market.")
    slug = analyzed().get((req.ios_id, country))
    if slug:
        return {"status": "done", "slug": slug}

    key = (req.ios_id, country)
    ip = client_ip(request)
    with lock:
        prune()
        for job in jobs.values():
            if job["key"] == key and job["status"] in ("queued", "running"):
                return public(job)  # someone already asked for this one
        now = time.time()
        recent = recent_by_ip[ip]
        while recent and recent[0] < now - 3600:
            recent.popleft()
        if len(recent) >= PER_IP_PER_HOUR:
            raise HTTPException(429, f"You've started {len(recent)} analyses in the last hour. Try again later, or open one that's already done.")
        if daily["day"] != date.today():
            daily.update(day=date.today(), count=0)
        if daily["count"] >= DAILY_LIMIT:
            raise HTTPException(429, "Today's analysis limit has been reached. Try again tomorrow.")
        if len(pending) >= MAX_QUEUE:
            raise HTTPException(503, "Lots of people are analyzing apps right now. Try again in a few minutes.")

    try:
        found = itunes("lookup", id=req.ios_id, country=country)
    except requests.RequestException:
        raise HTTPException(502, "Couldn't reach the App Store.")
    if not found:
        raise HTTPException(404, "That app isn't in the App Store for this market.")
    info = found[0]

    job = {
        "id": uuid.uuid4().hex[:12],
        "key": key,
        "ios_id": req.ios_id,
        "country": country,
        "title": info.get("trackName", ""),
        "name": short_name(info.get("trackName", "")),
        "publisher": info.get("sellerName", ""),
        "ratings": int(info.get("userRatingCount") or 0),
        "icon": safe_artwork(info.get("artworkUrl512") or info.get("artworkUrl100")),
        "status": "queued",
        "stage": "queued",
        "created": time.time(),
        "started": None, "finished": None,
        "reviews": None, "themes": None, "android": None,
        "slug": None, "error": None,
    }
    with lock:
        jobs[job["id"]] = job
        pending.append(job["id"])
        recent_by_ip[ip].append(time.time())
        daily["count"] += 1
    wake.set()
    return public(job)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "That analysis isn't running any more.")
    return public(job)


@app.middleware("http")
async def no_stale_assets(request: Request, call_next):
    # Browsers otherwise reuse cached JS modules after an update, mixing old and
    # new code. "no-cache" still uses the cache, it just revalidates (ETag), so
    # unchanged files cost a 304. API responses must never be cached.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store" if request.url.path.startswith("/api/") else "no-cache"
    return response


# The site itself. Mounted last so /api/* wins.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="site")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8600")))
