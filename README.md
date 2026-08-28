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

Working: natural-language query decomposition, hybrid semantic + keyword search
over the catalog, LLM result verification, PostGIS metadata lookup, map and
report UI.

Not working yet: **generated analysis plans are not executed.** The planner
emits a DAG and returns it; nothing runs it. The blocker is that
`geoark_attributes.csv` has no `table_name` column, so a retrieved attribute
cannot be resolved to a physical PostGIS table. See
[docs/ARCHITECTURE.md §4](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md) Phase 3.
