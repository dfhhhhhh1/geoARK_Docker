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
| A plain `docker compose up` drops the GPU, and `make up-gpu` does not put it back | `ollama ps` reads `100% CPU`; every planner call times out at 90s and the API reports "could not produce a valid plan" | Recreating any service without `-f docker-compose.gpu.yml` cascades to `ollama` and rebuilds it with no device request. `make up-gpu` then only **restarts** the container, it does not recreate it, so the config never changes. Use `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --force-recreate ollama embedder`, and confirm with `docker inspect geoark-ollama-1 --format '{{json .HostConfig.DeviceRequests}}'` returning non-null |
| **Top-level `temperature` is ignored by Ollama** (fixed 2026-09-29) | Run-to-run flakiness that every probe had to average over | `callLLM` sent `temperature` beside `messages`; Ollama reads only `options.temperature` and says nothing. Every call ran at the model default: **qwen3:14b 0.6, gemma3:4b 1.0**, not the 0.1-0.2 recorded throughout this file. Verified in the ollama log (`temp = 1.000` vs `0.000`). Every planner number before 2026-09-29 was measured at those defaults |
| **4,096-token context overflow** (fixed 2026-09-29) | "Plan invalid" retries; ollama log shows `slot context shift ... n_discard = 2045` | The planner prompt is ~3,600 tokens; qwen3's reasoning pushed past 4,096 and Ollama silently discarded the first half of the prompt, i.e. the system instructions, mid-answer. Now `num_ctx` 8,192 for the planner and 4,096 for gemma, with `OLLAMA_KV_CACHE_TYPE=q8_0` + flash attention so both stay resident on 16 GB (at 8,192 each, Ollama evicted one per switch). Check `ollama ps` shows both, 100% GPU |

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

### Spatial statistics without PySAL (2026-09-10)

`hotspot` (Getis-Ord Gi*) and `outlier` (Tukey fence on the IQR) are **pure
SQL**. The plan was a Python sidecar; it turned out not to be needed. Gi* over
binary contiguity weights is a join against an adjacency table plus two
aggregates, so it stays inside the read-only transaction, inside the
`(fips, value)` contract, and off the dependency list. PySAL earns its keep for
weights schemes this does not implement, distance bands and kernels, not for
this.

`county_neighbors` is materialized (`make neighbors`, 18,608 pairs, mean 5.79).
Computing it inline is 511ms, measured, which is payable once and wasteful per
query.

**`ST_Intersects`, not `ST_Touches`.** Touches is the textbook contiguity test
and the wrong one here: TIGER county polygons are generalized, so a shared
border is often a hairline overlap rather than a clean shared edge, and Touches
drops those pairs. That would remove real neighbours from the weights and
quietly change every score. Same family as the `filter_place` sliver problem, in
the other direction.

**Validated against known answers, not just "it ran".** On poverty rate the
hottest cluster is Puerto Rico and the coldest are Fairfax VA and the Denver
suburbs; on median income the outliers are Loudoun, Falls Church, Santa Clara.
The number that actually pins it is **mean Gi\* = −0.008 across 3,221
counties**: a standardized statistic must average to zero, and an implementation
error in the weights or the variance term would not.

`outlier` uses the median and IQR rather than a mean and standard deviation,
because both of those are dragged by the very values it is looking for, and
these distributions are heavily skewed, which is already why the choropleth uses
quantile bins.

**Three ops were added and the decision space did not grow.** `hotspot`,
`outlier` and `combine` all gate on the question's PHRASING via `offered(ctx)`,
which now receives the query. For every question that is not asking for them
they are absent from the enum and the prompt, so the 48-context prompt snapshot
is still byte-identical and the pre-existing probe queries see exactly the op
set they saw before. This is the lever that makes op-set growth affordable;
without it, the measured cost of going 7 ops to 8 says this would have hurt.

`hotspot` is additionally gated on `county_neighbors` being populated, the same
way `filter_place` is gated on `place_geom`: an op that can only fail should
never be offered.

**Measured, and the first measurement was misleading.** The 26-query probe read
80.8% op appropriateness against 95.2% before, which looks like the op-budget
cost arriving. It was not. Split by age:

- **Pre-existing 21 queries: 20 correct, exactly 95.2%, unchanged.** The gate did
  its job; nothing regressed.
- New statistics queries: 1 of 5 on that run.

Re-run three times (`eval/stats_probe.yaml`, `--suite-file`), the new queries
score **4 of 5 every time**: hotspot, outlier, combine and the rank control all
3/3. The single-run 1/5 was variance at temperature 0.1, and a 5-query sample is
too small to read once. **Repeat a small suite before believing it.**

The one consistent failure, `hotspot-clusters`, is **retrieval, not planning**:
"show me clusters of counties with high uninsured rates" retrieves six facility
layers (biodiesel plants, crushed stone operations) and no health-insurance
attribute, so the model correctly emits no steps. The same question phrased
"where are the hot spots of people without health insurance" retrieves 10
correct ACS attributes and plans `load -> hotspot -> output` every time. The word
"clusters" derails decomposition. Same family as `density-per-area`.

`generatePlan` now logs `ops offered:` for exactly this reason: "the model did
not use op X" and "op X was never on the menu" look identical from outside and
need different fixes.

**Signed output needs a different ramp, and the backend says so.** Both ops emit
values around zero, and the sequential blue would paint a cold spot and a hot
spot as two shades of one colour. The op declares `diverging: true` and it
travels with the layer, because the frontend cannot infer it: a run that happens
to be all-positive is still a diverging measure. Bins are symmetric about zero
from the quantiles of |value|, so the neutral colour stays on zero.

### The year dimension, and what more data did to the planner (2026-09-10)

`acs_county_values` is keyed `(fips, census_code, year)`. `load` takes an
optional `year`; omitting it means the latest vintage THAT MEASURE has, which
differs per measure, so there is no default to hardcode. Both the field and its
prompt section are gated on the question mentioning time, so the 48-context
snapshot is unchanged for everything else.

277 measures loaded from USDA ERS, CDC PLACES and County Health Rankings
(`make county-values`). Coverage 4,893 -> 5,162. The catalog grew by only 269
rows because **the year is a column, not a row**: `Unemployment2023.csv`'s 101
attribute names are 9 measures x 24 years.

**The probe moved a long way, in the right direction.** 26 queries:

| | before | after |
|---|--:|--:|
| op appropriateness | 80.8% | **92.3%** |
| forbidden op rate | 3.8% | **0.0%** |
| op diversity | 0.50 | 0.65 |

All four statistics queries flipped to correct, including `hotspot-clusters`,
which was recorded above as a retrieval failure. **It was, and the data fixed
it**: "clusters of counties with high uninsured rates" now retrieves real
uninsured measures instead of biodiesel plants. The lesson is that a retrieval
failure attributed to phrasing can be a coverage problem wearing phrasing's
clothes, and adding data is sometimes the cheaper fix than prompt work.

`known_item.yaml` is unmoved at 91.7% recall@1 / MRR 0.958, so a 4% larger
corpus cost nothing measurable in ranking. That suite tests 12 pre-existing
attributes, so it proves nothing regressed, not that the new measures rank well.

**`place-metro` is now a flake**, not a regression: correct in the previous
probe, no-plan in this one, and `filter_attr operator "=" value 32200` on a
manual retry. Repeat it before acting on it.

**Two defects this load introduced, both mine, both found by looking.** ERS uses
ACS-style year RANGES (`2008-12`, `2019-23`); matching only the leading year left
`-12` glued to the label and split one measure into three
("Bachelor's degree or higher", "...-12", "...-23") that retrieval could not
tell apart. Ranges are now dated by their END year, the convention ACS uses. And
`combine` bound `scale` for every operation while only `ratio` references it, so
`difference` sent three parameters for two placeholders and Postgres rejected it
**at execution, on a plan that had validated and compiled**. A test now checks
that every op's bound parameter count matches the `$n` its SQL actually uses.

**Near-duplicates are the new retrieval risk.** There are now 42 unemployment-ish
attributes across three sources. The first trend query compared ERS
`UNEMPLOYMENT_RATE` against a County Health Rankings unemployment measure and
returned -99% everywhere: valid, executable, wrong. The cause was example
copying, the only `combine` example loading two DIFFERENT attributes; a
year-gated example showing the same attribute twice fixed it. 36% of the new
rows still have two-word descriptions, which is the `gen_desc` gap from the 392
bare facility rows, now slightly larger.

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

### Two measures from one question (2026-09-03)

"Show me population and poverty rates" was answerable all along and the answer
was being thrown away. `join` has always emitted `a.value AS value, b.value AS
value_b`; the final SELECT listed only `r.value`, so the second series died one
line before the result. Carrying it out is a conditional column plus a
`withSecond` set of CTE names.

**The set is the load-bearing part.** Every other op selects `(fips, value)`
explicitly and therefore DROPS `value_b`, so `load -> load -> join -> rank ->
output` has one column. Emitting `r.value_b` for it would be a SQL error at
runtime, on a plan that validated: the failure mode this project keeps hitting,
in the other direction. Two tests pin both cases.

Measured end to end: "total population and poverty rate for each county" plans
`load -> load -> join -> output`, `series: 2`, Los Angeles 10,040,682 and 14.0%.

Not a bivariate choropleth. One number is in the color and a switch says which;
a 2D color matrix needs a legend most people will not read. Both numbers are
always in the hover readout, both columns in the table, both in every export.

Caveat that is data, not code: that run returned **1,524 counties, not 3,220**,
because retrieval chose `S0102_C01_001E` for "total population" and that subject
table only covers 1,524 counties. The join dropped nothing the first series did
not already lack. Same family as the `density-per-area` flake: a plausible
attribute with quietly narrow coverage.

### Map controls, and the stuck-tooltip class of bug

`sticky: true` tooltips were bound per county. Leaflet's `mouseout` is not
reliable at the edge of the container, so a label could stay on screen with the
pointer nowhere near it. Rebinding or calling `closeTooltip` harder does not fix
it, because the missed event is the problem.

The readout is now React state in an overlay, and the map wrapper's own DOM
`mouseleave` is the backstop: it fires when Leaflet's does not. The overlay is
`pointer-events-none`, because a readout that can receive the pointer steals the
`mouseout` from the county underneath it, which was one of the original causes.
Verified through the backstop path specifically, not the happy path.

**Typing in the question box reset the map.** `FitToData`'s effect depended on
an array rebuilt inline during render, so every keystroke re-ran `fitBounds` and
discarded the user's zoom. Memoizing it is the fix; a signature ref is the
second guard, so refitting now depends on the RESULT changing rather than on the
effect re-running. Verified: 21 keystrokes, zero map DOM churn.

Opacity is applied with `setStyle` rather than by remounting. The GeoJSON key
deliberately excludes it: rebuilding 3,233 polygons on every tick of a slider
drag is visibly slow. Series and theme stay in the key, because those genuinely
change every fill.

Basemaps (`lib/basemaps.ts`) are public tile services, no API key. The
no-cloud-APIs rule is about inference, and OSM tiles were already being fetched;
what is new is that two more hosts see the area being viewed. Point every `url`
at a local tile server if that matters. Satellite carries a labels overlay at
`zIndex 650`, because Esri's imagery has no place names and a county fill over
unidentifiable ground is not a map.

### The op registry, and the plan as a real DAG (2026-09-10)

Adding an op used to mean editing **seven files** and nothing enforced that they
agreed. Twice they did not, and both failures were invisible: an op named in the
prompt but missing from the decoding enum costs a repair round on a plan the
model was never able to emit, and op validation that lived in a loop beginning
`if (!src) continue` was skipped entirely for every op carrying `attr_id: ""`.

An op is now one module in `backend/planner/ops/` declaring its arity, required
fields, result shape, grounding rules, narrowing predicate, prompt line, worked
examples, validation and compilation. `planSchemaFor` and `buildSystemPrompt`
both derive from the same `offered(ctx)` call, so **they cannot disagree by
construction**. See [docs/OPERATORS.md](docs/OPERATORS.md).

**Ordering stays central, because order is behavior.** The decoder reads the
enum in order and the model reads the prompt top to bottom, so the four orders
are explicit arrays in `ops/index.js`. They genuinely differ; deriving one from
another would change the bytes the model sees.

**The refactor was pinned, not trusted.** `snapshot_prompt.js` captures the
prompt and schema across all 48 narrowing contexts and fails on a one-byte
change. Everything measured about this planner rests on that text, so a
restructuring that quietly reworded it would invalidate 95.2% op appropriateness
without anything looking wrong. It is a behavior test, not a formatting one:
re-baseline with `--write` only when a prompt change is the intended change.

**The plan was always a DAG; the compiler was not.** Split (one step feeding
several consumers) already worked, because a step is a named CTE. What did not:

- **Multiple outputs.** A plan may now carry several `output` steps; each
  compiles to its own statement over only the CTEs it reaches, and returns as a
  separate layer. All of them run in ONE read-only transaction, so every layer
  sees the same snapshot.
- **Mixed layers.** The `select_features` rule was "must be alone in the plan".
  It is now "may only be consumed by an `output`", which is the rule that was
  actually meant, and it lets a point layer and a choropleth come back together.
- **Prelude pruning.** Postgres never evaluates an unreferenced CTE, so a shared
  prelude would have been correct. It is pruned anyway because the generated SQL
  is shown to the user, and a listing that declares steps the query does not run
  misrepresents what happened.

**The planner is not yet told any of this.** The prompt still says to end with
exactly one output. Enabling multi-output is a prompt change and gets measured
on its own; same for `ops/combine.js` (ratio / sum / difference /
percent_change), which is written and tested but deliberately not registered.
Op-set size is the thing that costs accuracy, so a new op goes in behind its own
`plan_probe.py` run rather than riding along with a refactor.

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

### Literature expansion from SemMedDB (2026-09-28)

`backend/expansion.js`, `etl/build_semmed_index.py`, `docs/EXPANSION.md`.
Integrated from the `searchImprovement/` prototype. It links a condition in the
question ("coronary heart disease") to UMLS, looks up what PubMed says causes or
is associated with it (obesity, hypertension, smoking), and searches the catalog
for those too, under a new purpose `expanded`.

- **On by default since 2026-09-29** (`EXPAND_ENABLED=1`), and `expand: true|false` is a
  per-request field on unified-search and analyze, so an A/B needs no container
  recreate. Needs `make semmed` first.
- **Cannot move known_item.yaml, by construction.** Expanded results are
  appended after every decomposed sub-query. Use `eval/expansion.yaml` with
  `--score-depth` larger than `--top-k`, or the A/B reads "no effect" because it
  never looked at the appended rows.
- **Prompt is byte-identical when nothing expands**: `snapshot_prompt.js`
  passes across all 48 contexts. When it does expand, candidates appear under a
  separate "LINKED IN MEDICAL LITERATURE" heading, after facility layers. That
  is new planner input and needs `plan_probe.py --expand` vs `--no-expand`, 3x.
- The prototype's runtime scispaCy linker (GBs resident) and PubMed calls (the
  question leaves the machine) were deliberately not ported. Aliases come from
  scispaCy's KB **file** at build time; without it, "high blood pressure",
  "stroke", "COPD" link to nothing (SemMedDB names are clinical).
- Measured on the real file: 1,894,930 of 130,480,195 predications survive the
  filters. Among the top neighbors of every disease were "Inflammation",
  "Pathogenesis" (`patf`) and "sex"/"Gender" (`orga`), which are excluded as
  neighbors.
- **The guessed cutoff silently disabled it.** `EXPAND_MIN_SIM=0.72` rejected
  every concept: concept names score 0.61-0.68 against the rows they should
  find, 0.43-0.60 against rows they should not. Now 0.61, set on the same 8
  questions it is scored on. The first "on" run also read an "index not
  loaded" answer cached from before `make semmed` and ran unexpanded; the
  negative cache is now 10s and a skip is logged.
- **UMLS aliases fire on non-health questions.** 3 of 26 plan-probe questions
  linked: "hot spots" -> a dog dermatitis, "transmission" -> disease
  transmission, "educational attainment" -> Academic achievement (a true
  synonym, wrong domain). Fixed by seed rules, not a word list: no `patf`
  seeds, `inbe` links by own name only, and mention-to-concept similarity
  >= 0.6 (homonym 0.479, lowest correct link 0.738). Now 0/41 probe and 0/37
  regression questions expand. Popularity (`n_rel`) cannot separate them:
  suicide is 12, the dermatitis 21.
- Reach: related-measure recall 7/8 -> 8/8 on `eval/expansion.yaml`, but only
  2 of 8 needed expansion to get there, and the suite is lenient. Planner: 8/8
  same primary attribute, never planned over an unasked-for linked candidate.
  One run each. Details in `docs/EXPANSION.md`.

### `correlate` and the relevance check (2026-09-29)

`docs/CORRELATE.md`. The research-readiness review found the system could map
and rank but not TEST a relationship, and could answer confidently with data
measuring something else ("average rainfall" -> mean of reading scores).

- **`correlate`**: two series -> one row. Spearman rho headline (skewed data),
  Pearson, slope, 95% CI and p on an **effective n** discounted by Moran's I
  (~0.6 for PLACES, so n_eff ~ n/2). Pure SQL. Verified: income ~ diabetes rho
  -0.691 / r -0.631 reproduced exactly by an independent Python implementation;
  Moran's I of random noise -0.011. Gated on relationship phrasing + adjacency;
  snapshot byte-identical. A statistic may only feed an `output` (validator).
- **PLACES ~ PLACES correlations are inflated** by shared model covariates
  (smoking ~ COPD 0.936). The UI warns; don't cite them as findings.
- **Relevance check**: retrieval similarity CANNOT detect unanswerable questions
  (absent concepts score up to 0.65, answerable down to 0.47, rainfall 0.54).
  So it judges the finished plan: each used attribute is direct / proxy /
  denominator / unrelated; unrelated goes back through repair.
- **Its first measurement was a silent no-op**: exact label matching found no
  verdicts, and `|| "{}"` hid it. Only visible because the probe printed the
  verdicts. Unmatched is now `skipped`, never a pass.
- In 4 probe runs the check itself rejected nothing; the planner declines most
  unanswerable questions itself. What moved honest refusals 6-7/10 -> 9/10 was
  reading the planner's malformed "nothing" (output-only plans, last-attempt
  no-steps) as a refusal. False refusals 0/16 throughout.

### `explain`: ranked factors (2026-09-29)

`docs/EXPLAIN.md`. `load(outcome) -> explain -> output`; factors are attached
by CODE (literature concepts, then named concepts, then a default set), never
listed by the model. Partial Spearman after controlling income / % 65+ /
% rural, effective n from Moran's I of the residuals, BH q-values, ranked by
the CI bound nearest zero. Computed in Node (`planner/stats.js`), the first
`kind: "compute"` op.

- **The synthetic-confounder test caught a design error before real data**:
  dropping a control collinear with a factor removed exactly the confounder,
  and an income-tracking factor read partial -0.69 instead of ~0. Keep controls;
  report a factor >= 0.97 with a control as the same measure.
- **Literature direction must be counted, not listed.** roles=[cause,effect]
  hid that CVD follows FROM diabetes (733 vs 153 papers); it ranked #1 as an
  explanation. Consequences are now context, and why-questions expand by
  cause-papers (obesity's table otherwise had zero drivers).
- Measured: obesity <- physical inactivity +0.48; diabetes <- obesity +0.42
  (raw +0.67); asthma <- smoking +0.30, PM2.5 null after income.
- **The relevance check refused "what explains asthma rates"**, judging the
  outcome unrelated. Fixed by telling it each attribute's plan role; the
  answerability suite now has explain questions.
- **The relevance check was then rebuilt as extraction** (docs/CORRELATE.md):
  quote the question phrase an attribute measures + a fit; only `none` rejects,
  and only if the attribute's name shares no content word with the question
  (qwen3 twice "rejected" an attribute the question literally named). v3:
  0/20 false refusals, 9/10 honest refusals, 5.7s p50. gemma3:4b was
  benchmarked for it and is unusable (describes the question, not the
  attribute; passes "pet dogs" on household counts).
- **After fixing temperature + context** (traps table): plan_probe 92.3% op
  appropriateness unchanged, validity 96.2%, mean latency 25.5s.

### Follow-ups and user data (2026-09-29)

`docs/FOLLOWUPS.md`, `backend/followup.js`. The analysis page is a thread.

- **Edits never touch the planner.** "what about Texas", "top 10", swap a
  measure, add one side by side or as a correlation, hot spots, map your data:
  applied to the last plan in code, re-run through `validatePlan` and the
  compiler, 30-600 ms. Snapshot byte-identical across 48 contexts. The browser
  sends the plan back, so it is untrusted exactly like a model plan (24-step cap).
- **UI offers come from trying each edit server-side** (`availableFollowups`),
  not from browser rules. Keep it that way.
- **Free-text follow-ups are rewritten by gemma3:4b and SHOWN.** Two code guards
  exist because the model failed without them, 3 of 3 each: a complete question
  skips the model (it put "Ohio" into an unrelated airport question), and a
  rewrite that drops a word the user typed is discarded ("Texas hospitals" ->
  poverty by Texas county). `eval/followup_probe.py`: questions 71.4% -> 95.2%,
  held-out 8/8, 0% questions misread as edits, 3 repeats.
- **Never abbreviate a place list in text a model will read.** "Alabama,
  Arkansas and 14 more" in a title reached the rewrite and the planner guessed
  the 14 wrong. The rewrite now gets the plan's exact states and the on-screen
  measure, and an operation-only follow-up ("normalize by population") that
  loses either falls back to `"<measure>: <text> in <area>"` built in code.
- **User CSVs are never stored.** FIPS + values ride along per request, bound
  into `unnest(...)` in `load` (`source_kind: "inline"`), READ ONLY transaction.
  Provenance says `user_upload`.
- **Pre-existing, fixed on the way:** every national map opened at world zoom
  because Aleutians West crosses the antimeridian; correlation results showed a
  one-row "Summary" tab.

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
