# 🗂️ Feature Request Triage Tool

Type an app name. Get a prioritized product backlog built from what real users are
saying in App Store and Google Play reviews — each theme labelled, summarized, and
turned into a concrete fix recommendation by Claude.

```bash
python server.py                       # then open http://localhost:8600 and search any app
python pipeline.py "Wealthsimple"      # or analyze from the command line
```

---

## The pipeline

| # | Stage | What happens | Where |
|---|-------|--------------|-------|
| 1 | **Scrape** | Resolve the app name on both stores, pull reviews with text, rating, date and platform | `triage/scrape.py` |
| 2 | **Embed** | Each review → a 384-dim vector, persisted in ChromaDB | `triage/store.py` |
| 3 | **Cluster** | k-means over the embeddings, k chosen by silhouette score in 8–15 | `triage/cluster.py` |
| 4 | **Analyze** | One Claude call per cluster → label, summary, fix recommendation | `triage/analyze.py` |
| 5 | **Score** | Cluster size + average rating → a single priority score | `triage/score.py` |
| 6 | **Website** | Overview of every app, ranked backlog, priority map, trends, review drill-down | `web/` |

Steps 1–5 run in `pipeline.py` and write `data/runs/<app>.json`; the pipeline then
exports a trimmed copy to `web/data/` for the site. Neither front end calls the network
or Claude, so re-running the pipeline is the only thing that does.

---

## Search any app (the server)

`server.py` serves the website and lets visitors analyze apps nobody has analyzed yet:

1. Typing in search (⌘K, or the search bar on the homepage) queries the App Store live,
   with logos and ratings. Apps that already have a report open instantly.
2. Picking any other app queues an analysis. The visitor watches a progress page while
   the server finds the app on both stores, reads its reviews, clusters them, has
   Claude name each theme and suggest a fix, and ranks them — about a minute.
3. The finished report opens on its own and joins the site for everyone after.

```bash
python server.py                       # http://localhost:8600
HOST=0.0.0.0 PORT=8000 python server.py
```

| Endpoint | |
|---|---|
| `GET /api/search?q=&country=` | Live App Store search; already-analyzed apps are marked |
| `POST /api/analyze` `{ios_id, country}` | Start an analysis, or get the existing report |
| `GET /api/jobs/<id>` | Progress of one analysis |
| `GET /api/health` | Whether analysis is available |

Search starts from the App Store, so an app has to be listed there; Android reviews are
added when the Play listing clearly matches (same publisher or title), otherwise the
report uses App Store reviews only and says so. Markets: US, Canada, UK, Australia,
India, Ireland, New Zealand.

**Because anyone can start scraping and Claude calls, the server is guarded:**

| Guard | Default | Setting |
|---|---|---|
| Analyses per visitor per hour | 4 | `TRIAGE_PER_IP_PER_HOUR` |
| Analyses per day, all visitors | 60 | `TRIAGE_DAILY_LIMIT` |
| Waiting in the queue at once | 12 | `TRIAGE_MAX_QUEUE` |
| Reviews read per store | 500 | `TRIAGE_PER_PLATFORM` |

A request for an app and market that already has a report returns it without re-running,
and a second request for an app that's still in progress joins the same job. Analyses run
one at a time. The API key stays on the server; the browser never sees it. Each analysis
costs roughly half a cent in Claude calls.

**Deploying.** The server needs a host that runs Python and keeps files between restarts
(Render, Railway or Fly.io with a persistent disk, or any VPS): reports, icons and the
vector store live in `data/` and `web/data/`. Set `ANTHROPIC_API_KEY` and `HOST=0.0.0.0`.
It must run as **one process**, since the queue and limits are held in memory. A purely
static host (GitHub Pages, Netlify) can still serve `web/` on its own; search then only
finds the apps already analyzed.

Both stores are read through public, unofficial endpoints. That's fine for a portfolio
demo, but a high-traffic public deployment would hit their rate limits and should review
the stores' terms.

## The website

`web/` is a static site — plain HTML, CSS and JavaScript modules, no framework, no
build step and no server code. It reads `web/data/apps.json`, one
`web/data/apps/<slug>.json` per app, and the icons in `web/data/icons/`.

```bash
python -m http.server 8600 -d web      # any static server works
python -m triage.web                   # rebuild web/data by hand (the pipeline does this for you)
```

It has to be served over HTTP: browsers block a page opened straight from disk from
loading its data files.

**Home page** — told with one app's real reviews, top to bottom:

- **The story.** A pinned scroll sequence in which each of my Sun Life's 646 reviews is a
  particle. Scrolling gathers them into a cloud, spreads them across a map of meaning,
  colors them into themes, swaps the keywords for Claude's names, and finally lines them
  up into the ranked backlog — every dot is still one review. Dots on the map sit where
  t-SNE put that review's embedding, so neighbouring dots really are similar reviews.
- **A scroll-lit statement**, words brightening as you read.
- **The apps** — a horizontal gallery driven by vertical scroll, one card per app with its
  real logo, rating mix and top issue, curving in 3D through the centre.
- **The method** and a footer wordmark that rises into place.

**App page** — the hero's ambient light is the app's own icon, blurred; then a statement
of how many users are unhappy, the issue to fix first, an **interactive review map**
(hover any dot to read the review, click to open its theme), the ranked backlog, the
priority map and trends, and a hand-off to the next app. The page's accent color is
sampled from the icon.

**Getting around** — `⌘K` (or `/`) opens a switcher to jump to any app; each theme has its
own URL (`#/app/wealthsimple/3`); page changes play a curtain in the destination app's
brand color. Filters for platform, period and ranking re-score themes in the browser with
the same formula as `triage/score.py`.

**What the export adds** (`triage/web.py`): each app's icon, fetched from its store listing
and re-encoded locally as a 256px PNG; a brand color sampled from that icon (black-and-white
logos fall back to the site accent); and a 2-D t-SNE map of every review, cached in
`data/layout/` so it only recomputes when a run changes (~1 s per app).

**Accessibility** — every animation is skipped under *reduced motion*: the story becomes a
still image followed by the five steps as text, the gallery a plain grid, and smooth
scrolling is off. All chart content is also available as a table, and every review on the
map is listed in the theme drawers.

**External requests** — Google Fonts, and [Lenis](https://github.com/darkroomengineering/lenis)
1.1.13 from jsDelivr for smooth scrolling. Lenis is optional: without it the site falls
back to native scrolling.

Because it's static, the site can be published as-is on GitHub Pages, Netlify or
Vercel: point the host at `web/` and commit `web/data/`. No API key is involved —
Claude only runs inside the pipeline. App names and logos belong to their owners and
are shown only to identify the apps whose public reviews were analyzed. The Streamlit
dashboard (`streamlit run app.py`) is still there as a quick internal view.

---

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then paste your Anthropic API key into .env
```

Only **step 4** needs an API key. Embeddings run locally through ChromaDB's bundled
all-MiniLM-L6-v2 (ONNX) model — no embedding API, no extra key. Without a key the
pipeline still completes and themes fall back to TF-IDF keyword labels, which is
enough to see the clustering and scoring work end to end.

---

## Usage

**Nothing is hardcoded to any app.** Pass any name on either store.

```bash
# One app
python pipeline.py "Spotify"

# Several at once
python pipeline.py "Spotify" "Uber" "Notion" "Revolut"

# From a list (one name per line, # comments allowed)
python pipeline.py --from-file apps.txt

# Straight off the App Store charts, no names needed
python pipeline.py --top-charts 50 --chart-genre finance
python pipeline.py --top-charts 25 --chart grossing --chart-genre health --chart-country gb
```

Or type a name into **➕ Triage a new app** in the dashboard and it runs the
pipeline for you.

Each app writes its own `data/runs/<slug>.json`, and the dashboard's **App**
selector lists every run you've built.

```bash
# More reviews: Apple caps each storefront at 500, so add storefronts for volume
python pipeline.py "Notion" --per-platform 400 --ios-countries us,gb,ca

# Pin the exact listing when name resolution picks the wrong app
python pipeline.py "Wealthsimple" --android-pkg com.wealthsimple.trade --ios-id 1403491709

# One platform only, fixed cluster count, no API key needed
python pipeline.py "Duolingo" --skip-android -k 10 --no-llm

# Resume an interrupted batch without redoing finished apps
python pipeline.py --from-file apps.txt --skip-existing
```

In a batch, one app failing never stops the rest — failures are collected and
reported at the end. `python pipeline.py --help` lists every flag.

### Chart genres

`--chart-genre` takes a name or a raw Apple genre id:
`finance`, `health`, `social`, `productivity`, `games`, `shopping`, `travel`,
`music`, `news`, `education`, `business`, `food`, `lifestyle`, `medical`,
`photo`, `sports`, `utilities`, `weather`, `books`, `entertainment`,
`navigation`, `reference`, `all`. `--chart` is `free`, `paid` or `grossing`.

### The same reviews as your phone

Each report holds the same reviews, in the same order, that the App Store and
Google Play apps open with in that country. Two things decide that list, and both
were measured against the live store pages:

| | What the store apps show | What this tool fetches | Match |
|---|---|---|---|
| **App Store** | "Most Helpful", per country | Apple's own page for the top 10, then the "Most Helpful" feed (up to 500) | **10 of 10, same order** |
| **Google Play** | "Most relevant", per country, Phone reviews | "Most relevant", Phone filter, for the report's country (up to 500) | **20 of 20, same order** |

- **Sort order.** "Newest" and "Most helpful/relevant" share *no* reviews, so
  fetching newest-first gives a list that never looks like the phone's.
- **Country.** App Store reviews are separate per country (Spotify's US and CA
  lists share none), and Google Play ranks "Most relevant" per country too. Every
  report records its country; the site's search defaults to the visitor's own.
- **Apple's top 10.** Apple's public feed ranks almost exactly like the App
  Store, but its page hides a few feed reviews and swaps some neighbours. The
  first 10 are therefore taken from Apple's own "Ratings & Reviews" page, which
  is as far as Apple publishes; after that the feed's order is used.
- **Phone reviews.** The Play app on a phone (and Play's web page) filters to
  Phone reviews by default; the unfiltered list mixes in tablet and Chromebook
  reviews and only matched about half the time.
- **Every review is kept**, short ones included, because the stores show them.

The stores re-rank as new votes come in, so a report is a snapshot from the date
it shows. To check a report against the stores right now:

```bash
python -m triage.verify            # every app on the site
python -m triage.verify spotify    # one app
```

To fetch newest-first instead (better for "what broke this week"):

```bash
python pipeline.py "Wealthsimple" --country ca --ios-sort recent --android-sort newest
```

### How far this scales

The charts are the largest bulk listing either store publishes — up to **100 apps
per genre per storefront**. Neither store exposes a full catalogue, so there is no
"every app" list to iterate: the App Store and Play each carry roughly two million
apps, and at ~2 minutes per app a serial run over all of them would take years and
would be rate-limited or blocked long before that. Both stores are being scraped
through public, unauthenticated endpoints.

What this tool is actually built for is the tractable version: a few apps, a
competitive set, or a genre's top 50 — dozens to low hundreds, which is a batch
of minutes to hours. For more than that, raise `--delay`, run genres separately,
and expect to need proxying and a resumable queue.

---

## How priority is scored

```
reach    = cluster size ÷ largest cluster size      (0–1)
pain     = (5 − average rating) ÷ 4                 (0–1)
priority = 100 × (0.5 × reach + 0.5 × pain)
```

A large cluster of angry reviews outranks a large cluster of happy ones, and both
outrank a small cluster. The dashboard exposes the reach/pain balance as a slider,
so you can rank by "how many people" or "how angry they are" and watch the backlog
reorder.

**Filters re-score rather than re-filter.** Narrowing to Android or to the last 30
days recomputes every cluster's size, average rating and priority against just those
reviews. The ranking you see belongs to the slice you're looking at — on the sample
run, switching to Android-only promotes the login/update theme from 3rd to 2nd.

---

## What a run looks like

```
[1/5] Scraping reviews for 'Wealthsimple' ...
      iOS      'Wealthsimple' (1403491709, 129,935 ratings)
      Android  'Wealthsimple - Grow your money' (com.wealthsimple.trade, 81,086 ratings)
      648 reviews (Android 300, iOS 348)
[2/5] Embedding into ChromaDB ...      648 vectors x 384 dims
[3/5] Clustering ...                   k=12 (silhouette 0.0663)
[4/5] Analyzing 12 clusters with claude-haiku-5-5 ...
[5/5] Scoring ...

  pri     n   avg  label
 92.2    93  1.62  Money, Account, Card
 70.1    61  2.02  Slow, Data, Phone
 67.8    41  1.34  Update, Phone, Log
```

The clusters are coherent in practice: the 61-review "slow / data / phone" theme is
almost entirely lag, crashes and battery/data complaints, split 33 Android / 28 iOS,
concentrated in recent app versions — which is exactly the shape of a real bug report.

---

## Design notes

**App resolution is deliberately not title similarity.** For "Wealthsimple", string
similarity ranks the 73-rating *Wealthsimple Predict* above the 81,086-rating flagship,
because a shorter title shares a larger fraction of its characters with the query.
Resolution instead weights exact/prefix title matches first, then the store's own search
rank and the app's review volume. `--ios-id` / `--android-pkg` override it outright.

**Play Store search is read from HTML.** `google-play-scraper`'s `search()` returns
`appId: None` for the top "featured" hit — usually the app you actually meant — so
package resolution parses the search page and verifies each candidate with a details
lookup.

**Claude calls are schema-constrained and isolated.** Each cluster gets one
`messages.parse()` call against a Pydantic schema, so a malformed response can't reach
the dashboard. Calls run in parallel, retry with backoff on rate limits and 5xx, and a
cluster that still fails degrades to its keyword label with the error recorded — one
bad cluster never sinks a run. Reviews are framed in the system prompt as data to
analyze, not instructions to follow.

**Claude sees the centre of each cluster.** Clusters routinely exceed the 25-review
prompt budget, so the sample sent is the reviews nearest the cluster centroid rather
than an arbitrary slice.

---

## Known limitations

- **Silhouette scores are low (~0.05–0.07).** Normal for short-text embeddings, where
  clusters overlap rather than separate cleanly. It means the automatic `k` is a weak
  preference, not a strong optimum — the sweep lands anywhere in 8–15 depending on the
  app. Pin `-k` if you want a stable cluster count across runs.
- **Praise clusters still rank mid-table.** The score is exactly size + rating as
  specified, so a 92-review 4.6★ cluster lands around the middle. Filter to 1–3★ in the
  dashboard for a pure problem backlog.
- **Review volume is capped by the stores.** Apple's RSS feed serves at most 10 pages ×
  50 reviews per storefront; add storefronts via `--ios-countries` for more.
- **A run is a sample, not a census.** It's the first N reviews in one sort order from
  one storefront — not everything ever written about the app. Theme *proportions* are
  the sample's, so treat priority as a ranking signal rather than a population estimate,
  and keep sort and storefront fixed when comparing apps or re-running over time.
- **Reviews cluster by language too.** A French-language cluster is a normal result for
  a Canadian app; it's real signal, but it's a language split, not a product theme.
- Both stores are scraped through public, unauthenticated endpoints with no documented
  stability guarantee, so a store-side HTML or feed change can break resolution.

---

## Layout

```
server.py            website + live analysis API (search any app)
pipeline.py          CLI: runs steps 1-5 for one app or a batch
relabel.py           re-runs steps 4-5 on existing runs (no re-scraping)
app.py               Streamlit dashboard (internal view)
web/                 the website: index.html, assets/{lib,views}/, data/ (generated)
triage/
  config.py          paths, tunables, defaults
  models.py          Review / AppRef / Theme
  scrape.py          store resolution + review fetching
  charts.py          App Store top-charts enumeration for batch runs
  store.py           ChromaDB embed + persist
  cluster.py         k selection, k-means, TF-IDF keywords, centroid sampling
  analyze.py         Claude calls (claude-haiku-5-5, structured output)
  score.py           priority scoring (pure function of a review set)
  web.py             exports runs, icons, brand colors and review maps for the website
data/
  chroma/            persisted vector store
  runs/              one JSON per app -- the dashboard's input
```
