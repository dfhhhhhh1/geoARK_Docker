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
import json
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

# Tags are ~38% of all embedded text, and ~56% for facility rows whose
# attr_desc is just "Name"/"Address". They are also the least reproducible part
# of the catalog -- LLM-generated, and the generator was lost. This flag exists
# to MEASURE that exposure, not as a normal operating mode.
INCLUDE_TAGS = os.environ.get("EMBED_INCLUDE_TAGS", "1") not in ("0", "false", "False")

CACHE_DIR.mkdir(parents=True, exist_ok=True)

log.info("loading %s ...", MODEL_NAME)
MODEL = SentenceTransformer(MODEL_NAME)          # <-- loaded once, for the life of the process
DIM = MODEL.get_sentence_embedding_dimension()
log.info("model ready, dim=%d", DIM)

_corpus: dict[str, object] = {"matrix": None, "meta": None, "processed": None, "key": None}

# --------------------------------------------------------------------------- #
# provenance
# --------------------------------------------------------------------------- #
#
# The cache key covers the CSV, the model NAME, and the preprocessing version.
# It cannot see the things that silently change vectors underneath a stable
# name: a different sentence-transformers or torch build, CPU vs GPU kernels,
# a re-uploaded model revision, a different accelerator's float behaviour.
#
# Any of those produces a DIFFERENT VECTOR SPACE while every version string
# still matches -- and the failure is silent, because search keeps returning
# plausible-looking results that are quietly worse.
#
# So instead of trying to enumerate the causes, measure the effect: embed a
# fixed canary sentence and fingerprint the vector. If the fingerprint moves,
# the vector space moved, whatever the reason.

CANARY = "poverty rate by county in the united states"


def _torch_info() -> dict:
    try:
        import torch
        return {
            "torch": torch.__version__,
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "cuda": torch.version.cuda if torch.cuda.is_available() else None,
        }
    except Exception:
        return {"torch": None, "device": "unknown", "cuda": None}


def fingerprint() -> str:
    """
    Hash of the canary embedding, rounded before hashing.

    The rounding is deliberate: tiny last-bit differences between runs on the
    same setup are normal floating-point noise and must not look like drift,
    while a real model or precision change moves values far more than 1e-5.
    """
    vec = MODEL.encode([CANARY], normalize_embeddings=True)[0]
    quantized = ",".join(f"{v:.5f}" for v in vec)
    return hashlib.sha256(quantized.encode()).hexdigest()[:16]


def provenance() -> dict:
    import sentence_transformers
    info = {
        "embed_model": MODEL_NAME,
        "dimension": DIM,
        "preproc_version": PREPROC_VERSION,
        "include_tags": INCLUDE_TAGS,
        "lemmatizer": _LEMMATIZER is not None,
        "sentence_transformers": sentence_transformers.__version__,
        **_torch_info(),
        "canary_fingerprint": fingerprint(),
    }
    return info

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
    if INCLUDE_TAGS and row.get("tags"):
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
    h.update(b"tags=1" if INCLUDE_TAGS else b"tags=0")
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

@app.get("/provenance")
def provenance_endpoint():
    """What produced the current vectors, and whether the cache still matches."""
    return {**provenance(), "drift": _corpus.get("drift") is not None,
            "drift_detail": _corpus.get("drift")}


@app.get("/health")
def health():
    return {
        "status": "ok",
        "drift": _corpus.get("drift") is not None,
        "model": MODEL_NAME,
        "dimension": DIM,
        "corpus_loaded": _corpus["matrix"] is not None,
        "corpus_rows": 0 if _corpus["matrix"] is None else int(len(_corpus["matrix"])),
        # Consumers cache these vectors; the key lets them detect a re-embed.
        "cache_key": _corpus.get("key"),
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

    manifest_path = CACHE_DIR / f"{key}.json"

    if npy.exists() and not force:
        matrix = np.load(npy)
        cached = True
        log.info("loaded %d cached embeddings from %s", len(matrix), npy.name)

        # Drift check. Reusing a cached matrix built by a different vector space
        # is the one failure that produces no error and no visible symptom --
        # just quietly worse retrieval -- so it is checked on every load.
        if manifest_path.exists():
            try:
                stored = json.loads(manifest_path.read_text())
                current = provenance()
                if stored.get("canary_fingerprint") != current["canary_fingerprint"]:
                    log.error(
                        "EMBEDDING DRIFT: cached vectors were built by a different "
                        "vector space (fingerprint %s, now %s). Stored env: %s. "
                        "Current: %s. Re-embed with POST /corpus?force=true, or these "
                        "vectors and new query embeddings are not comparable.",
                        stored.get("canary_fingerprint"), current["canary_fingerprint"],
                        {k: stored.get(k) for k in ("torch", "device", "sentence_transformers")},
                        {k: current.get(k) for k in ("torch", "device", "sentence_transformers")})
                    _corpus["drift"] = {"stored": stored, "current": current}
                else:
                    _corpus["drift"] = None
            except Exception as exc:
                log.warning("could not verify cache provenance: %s", exc)
        else:
            # A cache written before provenance tracking existed. Backfill from
            # the current environment so drift is detectable from here on. This
            # assumes the current environment built it -- true for an in-place
            # upgrade, and the only assumption available.
            manifest_path.write_text(json.dumps(
                {**provenance(), "rows": len(matrix), "cache_key": key,
                 "backfilled": True}, indent=2))
            log.info("backfilled provenance manifest for %s", npy.name)
            _corpus["drift"] = None
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
        manifest_path.write_text(json.dumps(
            {**provenance(), "rows": len(rows), "cache_key": key}, indent=2))
        cached = False
        _corpus["drift"] = None
        log.info("wrote %s (+ manifest)", npy.name)

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
