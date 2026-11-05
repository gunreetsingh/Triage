#!/usr/bin/env python3
"""Re-run steps 4-5 (Claude analysis + scoring) on runs that already exist.

Use this after adding an API key, or after changing the prompt or the scoring
weights -- it reuses the stored reviews and cluster assignments instead of
re-scraping and re-embedding, so it costs a few Claude calls and nothing else.

    python relabel.py                 # every run missing Claude labels
    python relabel.py wealthsimple    # named runs only
    python relabel.py --all           # every run, including already-labelled ones
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from dotenv import load_dotenv

from triage import analyze, cluster as clustering, score, store, web
from triage.config import REVIEWS_PER_PROMPT, RUNS_DIR, slugify
from triage.models import Review


def samples_for(slug: str, ordered: list[Review], assignments: dict[str, int],
                clusters: dict[int, list[Review]]) -> dict[int, list[Review]]:
    """Centroid-nearest reviews per cluster, reusing the persisted vectors.

    Falls back to the lowest-rated reviews if the Chroma collection is gone,
    which still gives Claude the most informative end of the cluster.
    """
    try:
        col = store.client().get_collection(store.collection_name(slug))
        ids = [r.review_id for r in ordered]
        got = col.get(ids=ids, include=["embeddings"])
        order = {rid: i for i, rid in enumerate(got["ids"])}
        emb = np.asarray([got["embeddings"][order[r]] for r in ids if r in order], dtype=np.float32)
        if emb.shape[0] != len(ordered):
            raise ValueError("vector count does not match the stored reviews")
        labels = np.array([assignments[r.review_id] for r in ordered])
        return {
            cid: [ordered[i] for i in clustering.representative_reviews(
                emb, labels, cid, REVIEWS_PER_PROMPT)]
            for cid in clusters
        }
    except Exception as e:
        print(f"      (no usable vectors -- {e}; sampling by rating instead)")
        return {
            cid: sorted(members, key=lambda r: (r.rating, -r.helpful))[:REVIEWS_PER_PROMPT]
            for cid, members in clusters.items()
        }


def relabel(path, force: bool = False) -> bool:
    payload = json.loads(path.read_text(encoding="utf-8"))
    app_name = payload["app_name"]

    already = all(t.get("labelled_by") == "claude" for t in payload["themes"])
    if already and not force:
        print(f"{app_name}: already labelled by Claude, skipping (use --all to redo).")
        return False

    reviews = [Review(**r) for r in payload["reviews"]]
    assignments = {k: int(v) for k, v in payload["assignments"].items()}
    keywords = {int(k): v for k, v in payload.get("keywords", {}).items()}

    clusters: dict[int, list[Review]] = {}
    for r in reviews:
        clusters.setdefault(assignments[r.review_id], []).append(r)

    print(f"{app_name}: {len(clusters)} clusters, {len(reviews)} reviews")
    samples = samples_for(payload["slug"], reviews, assignments, clusters)

    analyses = analyze.analyze_clusters(
        app_name, clusters, keywords, samples,
        progress=lambda d, t: print(f"      {d}/{t}", end="\r", flush=True),
    )
    ok = sum(1 for a in analyses.values() if a.get("labelled_by") == "claude")
    print(f"      {ok}/{len(clusters)} labelled by Claude")
    for cid, a in sorted(analyses.items()):
        if a.get("error"):
            print(f"      cluster {cid}: {a['error']}")

    themes = score.score_themes(reviews, assignments, analyses, keywords)
    payload["themes"] = [t.to_dict() for t in themes]
    payload["params"]["llm"] = ok > 0
    payload["params"]["model"] = analyze.MODEL
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    for t in themes[:3]:
        print(f"      {t.priority:>5.1f}  {t.label}")
    return ok > 0


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("runs", nargs="*", help="Run slugs or app names; default is all")
    p.add_argument("--all", action="store_true", help="Redo runs already labelled by Claude")
    args = p.parse_args(argv)

    if not analyze.have_api_key():
        print("ANTHROPIC_API_KEY not set -- add it to .env first.")
        return 1

    if args.runs:
        paths = [RUNS_DIR / f"{slugify(r)}.json" for r in args.runs]
        missing = [p for p in paths if not p.exists()]
        if missing:
            print("No such run: " + ", ".join(p.stem for p in missing))
            return 1
    else:
        paths = sorted(RUNS_DIR.glob("*.json"))

    done = 0
    for path in paths:
        try:
            if relabel(path, force=args.all):
                done += 1
        except Exception as e:
            print(f"{path.stem}: FAILED {type(e).__name__}: {e}")
        print()

    if done:
        print(f"Website data refreshed for {web.export_all()} app(s).")
    print(f"Relabelled {done} run(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
