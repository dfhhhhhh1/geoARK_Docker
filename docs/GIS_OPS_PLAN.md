# Analyst GIS operations: plan

Status (2026-11-20): **H0-H3 built, H4 built for rasters over units, H5 partly built** (network distance; section 8); the rest of H4 and H5 are a plan. **H6** (primitive gaps, tiered) is planned in section 5; tier 1 items 1-3 are built. Follows
RESEARCH_PLAN.md (A-F built, G planned) and DATA_LOADING_PLAN.md (phases 1-7).

Goal: answer the class of question a working GIS analyst asks, buffers,
overlays, point-in-polygon summaries, zonal statistics, raster change, network
service areas, **in general**, not the 16 test questions. The test questions
(`eval/gis_ops/heldout_analyst_queries.csv`) are therefore a **held-out set**:
nothing in this plan is tuned against their wording, and they are scored only at
phase boundaries.

## 1. Baseline (2026-11-11, `/api/research`, qwen3:14b `off/on`, one run)

`eval/gis_ops/baseline-r1.json`. Correct **0 / 16**. Honest refusal 11 / 16.
**Confident wrong answer 5 / 16**, which is the number that matters most:

| # | question (short) | returned | why it is wrong |
|---|---|---|---|
| 4 | FEMA flood zones x parcels, value at risk | county owner-occupied home value (DP04_0080E) joined to itself | no flood or parcel data; relevance check said `none`, overruled because the attribute "shares *value* with the question" |
| 9 | 311 potholes per council district / road miles | an opaque-hash facility layer per county / "workers per car" | no 311, district or road layer; the divisor is a commuting ratio |
| 10 | solar raster over building footprints, top 20 | % of homes heated by solar, top 20 counties | no raster or footprints; same word, different measure |
| 11 | food stores per km² per neighborhood unit | Retail **Service Territories** (electric utilities) per **square mile** per county | wrong layer, wrong unit, wrong zones |
| 16 | 5 balanced clusters of our inspection sites | Mobile Home Parks per county | "mobile" matched the layer name |

The 11 refusals are mostly the right outcome for this data, but the message is
"could not produce a valid plan" for 7 of them. A user cannot tell "parcels
were never loaded" from "rephrase it" (the distinction `suggestions.js` already
makes for the 22 never-imported datasets).

Two defects found on the way, outside this plan:

- **`count_near` undercounts.** Its `ST_Expand` box converts miles to degrees at
  the equator, which is too narrow in longitude everywhere else. Hospitals
  within 3 mi of a fire station: 7,491 compiled vs 7,517 with the box widened by
  1/cos(lat). Same class as the `nearest_distance` correction. Spun off.
- **Public Schools, Private Schools, Public Transit Stations / Routes and Road
  Tunnels are catalog rows with no table**, so question 1 (schools near
  chemical facilities) is unanswerable for data reasons alone.

## 2. Why these fail: three gaps, not sixteen

Mapping each question to what it needs (operations x data) shows the same few
gaps repeated. Fixing these, not the questions, is the plan.

| gap | questions it blocks | today |
|---|---|---|
| **G1. Features do not compose.** Only `(fips, value)` series chain; `select_features` may only feed an `output` | 1, 2, 3, 4, 6, 7, 8, 10, 15 | buffer / select-by-location / overlay between two layers returning the *features* is not expressible |
| **G2. Analysis zones are a closed set** (county, tract, bg, zcta, place, grid) | 9, 11, 13 (forest), 3 (downtown), 1 (the buffer zone itself) | a user's council districts or planning units cannot be the unit of a summary |
| **G3. Rasters are one continuous layer** (WorldPop), reachable only through pre-built zonal sums | 5, 8, 10, 12, 13 | no categorical rasters (land cover), no raster math, no zonal stat over arbitrary polygons |
| G4. No network | 3, 7 (walk time), 15, 16 | no road graph, no pgRouting |
| G5. Data the question assumes | all but 7 | parcels, zoning, 311, flood zones, wetlands, roads, DEMs, land cover, footprints, transit stops |

And one guard gap, which is why five questions came back wrong instead of
refused:

| G0. **Nothing checks that every primary concept of the question is covered.** The relevance check judges each loaded attribute; a plan that silently drops "flood zones" and "parcels" and keeps "value" passes. The word-overlap override (`sharedWords`) fired on a generic word. |

## 3. Design principles (what keeps this general)

1. **Typed plan values.** Every step produces one of `series(level)`,
   `features(layer)`, `zones(zone_set)`, `raster`, `scalar`. Each op declares
   input and output types in its registry module; the validator type-checks
   edges. This replaces three special cases that exist today (features may only
   feed output; statistics may only feed output; same-level rule) with one
   rule, and it is what makes new ops compose without "unless it's features"
   branches.
2. **A small algebra, not a catalog of analyses.** About ten ops cover every
   row of the test CSV (section 4). A "site suitability" or "flood exposure"
   op is the hard-coding this plan avoids; they are compositions.
3. **Zones are data.** A council-district layer, a forest boundary or a
   downtown polygon ingests as a `geo_unit` kind (sidecar `role: zones`), after
   which every existing series op works over it unchanged. Same move as
   Phase E's `(level, geoid)`.
4. **Units in code.** Plans carry `{value, unit}` for distances, areas and
   durations; conversion, and the per-km² vs per-mi² choice, is code, read from
   the question the way `levels.js` reads the unit, never chosen by the model.
5. **Domain thresholds are cited definitions** in `etl/definitions.yaml`, the
   mechanism that already exists: "100-year flood zone" = NFHL `FLD_ZONE` in
   {A, AE, AH, AO, AR, A99, V, VE}; "cropland" = the CDL/NLCD class codes;
   "undeveloped" = an NLCD class set. Pinned to vintages and re-tested on load.
   Local vocabularies ("light industrial", "commercial") come from the layer's
   own discovered values (`featureFilterValues`), as `attribute_filters`
   already does.
6. **Assumptions the data cannot support are refused or stated, never
   absorbed.** "During peak traffic hours" with no speed data: answer
   free-flow and say so, or refuse that clause. "10-minute walk": network
   distance at a stated speed, reported in provenance.
7. **Every primary concept must be covered** (fixes G0, below). An answer that
   used a stand-in for a concept the user named is a refusal that names the
   missing data, not a result.

## 4. The op algebra

Existing ops keep their names; `count_near`, `count_features` and
`nearest_distance` become sugar over the general ones.

| op | types | covers |
|---|---|---|
| `select_features` (now composable) | -> features | every layer read; filters incl. **NOT**, numeric (`> 10 acres`), date range (`last 12 months`) |
| `within` | features x features, `distance`, `negate` -> features | buffer / select by location (1, 2, 7, 8) |
| `overlay` | features x features, `mode` intersects / clip -> features with clipped `area` / `length` | flood x parcels, roads x wetlands, land in a zone (4, 6, 8) |
| `summarize` | features [x zones] -> scalar or series(zones); count / sum(attr) / length / area | enrollment in a buffer, value at risk, potholes per district, road miles (1, 4, 9, 11) |
| `zonal` | raster x (zones or features) -> series or feature attribute; mean / sum / class area | slope per parcel, solar per roof, cropland area (5, 8, 10) |
| `raster_calc` | raster x raster, expression -> raster; then `threshold` -> features | NDVI change, cut/fill (12, 13) |
| `service_area` | features or zone, time or distance, mode -> zones | drive / walk catchments (3, 7) |
| `route` | origin x destinations, barriers -> features (lines) | 15 |
| `rank`, `per_area`, `normalize`, `filter_*` | extended to features and to any zone set | 9, 10, 11 |
| `cluster` / VRP (compute op) | features -> features + group | 16; last, likely a sidecar (OR-tools) |

Each op is gated by `offered(ctx)` on phrasing **and** on the types its inputs
need being present among the candidates (`within` is never offered with one
feature layer), so the 48-context snapshot stays byte-identical for every
question that exists today.

## 5. Phases

Continues the RESEARCH_PLAN lettering. F and G are reframed, not replaced:
Phase F's catchment questions (`f-co-share-within-5mi`,
`f-mo-pop-far-hospital`) are exactly `within` + `zonal`, so they land in H1.

### H0. Refuse honestly before answering more (guard, small, first)

- **Concept coverage check**: the decomposer's primary concepts must each be
  matched by an attribute the plan actually uses (extraction-style, like v3 of
  the relevance check). Uncovered -> refusal naming the concept.
- `sharedWords`: "value", "data", "area", "zone", "rate", "count", "mobile"...
  are not evidence, the same fix "chronic/disease" got.
- Refusal text names missing data by concept ("this needs parcel and flood-zone
  layers; none are loaded") instead of "could not produce a valid plan".

*Done when:* the 5 confident wrong answers above become refusals that name the
missing layer, 3/3, with answerability false refusals no worse than 1/20 and
`research.yaml` unmoved.

### H1. Typed DAG + feature algebra core (G1)

Types in the registry and validator; composable `select_features`; `within`,
`summarize`, filters with NOT / numeric / date; units in code; `rank` on
features. Port `nearest_distance` and `count_near` to tract (Phase E's open
item; the clinic-siting question needs it). Feature outputs return geometry +
attributes and export like today.

*Done when:* new suite `eval/gis_ops.yaml` family **proximity** (section 6)
correct 3/3 on the dev split, Phase F catchment questions correct, snapshot
byte-identical, every existing suite unmoved.

### H2. Zones as data, user layers first-class (G2, part of G5)

- Sidecar `role: zones` ingests into `geo_unit` with its own kind; `filter_place`
  and every series op accept it.
- Feature upload per request (GeoJSON / zipped shapefile / GeoPackage), stored
  only for the session, the way inline CSVs are today. "Our ..." in a question
  prefers a user layer.
- Load the national point/line layers that analyst questions assume and that
  are free: the missing HIFLD schools and transit layers, TIGER roads (primary
  + all roads), USDA SNAP retailer locations (food stores).

*Done when:* families **aggregation** and **density** correct 3/3 on a fixture
city (section 6).

### H3. Overlay and polygon reference data

`overlay` with area/length of the clipped part, over ANY polygon layer: a
hazard zone, a wetland, a perimeter, a district, an upload. Nothing in code
names a hazard or a class; which polygons count is the layer's own `type`
values or a cited definition, both data. NWI wetlands by state on request
(large; per state, as blocks were decided). A flood-zone layer, when one is
loaded, is one more polygon layer plus a `definitions.yaml` entry.
(Revised 2026-11-12: the first draft named NFHL x parcels, the held-out
question it would have been tuned to.)

*Done when:* family **overlay** correct 3/3.

### H4. Rasters beyond WorldPop (G3; was Phase G)

`load_raster.py` gains categorical rasters (class codes, a legend, class-area
tabulation) and on-the-fly `zonal` over arbitrary polygons (`ST_Clip` /
`ST_SummaryStatsAgg` on a tiled COG, with the sub-pixel rule for small
polygons). NLCD and CDL for two vintages, 3DEP DEM for the fixture area,
slope derived on load. `raster_calc` + `threshold` for user rasters (cut/fill,
NDVI change from user-supplied NDVI rasters). Imagery acquisition and
cloud-cover STAC search are **not** in scope: a STAC catalog can be ingested as
footprint polygons with attributes and then it is ordinary H1/H2 work.

*Done when:* family **raster** correct 3/3; zonal sums conserve the raster
total, as Phase 4 required.

(Built 2026-11-12, see section 8: native equal-area rasters, `zonal` over
units, NLCD 2001/2021 for Missouri + Illinois, 3DEP DEM and slope for the two
fixture metros. CDL was not downloaded; `zonal` over FEATURES (slope per
parcel), `raster_calc` / `threshold` -> features and user raster uploads are
the remaining part of H4.)

### H5. Network (G4)

pgRouting + OSM roads (local, `osm2pgrouting`) for the fixture region first:
`service_area` (drive, walk at a stated speed), `route` with one-way and a
barrier layer. No live traffic: peak-hour questions answer free-flow and say
so. VRP / balanced clustering last, as a compute op.

*Done when:* family **network** correct 3/3 against pgRouting-independent gold
(for a few hand-checked pairs) and drive times within 15% of a reference.

(Partly built: drive / walk distance and time through `within` +
`network_population`, `planner/network.js`, RUNBOOK "Road networks".
`route`, an isochrone POLYGON and VRP are not.)

### H6. Closing the primitive gaps (planned 2026-11-20)

An audit of the op registry against a standard 24-primitive spatial algebra
(predicates, construction, overlay, joins, network, raster) plus the
relational operators. Counted against it: **10 covered, 9 partial, 5 missing**.
The relational side (filter, sort/limit, tabular join, CRS) is complete.

| # | primitive | today | gap |
|---|---|---|---|
| 1 | intersects | `overlay`, `filter_place` | -- |
| 2 | contains / within | `overlay` (intersects) | no strict containment |
| 3 | touches / adjacent | `county_neighbors` | county only; no `tract_neighbors`, none for features |
| 4 | crosses | -- | line x line ("roads crossing rivers") |
| 5 | distance within | `within`, `count_near`, network form | -- |
| 6 | buffer | selection by distance | the buffer is never a geometry (mappable, measurable, dissolved) |
| 7 | centroid | internal | not needed as an op |
| 8 | convex / concave hull | -- | low value alone; the isochrone polygon needs it |
| 9 | Voronoi | -- | needed for allocation (below) |
| 10 | simplify / densify | `geo_unit` display tiers | infrastructure, not a question |
| 11 | intersection / clip | `overlay` + measured `summarize` | -- |
| 12 | union | internal (overlay input 2) | -- |
| 13 | difference / erase | `exclude` (whole features) | geometric A minus B area |
| 14 | dissolve | `aggregate` by state, `aggregate_to`, zone sets | geometry dissolve by attribute |
| 15 | spatial join | features -> units (`summarize`, catchments) | **units -> features**: a feature cannot carry the value of the unit it lies in |
| 16 | k-NN | `nearest_distance` (k=1, distance only) | which feature is nearest; k > 1 |
| 17 | spatial aggregation | `summarize`, `zonal`, `aggregate`, `geoark_apportion` | -- |
| 18 | shortest path | -- | `route` (H5) |
| 19 | isochrone | reach is answered | not drawn as a polygon |
| 20 | OD matrix | nearest-source cost | network nearest cost per unit |
| 21 | zonal | over units | over features (H4 remainder) |
| 22 | map algebra | pixel threshold inside `zonal`; `combine` at units | `raster_calc` (H4 remainder) |
| 23 | interpolation / KDE | `per_area` density per unit | no surface |
| 24 | terrain | slope at load | aspect, hillshade, viewshed |

Operations the 24 leave out that natural-language questions need more than
several of the 24: global Moran's I and LISA classes, a composite
(standardized, weighted) index over N series, local geocoding of a named
point, allocation and location-allocation, clustering / regionalization, a
multi-year trend slope, date-range feature filters, raster value at points,
and classification as an analysis step.

**The constraint is unchanged**: every op the model sees costs planner
accuracy, so each item below is a field variant or a code-attached behaviour
on an existing op wherever it can be, phrasing-gated, snapshot byte-identical,
and each gets its own `eval/gis_ops.yaml` family with brute-force gold and a
held-out split. "All 24 primitives" is not the goal; the measured
bottlenecks are still measure choice, catalog text and coverage.

**Tier 1** (cheap, existing pieces):

1. **Feature enrichment** (units -> features spatial join): each feature takes
   the value of a series at the unit it lies in, so `filter_attr` / `rank`
   over features can answer "hospitals in tracts with poverty over 30%",
   "the schools in the lowest-income ZIP codes".
2. Numeric and date filters on feature attributes (open since H1).
3. `nearest_distance` names the nearest feature, and takes `k`. (Built
   2026-11-20, see "H6 tier 1, item 3".)
4. Composite index: z-score or min-max N series, weighted sum. (Built
   2026-11-21, with geometric and minimum aggregation and percentile ranks as
   the default; see "H6 tier 1, item 4".)
5. `zonal` over features (H4 remainder).
6. Global Moran's I as a scalar answer, LISA classes as a diverging series.

**Tier 2**: network nearest cost per unit; `route`; isochrone and dissolved
buffer as geometry; allocation (Voronoi or network nearest) x WorldPop;
`raster_calc` + threshold -> features; KDE over the grid levels; local
geocoding against layer name / address columns.

**Tier 3** (possible, not now): hulls, centroid / simplify as ops, crosses,
feature adjacency, aspect / hillshade, viewshed, IDW / kriging (no point
measurements loaded), location-allocation optimisation, VRP, GWR.

## 6. Measuring "in general"

The plan fails if it passes the 16 and nothing else. So:

- **`eval/gis_ops.yaml`, written before each phase is built**, in families
  (proximity, overlay, aggregation, density, raster, network, refusal). Each
  family has **at least 6 questions varying layer, place, unit and phrasing**
  (miles / meters / km, "within", "near", "inside a buffer of"), split 4 dev /
  2 held out. Gold is hand-written SQL, as in `research.yaml`, with `wrong:`
  entries for the plausible errors (wrong unit, county instead of feature,
  stand-in measure) and `--self-test` run first: three of
  `research_advanced.yaml`'s first golds could not tell right from wrong.
- **A real fixture city** with open local data, so parcels / zoning / 311 /
  districts questions have gold: one city that publishes parcels, zoning,
  service requests and council or ward boundaries as open data (St. Louis is a
  candidate, since tract and filter_place gold already use it; check
  availability). A second city is the generality check: same questions, other
  layers, no code change.
- The CSV's 16 are scored only at the end of each phase, 3 runs, and never
  edited to match.
- Every phase also re-runs the guards: `snapshot_prompt.js`, `known_item.yaml`,
  `research.yaml`, answerability (false refusals).

## 7. Order and what each phase buys on the held-out 16

| phase | new questions answerable (if data present) | cumulative |
|---|---|---|
| H0 | none, but 5 wrong -> refused | 0 wrong |
| H1 | 1 (with schools loaded), 2, 7 (Euclidean walk) | 3 |
| H2 | 9, 11 | 5 |
| H3 | 4, 6, 8 (needs DEM: H4) | 7 |
| H4 | 5, 8, 10, 12, 13; 14 as ingested footprints | 12-13 |
| H5 | 3, 7 (network walk), 15; 16 last | 15-16 |

H0 first because more ops raise the chance of a plausible wrong answer, and
this project's rule is that a refusal beats one. H1 before everything because
H2-H5 are all new producers or consumers of the `features` type.

Risks: op-set growth (gating, typed narrowing: an op whose input type is absent
is never offered); latency (overlay on national NFHL is large; always restrict
by the question's area first, as `count_near` does with `&&`); VRAM is
unaffected (no new model).

## 8. Progress

### H0, built 2026-11-11

`backend/planner/named_data.js`, tests `planner/test_named_data.js` (10) and
one in `test_relevance.js`. On by default (`NAMED_DATA_CHECK`, per request
`named_data_check: false`). Planner prompt and schema byte-identical across 48
contexts. Evidence: `eval/gis_ops/h0-*`.

- **Named-data check.** After the relevance check passes, one call lists what
  the question names data about (copied phrases) and which used attribute
  covers each. An uncovered phrase goes back through the repair loop as
  `NOT_COVERED`; the planner then finds covering data or returns no steps.
  Code decides three things the model got wrong in the prototype: `covered_by`
  must be a listed label (it wrote "layer", "count_near"), the phrase must
  occur in the question, and phrases made only of places, units, periods,
  reporting units, remainders ("the rest of the country") or derived geometry
  ("the center of each county") are exempt. It listed "the Midwest", "each
  county" and "between 2019 and 2020" despite being told not to.
- **Reasoning off for it.** With reasoning on, one prototype call reasoned for
  16,000 tokens and timed out at 5 minutes; off, 0.5-2.3 s per call.
- **Refusals name what is missing.** When no plan got as far as the check, the
  same call runs over the retrieved candidates, so the error reads `the loaded
  data does not include "current 100-year FEMA flood zones", "local county
  tax parcel data", ...` instead of "could not produce a valid plan". The
  answerability suite's refusals now read "pet dogs", "a gallon of milk".
- **The single-word overrule is now a half-the-name overrule**
  (`relevance.overrules`), and "value" is generic. Both recorded overrules
  (heart 1/2, transmission 2/2) keep; mobile (1/3) and solar (1/8) no longer
  overrule.

| | before | after (3 runs) |
|---|--:|--:|
| held-out 16: confident wrong answers | 5 | **0, 0, 0** |
| held-out 16: refusal names the missing data | 0 | 14, 14, 14 |
| `research.yaml` answer correctness | 83.3, 83.3 | 83.3, 83.3, 83.3 |
| answerability: nonsense refused / false refusals | 10/10, 1/20 | 10/10, 1/20 (one run) |

- **One false refusal it caused, fixed before the repeat runs**:
  `r-hospital-distance-mo` ("the center of each Missouri county") was refused
  in r1; correct in r2 and r3 after the geometry exemption.
- Remaining `research.yaml` misses are pre-existing, all plan-valid-on-attempt-1
  or recorded failures: `r-poverty-top-mo` (the SNAP-household measure flake),
  `r-uninsured-big-counties`, `r-obesity-top50-income` (needs `/api/research`).
  The answerability false refusal is "where do seniors live", the recorded
  flake: the relevance check rejected Medicare coverage, which shares no word
  with the question, so the overrule change could not reach it.
- **Imprecise names, not wrong outcomes**: Q7 lists "distance to the nearest
  existing hospital" (Hospitals is loaded; tract median income and transit
  stops are what is missing); Q14 lists "target county"; Q2 sometimes names
  only "commercial zoning"; Q5 and Q16 still refuse with generic text. Each
  changes the message only: the candidate-path call runs after planning has
  already failed.
- Cost: about 1 s per answered question (one extra call, reasoning off);
  `research.yaml` mean latency 25.5 s.

**Correction, same day (found by the Phase E distance work).** The guard runs
above skipped `research_advanced.yaml`'s phase_e tier, and H0 broke three
things the tier and a later answerability run then showed:

- `overrules` counted the dataset name and the catalog's "(covers N
  counties)" note as part of the attribute's name. "Percent of households
  with no vehicle available" + "CDC Social Vulnerability Index" read 2 of 6
  words shared instead of 2 of 3; "Coronary heart disease among adults (...)
  (covers 2,957 counties)" read 1 of 3. The overrules that had rescued those
  measures from false "none" verdicts stopped firing: the Michigan roll-up,
  the Missouri tract spread and `a-expl-heart` were refused. Now the half is
  of the attribute's own name with the note stripped, and "person, persons,
  below, above" are generic. Mobile, solar and value still do not overrule
  (tested with their real dataset names).
- The named-data check read "How far, in miles" as data and refused
  `r-hospital-distance-mo` once; question and distance words are now exempt.

After the fixes (final build, RESEARCH_PLAN.md Phase E): held-out 16 still 0
wrong answers, 15 or 14 of 16 naming the missing data; phase_e 5/8 twice;
answerability 1/20 false refusals.

### H1, built 2026-11-11

Evidence: `eval/gis_ops/h1/` (`r1`-`r9` the dev iterations, `final-*` the
guard runs on one build). Tests: `planner/test_features.js` (19),
`planner/test_phase_f.js` (6). Planner prompt and schema byte-identical
across 48 contexts throughout; every new op, field variant and worked example
is gated on phrasing, and a scan of all 167 eval questions shows the feature
ops reach none of the pre-existing ones.

**Done-when, measured.**

| | before | after |
|---|--:|--:|
| `eval/gis_ops.yaml` proximity_dev (4) | 0/4 | **4/4, 4/4, 4/4** (r7-r9, one build) |
| Phase F catchment questions (2) | 0/2 | **2/2, 2/2, 2/2** (same build), and 2/2 on the final build |
| snapshot (48 contexts) | | identical |

`eval/gis_ops.yaml` was written before the ops: 6 proximity questions (4 dev,
2 held out) varying layer (hospitals, fire stations, nursing homes, child
care, law enforcement), state, unit (mi / km / m) and phrasing (within, more
than, not within, farthest, "have a ... within"). Gold is brute force (no
index, no box); feature answers are keyed by first coordinate
(`{fkey:...}`), and `answer_probe.py` scores them with `compare.features`.
`--check-gold` and `--self-test` (17/17) ran before any API run. One gold
alternative was added after a run, and the YAML says so: the Nursing Homes
layer also holds assisted living, and restricting it to its own type "NURSING
HOME" is a correct reading of "nursing homes".

**What was built.**

- **Types.** One validator rule over typed edges replaced three special
  cases (docs/OPERATORS.md "The types"). `series`, `features`, `scalar`,
  `statistic`, `factors`; `accepts` / `resultType` per op. Scalars now feed
  `combine` and `normalize`: a share is one total over another.
- **Composable features.** A features step read by anything but an output is
  a CTE with one fixed column list; `select_features` is `NOT MATERIALIZED`
  so a probe of it is an index scan. `within` (exact geodesic, two-step
  nearest as in nearest_distance; `exclude` for "farther than"), `summarize`
  (per unit, per state counting each feature once, or one total), `rank` and
  `filter_attr` on features. Equal to brute force on the three shapes
  checked: Ohio hospitals within 2 mi of a fire station 276 (0.4 s vs 6.7 s),
  Arizona child care centers beyond 5 km 1,459 = 1,459, Montana's 10
  nursing homes farthest from a hospital identical.
- **NOT filter**: `attribute_filters[].negate`, `IS DISTINCT FROM`, offered
  only on negation phrasing where features are the answer.
- **Units in code** (`planner/features.js`): km / m / ft converted to the
  miles a plan carries when the step's number is one the question stated in
  that unit; **which side** of the distance from the words before it ("more
  than 5 kilometers from" planned within 3.107 mi with no `exclude` and
  counted 1,672 for 568); "farthest" with no distance keeps every feature.
- **Catchments** (`planner/catchment.js`): people at a distance are counted
  by census tract, each tract in or out by its own point, not by county
  centroid; per-county answers summed back; "share of X's population" gets
  its denominator in code. Missouri: compiled 185,976 = gold exactly.
  Per-step levels in the compiler make this possible inside a county plan.
- `nearest_distance` / `count_near` at tract were already ported
  (RESEARCH_PLAN.md Phase E).

**Deterministic repairs the dev runs needed**, each a habit qwen3 (reasoning
off) repeated on every attempt, each in code after the model:

| symptom (dev run) | repair |
|---|---|
| "farthest from a hospital" left Hospitals off the candidates (decomposer nondeterminism; once as a `normalization` sub-query, which the facility cap never serves) | `referencePhrase`: the layer measured TO is its own primary sub-query, for gated questions only |
| reference layer restricted to the subject's state (drops a station across the line) | `widenReferenceLayer` |
| nursing homes filtered to `type: "HOSPITAL"`, 3 of 3 attempts, Hospitals on the list | `filterValueAsLayer`: a filter value that names another retrieved layer means that layer |
| hospitals `load`ed and fed into nearest_distance | `bridgeFromLoadedLayer` |
| share planned as sum(near) / population-by-county | `totalTheDenominator` |
| "how many people ..." refused, Population judged unrelated | relevance population rule covers `countsPeople` |

**Guards, final build** (`eval/gis_ops/h1/final-*`, one run each unless
stated; the feature distance property was renamed `miles_to_nearest` after
them and proximity_dev re-run 4/4 on that build):

| suite | before (last recorded) | final |
|---|--:|--:|
| `research_advanced.yaml` | 37.5% (9/24) | **70.8% (17/24)**: phase_d 4/6, phase_e 5/8 (same misses), phase_f 6/7, refuse 2/3 |
| `research.yaml` | 77.8, 77.8% | 77.8%, the same four misses |
| answerability | 10/10 refused, 1/20 false | 10/10, 1/20 (`a-seniors`, the recorded flake) |
| `plan_correctness.yaml` op appropriateness | 92.3-100% | 96.2%, validity 100%, forbidden 0% |
| `queries.yaml` concept recall / success | 97.8 / 97.3% | 97.8 / 97.3% (MRR 0.740 -> 0.750) |
| `known_item.yaml` recall@1 / MRR | 91.7% / 0.944 | 91.7% / 0.944 |
| held-out 16: wrong answers / naming missing data | 0, 14-15 | **0**, 15 |
| proximity_heldout (2) | not run | 1/2 |

- The `plan_correctness` miss is `normalize-poverty` ("poverty rate
  normalized by total population"): Phase B's rate-over-count rewire keeps
  the rate, once the ERS descriptions made the poverty RATE the first pick.
  That suite had not been run since before Phase B; no H1 code is on its
  path (log: no new op offered, no new repair fired).
- `e-zip-65721-counties` answered for the first time, wrongly (100% / 100%
  for its two counties, from an opaque-hash facility layer normalized by
  itself, judged `direct` by the relevance check); it was NO_ANSWER in three
  earlier runs. No H1 code on its path either; the missing piece is still a
  crosswalk lookup op.
- The proximity held-out miss: "within 800 meters" planned 0.5 mi, the
  model's own rounding (0.497 mi exact), and the unit repair only converts
  a number the question stated. Jaccard 0.884. Recorded, not fixed: held-out
  results do not drive changes. A dev question that states a metric distance
  the model rounds would be the way to measure a fix.

Not done in H1: numeric and date filters ("> 100 beds", "last 12 months");
they need numeric/date column discovery per layer like `featureFilterValues`.
`rank` on a tied cut returns an arbitrary subset of the ties (see the 2SFCA
note in RESEARCH_PLAN.md Phase F).

### H2, built 2026-11-12

Evidence: `eval/gis_ops/h2/` (`r1`-`r5` the dev iterations, `final-*` one
build). Tests: `planner/test_zones.js` (7), `test_user_layers.js` (7). Planner
prompt and schema byte-identical across 48 contexts throughout.

**Done-when, measured.** `eval/gis_ops.yaml` gained two families, written with
their gold before the build: aggregation and density, 6 questions each (4 dev
/ 2 held out), two fixture cities (St. Louis, Chicago), two zone sets each,
five layers, units mi2 and km2. `--check-gold` 0 problems, `--self-test`
60/60 before any API run.

| | r1 | r2 | final (3 runs, one build) |
|---|--:|--:|--:|
| aggregation_dev | 1/4 | 4/4 | **4/4, 4/4, 4/4** |
| density_dev | 2/4 | 3/4 | **4/4, 4/4, 4/4** |
| aggregation_heldout | | | 1/2 |
| density_heldout | | | 1/2 |

Mean latency 18-31 s. Both held-out misses are planner habits with reasoning
off, recorded and not fixed: "For every neighborhood in St. Louis, how many
public schools..." `load`ed the school layer instead of counting it; "Population
per square kilometer for each neighborhood" put `attribute_filters` on a
non-feature step, 3 of 3 attempts.

**One gold correction before any run.** The first gold (and loader) measured
land as the zone clipped to `county_geom`, on the belief that it is
shoreline-clipped. It is at coasts and the Great Lakes and NOT at rivers: St.
Louis city is 171.5 km2 of polygon for 159.9 km2 of TIGER land. Land is now
each zone-in-tract piece (clipped to county_geom) at that tract's land share:
St. Louis wards sum to 159.93 km2, Chicago's to 587 km2 (TIGER 589.7).

**What was built.**

- **Zones as data** (`etl/load_zones.py`, sidecar `kind: zones` / `role:
  zones`): a polygon layer becomes geo_unit level `z_<id>` with its own
  partitions, land area, county / state, display tiers, and WorldPop summed
  in (conservation against an exact pixel-overlap sum: -0.017% to +0.047% on
  the four sets). Registry `zone_set`; `/api/health` lists it; replay and
  dumps handle it. Loaded: St. Louis wards 14 and neighborhoods 88, Chicago
  wards 50 and community areas 77.
- **Reaching a zone set is code, not the model** (`planner/levels.js`): the
  question must name the unit (plural, or singular after each / every / per /
  by / which / what) AND one of the set's places. "each Boston ward" matches
  nothing. A scan of all 185 eval questions: the 12 H2 questions match, no
  other.
- `count_features` at any level (it was county-only); `summarize`,
  `select_features`, `within` allowed at a named unit. `per_area` takes
  `area_unit: km2`, set from the question's words (`features.applyAreaUnit`;
  3 of 185 questions, all H2).
- **National layers**, ingested and tagged: SNAP authorized retailers 249,063
  (current only, `etl/prep_h2_layers.py snap`), NCES public schools 102,178 and
  private schools 22,510, BTS transit stops 654,300 (boarding stops only,
  `prep_h2_layers.py transit`), TIGER 2024 primary roads 17,522. All roads (a
  per-county download) were not loaded.
- **Uploaded layers** (`backend/user_layers.js`): `POST /api/layers`, GeoJSON /
  zipped shapefile / GeoPackage / KML to WGS84 by ogr2ogr (gdal-bin is now in
  the API image), in memory for 4 h, never in the database. To the planner a
  layer is one more feature dataset; one helper (`_sql.featureFrom`) makes it
  a table expression over bound arrays wherever a table name would go, so no
  op special-cases it. "Our / my ..." prefers it (`preferUserLayer`). Upload
  panel, chips and the stream all carry it. Verified: an upload counted per
  St. Louis ward equals SQL on the same points for all 14; a projected
  shapefile zip reprojects to the right bbox; an expired id is a 410 that says
  to upload again.

**Defects the dev runs found, each fixed in code:**

| symptom | fix |
|---|---|
| "each Chicago ward" refused as data the question names | zone unit and place words are reporting-unit vocabulary in `named_data.isExempt` |
| SNAP offered three times, as its name / type / city columns, and `load`ed | the level filter topped up from the raw list; feature layers now only from the collapsed one |
| SNAP filtered to type "SNAP Authorized Food Retailers", 3 of 3 | `filterValueAsLayer` drops a value that is the layer's own name |
| a feature density loaded WorldPop into a dead branch | at a zone set WorldPop is forced on only for questions about people |
| ingest could not load any lat/lon CSV ("no coordinate system") | a CSV's coordinate columns are EPSG:4326 |
| the analysis map padded ward "1" to "00001": drew nothing, never zoomed; the table read "WARD 12 FL" | ids padded for counties only; state shown for county / tract rows only; `level_unit` names the unit |

**Guards, final build** (one run each):

| suite | H1 final | H2 final |
|---|--:|--:|
| `research_advanced.yaml` | 70.8% (17/24) | **70.8%** (phase_d 5/6, phase_e 5/8, phase_f 6/7, refuse 1/3) |
| `research.yaml` | 77.8% | **77.8%**, the same four misses |
| answerability | 10/10, 1/20 | 9/10, 1/20 (`a-seniors`) |
| `plan_correctness.yaml` | 96.2%, validity 100%, forbidden 0% | 96.2%, 100%, 0% |
| `queries.yaml` | 97.8 / 97.3%, MRR 0.750 | 97.8 / 97.3%, MRR 0.751 |
| `known_item.yaml` | 91.7% / 0.944 | 91.7% / 0.944 |
| proximity_dev / heldout | 4/4, 1/2 | 4/4, 1/2 |
| held-out 16: wrong answers / naming missing data | 0, 15 | **0**, 15 |

- The answerability miss is `r-snowfall`, answered through "Adverse Climate
  Events" judged a proxy: the recorded flake (relevance budget table), no H2
  code on its path.
- `d-asthma-then-rainfall` (refuse tier) was answered: workflow step q2
  averaged q1's own asthma result and called it rainfall, with no relevance or
  named-data verdict logged for the step. Correct refusal in H1's run; no H2
  repair fired. A pre-existing hole for workflow-result inputs, spun off.
- `r-refuse-schools` ("best public schools") is still a false answer, now
  ranking school COUNTS. Its note said the data was never imported; that is
  no longer the reason, and the note says so. The expectation is unchanged.
- Held-out 16: Q9 (311 potholes per council district) and Q11 (food stores
  per neighborhood unit) still refuse, naming "311 pothole service requests"
  and "retail food stores". Neither names a city whose zones are loaded, so
  the units are not there to count by; they are the questions a user's own
  upload is for.

Not done in H2: tract/ACS measures apportioned into zone sets (only WorldPop
is), zone attributes as measures (the ward file's census population), all
roads, a zone set's name matched as a place inside `filter_place` ("in Ward
5").


### H3, built 2026-11-12

Evidence: `eval/gis_ops/h3/` (`r1`-`r5` overlay dev, `final-*` one build,
`guards.sh`). Tests: `planner/test_overlay.js` (15). Planner prompt and schema
byte-identical across 48 contexts throughout.

**General, not flood-specific.** No code names a hazard, a class or a layer.
`overlay` works on any polygon layer; which polygons count is the layer's own
`type` values (a sidecar `as: type` maps NWI WETLAND_TYPE, or NFHL FLD_ZONE,
onto it) or a cited definition. The family's questions use wetlands, wildfire
perimeters, campuses, roads, transmission lines and point layers, none of them
the held-out flood x parcels question.

**Done-when, measured.** `eval/gis_ops.yaml` family **overlay**, written with
its gold before any API run: 4 dev / 2 held out, MO / CA / OR / St. Louis
wards, miles / acres / km, "pass through / inside / overlap / run through /
do not overlap". Gold is exact geometry, never the parts the op reads.
`--check-gold` 0 problems, `--self-test` 81/81.

| | r1 | r2 | final (r3-r5, one build) |
|---|--:|--:|--:|
| overlay_dev | 2/4 | 3/4 | **4/4, 4/4, 4/4** |
| overlay_heldout | | | **0/2** (below) |

Mean latency 29-34 s.

**What was built.**

- **`overlay`** (features x features -> features): input 1's features that
  intersect any feature of input 2 (`exclude`: none). Value = the length or
  area inside, input 2 unioned first so overlapping polygons are not counted
  twice; points carry none. Invalid polygons are made valid on the fly. Gated
  on overlay phrasing AND a polygon layer among the candidates
  (`features.overlayAlgebra`); a distance stays `within`'s.
- **Amounts** (`summarize` with `measure` / `unit`): total length or area of
  a line or polygon layer, per unit (clipped to each unit, LATERAL), per
  state, or one total. Count vs length vs area and the unit (miles, km, feet,
  acres, hectares, km2, mi2) are set in code from the question and the
  layer's geometry (`features.applyMeasures`), never by the model. "per
  square mile" stays a density.
- **Parts** (`feature_parts`, `etl/ingest.py build_parts`, `make parts`):
  polygons over 1,024 vertices split by `ST_Subdivide`; read wherever only
  geometry matters. MO roads x NWI: **234 s -> 4.8 s**, same 57 miles. Built
  for 8 polygon layers.
- **Ingest**: sidecar `as:` rename (ledgered, replayed), invalid polygons
  repaired, curved geometry densified, custom-CRS layers accepted (NWI's
  Albers raised in `AutoIdentifyEPSG`).
- **Data**: NWI wetlands, Missouri, 1,309,180 polygons (RUNBOOK "Polygon
  layers for overlay"). Its `ACRES` column is the WHOLE published polygon's
  area (716,505 acres on a river polygon whose Missouri geometry is 119,086);
  the catalog now says so. Per-county sums of the geometry conserve the
  layer's total exactly (2,935,380 acres).

**Defects the dev runs found, each fixed:**

| symptom | fix |
|---|---|
| roads x wetlands: SQL syntax error | `SUM(x, 0)` for `COALESCE(SUM(x), 0)`; test_overlay now checks paren nesting |
| "acres of wetlands in each ward" refused | my own catalog edit put an unquoted comma in a description, shifting `spatial_rep` to '' |
| same question planned `count_features`: polygons counted | an amount of a line / polygon layer turns count_features into select_features -> summarize, in code |
| per-unit area scanned all 2.4M rows per county | `LEFT JOIN LATERAL`, so the unit's box reaches the parts `UNION ALL` |
| eval scan: 4 H2 density questions read as amounts; e-zip-65721 as an overlay | "per square X" excluded; counties / states as the answer excluded |

**Held-out results, recorded and NOT fixed** (only dev may inform a change):

- `ov-mo-campus-no-wetland`: statement timeout. `exclude` compiles to `NOT
  EXISTS`, Postgres makes it an anti-join and does not push the box into the
  parts `UNION ALL` (EXPLAIN: seq scans of both branches). The same defect the
  LATERAL fix cured for per-unit totals; not applied to `exclude`.
- `ov-or-transmission-fire-km`: 551.7 km for 584.3. A state restriction on a
  geometry-only read tests each PART for a large polygon but the whole
  feature for a small one; with Oregon on both layers, a large perimeter
  across the state line loses its out-of-state parts (whole-feature reading:
  563.8). An inconsistency in the parts read, independent of wording.
- **Held-out 16: one confident wrong answer, the first since H0.** Q6 ("road
  segments in our transportation network that intersect wetlands or critical
  wildlife corridors") planned two overlays: national primary roads x NWI,
  and roads x **Public Nifs Archive Perimeters** as "critical wildlife
  corridors". The relevance check called the perimeters `direct` and the
  named-data check accepted them: the catalog name never says WILDFIRE.
  Before H3 the question could not be planned and was refused; overlay made
  it plannable and exposed the opaque name. Also, "our" network with no upload
  silently used a national layer. 15 of 16 still refuse naming the data.

**Guards, final build** (one run each):

| suite | H2 final | H3 final |
|---|--:|--:|
| proximity_dev / heldout | 4/4, 1/2 | 4/4, 1/2 (same miss) |
| aggregation_dev / heldout | 4/4, 1/2 | 4/4, 1/2 |
| density_dev / heldout | 4/4, 1/2 | 4/4, 1/2 |
| `research_advanced.yaml` | 70.8% | **75.0%** (phase_d 5/6, phase_e 5/8, phase_f 6/7, refuse 2/3) |
| `research.yaml` | 77.8% | 77.8%, the same four misses |
| answerability | 9/10, 1/20 | 9/10, 1/20 (snowfall, a-seniors) |
| `plan_correctness.yaml` | 96.2%, 100%, 0% | 96.2%, 100%, 0% |
| `queries.yaml` | 97.8 / 97.3%, MRR 0.751 | 97.8 / 97.3%, MRR 0.751 |
| `known_item.yaml` | 91.7% / 0.944 | 91.7% / 0.944 |
| held-out 16: wrong / naming missing data | 0, 15 | **1**, 15 |

**Held-out findings fixed, 2026-11-12 (at the user's request).** The H3
boundary numbers above stand as recorded; these fixes came after them, so the
overlay held-out pair is no longer clean.

| finding | fix | after |
|---|---|---|
| `exclude` timed out (anti-join scanned the parts UNION ALL) | `LEFT JOIN LATERAL (... LIMIT 1) WHERE hit IS NULL` | 0.48 s on the SQL; `ov-mo-campus-no-wetland` CORRECT (`eval/gis_ops/h3/fix-*`) |
| a state on a parts read tested each part, not the feature | `build_parts` records each large feature's states (`geoark_states`); the parts branch tests those | compiled Oregon plan 563.8 km = the whole-feature reading (was 551.7) |
| Q6 "our transportation network" answered with the national roads | named-data check: a phrase naming the user's OWN data (our / my) is covered only by an uploaded layer | Q6 refuses, naming the phrase |
| "critical wildlife corridors" covered by an opaque layer name | catalog renames: Wildfire Perimeters, Wildfire Perimeters Archive, Electric Utility Planning Areas, Electric Retail Service Territories | known_item 91.7% / 0.944, queries 97.8 / 97.3%, unmoved |

Two things the fix runs showed:

- **A rename can switch the overrule off.** The first rename, "Wildfire
  Perimeters (NIFC public NIFS)", made `relevance.overrules` fail (2 of 5
  name words shared), and the check called the perimeters unrelated for a
  question that says "wildfire perimeters": the Oregon question refused.
  The parenthetical was dropped (2 of 2). Keep catalog names short; any
  qualifier dilutes the overrule.
- **Q3 ("fire stations within a 10-minute drive of the downtown commercial
  district") planned fire stations within 10 MILES of fire stations** on
  that run, empty and unflagged: a drive time read as a distance, and the
  named-data check did not list "downtown commercial district" that run (it
  did the run before). Network territory (H5); recorded, not tuned.

Not done in H3: a flood-zone layer (none downloaded; NFHL per state is the
same ingest with `FLD_ZONE: {as: type}` plus a definitions entry);
statewide per-county area over all of NWI (~3 min, over the 30 s timeout);
line-layer parts; overlay as a per-unit series ("acres of wetland in flood
zones per county" works as select -> overlay(clip) -> summarize, but has no
dev question yet).


### H4 (rasters over units), built 2026-11-12

Evidence: `eval/gis_ops/h4/` (`r1`-`r3` contaminated iterations, `f1`-`f3`
the done-when runs, `final-*` guards on that build, `fix2-*` after the one
regression the guards found). Tests: `planner/test_zonal.js` (18). Planner
prompt and schema byte-identical across 48 contexts throughout.

**Data, downloaded with the user's approval.** NLCD land cover 2001 and 2021
(the NLCD 2021 release, MRLC WCS; the annual series sits on a requester-pays
bucket) for the Missouri + Illinois extent, 587M pixels per year at 30 m;
USGS 3DEP 1/3" DEM for the St. Louis and Chicago metro counties, 10 m, and
percent slope derived from it on load. All in EPSG:5070. RUNBOOK "Rasters
read on demand".

**General, as H3.** No class or dataset is named in code. A categorical
raster's legend and the publisher's own groups (NLCD's level I) are its
`type` values; a continuous raster takes a pixel threshold; what is reported
(share, area in the unit asked, mean) is code.

**Done-when, measured.** Family **raster** in `eval/gis_ops.yaml`, written
before the op ran: 4 dev / 2 held out; NLCD (group share, one-class change in
acres over two years), DEM (mean), slope (top 5 mean; threshold share);
community areas, wards, neighbourhoods, Missouri's counties, one county.

| | f1 | f2 | f3 |
|---|--:|--:|--:|
| raster_dev | **4/4** | **4/4** | **4/4** |
| raster_heldout | | | 1/2 (`final-*`) |

Gold is computed from the SOURCE GeoTIFFs with GDAL (`raster_gold.py`), so
it is independent of the loader, PostGIS raster and ST_Clip; it agreed with
ST_Clip to 3 decimals where checked. Self-test 107/107. **Conservation:** the
per-county class histograms of each NLCD year hold 582,113,733 pixels, the
same for both years, of 587,167,342 in the raster; the rest lie outside every
county polygon (Lake Michigan, the extent's edges). No pixel is counted twice.

**What was built.** `mode: native` rasters (`load_raster.load_native`,
`raster_layer.kind`, `raster_class`), a `raster` source kind end to end
(relink, attribute_source, resolve, validator), the `zonal` op (units at any
level, by ST_Clip pixel centre), per-county class histograms cached at load
(a two-year Missouri change: ~42 s live, milliseconds cached, same number).

**Defects the dev runs found, each fixed in code:**

| symptom | fix |
|---|---|
| zonal refused at a ward | `levels.LEVEL_OPS` lacked zonal and overlay (a list beside the registry, again) |
| "Cultivated Crops" dropped as unasked ("cultivated cropland") and the class CODES averaged | stem matching in dropUnaskedFilters; the validator refuses a land-class zonal with no classes |
| the model never put classes on zonal, any attempt | `fillRasterClasses`: the ones the question names, from the legend |
| filter_attr(= 1) or (= 2021) chained to s61: 9,400 tokens, 180 s x 3 | `num_predict` 3,000 on schema calls with reasoning off; the runaway op withheld from the next attempt's enum; repair text no longer quotes the runaway |
| the raster's year as a value (= 2026) | years listed only for multi-vintage rasters; `yearAsVintage` |
| a lone zonal step and no output, 3 attempts | `addMissingOutput` when exactly one step is unread |
| 2001 - 2021: right size, wrong sign | `orderChangeByYear`: later minus earlier for any year-carrying source |
| "could not determine data type of parameter $2" | the live path's pixel factor bound only when used |

**Guards, final build** (one run each):

| suite | H3 final | H4 final |
|---|--:|--:|
| overlay / proximity / aggregation / density dev | 4/4 each | 4/4 each |
| overlay / proximity / aggregation / density held-out | 0/2*, 1/2, 1/2, 1/2 | 1/2, 1/2, **2/2**, 1/2 |
| `research_advanced.yaml` | 75.0% | 70.8% (phase_d 4/6, phase_e 5/8, phase_f 6/7, refuse 2/3) |
| `research.yaml` | 77.8% | 72.2%, then **77.8%** after fix2 (the same four misses as H1-H3) |
| answerability | 9/10, 1/20 | **10/10, 1/20** (a-seniors) |
| `plan_correctness.yaml` | 96.2 / 100 / 0% | 96.2 / 100 / 0% |
| `queries.yaml` | 97.8 / 97.3%, MRR 0.751 | 97.8 / 97.3%, MRR 0.750 |
| `known_item.yaml` | 91.7% / 0.944 | 91.7% / 0.944 |
| held-out 16: wrong / naming missing data | 1, 15 | **0**, 15 |

\* before the held-out fixes. `research.yaml`: `r-hospital-distance-mo`
refused once, then correct 2/2 on reruns (variance). `r-rural-poor-no-hospital`
was a real regression from this build: the first equality-drop removed "no
hospital" (count = 0). The drop now applies only to raster-derived values; after that fix
(`fix2-*`): rural-poor correct 2/2, raster_dev 4/4 again, research.yaml 77.8%.

**Held-out, recorded:** `ra-cook-forest-share-2001` came back EMPTY (zonal ->
filter_place -> filter_area: the county restriction emptied it). Q5 of the
16 (cropland % change for "the county") now plans but does not validate;
still a refusal.

Not done in H4: zonal over FEATURES (slope per parcel, solar per roof);
`raster_calc` / `threshold` -> features (NDVI change, cut/fill); user raster
uploads; CDL; per-tract histogram caches.

### H6 tier 1, item 1: feature enrichment, built 2026-11-20 (not yet run through the planner)

`backend/planner/ops/enrich.js`, gate and repair in `planner/features.js`
(`enrichAlgebra`, `asksEnrichment`, `repairEnrichPercentile`), tests
`planner/test_enrich.js` (9). Eval family `enrichment` in `eval/gis_ops.yaml`
(4 dev, 2 held out), written before any planner run.

- **What it does.** `enrich(features, series) -> features`: each feature takes
  the value of the unit holding its `ST_PointOnSurface`, the county or the
  unit `levels.js` reads from the question (tract, ZIP, zone). Only features
  whose unit is IN the series are kept, so `load -> filter_attr -> enrich`
  answers "hospitals in census tracts where poverty is above 30%", and
  `enrich -> rank` or `-> summarize` rank or count them. A boundary point goes
  to the lowest geoid, so each feature is one row.
- **Why the filter goes before it.** A percentile ("high-poverty tracts") placed
  after enrich would rank tracts among the features' tracts, not among
  tracts. `repairEnrichPercentile` moves it to the series side; a stated number
  means the same either way and is left alone.
- **Gate.** Three phrasings that name the features' units as a qualifier ("in
  counties where / with ...", "in high-poverty tracts", "its tract" / "the
  county each X is in"), a feature layer among the candidates, a question
  about the features (not people). It reaches **0 of 284** eval questions (the
  one phrasing match, "people in rural counties", is a people question).
  Prompt and schema byte-identical across 48 contexts; all 15 existing planner
  test files pass. The retrieval filter at a named unit now keeps feature
  layers for these questions too (`unified_search_server.js keepFeatures`),
  or "hospitals in census tracts ..." would never see Hospitals.
- **Equal to brute force** (compiled SQL vs `ST_Covers` joins, live DB):
  Ohio hospitals in counties with PCTPOVALL > 15, **141 = 141**, 270 ms;
  Missouri hospitals in tracts with SVI_EP_POV150 > 40, **26 = 26**, 273 ms;
  all 805 Texas hospitals at tract, 635 ms.
- **Gold.** `--check-gold` 0 problems, `--self-test` 22/22 on the family. The
  suite's `hospitals` measure also accepts CMS long-term-care hospitals, whose
  Missouri gold is empty; the family uses `hifld_hospitals` instead.

Not done: the planner run (`enrichment_dev` 3x, then the guards), which needs
the API rebuilt from this tree; the output column is `county_value` /
`tract_value` / `zone_value` with the measure in `valueLabel`, and the
frontend was not checked for it.

### H6 tier 1, item 2: numeric and date filters on feature columns, built 2026-11-20

`backend/planner/feature_filters.js`, discovery `featureValueColumns` in
`unified_search_server.js`, SQL `_sql.valueFilterSql`, tests
`planner/test_feature_filters.js` (20). Eval family `value_filters` in
`eval/gis_ops.yaml` (4 dev, 3 held out), written before any planner run.
Evidence `eval/gis_ops/vf/`.

- **Decided in code, prompt untouched.** The comparison ("more than 100 beds",
  "magnitude 3 or greater", "between 50 and 100", "since 2005", "from 2020",
  "in the last 12 months") is read from the question and the column grounded
  against the columns the layer actually has, then carried as `value_filters`
  on `select_features` / `count_features`. Prompt and schema byte-identical
  across 48 contexts. The validator and compiler re-check every column against
  discovery, because a follow-up plan comes back from the browser.
- **Missing values are a sentinel, and this is the defect it exists for.**
  HSIP writes "not available" as one negative number: -999 for 307 hospitals'
  beds, 1,891 campuses' enrollment, 4,674 nursing homes' beds; -999999 for
  15,127 transmission lines' voltage. Hospital `ttl_staff` is -999 on every
  row. Discovery records a lone negative value <= -9 beside values >= 0 as the
  column's sentinel and the predicate excludes it; an all-sentinel column is
  not offered. The first draft of the dev question (Texas nursing homes < 50
  beds) moved only 1,346 -> 1,351 with the sentinel counted, inside the
  tolerance, so it could not see the defect; replaced by Arizona hospitals
  (40, or 83 with the sentinel) before any run.
- **What it refuses to guess.** A comparison whose words name no column is
  left alone (it may be filter_attr's, on the units); one that sits on a unit
  ("counties with more than 1,000 hospital beds" is a sum) is skipped; tied
  columns are reported ("intensity" is a generated tag on mag, inj and fat);
  several event dates are reported (FUDS has three). Record-keeping dates
  (HSIP SOURCEDATE / VAL_DATE, EPA FRS, ArcGIS editor tracking) are never the
  event date, so "hospitals opened since 2015" applies nothing.
- **Column grounding** is by the column's NAME as an abbreviation of the asked
  word ("mag" of magnitude, "enroll" of enrollment, "acres" ending "gisacres"),
  then catalog label / description, then tags. A tag decides only when it is
  the only column any word reaches ("students" -> tot_enroll). Units, not
  synonyms: kV -> voltage, MW -> capacity_mw.
- **Four planner habits needed deterministic repairs**, each found on dev:
  1. The named-data check refused "more than 100 beds": no ATTRIBUTE measures
     it, the step's column does. A phrase is now covered by a value filter
     read from the same number and a shared word (`said` on the filter).
  2. `select_features` was never offered for "Which hospitals in Missouri have
     more than 100 beds?"; the model counted hospitals per county and compared
     the COUNT to 100. `queryWantsLocations` now also accepts "which / show
     <things>" with a value comparison; it reaches **0 of 297** existing eval
     questions.
  3. The model `load`ed a layer's column row ("Mag") as a county series, 3 of
     3 attempts though the validator said count_features. When the question
     compares that very column, the load becomes count_features
     (`loadedColumnAsCount`); a column load with no comparison is left alone.
  4. The model's own filter_attr restating the threshold is folded into the
     value filter; after a count, a downstream aggregate `count` (counties
     passing) becomes `sum` (Arizona read 15, its county count, for 40).
- **Dev, qwen3:14b, `off/2048`** (one build per row, 3 runs on the last):

  | run | MO beds > 100 | AZ beds < 50 | OK tornadoes | fires 2020 | total |
  |---|---|---|---|---|--:|
  | r1 (filters only) | NO_ANSWER | WRONG_MEASURE | NO_ANSWER | NO_ANSWER | 0/4 |
  | r5 a / b / c | CORRECT x3 | CORRECT, CORRECT, WRONG_MEASURE | WRONG_SHAPE, NO_ANSWER, WRONG_VALUE | NO_ANSWER x3 | 2, 2, 1 /4 |

  Run r4c read 3/4 (tornadoes and fires CORRECT), so neither of those is out
  of reach; both fail on things outside this change:
  - **Tornadoes**: when planned `select_features -> summarize` the answer is
    32 = gold. Planned `count_features -> filter_area -> aggregate(sum)` it is
    58-77: a track crossing three counties counts three times. Pre-existing
    count_features semantics for LINES, not the filter.
  - **Fires**: retrieval often picks the perimeter ARCHIVE (every saved
    version: 481 rows for 29 fires) over current perimeters, and the response
    then dies with `Invalid string length`: 481 full-resolution polygons
    exceed V8's string limit. Pre-existing; select_features ships full
    geometry. When it picks current perimeters it is CORRECT (14 = gold).
  - **Arizona WRONG_MEASURE**: the AHRF county "Licensed hospital beds"
    series instead of the Hospitals layer, measure choice.
- **Held out, scored once (not to drive changes): 0/3.** Power plants
  >= 500 MW returned 42 features for gold's 42, jaccard 0.909 (2 extra, 2
  missed: boundary membership, not the comparison); transmission "345 kV or
  more" refused by the named-data check (coverage did not match that
  wording); campuses > 20,000 students returned EMPTY. Not investigated
  against the held-out wording, per the plan.
- **Scorer**: `{fkey:...}` now keys a line or polygon by its first vertex
  (`ST_Points`), the same key `feature_key` already took from GeoJSON; for
  points it is unchanged. Full `gis_ops.yaml --self-test` 174/175: the one
  failure, `p-oh-hospitals-near-fire` wrong0 scoring CORRECT, fails
  identically with the committed scorer, so it predates this change.
- **Guards, same build** (`eval/gis_ops/vf/guard-*`): answerability 9/10
  refused, **0/20 false refusals** (recorded 10/10, 1/20); the miss is
  rainfall, answered from "Average annual precipitation, 1991-2020", a measure
  loaded since that gold was written. research.yaml 72.2% (recent 77.8-88.9%):
  no value filter, load rewrite or gate fired on any of its 18 questions (API
  log), and both changed paths are inert without one, so the misses
  (hospital-distance-mo, obesity workflow, uninsured, rainfall, schools) are
  not this change. One run each.
- **Not done**: equality ("5-star", "2 lanes"); filters on uploaded layers
  (they report no value columns); the two pre-existing defects above.
  `within`, `overlay` and `summarize` read `select_features` steps, so they
  get filters through them; only the dev questions above were run live.

### H6 tier 1, item 3: nearest with identity, and k, built 2026-11-20

`backend/planner/nearest.js` (gate, field repair, two plan repairs), SQL in
`ops/nearest_distance.js` (`compileNearestK`), output join in `compile.js`
(`nearestOf`), tests `planner/test_nearest.js` (14). Eval family `nearest` in
`eval/gis_ops.yaml` (4 dev, 2 held out), written before any planner run.
Evidence `eval/gis_ops/nearest/`.

- **Two field variants on `nearest_distance`, set in code, never offered to
  the model.** `identify` (each unit also carries `nearest_name`, the
  layer's "name, city, state", so the many "Mercy Hospital"s can be told
  apart) and `k` + `k_stat` (`mean` of the k nearest, or the `kth`; the k
  names travel nearest first). Read from the question: "which / what is the
  nearest X", "name the nearest", "the 3 nearest", "second-closest". Prompt and
  schema byte-identical across 48 contexts. Without a variant the SQL is
  exactly what it was. The validator checks the fields, since a follow-up plan
  comes back from the browser.
- **k needs a unit to measure from** ("each county", a named unit): "the 5
  closest hospitals to Kansas City" names a point, and a per-county mean of
  five distances would answer something else; it is left alone and noted.
  Local geocoding of a named point is tier 2.
- **Exact, the same way the plain form is**: the k planar-nearest (`<->`) are
  k features within d0 = the largest of their geodesic distances, so the true
  k-th is within d0 and every feature that close is in the box that holds a d0
  circle. **Equal to brute force** (every unit x every hospital, ranked by
  geodesic distance; `eval/gis_ops/nearest/brute_force.js`): MO k=1 and k=3,
  AK k=2 kth, AK/MT/HI k=5, RI tracts k=3 kth, **599 units, 0 value and 0 name
  differences**. All 3,233 counties: plain 335 ms, named 333 ms, k=5 418 ms.
- **The name survives filters and ranks.** filter_area / filter_place /
  filter_attr / rank select `(fips, value)`, so the output joins the nearest
  step back on by fips (`nearestOf`). Any op that makes a new value (normalize,
  combine, aggregate) ends it: the name would no longer describe the number.
  The first version put that join before the geometry join's `USING (fips)`,
  which Postgres refused as ambiguous; found by the brute-force run.
- **Gate reach**: fires on the 6 family questions and **0 of 291** other eval
  questions. The first pattern allowed one word of layer name and missed
  "which fire station is nearest" (dev); now up to three, the last judged
  (a unit noun such as "tracts" means the question is about the units).
- **Three planner / check habits, each found on dev, each fixed generally:**
  1. The named-data check refused "how many miles away" and "average distance
     in miles" (2 of 4, run 1) and "second-closest" (1 of 12): `many much
     average mean median` and the ordinals `first`-`tenth` are now exempt
     words. A phrase that also holds a noun ("average income", "second
     homes") is still checked on the noun.
  2. "Which hospital is closest ..." planned `count_features(Hospitals) ->
     filter_area` joined to `nearest_distance(Hospitals)`, 3 of 3: "which" read
     as a count. The join dropped the name, or with the inputs swapped made the
     count the value (DE 1 of 3, within_tol 0.09). When the question asks
     which feature is nearest and a join pairs a count of a layer with the
     distance to that same layer, the count side goes and its place filters
     move onto the distance (`dropCountBesideNearest`).
  3. "The average distance from each Texas county to its 3 nearest" planned an
     `aggregate(mean)` over the counties, 3 of 3 once (2) was in: one number
     for Texas. When k's mean came from the question, a mean over all units of
     that step is dropped (`dropMeanOverUnits`).
- **Scorer**: `compare.names: true` checks the third gold column against each
  row's `nearest_name` (case and space insensitive, 95%), so a distance with
  no name, or the second-nearest named at the nearest's distance, is not
  CORRECT. `--check-gold` 0 problems, `--self-test` 29/29 on the family.
- **Dev, qwen3:14b, `off/2048`**:

  | run | MO name | TX mean of 3 | KS 2nd-closest | DE tract name | total |
  |---|---|---|---|---|--:|
  | r1 (variants only) | NO_ANSWER | NO_ANSWER | CORRECT | CORRECT | 2/4 |
  | r2 a/b/c (+ exempt words) | WRONG x3 (count join) | WRONG_SHAPE, CORRECT, CORRECT | CORRECT x3 | WRONG, CORRECT, CORRECT | 1, 3, 3 /4 |
  | r3 a/b/c (+ count repair) | CORRECT x3 | WRONG_SHAPE x3 (mean over counties) | CORRECT x3 | CORRECT x3 | 3, 3, 3 /4 |
  | r4 a/b/c (+ mean repair) | CORRECT x3 | CORRECT x3 | CORRECT, NO_ANSWER, CORRECT | CORRECT x3 | 4, 3, 4 /4 |
  | r5 a/b/c (+ ordinals) | CORRECT x3 | CORRECT x3 | CORRECT x3 | CORRECT x3 | **4, 4, 4 /4** |

- **Held out, scored once: 1/2.** Montana nursing homes, named: CORRECT.
  Iowa, mean of the four closest law enforcement agencies: "could not produce
  a valid plan". Not investigated against its wording, per the plan.
- **Guards, r4 build** (`eval/gis_ops/nearest/guard-*`): answerability 9/10
  refused, **0/20 false refusals** (same as the item 2 build; the miss is
  rainfall again). research.yaml **77.8%** (14/18; recent 72.2-88.9%),
  r-hospital-distance-mo CORRECT. The nearest gate fires on none of either
  suite's questions.
- **Held-out 16 (r4 build, then r5 twice): answered 2, 1, 0 of 16, all
  wrong** (recorded 0 of 16 at H5). Q16 ("mobile field inspection
  locations" -> Mobile Home Parks, count per county) passed the relevance
  check as a `narrower` proxy in 2 of 3 runs, where H5's three runs refused
  it; Q1 (schools near TSCA facilities) once took an ACS school-enrollment
  count as "total estimated student population", which H5 judged not
  covered. Neither path reaches this change: the nearest gate does not fire
  on either question, and neither phrase consists of the newly exempt words.
  Both are model verdicts that vary run to run; the Q16 one is the oldest
  confidently wrong answer in the set. Recorded, not fixed here.
- **UI**: `nearest_name` shows in the county table ("Nearest" column), the
  hover readout and both exports (CSV column, GeoJSON property); the legend
  carries the value label ("mean miles to the 3 nearest features") for these
  layers only. Checked live: Missouri named, Texas k=3.
- **Not done**: identity for features-to-features (`within`: "the nearest
  hospital to each school"), which needs a column in the features contract
  that every feature op passes through; k nearest from a named point
  (needs local geocoding, tier 2).

### H6 tier 1, item 4: composite index, built 2026-11-21

`backend/planner/composite.js` (gate, weights, directions, method, the plan
repairs), op `ops/composite.js`, tests `planner/test_composite.js` (32). Eval
family `composite` in `eval/gis_ops.yaml` (4 dev, 2 held out), written before
any planner run. Evidence `eval/gis_ops/composite/`.

- **The model chooses the measures and nothing else.** `composite` takes 2 to
  6 series (the first op with a `[min, max]` arity; the validator and the
  registry test now accept one). Everything an analyst would call the method
  is read from the question in code, set on the step, and echoed in the
  response ("Composite: composite of percentile ranks, weighted sum, the
  weights stated: Poverty 50% (higher scores higher); Median household income
  25% (lower scores higher); ...") so the user can change it:
  - **weights**, by tier: (1) stated shares ("transit at 50%, poverty at
    30%"; a percentage after "above / more than" is a threshold, not a
    weight; shares not totalling 100 are rescaled, and the response says so)
    and stated ratios ("twice as important as", "double weight on"), several
    of which are solved as AHP pairwise judgments (log least squares; Saaty's
    consistency ratio reported when every pair is judged, flagged at >= 0.10);
    (2) emphasis ("primarily X, while also considering Y and Z") as 2 to 1;
    (3) a published index is loaded, never rebuilt: the gate needs the
    question to list criteria, so FEMA's "composite risk value" is not a
    composite; (4) equal, 1/N, the default. A stated weight that cannot be
    tied to exactly one input applies NO stated weights and says so; entropy /
    PCA weights are not implemented and are noted, never guessed.
  - **directions**: "high" unless a cue sits next to the measure's words, not
    across "and" or a comma ("low income", "close to transit", "few
    hospitals"). A distance reads near / far vocabulary. A negation that is
    the measure's own subject ("adults WITHOUT health insurance", "limited
    English") is not a cue on a rate, only on a count; a cue word in the
    measure's own name ("Low birth weight") never is. A dry run caught the
    uninsured rate inverted before any API run.
  - **method**: weighted sum (compensatory), geometric mean (a zero in any
    input zeroes the score) or minimum (the bottleneck: "cannot make up for",
    "high on all three"). Geometric over z-scores falls back to percentiles.
  - **standardize**: percentile rank (SVI's convention, default), z-score
    (the layer is then diverging), min-max.
  - **threshold masking** is a filter on that input before the composite: the
    composite is an inner join, so a unit failing it has no score.
- **Scores are within the area asked about.** Standardization runs over the
  joined units, so a place filter after the composite moves onto its first
  input (unless the question says "nationally"), and a state the question
  names but the plan left out is added there.
- **Equal to independent gold** (compiled SQL vs hand-written SQL that counts
  strictly smaller values over n - 1, live DB): Missouri equal weights, Texas
  stated weights with an inverted input and a distance, Georgia minimum,
  Kentucky emphasis, Tennessee geometric: **743 counties, max |diff| 2.2e-16**.
- **Gate reach: 0 of 321** existing eval questions (every suite plus the
  held-out CSV), all 6 family questions. Prompt and schema byte-identical
  across 48 contexts; the choice line, prompt line and worked example appear
  only when the gate fires.
- **Gold**: `--check-gold` 0 problems, `--self-test` 26/26 on the family. The
  self-test caught two golds that could not tell right from wrong, both fixed
  before they could score a run: c-tn-geometric's top 10 read the arithmetic
  mean CORRECT (now values over every county), and c-ky-emphasis as a top 10
  needs value_rel_tol 0.005 to separate emphasis from equal weights (the op
  equals gold to 1e-16, so the tight tolerance costs nothing).
- **Defects found on dev, each fixed generally:**
  1. `/api/research` split every two-sentence composite question into a
     workflow; the first step planned the composite and later steps replaced
     it (3 of 4, r1). A composite question is now one plan unless a later
     sentence refers back (`workflow.needsWorkflow`; unchanged on every
     existing question, since the composite gate reaches none of them).
  2. **`minimum` bound three weights it never used**: 12 parameters for 9
     placeholders, refused at execution on a plan that had validated (r3a).
     The same trap as combine's `scaled`; a test now checks every method's
     bind count.
  3. "High on all three of A, B and C ... the lowest of its three percentile
     ranks" planned rank x3 -> intersect x2 (r2, r3b, r3c) despite a choice
     line for it. When the question asks for a composite AND states the
     minimum method, intersected top lists are rebuilt as the minimum
     composite (`intersectAsComposite`).
  4. A rank on each input truncated it before scoring (r3a); it moves after
     the composite. The rank after a composite runs highest-first unless the
     question asks for the least ("which counties are most in need" once
     ranked ascending, overlap 0).
  5. The plan once dropped the named state entirely and scored 3,132
     counties (r4a): `restrictToNamedArea`.
  6. Suite, not plan: the Georgia measures accepted only CDC PLACES; County
     Health Rankings' adult obesity / diabetes / physical inactivity were
     scored WRONG_MEASURE (r1). Widened, recorded in the suite.
- **Dev, qwen3:14b, `off/2048`, `--endpoint research`**:

  | run | MO equal | TX stated | GA minimum | KY emphasis | total |
  |---|---|---|---|---|--:|
  | r1 | WRONG (workflow) | CORRECT | WRONG_MEASURE (suite) | NO_ANSWER (workflow) | 1/4 |
  | r2 (+ one plan) | CORRECT | CORRECT | INCOMPLETE (intersect) | INCOMPLETE (suite compare) | 2/4 |
  | r3 a/b/c (+ choice line) | CORRECT x3 | CORRECT x3 | bind error, intersect, intersect | WRONG (asc), CORRECT, CORRECT | 2, 3, 3 /4 |
  | r4 a/b/c (+ bind, ranks, intersect) | CORRECT x3 | NO STATE, CORRECT, CORRECT | CORRECT x3 | CORRECT x3 | 3, 4, 4 /4 |
  | r5 a/b/c (+ named state) | CORRECT x3 | CORRECT x3 | CORRECT x3 | CORRECT x3 | **4, 4, 4 /4** |

  Mean 21-31 s per question.
- **Held out, scored once: 2/2** (Colorado "twice as heavily" ratio,
  Tennessee geometric mean).
- **Guards, r5 build** (`eval/gis_ops/composite/guard-*`): answerability 9/10
  refused, **0/20 false refusals** (same as the item 2 and 3 builds; the miss
  is rainfall again). research.yaml **77.8%** (14/18; recent 72.2-88.9%),
  the same misses as the item 2 guard run (uninsured, the obesity workflow,
  rainfall, schools). The composite gate fires on none of either suite's
  questions. One run each.
- **UI**: op label "Composite index"; the plan reads "weighted sum of the
  percentile ranks of step 1 (50%), step 3 (25%, lower scores higher) ...";
  the legend and exports carry "composite score (0 to 1, weighted sum of
  percentile ranks)" through any rank or filter after it; the inputs come
  back as part layers. `npm run build` passes; not checked in the browser.
- **Not done**: follow-up edits of the weights ("double the weight on X"
  after an answer is a new question today); data-driven weights (entropy,
  PCA, correlation / VIF down-weighting) and a warning when two inputs nearly
  duplicate each other; canonical presets as data (EJScreen's burden x
  demographic product); the components' standardized values in the table
  (part layers carry raw values); composites at tract level were not run
  live (the op is in `levels.LEVEL_OPS`).
