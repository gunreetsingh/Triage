#!/usr/bin/env python3
"""Feature Request Triage Tool -- scrape -> embed -> cluster -> analyze -> score.

Works on any app on either store. One app, several, or a whole chart:

    python pipeline.py "Spotify"
    python pipeline.py "Spotify" "Uber" "Notion"
    python pipeline.py --from-file apps.txt
    python pipeline.py --top-charts 50 --chart-genre finance

    python pipeline.py "Wealthsimple" --android-pkg com.wealthsimple.trade
    python pipeline.py "Notion" --no-llm      # skip step 4 (no API key needed)

Writes one data/runs/<slug>.json per app, which is what the dashboard reads.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv

from triage import analyze, charts, cluster as clustering, score, store, web
from triage.config import (
    ANDROID_COUNTRY,
    ANDROID_SORT,
    IOS_COUNTRIES,
    IOS_SORT,
    K_MAX,
    K_MIN,
    PER_PLATFORM_TARGET,
    REVIEWS_PER_PROMPT,
    RUNS_DIR,
    ensure_dirs,
    slugify,
)
from triage.models import Review
from triage.scrape import same_app_confidence, scrape


def log(msg: str = "") -> None:
    print(msg, flush=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build a prioritized feature backlog from app store reviews.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("apps", nargs="*", help='App names, e.g. "Spotify" "Uber"')
    p.add_argument("--from-file", default=None,
                   help="Text file of app names, one per line (# comments allowed)")
    p.add_argument("--top-charts", type=int, default=None, metavar="N",
                   help="Queue the top N App Store apps instead of naming them")
    p.add_argument("--chart", default="free", choices=sorted(charts.CHARTS),
                   help="Which chart to pull for --top-charts")
    p.add_argument("--chart-genre", default="all",
                   help="Genre name or Apple genre id for --top-charts")
    p.add_argument("--chart-country", default="us", help="Storefront for --top-charts")

    p.add_argument("--per-platform", type=int, default=PER_PLATFORM_TARGET,
                   help="Target reviews per platform")
    p.add_argument("--country", default=None, metavar="CC",
                   help="Shorthand: set the iOS storefront and Play country together "
                        "(e.g. --country ca). App Store reviews differ per storefront.")
    p.add_argument("--ios-countries", default=",".join(IOS_COUNTRIES),
                   help="Comma-separated iOS storefronts (Apple caps each at 500 reviews)")
    p.add_argument("--android-country", default=ANDROID_COUNTRY)
    p.add_argument("--ios-sort", default=IOS_SORT, choices=["recent", "helpful"],
                   help="App Store order. 'helpful' matches what the store app shows "
                        "by default; the two orders barely overlap")
    p.add_argument("--android-sort", default=ANDROID_SORT,
                   choices=["newest", "relevant", "rating"],
                   help="Play order. 'relevant' matches the store app's default")
    p.add_argument("--ios-id", default=None,
                   help="Force an App Store track id (single-app runs only)")
    p.add_argument("--android-pkg", default=None,
                   help="Force a Play package name (single-app runs only)")
    p.add_argument("--skip-ios", action="store_true")
    p.add_argument("--skip-android", action="store_true")
    p.add_argument("-k", "--clusters", type=int, default=None,
                   help=f"Fixed cluster count; default sweeps {K_MIN}-{K_MAX} by silhouette")
    p.add_argument("--no-llm", action="store_true",
                   help="Skip step 4; themes keep their TF-IDF keyword labels")
    p.add_argument("--skip-existing", action="store_true",
                   help="Leave apps that already have a run file alone (resumes a batch)")
    p.add_argument("--delay", type=float, default=2.0,
                   help="Seconds to pause between apps in a batch, to stay polite")
    p.add_argument("--out", default=None,
                   help="Output path (single-app runs only; default data/runs/<slug>.json)")
    return p.parse_args(argv)


def collect_targets(args: argparse.Namespace) -> list[tuple[str, str | None]]:
    """Build the work queue as ``[(app_name, forced_ios_id_or_None), ...]``."""
    targets: list[tuple[str, str | None]] = [(a.strip(), None) for a in args.apps if a.strip()]

    if args.from_file:
        with open(args.from_file, encoding="utf-8") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    targets.append((line, None))

    if args.top_charts:
        log(f"Fetching top {args.top_charts} {args.chart} apps "
            f"({args.chart_genre}, {args.chart_country}) ...")
        # The chart gives us the iOS track id directly, so skip name resolution there.
        targets += charts.top_apps(
            limit=args.top_charts,
            country=args.chart_country,
            chart=args.chart,
            genre=args.chart_genre,
        )

    # De-dupe by slug, preserving order.
    seen: set[str] = set()
    unique: list[tuple[str, str | None]] = []
    for name, ident in targets:
        s = slugify(name)
        if s not in seen:
            seen.add(s)
            unique.append((name, ident))
    return unique


def run_one(
    app_name: str,
    args: argparse.Namespace,
    ios_id: str | None = None,
    report=None,
) -> dict | None:
    """Run all five stages for one app. Returns its payload, or None if it found nothing.

    ``report(stage, **data)`` is called as each stage starts (the web server
    uses it to show live progress); a failure is reported as ``"failed"`` with
    a human-readable ``reason`` before None is returned.
    """
    slug = slugify(app_name)
    started = time.time()
    notify = report or (lambda stage, **data: None)

    # --- 1. scrape --------------------------------------------------------
    ios_countries = tuple(
        c.strip() for c in (args.country or args.ios_countries).split(",") if c.strip()
    )
    android_country = args.country or args.android_country

    notify("scrape")
    log(f"[1/5] Scraping reviews for {app_name!r} "
        f"(iOS {'/'.join(ios_countries)}, sorted {args.ios_sort}; "
        f"Play sorted {args.android_sort}) ...")
    reviews, resolved, diag = scrape(
        app_name,
        ios_countries=ios_countries,
        android_country=android_country,
        per_platform=args.per_platform,
        ios_id=ios_id or args.ios_id,
        android_pkg=args.android_pkg,
        skip_ios=args.skip_ios,
        skip_android=args.skip_android,
        ios_sort=args.ios_sort,
        android_sort=args.android_sort,
    )
    for platform, ref in resolved.items():
        if ref:
            log(f"      {platform:<8} {ref.title!r} ({ref.ident}, {ref.ratings:,} ratings)")
        else:
            log(f"      {platform:<8} not found")

    # The two stores rank independently, so an ambiguous name can resolve to two
    # different companies. Pooling those gives a confident backlog about nothing.
    # 1.0 = publishers agree, 0.7 = titles agree, below that is raw string
    # similarity. Across the sample runs legitimate pairs all scored 1.0 and the
    # one wrong match scored 0.46, so the threshold sits in that gap.
    confidence = same_app_confidence(resolved.get("iOS"), resolved.get("Android"))
    mismatched = confidence < 0.6
    if mismatched:
        log("      WARNING: the two listings may not be the same app "
            f"(title/publisher similarity {confidence:.2f}).")
        log("               Pin the right ones with --ios-id / --android-pkg, "
            "or use --skip-ios / --skip-android.")

    # A storefront that returns almost nothing usually means the app is dormant
    # there and you are looking at the wrong market, not that nobody reviewed it.
    for cc, n in sorted(diag.get("ios_per_country", {}).items()):
        if n < 25:
            log(f"      Note: the {cc.upper()} App Store returned only {n} review(s) "
                f"for this app -- try --country <your market>.")

    if not reviews:
        log("      No reviews found -- skipping.")
        notify("failed", reason="No reviews were found for this app in that market.")
        return None

    counts: dict[str, int] = {}
    for r in reviews:
        counts[r.platform] = counts.get(r.platform, 0) + 1
    log(f"      {len(reviews)} reviews "
        f"({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))})")

    # Clustering into 8-15 themes needs more than a handful of reviews to mean anything.
    notify("scraped", reviews=len(reviews), platforms=counts)
    if len(reviews) < K_MIN * 3:
        log(f"      Only {len(reviews)} reviews -- too few to cluster, skipping.")
        notify("failed", reason=f"Only {len(reviews)} reviews were found, too few to find themes. "
                                "Try another market, or an app with more reviews.")
        return None
    if len(reviews) < 50:
        log("      Warning: very few reviews; clustering will be noisy.")

    # --- 2. embed ---------------------------------------------------------
    notify("embed")
    log("[2/5] Embedding into ChromaDB ...")
    ids, embeddings, documents, _ = store.embed_reviews(
        slug, reviews, reset=True,
        progress=lambda d, t: print(f"      {d}/{t}", end="\r", flush=True),
    )
    log(f"      {embeddings.shape[0]} vectors x {embeddings.shape[1]} dims")

    by_id = {r.review_id: r for r in reviews}
    ordered = [by_id[i] for i in ids]

    # --- 3. cluster -------------------------------------------------------
    notify("cluster")
    log("[3/5] Clustering ...")
    labels, k, silhouette = clustering.cluster(embeddings, k=args.clusters)
    keywords = clustering.keywords_per_cluster(documents, labels, app_name=app_name)
    log(f"      k={k}" + (f" (silhouette {silhouette.get(k, 0):.4f})" if silhouette else ""))

    assignments = {rid: int(c) for rid, c in zip(ids, labels)}
    clusters: dict[int, list[Review]] = {}
    for review, c in zip(ordered, labels):
        clusters.setdefault(int(c), []).append(review)
    samples = {
        cid: [ordered[i] for i in clustering.representative_reviews(
            embeddings, labels, cid, REVIEWS_PER_PROMPT)]
        for cid in clusters
    }

    # --- 4. analyze -------------------------------------------------------
    notify("analyze", themes=len(clusters))
    if args.no_llm:
        log("[4/5] Skipping Claude analysis (--no-llm).")
        analyses = {
            cid: {
                "label": ", ".join(keywords.get(cid, [])[:3]).title() or f"Theme {cid}",
                "summary": "Theme write-up skipped (--no-llm).",
                "recommendation": "Re-run without --no-llm for a recommendation.",
                "labelled_by": "keywords",
            }
            for cid in clusters
        }
    elif not analyze.have_api_key():
        log("[4/5] ANTHROPIC_API_KEY not set -- falling back to keyword labels.")
        analyses = analyze.analyze_clusters(app_name, clusters, keywords, samples)
    else:
        log(f"[4/5] Analyzing {len(clusters)} clusters with {analyze.MODEL} ...")
        analyses = analyze.analyze_clusters(
            app_name, clusters, keywords, samples,
            progress=lambda d, t: print(f"      {d}/{t}", end="\r", flush=True),
        )
        ok = sum(1 for a in analyses.values() if a.get("labelled_by") == "claude")
        log(f"      {ok}/{len(clusters)} clusters labelled by Claude")
        for cid, a in sorted(analyses.items()):
            if a.get("error"):
                log(f"      cluster {cid}: {a['error']}")

    # --- 5. score ---------------------------------------------------------
    notify("score")
    log("[5/5] Scoring ...")
    themes = score.score_themes(ordered, assignments, analyses, keywords)

    payload = {
        "app_name": app_name,
        "slug": slug,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "elapsed_seconds": round(time.time() - started, 1),
        "params": {
            "per_platform": args.per_platform,
            "ios_countries": "/".join(ios_countries),
            "android_country": android_country,
            "ios_sort": args.ios_sort,
            "android_sort": args.android_sort,
            "ios_per_country": diag.get("ios_per_country", {}),
            "listing_confidence": round(confidence, 2),
            "listing_mismatch": mismatched,
            "k": k,
            "k_requested": args.clusters,
            "silhouette": silhouette,
            "llm": (not args.no_llm) and analyze.have_api_key(),
            "model": analyze.MODEL,
        },
        "resolved": {p: (ref.__dict__ if ref else None) for p, ref in resolved.items()},
        "reviews": [r.to_dict() for r in ordered],
        "assignments": assignments,
        "keywords": {str(c): v for c, v in keywords.items()},
        "themes": [t.to_dict() for t in themes],
    }

    out_path = args.out or (RUNS_DIR / f"{slug}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    log()
    log(f"Top themes for {app_name}:")
    log(f"  {'pri':>5}  {'n':>4}  {'avg':>4}  label")
    for t in themes[:5]:
        log(f"  {t.priority:>5.1f}  {t.n_reviews:>4}  {t.avg_rating:>4.2f}  {t.label}")
    log(f"Wrote {out_path}")
    return payload


def main(argv: list[str] | None = None) -> int:
    load_dotenv()
    args = parse_args(argv)
    ensure_dirs()

    try:
        targets = collect_targets(args)
    except (ValueError, OSError) as e:
        log(f"Error: {e}")
        return 1

    if not targets:
        log("No apps given. Name them, or use --from-file / --top-charts.")
        log('  python pipeline.py "Spotify" "Uber"')
        log("  python pipeline.py --top-charts 50 --chart-genre finance")
        return 1

    if len(targets) > 1 and (args.ios_id or args.android_pkg or args.out):
        log("Error: --ios-id / --android-pkg / --out apply to a single app only.")
        return 1

    batch = len(targets) > 1
    if batch:
        log(f"Queued {len(targets)} apps: "
            + ", ".join(n for n, _ in targets[:6])
            + (" ..." if len(targets) > 6 else ""))
        log()

    done, skipped, failed = 0, 0, []
    for i, (name, ios_id) in enumerate(targets, 1):
        if args.skip_existing and (RUNS_DIR / f"{slugify(name)}.json").exists():
            log(f"({i}/{len(targets)}) {name} -- already has a run, skipping.")
            skipped += 1
            continue

        if batch:
            log(f"=== ({i}/{len(targets)}) {name} " + "=" * max(0, 46 - len(name)))
        try:
            # One app's failure must not end the batch.
            if run_one(name, args, ios_id=ios_id):
                done += 1
            else:
                skipped += 1
        except KeyboardInterrupt:
            log("\nInterrupted. Runs completed so far are saved.")
            break
        except Exception as e:
            log(f"      FAILED: {type(e).__name__}: {e}")
            failed.append(name)
        log()

        if batch and i < len(targets):
            time.sleep(args.delay)

    if batch:
        log("=" * 60)
        log(f"Done: {done} built, {skipped} skipped, {len(failed)} failed")
        if failed:
            log("Failed: " + ", ".join(failed))
    if done and not args.out:
        try:
            log(f"Website data refreshed for {web.export_all()} app(s).")
        except Exception as e:  # the run itself succeeded; don't fail it over the site
            log(f"Note: couldn't refresh the website data ({type(e).__name__}: {e}).")
    log("Website:    python -m http.server 8600 -d web")
    log("Dashboard:  streamlit run app.py")
    return 0 if done or skipped else 1


if __name__ == "__main__":
    sys.exit(main())
