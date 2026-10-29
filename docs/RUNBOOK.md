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

### What the data archive holds

`GEODATA_DIR` (default `../geospatial_database_data`, mounted read-only at
`/data`) is the single thing to copy to a new server. Everything loaded lives
there, organised by how it is loaded:

```
geospatial_database_data/
  HSIP_without_tifs/       101 facility geodatabases   -> make load-geo
  fips_merged_ACS_data.csv ACS county values           -> make load-reference
  county_csv/              7 county CSV releases       -> make county-values
  tiger/                   4 TIGER geodatabases        -> make boundaries SRC=/data/tiger
  raster/                  1 km population grid        -> not yet supported
```

`deploy/incoming/` is a staging area, not storage: put new files there, load
them, then move them into the archive so a rebuild on another machine has
everything in one place.

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

## 5a-0. County measures with a time dimension

The value store is keyed `(fips, census_code, year)`. Everything below is
reproducible from files in `geospatial_database_data/county_csv/`, which is the
archive; nothing here needs a network connection or an API key.

**One-time migration**, on a database created before the year column existed:

```bash
make add-year
```

It backfills existing rows to 2018 (the ACS 5-year vintage that was loaded),
widens the primary key, and prints a year/measure summary. Safe to re-run.

**Load the county CSVs.** Three release formats are handled, detected by header
rather than by filename:

| Source | Shape | Year comes from |
|---|---|---|
| USDA ERS (`Unemployment2023.csv`, `Education2023.csv`, `Poverty2023.csv`, `PopulationEstimates.csv`) | long | the attribute NAME, in four different conventions |
| CDC PLACES | long | an explicit `Year` column |
| County Health Rankings (`analytic_data*.csv`) | wide, **two-row header** | the `year` column |

```bash
make county-values-dry          # parse everything, write nothing
make county-values              # load values + attribute_source
# then, on the HOST -- the catalog is mounted read-only in the containers:
python3 etl/load_county_values.py --source-dir geospatial_database_data/county_csv \
    --catalog-only --catalog backend/geoark_attributes.csv
python3 etl/validate_catalog.py --new backend/geoark_attributes.csv
make reindex && make up-gpu
```

**The catalog step is not optional.** Search indexes the catalog CSV, not the
database. A measure in `attribute_source` but not in the catalog resolves
perfectly and is never retrieved, which from outside looks exactly like the data
not being loaded.

Measured on the current archive: 7 files, **277 measures, 1.49M values,
1970-2024**. Coverage goes 4,893 -> 5,170 resolvable attributes; the catalog
grows only 277 rows because the year is a COLUMN, not a row. Loading
`Unemployment2023.csv`'s 101 attribute names as 101 attributes instead of 9
measures x 24 years would bloat the corpus, and corpus size is already the
limiting factor on retrieval quality.

**Three traps these files contain**, all of which a naive CSV loader hits:

- `Education2023.csv` and `PopulationEstimates.csv` are **cp1252, not UTF-8**,
  and the first bad byte is 13.5 MB and 5.5 MB in (`Añasco Municipio`,
  `Doña Ana County`). Sniffing the first chunk calls them UTF-8 and the load
  dies most of the way through, or survives with `errors="replace"` and
  silently mangles county names. The loader decodes the whole file once, up
  front.
- County Health Rankings has a **two-row header**: human labels then machine
  codes. Read naively, row two becomes a data row of garbage.
- CDC PLACES carries **two rows per county and measure**, crude and
  age-adjusted. They are stored as separate measures; collapsing them would put
  two values in one slot and the last write would win silently.

**Spatial statistics** need the adjacency table once:

```bash
make neighbors        # 18,608 pairs, mean 5.79 neighbours
```

## 5a. Adding data

A dataset is a **folder** in `deploy/incoming/`: the data, plus an optional
sidecar `*.meta.yaml`, plus the official XML if the data shipped with one.

```
deploy/incoming/hydrants/
  hydrants.geojson
  hydrants.meta.yaml        optional: copy etl/templates/dataset.meta.yaml
  hydrants.xml              optional: FGDC, ISO 19115, ISO 19110 or ArcGIS
```

```bash
make inspect DIR=hydrants             # writes nothing; shows where every field came from
make ingest  DIR=hydrants             # load, tag, register, re-embed, reload, validate
make ingest  DIR=hydrants ARGS=--replace   # load it again after fixing its metadata
make ledger                           # what has been loaded
```

`DIR` is relative to `deploy/incoming/`. The old single-file form,
`FILE=/incoming/x.geojson NAME="..."`, still works.

**Metadata precedence: sidecar, then XML, then the model.** Per column it is per
field, so a sidecar can add `units` to a column the XML already describes. The
dry run prints the origin of each field (`[sidecar]`, `[xml]`, `[column name]`),
which is how you find out that the XML's "abstract" is a download link (true
of the HSIP ISO files) and should be overridden. Unknown sidecar keys are
reported, so a typo does not silently leave the model's text in place.

What lands in the catalog: `dataset_clean` from the name; `attr_desc` from the
column's description plus units, or the title-cased column name; `gen_desc`
from the model, always (stored; NOT searched by default, because embedding it
measured -25pp known-item recall@1, see `EMBED_GEN_DESC`); `start_date`/`end_date` from
`vintage` or the XML's time period; `spatial_rep` from the geometry. Dataset-
level fields with no catalog column (description, source URL, licence,
originator, keywords, the probe question) go to the ledger.

`ingest` then loads via ogr2ogr reprojected to 4326, builds the GIST index,
**ANALYZEs** (without which `reltuples` stays -1 and the layer reads as empty to
anything checking coverage), tags every column, writes both catalog CSVs with a
backup in `etl/_backups/`, records the load in `etl/data_manifest.yaml`, relinks,
re-embeds, and calls `make reload-corpus` so the API serves it without a
restart.

Things it refuses, deliberately:

- **A second load of the same dataset** without `--replace`. It used to append a
  duplicate of every row, and duplicate `attr_label`s silently shadow each other.
- **Two data files in one folder**, unless the sidecar names one with `file:`.
- **A sidecar that is not valid YAML**, with the line and column. A regex or a
  backslash belongs in 'single quotes'.

### Tables of values: `kind: table`

A CSV / TSV / XLSX / Census-API JSON with a geographic code column and numeric
columns, at ANY level. `etl/load_table.py`.

```yaml
id: svi                    # shared by the tract and county files: same codes, two levels
name: CDC Social Vulnerability Index
vintage: 2022              # a range like 2018-2022 is dated by its END year
include: [E_TOTPOP, EP_*, RPL_THEME*]
level: zcta                # only when the codes do not decide it (see below)
missing: [-1]              # extra missing-value sentinels; -999 and the ACS
                           # -666666666 family are already treated as missing
code_rewrite:              # map columns onto EXISTING measure codes
  - ['^(.*)_CrudePrev$', 'PLACES_\1_CrdPrv']
```

- **The level** comes from the sidecar, else the code width: 2 state, 5 county
  or ZCTA, 7 place, 11 tract, 12 block group, 15 block. Codes one digit short (a
  spreadsheet dropped the leading zero) are padded.
- **Five digits is refused unless something decides it**: the column name
  (zcta/zip vs fips/county), or membership (codes matching one level almost
  entirely and the other clearly less). Loading ZIP values as counties puts every
  number on the wrong place with nothing visibly wrong.
- **County** values go to `acs_county_values` plus a catalog row per measure, so
  the planner can use them. **Every other level** goes to `geo_values` with NO
  catalog row: nothing can plan over a tract measure until ops are level-aware.
  `geo_measure` records every (measure, level) either way.
- **Over 50 measure columns is refused** without `include`/`exclude` or
  `--allow-wide`: every column is a search entry.
- **The county vintage**: a current county file carries Connecticut's planning
  regions (091xx) and 02063/02066, which `county_geom` predates. Those rows are
  reported and skipped; load the TRACT file of the same release to fill them.
  For SVI 2022, tract population summed to county matched the county file
  exactly for all 3,133 counties, and filled the 9 the county file could not.

### Rasters: `kind: raster`

A single-band GeoTIFF in EPSG:4326. `etl/load_raster.py`.

```yaml
id: worldpop
name: WorldPop population grid
kind: raster
aggregate: sum             # REQUIRED: sum for counts, mean for rates and fields
vintage: 2025
measure: pop               # code becomes WORLDPOP_POP
zonal_levels: [county, tract, zcta]
```

One load produces three things: the raster itself, tiled in PostGIS
(`raster_<id>`, only tiles holding data), for `geoark_zonal(raster, geometry,
'sum'|'mean'|...)` over any polygon on demand; zonal values for each of
`zonal_levels`; and a **grid pyramid** of real polygons at about 4, 16 and 64 km
(`geo_unit` levels `grid4k`/`grid16k`/`grid64k`), each cell an exact aggregate of
whole pixels. Refused: no `aggregate` (there is no default, because the wrong
one produces a plausible map of nonsense), and any CRS other than 4326 (warp it
yourself with `-r sum` for counts or `-r average` for rates; reprojecting a
count raster with the wrong resampling changes its total).

```bash
make raster-export RASTER=worldpop STATE=29 KM=4      # GeoJSON cells for an area
make raster-export RASTER=worldpop COUNTY=29077 KM=1
```

Writes `deploy/dumps/exports/`. Cells are whole-pixel blocks kept by their
centre; capped at 250,000 cells (California at 1 km is refused; at 4 km it is
not).

### Repeating loads on the server: replay and dumps

```bash
make replay-dry                  # ledger vs this database: current / stale / absent
make replay                      # load what is stale, then relink + reindex + reload
make dump-dataset ID=ing_worldpop_01      # write deploy/dumps/<id>/ (records it in the ledger)
```

On the server: `git pull`, `scp` each dataset folder into `deploy/incoming/`
(and/or each dump folder into `deploy/dumps/`), then `make replay`. Replay loads
only the data half. It never tags and never writes the catalog: those came
through git, tagged on this machine. A raw file whose bytes differ from the
ledger is **refused** (it is not what the catalog rows were written from). With
no raw files, a dump is restored instead; `--prefer-dump` (`ARGS=--prefer-dump`)
uses the dump even when both exist. Measured: the WorldPop raster loads from
raw in 2 minutes and restores from its 56 MB dump in 19 seconds.

**Reloads leave dead rows.** `--replace`, replay and restore delete and
re-insert; three cycles left the 4 km grid partition at 742 MB for 251 MB of
live data. `VACUUM FULL ANALYZE <partition>` reclaims it; autovacuum only makes
the space reusable.

Two traps the first real test hit:

- **DBF truncates column names to 10 characters.** A sidecar entry for `OBJNAM`
  matches nothing when the shapefile column is `Object_Nam`. Run `inspect`
  first and copy the names it prints.
- **Git Bash rewrites `/incoming/x` into `C:/Program Files/Git/incoming/x`**
  before `make` sees it, which is why `DIR` is relative.

Vector formats: `.shp .geojson .gpkg .gdb .kml .fgb`, and CSVs with lat/lon.
`--layer` (or `layer:` in the sidecar) selects one layer from a multi-layer
source.

### Analysis geography: `geo_unit` (Phase 2 of the data plan)

```bash
make geo-units-dry                         # what would load
make geo-units                             # state, county, tract, bg, zcta, place
make geo-units LEVELS=tract STATES=29      # a quick trial on one state
make crosswalks                            # zcta->county and zcta->tract area weights
make geo-verify                            # counts, nesting, weights, sizes; changes nothing
```

Loads the TIGER geodatabases already in the archive into `geo_unit`, keyed
`(level, geoid)`, with parent keys, TIGER's interior point, and pre-simplified
display tiers. **Nothing reads these tables yet**; see
docs/DATA_LOADING_PLAN.md and CLAUDE.md for what was measured.

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
