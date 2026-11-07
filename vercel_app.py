"""Triage on Vercel: the website plus live analysis of any app, serverless.

Vercel loads ``app`` from here (see pyproject.toml). It needs only light
dependencies; the full pipeline (server.py) stays the local version.

    GET  /api/health                      what this server can do
    GET  /api/search?q=&country=          live App Store search, analyzed apps marked
    POST /api/collect {ios_id, country}   reviews from both stores, signed
    POST /api/themes {name, reviews, token}  themes, names, summaries and fixes

Everything else is the static site in web/. Run it locally with:

    .venv/bin/uvicorn vercel_app:app --port 8700
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

from triage import live  # noqa: E402  (after load_dotenv so the API key is visible)
from triage.appstore import COUNTRIES, client_ip, search_apps  # noqa: E402

# Best effort per instance: serverless instances don't share memory. The real
# ceiling on spend is the monthly limit set on the Anthropic account.
PER_IP_PER_HOUR = int(os.environ.get("TRIAGE_PER_IP_PER_HOUR", "6"))
MAX_REVIEWS = 2 * live.PER_PLATFORM
recent: dict[str, deque] = defaultdict(deque)

app = FastAPI(title="Triage", docs_url=None, redoc_url=None, openapi_url=None)


def allow(ip: str) -> bool:
    now = time.time()
    hits = recent[ip]
    while hits and now - hits[0] > 3600:
        hits.popleft()
    if len(hits) >= PER_IP_PER_HOUR:
        return False
    hits.append(now)
    return True


@app.get("/api/health")
def health():
    return {"ok": True, "mode": "live", "llm": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "countries": sorted(COUNTRIES)}


@app.get("/api/search")
def search(q: str = "", country: str = "us"):
    q = q.strip()[:60]
    country = country.lower()
    if country not in COUNTRIES:
        raise HTTPException(400, "Unsupported market.")
    if len(q) < 2:
        return {"results": []}
    try:
        return {"results": search_apps(q, country)}
    except requests.RequestException:
        raise HTTPException(502, "Couldn't reach the App Store.")


class CollectRequest(BaseModel):
    ios_id: str = Field(pattern=r"^\d{1,12}$")
    country: str = Field(default="us", pattern=r"^[a-z]{2}$")


@app.post("/api/collect")
def collect(req: CollectRequest, request: Request):
    if req.country not in COUNTRIES:
        raise HTTPException(400, "Unsupported market.")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "Live analysis isn't switched on for this site yet.")
    if not allow(client_ip(request)):
        raise HTTPException(429, f"You've analyzed {PER_IP_PER_HOUR} apps in the last hour. Try again later, or open one of the analyzed apps.")
    try:
        return live.collect(req.ios_id, req.country)
    except live.LiveError as e:
        raise HTTPException(422, str(e))
    except requests.RequestException:
        raise HTTPException(502, "Couldn't reach the app stores just now. Try again in a minute.")


class ThemesRequest(BaseModel):
    name: str = Field(max_length=120)
    reviews: list[dict] = Field(max_length=MAX_REVIEWS)
    token: str = Field(max_length=200)


@app.post("/api/themes")
def themes(req: ThemesRequest):
    if not live.verify(req.reviews, req.token):
        raise HTTPException(403, "These reviews expired. Search for the app again.")
    try:
        return live.group(req.name, req.reviews)
    except live.LiveError as e:
        raise HTTPException(502, str(e))


# Last, so the API routes above win.
app.mount("/", StaticFiles(directory="web", html=True), name="site")
