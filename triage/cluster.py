"""Step 3: cluster review embeddings into themes.

k-means on L2-normalized vectors (so Euclidean distance ranks the same as
cosine), sweeping k across the configured range and keeping the best silhouette
score. Each cluster also gets TF-IDF keywords: they label themes when step 4 is
skipped, and they give Claude a head start when it isn't.
"""
from __future__ import annotations

import re

import numpy as np
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import silhouette_score

from .config import K_MAX, K_MIN

# Review-boilerplate that describes no theme.
EXTRA_STOPWORDS = {
    "app", "apps", "application", "use", "used", "using", "user", "users",
    "great", "good", "bad", "nice", "love", "like", "really", "just", "dont",
    "doesnt", "im", "ive", "thing", "things", "time", "times", "star", "stars",
    "please", "thanks", "thank", "make", "makes", "need", "needs", "want",
    "getting", "got", "way", "lot", "day", "days", "work", "works", "working",
}


def _l2(x: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.clip(norms, 1e-12, None)


def choose_k(
    embeddings: np.ndarray, k_min: int = K_MIN, k_max: int = K_MAX, seed: int = 42
) -> tuple[int, dict[int, float]]:
    """Pick k in [k_min, k_max] by silhouette score on cosine distance."""
    x = _l2(embeddings)
    # Need at least k+1 samples for a meaningful silhouette.
    k_max = max(k_min, min(k_max, len(x) - 1))
    scores: dict[int, float] = {}
    for k in range(k_min, k_max + 1):
        labels = KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(x)
        if len(set(labels)) < 2:
            continue
        scores[k] = float(silhouette_score(x, labels, metric="cosine"))
    if not scores:
        return k_min, {}
    return max(scores, key=scores.get), scores


def cluster(
    embeddings: np.ndarray, k: int | None = None, seed: int = 42
) -> tuple[np.ndarray, int, dict[int, float]]:
    """Return (labels, k_used, silhouette_by_k)."""
    x = _l2(embeddings)
    scores: dict[int, float] = {}
    if k is None:
        k, scores = choose_k(embeddings, seed=seed)
    k = max(2, min(k, len(x) - 1))
    labels = KMeans(n_clusters=k, n_init=10, random_state=seed).fit_predict(x)
    return labels, k, scores


def keywords_per_cluster(
    documents: list[str],
    labels: np.ndarray,
    app_name: str = "",
    top_n: int = 6,
) -> dict[int, list[str]]:
    """Top TF-IDF terms per cluster, with the app's own name filtered out.

    The app name appears in a large share of its own reviews, so left in it
    would win every cluster's keyword list and describe nothing.
    """
    stop = set(TfidfVectorizer(stop_words="english").get_stop_words() or [])
    stop |= EXTRA_STOPWORDS
    stop |= {w for w in re.split(r"[^a-z0-9]+", app_name.lower()) if w}

    vec = TfidfVectorizer(
        stop_words=list(stop),
        ngram_range=(1, 2),
        min_df=2,
        max_df=0.6,
        max_features=5000,
        sublinear_tf=True,
    )
    try:
        matrix = vec.fit_transform(documents)
    except ValueError:
        return {int(c): [] for c in set(labels.tolist())}

    terms = np.asarray(vec.get_feature_names_out())
    out: dict[int, list[str]] = {}
    for c in sorted(set(labels.tolist())):
        rows = matrix[labels == c]
        if rows.shape[0] == 0:
            out[int(c)] = []
            continue
        mean = np.asarray(rows.mean(axis=0)).ravel()
        top = mean.argsort()[::-1]
        picked: list[str] = []
        for i in top:
            if mean[i] <= 0:
                break
            term = terms[i]
            # Drop a unigram already covered by a chosen bigram, and vice versa.
            if any(term in p or p in term for p in picked):
                continue
            picked.append(term)
            if len(picked) == top_n:
                break
        out[int(c)] = picked
    return out


def representative_reviews(
    embeddings: np.ndarray, labels: np.ndarray, cluster_id: int, limit: int
) -> list[int]:
    """Indices of the reviews closest to a cluster's centroid, nearest first.

    Sending Claude the centre of a cluster rather than a random slice keeps the
    sample on-theme when a cluster is larger than the prompt budget.
    """
    x = _l2(embeddings)
    members = np.where(labels == cluster_id)[0]
    if len(members) == 0:
        return []
    centroid = x[members].mean(axis=0)
    centroid /= max(float(np.linalg.norm(centroid)), 1e-12)
    sims = x[members] @ centroid
    return [int(members[i]) for i in np.argsort(sims)[::-1][:limit]]
