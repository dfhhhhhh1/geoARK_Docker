# GeoARK

**Geospatial analysis from natural-language queries.**

GeoARK lets a user type a question like *"show me poverty rates normalized by
population for counties near Superfund sites"* and get back the relevant
variables, an analysis plan, and a map/report — without writing SQL or PostGIS
by hand.

Everything runs on local infrastructure. No query text or dataset content
leaves the machine: embeddings come from a local sentence-transformers model,
reasoning from a local LLM served by Ollama.

---

## Quick start

Server (Docker, the normal path):

```bash
cd deploy && cp .env.example .env && make up && make models
```

Then open `http://localhost:8080` — or tunnel it from your laptop:

```bash
ssh -N -L 8080:localhost:8080 you@server
```

First start downloads the embedding model and embeds the catalog; every start
after that is warm because both live on Docker volumes. See
[deploy/README.md](deploy/README.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

Local development without Docker needs Ollama, Postgres/PostGIS, the embedder,
and the two app processes — [docs/DEPLOYMENT.md §7](docs/DEPLOYMENT.md) has the steps.

## Layout

| Path | What it is |
|---|---|
| [`backend/`](backend) | Node/Express API. `unified_search_server.js` is the entrypoint |
| [`frontend/`](frontend) | React 19 + Vite + Tailwind SPA, served by nginx in production |
| [`deploy/`](deploy) | The single source of truth for how this is built and run |
| [`etl/`](etl) | `geospatial_etl.py` — shapefile/GDB/CSV → PostGIS ingestion |
| [`docs/`](docs) | Architecture, deployment, AI pipeline design, roadmap |
| [`backend/legacy/`](backend/legacy) | Superseded servers kept for reference only |

## Services

| Service | Port | Role |
|---|---|---|
| `web` | 8080 → 80 | nginx; serves the SPA and proxies `/api/` and `/automl/` |
| `api` | 4000 | Node. Query decomposition, hybrid search, PostGIS access |
| `embedder` | 8000 | FastAPI. Holds the BGE model in memory; owns the catalog matrix |
| `ollama` | 11434 | Local LLM |
| `db` | 5432 | PostGIS + pgvector |
| `automl` | 8000 | AutoGluon (optional — `make automl`) |
| `etl` | — | One-shot loader job (`make load-reference`) |

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit, and what is still missing
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — Docker, model volumes, working over SSH
- **[docs/AI-PIPELINE.md](docs/AI-PIPELINE.md)** — the NL → analysis-plan design
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — phased plan; Phases 0 and 1 are done
- **[docs/ENHANCED_SEARCH.md](docs/ENHANCED_SEARCH.md)** — multi-agent search design notes

## Data

The ~3.5 GB of source geodata (HSIP/HIFLD shapefiles, geodatabases, ACS CSVs)
lives **outside this repository** and is deliberately gitignored. `etl/geospatial_etl.py`
ingests it into PostGIS. The variable catalog it searches over,
`backend/geoark_attributes.csv` (6,860 rows), is small enough to track and is
committed.

## Status

**Search** (`POST /api/unified-search`) — query decomposition, hybrid BGE + BM25
retrieval fused with RRF, over a 6,860-row variable catalog. Measured 97.8%
concept recall / 97.3% query success on a 37-query suite, p50 3.2s.

**Analysis** (`POST /api/analyze`) — natural language to executed results. The
model emits a typed plan over seven operations; a deterministic compiler turns
it into parameterized PostGIS SQL and runs it read-only. 3,596 of 6,860 catalog
attributes (52.4%) resolve to physical columns; the rest are facility datasets
whose shapefiles are not loaded yet.

Honest limits:

- **Plan quality is the bottleneck, not the plumbing.** On the hardest eval
  suite, 62.5% of queries yield a valid plan that executes and returns rows.
  With `gemma3:4b` the plans are well-formed and grounded but often semantically
  wrong. `PLAN_MODEL` routes planning to a larger model; that is the next thing
  to try.
- **`/api/analyze` needs `make load-reference` first**, or it returns 422.
- The cross-encoder reranker and the MCP tool server are not built.

Run `python3 eval/run.py` to reproduce any of these numbers — see
[eval/README.md](eval/README.md).

## Adding data, and running on other hardware

```bash
cd deploy && make validate-catalog CSV=path/to/new.csv && make load-reference && make reindex
```

[`etl/PROVENANCE.md`](etl/PROVENANCE.md) covers what breaks when data is added
(duplicate `attr_label` and unknown `entity_type`, mostly), what does not
(tagger drift — measured, not assumed), and how the embedder detects a changed
vector space when you move between CPU and GPU. `make up-gpu` for NVIDIA hosts.
