# Triage

**Search any app. See what its users want fixed.**

Triage reads an app's reviews from the App Store and Google Play, groups them into themes, and ranks those themes so you know what to fix first. Each theme gets a short name, a summary of what people are saying, and a suggested fix.

It's built for product managers who want answers from real user feedback without reading thousands of reviews.

---

## What you can do

- **Search any app** on the App Store and get a report in about a minute.
- **See the top issue first**, with a priority score from 0 to 100.
- **Read the ranked list** of every theme, from most urgent to least.
- **Click any theme** to read the summary, the suggested fix, and every review behind it.
- **Filter** by platform (iPhone or Android) and time period (last 30 or 90 days).
- **Compare with the stores.** Reviews appear in the same order the App Store and Google Play show them on your phone.

---

## How it works

1. **Collect.** Triage pulls up to 500 reviews from each store, in the same order the stores show them.
2. **Understand.** Each review is turned into numbers that capture its meaning, so reviews saying the same thing end up close together.
3. **Group.** Similar reviews are grouped into 8 to 15 themes, like "Crashes after update" or "Too many ads".
4. **Explain.** AI (Anthropic's Claude) names each theme, summarizes it, and suggests a fix.
5. **Rank.** Each theme gets a priority score.

### How priority is scored

A theme ranks higher when **more people** mention it and when those people are **more unhappy** (lower star ratings). Both count equally. A big group of 1-star reviews lands at the top; a small group of happy reviews lands at the bottom.

---

## Run it on your computer

You need **Python 3.10 or newer** and an **Anthropic API key** (from console.anthropic.com).

**1. Install**

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements-local.txt
```

**2. Add your API key**

```bash
cp .env.example .env
```

Open `.env` and replace the placeholder after `ANTHROPIC_API_KEY=` with your key. This file stays on your computer and is never uploaded to GitHub.

**3. Start it**

```bash
.venv/bin/python server.py
```

Then open **http://localhost:8600** in your browser.

---

## Put it online (Vercel, free)

The online version runs on Vercel's free plan. Visitors can open the finished reports and search any app for a new one. Online, Claude groups the reviews into themes itself, so the site doesn't need the heavier libraries the local version uses. New reports are kept in the visitor's browser tab, not saved on the server.

1. On **vercel.com**, choose **Add New → Project** and import this repository. Leave every setting as it is.
2. Under **Environment Variables**, add `ANTHROPIC_API_KEY` with your key.
3. Click **Deploy**.

Set a monthly spend limit in your Anthropic account so a busy day can't surprise you.

---

## Built with

- **Python** and **FastAPI** for the server
- **ChromaDB** to store what each review means
- **scikit-learn** to group reviews into themes
- **Claude** (Anthropic) to name and explain each theme
- **Plain HTML, CSS and JavaScript** for the website (no framework)

---

## Good to know

- **A report is a snapshot.** The stores re-rank reviews over time, so a report matches the stores on the day it was made.
- **It reads a sample.** Up to 500 reviews per store, the ones each store shows first. That's what most users see, but not every review ever written.
- **Search starts from the App Store.** Apps only on Google Play won't show up in search.
- **Reviews differ by country.** Each report is for one country, shown at the top of the page.
- **Each new report costs about half a cent** in AI usage.

---

## Project files

| File or folder | What it is |
|---|---|
| `server.py` | Runs the website and the "search any app" feature on your computer |
| `vercel_app.py` | The same, for the free online version on Vercel |
| `pipeline.py` | Builds reports from the command line |
| `triage/` | The main logic: collecting, grouping, explaining and scoring reviews |
| `web/` | The website, plus the finished reports in `web/data/` |
