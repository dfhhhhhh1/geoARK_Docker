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
