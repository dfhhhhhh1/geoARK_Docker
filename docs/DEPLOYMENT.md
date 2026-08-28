# Deployment

Target: a single self-hosted Linux server reached over SSH, running the whole
stack in Docker Compose. Nothing calls out to a cloud API.

---

> **Status:** implemented. `deploy/` contains the working stack described here.
> This section explains *why* it is shaped this way; [`deploy/README.md`](../deploy/README.md)
> is the operational guide.

## 1. The problem this solved

Before Phase 1, every container start:

1. downloads `BAAI/bge-base-en-v1.5` (~440 MB) from Hugging Face, because the
   cache lives in the container's ephemeral filesystem;
2. embeds all 6,860 catalog rows from scratch (minutes of CPU);
3. and then **reloaded the model again on every single search query**, because
   `generateEmbeddings()` spawned a fresh `python3` process per call.

Separately, Ollama's LLM weights (2–9 GB) live wherever Ollama happens to be
installed and are not part of the deployment at all.

The fix has three independent parts, and you need all three:

| Part | Fixes | How |
|---|---|---|
| **A. Persist model weights** | re-downloading | named volumes / bind mounts / baking into the image |
| **B. Keep the model in memory** | reloading per query | replace the per-call subprocess with a long-lived embedding service |
| **C. Persist computed embeddings** | re-embedding the corpus | write the 6,860 × 768 matrix to disk, keyed by a content hash |

Volumes are part A, and they are the right answer for it — but on their own they
only take startup from ~4 minutes to ~3 minutes, because parts B and C are where
the time actually goes. All three are now implemented:

- **A** — `hf_cache` and `ollama_models` named volumes.
- **B** — `deploy/embedder/app.py`, a FastAPI service that constructs the
  `SentenceTransformer` once at process start. The API calls it over HTTP.
- **C** — the corpus matrix is cached to the `emb_cache` volume, keyed by
  `sha256(csv + model + preprocessing_version)` so it self-invalidates.

## 2. Where model weights should live — the options

### Option A — named volume for the Hugging Face cache *(recommended for the embedder)*

```yaml
services:
  embedder:
    environment:
      HF_HOME: /models/hf          # modern var; supersedes TRANSFORMERS_CACHE
    volumes:
      - hf_cache:/models/hf
volumes:
  hf_cache:
```

Survives `docker compose down`, image rebuilds, and code changes. Docker manages
the storage. First run downloads; every run after that is instant. Once warm,
set `HF_HUB_OFFLINE=1` so a network blip can't stall startup with a hub call.

**Use this.** It is the lowest-friction option and matches what you proposed.

### Option B — bake the model into the image

```dockerfile
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('BAAI/bge-base-en-v1.5')"
```

Fully hermetic: the image runs on an air-gapped box, and there is no first-run
download at all. Costs ~500 MB of image size, and changing models means a
rebuild + re-push.

Worth it for the *embedding* model if you ever need reproducible images or want
to deploy to a second machine. Not worth it for multi-GB LLMs.

### Option C — a dedicated model-server container *(recommended for the LLM)*

Ollama already is this. Run it as a compose service with its own volume:

```yaml
  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_models:/root/.ollama
    environment:
      OLLAMA_KEEP_ALIVE: "-1"        # never unload; no cold start per request
      OLLAMA_MAX_LOADED_MODELS: "2"  # keep the small router + the planner resident
```

The app containers stay small and stateless; weights live in one place; you can
restart the API twenty times while iterating without touching the LLM.

For embeddings the equivalent is Hugging Face's
`ghcr.io/huggingface/text-embeddings-inference:cpu-1.5`, which serves BGE over
HTTP with no Python of your own. That is the eventual right answer — it is
faster than sentence-transformers and there is no code to maintain. Start with
the small FastAPI sidecar in `deploy/embedder/` (it preserves your lemmatization
and the BGE query prefix), and swap in TEI once the interface is stable.

### Option D — a shared host directory, bind-mounted read-only

```yaml
    volumes:
      - /srv/models:/models:ro
```

Good when several projects on the same SSH box need the same weights, or when
you want to `scp`/`rsync` model files in out-of-band rather than pulling from
the internet on the server. Downside: you manage the directory yourself, and
permissions bite you (the container user needs read access).

Use this **in addition to** A if disk on the server is tight and you want one
copy of the weights shared across projects.

### Recommendation

- **LLM weights** → Option C (Ollama service + `ollama_models` named volume).
- **Embedding weights** → Option A (named `hf_cache` volume). Add Option B later
  if you need reproducible images.
- **Computed corpus embeddings** → not a model at all; see §3.

## 3. Persisting the computed embeddings (part C — the big win)

Even with warm model weights, the backend re-encodes 6,860 rows at every boot.
It should not. Two levels:

### Level 1 — cache to disk *(done)*

Implemented in `deploy/embedder/app.py`. Key the cache on `sha256(csv_bytes + model_name + preprocessing_version)`. On
start, if `/data/embeddings/<hash>.npy` exists, `np.load` it; otherwise encode
and write it. Mount `/data` as a volume. Startup drops from minutes to under a
second, and the cache invalidates itself automatically when the catalog changes.

### Level 2 — move embeddings into Postgres with pgvector *(Phase 2)*

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE attribute_embeddings (
    attr_id    TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL,
    label      TEXT,
    description TEXT,
    tags       TEXT[],
    entity_type TEXT,
    embedding  vector(768),
    tsv        tsvector GENERATED ALWAYS AS (
                 to_tsvector('english', coalesce(label,'') || ' ' || coalesce(description,''))
               ) STORED
);

CREATE INDEX ON attribute_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON attribute_embeddings USING gin  (tsv);
```

Now search is one SQL query instead of 6,860 JavaScript cosine loops, the
backend holds no state, it starts instantly, and you get keyword search from
the same index — replacing the hand-rolled 0.7/0.3 score blend with a proper
fusion. This is the target; Level 1 is the stepping stone you can ship today.

The stock `postgis/postgis` image does not include pgvector, so `deploy/db/Dockerfile`
builds a one-line image on top of it. The schema above is already created at
first boot by `deploy/db/init/01-extensions.sql`; nothing populates it yet.

## 4. The compose topology

This is what [`deploy/`](../deploy) implements. It replaced the original
two-service `docker-compose.yml`, which is now deleted (recoverable from git
history) so that there is exactly one definition of how this is built.

```
        host :8080                     host :11434 (optional, for debugging)
            │                                  │
┌───────────▼────────────┐          ┌──────────▼──────────┐
│ web    nginx + SPA     │          │ ollama              │
│                        │          │  volume: ollama_models│
└───────────┬────────────┘          └──────────▲──────────┘
            │ /api/ →                          │ OLLAMA_HOST
┌───────────▼────────────┐                     │
│ api    Node 20         ├─────────────────────┘
│  no Python at all      │
└─────┬──────────────┬───┘
      │              │
      │              └──────────────┐
┌─────▼──────────────┐    ┌─────────▼─────────────┐
│ embedder  FastAPI  │    │ db   PostGIS+pgvector │
│  volume: hf_cache  │    │  volume: pgdata       │
│  volume: emb_cache │    └───────────────────────┘
└────────────────────┘
```

Four changes from the original two-service compose, each of which matters:

1. **Python leaves the Node image.** The `api` image becomes `node:20-slim`,
   ~200 MB instead of ~3 GB. Backend code changes rebuild in seconds.
2. **The embedder is a long-lived HTTP service.** The model is constructed once
   at process start, not once per query. `POST /embed` returns in ~20 ms instead
   of ~4 s.
3. **Ollama and Postgres are services**, addressed by DNS name (`http://ollama:11434`,
   `db:5432`) rather than `127.0.0.1`.
4. **Every heavy artifact sits on a named volume** — weights, HF cache, computed
   embeddings, database.

### Running it

```bash
cd deploy && cp .env.example .env && docker compose up -d --build
```

Warm the model volumes once (safe to re-run; it is a no-op when warm):

```bash
cd deploy && docker compose --profile setup run --rm model-init
```

Check everything is up:

```bash
cd deploy && docker compose ps && curl -s localhost:8080/api/health | jq
```

## 5. Working over SSH

The stack binds only `web` to a host port. Don't expose 4000/11434/5432
publicly — tunnel them when you need to poke at them:

```bash
ssh -N -L 8080:localhost:8080 -L 11434:localhost:11434 -L 5432:localhost:5432 you@server
```

Then `http://localhost:8080` in your local browser hits the deployed app.

For iterating on the server without waiting on rebuilds, mount the source and
run the dev command — a compose override is the clean way:

```bash
cd deploy && docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

Long builds should not die when your SSH session drops. Either run them under
`tmux`, or use `systemd-run --user --scope`:

```bash
tmux new -s geoark
```

### Build speed on a remote box

Add BuildKit cache mounts so pip and npm don't re-download on every rebuild:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
```

And keep a `.dockerignore` — right now there isn't one, so `COPY . .` ships
`node_modules/`, `.env`, and `nohup.out` into every image, and any change to any
of them busts the cache.

## 6. Local development without Docker

Four processes. From the repo root:

```bash
ollama serve && ollama pull gemma3:4b
```

```bash
cd deploy/embedder && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && CATALOG_CSV=../../backend/geoark_attributes.csv EMBED_CACHE_DIR=/tmp/geoark-emb uvicorn app:app --port 8000
```

```bash
cd backend && npm install && npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

The API defaults to `http://localhost:8000` for the embedder and
`http://localhost:11434` for Ollama, so no configuration is needed. The Vite dev
server proxies `/api` and `/automl` (see `frontend/vite.config.ts`), so the same
relative URLs work in dev and in Docker.

PostGIS is optional locally — the API logs `PostGIS connection failed` and keeps
running; only `/api/get-data` needs it.

## 7. Sizing

See [`etl/PROVENANCE.md`](../etl/PROVENANCE.md) for GPU, ARM, and low-RAM
profiles, and for why switching hardware requires one `make reindex`.

| Service | RAM | Disk | Notes |
|---|---|---|---|
| `ollama` + `gemma3:4b` | ~4 GB | ~3.3 GB | with `OLLAMA_KEEP_ALIVE=-1` it stays resident |
| `ollama` + a 14B planner | ~10 GB | ~9 GB | only if you add a second, larger model |
| `embedder` (bge-base) | ~1.5 GB | ~0.5 GB | CPU inference is fine at this corpus size |
| `db` (PostGIS) | ~1 GB | 3.5 GB+ | the HSIP source data is 3.5 GB before import |
| `api` + `web` | ~0.3 GB | ~0.3 GB | |

Comfortable floor: **16 GB RAM, 60 GB disk**. This is not advisory — it was
measured. On a host giving Docker 7.65 GB, `ollama` with `gemma3:4b` and
`OLLAMA_KEEP_ALIVE=-1` sits at **5.5 GB (72% of the budget)**, and a sustained
32-query evaluation run produced an OOM kill of the model runner.

If you have under ~16 GB, set `OLLAMA_KEEP_ALIVE=30m` in `.env`. Idle memory is
then reclaimed, at the cost of a ~10 s model reload on the next cold request.
`OLLAMA_MAX_LOADED_MODELS` now defaults to 1 for the same reason; raise it only
when the Phase 3 router/planner split actually needs two resident models. If the server has an NVIDIA GPU,
add `gpus: all` to the `ollama` service and use the CUDA base for `embedder`;
CPU is adequate for the embedder either way at 4.5k rows.
