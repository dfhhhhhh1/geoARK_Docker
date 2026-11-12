# Data loading and multi-scale geography: plan

Status (2026-10-30): **Phases 1-5 built**, Phase 6 in part (the cross-level
SQL and its use on the map; the planner's ops are not yet ported), Phase 7 not
started. Phase 2 has no blocks; Phase 4 no COG conversion or `mode`. See
"Progress" at the end for what was measured and where it departed from the
plan. Usage is in [RUNBOOK.md §5a](RUNBOOK.md). This file plans for three things:

1. A drop-in loading process, with metadata, that the server can replay.
2. Geographies other than counties (tract, block group, block, ZCTA, place,
   and grid cells) treated as first-class: stored, computed on, and displayed
   when the map is zoomed in far enough.
3. Rasters kept as rasters, so they can be summarised to **any** geography,
   not only counties, and exported as GeoJSON at a scale someone chooses.

The first revision of this plan put finer geographies last and turned rasters
into county numbers at load time. That would have thrown information away
during loading. This revision sets the storage model up for every scale from
the start, and adds the code that uses each scale one step at a time.

---

## 1. Where things stand

| | Today | Problem for multi-scale |
|---|---|---|
| Values | `acs_county_values (fips, census_code, year)` | the key **is** a county |
| Geometry | `county_geom` (3,233); `place_geom` (places, ZCTAs, CBSAs, urban areas) | place_geom is only for filtering BY; it holds no values |
| Op contract | every op yields `(fips, value)` | about 14 backend files assume `fips` |
| Display | Leaflet, one GeoJSON of all counties | fine at 3k polygons; impossible at 85k tracts or 8M blocks |
| Rasters | refused at ingest | — |
| On disk already | `tiger/tlgdb_2026_us_substategeo.gdb` (holds tracts and block groups, not yet loaded); `raster/usa_pop_2025_CN_1km...tif` (37 MB) | — |

## 2. Decisions taken

- All shapes are wanted: county tables, features, rasters, and finer
  geographies.
- Metadata comes as a sidecar file the user writes, or as the official
  FGDC/ISO XML; both are parsed, and the model fills only the gaps.
- Server sync uses **both** replay from raw files (the default) and database
  dumps (for large layers). With rasters and blocks, dumps matter more than
  first assumed.
- The server has an **8 GB GPU**, so all tagging happens on this machine and
  reaches the server through git. Nothing in this plan puts new load on the
  GPU: geometry, tiles and raster statistics all run in Postgres.

---

## 3. The core change: the geography is a level plus an id

Every value is keyed by **which kind of unit** it describes as well as which
unit:

```
(fips, value)              ->   (level, geoid, value)
'29077', 14.1                   'county', '29077',       14.1
                                'tract',  '29077000100', 22.7
                                'zcta',   '65804',       11.3
                                'grid1k', 'r4512c8833',  412
```

### Geography registry: `geo_unit`

One table for every analysis unit, keyed `(level, geoid)`:

| column | why |
|---|---|
| `level` | `state`, `county`, `tract`, `bg`, `block`, `zcta`, `place`, `cbsa`, `grid1k`, `grid4k`, ... |
| `geoid` | the Census GEOID, or a grid cell id |
| `name` | for display and the hover readout |
| `state_fp`, `county_fips` | **parent keys**. Tract, block group and block nest exactly inside a county, so rolling up is `LEFT(geoid, 5)`, with no geometry involved |
| `aland` | land area, so `per_area` works at every level |
| `geom` | full resolution, used for calculations |
| `geom_z6`, `geom_z9`, `geom_z12` | pre-simplified copies for display at a zoom tier. Simplifying is done once at load time, never per request |

`county_geom` and `place_geom` stay exactly as they are. The county rows are
*also* written into `geo_unit`. Nothing that works today gets touched until
an op is ported on purpose.

### Values: `geo_values`

`(level, geoid, code, year, value)`, **partitioned by level**. Each level's
size grows by about 30x over the one above it (county 3k, tract 85k, block
group 240k, block 8M), so partitioning keeps a county query from ever
scanning tract rows. `acs_county_values` stays and becomes, in effect, the
county partition. A compatibility view keeps every existing county op and the
48-context prompt snapshot byte-identical.

### Levels that do not nest: crosswalks

Tracts, block groups and blocks nest inside counties. **ZCTAs, places and grid
cells do not**: a ZIP area can cross county lines. Moving a value between
levels like that needs weights, not a key:

`geo_crosswalk (from_level, from_geoid, to_level, to_geoid, w_area, w_pop)`

The weights are built once from geometry overlap. `w_pop` uses block
population, which is the standard method and the reason blocks are worth
loading even if they are never drawn. "Median income by ZIP, rolled up to
county" then becomes a weighted join instead of a guess.

### `attribute_source` gains the levels each measure exists at

A measure such as poverty rate may exist at county, tract and block group.
The catalog keeps **one row per measure, not one per level**. Levels are a
property of the measure, for the same reason the year became a column: one
row per level would triple the search corpus, and corpus size is what limits
retrieval (CLAUDE.md).

---

## 4. Rasters: keep the raster and derive everything else from it

### Why not store the raster as GeoJSON

A 1 km grid of the US is roughly 9-10 million cells. As GeoJSON polygons that
is several GB: no browser can draw it and no query would want it. A raster is
already the compact form of that data. The right move is to keep it as a
raster and produce vectors (GeoJSON) **for the area and scale someone actually
asks for**.

### Three ways to use the same raster

| Use | How | Output |
|---|---|---|
| **Statistics for any geography** | PostGIS raster, tiled in the database (`postgis_raster` is present in the db image, not yet enabled). Zonal statistics (`ST_SummaryStats` over `ST_Clip`) run in SQL, inside the same read-only transaction as everything else | values at county, tract, ZCTA, city, a 10-mile buffer, or a user's own polygon |
| **A vector grid at a chosen scale** | a pre-built pyramid of grid cells aligned to the raster's own pixels: 1 km, 4 km (4x4 pixels), 16 km, 64 km, stored as `geo_unit` levels `grid1k` ... `grid64k` | real polygons with values, GeoJSON-exportable, drawn at a zoom where their count fits |
| **Show the raster itself** | image tiles produced from the database or from a Cloud-Optimized GeoTIFF | a continuous surface, cheap at any zoom |

**The grid cells follow the raster's own pixel boundaries, so they do not
need resampling.** A 4 km cell is exactly the sum (or mean) of 16 source
pixels, so totals are preserved exactly. Reprojecting to an equal-area grid
would resample, and resampling a population count changes the total. Each cell
stores its true `aland`, so densities stay correct even though cells in
latitude/longitude are not all the same size.

**The sidecar says whether to sum or average the raster** (`aggregate: sum` for
population, `mean` for temperature or elevation, `mode` for land cover). The
code cannot infer this, and choosing wrong produces a plausible map of
nonsense.

**"Give me this as GeoJSON at 2 km for Missouri"** is an export that
vectorises the raster clipped to that area at that resolution, with a cap on
the number of cells. It returns a file and is never drawn as one layer.

The source of truth is the file itself, converted to a Cloud-Optimized GeoTIFF
in the archive. The database copy can always be rebuilt from it.

### Test case already on disk

`usa_pop_2025_CN_1km_R2025A_UA_v1.tif`. The check is not "it loaded" but **the
zonal sum per county against the ACS county population**: a close match proves
the CRS, the nodata handling and the sum aggregation all at once.

---

## 5. Display: decide by how many features are on screen, not by zoom level

Zoom level alone is the wrong trigger. Zoomed in on Manhattan, a screen holds
hundreds of tracts; at the same zoom over Nevada, it holds a dozen. The rule
is:

> Draw the **finest level whose feature count inside the current viewport is
> under a budget** (about 3-5k polygons, the size the county map already draws
> comfortably), and never finer than the data exists at.

Counting features in the viewport is a cheap indexed query on `geo_unit`. Going
from coarse to fine as you zoom in:

```
nation        county (3.2k)          grid64k
state         tract  (~1.5k in MO)   grid16k
metro         block group            grid4k
neighborhood  block                  grid1k
```

### How the geometry gets to the browser

Two options. The plan builds the first and leaves room for the second.

**A. A viewport GeoJSON endpoint (fits the current Leaflet map).**
`GET /api/geo?level=tract&bbox=...&z=10&code=...&year=...` returns the
simplified geometry for that zoom tier, joined to the values and capped at the
budget. It reuses the existing `ChoroplethMap` almost unchanged, and is enough
for county, tract, block group and the coarser grids.

**B. Vector tiles straight from PostGIS (`ST_AsMVT`).** No new service is
needed: the API returns tiles directly from SQL. This is what makes **blocks
(8M) and the 1 km grid** drawable at all, because the browser only ever holds
what is on screen. It needs either the `Leaflet.VectorGrid` plugin or a move to
MapLibre GL. That is a frontend decision with a cost, and it is deferred until
A has been used.

**Quantile bins have to stay stable while panning.** If the colour bins were
recomputed per viewport, the same tract would change colour as you pan past
it. Bins are computed once for the whole (level, area-of-analysis) and sent with
the first response.

---

## 6. Calculations at other levels

Most ops already work at any level once `fips` means `(level, geoid)`. Only a
few need real thought:

| Op | At finer levels |
|---|---|
| `load`, `normalize`, `rank`, `filter_attr`, `combine`, `outlier`, `correlate` | unchanged; both inputs must share a level, and the validator enforces it |
| `filter_area`, `filter_place` | via the parent key (`state_fp`, `county_fips`) or the existing 1%-overlap test |
| `per_area` | `aland` exists on every level |
| `count_features`, `count_near`, `nearest_distance` | same SQL, joined to `geo_unit`; keep the `&&` prefilter and the `<->` KNN rules from CLAUDE.md |
| `hotspot` | needs neighbours per level: `tract_neighbors` is about 500k pairs, built once like `county_neighbors` |
| `explain` | needs its control series (income, % 65+, % rural) at the same level |
| **new `aggregate_to`** | fine to coarse: by parent key where levels nest, by crosswalk weight where they do not |
| **new `apportion`** | coarse to fine, or between non-nesting levels, using `w_pop` or `w_area`; always labelled an estimate in provenance |
| **new `zonal`** | a raster summarised to any level or polygon |

**Display level and analysis level are different things.** A county answer can
be *drawn* over tracts for context, and a tract answer can be *rolled up* for a
national view. The response carries both levels.

### The planner comes last, and is measured separately

The level field in `load` gets the same gate as `year`: it enters the
decoding schema and the prompt only when the question names a finer unit
("by tract", "ZIP code", "neighborhood", "block group", "1 km grid"). For
every other question the 48-context snapshot stays byte-identical, so nothing
measured so far is affected. It then gets its own `plan_probe.py` run, 3x.

**Before the planner knows about levels, levels are already reachable through
follow-ups.** "Show this by tract" is an edit to the existing plan, applied in
code, the way "what about Texas" already works (`backend/followup.js`). That
makes finer levels usable without spending any of the planner's op budget.

---

## 7. Loading: one entry point, a sidecar, a ledger

### The dataset folder and the sidecar

```
deploy/incoming/svi_2022/
  SVI_2022_US.csv              the data
  svi_2022.meta.yaml           optional; written by the user
  SVI_2022_US.xml              optional; official metadata, parsed if present
```

```yaml
name: CDC Social Vulnerability Index
kind: table                     # table | features | raster | boundaries
level: tract                    # county | tract | bg | block | zcta | place | state
geo_column: FIPS
vintage: 2022                   # or year_column: YEAR
description: Relative social vulnerability of every census tract.
source_url: https://www.atsdr.cdc.gov/placeandhealth/svi/
license: public domain
originator: CDC/ATSDR
include: [RPL_*, EP_*]          # allowlist; wide releases bloat the corpus
columns:
  RPL_THEMES: {desc: Overall vulnerability percentile, units: percentile}
probe: "social vulnerability index"   # search check, see below
# raster only:
aggregate: sum                  # sum | mean | mode
grid_levels: [1k, 4k, 16k, 64k]
```

The level is detected from GEOID length when it is not given (2 state, 5
county, 11 tract, 12 block group, 15 block), and the sidecar overrides it. A
ZCTA and a county are both 5 digits, so for those the sidecar or the column
name has to decide. **That case refuses rather than guesses**, because the two
look identical and mean entirely different areas.

### One command

`make ingest DIR=svi_2022` (relative to `deploy/incoming/`) dispatches on `kind`:

| kind | handler |
|---|---|
| `table` | **new** generic reader: CSV/XLSX, wide or long, any level → `geo_values` |
| `features` | the existing `ingest.py` vector path |
| `raster` | **new**: write a COG to the archive, load into PostGIS raster, build the grid pyramid |
| `boundaries` | `load_boundaries.py`, extended to write `geo_unit` |

Without `--commit` it writes nothing, like every loader here.

### Load ledger: `etl/data_manifest.yaml`, in git

```yaml
- id: svi_2022
  kind: table
  level: tract
  files: [{path: svi_2022/SVI_2022_US.csv, sha256: ..., bytes: ...}]
  loaded: 2026-10-20T14:03Z
  codes: [SVI_RPL_THEMES, ...]
  catalog_labels: [ing_svi2022_01, ...]
  rows: 84120
  units_covered: 84120 / 85190 tracts
  dump: null
```

### Checks after every load

1. `validate_catalog.py`.
2. Coverage against `geo_unit` for that level: units with values and units
   without. Below the partial threshold, the coverage goes into the
   description.
3. **The search check.** `probe` is run against `/api/unified-search`; the new
   attribute's rank is reported and appended to `eval/known_item.yaml`. This is
   the only test of whether a dataset can be *found*.
4. A warning for near-duplicates of existing attributes (the "42 unemployment
   attributes" problem).
5. Rasters only: zonal sum per county compared with a known county total, when
   one exists.

### Server sync

**Replay** (default): commit the catalog and the ledger, `scp` the dataset
folder, `git pull`, then `make replay`. Replay loads every ledger entry whose
files are present and whose data is missing or stale (by sha256). It
**never tags and never writes the catalog**, so the server gets exactly the
tags tested here.

**Dump** (large data): `make dump-dataset ID=...` writes a `pg_dump` of that
dataset's tables, partitions or raster table. `make replay` restores it when it
is present, instead of reloading. For blocks, the 1 km grid and rasters, this
is the expected route, not a shortcut.

**Size check for the server.** *Measured in Phase 2, and the estimate here was
wrong:* tracts are 1.15 GB and block groups 2.06 GB, not "under 1 GB
together"; all of `geo_unit` is 4.7 GB. Full-resolution TIGER geometry is ~85%
of it. At that density national blocks would be tens of GB, so blocks are
**loaded per state, on request**, and the server needs its free disk checked
before `make geo-units`. The 1 km raster plus its grid pyramid is still an
estimate (a few GB).

---

## 8. Phases

Each phase leaves the system working and adds one capability.

**Phase 1: foundation.** Sidecar and XML parsing, keeping `gen_desc`, the
ledger, the `make ingest DIR=` dispatcher, and a corpus reload in place of the
`make up` advice. The `geo_unit` and `geo_values` tables are created and county
rows are copied in, with nothing reading them yet.
*Done when:* a GeoJSON with a sidecar ingests with real descriptions, and the
snapshot and every eval suite are unmoved.

**Phase 2: tract, block group and ZCTA geography.** Load from the TIGER
geodatabase already on disk into `geo_unit`, with simplified tiers and parent
keys. Build the ZCTA↔county and ZCTA↔tract crosswalks. Blocks for one state, to
measure size.
*Done when:* the counts match TIGER, every tract rolls up to a real county,
and the sizes are recorded here.

**Phase 3: tables at any level, and replay.** The generic table reader, with
level detection and the ambiguity refusal; `make replay` and `make dump-dataset`.
*Test data:* CDC SVI and FEMA NRI (both published at county **and** tract),
and ACS 5-year at tract.
*Done when:* tract SVI rolled up to county matches the published county SVI
within rounding, and a fresh server database reaches the same `/api/health`
counts as this machine.

**Phase 4: rasters.** `postgis_raster`, the COG archive, the grid pyramid,
`zonal`, and GeoJSON export clipped to an area at a chosen scale.
*Done when:* the population raster's zonal sum per county is close to ACS county
population, and a grid cell's 4k value equals the sum of its 16 1k cells exactly.

**Phase 5: multi-scale display.** `/api/geo` with simplified tiers, the
viewport feature-count rule, stable bins, and a level control on the map.
*Done when:* zooming from the nation to a city moves county → tract → block
group with no request over budget, measured in the browser.

**Phase 6: ops at other levels, reached through follow-ups.** Port ops one at a
time onto `(level, geoid)` with the validator's same-level rule; add
`aggregate_to`, `apportion` and `tract_neighbors`. Expose "show this by tract"
as a follow-up edit.
*Done when:* each ported op has tests at two levels, and the county snapshot is
byte-identical.

**Phase 7: the planner learns levels.** Phrasing-gated `level` field and the
cross-level ops in the prompt. `plan_probe.py` with new tract and ZIP
questions, 3x.

**Later: vector tiles** (blocks and the 1 km grid on screen), depending on the
Leaflet.VectorGrid vs MapLibre decision.

---

## 9. Decisions still open

| Decision | Leaning | Decide by |
|---|---|---|
| Leaflet + VectorGrid, or move to MapLibre GL | Leaflet: Phase 5 runs on a canvas renderer at 3,600 polygons / 8,000 cells per view without strain. The limit is payload (ZIP areas ~3 MB per view), not drawing. Revisit with blocks | blocks |
| Blocks: per state on request, or national | per state | Phase 2 size measurement |
| Grid shape: raster-aligned squares, or H3 hexagons | squares (exact sums, no extension); H3 is a later option for equal-area analysis | Phase 4 |
| How long to keep the old county tables | until every op is ported | Phase 6 |

## 10. Progress

### Phase 1, built 2026-10-16

- `etl/dataset_meta.py`: sidecar + XML (FGDC, ISO 19115, ISO 19110, ArcGIS)
  parsing and merging, and the ledger. `etl/test_dataset_meta.py`, 19 tests,
  including the real HSIP ISO file.
- `etl/ingest.py --dir`: kind detection (features load; table, raster and
  boundaries are recognised and refused with their phase), `include` /
  `exclude` / `skip`, descriptions and units into `attr_desc`, `gen_desc` kept,
  years into start/end date, `--replace`, ledger entry.
- `make inspect|ingest DIR=`, `make reload-corpus`, `make ledger`.
- `etl/schema_geo.sql`: `geo_unit`, `geo_values` (no county partition, by
  design), `geo_values_all`, `geo_crosswalk`.
- Tested end to end on a real HSIP shapefile with ISO XML and a sidecar, into
  scratch copies of the catalog: CRLF preserved, validation clean, a second load
  refused, `--replace` leaves exactly one copy.
- *Done-when check:* the catalog is byte-identical (corpus cache key unchanged),
  the prompt snapshot is identical across 48 contexts, and no backend file was
  touched, so the retrieval and planner suites cannot have moved and were not
  re-run.
- **Departures:** the ledger is `etl/data_manifest.yaml`, not
  `data/manifest.yaml`, because `etl/` is already mounted writable in the ETL
  container. `DIR` is relative to `deploy/incoming/`, because Git Bash rewrites
  absolute `/incoming/...` arguments. The `probe` is recorded but not yet run
  automatically.

### Phase 2, built 2026-10-16 (blocks deferred)

`etl/load_geo_units.py`, `make geo-units | crosswalks | geo-verify`.

| level | units (= TIGER) | on disk |
|---|--:|--:|
| state | 56 | 16 MB |
| county | 3,233 (from county_geom) | 27 MB |
| tract | 85,529 | 1,154 MB |
| bg | 242,748 | 2,055 MB |
| zcta | 33,791 | 1,028 MB |
| place | 32,642 | 308 MB |

Levels load in 8 minutes. Crosswalks, full resolution, geodesic areas:

| crosswalk | pairs | coverage | per ZCTA | time |
|---|--:|---|---|--:|
| zcta → county | 46,683 | every ZCTA; 3,231 of 3,233 counties | mean 1.38, max 6 | 7 min |
| zcta → tract | 165,583 | every ZCTA; 85,150 of 85,529 tracts | mean 4.90, max 53 | 15 min |

Shares sum to 1 per ZCTA within 7e-16. The tracts with no ZCTA are mostly
water and unpopulated land, which ZCTAs (built from addresses) do not cover.
0 invalid geometries. Every block group has its tract, and every block group's
county equals its tract's.

**The county vintage problem**, which the plan did not anticipate: county_geom
predates Connecticut's 2022 planning regions and the 2019 Valdez-Cordova split,
so 883 tracts and 2,722 block groups have a county code that does not exist
there. They are assigned to the old county they overlap most. Fit is
>= 98.2% for every one, so "a tract rolls up to a county" still holds by key.

**Blocks are not loaded.** They are not in the national geodatabases on disk
and need a per-state TIGER download. Given the measured density, blocks stay
per state, on request.

### Phase 3, built 2026-10-16

`etl/load_table.py` (kind: table), `etl/replay.py`, `make replay | replay-dry |
dump-dataset`, and `geo_measure` / `dataset_load` in `etl/schema_geo.sql`.
`etl/test_load_table.py`, 14 tests.

Test data, downloaded for this:

| dataset | level | rows | values | measures |
|---|---|--:|--:|--:|
| CDC SVI 2022, tracts (61 MB) | tract (11-digit) | 84,120 | 2,505,539 | 30 |
| CDC SVI 2022, counties (2.3 MB) | county (column name `FIPS`) | 3,144 | 93,990 | 30 |
| CDC PLACES 2025, ZCTA (24.8 MB) | zcta (sidecar) | 32,520 | 1,204,083 | 41 |

- **The roll-up check passes exactly.** SVI tract population summed to county
  equals the county file for **all 3,133** counties both have, and the tracts
  fill the 9 the county file cannot (the 8 old Connecticut counties and
  Valdez-Cordova, whose current-vintage codes county_geom lacks).
- **PLACES at ZCTA reuses the county codes** (`code_rewrite`), so 40 measures
  now exist at two levels as one measure each, and borrow the county
  measure's description.
- **Replay and dumps, round-tripped**: SVI tract deleted then replayed from the
  raw CSV (2,505,539 values, identical); SVI county and PLACES ZCTA dumped,
  deleted, restored (identical); a features layer replayed and restored through
  pg_dump (77 rows, indexes intact); a changed raw file refused by name.
- **Not run against a second database.** "A fresh server reaches the same
  counts" was tested by deleting and restoring inside this one. The first real
  `make replay` on the server is the true test.
- **Pending: the SVI county catalog rows** (30) and the WorldPop county row (1)
  were written to a scratch copy of the catalog, not the real one, because a
  separate session was measuring retrieval on this stack at the same time and a
  corpus change would have confounded both. The values and attribute_source
  rows are loaded. To finish: `make ingest DIR=svi_county ARGS=--replace` and
  `make ingest DIR=worldpop ARGS=--replace`, then known_item.yaml against the
  baseline in `eval/dataload/ki-before.json` (91.7% / MRR 0.944).
- **Departures:** wide tables only; long format (one row per unit x measure)
  is still the job of `load_county_values.py` for ERS/PLACES/CHR. The Census API
  now requires a key, so Census-API JSON input is supported but was tested only
  in unit tests.

### Phase 4, built 2026-10-16

`etl/load_raster.py` (kind: raster), `etl/raster_export.py`, `make
raster-export`, `raster_layer` + `geoark_zonal()` + grid partitions in
`etl/schema_geo.sql`. `etl/test_load_raster.py`, 8 tests.

Test data: the WorldPop 2025 constrained 1 km population raster already in the
archive. 43,071 x 6,298 pixels, 6,083,321 valid, **total 346,373,570**. The full
load is 2 minutes; a restore from its dump is 19 seconds.

| product | units | time | size |
|---|--:|--:|--:|
| raster tiles (128 px, data-bearing only) | 1,128 tiles | 4 s | 30 MB |
| zonal: county | 3,142 of 3,233 | 8 s | |
| zonal: tract | 84,378 of 85,529 | 29 s | |
| zonal: ZCTA | 33,631 of 33,791 | 33 s | |
| grid4k (4x4 px) | 613,889 cells | | 251 MB + 88 MB values |
| grid16k (16x16 px) | 48,526 cells | | 20 MB |
| grid64k (64x64 px) | 3,745 cells | | 2 MB |

What was checked, and the result:

- **Conservation.** Every grid level sums to the raster total within 0.0001.
  Zonal sums capture 99.79% (county), 99.91% (tract), 99.78% (ZCTA); the rest
  lies outside every unit (coastal pixels beyond county_geom's clipped shoreline,
  land no ZCTA covers). Units too small for any sub-pixel take their interior
  pixel scaled by area: 17 tracts and 80 ZCTAs, which over-counts by 26,821
  (0.008%) and 6,604 (0.002%), stated in the load output rather than hidden.
- **Exactness.** All 48,526 grid16k cells equal the sum of their 16 grid4k
  children (max relative difference 6e-16), and `geoark_zonal()` over a grid4k
  cell reproduces its stored value exactly.
- **Against an independent count.** County zonal sums vs SVI's ACS 2018-2022
  population: Pearson 0.997 over 3,133 counties, total ratio 1.044 (WorldPop is
  UN-adjusted 2025), median ratio 0.96, 5th-95th percentile 0.77-1.12. The
  spread is WorldPop's model against the Census, not the pipeline. Puerto Rico
  and the island areas lie south of the raster's 18.9N edge and have no value.
- **Export.** Greene County MO at 1 km: 2,557 cells, total 315,630, within
  0.08% of the sub-pixel county value (whole cells by centre vs sub-pixel
  weighting). Missouri at 4 km: 16,713 cells, 6.29M. California at 1 km refused
  by the 250,000-cell cap.
- **Departures:** the raster is stored in PostGIS only; the plan's COG copy in
  the archive is not made (the original GeoTIFF is the source of truth; COG
  matters when tiles are served straight from a file, Phase 5). `aggregate:
  mode` (land cover) is not implemented. Pyramid factors are powers of two from
  pixel HEIGHT: sizing by width at the raster's mid-latitude (45N, dragged north
  by Alaska) gave 8x8-pixel "4 km" cells.

### Phase 5, built 2026-10-30

`backend/geo_layers.js` (`GET /api/geo/catalog`, `GET /api/geo/layer`),
`frontend/src/components/ExplorePage.tsx` at `/explore` ("Explore map" in the
header). `backend/test_geo_layers.js`, 14 tests.

- **The level rule works as designed**: the finest level whose unit count in
  the view's bounding box fits a budget (3,600 polygons, which admits every
  county; 8,000 grid cells or pixels). Over budget at every level, it refuses
  to draw rather than draw a truncated subset. Measured on a 1440x900 window:

  | view | WorldPop (grid) | SVI | PLACES |
  |---|---|---|---|
  | lower 48 | 64 km grid, 3,464 cells | counties, 3,220 | counties, 3,220 |
  | a state (z7) | 16 km grid, 1,887 | counties, 896 (14.3k tracts) | ZIP areas, 1,991 |
  | a metro (z9-10) | 4 km grid, 1,800 | tracts, 1,042 | ZIP areas |
  | downtown (z12) | 1 km pixels, 1,703 | tracts | ZIP areas |

  Responses 8-400 ms once warm; worst payload ~3 MB (ZIP areas at z9).
- **Breaks are national and computed once** per (measure, level, year, unit),
  so a unit keeps its colour while panning. Densities are skewed (most 4 km
  cells are rural), and even sixths put a whole metro in the top class, so
  densities use breaks at the 35/60/80/92/98th percentiles. The legend states
  the percentiles used.
- **Counts are shown per km²** by default (a tract count map is flat: tracts
  are drawn to hold ~4,000 people). Toggle off to see raw counts; the readout
  always gives both.
- **Pixel-level breaks first cost 11 s** (geodesic area of every sampled
  pixel). A pixel's area depends only on latitude, so it is computed
  analytically now: 2 s, then cached, and warmed in the background.
- **Two frontend bugs found by looking**: the first view was degenerate (Leaflet
  measured the container before it had a size; the API rejected the bbox), and
  a linked view (`?at=lat,lng,zoom`) was overwritten by the default fit. The
  link is now the map's initial props, so no effect races it.
- **Not built**: vector tiles; year selection in the UI (every loaded measure
  has one year); the hover readout on touch devices.

### Phase 6, in part, 2026-10-30

`geoark_level_link`, `geoark_aggregate` and `geoark_apportion` in
`etl/schema_geo.sql`: the two moves between levels every level-aware op will
use. Each returns its coverage; a derived value built from half its parts must
not look like a stored one.

Validated against values the source publishes, which is the only way to know a
derivation is right:

| check | result |
|---|---|
| SVI population, tract -> county, `sum` | **exact** for all 3,133 counties |
| SVI % below 150% poverty, tract -> county, population-weighted | r 0.9975, mean abs error 0.22 pp |
| PLACES diabetes, ZCTA -> county through the crosswalk, population-weighted | r 0.978, mean abs error 0.36 pp |
| county population apportioned to tracts by WorldPop, vs each tract's own count | r 0.859, median error 11% |
| apportion, then aggregate back | every county within 3e-8 |

- **The poverty outliers are group quarters** (largest: Fort Benning's
  Chattahoochee, 42.6% group quarters, derived 28.7 vs published 40.0; state
  prisons; Ohio University). Poverty is measured over the population whose
  status is determined, so total population is the wrong weight there. The
  right weight (the poverty universe) is not loaded.
- **Apportioning is an estimate and is labelled one.** A median 11% error per
  tract is the real cost of spreading a county total by a modelled population.
- **On the map**, `/api/geo/layer` uses them two ways. *Fill*: a stored level
  with gaps gets them estimated from a finer level: Connecticut's 8 old counties
  and Valdez-Cordova for SVI (from tracts) and PLACES (from ZIP areas); 30
  counties nationally for PLACES diabetes. *Derived level*: SVI has a ZIP-area
  level built from tracts that it was never loaded at. Estimates are drawn with
  a dashed outline, the panel says how many and how, and the readout gives the
  parts and coverage ("estimate from 65 census tracts, population-weighted").
- **Never for percentile ranks**: a population-weighted mean of tract
  percentiles is not a county percentile, so SVI's RPL themes stay blank in
  Connecticut, and say so. Counts are summed; rates are weighted by the same
  dataset's population, else WorldPop's, and not offered when neither exists.
- **Analysis answers link to it**: when an answer's measure exists below county
  (stored or estimated), its follow-up bar offers "Zoom in: <measure> by ZIP
  code areas", opening the explore map on that measure.
- **Not done, deliberately**: porting the planner's ops (`load`, `rank`,
  `hotspot`...) onto `(level, geoid)`, `tract_neighbors`, and "show this by
  tract" as a plan edit. A separate session had uncommitted edits in
  `backend/planner/ops`, and every planner change here is measured with GPU
  probe runs that would have competed with its evaluation. The map-side pieces
  above do not touch the planner: the prompt snapshot is byte-identical across
  48 contexts and the backend suite passes.
- First view of a measure with fills costs one national `geoark_aggregate`
  (0.3-2 s, measured up to 5 s cold with everything else), then is cached in
  the API process.

### Phases 6-7, the planner at other levels, 2026-11-11

`backend/planner/levels.js`, tests `planner/test_levels.js` (10). Measured with
`eval/research_advanced.yaml`'s `phase_e` tier; numbers in RESEARCH_PLAN.md,
Phase E.

- **The model never picks the level.** A question that wants tracts says so
  ("census tracts", plural "ZIP codes", "4 km grid cells"), so the unit is read
  from its words after planning and set as `plan.level`. The decoding schema
  and prompt are byte-identical across all 48 contexts. A question that names
  counties as its answer ("each Michigan county", "in which Missouri
  counties") keeps the county even when it mentions tracts: that is a roll-up,
  and answering it with tract rows would be the wrong unit. 5 of 151 eval
  questions get a level.
- **A level is set only when every loaded measure has it** (`geo_measure`).
  Otherwise the plan goes back for repair with the candidates that do, by
  label: "Uninsured has no values by census tract. These on the list do: a5
  Percent of persons without health insurance", and the next attempt used it.
- **Ported:** `load` (geo_values_all), `filter_area` (geo_unit.state_fp; a ZIP
  area through the crosswalk, >= 50% of it), `filter_place` (the same 1%
  overlap rule against the unit's own geometry), `per_area` (geo_unit.aland),
  and the output (geo_unit at its z12 tier). `rank`, `filter_attr`,
  `normalize`, `join`, `intersect`, `combine` read only `(fips, value)` and
  need nothing. Everything else is refused at another level with a sentence,
  never compiled at the county level by accident. County SQL is unchanged
  (tested: no geo_unit / geo_values in it).
- **The level is inlined in one place** (the output's geo_unit join), from a
  closed set; a level outside it compiles as the county.
- Verified by executing compiled SQL: St. Louis city tracts by % below 150% of
  poverty return exactly the gold's top three (70.7, 69.3, 67.7), 453 ms.
- **Found on the way:** none of the 31 catalog rows the ledger records for CDC
  SVI (county) and WorldPop were in the catalog. Something rewrote it after the
  2026-10-16 ingests; their values resolved and nothing could retrieve them.
  `etl/restore_ledger_catalog.py` puts back what the ledger lists (the tagger's
  original tags are lost; tags are rebuilt from descriptions). Retrieval
  guards after: known-item 91.7% / 0.944, concept 97.8 / 97.3%, concept MRR
  0.737 -> 0.750. Seven SVI race/ethnicity codes had no sidecar description
  ("EP_AFAM"); the CDC definitions are now in both SVI sidecars.
- **Roll-ups: finer data, county answers** (`ops/aggregate_to.js`, internal:
  in no ordering, never offered, so again nothing the model sees changes).
  "Using census tract data ... each Michigan county" and "which Missouri
  counties vary most from one tract to another" keep the county as the answer
  unit; `applyRollup` marks each load to read tracts and inserts the roll-up
  right after it, so the rest of the plan is an ordinary county plan. Rates
  are weighted by the same dataset's population (SVI), else WorldPop's;
  counts are summed; spread phrasing takes the standard deviation of a
  county's tracts (3+). Tract and block group only: they nest in counties, a
  grid cell does not. Compiled SQL against hand-written gold: Michigan 83 of
  83 counties within 0.01, Missouri spread top 10 exactly.
- **At a named unit, only measures with values there are offered.** The
  candidate list is filtered to measures `geo_measure` has at that level,
  topped up from everything retrieval found; a unit holding five or fewer
  measures gets all of them. "Uninsured rate for every census tract" chose CHR
  Uninsured (county only), was sent back naming SVI's, and the next two
  attempts broke the plan rather than switch; with the filter it plans SVI on
  attempt 1 and returns all 104 St. Louis city tracts.
- **The analysis map draws other levels.** It joins counties from a shipped
  file, so a tract answer used to draw nothing. Any level but the county now
  always carries its geometry (z12 tier, a few hundred bytes a tract) and the
  map draws it; the response says `level`.
- **Two repairs this needed, both deterministic:** a place named "Cook County"
  becomes a county restriction (an internal place kind, not in the enum), and
  a plan that restricts to nothing while the question names exactly one state
  gets that state (the grid question ranked all 613,889 US cells in 190 s for
  "in Colorado"; the same failure as the old `r-fire-stations-co` flake).
  "In the city of St. Louis" now passes the area gate.
- **Ported 2026-11-11:** `nearest_distance` (from `geo_unit.pt`) and
  `count_near` (a LATERAL probe per unit: the plain join was 95 s at tract,
  1.5 s after), both equal to brute force; details in RESEARCH_PLAN.md
  Phase E.
- **Not done:** a crosswalk lookup ("which counties does ZIP 65721 fall in"),
  ZIP -> county roll-ups (they need crosswalk shares), `tract_neighbors` and
  the statistics ops at other levels, and city names with no state at tract
  level (Denver: five other states' Denvers, which is the user's to settle).

## 11. Sources

None of these have been checked for current availability yet.

| Source | Levels | Why |
|---|---|---|
| Census ACS 5-year, 2019-2024 | county, tract, block group | time depth, and the backbone of every finer level |
| Decennial census (P.L. 94-171) | block | the population weights every crosswalk needs |
| CDC PLACES | county, tract, ZCTA, place | health measures at four levels |
| CDC SVI, FEMA NRI | county, tract | Phase 3 test data, with a county version to check against |
| EPA EJScreen (archived copies) | block group | environmental burden |
| Census LODES | block | where people work |
| NOAA nClimDiv | county | rainfall and temperature |
| PRISM / gridMET, NLCD, USGS 3DEP | raster | climate, land cover, elevation for Phase 4 |
| BEA, BLS LAUS / QCEW, HRSA AHRF, USDA ERS | county | economy and health workforce |
| HIFLD successors, EIA, NCES EDGE, EPA FRS, PAD-US, NIFC | features | the 22 missing HSIP layers and more |
