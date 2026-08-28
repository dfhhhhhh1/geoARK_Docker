# GeoARK — working context

Geospatial analysis from natural-language queries, running entirely on local
infrastructure (Ollama + a local embedding model + PostGIS). No cloud APIs.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together and
[docs/RUNBOOK.md](docs/RUNBOOK.md) to stand it up. This file holds what those do
**not** say: the things that cost time to learn and are not derivable from the
code.

---

## Ground rules that matter here

**Measure before claiming.** This project has already produced one confidently
wrong conclusion ("tags don't affect retrieval") that survived because the
metric used couldn't detect the effect and the experiment silently never ran.
A metric that doesn't move is not evidence of no effect until you have shown the
metric *can* move. See the correction in [eval/README.md](eval/README.md).

**The eval suites differ in what they can see.**
- `eval/queries.yaml` — concept coverage. Assertions are satisfied by hundreds
  of rows, so it **cannot detect ranking changes**. Regression guard only.
- `eval/known_item.yaml` — rank of one specific attribute. This is the sensitive
  instrument. Use it for anything about retrieval quality.
- `--endpoint analyze` — plan validity / execution success for the planner.

## Traps that have already burned time

| Trap | Symptom | Fix |
|---|---|---|
| `docker compose up -d api` does **not** recreate a container whose image is unchanged | The API serves vectors cached at its startup; an ablation "showed no difference" because both arms read the same stale cache | `--force-recreate`, and check `corpus_stale` on `/api/health` |
| ETL scripts were baked into the job image | Script edits silently ran stale | Now bind-mounted; still rebuild if you change deps |
| `CREATE TABLE IF NOT EXISTS` ignores new columns | Loader fails with "column does not exist" on an established DB | Explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `etl/schema_reference.sql` |
| One failed table import logs ~1000 errors | Every row insert repeats "relation does not exist" | Count distinct messages, not lines |
| `ST_Transform` on the **facility** side of a spatial join | Non-sargable; disables the GIST index; 5 min instead of 3 s | Transform the county side, or neither when SRIDs match |
| gdb table names are opaque hashes | Tempting to rename to human names | **Don't** — 29 of 83 rows in `etl/facility_table_map.csv` are keyed on those hashes |

## Measured facts (do not re-derive)

- **Tags are load-bearing.** Removing them costs 41.7pp of known-item recall@1
  (91.7% → 50.0%). 392 facility rows have an `attr_desc` that is a bare column
  name, so tags + `dataset_clean` are all they have.
- **The LLM verification step subtracts value.** −10pp concept recall, +7.7s per
  query, while *raising* MRR. It ranks well and deletes too much. Default off;
  a cross-encoder is the intended replacement.
- **BM25 + RRF beat the old weighted blend** by +7.5pp recall, 4× faster. The
  old lexical scorer was near-constant noise (0.833 on unrelated rows).
- **Decomposition earns its keep**: +2.5pp recall over raw retrieval, and takes
  the paraphrase suite to 100%.
- **8 GB of Docker RAM is not enough.** `gemma3:4b` pinned resident is 5.5 GB
  and a sustained eval run OOM-killed the model runner.

## Current state

- Retrieval: 97.8% concept recall / 97.3% query success (37 queries), p50 3.2s.
- Planner: `POST /api/analyze` executes. **25%** plan validity on the hardest
  suite, down from 62.5% when only ACS data was executable. Expanding coverage
  made the planning task harder and a 4B model degraded sharply; narrowing the
  op set per query recovered half the loss. See docs/RUNBOOK.md §5.
- Coverage: 5,232 of 6,860 attributes (76.3%) resolve to a physical column.
- **`PLAN_MODEL` (larger planner) has never been tested** — no host with enough
  RAM. It is the highest-value open experiment, and the coverage regression
  above makes it sharper: if capacity is the bottleneck, a 14B planner should
  recover 62.5% and beat it; if not, the problem is the prompt or tool surface.
- `eval/collect.py --label <name>` bundles results plus the environment that
  produced them, for comparing across machines.

## Two things generated and then thrown away

1. **`gen_desc`** — `attr_gen copy.py` asks the model for a one-sentence
   description of every column alongside its tags, and no downstream artifact
   carries it. For the 392 bare-`"Name"` facility rows that is exactly the
   signal they lack. Likely the cheapest retrieval win left.
2. **`table_name`** — dropped by `merge_geospatial_attrs.py`. Already recovered
   into `etl/facility_table_map.csv`.

## Layout

```
backend/        API. unified_search_server.js is the entrypoint.
  planner/      validate.js (grounding) · compile.js (plan -> SQL) · index.js (agent loop)
  schemas.js    JSON Schemas used as Ollama decoding constraints
etl/            geospatial_etl.py · load_reference_data.py · validate_catalog.py
eval/           run.py · queries.yaml · known_item.yaml · test_predicates.py
deploy/         the single build definition; Makefile is the interface
```

## Conventions

- Anything outward-facing (push, deploy) is confirmed first.
- Findings go in the docs with the number that supports them, and corrections
  stay visible rather than being quietly edited away.
- New retrieval claims need `known_item.yaml`, not `queries.yaml`.
