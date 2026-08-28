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
  Execution                    Deterministic compiler -> PostGIS SQL   ← Phase 3
        │
        ▼
  Map + report                 React/Leaflet renders results
```

**This now runs end to end.** `POST /api/analyze` takes a question and returns
executed rows plus GeoJSON. Phase 3 replaced the IR/DAG pair with a single typed
plan over a closed set of seven operations, and a deterministic compiler that
turns a validated plan into parameterized PostGIS SQL.

The model never writes SQL, table names, or column names. It emits a plan
referencing short attribute labels; code resolves those to real columns via
`attribute_source` and compiles the query. See §5.

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

**The catalogs are now linked** (Phase 3). `etl/load_reference_data.py` builds
`attribute_source`, which maps a catalog `attr_id` to the physical place its
values live:

| table | rows | what |
|---|--:|---|
| `county_geom` | 3,233 | county polygons, joined on `fips` |
| `acs_variables` | 3,980 | ACS code → description |
| `acs_county_values` | 10,774,147 | long-format values |
| `attribute_source` | 3,596 | **attr_id → physical column** |

The join works because ACS catalog rows carry the census code in `attr_orig`;
3,582 of 4,523 distinct codes match the ACS extract directly. That makes
**3,596 of 6,860 catalog attributes (52.4%) executable**.

The values are long-format, not wide, because 3,982 ACS columns exceeds
Postgres' 1,600-column ceiling — and a long table is what the compiler wants to
join against anyway.

The remaining 47.6% are facility datasets (shelters, refineries, volcanoes)
whose shapefiles are not loaded yet. `/api/analyze` returns a 422 naming that
cause rather than failing obscurely.

## 5. The planner

```
question
   -> decompose            (constrained; small model)
   -> hybrid search        per concept, grouped primary/normalization/filter
   -> keep executable      drop anything absent from attribute_source
   -> plan                 (constrained to PLAN_SCHEMA; PLAN_MODEL)
   -> validate             grounding + arity + DAG order + single output
   -> repair               errors fed back to the model, up to PLAN_MAX_REPAIRS
   -> compile              deterministic plan -> parameterized SQL
   -> execute              READ ONLY transaction, statement_timeout
```

Seven operations: `load`, `filter_attr`, `normalize`, `aggregate`, `rank`,
`join`, `output`. A closed vocabulary is both easier for a small model to use
and what makes a deterministic compiler possible.

**Safety.** No model-produced string reaches SQL. Census codes come from
`attribute_source`; every literal is a bound parameter; operators and aggregate
functions pass through closed allow-lists; step ids are pattern-checked before
becoming CTE names; execution runs in a `READ ONLY` transaction with a statement
timeout. `backend/planner/test_planner.js` covers this, including identifier and
operator injection attempts.

**Reference labels.** Candidates are shown to the model as `a1`, `a2`, … rather
than raw ids like `04d18a18_08_01_352`. Asked to transcribe the real ids, a 4B
model gave up and invented placeholders (`attr_14`), which grounding correctly
rejected — so the request produced nothing. Code maps labels back, which is the
only place that mapping can be trusted.

## 6. Known problems

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

1. ~~The generated DAG is never executed.~~ Fixed in Phase 3: `POST /api/analyze`
   compiles a validated plan to SQL and runs it. Measured on the hardest eval
   suite: 62.5% of queries produce a valid plan that executes and returns rows.
1b. **The LLM verification step is destructive.** Measured: −10pp concept
   recall, −12.5pp query success, +7.7s per request, while *raising* MRR. It
   judges relevance well but deletes instead of reordering. Now defaulted off;
   a cross-encoder should replace it — [AI-PIPELINE.md §4](AI-PIPELINE.md).
2. ~~The two catalogs don't join.~~ Fixed in Phase 3 — see §4.
3. ~~LLM output is parsed with a regex.~~ Fixed in Phase 3. Every LLM call now
   uses Ollama's schema-constrained decoding (`format: <JSON Schema>`), so
   invalid JSON is unrepresentable. There are zero `match(/\{[\s\S]*\}/)`
   calls left in the live server.

3b. **Plan quality is limited by the planner model.** Plans are well-formed,
   grounded, and executable, but often semantically mediocre: given a correctly
   labelled NORMALIZATION section containing "Estimate|Total|Total population",
   gemma3:4b still divided one poverty percentage by another. `PLAN_MODEL`
   routes planning to a larger model where RAM allows; untested here, since
   this host OOMs above ~6 GB.
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
