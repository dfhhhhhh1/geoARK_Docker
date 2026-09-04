# Runbook: standing GeoARK up on a new machine

From a fresh clone to a working `/api/analyze`. Written for a machine with more
resources than the one this was developed on, notes call out where extra RAM or
a GPU changes what you should do.

---

## 0. What you need on the machine

| | |
|---|---|
| Docker + Compose v2 | `docker compose version` |
| Disk | ~60 GB (3.5 GB source geodata, ~9 GB Postgres, ~4 GB LLM, ~2 GB images) |
| RAM | 16 GB comfortable. Under that, see the `OLLAMA_KEEP_ALIVE` note in step 3 |
| GPU (optional) | NVIDIA + Container Toolkit unlocks `make up-gpu` and a larger planner |
| **The source geodata** | **Not in the repo.** ~3.5 GB, copied separately, see step 2 |

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
`KEEP_ALIVE=-1` is right here: the 8 GB constraint that forced `30m` does not
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

Without this, `make up` still works and search still works, only `/api/analyze`
is limited, because nothing resolves to a physical table.

## 3. Start the stack

```bash
cd deploy && make up && make models
```

On an NVIDIA host use `make up-gpu` instead of `make up`, then `make reindex`
once, moving the embedder to a GPU changes the vector space, and the drift
check will tell you so.

Under 16 GB RAM, add `OLLAMA_KEEP_ALIVE=30m` to `.env`. Measured on an 8 GB
host, `gemma3:4b` pinned resident is 5.5 GB and a sustained run OOM-killed the
model runner.

```bash
make health
```

## 4. Load the data, order matters

```bash
make load-geo
```

Shapefiles and geodatabases into PostGIS. **Slow**, 85 sources, ~70 minutes on
a 12-core laptop; much faster with more cores and a better disk. Idempotent, so
it skips tables that already exist and is safe to re-run.

```bash
make load-reference
```

County geometry, ~10.8 M ACS values, and `attribute_source`: the mapping from a
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

Reference numbers: **4,893 of 6,860 attributes (71.3%)**, 3,257 ACS plus 1,636
facility, across 61 of 83 facility tables.

This read 5,232 until 2026-09-01. The ACS half was derived from `acs_variables`,
the codes the source CSV *declares*, and 339 of those attributes pointed at
codes with no row in `acs_county_values`. They compiled, ran, and returned
nothing. Resolvability now means "has values". To rebuild the mapping after a
change like that, without re-importing the 10.8M ACS rows:

```bash
docker compose --profile etl run --rm etl python /app/etl/load_reference_data.py \
  --acs-csv /data/fips_merged_ACS_data.csv --relink-only
```

### The 22 missing facility tables are a SOURCE DATA gap, not an ETL failure

This page previously said they were imports that failed before the
nested-geodatabase and `PRECISION=NO` fixes, and that re-running `make load-geo`
on a clean database should recover most of them. That is wrong, and acting on it
costs ~70 minutes for no change. Checked 2026-08-31:

- `geospatial_database_data.zip` contains **101 layers, ending alphabetically at
  `Oil_and_Natural_Gas_Wells`**. The extracted directory contains the same 101.
- All 22 missing datasets sort after that point: Petroleum Ports, Power Plants,
  Prison Boundaries, Private/Public Schools, Public Transit, Rail Company, Road
  Tunnels, Solid Waste Landfills, Urgent Care, Veterans Health, Uranium, plus
  DOE Petroleum Reserves and Generating Units.
- No prefix-matching table exists in the database under any other name, so this
  is not a naming mismatch either.

The archive was truncated at the source. Recovering these needs a fresh copy of
the HSIP data; nothing on the machine can produce them. Until then, queries about
roads, rail, schools, power plants, prisons or transit have no data to hit, and
the planner will correctly say so.

## 5. Try it

```bash
curl -s -X POST localhost:8080/api/analyze -H 'Content-Type: application/json' -d '{"q":"poverty rate normalized by total population for counties"}' | jq '{plan:.plan.steps, rows:.row_count}'
```

Then open `http://localhost:8080`, or tunnel it:

```bash
ssh -N -L 8080:localhost:8080 you@newmachine
```

### The thing to actually test on a bigger machine

Set `PLAN_MODEL=qwen3:14b` in `.env`, then, note `up -d api` alone will NOT
pick this up, the container's image is unchanged:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --force-recreate api
```

Measure with **both** instruments. The second is the one that means anything:

```bash
python3 eval/run.py --endpoint analyze --suite multi_concept --compare eval/adaptive-ops.json
python3 eval/plan_probe.py --compare eval/plan-D-callllm-fixed.json
```

**Compare against `adaptive-ops.json`, not `phase3-analyze.json`.** This page
said `phase3-analyze.json` for a while and that was wrong: it is the obsolete
ACS-only 62.5% baseline from before facility coverage existed. The three stored
analyze runs map onto the table below, `after-guards.json` is the 12.5% row,
`adaptive-ops.json` the 25.0% row.

### What happened when it was finally run (2026-08-31, RTX 4080 Super)

The framing above, "plan quality is a model-capacity problem", did not
survive contact with the hardware. `qwen3:14b` took plan validity from 25% to
100%, which looked like a decisive confirmation and was not one: the planner
was not reading the question at all. `callLLM` accepted a `userPrompt` and
never sent it, so both arms were reciting the prompt's worked examples, and the
A/B measured which model copies an in-context example more faithfully.

See the correction in CLAUDE.md. Two lessons worth keeping:

- **`plan_validity` cannot see this class of failure** and never could. Use
  `eval/plan_probe.py`; `op_diversity` was 0.12: one op sequence across eight
  different questions, while plan validity read 87.5%.
- **The capacity question is open again.** It has still not been tested on a
  planner that can actually see the question, because the bug predates every
  measurement in this file.

### Why the planner number moved, and what it predicts

| configuration | ops available | plan validity |
|---|--:|--:|
| ACS only, `gemma3:4b` | 7 | 62.5% |
| + facility data, 8 ops always offered | 8 | 12.5% |
| + facility data, ops narrowed per query | 7 or 8 | 25.0% |

Tripling executable coverage (52.4% → 76.3%) **halved** plan validity. The task
got harder, more candidate types, a new op, a bigger decision space, and a 4B
model degraded sharply. Narrowing the op set per query recovered half of that
loss, which is itself evidence that decision-space size is what hurts.

That is a clean hypothesis for the 4080 to test: **if the bottleneck is model
capacity, a 14B planner should recover the 62.5% and go past it. If it does
not, the problem is the prompt or the tool surface, and no amount of GPU will
fix it.** Either answer is worth having, and it decides whether Phase 4 is
sensible to start.

## 5a. Adding data

Drop a file in `deploy/incoming/`, then:

```bash
make inspect FILE=/incoming/hydrants.geojson NAME="Fire Hydrants"   # writes nothing
make ingest  FILE=/incoming/hydrants.geojson NAME="Fire Hydrants"
```

`inspect` reports the driver, layer, geometry type, CRS, feature count and which
columns become searchable attributes. `ingest` loads via ogr2ogr reprojected to
4326, builds the GIST index, **ANALYZEs** (without which `reltuples` stays -1 and
the layer reads as empty to anything checking coverage), tags every column, and
appends to both catalog CSVs with a backup, then relinks and re-embeds.

Vector only: `.shp .geojson .gpkg .gdb .kml`, and CSVs with lat/lon. Rasters are
refused with the reason. `--layer` selects one layer from a multi-layer source.

**It stops if the tagger is unreachable.** Tags are worth 41.7pp of known-item
recall, and a dataset loaded without them is present but measurably hard to
find, with nothing visible to say why. `--no-tags` exists and states the cost.

### Named boundaries

TIGER geodatabases are different: they are boundaries to filter BY, not datasets
to search. They go in `place_geom`, not the catalog.

```bash
make boundaries-dry     # what it would load
make boundaries         # 70,012 places, ZCTAs, metros and urban areas
```

That enables `filter_place`, so "counties in the Chicago metro area" and
"counties in ZIP code 63101" become answerable. TIGER `.gdb` archives unzip to a
folder containing a folder of the same name; the loader handles that, but a bare
`ogrinfo` on the outer one fails with "unable to open".

## 5b. Before anyone else can reach it

Three things gate exposure beyond localhost. All are off by default, because
defaulting them on breaks the eval harness and a broken dev loop is how people
end up disabling security permanently.

```bash
ACCESS_CODE=some-long-code       # comma-separated for several
SESSION_SECRET=$(openssl rand -hex 32)
```

- **Auth.** With `ACCESS_CODE` set, every API route except `/api/health`,
  `/api/session`, `/api/login` and `/api/logout` requires a session cookie.
  The cookie is HttpOnly + SameSite=strict and signed with HMAC-SHA256;
  `document.cookie` cannot read it. A cookie rather than a bearer token because
  `/api/analyze/stream` is an `EventSource`, and EventSource cannot set headers:
  a token in the querystring would land in nginx logs and browser history.
  Without `SESSION_SECRET` a random key is generated per start, so a restart
  signs everyone out.
- **Rate limits**, per session when signed in and per IP otherwise. Two tiers:
  retrieval is ~30 ms of CPU, an analysis is ~19 s of a GPU that does one at a
  time. Login has its own bucket so the code cannot be brute-forced.
- **A queue.** Analyses run one at a time and the stream emits a `queued` event
  with your position, so a 76 s wait reads as "4th in line" instead of a hang.
  A client that navigates away is dropped before its job starts. When more than
  `ANALYZE_QUEUE_DEPTH` are waiting, new requests get 503 with `Retry-After`.

Check it took effect:

```bash
curl -s localhost:8080/api/health | jq '.auth_required, .queue'
```

`make up` prints the state at startup, including a warning when auth is off.

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
| **Planner correctness check** | `python3 eval/plan_probe.py --compare eval/plan-E-geospatial-ops.json` |
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
  is a coverage answer, not a crash: the message names the cause.
- **The API caches vectors at startup.** If you rebuild the embedder, check
  `corpus_stale` on `/api/health` and `POST /api/reload-corpus`. `docker compose
  up -d api` will NOT recreate a container whose image is unchanged.
