# Roadmap

Five phases. Each ends with something demonstrably working, and each is ordered
so that it unblocks the next. Estimates assume you working part-time on it.

---

## Phase 0 — Consolidate ✅ done

Nothing else is worth doing while there are two app trees and nine backend
entrypoints.

- [x] Pick `GeoARK/` as the canonical tree (it has the Docker setup).
- [x] Move `unified_search_server.js`, `geospatial_search_enhanced.py`,
      `ml_service.py`, and `README_ENHANCED_SEARCH.md` from `geoArkVis/backend/`
      into `GeoARK/backend/`.
- [x] Reconcile the frontends: `geoArkVis/src/App.tsx` calls
      `POST /api/unified-search` at an absolute `http://localhost:4000` URL;
      `GeoARK/frontend/src/App.tsx` calls `GET /api/search` at a relative path.
      Keep the relative path (nginx proxies it, so it works in Docker) and the
      unified endpoint (it's the better backend).
- [x] Copy the good code out of `geoArkVis/`. **It is still on disk, untouched** —
      delete it once you're satisfied nothing was missed.
- [x] Delete the dead entrypoints: `server_tunnel.js`, `server_e5_test.js`,
      `multi_search_server.js`, `enhanced_search_server_old.js`,
      `geospatial_server copy.js`, `old_server/`, `semantic_backend.js`,
      `ReportPage(2).tsx`, `ReportPage(3).tsx`, `geoark_attributes_old.csv`.
- [x] Git. `.gitignore` expanded to cover secrets, model/embedding caches,
      geodata extensions, build output, and editor noise.
- [x] `frontend/.env` deleted; `frontend/.env.example` added. The key was never
      committed (verified against full history) — **but rotate it anyway**, it
      sat in plaintext on disk and in the Docker build context.

Also done, and not originally planned:

- [x] Swapped in the **correct catalog CSV**. `unified_search_server.js` reads
      `dataset_clean`, which the tracked 4,555-row CSV did not have — the
      6,860-row one in `geoArkVis` did. Every `dataset_clean` lookup would have
      returned empty.
- [x] Added **`pg` to `package.json`**. It was required but never declared.
- [x] Dropped the unused `@langchain/*`, `ts-node`, and `typescript` deps.
- [x] Frontend URLs made **relative** (`/api`, `/automl`) with a Vite dev proxy,
      so the same code works in dev and behind nginx.
- [x] Added the missing `@types/papaparse` and `@types/lodash`.

**Done: one tree, one backend entrypoint, one frontend, one build definition.**

## Phase 1 — Deployment that starts in seconds ✅ done

The blocker you named. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full design;
`deploy/` has a working reference implementation.

- [x] Split the embedder out of the Node image into a FastAPI sidecar that loads
      the model **once** at process start. *(Biggest single win — search goes
      from ~4 s to ~20 ms.)*
- [x] Named volume for the HF cache (`HF_HOME=/models/hf`), and
      `HF_HUB_OFFLINE=1` once warm.
- [x] Ollama as a compose service with an `ollama_models` volume and
      `OLLAMA_KEEP_ALIVE=-1`.
- [x] PostGIS as a compose service with a `pgdata` volume.
- [x] Cache the corpus embedding matrix to `/data/embeddings/<sha256>.npy`.
      *(Startup drops from minutes to under a second.)*
- [x] Fix `package.json`: `"start": "node unified_search_server.js"` — not
      `ts-node server.js`, which serves the wrong file through an unnecessary
      TypeScript loader.
- [x] Add `.dockerignore` and BuildKit cache mounts.
- [x] Point all service addresses at DNS names (`ollama:11434`, `db:5432`), not
      `127.0.0.1`.
- [x] `Makefile` with `up`, `down`, `dev`, `models`, `health`, `reindex`,
      `automl`, `psql`, `clean`.

Also done, and not originally planned:

- [x] `automl` service (optional profile) so the Report page's AutoGluon
      features work in the deployment.
- [x] nginx `/automl/` upstream resolved through a **variable**, so nginx still
      boots when that optional service is absent.
- [x] `waitForEmbedder()` in the API, so a cold model volume doesn't crash-loop
      the API for the minutes the download takes.
- [x] A **row-count assertion** between the CSV the API loads and the corpus the
      embedder serves. A silent misalignment would return wrong results for
      every query.

**Verified so far:** startup path, `/api/health`, and `/api/search` all tested
end-to-end against a stub embedder (6,860 rows, keyword scoring live); the
mismatch guard fires correctly; the frontend builds; both compose files validate.
**Not yet verified:** a real `docker compose up` — no Docker daemon was
available on the machine this was built on. Run `make up` on the server.

## Phase 2 — Retrieval you can measure 🚧 in progress

- [x] Write `eval/queries.yaml`. **Not** 50 queries with expected `attr_id`s —
      that design doesn't survive contact with this catalog (221 poverty
      attributes; no single one is "correct"). Instead 32 queries × 40
      *concept assertions*, each verified satisfiable against the CSV.
      See [`eval/README.md`](../eval/README.md).
- [x] `eval/run.py` reporting concept recall, query success, MRR, and latency,
      with `--save` / `--compare` for before-and-after diffs and `--fail-under`
      for CI later.
- [ ] Move the catalog into pgvector (`attribute_embeddings`, HNSW + GIN index).
      **Reassess before doing this.** Three of the four reasons I gave for it
      have evaporated: search latency is already 0.01s (not a bottleneck),
      startup is already seconds, and the BM25 index now in Node is a better
      lexical matcher for this corpus than Postgres FTS would be. The one real
      remaining benefit is a stateless API. That pairs naturally with the
      Phase 3 `dataset_table_map` work, where the API needs the database
      anyway — so defer it there rather than doing it for its own sake.
- [x] Replace weighted score blending with Reciprocal Rank Fusion.
- [x] **Replace the lexical scorer with BM25.** Not originally planned — the
      eval exposed that `keywordMatchScore` was near-constant noise (0.833 on
      unrelated rows) because it substring-matched against unfiltered tokens.
- [x] **Demote margin-of-error rows** (`MOE_PENALTY`, default 0.5). Also not
      planned; ~900 near-duplicate ACS MOE rows were flooding the top 20.
- [x] **Disabled the LLM verification step** (`use_llm_filter` now defaults to
      false). Measured: it cost 10pp concept recall and 7.7s/query while
      raising MRR — it ranks well but deletes instead of reordering.
- [ ] Add the `bge-reranker-base` cross-encoder to recover that ranking gain
      (MRR 0.726 → 0.874) without the recall loss. **Now the highest-value
      remaining item**, and the numbers say exactly what it has to beat.
- [~] Enrich embedded text. `entity_type`, `dataset_clean`, `attr_orig` and
      tags are already included; the temporal range is not yet.
- [x] Cache query embeddings by content hash — already done in Phase 1 via the
      embedder's `lru_cache`.

**Measured so far** (`--endpoint search`, 32 queries):

| | baseline | now | Δ |
|---|--:|--:|--:|
| concept recall | 87.5% | **95.0%** | +7.5pp |
| query success | 84.4% | **93.8%** | +9.4pp |
| MRR | 0.773 | **0.822** | +0.049 |
| latency p50 | 0.04s | **0.01s** | 4× faster |

`multi_concept` 62.5% → 87.5%; `paraphrase` 60% → 80%. Three queries flipped to
passing, none regressed.

**End-to-end, same 32 queries:**

| | recall | success | MRR | p50 |
|---|--:|--:|--:|--:|
| retrieval only | 95.0% | 93.8% | 0.822 | 0.01s |
| + decomposition, verify OFF | **97.5%** | **96.9%** | 0.726 | 3.42s |
| + decomposition, verify ON | 87.5% | 84.4% | 0.874 | 11.10s |

**Still to do:** cross-encoder reranker, and the pgvector migration — see the
note below on why pgvector got *less* valuable, not more.

## Phase 3 — A real agent (1–2 weeks)

See [AI-PIPELINE.md §3](AI-PIPELINE.md#3-the-shape-to-move-to-a-constrained-tool-calling-agent).

- [ ] Adopt Ollama **schema-constrained decoding** (`format: <JSON Schema>`)
      everywhere, and delete every `match(/\{[\s\S]*\}/)`. *(Cheapest fix in the
      project; removes a whole class of 500s.)*
- [ ] Define the plan DSL with Pydantic — nine ops, closed vocabulary.
- [ ] **Link the two catalogs.** Add a `dataset_id → table_name` mapping so a
      retrieved `attr_id` resolves to a real PostGIS column. Everything
      executable depends on this; nothing works without it.
- [ ] Build the tool surface: `search_variables`, `describe_dataset`,
      `column_stats`, `sample_rows`, `add_step`, `validate_plan`, `execute_plan`.
- [ ] Enforce grounded identifiers in the validator — the model may only
      reference identifiers a tool returned.
- [ ] Add the validate → repair → retry loop, capped at 3 attempts.
- [ ] Write the plan→SQL compiler for the nine ops.
- [ ] Wrap the tools as an **MCP server** so you can drive them from an MCP
      client while iterating.
- [ ] Route small model (decompose/rerank) vs large model (plan/repair).

**Done when:** `POST /api/analyze` takes a natural-language query and returns
executed results — GeoJSON plus statistics — not just a plan.

## Phase 4 — The product around it (ongoing)

- [ ] Stream pipeline stages over SSE; show variables in ~1 s.
- [ ] Render the plan in the UI as an editable pipeline before execution.
- [ ] Map the executed result (the Leaflet component is already there).
- [ ] Export: GeoJSON / GeoPackage / CSV, and the plan itself as a reproducible
      artifact.
- [ ] Wire `ml_service.py` (AutoGluon) in as a plan op — "predict X from these
      variables" becomes an analysis step rather than a separate service.
- [ ] Query history and shareable permalinks.
- [ ] Basic auth in front of nginx.

---

## The five things that matter most

If you only do a handful of items from the above, do these:

1. **Long-lived embedding service** — 4 s → 20 ms per search, and it removes
   the reason Docker startup hurts. *(Phase 1)*
2. **Persist the embedding matrix to disk** — minutes → <1 s at boot. *(Phase 1)*
3. **Schema-constrained decoding** — ~10 lines; deletes most parse failures.
   *(Phase 3)*
4. **Link `dataset_id` → PostGIS `table_name`** — without it the DAG can never
   execute, and the project stays a demo. *(Phase 3)*
5. **The eval set** — otherwise none of the rest is measurable. *(Phase 2)*
