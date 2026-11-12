# Analyst GIS operations: plan

Status (2026-11-11): **H0 built** (section 8); H1-H5 are a plan. Follows
RESEARCH_PLAN.md (A-E built, F/G planned) and DATA_LOADING_PLAN.md (phases 1-7).

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

`overlay` with area/length of the clipped part; NFHL flood zones and NWI
wetlands by state on request (both are large; per state, as blocks were
decided); flood-zone definition in `definitions.yaml`.

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

### H5. Network (G4)

pgRouting + OSM roads (local, `osm2pgrouting`) for the fixture region first:
`service_area` (drive, walk at a stated speed), `route` with one-way and a
barrier layer. No live traffic: peak-hour questions answer free-flow and say
so. VRP / balanced clustering last, as a compute op.

*Done when:* family **network** correct 3/3 against pgRouting-independent gold
(for a few hand-checked pairs) and drive times within 15% of a reference.

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
