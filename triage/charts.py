"""Enumerate apps from the App Store top charts.

Used to fill a batch run without typing names by hand: "triage the top 50 finance
apps" rather than one app at a time. Apple's chart RSS serves up to 100 entries
per genre per storefront, and is the only public bulk listing either store
offers -- neither exposes a full catalogue, so "every app" is not something you
can enumerate (see the batch section of the README).
"""
from __future__ import annotations

import requests

CHART_RSS = (
    "https://itunes.apple.com/{country}/rss/{chart}/limit={limit}{genre}/json"
)

CHARTS = {
    "free": "topfreeapplications",
    "paid": "toppaidapplications",
    "grossing": "topgrossingapplications",
}

# Apple genre ids. Pass any numeric id directly for anything not named here.
GENRES = {
    "all": None,
    "books": 6018,
    "business": 6000,
    "education": 6017,
    "entertainment": 6016,
    "finance": 6015,
    "food": 6023,
    "games": 6014,
    "health": 6013,
    "lifestyle": 6012,
    "medical": 6020,
    "music": 6011,
    "navigation": 6010,
    "news": 6009,
    "photo": 6008,
    "productivity": 6007,
    "reference": 6006,
    "shopping": 6024,
    "social": 6005,
    "sports": 6004,
    "travel": 6003,
    "utilities": 6002,
    "weather": 6001,
}


def resolve_genre(value: str | None) -> int | None:
    if not value or value == "all":
        return None
    key = value.strip().lower()
    if key in GENRES:
        return GENRES[key]
    if key.isdigit():
        return int(key)
    raise ValueError(
        f"Unknown genre {value!r}. Use a numeric Apple genre id or one of: "
        + ", ".join(sorted(GENRES))
    )


def top_apps(
    limit: int = 25,
    country: str = "us",
    chart: str = "free",
    genre: str | None = None,
) -> list[tuple[str, str]]:
    """Return ``[(app_name, track_id), ...]`` from an App Store chart.

    Names come back as the store writes them, which is what the pipeline then
    resolves on Google Play -- so a charting iOS app with no Android listing
    simply yields iOS-only reviews.
    """
    if chart not in CHARTS:
        raise ValueError(f"chart must be one of {sorted(CHARTS)}")
    gid = resolve_genre(genre)
    url = CHART_RSS.format(
        country=country,
        chart=CHARTS[chart],
        limit=min(max(limit, 1), 100),  # the feed returns at most 100 however many you ask for
        genre=f"/genre={gid}" if gid else "",
    )
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    r.raise_for_status()

    entries = r.json().get("feed", {}).get("entry", [])
    if isinstance(entries, dict):
        entries = [entries]

    out: list[tuple[str, str]] = []
    for e in entries:
        try:
            name = e["im:name"]["label"]
            track = e["id"]["attributes"]["im:id"]
        except (KeyError, TypeError):
            continue
        out.append((name, track))
    return out[:limit]
