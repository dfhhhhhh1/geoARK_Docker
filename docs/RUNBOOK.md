# Runbook: standing GeoARK up on a new machine

From a fresh clone to a working `/api/analyze`. Written for a machine with more
resources than the one this was developed on — notes call out where extra RAM or
a GPU changes what you should do.

---

## 0. What you need on the machine

| | |
|---|---|
| Docker + Compose v2 | `docker compose version` |
| Disk | ~60 GB (3.5 GB source geodata, ~9 GB Postgres, ~4 GB LLM, ~2 GB images) |
| RAM | 16 GB comfortable. Under that, see the `OLLAMA_KEEP_ALIVE` note in step 3 |
| GPU (optional) | NVIDIA + Container Toolkit unlocks `make up-gpu` and a larger planner |
| **The source geodata** | **Not in the repo.** ~3.5 GB, copied separately — see step 2 |

## 1. Clone and configure

```bash
git clone https://github.com/dfhhhhhh1/geoARK_Docker.git && cd geoARK_Docker/deploy && cp .env.example .env
```

Edit `.env`. Only `POSTGRES_PASSWORD` is required. On a bigger machine also set:

```bash
PLAN_MODEL=qwen3:14b
LLM_MODEL=gemma3:4b
OLLAMA_MAX_LOADED_MODELS=2
OMP_NUM_THREADS=16
```

**Tuned for an RTX 4080 Super / 32 GB / i9-14900:**

```bash
POSTGRES_PASSWORD=change_me
GEODATA_DIR=/srv/geoark_data
LLM_MODEL=gemma3:4b
PLAN_MODEL=qwen3:14b
OLLAMA_KEEP_ALIVE=-1
OLLAMA_MAX_LOADED_MODELS=2
OMP_NUM_THREADS=16
```

16 GB of VRAM holds `qwen3:14b` (~9 GB at q4) and `gemma3:4b` (~3.3 GB)
resident together, so the small router and the large planner both stay warm.
`KEEP_ALIVE=-1` is right here — the 8 GB constraint that forced `30m` does not
apply. `OMP_NUM_THREADS=16` leaves headroom on the 14900's 24 cores.

Use `make up-gpu`, then `make reindex` once: moving the embedder to CUDA changes
the vector space, and the drift check will say so.

`PLAN_MODEL` is the single highest-leverage setting. Planning is where quality is
lost; `LLM_MODEL` stays small for decomposition. See §5.

## 2. Get the source data across

Two directories live outside the repo because they are too large to track:

| What | Where it goes | Used by |
|---|---|---|
| `geospatial_database_data/` (~3.5 GB: HSIP shapefiles, geodatabases, `fips_merged_ACS_data.csv`) | anywhere; point `GEODATA_DIR` at it | `make load-geo`, `make load-reference` |
| `GeoARK_data/` (tag generation inputs) | only needed to regenerate tags | `attr_gen copy.py` |

```bash
rsync -av --progress ~/Documents/2026Fall/geoARK/geospatial_database_data/ user@newmachine:/srv/geoark_data/
```

Then set `GEODATA_DIR=/srv/geoark_data` in `deploy/.env`.

Without this, `make up` still works and search still works — only `/api/analyze`
is limited, because nothing resolves to a physical table.

## 3. Start the stack

```bash
cd deploy && make up && make models
```

On an NVIDIA host use `make up-gpu` instead of `make up`, then `make reindex`
once — moving the embedder to a GPU changes the vector space, and the drift
check will tell you so.

Under 16 GB RAM, add `OLLAMA_KEEP_ALIVE=30m` to `.env`. Measured on an 8 GB
host, `gemma3:4b` pinned resident is 5.5 GB and a sustained run OOM-killed the
model runner.

```bash
make health
```

## 4. Load the data — order matters

```bash
make load-geo
```

Shapefiles and geodatabases into PostGIS. **Slow** — 85 sources, ~70 minutes on
a 12-core laptop; much faster with more cores and a better disk. Idempotent, so
it skips tables that already exist and is safe to re-run.

```bash
make load-reference
```

County geometry, ~10.8 M ACS values, and `attribute_source` — the mapping from a
catalog attribute to the physical column holding its values. Takes a few minutes.

Reversing these leaves facility attributes unlinked, because `load-reference`
only maps onto tables that already exist. If that happens, no need to redo the
ACS load:

```bash
make relink-features
```

Check what you got:

```bash
curl -s localhost:8080/api/health | jq '.resolvable_attributes, .corpus_stale'
```

Reference numbers from the development machine: **5,232 of 6,860 attributes
(76.3%)** — 3,596 ACS plus 1,636 facility, across 61 of 83 facility tables. The
22 missing tables are imports that failed before the nested-geodatabase and
`PRECISION=NO` fixes existed; re-running `make load-geo` on a clean database
should recover most of them.

## 5. Try it

```bash
curl -s -X POST localhost:8080/api/analyze -H 'Content-Type: application/json' -d '{"q":"poverty rate normalized by total population for counties"}' | jq '{plan:.plan.steps, rows:.row_count}'
```

Then open `http://localhost:8080`, or tunnel it:

```bash
ssh -N -L 8080:localhost:8080 you@newmachine
```

### The thing to actually test on a bigger machine

Plan quality is the current ceiling, and it is a model-capacity problem. With
`gemma3:4b`, plans are well-formed, grounded and executable but often
semantically wrong — 62.5% of hard queries produce a valid executing plan.

```bash
docker compose exec ollama ollama pull qwen3:14b
```

Set `PLAN_MODEL=qwen3:14b` in `.env`, `docker compose up -d api`, then measure:

```bash
python3 eval/run.py --endpoint analyze --suite multi_concept --compare eval/phase3-analyze.json
```

This has **never been tested** — the development machine could not hold a model
that size. It is the most valuable single experiment available, and there is now
a specific reason to expect it to matter.

### Why the planner number moved, and what it predicts

| configuration | ops available | plan validity |
|---|--:|--:|
| ACS only, `gemma3:4b` | 7 | 62.5% |
| + facility data, 8 ops always offered | 8 | 12.5% |
| + facility data, ops narrowed per query | 7 or 8 | 25.0% |

Tripling executable coverage (52.4% → 76.3%) **halved** plan validity. The task
got harder — more candidate types, a new op, a bigger decision space — and a 4B
model degraded sharply. Narrowing the op set per query recovered half of that
loss, which is itself evidence that decision-space size is what hurts.

That is a clean hypothesis for the 4080 to test: **if the bottleneck is model
capacity, a 14B planner should recover the 62.5% and go past it. If it does
not, the problem is the prompt or the tool surface, and no amount of GPU will
fix it.** Either answer is worth having, and it decides whether Phase 4 is
sensible to start.

## 6. Routine operations

| Task | Command |
|---|---|
| Health of every service | `make health` |
| What produced the vectors | `make provenance` |
| Check a new catalog before loading | `make validate-catalog CSV=path/to/new.csv` |
| Force re-embed | `make reindex` |
| Re-link facility tables only | `make relink-features` |
| SQL shell | `make psql` |
| Retrieval regression check | `python3 eval/run.py --compare eval/phase2-search.json` |
| Ranking-sensitive check | `python3 eval/run.py --suite-file eval/known_item.yaml` |
| Stop (volumes survive) | `make down` |

`make clean` deletes volumes and re-downloads everything. It asks first.

## 7. Known rough edges

- **Re-running `make load-geo` on an existing database** skips tables that
  already exist, so failures from an earlier run are only retried if you drop
  the table first.
- **One import failure can log ~1,000 errors.** A table that fails to create
  makes every subsequent row insert log the same "relation does not exist".
  Count distinct messages, not lines.
- **`/api/analyze` returns 422** when retrieval finds nothing executable. That
  is a coverage answer, not a crash — the message names the cause.
- **The API caches vectors at startup.** If you rebuild the embedder, check
  `corpus_stale` on `/api/health` and `POST /api/reload-corpus`. `docker compose
  up -d api` will NOT recreate a container whose image is unchanged.
