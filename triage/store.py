"""Step 2: embed reviews and persist them in ChromaDB.

Chroma's default embedding function (all-MiniLM-L6-v2, 384-dim, ONNX) runs
locally, so the only API key this project needs is for step 4.
"""
from __future__ import annotations

import numpy as np
import chromadb

from .config import CHROMA_DIR, ensure_dirs
from .models import Review

BATCH = 100


def collection_name(slug: str) -> str:
    # Chroma requires 3-512 chars of [a-zA-Z0-9._-], starting/ending alphanumeric.
    return f"reviews-{slug}"[:512]


def client() -> chromadb.ClientAPI:
    ensure_dirs()
    return chromadb.PersistentClient(path=str(CHROMA_DIR))


def document_for(r: Review) -> str:
    """Embedding text. iOS titles carry real signal ("Crashes on login"), so keep them."""
    if r.title and r.title.lower() not in r.text.lower():
        return f"{r.title}. {r.text}"
    return r.text


def embed_reviews(
    slug: str, reviews: list[Review], reset: bool = False, progress=None
) -> tuple[list[str], np.ndarray, list[str], list[dict]]:
    """Upsert ``reviews`` into Chroma and return everything the clusterer needs.

    Upsert (not add) keeps re-runs idempotent, so re-scraping an app that shares
    reviews with a previous run does not duplicate vectors.
    """
    c = client()
    name = collection_name(slug)
    if reset:
        try:
            c.delete_collection(name)
        except Exception:
            pass  # nothing to delete on a first run

    col = c.get_or_create_collection(name=name, metadata={"hnsw:space": "cosine"})

    for i in range(0, len(reviews), BATCH):
        chunk = reviews[i : i + BATCH]
        col.upsert(
            ids=[r.review_id for r in chunk],
            documents=[document_for(r) for r in chunk],
            metadatas=[
                {
                    "platform": r.platform,
                    "rating": r.rating,
                    "ts": r.ts,
                    "date": r.date,
                    "app_version": r.app_version or "",
                    "country": r.country or "",
                    "helpful": r.helpful,
                }
                for r in chunk
            ],
        )
        if progress:
            progress(min(i + BATCH, len(reviews)), len(reviews))

    # Read back in a deterministic order so ids line up with the embedding matrix.
    wanted = [r.review_id for r in reviews]
    got = col.get(ids=wanted, include=["embeddings", "documents", "metadatas"])
    order = {rid: i for i, rid in enumerate(got["ids"])}
    idx = [order[rid] for rid in wanted if rid in order]

    ids = [got["ids"][i] for i in idx]
    embeddings = np.asarray([got["embeddings"][i] for i in idx], dtype=np.float32)
    documents = [got["documents"][i] for i in idx]
    metadatas = [got["metadatas"][i] for i in idx]
    return ids, embeddings, documents, metadatas
