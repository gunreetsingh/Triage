"""Record shapes passed between pipeline stages and persisted to the run file."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Review:
    review_id: str
    platform: str          # "iOS" | "Android"
    rating: int            # 1-5
    date: str              # ISO 8601, UTC-naive
    ts: int                # unix seconds, for cheap range filters
    text: str
    title: str = ""
    author: str = ""
    app_version: str = ""
    country: str = ""
    helpful: int = 0
    position: int = -1     # 0-based rank in the store's own list (per platform, per storefront)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AppRef:
    """A resolved store listing. ``ident`` is a track id (iOS) or package (Android)."""
    platform: str
    ident: str
    title: str
    publisher: str = ""
    ratings: int = 0
    url: str = ""
    rating: float = 0.0    # the store's own average, as its listing shows it


@dataclass
class Theme:
    cluster_id: int
    review_ids: list[str]
    keywords: list[str] = field(default_factory=list)
    label: str = ""
    summary: str = ""
    recommendation: str = ""
    labelled_by: str = "keywords"   # "claude" once step 4 has run
    error: str = ""
    # populated by score.py, and recomputed against whatever the dashboard filters select
    n_reviews: int = 0
    avg_rating: float = 0.0
    priority: float = 0.0
    reach: float = 0.0           # cluster size relative to the largest cluster, 0-1
    pain: float = 0.0            # (5 - avg_rating) / 4, 0-1
    share: float = 0.0           # fraction of all reviews in scope
    recent_share: float = 0.0    # fraction of the cluster inside the recent window
    low_star: int = 0            # count of 1- and 2-star reviews
    platforms: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
