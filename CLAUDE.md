# GeoARK, working context

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
- `eval/queries.yaml`, concept coverage. Assertions are satisfied by hundreds
  of rows, so it **cannot detect ranking changes**. Regression guard only.
- `eval/known_item.yaml`, rank of one specific attribute. This is the sensitive
  instrument. Use it for anything about retrieval quality.
- `--endpoint analyze`, plan validity / execution success. **Well-formedness
  only.** `planned` is one line: `"plan" in payload && !payload.error`. A plan
  that divides nonveteran-above-poverty by "Moved in 2015 to 2016" scores a
  full success on all three of its metrics. Never judge planner *quality* with
  this.
- `eval/plan_probe.py` + `eval/plan_correctness.yaml`, op appropriateness and
  op diversity. This is the sensitive instrument for planning, the analogue of
  `known_item.yaml` for retrieval. `op_diversity` is the direct test for a
  planner that has latched onto one worked example: it scored 0.12 (a single op
  sequence across eight different questions) while `--endpoint analyze`
  reported 87.5% plan validity for the same run.

## Traps that have already burned time

| Trap | Symptom | Fix |
|---|---|---|
| `docker compose up -d api` does **not** recreate a container whose image is unchanged | The API serves vectors cached at its startup; an ablation "showed no difference" because both arms read the same stale cache | `--force-recreate`, and check `corpus_stale` on `/api/health` |
| ETL scripts were baked into the job image | Script edits silently ran stale | Now bind-mounted; still rebuild if you change deps |
| `CREATE TABLE IF NOT EXISTS` ignores new columns | Loader fails with "column does not exist" on an established DB | Explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `etl/schema_reference.sql` |
| One failed table import logs ~1000 errors | Every row insert repeats "relation does not exist" | Count distinct messages, not lines |
| `ST_Transform` on the **facility** side of a spatial join | Non-sargable; disables the GIST index; 5 min instead of 3 s | Transform the county side, or neither when SRIDs match |
| gdb table names are opaque hashes | Tempting to rename to human names | **Don't**, 29 of 83 rows in `etl/facility_table_map.csv` are keyed on those hashes |

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

- Retrieval: 97.8% concept recall / 97.3% query success (37 queries), p50 1.0s
  on GPU.
- Planner: `POST /api/analyze` executes. **94.1% op appropriateness** on
  `eval/plan_correctness.yaml` (16/17), which is the number that actually means
  something; forbidden-op rate 0.0%. `PLAN_MODEL=qwen3:14b`, mean 19s.
  The one failure is `density-per-area`, a long-standing flake where bare
  "population density per square mile" retrieves housing-occupancy columns and
  no total-population series.
- **`op_diversity` decays as the suite grows.** It is distinct op sequences over
  query count, so adding queries that intentionally share a shape lowers it
  without anything getting worse: 11 distinct sequences read 0.73 at 15 queries
  and 0.65 at 17. It is a strong signal of template-copying (it caught 0.12) and
  a weak one of anything else. Read it against a fixed suite or not at all.
- Coverage: **4,893 of 6,860 attributes (71.3%)** resolve to a physical column
  that actually holds data, 3,257 ACS plus 1,636 facility. It read 5,232 until
  2026-09-01, when the 339 declared-but-valueless ACS codes were excluded.
- `eval/collect.py --label <name>` bundles results plus the environment that
  produced them, for comparing across machines.

### Correction: the planner was never reading the question (2026-08-31)

`callLLM` in `unified_search_server.js` accepted a `userPrompt` argument and
never sent it, `messages` carried only the system prompt. `generatePlan` puts
the question *and* the entire AVAILABLE ATTRIBUTES list in `userPrompt`, so the
planner had never seen either. It was working from rules and worked examples
alone, which is why it emitted the examples' own labels (`a3`, `a8`, `a5`).
Those always dereference to *some* candidate, so grounding passed and every
plan validated on attempt 1 while being unrelated to the question: "how many
hospitals are in each county" planned a count over Oil And Natural Gas Wells.

Decomposition was unaffected because it interpolates the query into its FIRST
argument, which is why retrieval numbers never showed this.

**This invalidates the `PLAN_MODEL` A/B measured earlier the same day** (25% →
100% plan validity for `gemma3:4b` → `qwen3:14b`). Both arms were reciting
in-context examples, so that comparison measured example-copying fidelity, not
planner capacity. The capacity question is now genuinely open again.

Fixing it moved op appropriateness 50.0% → 87.5% and forbidden-op rate 12.5% →
0.0% with the model and prompt held constant. Retrieval was re-checked after
the change: 97.8% / 97.3%, unmoved.

### Geospatial ops (2026-08-31)

Four ops beyond the county-value basics, all fitting the existing
`(fips, value)` contract so they compose with `normalize`, `rank` and the rest:

| op | question shape | notes |
|---|---|---|
| `filter_area` | "in Missouri", "in the Midwest" | predicate on `LEFT(fips,2)`; names are an enum in the decoding schema so a place with no FIPS code cannot be emitted. `backend/states.js` |
| `count_near` | "X within N miles of Y" | needs TWO feature datasets |
| `nearest_distance` | "how far to the nearest X" | miles from county centroid |
| `per_area` | "per square mile", "density" | divides by `aland`, **land** area; water excluded, or coastal counties read as artificially sparse |

Two performance rules these depend on, both measured:

- **`count_near` must keep the `&&  ST_Expand` bounding-box prefilter.** The
  distance test runs on `geography` so miles mean miles, but a geography cast
  cannot use the GIST index built on the geometry column, and the reference
  layers are large (transmission lines is 89,744 rows). The `&&` prefilter is
  index-assisted and a strict superset, so the exact test only runs on
  survivors: **1.2s** nationally with it, a sequential scan without.
- **`nearest_distance` must keep the `<->` KNN operator.** 187ms for all 3,233
  counties; rewriting it as a join is a cross product.

The op surface is now 12, and this project has already measured that op-set size
costs accuracy on its own. Narrowing is therefore load-bearing, and
`planSchemaFor` and `buildSystemPrompt` must agree exactly: an op named in the
prompt but absent from the decoding enum costs a repair round on a plan the
model was never able to emit.

### Mapping the features themselves (`select_features`)

A second result shape, alongside the per-county series. `select_features`
returns the individual locations, points, lines or polygons, with their own
geometry and attributes, for "where are the X in Y".

It is deliberately **not** composable. Every other op yields `(fips, value)` and
chains; features have no county key and no value to bin, so the validator
enforces `select_features -> output` and any place restriction goes inside the
step. The alternative was a "unless it's features" branch in every downstream
op. The frontend mirrors this with two components, `ChoroplethMap` and
`FeatureMap`: a choropleth encodes one number per county in color, a feature
layer encodes identity and position.

What the data supports, measured: **49 point layers (~1.97M features), 14
polygon (~466k), 6 line (~237k)**, all SRID 4326.

Two things this ran into:

- **There is no city, place, tract or ZIP boundary layer.** `county_geom` is the
  only administrative geometry, so a city restriction cannot be spatial. It is
  matched against the layer's own `city` column instead, present on 41% of
  layers. Label-column coverage generally is patchy (county/state 54%, name 49%,
  city 41%, address 35%), so `select_features` asks `information_schema` which
  columns a layer has rather than assuming a fixed SELECT list.
- **City names are not unique, and the planner would not restrict them.**
  "fire stations in Springfield, Missouri" planned `city: "Springfield"` with no
  state and returned **97 stations across 25 states**, 21 of them in Missouri.
  Both the op description and a worked example set city and state together, and
  qwen3:14b dropped the state every time. `applyImpliedState` now adds it in
  code when the question names exactly one place and the step filters only by
  city, deterministic, logged, and narrow enough not to guess.

### Attribute filters, and two things they broke on the way in

`attribute_filters` narrows a layer by its own columns, "critical access
hospitals", "open shelters". Values are discovered from the database
(`featureFilterValues`, 11ms for Hospitals), listed under the dataset in the
prompt, checked by the validator and **normalized** to the stored spelling, so
"critical access" becomes "CRITICAL ACCESS" rather than matching nothing.
Verified: the filtered count totals **1,027**, exactly the database's
`CRITICAL ACCESS` count.

On `count_features` the predicate goes in the **ON clause, not WHERE**. In WHERE
it deletes every county whose only hospitals are general ones, so the answer
silently loses counties instead of showing them as 0.

Two regressions this caused, both now fixed and both worth remembering:

1. **A field needs narrowing exactly as much as an op does.** Offered
   unconditionally, the model attached a `status` filter to Fire Stations, a
   layer with no such column, on a query that never mentioned status. It failed
   validation and, at temperature 0.1, **the repair loop re-emitted the
   identical plan all three attempts**. `attribute_filters` is now deleted from
   the decoding schema when no candidate has any filterable values, the
   explanation and worked example are withheld with it, and layers without
   filters say so explicitly rather than leaving it implicit.
2. **`city` is the one free-text field in a plan, and decoding leaks into it.**
   About half of runs emitted `"city": "Springfield','states':['Missouri']"`,
   valid JSON, compiles, matches nothing, **0 features from a plan that looked
   healthy** (the clean half returned 21). `sanitizeCity` truncates at the first
   character that cannot occur in a place name, and the validator refuses
   anything still malformed. A name must END in a letter: allowing a trailing
   apostrophe let the leaked quote survive as "Springfield'".

### Named boundaries: `place_geom` and `filter_place` (2026-09-02)

TIGER 2026 gave the thing that was missing. `county_geom` was the ONLY
administrative geometry, which is why a city restriction could not be spatial
and had to match a `city` COLUMN present on 41% of layers.

`place_geom` holds 70,012 boundaries in one table keyed on `(kind, geoid)`:
32,642 places (cities/towns), 33,791 ZCTAs, 935 CBSAs, 2,644 urban areas.
Loaded by `etl/load_boundaries.py` (`make boundaries`).

Deliberately **not** catalog attributes. Nobody asks "how many Census Tracts are
in each county"; they say "in Springfield". Loading 32,642 places x 16 columns
as searchable attributes would add half a million meaningless rows to the corpus.

`filter_place` restricts a `(fips, value)` series to counties inside a named
boundary. Four things it needed that were not obvious:

1. **Plain `ST_Intersects` is wrong.** It returned **27** counties for the
   Chicago metro, which is 13 whole counties: the CBSA and county layers are
   drawn at different generalisations, so every neighbour clips a few metres in.
   `ST_Touches` does not help, because those slivers have area. The test is
   overlap **> 1% of the smaller geometry**, which is size-agnostic: for a metro
   the smaller side is the county, for a city it is the city. Verified:
   Chicago 13, St. Louis 15, both matching the official CBSA county lists.
2. **Springfield MO is 99.9914% in Greene and 0.0086% in Christian.** That
   sliver is an artifact, not a municipal extension, so the 1% rule correctly
   answers "Greene".
3. **Metro names are compound.** The Chicago CBSA is stored as
   "Chicago-Naperville-Elgin, IL-IN", so equality on "Chicago" matched nothing
   and returned an empty answer. Matching is exact OR name-plus-separator, which
   still does not let "Springfield" reach "Springfield Gardens".
4. **Two more deterministic repairs.** `applyImpliedState` had to be extended:
   filter_place reproduced the state-dropping bug immediately, returning 24
   counties across Virginia, Nebraska and Illinois for "the Springfield,
   Missouri area". And `repairPlaceKind` forces `zcta` when the name is five
   digits: the model planned `place_kind: "place", place_name: "63101"`, which
   searched 32,642 city names for one called 63101 and returned zero rows.

Census_Tract and Block_Group are deliberately NOT loaded. They are a different
analysis unit, not a place you name, and using them needs the `(fips, value)`
contract to change.

### Regions: the gate was the hardcoding, not the enum (2026-09-01)

There were two lists, and only one was a mistake.

**The gate.** `filter_area` was offered only when the question matched one of
the 60 literal names in `AREA_NAMES`. "New England" is not on that list, so the
op never entered the decoding schema at all: the planner had no way to express
the restriction, reached for `filter_attr` instead, and **returned 0 rows with
no error**. Not unsupported, invisible. Any list like that grows one commit at a
time forever.

`queryMentionsArea` now recognises the SHAPE of a place restriction: region
words (`belt`, `coast`, `northwest`, `valley`, `new england`) and locative
phrases (`in the <Capitalised Phrase>`). A false positive costs one extra op in
the schema; a false negative silently answers a different question.

**The enum is not hardcoding.** Constraining `states` to the 56 real states
enumerates *reality*, a closed set that does not grow, and it is what stops a
place with no FIPS code being emitted. It stays.

So: the code no longer knows what a region contains, except for the four census
regions. The model expands "New England", "the Pacific Northwest", "the Rust
Belt" into member states, and the enum guarantees every name is real. Verified:
New England 67 counties, Pacific Northwest (WA/OR/ID) 119, with no entry
anywhere for either.

**Where the model cannot be trusted.** "counties in the South" emitted **38
entries spanning three regions**, the census South plus the whole Northeast plus
Arizona and New Mexico, with New York and New Jersey listed twice: 1,685
counties from Arizona to Maine, from a plan that validated. Every name was a
real state, so grounding could not catch it; only a region definition can.
`repairStates` deduplicates always, and replaces the list when the question
names exactly one census region and the plan includes states outside it. Any
other regional phrase is left to the model.

Caveat worth knowing: the model's "South" is now 12 states and the census South
is 17 (it omits DE, DC, KY, MD, OK). All 12 are inside the census South, so the
override does not fire, it only catches states OUTSIDE the region. That is a
defensible colloquial reading rather than a stable definition.

### Follow-ups when a question cannot be answered

`backend/suggestions.js`. Three distinct situations, deliberately kept apart
because they look identical to a user and have different remedies:

1. **The data was never loaded.** Retrieval matched a catalog entry with no
   table: one of the 22 from the truncated source archive. Named explicitly
   ("Public Schools, Prison Boundaries … are in the catalog but their source
   data was never imported"), because no rephrasing will ever reach it and the
   user otherwise cannot tell that from an unsupported question.
2. **Nothing usable came back.** Suggestions are drawn from `attribute_source`
   itself, a cached sample of what IS loaded, rather than hardcoded examples
   that go stale.
3. **A plan could not be built.** Suggestions come from this query's own
   resolved candidates.

**Every suggestion is grounded by construction**: built only from attributes
that resolved, so clicking one cannot fail the way the original just did.
Asking the LLM to invent alternatives would be easier and would reproduce this
project's oldest failure, confident output with nothing behind it. Verified by
running two generated suggestions end to end.

### Ambiguity that succeeds is more dangerous than failure

A city filter with no state runs fine and quietly answers a broader question:
"where are the fire stations in Springfield" returns **97 stations across 25
states**. Nothing errors, the map looks plausible, and it is downloadable.

`cityAmbiguity` reports the state spread on success, and the UI offers to narrow
(MO 21, OH 14, IL 13 …) rather than picking one: which Springfield was meant is
the user's to say. `applyImpliedState` already handles the case where the
question named the state and the planner dropped it.

### Correction: the facility cap was applied across concepts, not per concept

`MAX_FEATURE_CANDIDATES` (6) used to be filled first-come down the RRF-merged
result list. That silently loses the dataset the question is about.

Measured on "how far is each county from the nearest hospital": the sub-query
"nearest hospital" ranks Hospitals **#1**, but merging three sub-queries buries
it at **merged rank 19**, behind six unrelated facility datasets pulled in by
"county distance" and "population density". Those six filled the cap, Hospitals
never reached the planner, and the planner measured distance to Major Sport
Venues while calling it "nearest hospital", valid, executable, and wrong.

Facility slots are now allocated **round-robin across sub-queries**, so every
concept the decomposer found is represented before any concept gets a second.
This is the same failure as the per-purpose `QUOTA` issue below, in a different
cap; that one is still open.

### Provenance travels with the data

`/api/analyze` returns a `provenance` block, timestamp, the three model names,
corpus cache key, catalog size, and per-attribute origins (dataset, physical
table or census code, period). Every export carries it: CSV as `#` comment
lines, GeoJSON as a `metadata` foreign member, plus a Markdown report and a
full JSON bundle. `frontend/src/lib/exports.ts`.

A feature dataset's origin reports its **geometry column**, not `value_column`.
`attribute_source` still holds whichever column retrieval matched ("website",
"objectid"), and citing that as the source of a count is simply wrong.

### Two defects this exposed, both now fixed (2026-09-01)

1. **The candidate quota was per-purpose, not per-concept.**
   `QUOTA = { primary: 10, ... }` was filled first-come from the merged list, so
   two concepts sharing a purpose meant the first one took everything. On
   "compare median income against educational attainment" income filled all 10
   primary slots and the planner was told educational attainment did not exist,
   correctly, given what it was shown, while a direct search ranks it 1-6.

   Each purpose quota is now shared **round-robin across the sub-queries that
   carry that purpose**, so every concept the decomposer found is represented
   before any concept gets a second slot. Measured after: 5 income and 5
   education candidates, and the plan uses both. Same fix as the facility cap,
   one level up.

2. **339 of 3,596 ACS attributes were resolvable but had no data.**
   `build_attribute_source` derived "resolvable" from `acs_variables`, the list
   of codes the source CSV *declares*. 383 of those 3,980 codes have no row in
   `acs_county_values`, and 339 catalog attributes pointed at them, so a plan
   over one compiled, ran, and returned zero rows: valid, executable, empty. A
   `join` with an empty side returns nothing at all, which is how it surfaced.

   Resolvability now comes from `SELECT DISTINCT census_code FROM
   acs_county_values`, the codes that actually carry values. **Coverage is
   therefore 4,893, not 5,232** — the old figure counted 339 attributes that
   could never answer anything. Rebuild without re-importing the 10.8M values
   using the new `--relink-only` flag.

   Feature tables were checked for the same problem and do not have it. The
   four layers `pg_class` reported as empty were simply never `ANALYZE`d
   (`reltuples = -1` means unknown, not zero) and hold 7 to 48 rows each.

## Two things generated and then thrown away

1. **`gen_desc`**, `attr_gen copy.py` asks the model for a one-sentence
   description of every column alongside its tags, and no downstream artifact
   carries it. For the 392 bare-`"Name"` facility rows that is exactly the
   signal they lack. Likely the cheapest retrieval win left.
2. **`table_name`**, dropped by `merge_geospatial_attrs.py`. Already recovered
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
