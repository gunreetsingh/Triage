"""Step 1: resolve an app name to store listings and pull its reviews.

iOS comes from Apple's public review RSS feed (10 pages x 50 per storefront),
with the first reviews set to exactly what Apple's own App Store page shows.
Android goes through ``google-play-scraper``, except for search: that library
returns ``appId: None`` for the top "featured" hit, which is usually the app the
user actually meant, so package resolution reads the search page directly.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from difflib import SequenceMatcher

import requests
from google_play_scraper import Sort
from google_play_scraper.constants.google_play import Device
from google_play_scraper import app as gp_app
from google_play_scraper import reviews as gp_reviews

from .config import ANDROID_SORT, IOS_SORT, MIN_REVIEW_CHARS
from .models import AppRef, Review

# Sort order changes which reviews you get far more than people expect: on both
# stores, "newest" and "most helpful/relevant" returned zero overlapping reviews
# in testing. The store apps default to helpful/relevant, and so does this tool,
# so its reviews are the ones users actually see.
IOS_SORTS = {"recent": "mostrecent", "helpful": "mosthelpful"}
ANDROID_SORTS = {
    "newest": Sort.NEWEST,
    "relevant": Sort.MOST_RELEVANT,
    "rating": Sort.RATING,
}

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
ITUNES_SEARCH = "https://itunes.apple.com/search"
ITUNES_LOOKUP = "https://itunes.apple.com/lookup"
ITUNES_RSS = "https://itunes.apple.com/{country}/rss/customerreviews/page={page}/id={ident}/sortby={sort}/json"
PLAY_SEARCH = "https://play.google.com/store/search"
APPLE_SEE_ALL = "https://apps.apple.com/{country}/app/id{ident}?see-all=reviews"
APPLE_PAGE_REVIEW = re.compile(r'"\$kind":"Review","id":"(\d+)"')
# apps.apple.com only embeds its reviews for the browser it expects.
SAFARI_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/18.0 Safari/605.1.15")


def _session() -> requests.Session:
    s = requests.Session()
    s.headers["User-Agent"] = UA
    return s


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


# Dropped before comparing publishers/titles: shared across unrelated companies.
_BOILERPLATE = {
    "inc", "llc", "ltd", "limited", "corp", "corporation", "company", "co",
    "sa", "ab", "ag", "gmbh", "plc", "bv", "nv", "pty", "llp", "lp", "oy",
    "holdings", "group", "technologies", "technology", "labs", "software",
    "mobile", "apps", "app", "international", "services", "solutions",
    "the", "and", "of", "my",
}


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", (s or "").lower()) if t and t not in _BOILERPLATE}


def _tokens_match(a: set[str], b: set[str]) -> bool:
    """True if the two token sets name the same entity.

    Exact overlap, or one token being a prefix of the other so that
    "Kalshi" matches "KalshiEX". The 4-character floor keeps fragments like
    "sun" from matching "sunlife", which is exactly the false rescue that would
    hide a wrong-app resolution.
    """
    if a & b:
        return True
    for x in a:
        for y in b:
            lo, hi = (x, y) if len(x) <= len(y) else (y, x)
            if len(lo) >= 4 and hi.startswith(lo):
                return True
    return False


def same_app_confidence(a: AppRef | None, b: AppRef | None) -> float:
    """How much the two platforms' resolved listings look like the same product.

    The stores rank independently, so one ambiguous name can resolve to two
    unrelated companies -- "Sunlife" gives the juice chain *SunLife Organics*
    (published by Incentivio) on iOS and the insurer *my Sun Life* on Play.
    Pooling those produces a confident-looking backlog about two different
    businesses, so callers should warn when this is low.

    Publisher is the strongest signal: store titles diverge freely across
    platforms ("Wealthsimple" vs "Wealthsimple - Grow your money") while the
    company behind them does not.
    """
    if not a or not b:
        return 1.0  # only one platform resolved; nothing to disagree with
    if a.publisher and b.publisher and _tokens_match(_tokens(a.publisher), _tokens(b.publisher)):
        return 1.0
    if _tokens_match(_tokens(a.title), _tokens(b.title)):
        return 0.7
    return max(_similarity(a.title, b.title), _similarity(a.publisher, b.publisher))


def _publisher_overlap(a: AppRef, b: AppRef) -> float:
    """Share of publisher words the two listings have in common."""
    x, y = _tokens(a.publisher), _tokens(b.publisher)
    if not x or not y:
        return 0.0
    shared = sum(any(_tokens_match({t}, {u}) for u in y) for t in x)
    return shared / max(len(x), len(y))


def pick_same_app(ref: AppRef, candidates: list[AppRef], threshold: float = 0.6) -> AppRef | None:
    """The candidate that is most clearly the same product as ``ref``.

    Takes the best match, not the first one over the line: searching Play for
    "Flo" ranks FLO, a Turkish shoe retailer ("Flo Magazacilik ..."), above Flo
    Health's period tracker, and one shared publisher word passes the line for
    both. Among those, the publisher that shares the most words wins.
    """
    scored = [(same_app_confidence(ref, c), _publisher_overlap(ref, c), -i, c) for i, c in enumerate(candidates)]
    scored = [t for t in scored if t[0] >= threshold]
    return max(scored, key=lambda t: t[:3])[3] if scored else None


def _rank_candidates(name: str, cands: list[AppRef]) -> list[AppRef]:
    """Order store hits by how likely each is the app the user meant.

    Title similarity alone is a trap: for "Wealthsimple" it scores the small
    "Wealthsimple Predict" above the flagship "Wealthsimple - Grow your money",
    because a shorter title shares a larger fraction of its characters with the
    query. So an exact or prefix title match dominates, the store's own search
    rank and the app's review volume break the remaining ties, and raw
    similarity only matters when nothing matched by prefix (typos, spacing).
    """
    import math

    q = _norm(name)
    scored = []
    for rank, c in enumerate(cands):
        t = _norm(c.title)
        exact = 1.0 if t == q else 0.0
        prefix = 1.0 if t.startswith(q) or q.startswith(t) else 0.0
        rank_score = 1.0 / (rank + 1)
        pop = min(1.0, math.log10(1 + max(0, c.ratings)) / 6.0)
        score = (
            0.35 * exact
            + 0.22 * prefix
            + 0.18 * rank_score
            + 0.13 * pop
            + 0.12 * _similarity(name, c.title)
        )
        scored.append((score, rank, c))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [c for _, _, c in scored]


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").replace(" ", " ")).strip()


# --------------------------------------------------------------------------
# resolution
# --------------------------------------------------------------------------
def ios_ref(item: dict) -> AppRef:
    """An iOS listing from an iTunes search/lookup result, with that storefront's rating."""
    return AppRef(
        platform="iOS",
        ident=str(item["trackId"]),
        title=item.get("trackName", ""),
        publisher=item.get("sellerName", ""),
        ratings=int(item.get("userRatingCount") or 0),
        url=item.get("trackViewUrl", ""),
        rating=float(item.get("averageUserRating") or 0),
    )


def resolve_ios(name: str, country: str = "us", limit: int = 8) -> list[AppRef]:
    """Candidate iOS listings for ``name``, best title match first."""
    r = _session().get(
        ITUNES_SEARCH,
        params={"term": name, "country": country, "entity": "software", "limit": limit},
        timeout=30,
    )
    r.raise_for_status()
    return _rank_candidates(name, [ios_ref(item) for item in r.json().get("results", [])])


def lookup_ios(ident: str, country: str = "us") -> AppRef | None:
    """One iOS listing by track id, with that storefront's rating."""
    r = _session().get(ITUNES_LOOKUP, params={"id": ident, "country": country}, timeout=30)
    r.raise_for_status()
    items = r.json().get("results", [])
    return ios_ref(items[0]) if items else None


def resolve_android(name: str, country: str = "us", limit: int = 8) -> list[AppRef]:
    """Candidate Android listings, read from the Play search page then verified.

    ``google_play_scraper.search`` drops the package id of the first result, so
    we pull ids out of the search HTML in rank order and confirm each with a
    details lookup.
    """
    r = _session().get(
        PLAY_SEARCH,
        params={"q": name, "c": "apps", "hl": "en", "gl": country},
        timeout=30,
    )
    r.raise_for_status()
    pkgs = list(dict.fromkeys(re.findall(r"/store/apps/details\?id=([A-Za-z0-9_.]+)", r.text)))

    out: list[AppRef] = []
    for pkg in pkgs[:limit]:
        try:
            d = gp_app(pkg, lang="en", country=country)
        except Exception:
            continue  # delisted / region-locked / not an app
        out.append(
            AppRef(
                platform="Android",
                ident=pkg,
                title=d.get("title", ""),
                publisher=d.get("developer", "") or "",
                ratings=int(d.get("ratings") or 0),
                url=f"https://play.google.com/store/apps/details?id={pkg}",
                rating=float(d.get("score") or 0),
            )
        )
    return _rank_candidates(name, out)


# --------------------------------------------------------------------------
# reviews
# --------------------------------------------------------------------------
def _entries(payload: dict) -> list[dict]:
    """The RSS feed omits ``entry`` when empty and unwraps it when len == 1."""
    entry = payload.get("feed", {}).get("entry", [])
    if isinstance(entry, dict):
        return [entry]
    return entry or []


def _rss_text(entry: dict) -> str:
    content = entry.get("content")
    if isinstance(content, list):  # occasionally [text, html]
        for c in content:
            if c.get("attributes", {}).get("type") == "text":
                return _clean(c.get("label", ""))
        content = content[0] if content else {}
    return _clean((content or {}).get("label", ""))


def apple_shown_ids(ident: str, country: str) -> list[str]:
    """Review ids Apple's own "Ratings & Reviews" page shows, in its order.

    That page (up to 10 reviews) is the top of the "Most Helpful" list the App
    Store app opens with. The RSS feed ranks almost the same way but not quite:
    Apple's page hides a few feed reviews and swaps some neighbours."""
    url = APPLE_SEE_ALL.format(country=country, ident=ident)
    html = requests.get(url, headers={"User-Agent": SAFARI_UA}, timeout=30).text
    return list(dict.fromkeys(APPLE_PAGE_REVIEW.findall(html)))


def _match_apple_page(reviews: list[Review], ident: str, country: str) -> list[Review]:
    """Put the reviews Apple's page shows first, in its order; drop the feed
    reviews Apple hides from that window; keep the feed order after it."""
    try:
        shown = apple_shown_ids(ident, country)
    except requests.RequestException:
        return reviews
    by_id = {r.review_id: r for r in reviews}
    top = [by_id[f"ios-{i}"] for i in shown if f"ios-{i}" in by_id]
    if not top:
        return reviews
    window = max(r.position for r in top)
    picked = {id(r) for r in top}
    rest = [r for r in reviews if id(r) not in picked and r.position > window]
    ordered = top + rest
    for i, r in enumerate(ordered):
        r.position = i
    return ordered


def fetch_ios_reviews(
    ident: str,
    countries=("us",),
    target: int = 300,
    sort: str = IOS_SORT,
    per_country: dict[str, int] | None = None,
) -> list[Review]:
    """Reviews for one iOS listing across storefronts.

    App Store reviews are scoped to a storefront, so ``countries`` decides which
    users you hear from, not just how many. ``per_country`` is filled in with the
    count each storefront contributed, so callers can spot a dead storefront.
    """
    sort_key = IOS_SORTS.get(sort, IOS_SORTS[IOS_SORT])
    sess = _session()
    seen: set[str] = set()
    out: list[Review] = []

    for country in countries:
        before = len(out)
        pos = 0  # rank in this storefront's list, as the store orders it
        for page in range(1, 11):  # Apple serves at most 10 pages per storefront
            if len(out) >= target:
                break
            url = ITUNES_RSS.format(country=country, page=page, ident=ident, sort=sort_key)
            try:
                resp = sess.get(url, timeout=30)
                if resp.status_code != 200:
                    break
                entries = _entries(resp.json())
            except Exception:
                break
            if not entries:
                break

            for e in entries:
                # The first entry of page 1 is sometimes the app itself, not a review.
                if "im:rating" not in e:
                    continue
                position = pos
                pos += 1
                rid = f"ios-{e.get('id', {}).get('label', '')}"
                if rid in seen:
                    continue
                body = _rss_text(e)
                title = _clean(e.get("title", {}).get("label", ""))
                if len(f"{title} {body}".strip()) < MIN_REVIEW_CHARS:
                    continue
                raw_date = e.get("updated", {}).get("label", "")
                try:
                    dt = datetime.fromisoformat(raw_date).astimezone(timezone.utc).replace(tzinfo=None)
                except ValueError:
                    continue
                seen.add(rid)
                out.append(
                    Review(
                        review_id=rid,
                        platform="iOS",
                        rating=int(e["im:rating"]["label"]),
                        date=dt.isoformat(timespec="seconds"),
                        ts=int(dt.replace(tzinfo=timezone.utc).timestamp()),
                        text=body,
                        title=title,
                        author=_clean(e.get("author", {}).get("name", {}).get("label", "")),
                        app_version=e.get("im:version", {}).get("label", "") or "",
                        country=country,
                        helpful=int(e.get("im:voteSum", {}).get("label", 0) or 0),
                        position=position,
                    )
                )
            time.sleep(0.25)  # be polite to the feed
        if sort_key == "mosthelpful":
            out[before:] = _match_apple_page(out[before:], ident, country)
        if per_country is not None:
            per_country[country] = len(out) - before
    return out


def fetch_android_reviews(
    ident: str,
    country: str = "us",
    lang: str = "en",
    target: int = 300,
    sort: str = ANDROID_SORT,
) -> list[Review]:
    """Reviews for one Play listing.

    Play's pool is global, but its "Most relevant" ranking is per country, so
    ``country`` should be the market the report is for. Only phone reviews are
    read: the Play app on a phone (and Play's web page) defaults to its "Phone"
    filter, and the unfiltered list mixes in tablet and Chromebook reviews.
    """
    sort_key = ANDROID_SORTS.get(sort, ANDROID_SORTS[ANDROID_SORT])
    out: list[Review] = []
    seen: set[str] = set()
    token = None
    pos = 0

    while len(out) < target:
        batch_size = min(200, max(20, target - len(out)))
        try:
            if token is None:
                batch, token = gp_reviews(
                    ident, lang=lang, country=country, sort=sort_key, count=batch_size,
                    filter_device_with=int(Device.MOBILE),  # the enum formats as "Device.MOBILE"
                )
            else:
                batch, token = gp_reviews(ident, continuation_token=token)
        except Exception:
            break
        if not batch:
            break

        for r in batch:
            position = pos
            pos += 1
            rid = f"android-{r.get('reviewId', '')}"
            if rid in seen:
                continue
            body = _clean(r.get("content") or "")
            if len(body) < MIN_REVIEW_CHARS:
                continue
            dt = r.get("at")
            if not isinstance(dt, datetime):
                continue
            seen.add(rid)
            out.append(
                Review(
                    review_id=rid,
                    platform="Android",
                    rating=int(r.get("score") or 0),
                    date=dt.isoformat(timespec="seconds"),
                    ts=int(dt.replace(tzinfo=timezone.utc).timestamp()),
                    text=body,
                    author=_clean(r.get("userName") or ""),
                    app_version=r.get("reviewCreatedVersion") or "",
                    country=country,
                    helpful=int(r.get("thumbsUpCount") or 0),
                    position=position,
                )
            )
        if token is None:
            break
        time.sleep(0.25)

    return out[:target]


def scrape(
    name: str,
    ios_countries=("us",),
    android_country: str = "us",
    per_platform: int = 300,
    ios_id: str | None = None,
    android_pkg: str | None = None,
    skip_ios: bool = False,
    skip_android: bool = False,
    ios_sort: str = IOS_SORT,
    android_sort: str = ANDROID_SORT,
) -> tuple[list[Review], dict[str, AppRef | None], dict]:
    """Resolve ``name`` on both stores and return the pooled, deduped reviews.

    ``ios_id`` / ``android_pkg`` skip resolution for that platform, for when the
    store's search ranking disagrees with the app you meant.

    Returns ``(reviews, resolved, diagnostics)``; diagnostics records the sort
    orders used and the per-storefront iOS counts, which is how a caller spots a
    storefront that is dormant for this app.
    """
    resolved: dict[str, AppRef | None] = {"iOS": None, "Android": None}
    reviews: list[Review] = []
    ios_per_country: dict[str, int] = {}

    if not skip_ios:
        if ios_id:
            cands = resolve_ios(name, country=ios_countries[0], limit=25)
            match = next((c for c in cands if c.ident == str(ios_id)), None)
            if match is None:
                try:
                    match = lookup_ios(str(ios_id), ios_countries[0])
                except requests.RequestException:
                    match = None
            resolved["iOS"] = match or AppRef("iOS", str(ios_id), f"iOS app {ios_id}")
        else:
            cands = resolve_ios(name, country=ios_countries[0])
            resolved["iOS"] = cands[0] if cands else None
        if resolved["iOS"]:
            reviews += fetch_ios_reviews(
                resolved["iOS"].ident, ios_countries, per_platform,
                sort=ios_sort, per_country=ios_per_country,
            )

    if not skip_android:
        if android_pkg:
            try:
                d = gp_app(android_pkg, lang="en", country=android_country)
                resolved["Android"] = AppRef(
                    platform="Android",
                    ident=android_pkg,
                    title=d.get("title", ""),
                    publisher=d.get("developer", "") or "",
                    ratings=int(d.get("ratings") or 0),
                    url=f"https://play.google.com/store/apps/details?id={android_pkg}",
                    rating=float(d.get("score") or 0),
                )
            except Exception:
                resolved["Android"] = AppRef("Android", android_pkg, android_pkg)
        else:
            cands = resolve_android(name, country=android_country)
            resolved["Android"] = cands[0] if cands else None
        if resolved["Android"]:
            reviews += fetch_android_reviews(
                resolved["Android"].ident, android_country,
                target=per_platform, sort=android_sort,
            )

    reviews.sort(key=lambda r: r.ts, reverse=True)
    diagnostics = {
        "ios_sort": ios_sort,
        "android_sort": android_sort,
        "ios_countries": list(ios_countries),
        "android_country": android_country,
        "ios_per_country": ios_per_country,
    }
    return reviews, resolved, diagnostics
