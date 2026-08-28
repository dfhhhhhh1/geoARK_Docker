# Architecture

This document describes what GeoARK actually does today, as built — not the
intended design. Where the two differ, that is called out.

---

## 1. The intended pipeline

```
Natural-language query
        │
        ▼
  Query decomposition          LLM splits "poverty per capita near X" into
  (local LLM)                  primary / normalization / filter concepts
        │
        ▼
  Catalog search               Each concept is embedded and matched against
  (embeddings + keywords)      6,860 variable descriptions in geoark_attributes.csv
        │
        ▼
  IR generation                LLM emits a structured analytic plan:
  (local LLM)                  entities, spatial ops, temporal filters, aggregations
        │
        ▼
  DAG generation               LLM converts the IR into ordered atomic steps:
  (local LLM)                  load_data → buffer → spatial_join → aggregate → output
        │
        ▼
  Execution                    PostGIS / GeoPandas run the DAG   ← NOT IMPLEMENTED
        │
        ▼
  Map + report                 React/Leaflet renders results
```

Everything above the "Execution" line exists. The DAG is generated and returned
to the client, but **nothing executes it**. That is the single biggest gap
between the demo and a working product.

## 2. Components as deployed

```
┌──────────────────────────────┐
│ web    nginx + React SPA     │  :8080 → :80
│  App.tsx  SearchBar          │
│  MapVisualization (Leaflet)  │
│  ReportPage (Chart.js/d3)    │
└──────────────┬───────────────┘
               │  /api/ → api:4000     /automl/ → automl:8000
               ▼
┌──────────────────────────────┐
│ api    Node 20 + Express     │  :4000
│  variables[]   (CSV metadata)│
│  embeddings[]  (from embedder│
│                 at startup)  │
│  HTTP ───────────────────────┼──► embedder:8000   model resident in memory
│  HTTP ───────────────────────┼──► ollama:11434    weights on a volume
│  pg Pool ────────────────────┼──► db:5432         PostGIS + pgvector
└──────────────────────────────┘
```

All addresses are environment variables resolving to Compose service names, so
nothing points at `127.0.0.1` from inside a container. See
[DEPLOYMENT.md](DEPLOYMENT.md).

## 3. Backend inventory

Nine Express entrypoints used to live across two trees. The Phase 0
consolidation reduced that to one. What remains:

| File | Role |
|---|---|
| **`backend/unified_search_server.js`** | **The entrypoint.** Decompose → per-concept hybrid search (BGE semantic, weighted 0.7, + keyword, 0.3) → LLM verification → PostGIS lookup. Endpoints: `POST /api/unified-search`, `POST /api/decompose-query`, `POST /api/get-data`, `GET /api/search`, `GET /api/health` |
| `backend/enhanced_search_server.js` | Module (not an entrypoint) exporting PostGIS tools: `search-metadata`, `search-columns`, `table-sample`, `column-statistics`, `spatial-query`, `join-tables`. Foundation for the Phase 3 tool surface |
| `backend/geospatial_search_enhanced.py` | **LangGraph agent** — `PostGISSearcher`, `QueryDecomposer`, `GeospatialSearchAgent`, six `@tool` functions. The closest thing to a real tool-calling agent and the right base for Phase 3 |
| `backend/ml_service.py` | FastAPI + AutoGluon (`POST /automl/train`). Optional `automl` compose profile |
| `deploy/embedder/app.py` | Loads the BGE model once, owns the catalog matrix, caches it to a volume |
| `backend/legacy/geospatial_server.js` | Generation-1 IR→DAG pipeline. Not wired up; kept because its prompts seed Phase 3 |

Deleted in Phase 0 (recoverable from git history): `server.js`, `server_ai.js`,
`server_tunnel.js`, `semantic_backend.js`, `semantic_search_python.py`,
`old_server/`. See [`backend/legacy/README.md`](../backend/legacy/README.md).

## 4. The data layer

`geospatial_etl.py` recursively scans a directory and imports shapefiles, ESRI
file geodatabases, and large CSVs into PostGIS. It is idempotent (skips tables
that already exist), unzips archives, and writes a catalog row per dataset:

```sql
CREATE TABLE dataset_metadata (
    id            SERIAL PRIMARY KEY,
    dataset_name  TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    source_path   TEXT NOT NULL,
    geometry_type TEXT,
    row_count     INTEGER,
    column_list   TEXT[],
    crs           TEXT,
    bbox          TEXT,
    date_ingested TIMESTAMP DEFAULT now(),
    UNIQUE(table_name)
);
```

Separately, `backend/geoark_attributes.csv` (6,860 rows) is a **variable-level**
catalog: `dataset_id, dataset_clean, attr_label, attr_orig, attr_desc, attr_id,
start_date, end_date, entity_type, tags, spatial_rep, …`. This is what gets
embedded for semantic search.

The two catalogs are not linked. `dataset_metadata.table_name` and
`geoark_attributes.dataset_id` use different identifier schemes, so a search hit
in the CSV cannot be resolved to a physical PostGIS table.

The gap is visible in the code: `loadVariablesFromCSV()` reads
`row.table_name || ''` — a column the CSV **does not have**, so it is empty for
every row. **This is why the DAG cannot execute.** The planner has no reliable
way to turn `attr_id = 6fbbd315_01_01_01` into `SELECT fips_code FROM some_table`.

`deploy/db/init/01-extensions.sql` creates a `dataset_table_map` table as the
place to fix this. Populating it is a Phase 3 prerequisite.

## 5. Known problems

### Fixed in Phases 0–1

1. ~~The embedding model is loaded from scratch on every call.~~ The `embedder`
   service now holds it in memory; the API calls it over HTTP. Search went from
   ~4 s to ~20 ms per query.
2. ~~The corpus re-embeds at every boot.~~ The matrix is cached to a volume,
   keyed by `sha256(csv + model + preprocessing_version)`, so it self-invalidates
   when the catalog changes. Startup went from minutes to seconds.
3. ~~The Docker image serves the wrong entrypoint.~~ `npm start` is now
   `node unified_search_server.js`.
4. ~~No LLM or database in compose.~~ `ollama` and `db` are services with their
   own volumes.
5. ~~Python is baked into the Node image.~~ The `api` image is `node:20-slim`.
6. ~~No `.dockerignore`.~~ Added for both `backend/` and `frontend/`.
7. ~~Hardcoded credentials.~~ All config is environment-driven. The Google API
   key in `frontend/.env` was deleted (it was never committed — verified against
   the full git history — but should still be rotated, as it sat in plaintext on
   disk and in the Docker build context).
8. ~~`pg` missing from `package.json`.~~ It was required by
   `unified_search_server.js` but never declared, so the server could only run
   where a stray global copy happened to exist.

### Still open

1. **The generated DAG is never executed.** See §1. The single biggest gap
   between the demo and a product.
1b. **The LLM verification step is destructive.** Measured: −10pp concept
   recall, −12.5pp query success, +7.7s per request, while *raising* MRR. It
   judges relevance well but deletes instead of reordering. Now defaulted off;
   a cross-encoder should replace it — [AI-PIPELINE.md §4](AI-PIPELINE.md).
2. **The two catalogs don't join.** See §4. Prerequisite for the above.
3. **LLM output is parsed with a regex.** `llmResponse.match(/\{[\s\S]*\}/)`
   plus `JSON.parse`. A small local model producing prose, a trailing comma, or
   `<think>` tags fails the whole request. Ollama's schema-constrained decoding
   fixes this — [AI-PIPELINE.md §3](AI-PIPELINE.md), Phase 3.
4. ~~No tests, no evaluation set.~~ `eval/` measures concept recall, query
   success, MRR, and latency over 32 queries. Still small — a 1-query flip moves
   recall ~2.5pp — and there are no plan-execution metrics yet.
5. ~~Hybrid scoring blends incomparable scales.~~ Replaced with BM25 + Reciprocal
   Rank Fusion in Phase 2. The old lexical scorer turned out to be worse than
   "incomparable" — it was near-constant noise. Measured: +7.5pp concept recall,
   +9.4pp query success, 4× faster. See [`eval/README.md`](../eval/README.md).
6. **18 pre-existing TypeScript errors** in `MapVisualization.tsx`,
   `ReportPage.tsx`, and `App.tsx` (unused vars, possible-null, implicit any).
   `npm run build` is `vite build`, which does not typecheck, so they do not
   block the image — but `npx tsc --noEmit -p tsconfig.app.json` reports them.
7. **The frontend bundle is 754 kB** (240 kB gzipped) in one chunk. Leaflet,
   Chart.js, and d3 all load on first paint.
