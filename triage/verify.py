"""Check the site's reviews against the live store pages.

    python -m triage.verify            # every app on the site
    python -m triage.verify spotify    # just these slugs

For each app it loads the public App Store and Google Play pages for the
report's country, reads the reviews those pages show (the top of the lists the
store apps open with: up to 10 on the App Store, 20 on Google Play), and checks
that each one is on the site at the same position. The stores re-rank over time, so run it soon after an analysis.
"""
from __future__ import annotations

import json
import re
import sys

import requests

from .config import ROOT
from .scrape import apple_shown_ids

DATA = ROOT / "web" / "data"
PLAY_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
PLAY_REVIEW = re.compile(r'"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"')


def _unique(ids: list[str]) -> list[str]:
    return list(dict.fromkeys(ids))


def apple_page(ios_id: str, country: str) -> list[str]:
    return apple_shown_ids(ios_id, country)


def play_page(pkg: str, country: str) -> list[str]:
    url = f"https://play.google.com/store/apps/details?id={pkg}&hl=en_{country.upper()}&gl={country.upper()}"
    return _unique(PLAY_REVIEW.findall(requests.get(url, headers=PLAY_UA, timeout=30).text))


def compare(store_ids: list[str], site: dict[str, int], prefix: str) -> tuple[int, int]:
    """(at the same position on the site, shown by the store page)."""
    return sum(site.get(f"{prefix}-{i}") == k for k, i in enumerate(store_ids)), len(store_ids)


def check(slug: str, summary: dict) -> dict:
    app = json.loads((DATA / "apps" / f"{slug}.json").read_text())
    site = {r["i"]: r.get("o", -1) for r in app["reviews"]}
    cc = summary.get("market", "us")
    out = {"slug": slug, "name": app["name"], "market": cc}
    if summary.get("ios_id"):
        out["ios"] = compare(apple_page(summary["ios_id"], cc), site, "ios")
    if summary.get("android_id"):
        out["android"] = compare(play_page(summary["android_id"], cc), site, "android")
    return out


def main(argv: list[str]) -> int:
    manifest = json.loads((DATA / "apps.json").read_text())
    apps = {a["slug"]: a for a in manifest["apps"]}
    slugs = argv or list(apps)
    exact = True
    print(f"{'App':<34} {'Market':<7} {'App Store page':<18} Google Play page")
    for slug in slugs:
        if slug not in apps:
            print(f"{slug:<34} not on the site")
            exact = False
            continue
        try:
            res = check(slug, apps[slug])
        except requests.RequestException as e:
            print(f"{slug:<34} couldn't reach the store ({e.__class__.__name__})")
            exact = False
            continue

        def cell(key: str) -> str:
            nonlocal exact
            if key not in res:
                return "not listed"
            same, shown = res[key]
            exact = exact and shown > 0 and same == shown
            return f"{same}/{shown} in order"

        print(f"{res['name'][:33]:<34} {res['market'].upper():<7} {cell('ios'):<18} {cell('android')}")
    print("\nEvery review the store pages show is on the site, at the same position." if exact
          else "\nSome reviews differ. The stores re-rank over time; re-run the analysis to refresh.")
    return 0 if exact else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
