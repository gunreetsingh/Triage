"""Paths, tunables and the single source of truth for pipeline defaults."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RUNS_DIR = DATA_DIR / "runs"
CHROMA_DIR = DATA_DIR / "chroma"

# --- scraping -------------------------------------------------------------
# Apple's review RSS caps at 10 pages x 50 reviews per storefront, so pulling
# a couple of storefronts is the only way past ~500 iOS reviews.
#
# App Store reviews are PER STOREFRONT: the same app shows a completely
# different review pool in each country, and a listing can be near-dormant in
# one country while busy in another. Set this to the market you actually care
# about -- see --country.
IOS_COUNTRIES = ("us",)
ANDROID_COUNTRY = "us"  # Play ranks "Most relevant" per country too
PER_PLATFORM_TARGET = 500  # Apple's feed stops at 500 per storefront
MIN_REVIEW_CHARS = 1       # keep every review the store shows, short ones included

# Sort order decides WHICH reviews you get, and the orders don't overlap at all.
# The defaults are each store's own default order, the one the App Store and
# Google Play apps show ("Most Helpful" / "Most relevant"), so the reviews here
# are the same reviews, in the same order, that a user sees on their phone in
# that country. Checked against the live store pages by `python -m triage.verify`.
IOS_SORT = "helpful"       # helpful | recent
ANDROID_SORT = "relevant"  # relevant | newest | rating

# --- clustering -----------------------------------------------------------
K_MIN = 8
K_MAX = 15

# --- priority score -------------------------------------------------------
# priority = 100 * (REACH_WEIGHT * reach + PAIN_WEIGHT * pain)
REACH_WEIGHT = 0.5
PAIN_WEIGHT = 0.5

# --- Claude ---------------------------------------------------------------
MODEL = "claude-haiku-5-5"
REVIEWS_PER_PROMPT = 25  # sampled per cluster; keeps prompts cheap and focused
MAX_LLM_WORKERS = 6

RECENT_WINDOW_DAYS = 90


def slugify(name: str) -> str:
    """App name -> filesystem- and Chroma-safe identifier."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return s or "app"


def ensure_dirs() -> None:
    for d in (DATA_DIR, RUNS_DIR, CHROMA_DIR):
        d.mkdir(parents=True, exist_ok=True)
