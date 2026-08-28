# `deploy/` — reference deployment

The single definition of how GeoARK is built and run. Fixes the "models reload
on every start" problem. Design rationale is in
[../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Layout

| File | Purpose |
|---|---|
| `docker-compose.yml` | Five services: `web`, `api`, `embedder`, `ollama`, `db`; plus optional `automl` and a one-shot `model-init` |
| `docker-compose.dev.yml` | Override that bind-mounts source for live reload on the server |
| `api.Dockerfile` | Node-only image (~200 MB). No Python, no torch |
| `web.Dockerfile` | Vite build → nginx |
| `embedder/` | FastAPI service that loads the embedding model **once** |
| `db/` | PostGIS + pgvector, with schema bootstrap in `db/init/` |
| `automl.Dockerfile` | AutoGluon service (~4 GB, behind the `automl` profile) |
| `Makefile` | `make up`, `make models`, `make health`, `make reindex`, … |

## First run

```bash
cd deploy && cp .env.example .env
```

Edit `.env` (only `POSTGRES_PASSWORD` is required), then:

```bash
make up
```

The embedder's first start downloads the model into the `hf_cache` volume and
embeds the catalog into `emb_cache`; give it a few minutes and watch with
`make logs`. Then warm the LLM volume once:

```bash
make models
```

Every start after that is warm. `make down && make up` does **not** re-download
anything — that is the whole point of the named volumes.

Once the caches are warm, set `HF_HUB_OFFLINE=1` in `.env` so the embedder can
never block on a call to huggingface.co.

## How the pieces talk

```
web ──/api/──► api ──HTTP──► embedder      model resident; owns the corpus matrix
                 └──HTTP──► ollama         weights on a volume
                 └──pg────► db             PostGIS + pgvector
web ──/automl/─► automl                    optional profile
```

The API no longer spawns Python. At startup it waits for the embedder, pulls the
whole corpus (vectors + preprocessed text + metadata) in one call, and asserts
the row count matches the CSV it loaded — a misalignment there would return
wrong results for every query, so it fails loudly instead.

Per-query, `generateEmbeddings()` is one HTTP round trip to a process that
already has the model in memory.

### Things worth knowing

- **The embedder owns preprocessing.** `embedding_text()` in
  `embedder/app.py` must stay in lockstep with `createEmbeddingText()` in
  `backend/unified_search_server.js` — the Node side scores keyword overlap
  against text the embedder produced. If you change one, change both.
- **NLTK WordNet is downloaded at image build time**, not at runtime, so the
  container never reaches for the network mid-request.
- **`PREPROC_VERSION`** in `embedder/app.py` is part of the cache key. Bump it
  whenever preprocessing changes, or you will silently serve stale vectors.
- **`make down` does not delete volumes.** `make clean` does, and will make the
  next start re-download everything. It asks first.

## Useful commands

```bash
make health
```

```bash
make reindex
```

```bash
make automl
```

```bash
ssh -N -L 8080:localhost:8080 -L 11434:localhost:11434 -L 5432:localhost:5432 you@server
```
