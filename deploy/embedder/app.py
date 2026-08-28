"""
GeoARK embedding service.

The point of this file is the module-level line that loads the model ONCE, at
process start. The Node backend used to spawn `python3` per call, so every
search query paid a full SentenceTransformer construction (2-6 s) and every
restart re-embedded the whole catalog. Here the model load is paid once per
container lifetime, the corpus matrix is cached to a volume, and a query embed
is ~20 ms.

This service owns catalog preprocessing. `embedding_text()` below must stay in
lockstep with `createEmbeddingText()` in backend/unified_search_server.js.

Endpoints
---------
GET  /health           readiness; used by the compose healthcheck and by the
                       API's waitForEmbedder()
POST /embed            {"texts": [...], "is_query": false}
                       -> {"embeddings", "processed_texts", "dimension"}
POST /corpus           build, or load from cache, the full catalog matrix
                       (?force=true to re-embed)
GET  /corpus/vectors   hand the whole corpus to the API at its startup
POST /search           cosine top-k against the cached corpus

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embedder")

MODEL_NAME = os.environ.get("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
CACHE_DIR = Path(os.environ.get("EMBED_CACHE_DIR", "/data/embeddings"))
CSV_PATH = Path(os.environ.get("CATALOG_CSV", "/data/geoark_attributes.csv"))

# BGE wants this prefix on the query side only. Keeps parity with the behaviour
# in unified_search_server.js.
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

# Bump when preprocessing changes, so cached matrices invalidate themselves.
PREPROC_VERSION = "v2"   # v2: added temporal range to embedding text

CACHE_DIR.mkdir(parents=True, exist_ok=True)

log.info("loading %s ...", MODEL_NAME)
MODEL = SentenceTransformer(MODEL_NAME)          # <-- loaded once, for the life of the process
DIM = MODEL.get_sentence_embedding_dimension()
log.info("model ready, dim=%d", DIM)

_corpus: dict[str, object] = {"matrix": None, "meta": None, "processed": None, "key": None}

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load the corpus at boot so the first user query isn't the one that pays."""
    try:
        log.info("warm start: %s", build_corpus())
    except Exception as exc:                                   # non-fatal
        log.warning("corpus warm-up skipped: %s", exc)
    yield


app = FastAPI(title="GeoARK embedder", version="1.0.0", lifespan=lifespan)


# --------------------------------------------------------------------------- #
# preprocessing
# --------------------------------------------------------------------------- #

_PUNCT = re.compile(r"[|\"()\[\]{}/,]")

# The original spawn-per-call script lemmatized with NLTK WordNet, and BOTH the
# corpus embeddings and the Node-side keyword scores are built from the result.
# Dropping it would quietly change retrieval, so it is preserved here. The
# corpus is downloaded at image BUILD time (see Dockerfile) so nothing reaches
# for the network at runtime; if it is somehow absent we degrade to identity
# rather than crash or download.
try:
    from nltk.stem import WordNetLemmatizer

    _LEMMATIZER = WordNetLemmatizer()
    _LEMMATIZER.lemmatize("tests")          # force the corpus load now, not mid-request
except Exception as _exc:                    # pragma: no cover
    _LEMMATIZER = None
    logging.getLogger("embedder").warning(
        "WordNet unavailable (%s); continuing without lemmatization", _exc)


def _lemmatize(words: list[str]) -> list[str]:
    if _LEMMATIZER is None:
        return words
    return [_LEMMATIZER.lemmatize(w) for w in words]


def embedding_text(row: dict) -> str:
    """
    Build the string that gets embedded for one catalog row.

    This MUST stay in lockstep with createEmbeddingText() in
    unified_search_server.js: the Node side scores keyword overlap against the
    same text, so a divergence here silently degrades hybrid search.
    """
    parts: list[str] = []
    for key in ("dataset_clean", "source_folder", "attr_desc"):
        if row.get(key):
            parts.append(row[key].strip())
    if row.get("attr_orig"):
        parts.append(row["attr_orig"].replace("_", " ").strip())
    if row.get("tags"):
        parts += [t.strip() for t in re.sub(r"[\[\]'\"]", "", row["tags"]).split(",") if t.strip()]
    if row.get("entity_type"):
        parts.append(row["entity_type"].strip())

    # Temporal range in words -- users ask for "2015" or "recent" data, and
    # without this the years are invisible to both the embedding and BM25.
    start, end = (row.get("start_date") or "").strip(), (row.get("end_date") or "").strip()
    if start and end and start != end:
        parts.append(f"{start} to {end}")
    elif start:
        parts.append(start)

    return " ".join(parts).lower()


def clean(text: str) -> str:
    """Normalize + lemmatize. Applied identically to corpus text and queries."""
    return " ".join(_lemmatize(_PUNCT.sub(" ", text).lower().split()))


@lru_cache(maxsize=4096)
def _embed_one_cached(text: str, is_query: bool) -> tuple[float, ...]:
    """Query embeddings repeat constantly; caching them makes repeats free."""
    prepared = (QUERY_PREFIX + clean(text)) if is_query else clean(text)
    return tuple(MODEL.encode([prepared], normalize_embeddings=True)[0].tolist())


def embed(texts: list[str], is_query: bool = False) -> np.ndarray:
    if is_query:      # queries are few and repetitive -> per-text cache
        return np.array([_embed_one_cached(t, True) for t in texts], dtype=np.float32)
    prepared = [clean(t) for t in texts]
    return MODEL.encode(
        prepared, normalize_embeddings=True, batch_size=64, show_progress_bar=False
    ).astype(np.float32)


def cache_key(payload: bytes) -> str:
    """Content hash over data + model + preprocessing: self-invalidating."""
    h = hashlib.sha256()
    h.update(payload)
    h.update(MODEL_NAME.encode())
    h.update(PREPROC_VERSION.encode())
    return h.hexdigest()[:16]


# --------------------------------------------------------------------------- #
# schemas
# --------------------------------------------------------------------------- #

class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1)
    is_query: bool = False


class SearchRequest(BaseModel):
    query: str
    top_k: int = 20


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "dimension": DIM,
        "corpus_loaded": _corpus["matrix"] is not None,
        "corpus_rows": 0 if _corpus["matrix"] is None else int(len(_corpus["matrix"])),
    }


@app.post("/embed")
def embed_endpoint(req: EmbedRequest):
    vectors = embed(req.texts, req.is_query)
    return {
        "embeddings": vectors.tolist(),
        # The caller keyword-matches this against the corpus's processed text,
        # so it is the cleaned form WITHOUT the BGE query prefix.
        "processed_texts": [clean(t) for t in req.texts],
        "dimension": DIM,
    }


@app.post("/corpus")
def build_corpus(force: bool = False):
    """
    Build the catalog embedding matrix, or load it from disk if the CSV, model,
    and preprocessing are unchanged. This is what turns a multi-minute cold
    start into a sub-second one.
    """
    if not CSV_PATH.exists():
        raise HTTPException(404, f"catalog CSV not found at {CSV_PATH}")

    import csv

    raw = CSV_PATH.read_bytes()
    key = cache_key(raw)
    npy = CACHE_DIR / f"{key}.npy"

    rows: list[dict] = []
    with CSV_PATH.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            rows.append({
                # Identity / display fields the API returns to the frontend.
                "dataset_id": row.get("dataset_id", ""),
                "dataset_clean": row.get("dataset_clean", ""),
                "table_name": row.get("table_name", ""),
                "attr_id": row.get("attr_label", ""),
                "attr_orig": row.get("attr_orig", ""),
                "attr_desc": row.get("attr_desc", ""),
                "source_folder": row.get("source_folder", ""),
                "tags": row.get("tags", ""),
                "entity_type": row.get("entity_type", ""),
                "spatial_rep": row.get("spatial_rep", ""),
                "start_date": row.get("start_date", ""),
                "end_date": row.get("end_date", ""),
                "text": embedding_text(row),
            })

    texts = [r["text"] for r in rows]
    processed = [clean(t) for t in texts]

    if npy.exists() and not force:
        matrix = np.load(npy)
        cached = True
        log.info("loaded %d cached embeddings from %s", len(matrix), npy.name)
    else:
        matrix, cached = None, False

    # A stale cache (CSV edited without a hash change is impossible, but a
    # truncated write is not) must never silently misalign vectors with rows.
    if matrix is None or len(matrix) != len(rows):
        if matrix is not None:
            log.warning("cache had %d rows, CSV has %d - re-embedding",
                        len(matrix), len(rows))
        log.info("embedding %d catalog rows (first run for this CSV+model)...", len(rows))
        matrix = embed(texts)
        np.save(npy, matrix)
        cached = False
        log.info("wrote %s", npy.name)

    _corpus.update(matrix=matrix, meta=rows, processed=processed, key=key)
    return {"rows": len(rows), "dimension": DIM, "cache_key": key, "from_cache": cached}


@app.get("/corpus/vectors")
def corpus_vectors():
    """
    Hand the whole corpus to the Node API at its startup: vectors, the
    preprocessed text (which Node needs for keyword scoring), and row metadata.

    Row order here is authoritative and matches the CSV, so Node can index
    straight into these arrays. ~20 MB of JSON, fetched once per API start.
    """
    if _corpus["matrix"] is None:
        build_corpus()
    return {
        "count": len(_corpus["matrix"]),
        "dimension": DIM,
        "model": MODEL_NAME,
        "cache_key": _corpus["key"],
        "embeddings": _corpus["matrix"].tolist(),
        "processed_texts": _corpus["processed"],
        "meta": [{k: v for k, v in r.items() if k != "text"} for r in _corpus["meta"]],
    }


@app.post("/search")
def search(req: SearchRequest):
    if _corpus["matrix"] is None:
        build_corpus()

    matrix, meta = _corpus["matrix"], _corpus["meta"]
    q = embed([req.query], is_query=True)[0]

    # Vectors are L2-normalized, so a dot product IS cosine similarity, and one
    # numpy matmul replaces the per-row JavaScript cosine loop.
    scores = matrix @ q

    k = min(req.top_k, len(scores))
    idx = np.argpartition(-scores, k - 1)[:k]
    idx = idx[np.argsort(-scores[idx])]

    return {
        "query": req.query,
        "results": [
            {**{k_: v for k_, v in meta[i].items() if k_ != "text"},
             "similarity": round(float(scores[i]), 4)}
            for i in idx
        ],
    }
