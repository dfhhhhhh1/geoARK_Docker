# Roadmap

Five phases. Each ends with something demonstrably working, and each is ordered
so that it unblocks the next. Estimates assume you working part-time on it.

> **Updated 2026-11-23.** Phases 0-2 are done, Phase 3 is done apart from the
> MCP server, and Phase 4 is partly done. The work since September went mostly
> into the planner, research workflows, multi-scale geography and analyst GIS
> operations, which sit in their own plans. The section "Where things stand
> (2026-11-23)" below is the current picture; the phase sections keep their
> original text with status marks corrected and dated notes added.

## Where things stand (2026-11-23)

| Track | Plan | State |
|---|---|---|
| Retrieval | Phase 2 | 97.8% concept recall / 97.3% success; known-item R@1 91.7%. Reranker measured and **rejected** (`RERANK=off`) |
| Planner and `/api/analyze` | Phase 3 | 94.1% op appropriateness (qwen3:14b); 37 registered ops, 31 offered; typed DAG |
| Data coverage | Phase 4 data ops | 4,893 of 6,860 catalog attributes (71.3%) resolve to data, up from 52.4%; many datasets since (see DATA_CARPENTRY) |
| Research workflows | [RESEARCH_PLAN.md](RESEARCH_PLAN.md) | A-D and F built, E in progress, G (data research questions assume) planned |
| Multi-scale geography | [DATA_LOADING_PLAN.md](DATA_LOADING_PLAN.md) | Phases 1-5 built, 6-7 built in part; tract/ZIP/grid levels, rasters, 118M fine points |
| Analyst GIS ops | [GIS_OPS_PLAN.md](GIS_OPS_PLAN.md) | H0-H5 built (VRP open), H6 tier 1 complete; 11 of 24 primitives covered, 9 partial, 4 missing |
| Data cart and papers | [DATA_CART_PLAN.md](DATA_CART_PLAN.md), [PAPER_AND_CART_INTEGRATION.md](PAPER_AND_CART_INTEGRATION.md) | Cart, mapping, AutoML built; paper upload P3-P4 first version built 2026-11-23 (dev papers only); P1, P2, held-out papers open |
| Fine points | [POINTS_INTEGRATION_PLAN.md](POINTS_INTEGRATION_PLAN.md) | Loaded for L48 + DC; map and `point_distance` built; AK/HI not loaded |

### Big fixes still outstanding (ranked)

1. **Held-out analyst questions: 0 of 16 correct.** Refusals now name the
   missing data (13 of 16), but one is still confidently wrong (Q16, "our
   mobile field inspection locations" plans Mobile Home Parks; `OWN_DATA` in
   `named_data.js` tests the phrase, never the words before it) and eight
   depend on context nobody gave the system ("our", "the county", "downtown").
   Needs a session area of interest / named-feature binding and local geocoding.
2. **No `gis_ops.yaml` family for `service_area`, `route`, `raster_calc`**,
   which the plan requires of every addition; they are checked against one-off
   gold only. The research, answerability and plan_correctness guards were not
   re-run after the 2026-11-23 build.
3. **Answer quality is a measure-choice and catalog-text problem more than an
   op problem.** `research.yaml` sits at 72-89% (run to run); remaining misses
   are attribute choice (opaque catalog names, "around Detroit" matching
   cities in five states, "uninsured in big counties" never loading a rate).
4. **`filter_place` county for independent cities** (St. Louis, Baltimore,
   Richmond VA): every county-filtered answer for these names includes the
   city. Fixed in `raster_calc` only.
5. **Overlay `exclude` on NWI times out** (`NOT EXISTS` scans every row);
   `select_features` ships full geometry (481 fire perimeters died with
   `Invalid string length`); `count_features` over lines double counts.
6. **Missouri NLCD questions miss the raster in retrieval** (raster_dev crop
   change 0/3); tornado `fat` / `inj` read as "fat content" / "injection rate".
7. **Fine points: 24 of the 30 distances are missing for 1.64M points** in
   ME/VT/MN/NH/MA/NY/MI; distances are straight-line, not driving; Alaska and
   Hawaii are not loaded.
8. **Missing GIS capabilities:** allocation (needs the source label per vertex),
   VRP and clustering, KDE, band math and different-grid rasters, raster
   uploads, time-of-day traffic, barriers, local geocoding, transit stops.
9. **Paper upload** (U1-U4, P3-P4) first version built 2026-11-23; held-out papers (U5) and the shared cart (P1-P2) are not.
10. **Operational:** pin torch before the next embedder rebuild (a rebuild
    moved the canary fingerprint); `PLAN_THINK=on` still leaves the relevance
    check unbounded; the ungrounded-`proxy` refusal policy ("best place to
    live" answered 2 of 3) is undecided; cart duplicate-column check at
    checkout not built.

---

## Phase 0: Consolidate ✅ done

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
- [x] Copy the good code out of `geoArkVis/`. **It is still on disk, untouched**,
      delete it once you're satisfied nothing was missed.
- [x] Delete the dead entrypoints: `server_tunnel.js`, `server_e5_test.js`,
      `multi_search_server.js`, `enhanced_search_server_old.js`,
      `geospatial_server copy.js`, `old_server/`, `semantic_backend.js`,
      `ReportPage(2).tsx`, `ReportPage(3).tsx`, `geoark_attributes_old.csv`.
- [x] Git. `.gitignore` expanded to cover secrets, model/embedding caches,
      geodata extensions, build output, and editor noise.
- [x] `frontend/.env` deleted; `frontend/.env.example` added. The key was never
      committed (verified against full history), **but rotate it anyway**, it
      sat in plaintext on disk and in the Docker build context.

Also done, and not originally planned:

- [x] Swapped in the **correct catalog CSV**. `unified_search_server.js` reads
      `dataset_clean`, which the tracked 4,555-row CSV did not have, the
      6,860-row one in `geoArkVis` did. Every `dataset_clean` lookup would have
      returned empty.
- [x] Added **`pg` to `package.json`**. It was required but never declared.
- [x] Dropped the unused `@langchain/*`, `ts-node`, and `typescript` deps.
- [x] Frontend URLs made **relative** (`/api`, `/automl`) with a Vite dev proxy,
      so the same code works in dev and behind nginx.
- [x] Added the missing `@types/papaparse` and `@types/lodash`.

**Done: one tree, one backend entrypoint, one frontend, one build definition.**

## Phase 1: Deployment that starts in seconds ✅ done

The blocker you named. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full design;
`deploy/` has a working reference implementation.

- [x] Split the embedder out of the Node image into a FastAPI sidecar that loads
      the model **once** at process start. *(Biggest single win, search goes
      from ~4 s to ~20 ms.)*
- [x] Named volume for the HF cache (`HF_HOME=/models/hf`), and
      `HF_HUB_OFFLINE=1` once warm.
- [x] Ollama as a compose service with an `ollama_models` volume and
      `OLLAMA_KEEP_ALIVE=-1`.
- [x] PostGIS as a compose service with a `pgdata` volume.
- [x] Cache the corpus embedding matrix to `/data/embeddings/<sha256>.npy`.
      *(Startup drops from minutes to under a second.)*
- [x] Fix `package.json`: `"start": "node unified_search_server.js"`, not
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
**Not yet verified:** a real `docker compose up`: no Docker daemon was
available on the machine this was built on. Run `make up` on the server.

## Phase 2: Retrieval you can measure ✅ done (reranker tried, rejected)

- [x] Write `eval/queries.yaml`. **Not** 50 queries with expected `attr_id`s,
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
      anyway, so defer it there rather than doing it for its own sake.
- [x] Replace weighted score blending with Reciprocal Rank Fusion.
- [x] **Replace the lexical scorer with BM25.** Not originally planned, the
      eval exposed that `keywordMatchScore` was near-constant noise (0.833 on
      unrelated rows) because it substring-matched against unfiltered tokens.
- [x] **Demote margin-of-error rows** (`MOE_PENALTY`, default 0.5). Also not
      planned; ~900 near-duplicate ACS MOE rows were flooding the top 20.
- [x] **Disabled the LLM verification step** (`use_llm_filter` now defaults to
      false). Measured: it cost 10pp concept recall and 7.7s/query while
      raising MRR: it ranks well but deletes instead of reordering.
- [x] Add the `bge-reranker-base` cross-encoder. **Built and measured
      2026-10-30; it does not clear the bar, so `RERANK=off`.** Reorder and
      replace cost 25pp of known-item recall@1 (91.7% → 66.7%); `fuse` (a third
      RRF ranking) loses least (83.3%) for +2.2pp concept recall. Not a default.
      Evidence `eval/rerank/`, CLAUDE.md "Phase B".
- [~] Enrich embedded text. `entity_type`, `dataset_clean`, `attr_orig` and
      tags are already included; the temporal range is not yet. `gen_desc` was
      tried 2026-10-16 behind `EMBED_GEN_DESC` and **hurts** (−25pp known-item
      recall@1 from sibling dilution); default `off`.
- [x] Cache query embeddings by content hash, already done in Phase 1 via the
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

**Final, 37 queries across six suites.** The middle row is the production
default:

| | recall | success | MRR | p50 |
|---|--:|--:|--:|--:|
| retrieval only | 95.6% | 94.6% | 0.847 | 0.03s |
| **+ decomposition, verify off** | **97.8%** | **97.3%** | 0.786 | 3.22s |
| + decomposition, verify on | 91.1% | 89.2% | **0.907** | 10.38s |

Started at 87.5% recall / 84.4% success. Five of six suites now sit at 100%;
`multi_concept` (93.8% / 87.5%) is the remaining weakness and the right target
for Phase 3.

**Still to do:** the pgvector migration only, deferred (see the note above on
why it got *less* valuable). The reranker was built and rejected, see above.

## Phase 3: A real agent ✅ done except the MCP server

See [AI-PIPELINE.md §3](AI-PIPELINE.md#3-the-shape-to-move-to-a-constrained-tool-calling-agent).

- [x] Adopt Ollama **schema-constrained decoding** (`format: <JSON Schema>`)
      everywhere, and delete every `match(/\{[\s\S]*\}/)`. *(Cheapest fix in the
      project; removes a whole class of 500s.)*
- [x] Define the plan DSL, seven ops, closed vocabulary. In JSON Schema
      (`backend/schemas.js`) rather than Pydantic, since the planner lives in
      the Node service and the schema doubles as the decoding constraint.
- [x] **Link the two catalogs.** Add a `dataset_id → table_name` mapping so a
      retrieved `attr_id` resolves to a real PostGIS column. Everything
      executable depends on this; nothing works without it.
- [~] Tool surface: `validate_plan`, `execute_plan`, and grounded
      `search_variables` exist as internal functions. They are **not** exposed
      as model-callable tools: the planner still emits a whole plan in one shot.
      `describe_dataset`, `column_stats` and `sample_rows` are not written.
      Decision still open whether to build them at all; the one-shot planner
      plus code-side repairs has carried every measured gain so far.
- [x] Enforce grounded identifiers in the validator: the model may only
      reference identifiers a tool returned.
- [x] Add the validate → repair → retry loop, capped at 3 attempts.
- [x] Write the plan→SQL compiler. The "seven ops" became a registry of 37
      (31 offered; 6 internal, inserted by code). See [OPERATORS.md](OPERATORS.md).
- [ ] Wrap the tools as an **MCP server** so you can drive them from an MCP
      client while iterating.
- [x] Route small vs large model: `PLAN_MODEL` selects the planner
      independently of `LLM_MODEL`. Tested since: qwen3:14b is the planner
      (`PLAN_THINK=off/2048`), qwen3.5:9b measured and not better.


**`POST /api/analyze` works end to end**, natural language in, executed rows
plus GeoJSON out. First measured baseline, on `multi_concept`, the hardest suite:

| | |
|---|--:|
| plan validity | 62.5% |
| execution success | 62.5% |
| non-empty results | 62.5% |
| mean repairs | 0.62 |
| latency p50 | 8.6s |

`python3 eval/run.py --endpoint analyze --suite multi_concept`

> **Superseded 2026-11-23:** that table is the first, gemma3:4b baseline. After
> the planner was fixed to read the question (2026-08-31) and moved to
> qwen3:14b, op appropriateness is 94.1% on `eval/plan_correctness.yaml`, and
> answer correctness is measured separately on `research.yaml` (72-89%).

**What limited it then was plan quality, not plumbing.** gemma3:4b produces
well-formed, grounded, executable plans that are often semantically wrong, it
picked `join` where `normalize` was needed, and divided one poverty percentage
by another while a correctly labelled total-population row sat in the candidate
list. The next moves are a larger `PLAN_MODEL` and the deferred Phase 2
reranker, in that order.

## Is this ready for Phase 4? (September assessment, kept for history)

**Partly.** Phase 4 splits cleanly into work that is ready and work that is not,
and the dividing line is whether it depends on plan quality.

**Ready now**, independent of the planner being right:

- Stream pipeline stages over SSE (retrieval is 0.03s; planning is 8s, the
  latency is already there to hide).
- Map the executed result. `/api/analyze` returns GeoJSON today and the Leaflet
  component already exists; nothing is wired between them.
- Export GeoJSON / CSV, and the plan itself as a reproducible artifact.
- Query history, permalinks, auth.

**Not ready**: these amplify a 62.5% success rate rather than fixing it:

- Rendering the plan as an *editable* pipeline. Worth building, but polishing
  the presentation of plans that are wrong a third of the time inverts the
  order: raise plan quality first, then make it editable.
- Wiring AutoML in as a plan op, which adds surface area to a planner that
  cannot yet reliably choose between `join` and `normalize`.

**The recommendation:** do the two highest-leverage planner items first, try a
larger `PLAN_MODEL`, and build the deferred cross-encoder reranker, then take
the whole "ready now" list. Both are small next to Phase 4's UI work, and both
raise the ceiling everything else sits under.

## Phase 4: The product around it 🚧 partly done

- [x] Stream pipeline stages over SSE (`useAnalyzeStream`).
- [ ] Render the plan in the UI as an editable pipeline before execution.
      Not built; follow-up edits (`followup.js`) cover the common edits in code.
- [x] Map the executed result: choropleths, feature layers, large point answers
      as tiles, travel bands and routes, tract / ZIP / grid levels, `/explore`.
- [~] Export: CSV, GeoJSON, Markdown report and a JSON bundle with provenance
      are built. GeoPackage is not.
- [~] AutoML: built as a **cart** feature (`POST /api/cart/model`, spatial-fold
      CV with Moran's I of residuals), not as a plan op.
- [~] Query history: the analysis page is a follow-up thread. Shareable
      permalinks are not built.
- [x] Access code in front of the API (`ACCESS_CODE`, `backend/auth.js`,
      rate limits). Not per-user auth.
- [x] Data cart (`/data-search`): shelf, checkout, map, AutoML, opt-in LLM
      curator. Paper upload is not built (see PAPER_AND_CART_INTEGRATION).

### Data operations (added after Phase 3)

- [x] `etl/validate_catalog.py`, pre-flight gate for new or edited catalogs.
      Catches duplicate `attr_label`, unknown `entity_type`, missing columns,
      encoding damage, and baseline drift.
- [x] Provenance fingerprinting in the embedder. A canary embedding is hashed
      and stored beside every cached matrix, so a changed vector space is
      detected rather than silent. `make provenance`.
- [x] Hardware profiles: `make up-gpu` (NVIDIA overlay), `TORCH_INDEX_URL`
      build arg, documented RAM tiers. See [`etl/PROVENANCE.md`](../etl/PROVENANCE.md).
- [x] Measured the tag-reproducibility risk properly, after an initial wrong
      answer. Tags are **load-bearing**: removing them costs 41.7pp of
      known-item recall@1 (91.7% -> 50.0%). Tagger consistency matters; re-tag
      new data with the recorded settings in [`etl/PROVENANCE.md`](../etl/PROVENANCE.md).
- [x] `eval/known_item.yaml`, known-item and absent-query suites. The concept
      suite cannot detect ranking changes (its assertions are satisfied by
      hundreds of rows); this one scores the rank of one specific attribute.
- [x] Fixed a real bug the above exposed: the API held its startup vector cache
      forever with no staleness detection, so a re-embedded corpus was served
      silently wrong. `/api/health` now reports `corpus_stale`;
      `POST /api/reload-corpus` fixes it without a restart.
- [x] Load the facility shapefiles. Done; coverage is 4,893 of 6,860 (71.3%),
      1,636 of them facility rows. The remaining 28.7% are catalog rows whose
      source data was never obtained (22 from a truncated archive) or declared
      codes with no values.
- [x] `gen_desc`: carried through and **measured; not a retrieval win** as a
      per-column embedding (−25pp). If used, once per dataset. See CLAUDE.md.
- [x] Recover `table_name`: done, `etl/facility_table_map.csv`.
- [x] Drop-in loading (`make ingest DIR=`), a load ledger and `make replay`,
      so the server never runs the tagger. See DATA_LOADING_PLAN.

---

## The five things that matter most

If you only do a handful of items from the above, do these:

1. **Long-lived embedding service**, 4 s → 20 ms per search, and it removes
   the reason Docker startup hurts. *(Phase 1)*
2. **Persist the embedding matrix to disk**, minutes → <1 s at boot. *(Phase 1)*
3. **Schema-constrained decoding**, ~10 lines; deletes most parse failures.
   *(Phase 3)*
4. **Link `dataset_id` → PostGIS `table_name`**, without it the DAG can never
   execute, and the project stays a demo. *(Phase 3)*
5. **The eval set**, otherwise none of the rest is measurable. *(Phase 2)*
