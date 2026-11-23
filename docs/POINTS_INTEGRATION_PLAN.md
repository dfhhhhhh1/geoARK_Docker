# Fine-point (block centroid + hexagon) integration plan

Status: plan only, nothing loaded. Written 2026-11-22.

## 1. What exists and where

### The points (this is the file you want)

`/scratch/US_L48GeoARK_TEMP/US_L48GeoARK.gdb` (168 GB, ESRI File Geodatabase)

| Layer | Geometry | Rows | Notes |
|---|---|---|---|
| `L48_All_Pt_Blk1020ZipHUC_TH_Area` | Point | **118,158,718** | The 2020 block centroids plus the hexagon tessellation points (`GRID_ID`, e.g. `RQN-7387`), with block 2010/2020, ZIP and HUC12 attached and every precomputed distance |
| `l48pts` | none | 118,158,718 | Same attributes, no geometry (a table copy) |

- **CRS:** ESRI:54034 World Cylindrical Equal Area, metres. The app uses EPSG:4326.
- **Keys:** `OBJECTID`, `Block20` (15-digit 2020 block GEOID), `GRID_ID`, `Blk10`, `ZIP_CODE`, `huc12`.
- **Distances (metres), each a pair of `F_<x>` (nearest feature's FID) and `D_<x>` (distance):**
  Airport, Biodsl, ChldCare, CnsMinOp, CrshStOp, FeMines, EMS, FeMtPPln, AgrMinOp, NonFeMtM,
  NonFeMtP, MineMnrl, MiscInd, Abrasive, UrnVandD, SWLndfl, PowLines, PowPlnts, SubStn,
  PubHealth, PbSchools, Uni, PubTrans, Worship, Tornado, ER_TRI, ER_TSCA, OilRef, OilRefPl (29 pairs).
- **Other per-point measures:** `HospEDist` (hospital), `ParksEdist`, `UrgCareEDist`,
  `PowerLineDen`, `FID_VHA`/`DIST_VHA` (VA facilities), `ThiesArea`, `ThiessenArea`.

The CSV copies are the same rows with extra joined features:
`/scratch/mongodata/geoark_raw_L48.csv` (146 GB, these columns as text),
`/scratch/GeoARK/L48_FV.csv/combine/part*.csv` and `L48new_0821.csv/fea*/` (feature-vector joins, 50-500 GB each).
For loading, read the **gdb**: it has typed columns and real geometry, and GDAL reads it directly.

### Thiessen (Voronoi) polygons: no polygon file for these points

- The points carry `FID_L48_All_points_CreateThies_Clip` and `ThiessenArea`, so the polygons were
  built in ArcGIS (feature class `L48_All_points_CreateThies_Clip`), but **that feature class is
  not in the gdb and was not found anywhere under `/scratch`** (searched names containing
  thies / voronoi / tess, plus every .gdb / .shp / .gpkg / .parquet).
- `/scratch/GeoARKOct2025/psds_dbase/US48Tess_Bare/` is an **empty directory**.
- `/scratch/Danlu/points_x_y/outfile_final` (63 GB) is a Voronoi file: `lat,lon| c(lat,lon) c(lat,lon) ...` vertex rings. But it is in lat/lon and covers
  an older point set of about 11-12M points (2010 block centroids, `outfile_1_1000000` to `outfile_11000001_12000000`), not the 118M block + hexagon points.
  Alaska and Hawaii have the same format in `/scratch/tim_data_0730/`.

**Recommendation:** don't look for the national polygons or store them. Make them in PostGIS when a
request needs them (section 3, step 4). `ThiessenArea` already gives the area weight for
area-weighted sums.

### Your summary files in `GeoARKOct2025/app/`

They were built by `/scratch/US_L48GeoARK_TEMP/summarize_block.py` (points to block) and
`summarize_eachGeo.py` (block to block group, tract, county). For each `D_*` the value is the
**plain mean over the points in the unit** (not weighted by population or area). `F_*_list` is the
set of nearest-feature FIDs.

| File | Rows | Status |
|---|---|---|
| `summarized_counties.csv` | 3,159 | identical to the original |
| `summarized_tracts.csv` | 111,413 | identical to the original |
| `summarized_blocks.csv` | ~8M | same size as the original |
| `summarized_block_groups.csv` | 190,795 | **TRUNCATED.** The original has 239,615 rows; this copy ends mid-row (161,906,688 bytes vs 202,828,661). Copy it again from `/scratch/US_L48GeoARK_TEMP/` |

Gaps in the summaries: they cover only `D_*` fields, so **hospital (`HospEDist`), urgent care,
parks, VA (`DIST_VHA`) and power-line density are not in them** even though the points have them.
The tract file also has more rows (111k) than `geo_unit_tract` (85.5k), which suggests
2020 vs older tract vintages or water-only tracts. Check the join before loading.

## 2. What the app has now

- PostGIS 3.4.3, database 28 GB, 9.9 TB free on `/scratch`.
- `geo_unit` (partitioned by `level`) with geometry, and `geo_values` (`level, geoid, code, year, value`),
  long format, partitioned the same way. Partitions exist for `tract`, `bg`, `zcta`, `place`,
  `block` and the grids. **`geo_unit_block` and `geo_values_block` exist but are empty.**
- Sub-county measures are found at a named unit through `backend/level_measures.js`. County values live in
  `acs_county_values`.
- The facility layers these distances point to (HSIP hospitals, EMS, schools, ...) are already
  loaded as feature tables, so `F_*` FIDs can link back to them if the FIDs match the HSIP
  `OBJECTID`s. Check this on one layer first.
- No vector tile endpoint (`ST_AsMVT`); the map draws GeoJSON. That works for counties and tracts, not for millions of points.

## 3. Plan

### Step 1: Load the summaries (small, quick, adds value at once)

**Done 2026-11-22**, differently from what is written below: the published
tract / block group / county files had shifted codes for states 01-09, so they
were rebuilt from `summarized_blocks.csv` by `etl/prep_proximity_summaries.py`
and loaded with `make ingest` (dataset `hsip_proximity`, 27 measures, codes
`HSIP_PROXIMITY_DIST_*`). Airport and crushed stone left out. Details, match
rates and checks: DATA_CARPENTRY.md, "GeoARK distance to nearest facility".
The original sketch follows.

1. Copy `summarized_block_groups.csv` again (see above).
2. Write `etl/load_distance_summaries.py`: melt each file to `(level, geoid, code, year, value)` with
   `code = 'DIST_<x>_MEAN_M'` and year 2020. Counties go to `acs_county_values` (or a separate code namespace),
   tract and bg to `geo_values`. Leave out the `F_*_list` columns, or put them in a side table
   `geo_nearest_fids(level, geoid, layer, fids int[])` if you want "which facilities are nearest".
3. Add catalog rows to `backend/geoark_attributes.csv` (one per distance and level), then
   `make reindex reload-corpus`, then `python etl/restore_ledger_catalog.py` (see CLAUDE.md traps).
4. Add `known_item.yaml` / `research.yaml` cases ("average distance to nearest EMS station by tract in Missouri")
   with gold from SQL.

Result: the planner can use proximity at county, tract and block-group level with no new ops.

### Step 2: Load the 118M points into PostGIS as one table

**Missouri pilot done 2026-11-22.** `etl/schema_fine_points.sql` (table `fine_pt`,
list-partitioned by state) and `etl/load_fine_points.sh <state>` (host GDAL,
PGDump streamed into the db container). Result, `fine_pt_29`:

| | |
|---|---|
| points / blocks | **2,747,844 / 243,688**, the block count of `summarized_blocks.csv` exactly |
| point kinds | 2,605,325 hexagon points (`grid_id` like `RQN-7387`) + 123,291 block centroids (`grid_id = 'BLOCK2020_ID'`); a block gets its centroid only when no hexagon point falls in it, so 131,764 blocks have exactly one point |
| size | 910 MB with GIST + block index, **331 bytes per point** |
| load time | 1,128 s, 1,090 of it the gdb scan |

What the pilot found:

- **`HospEDist` (and `ParksEdist`) are Web Mercator raster distances**, 1.287x
  true distance at 39N. Stored corrected (`x cos(lat)`): corrected hospital
  miles vs geodesic to the loaded HSIP hospitals, median **1.000**, p05-p95
  0.996-1.005 on 2,000 points.
- **`UrgCareEDist` is NULL on all 2.7M Missouri points**: not loaded.
- **`DIST_VHA`** is the D_* metric but against a different VA facility list
  than the one loaded (exact match 2.4%).
- **Point values reproduce the summaries**: all 115 Missouri county EMS values
  recomputed from `fine_pt` (mean of block means) equal the loaded
  `HSIP_PROXIMITY_DIST_EMS` within 5e-5 mi.
- **The Thiessen polygons can be rebuilt exactly.** `ST_VoronoiPolygons` over
  Boone County's points (27,608 cells): interior cell area / `ThiessenArea`
  median **1.000**, p05-p95 0.979-1.027. 143 s, mostly the cell-to-point
  `ST_Contains` join and geography areas; needs work before it is interactive.
- Query costs in Missouri: per-county share beyond 30 mi + p90 for all 115
  counties 3.0 s; a 10 km map view 11 ms (2,057 points); nearest point to a
  click 0.5 ms.
- **The bounding box mattered for speed after all**: with `-spat` the scan was
  ~7 min (and clipped the Bootheel: 1,464 blocks in Pemiscot and Dunklin
  missing), attribute-only 18 min. GDAL rejects the gdb's spatial index, so
  either way the whole file is read.

**National, before running it:** 48 per-state runs at ~18 min is ~15 h. A
single unfiltered scan into one staging table, then `INSERT ... SELECT` per
state, reads the gdb once. At 331 bytes per point the table is **~39 GB**
(not the 15-25 GB estimated below); dropping `zip`/`huc12` (both derivable by
spatial join) or storing distances as smallint tenths of a mile would cut it.

**National, done 2026-11-22** (`etl/load_fine_points.sh ALL --skip 29`, log and
checks in `eval/fine_points/`). 42 min end to end; every L48 state and DC is a
partition of `fine_pt`, **39 GB**.

- **One scan was the wrong plan.** ogr2ogr is single-threaded: it parses ~110k
  rows/s but writes only ~14k rows/s, so one national extract is >2 h. And
  PGDump writes one `INSERT` per row unless `--config PG_USE_COPY YES` (the
  Missouri pilot ran on INSERTs). The loader instead runs 12 extracts at once,
  each `State20 IN (...)` over a disjoint group of states balanced by land
  area. Each pays the full parse (the page cache serves the repeated reads) but
  writes only its share: all 12 staged in 28-31 min. Partitions were then
  built 8 at a time from the group staging tables in 11 min, ordered by
  `ST_GeoHash` on insert instead of `CLUSTER`.
- **Counts:** 118,157,378 points. The gdb layer has 118,158,718; the other
  1,340 have no L48 state code, the same points `summarized_blocks.csv` holds
  as its one row with an empty `Block20` (`eval/fine_points/unassigned_points.txt`).
  Blocks per state equal `summarized_blocks.csv` for all 49.
- **County EMS rebuilt from the points equals the Step 1 values** for all 3,096
  counties that have one, max difference 5e-5 mi (rounding).
- **The source has no facility distances for 1.64M points (1.39%)**, in one
  contiguous northern area: Maine 93.6% of its points, Vermont 15.8%,
  Minnesota 9.2%, New Hampshire 7.8%, Massachusetts 3.3%, New York 2.9%,
  Michigan 0.4% (`eval/fine_points/null_rates.txt`). 39 counties are touched
  (`eval/fine_points/gap_counties.txt`): 12 in Maine with none, and 27 partly
  covered, from 0.0x% to 97% missing (NE Minnesota's arrowhead, Cape Cod,
  Keweenaw, northern NY and VT, coastal NH). Two null classes,
  exact across all 118M points: 23 of the 27 `D_*` plus `DIST_VHA` are null
  together; `D_ChldCare`, `D_Biodsl`, `D_CnsMinOp` and `D_FeMines` are present
  in the gap, as are `HospEDist` and `ParksEdist` (the rasters), which are
  complete everywhere. (First written 2026-11-22 as "all 27 `D_*` null";
  `etl/build_fine_point_grid.sh` checks the two classes cell by cell.) In New
  York and Vermont the missing points are exactly those north of 44.763 N
  (54034 y > 4,471,157 m); Maine and New Hampshire are missing east of ~70.6 W
  too, and Minnesota's gap is its northeast, so it is not one rectangle. That looks like processing chunks that never got the Near step; the
  `L48_FV.csv/combine/partx.csv` files may hold them and were not checked.
- **What that does downstream:**
  - Step 1 county, tract and bg values in the gap are means over only the
    covered blocks: the 12 Maine counties have no value, and the 27 partly
    covered counties carry an average of part of the county.
  - `point_distance` (Step 4) filters `IS NOT NULL`, so a share or percentile
    there is over the covered part of the unit and says nothing. The API reads
    the partitions every 5 min, so it now offers the op in these states.
    **Open.**

The original sketch follows.

Use a separate table, not `geo_unit`: these are sample points, not analysis units.

```sql
CREATE TABLE fine_pt (
  pt_id      bigint PRIMARY KEY,          -- gdb OBJECTID
  block20    char(15), grid_id text,
  county_fips char(5) GENERATED ALWAYS AS (left(block20,5)) STORED,
  zip text, huc12 char(12),
  thiessen_m2 real,
  geom       geometry(Point,4326),
  geom_ea    geometry(Point,54034),        -- optional: keep native metres for exact recompute
  d_hosp real, d_urgcare real, d_parks real, d_vha real, d_ems real, ... -- one real per distance
  f_hosp int, ...                          -- optional, nearest FIDs
) PARTITION BY LIST (left(block20,2));     -- one partition per state
```

Load per state with GDAL streaming straight into Postgres (no CSV step):

```bash
ogr2ogr -f PostgreSQL PG:"..." /scratch/US_L48GeoARK_TEMP/US_L48GeoARK.gdb \
  L48_All_Pt_Blk1020ZipHUC_TH_Area -nln fine_pt_staging -t_srs EPSG:4326 \
  -select "Block20,GRID_ID,ZIP_CODE,huc12,ThiessenArea,HospEDist,...,D_EMS,..." \
  -where "State20='29'" -lco GEOMETRY_NAME=geom -gt 1000000 --config PG_USE_COPY YES
```

- Start with **Missouri only** (about 2-3% of rows) to check counts, CRS, distances and timings.
- Size: about 120-150 bytes per row with real distances, so roughly **15-20 GB for the table plus about 5 GB
  for GIST and btree indexes**. Selecting only the needed columns matters; all 114 would be over 60 GB.
- Indexes per partition: GIST on `geom`, btree on `block20`, `county_fips`. `CLUSTER` on the GIST index after the load.
- Run it as an `etl` job (bind-mounted script, `etl-gdal.Dockerfile` already has GDAL), recorded in
  `etl/data_manifest.yaml`.

### Step 3: Show the points on the map

GeoJSON can't draw 118M points. Add a tile endpoint in the API:

- `GET /api/tiles/fine_pt/{z}/{x}/{y}.mvt?measure=d_hosp` → `ST_AsMVT` over `ST_TileEnvelope`.
- Below about zoom 10, serve the existing block-group or tract summaries (Step 1) instead of points; at zoom 10
  and above, serve points, coloured by the chosen distance.
- The frontend needs a vector-tile layer (Leaflet.VectorGrid or MapLibre). This is the largest
  frontend change.

**Done 2026-11-22, differently from the sketch above** (`backend/fine_points.js`,
`frontend/src/lib/finePoints.ts`, `frontend/src/components/FinePoints.tsx`). No vector-tile library:
a Leaflet `GridLayer` fetches one compact JSON tile per 256 px and draws it on a canvas. The server
decides per tile what it holds:

| tile | content | when |
|---|---|---|
| `agg` | mean of the points in each 4x4 px cell (64x64 cells) | more than 6,000 points in the tile |
| `points` | every point at its pixel; block centroids get a dark ring from z13 | otherwise |
| `cells` | each point's Thiessen cell, rebuilt with `ST_VoronoiPolygons` in Web Mercator over the tile plus half a tile each side, clipped by `ST_AsMVTGeom` | asked for, z >= 13, <= 2,500 points |

The rest of the API: `/api/points/catalog`, `/breaks` (sixths of a 1% sample, or of the view),
`/at` (the point under a click, all 30 distances, its rebuilt Thiessen cell, its block group /
tract / county), `/stats` (mean, area-weighted mean, mean of block means, p10/50/90, max, share
beyond 1-30 mi by points and by Thiessen area, for the view, a bg / tract / county / ZCTA / place,
or a radius). Tiles are cached in memory (LRU 4,000, keyed by the loaded partitions).

On the Explore page: "Show fine points", a distance picker, Auto / Points / Thiessen cells,
"stretch colours to this view", click details, distribution for the view / clicked unit / radius,
and a running tile-speed readout. URL: `/explore?pts=hosp_mi&ptmode=cells&ptscale=view`.

Measured (Missouri, 2.75M points; SQL in the API, round trip in headless Firefox on the server):

| request | time |
|---|---|
| `agg` tile covering most of Missouri (z6, 2.5M points) | 1.6 s first, 4 ms cached |
| `agg` tile z8 (227k points) / z10 (14k) | 225 ms / 41 ms |
| `points` tile z12 (944 points) | 30 ms |
| `cells` tile z14 (77 cells) | 25-44 ms |
| a city view at z13, 48 tiles | round trip median 47 ms, max 70 ms; SQL median 6 ms |
| Thiessen cells at z14, 52 tiles | round trip median 78 ms, max 256 ms; SQL median 32 ms |
| click lookup (`/at`) | 6-24 ms |
| stats: tract / ZCTA 65201 / Boone County / 10 mi radius / all Missouri | 5 / 38 / 94 / 203 ms / 4.0 s |

**Revised the same day after use** (user feedback):
- **Cells broke when zoomed in**: past the point spacing a tile and its half-tile margin held few or no
  points, so the tile came back `empty` (or with cells missing) and the basemap showed through. Cells
  are now built from the margin's points plus the 80 nearest the tile centre, and a tile in cells mode
  is never empty. Checked: every tile at z14-19 (Columbia and rural Douglas County) covers 103.15% of
  its area, which is the tile plus its 2 px buffer.
- **View breaks rounded to two significant digits** read "36.2 · 36 · 37" for a 36.2-37.0 mi view;
  they are now rounded to a tenth of the range's order of magnitude, kept inside the range.
- The panel: colour ramp and opacity for each layer (area and points), an On/Off for each, much less
  text (counts, speeds and the method sit under "About and speed"; a click shows the selected distance
  with "All distances" folded), fine-point choices remembered when the points are turned off and on
  (browser storage), and a translucent glass panel that can be collapsed to a "Layers" button.
  Recolouring redraws loaded tiles in place instead of refetching them.

Three traps found on the way:
- **A KNN `ORDER BY geom <-> p` where p comes from a CTE is not index-ordered**: the click
  lookup took 1.3 s; with the point as a constant expression, 21 ms.
- **`block20` compared as text skips its btree** (char(15) column): Boone County stats 577 ms
  vs 10 ms compared as `bpchar`.
- **Statewide colour classes hide a city**: every point in Columbia is in the first sixth for
  hospitals. Hence the per-view breaks option.

Checks: the click's rebuilt cell is 0.069 km² where the gdb's `ThiessenArea` says 0.069 (Columbia),
0.028 vs 0.031 (Springfield, a cell on the edge of the 60 neighbours used). One data oddity to know:
`D_PubTrans` reads 134 mi in Columbia, which has buses, so it measures something sparser (rail or
intercity stations); it is on the map but not used by the planner.

**Zoomed out after the national load: a precomputed pyramid (2026-11-23).** With 118M
points the live per-tile aggregate fell over: a z9 tile 0.11 s, z7 1.3 s, **z5 18.5 s**
(15.3M points). A screen is ~35 tiles, and the tile route shared the API's one 10-connection
pool, so a zoom-out held every connection for minutes; aborted fetches kept running in
Postgres, the page stalled, and tiles failed blank. Below z5 nothing was drawn at all.

- `fine_pt_grid` (`etl/build_fine_point_grid.sh`, 3 min, 2.0 GB): the 4 px cell means of
  every tile from z9 down to z3 (8.9M cells at z9, 2,392 at z3), each level built from
  the one below weighted by its count. Every level sums to 118,157,378 points. The build
  checks the two null classes (`n` / `n_b`) cell by cell and fails if one breaks.
- **Equal to the live aggregate**, not an approximation: same cells and counts, values
  within float rounding (max relative 1e-7) on z5-z9 tiles, `hosp_mi`, `ems_mi`,
  `child_care_mi`, `tornado_track_mi`, including a tile across the northern gap's edge
  (`eval/fine_points/grid_vs_live.sh`, `.log`).
- Tiles z3-z9 read it (one indexed read, <= 4,096 rows) unless the tile has <= 6,000
  points, which still draws points live. The map now starts at z3.
- Tiles have their own pool (`POINT_TILE_POOL`, 8) with a 20 s `statement_timeout`
  (`POINT_TILE_TIMEOUT_MS`), and skip their next query when the browser has dropped the
  tile. The browser retries a failed tile once instead of leaving it blank.
- View-scaled breaks over > 200k points read the grid (count-weighted quantiles of cell
  means at the finest level with <= 250k cells in view) instead of a 2% `TABLESAMPLE`,
  which read 2% of all 39 GB on every pan. Cell means are a little smoother than
  points, so the extremes are slightly narrower.
- Measured through the API, cold, ~35 tiles per view: z3-z5 50-110 ms, z6-z9 235-300
  ms, z10-z11 (live) 205-300 ms, 0 errors; zoomed-out view breaks 0.4 s.
- **Thiessen-cell tiles went from fast to ~20 s a view after the national load, and it
  was JIT** (2026-11-23). Over 49 partitions the planner estimates ~118k points in a tile
  envelope (real: hundreds), the cell query's cost passes `jit_above_cost` (100k), and
  Postgres spent **4.7 s compiling 471 functions** per tile for a query that runs in
  30-90 ms. With Missouri alone the estimate stayed under the threshold. The points pool
  now runs `SET jit = off` on connect. Whole cell views (35 tiles, cold, through the
  API): Columbia MO z13-15 0.07-0.46 s, St. Louis z13 1.3 s / z14 0.24 s, downtown
  Chicago z13 2.9 s / z14 0.34 s / z16 0.07 s. The remaining cost in dense z13 tiles is
  matching each Voronoi cell back to its point (a nested loop over ~1,200 x ~5,000);
  materializing the CTEs and a bbox prefilter did not change it. The planner's
  `point_distance` queries (main pool) were checked: one state prunes the partitions and
  JIT costs them 24 ms, so the main pool keeps JIT.
- **Rebuild the grid after any `load_fine_points.sh` run**; the API puts its row count in
  the tile cache key, so a rebuild never mixes with cached tiles of the old one.

### Step 4: Analysis on the fine points

New planner ops that fit the existing `(geoid, value)` contract:

| Op | SQL sketch | Use |
|---|---|---|
| `point_aggregate` | `SELECT left(block20,n), avg / percentile / max(d_x) ... GROUP BY 1` | Recompute any summary, including the missing hospital, urgent care and VA ones, or a median or 90th percentile instead of a mean |
| `share_beyond` | `avg((d_x > :m)::int)` per unit | "% of a county's points more than 30 miles from a hospital" |
| `area_weighted` | `sum(d_x*thiessen_m2)/sum(thiessen_m2)` | Area-weighted mean, using `ThiessenArea` |
| `pop_weighted` | join `geo_values_block` population, weight point values per block | The population-exposure number most research questions want |
| `voronoi_on_demand` | `ST_VoronoiPolygons(ST_Collect(geom), 0, county_geom)` per county, clipped with `ST_Intersection` | Rebuilds the Thiessen cells for a county or region being looked at; cache in `fine_pt_cell` only for counties actually requested |
| custom zones | `ST_Within(pt.geom, zone.geom)` | Values for user-drawn areas, HUC12 or wards, without a crosswalk |

All of these run per state partition, so a single-state question never scans the whole country.

**Partly done 2026-11-22: `point_distance`** (`planner/point_distance.js`, `planner/ops/point_distance.js`,
tests `planner/test_point_distance.js`). An internal op, never offered to the model (prompt and schema
byte-identical across all 48 contexts). After a plan is accepted, code swaps it in for:

- a `nearest_distance` step, when the question asks how distance is DISTRIBUTED over each unit
  (share / percent of the unit beyond or within N miles or km, an Nth percentile, a median distance,
  the farthest point, an average "across" the unit, or names the fine points), the measured layer
  has a precomputed column (25 catalog layers matched by dataset name), and every state in the
  plan's area is loaded. A `filter_attr` with the share's own threshold is absorbed (the model writes
  "more than 20 miles" as a filter); any other threshold filter, a catchment count, a question about
  "the center of" a unit, `identify` or `k` leave the centroid distance;
- a `load` of a Step 1 summary (`HSIP_PROXIMITY_DIST_*`), when a median / percentile / share is
  asked: the summary is a mean of block means and cannot answer those.

Stats: `mean`, `pct` (percentile_cont), `max`, `share` (percent of the unit's Thiessen AREA). Units:
county / tract / bg by block-code prefix, ZCTA / place by point-in-polygon. Not ported: zone sets, grids.

The gate reaches **0 of 330** questions in `eval/` (the first version reached 3: "median household
income and distance", "share of Colorado's population within 5 miles", "above-median poverty ... more
than 30 miles"; all three are now tests). Live, against gold computed independently (point-in-polygon
on TIGER units, not block prefixes):

| question | plan | rows | max abs diff vs gold | SQL |
|---|---|--:|--:|--:|
| What share of each Missouri county is more than 20 miles from a hospital? | point_distance(share) -> filter_area | 115 / 115 | 0.046 pct pts (border points) | 1.3 s |
| What is the 90th percentile distance to the nearest hospital in each census tract in Missouri? | point_distance(pct 90) -> filter_area -> rank | 90 (rank cut) | 0.003 mi | 4.2 s |
| For each Missouri county, what is the median distance to the nearest public school? | load(summary) swapped -> point_distance(pct 50) | 115 / 115 | 0.004 mi | 2.1 s |

Douglas County: 92.1% of its area is more than 20 mi (straight line) from a hospital.

Not reached, planner-side and pre-existing: "What percent of each census tract in Boone County,
Missouri is within 2 miles of a hospital?" fails validation 3 times (the model loads the hospital
layer as a series); "What share of each census tract in Missouri is more than 10 miles from a
hospital?" is refused by the named-data check (at tract the hospital layer is not kept, the same gap
as "Which ZIP codes ... are farthest from"). "Where ... is the farthest point from a hospital in each
county?" produced no valid plan. No EMS layer is loaded, so EMS distance is reachable only through
the Step 1 summary (median / share via the swap) and the map.

The answer map draws these as ordinary county / tract choropleths; it does not yet overlay the points.

## 4. Things to check before trusting the numbers

1. **Distance metric.** The `D_*` values are planar metres in World Cylindrical Equal Area. That
   projection keeps area but **stretches east-west distance by about 1/cos(lat)** (about 1.3x at 40°N).
   Compare a sample of points against `ST_DistanceSphere` to the facility, and if they disagree,
   label the values "projected distance" or recompute in a distance-safe CRS.
2. **Facility vintages.** Find out which HSIP vintage the `F_*` FIDs refer to before linking them to the loaded layers.
3. **Point weighting.** A block's value is the mean of its centroid and the hexagon points inside it, so large rural
   blocks count more points. For population questions use population weighting (Step 4).
4. **Coverage.** L48 only. Alaska and Hawaii are in `/scratch/GeoARK/AKnew_0821.csv` and `/scratch/alaska_hawaii/`
   with different schemas.

## 5. Suggested order

1. Copy block groups again, then Step 1 (about a day, lowest risk, uses the current UI).
2. Step 2 for Missouri, then check (section 4, item 1).
3. Step 2 for all of L48 (overnight load).
4. `point_aggregate` and `share_beyond` ops, with eval gold.
5. MVT tiles and the frontend layer.
6. Voronoi on demand.
