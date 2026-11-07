"""App Store search and request helpers shared by both servers.

Lightweight on purpose (requests only): the Vercel deployment imports this
without any of the pipeline's machine-learning dependencies.
"""
from __future__ import annotations

import json
import re

import requests

from .config import ROOT

COUNTRIES = {"us", "ca", "gb", "au", "in", "ie", "nz"}
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
MANIFEST = ROOT / "web" / "data" / "apps.json"

# The site uses no em dashes, including inside quoted reviews and model output.
_EM_DASH = re.compile(r"\s*—\s*")


def plain(text: str) -> str:
    return _EM_DASH.sub(" - ", text or "").strip()


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


def client_ip(request) -> str:
    # Behind a proxy (Vercel, Render, Fly...) the visitor is the first hop.
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


def analyzed() -> dict[tuple[str, str], str]:
    """(ios_id, market) -> slug for every report the site already has."""
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {(a.get("ios_id"), a.get("market")): a["slug"] for a in manifest.get("apps", []) if a.get("ios_id")}


def search_apps(q: str, country: str) -> list[dict]:
    """Live App Store search, with apps that already have a report marked by slug."""
    results = itunes("search", term=q, country=country, entity="software", limit=8)
    done = analyzed()
    return [
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
    ]
