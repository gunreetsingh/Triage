"""Step 6: the triage dashboard.

Reads a run file written by pipeline.py. Filters re-score the themes against
whatever is in scope rather than filtering a frozen ranking, so narrowing to
Android or to the last 30 days genuinely re-prioritizes the backlog.

Developer-facing detail (CLI flags, cluster counts, scoring formulas) lives in
the README and the pipeline output, deliberately not here -- this view is for
reading the backlog, not for operating the tool.

    streamlit run app.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta

import pandas as pd
import streamlit as st

from triage.config import ROOT, RUNS_DIR, ensure_dirs, slugify
from triage.models import Review
from triage.score import score_themes

st.set_page_config(page_title="Feature Request Triage", page_icon="🗂️", layout="wide")

COUNTRY_NAMES = {
    "us": "US", "ca": "Canadian", "gb": "UK", "au": "Australian",
    "in": "Indian", "de": "German", "fr": "French", "jp": "Japanese",
}
SORT_WORDS = {
    "recent": "newest first", "helpful": "most helpful first",
    "newest": "newest first", "relevant": "most relevant first",
    "rating": "by rating",
}


@st.cache_data(show_spinner=False)
def load_run(path: str, mtime: float) -> dict:
    """``mtime`` is unused but busts the cache when the pipeline rewrites the file."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def stars(avg: float) -> str:
    full = int(round(avg))
    return "★" * full + "☆" * (5 - full)


def triage_new_app(name: str, per_platform: int, country: str) -> tuple[bool, str]:
    cmd = [sys.executable, "pipeline.py", name, "--per-platform", str(per_platform)]
    if country:
        cmd += ["--country", country]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=1800)
    out = (proc.stdout or "") + (proc.stderr or "")
    ok = (RUNS_DIR / f"{slugify(name)}.json").exists() and proc.returncode == 0
    return ok, "\n".join(out.strip().splitlines()[-10:])


ensure_dirs()
runs = sorted(RUNS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

# --------------------------------------------------------------------------
# sidebar
# --------------------------------------------------------------------------
with st.sidebar:
    st.markdown("### 🗂️ Feature Request Triage")

    if not runs:
        st.caption("No apps yet.")
    choice = st.selectbox(
        "App", runs, format_func=lambda p: p.stem.replace("-", " ").title(),
        label_visibility="collapsed",
    ) if runs else None

    with st.popover("Add an app", width="stretch"):
        new_app = st.text_input("App name", placeholder="e.g. Spotify")
        c1, c2 = st.columns(2)
        depth = c1.selectbox("Reviews", [150, 250, 400], index=1)
        market = c2.selectbox("Market", ["us", "ca", "gb", "au"], index=0)
        if st.button("Analyze", type="primary", width="stretch"):
            if new_app.strip():
                with st.spinner(f"Analyzing {new_app}… this takes a couple of minutes"):
                    ok, tail = triage_new_app(new_app.strip(), depth, market)
                if ok:
                    st.cache_data.clear()
                    st.rerun()
                else:
                    st.error("Couldn't analyze that app.")
                    st.caption(tail.splitlines()[-1] if tail else "")
            else:
                st.warning("Enter an app name.")

if not runs:
    st.title("Feature Request Triage")
    st.info("No apps analyzed yet. Use **Add an app** in the sidebar to start.")
    st.stop()

payload = load_run(str(choice), choice.stat().st_mtime)
reviews = [Review(**d) for d in payload["reviews"]]
assignments = {k: int(v) for k, v in payload["assignments"].items()}
keywords = {int(k): v for k, v in payload.get("keywords", {}).items()}
analyses = {
    int(t["cluster_id"]): {
        "label": t.get("label", ""),
        "summary": t.get("summary", ""),
        "recommendation": t.get("recommendation", ""),
        "labelled_by": t.get("labelled_by", "keywords"),
    }
    for t in payload["themes"]
}

with st.sidebar:
    st.divider()
    st.caption("FILTERS")

    platforms_present = sorted({r.platform for r in reviews})
    platforms = st.multiselect(
        "Platform", platforms_present, default=platforms_present,
        label_visibility="collapsed",
    )

    dates = [datetime.fromisoformat(r.date).date() for r in reviews]
    dmin, dmax = min(dates), max(dates)
    preset = st.radio("Period", ["All time", "Last 30 days", "Last 90 days", "Custom"])
    if preset == "All time":
        start, end = dmin, dmax
    elif preset == "Last 30 days":
        start, end = max(dmin, dmax - timedelta(days=30)), dmax
    elif preset == "Last 90 days":
        start, end = max(dmin, dmax - timedelta(days=90)), dmax
    else:
        picked = st.date_input("Dates", value=(dmin, dmax), min_value=dmin, max_value=dmax)
        start, end = picked if isinstance(picked, tuple) and len(picked) == 2 else (dmin, dmax)

    lo, hi = st.slider("Star rating", 1, 5, (1, 5))

    focus = st.toggle(
        "Problems only", value=False,
        help="Hide themes that are mostly positive feedback",
    )

    pain_w = st.slider(
        "Rank by", 0.0, 1.0, 0.5, 0.05,
        help="Left ranks by how many users mention a theme; "
             "right ranks by how badly they rate it.",
        format="",
    )
    cols = st.columns(2)
    cols[0].caption("how many")
    cols[1].caption("how bad")
    reach_w = round(1.0 - pain_w, 2)

# --------------------------------------------------------------------------
# filter + score
# --------------------------------------------------------------------------
scope = [
    r for r in reviews
    if r.platform in platforms
    and lo <= r.rating <= hi
    and start <= datetime.fromisoformat(r.date).date() <= end
]

if not scope:
    st.title(payload["app_name"])
    st.warning("No reviews match these filters.")
    st.stop()

themes = score_themes(
    scope, assignments, analyses, keywords, reach_weight=reach_w, pain_weight=pain_w
)
if focus:
    themes = [t for t in themes if t.avg_rating < 3.5]

avg_all = sum(r.rating for r in scope) / len(scope)
low_star = sum(1 for r in scope if r.rating <= 2)

ios_cc = str(payload["params"].get("ios_countries", "us")).split("/")[0].split(",")[0]
market = COUNTRY_NAMES.get(ios_cc.lower(), ios_cc.upper())

st.title(payload["app_name"])
st.caption(
    f"{len(scope):,} reviews · {start:%b %Y} – {end:%b %Y} · "
    f"{market} App Store and Google Play"
)

# st.metric's delta always renders an arrow glyph, so sub-labels go in captions.
c1, c2, c3, c4 = st.columns(4)
c1.metric("Reviews", f"{len(scope):,}")
c2.metric("Average rating", f"{avg_all:.2f}")
c2.caption(stars(avg_all))
c3.metric("Unhappy users", f"{low_star / len(scope):.0%}")
c3.caption(f"{low_star:,} rated 1–2 stars")
c4.metric("Themes", len(themes))

st.divider()

if not themes:
    st.info("No problem themes in this selection. Turn off **Problems only** to see everything.")
    st.stop()

table = pd.DataFrame(
    [
        {
            "Priority": t.priority,
            "Theme": t.label,
            "Reviews": t.n_reviews,
            "Rating": t.avg_rating,
        }
        for t in themes
    ]
)

event = st.dataframe(
    table,
    hide_index=True,
    on_select="rerun",
    selection_mode="single-row",
    width="stretch",
    column_config={
        "Priority": st.column_config.ProgressColumn(
            "Priority", min_value=0, max_value=100, format="%.0f", width="small"
        ),
        "Theme": st.column_config.TextColumn("Theme", width="large"),
        "Reviews": st.column_config.NumberColumn(width="small"),
        "Rating": st.column_config.NumberColumn(format="%.1f ★", width="small"),
    },
)

# --------------------------------------------------------------------------
# selected theme
# --------------------------------------------------------------------------
selected = event.selection.rows[0] if event.selection.rows else 0
theme = themes[selected]

st.divider()
st.subheader(theme.label)

m1, m2, m3, m4 = st.columns(4)
m1.metric("Priority", f"{theme.priority:.0f}")
m2.metric("Reviews", theme.n_reviews)
m2.caption(f"{theme.share:.0%} of all reviews")
m3.metric("Rating", f"{theme.avg_rating:.1f}")
m3.caption(stars(theme.avg_rating))
m4.metric("Last 90 days", f"{theme.recent_share:.0%}")
m4.caption("of this theme")

if theme.summary:
    st.markdown("**What users are saying**")
    st.write(theme.summary)
if theme.recommendation:
    st.markdown("**Recommended fix**")
    st.success(theme.recommendation)

split = " · ".join(f"{p} {n}" for p, n in sorted(theme.platforms.items()))
st.caption(f"Platform split: {split}")

with st.expander(f"Read the {theme.n_reviews} reviews behind this theme"):
    order = st.radio(
        "Order", ["Lowest rated", "Newest", "Most helpful"],
        horizontal=True, label_visibility="collapsed",
    )
    in_theme = [r for r in scope if r.review_id in set(theme.review_ids)]
    if order == "Lowest rated":
        in_theme.sort(key=lambda r: (r.rating, -r.ts))
    elif order == "Newest":
        in_theme.sort(key=lambda r: -r.ts)
    else:
        in_theme.sort(key=lambda r: (-r.helpful, r.rating))

    for r in in_theme:
        meta = f"{stars(r.rating)} · {r.platform} · {r.date[:10]}"
        if r.app_version:
            meta += f" · app {r.app_version}"
        st.caption(meta)
        if r.title:
            st.markdown(f"**{r.title.replace('—', ' - ')}**")
        st.write(r.text.replace("—", " - "))
        st.divider()

st.download_button(
    "Export backlog (CSV)",
    table.to_csv(index=False).encode(),
    file_name=f"{payload['slug']}-backlog.csv",
    mime="text/csv",
)
