"""Step 5: turn each cluster into a priority score.

    reach    = cluster size / largest cluster size      (0-1)
    pain     = (5 - average rating) / 4                 (0-1)
    priority = 100 * (REACH_WEIGHT * reach + PAIN_WEIGHT * pain)

So a big cluster of angry reviews outranks a big cluster of happy ones, and both
outrank a small one. ``reach`` is relative to the largest cluster rather than the
total, which keeps the score readable on a 0-100 scale regardless of how many
clusters there are.

Scoring is deliberately a pure function of a set of reviews: the dashboard calls
it again on whatever its filters select, so the ranking reflects the current view
rather than the whole run.
"""
from __future__ import annotations

import time

from .config import PAIN_WEIGHT, REACH_WEIGHT, RECENT_WINDOW_DAYS
from .models import Review, Theme


def score_themes(
    reviews: list[Review],
    assignments: dict[str, int],
    analyses: dict[int, dict] | None = None,
    keywords: dict[int, list[str]] | None = None,
    now_ts: int | None = None,
    reach_weight: float = REACH_WEIGHT,
    pain_weight: float = PAIN_WEIGHT,
    recent_days: int = RECENT_WINDOW_DAYS,
) -> list[Theme]:
    """Score the clusters present in ``reviews``, highest priority first.

    ``assignments`` maps review id -> cluster id. Reviews with no assignment
    (e.g. filtered-in from a different run) are ignored.
    """
    analyses = analyses or {}
    keywords = keywords or {}
    now_ts = now_ts or int(time.time())
    cutoff = now_ts - recent_days * 86400

    buckets: dict[int, list[Review]] = {}
    for r in reviews:
        cid = assignments.get(r.review_id)
        if cid is None:
            continue
        buckets.setdefault(int(cid), []).append(r)
    if not buckets:
        return []

    total = sum(len(v) for v in buckets.values())
    max_n = max(len(v) for v in buckets.values())

    themes: list[Theme] = []
    for cid, members in buckets.items():
        n = len(members)
        avg = sum(m.rating for m in members) / n
        reach = n / max_n
        pain = max(0.0, min(1.0, (5.0 - avg) / 4.0))
        meta = analyses.get(cid, {})

        platforms: dict[str, int] = {}
        for m in members:
            platforms[m.platform] = platforms.get(m.platform, 0) + 1

        themes.append(
            Theme(
                cluster_id=cid,
                review_ids=[m.review_id for m in members],
                keywords=keywords.get(cid, []),
                label=meta.get("label") or f"Theme {cid}",
                summary=meta.get("summary", ""),
                recommendation=meta.get("recommendation", ""),
                labelled_by=meta.get("labelled_by", "keywords"),
                error=meta.get("error", "") or "",
                n_reviews=n,
                avg_rating=round(avg, 2),
                priority=round(100 * (reach_weight * reach + pain_weight * pain), 1),
                reach=round(reach, 3),
                pain=round(pain, 3),
                share=round(n / total, 3),
                recent_share=round(sum(1 for m in members if m.ts >= cutoff) / n, 3),
                low_star=sum(1 for m in members if m.rating <= 2),
                platforms=platforms,
            )
        )

    themes.sort(key=lambda t: (-t.priority, -t.n_reviews))
    return themes
