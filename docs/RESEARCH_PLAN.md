# Research workflows: plan

Status (2026-11-11): **Phases A-D and F built; Phase E in progress.** Each has a
"Progress" entry below with the numbers; G is still a plan.
Analyst-style GIS questions (buffers, overlays, zonal, network) continue as
Phases H0-H5 in [GIS_OPS_PLAN.md](GIS_OPS_PLAN.md); baseline 0/16 correct,
5/16 confidently wrong.

Goal: let GeoARK carry out multi-step geospatial research from a natural-language
question, not just answer one question with one plan.

## 1. Where things stand

GeoARK answers **one question with one plan**: a single SQL query over county
`(fips, value)` series, about 20 ops, with code-side repairs and a relevance
check. It does this well: 100% op appropriateness on `plan_correctness.yaml`,
and honest refusals on nonsense questions.

Research breaks four of the assumptions that design rests on:

1. **One question, one plan.** Research is iterative: look at a result, decide
   the next step.
2. **County is the only analysis unit.** Tract, ZCTA and raster data are loaded
   (`geo_unit`, the grid pyramid), but nothing that plans can reach them.
3. **The only analysis shape is a series.** Comparing groups, combining
   conditions and accessibility do not fit it yet.
4. **Nothing scores whether the answer is right.** Every suite scores plans,
   retrieval or refusals. None checks the numbers that come back.

The held-out `wild_queries.yaml` probe already shows the gaps, though it is
stale (2026-09-11, before the temperature, context and relevance-check fixes):
"rural counties with high poverty and few hospitals", "south vs north" and
"biggest increase over the last decade" came back **empty**, and "average
rainfall" was **answered** when it should have been refused.

## 2. Phases

### Phase A: measure research quality before building it

- Re-run `wild_probe.py` 3x on the current build for an honest baseline.
- `eval/research.yaml`: multi-step questions written from outside the system
  (a county health officer, a grad student), each with an expected **answer**
  computed by hand-written SQL that does not go through the compiler, plus the
  wrong-but-plausible classes it should catch (percent / population, a series
  covering 1,524 counties).
- An **answer-correctness** metric: does the executed result match the gold
  answer within a tolerance. Without it, multi-step workflows would be judged on
  well-formedness, the `--endpoint analyze` trap again.
- **Show the metric can move** before trusting it: feed it a known-wrong plan
  (the Detroit percent / population plan) and confirm it fails.

*Done when:* a 3x baseline of answer correctness over `research.yaml` exists.

**Baseline, valid (2026-10-30, Phase B build, API created 14:48, never
recreated; 0 harness errors; qwen3:14b, reasoning on).** `eval/phaseA/answer-r{1,2,3}.json`:

| | r1 | r2 | r3 |
|---|--:|--:|--:|
| answer correctness | 33.3% | 33.3% | 27.8% |
| now (10) | 4 | 4 | 3 |
| phase_c (4) / phase_d (1) | 0 / 0 | 0 / 0 | 0 / 0 |
| refuse (3) | 2 | 2 | 2 |
| mean latency | 78s | 76s | 89s |

Correct 3/3: hospitals per capita (TX), Midwest density, income ~ diabetes rho,
rainfall and CKD refusals. Findings, by size:

1. **`S2201_C02_021E` (households below poverty, SNAP table) is chosen for every
   "poverty rate" question**, 13 of 15 poverty runs: top-10 MO, St. Louis,
   Detroit, access-gap, rural-poor. One retrieval/choice defect is the largest
   single cause of wrong answers. Next Phase B item.
2. **`nearest_distance` is off by more than 3% in 6% of Missouri counties**
   (3/3 runs; e.g. 29067 gold 37.1 mi, got 41.1). The single planar `<->` KNN
   neighbour is not the geodesic nearest. Fix: geodesic min over the k planar
   nearest, as the gold does; keeps the KNN index.
3. Phase C questions fail as predicted: south-vs-northeast EMPTY 3/3
   (aggregate->join of two one-row aggregates), decade change WRONG_SHAPE/EMPTY,
   rural-poor partly the poverty-measure defect.
4. Unemployment 2019->2020: NO_ANSWER 3/3, twice refused by the relevance
   check ("does not measure what this question asks"). A false refusal.
5. Flakes: fire stations lost the Colorado filter in 1/3; uninsured/large
   counties never correct (EMPTY, wrong measure, no plan).

**Suite issues to fix before comparing against this** (not system defects):
ERS `MEDIAN_HOUSEHOLD_INCOME` is not in the `income` regex (obesity-top50 r1
scored WRONG_MEASURE for it); `r-refuse-schools` answered with CHR education
measures (V159 reading scores, V168 high-school completion), which may be a
defensible proxy rather than a FALSE_ANSWER. Wild-probe re-runs
(`eval/phaseA/wild-r*.json`) are saved but not yet classified.

Suite fix after the baseline: ERS `MEDIAN_HOUSEHOLD_INCOME` added to `income`
(median ratio 0.96 to MEDHHINC, 3% of counties off >15%). This changes one
baseline score: obesity-top50 r1 would read WRONG_SHAPE or INCOMPLETE, not
WRONG_MEASURE, and it fails either way, so the rates above stand.
`r-refuse-schools` is left as is; whether CHR reading scores answer "best
schools" is a refusal-policy decision for the user, not a scorer fix.

**Wild probe, 3x on the same build** (`eval/phaseA/wild-r*.json`; outcome
shape only, ROWS is not correctness) vs the 2026-09-11 run:

| | 09-11 | r1 | r2 | r3 |
|---|--:|--:|--:|--:|
| ROWS | 20 | 20 | 20 | 19 |
| EMPTY | 3 | 2 | 2 | 2 |
| NO_PLAN | 1 | 2 | 2 | 3 |

- Better: rainfall (`w-out-of-scope`) now refused 3/3 (answered on 09-11);
  "of the counties in Texas, which ten..." now answered 3/3 (no plan on 09-11).
- Still failing: south-vs-north EMPTY 3/3, the same aggregate->join shape as
  `r-south-vs-northeast`; "rural + high poverty + few hospitals" EMPTY 2/3.
  Both are Phase C.
- Changed: "Tell me about poverty" now NO_PLAN 3/3 (answered before). The
  suite note asks for "something, or an explanation"; check that the refusal
  explains itself.
- "Biggest increase in poverty over the last decade" returns ROWS 2/3 via
  `load->load->normalize->aggregate->rank`, a ratio of two series, not a change
  over time. ROWS only; see `r-unemp-decade` for the scored version.

Phase A is done: the instrument exists, is shown to move, and has a 3x
baseline on a fixed build. Next is Phase B's remaining item (the SNAP-household
poverty choice, finding 1) and the `nearest_distance` geodesic fix (finding 2),
each re-measured with `answer_probe.py --only` 3x.


### Phase B: cheap correctness fixes already known

| Item | Why |
|---|---|
| Validator refuses a percent / count `normalize` | The "Detroit" shape; deterministic, not yet done |
| Coverage-aware attribute choice (prefer >= 95% of the analysis area) | `S0102_C01_001E` (1,524 counties) beats `DP05_0001E` (3,221) for "total population"; density plans map half the country |
| Explained-outcome guard for research expansion | "what drives CKD" explained diabetes instead of refusing |
| Out-of-scope refusal re-checked on rainfall, "best place to live" | Should already hold after the relevance check; confirm |
| Cross-encoder reranker (`bge-reranker-base`) | Still the top open retrieval item: MRR 0.726 -> 0.874 to beat, no recall loss |

### Phase C: compositional ops the wild suite asks for

Each behind an `offered(ctx)` phrasing gate (48-context snapshot byte-identical)
and its own `plan_probe.py` run, 3x.

- **`intersect` / boolean conditions**: "rural AND high poverty AND few
  hospitals". Today a chain of `filter_attr` that returns empty.
- **`compare_groups`**: region A vs region B, or inside vs outside a metro;
  group medians plus a test on effective n (Moran's I), like `correlate`.
- **Relative time in code**: "last decade", "since the recession" resolved to
  concrete years against the measure's own vintages, like `applyImpliedState`.
- **Derived-concept dictionary**: "rural", "senior", "low-income", "food
  desert" -> a defined measure and threshold (e.g. % rural > 50), shown in
  provenance, never invented by the model. Same principle as the states enum.

*Done when:* `w-two-conditions`, `w-ratio-question`, `w-trend-where` correct 3/3.

### Phase D: multi-step workflows (the architectural change)

Keep each step a small validated plan; add a workflow layer above it.

1. **Named intermediate results**: an executed result becomes an inline source
   for the next plan. `source_kind: "inline"` already exists for user CSVs.
2. **Research loop**: decompose into ordered sub-questions -> plan + execute
   each -> pass the next step a compact summary (n, range, top 5, coverage),
   never raw rows -> stop on answer, refusal, or a step cap (~5).
3. **The validator grounds the workflow**: a step may only reference results an
   earlier step produced, the same rule as attributes.
4. **Output is a report**: ordered steps with layers and SQL, a methods
   paragraph generated from provenance, exportable as a reproducible bundle.
5. **Latency budget**: 5 steps x 46s is 4 minutes. Planner reasoning `off`,
   relevance check reasoning on, once Phase B's validator rule removes the
   Detroit shape.

*Done when:* `research.yaml` correctness measured end to end; a 3-step workflow
under 90s on GPU.

### Phase E: multi-scale geography

`DATA_LOADING_PLAN.md` phases 5-7, already designed and the data loaded: ops on
`(level, geoid)`, `aggregate_to`, `apportion`, `zonal`, `tract_neighbors`,
first as follow-up edits ("show this by tract"), then a phrasing-gated `level`
field. Display forces the Leaflet / MapLibre decision.

### Phase F: spatial methods research questions need

| Method | Answers | Notes |
|---|---|---|
| Accessibility (2SFCA) | "where is it hardest to see a doctor" | facility supply, population demand; Euclidean first, OSM + pgRouting (local) later |
| Buffers / catchments | "people within 10 mi of a refinery" | `zonal` over WorldPop gives population in any polygon |
| LISA (local Moran's I) | high-high / low-low clusters, spatial outliers | pure SQL over `county_neighbors`, complements Gi* |
| Change detection | trends across vintages, with significance | `combine percent_change` + year dimension |
| Spatial regression (lag / error) | multivariate explanation | where PySAL earns a `compute` sidecar |
| ACS MOE propagation | "is this difference real" | MOE rows exist, only demoted today |

### Phase G: data research questions assume exists

Climate and environment rasters (PRISM / gridMET, NLCD, 3DEP) via
`load_raster.py` + `zonal`, which turns "rainfall" from a refusal into an
answer; kidney disease; the 22 never-imported catalog datasets; block
population for `w_pop`.

**Blocking Phase G, found 2026-11-12: tract and block-group measures are loaded
but not findable.** EJScreen, Food Access, USALEEP and Smart Location (106
measures) have no catalog rows, so the planner refuses "highest PM2.5 tracts in
Missouri" as missing data. Loading more tract-level data does not help research
questions until this is fixed. Plan, options and done-when:
[DATA_LOADING_PLAN.md](DATA_LOADING_PLAN.md), "Open: tract-only measures are
not findable".

## 3. Order

**A -> B -> C -> D**, with **E** in parallel (mostly ETL and display), and F/G
pulled in by whichever `research.yaml` questions fail. A first because every
later step is a claim that needs its number; B because multi-step workflows
compound confident wrong answers.

Risks: op-budget growth (gating, and a workflow layer keeps each prompt small);
VRAM over long sessions (`MAX_LOADED_MODELS=1` + 5 steps = many swaps, which
makes qwen3.5:9b's 5.7 GB attractive); compounding error across steps (why Phase
A scores the final answer, not each step).

## 4. Progress

### Phase A

Built 2026-10-30:

- `eval/research.yaml`: 18 questions (10 `now`, 4 `phase_c`, 1 `phase_d`,
  3 `refuse`), gold answers in hand-written SQL bound to whichever acceptable
  measure the plan loaded. `--check-gold`: all 44 (question x acceptable code x
  alternative) gold queries run and are non-empty; the metro geographies match
  the documented counts (St. Louis 15 counties, Detroit 6).
- `eval/answer_probe.py`. **The metric was shown to move before it was used**:
  `--self-test` 69/69. Gold fed back is CORRECT; shuffled values are not; every
  declared wrong answer gets its declared class, including the "Detroit" plan
  (poverty % / population -> WRONG_VALUE, which every other suite scores as a
  success), a dropped state filter (WRONG_GEOGRAPHY), zero-count counties lost
  to a WHERE (INCOMPLETE), kilometres for miles and Pearson for Spearman
  (WRONG_VALUE), and the half-coverage population series (WRONG_MEASURE).
- **A harness defect caught on the first run**: three HTTP 502s from a redeploy
  scored as CORRECT_REFUSAL on the refuse tier. Transport errors are now
  `HARNESS_ERROR`, excluded from every rate, and the probe aborts if the API
  container is recreated mid-run. Same family as the ablation that "showed no
  difference" because it never ran.

**Baseline: not yet valid.** Three attempts on 2026-10-30 ran while other
sessions recreated the API container (14:04, 14:09, 14:16); runs are in
`eval/phaseA/void/` and are not results. The three questions that executed
before the first redeploy were all WRONG_MEASURE, each a plausible attribute
nothing else would flag:

| question | loaded | |
|---|---|---|
| top 10 Missouri counties, share of people in poverty | `S2201_C02_021E`, HOUSEHOLDS below poverty, from the SNAP table | not people |
| Texas hospitals per 100,000 residents | `S0102_C01_001E` | 1,524-county population series |
| Midwest population density | `S0102_C01_001E` | same |

The second and third are Phase B's coverage-aware item, measured end to end.

**Correction, same day:** these three are NOT a pre-Phase-B sample. The image
they ran on (built 09:16) had already picked up some in-progress Phase B files
from the shared working tree (`units.js`, `coverage.js`, `series_stats.js`;
not `outcome.js` or the reranker), per the Phase B session. They show the
failure classes the suite detects, not a "before" for Phase B. There is no
clean pre-B baseline; the first valid baseline will be taken on the finished
Phase B build, and Phase B's own gain needs its own A/B (per-request flags),
not a comparison against these.

### Phase B

Built 2026-10-30; details and numbers in CLAUDE.md, "Phase B: cheap correctness
fixes". Prompt and schema byte-identical across 48 contexts.

| Item | Status | Evidence |
|---|---|---|
| Validator refuses rate / count `normalize` | **done** | Detroit, reasoning off: rejected on attempt 1, repaired to load -> filter_place -> output (6 counties); the log names the rule |
| Coverage-aware attribute choice | **done** | Texas 98/254 and Midwest 436/1,055 swapped to full-coverage population; equivalence checked by value (DP02_0122E rejected, ratio 0.002) |
| Explained-outcome guard | **done** | CKD + PubMed: expanded subject rejected, then refused (was: explained Diabetes) |
| Out-of-scope refusal re-check | **half** | rainfall refused 3/3; "best place to live" answered 2/3 as rank(median income), a `proxy` verdict, once with an empty quoted phrase |
| Cross-encoder reranker | **built, off** | best MRR 0.826 (target 0.874); known-item R@1 91.7% -> 66.7% for that arm; `fuse` +2.2pp concept recall, MRR 0.756 |

For a Phase B A/B on the answer suite: `coverage: false` and `rerank` are
per-request; the rate / count rule and the expanded-subject guard are always on
and have no flag, so their effect is shown by the attributed log lines above.
answer_probe's `population` regex accepts DP05_0001E | POP_ESTIMATE only; the
coverage swap can legitimately choose CHR_V051_RAWVALUE (CHR's population,
agreeing by value), which the probe then scores WRONG_MEASURE.
*Resolved before the Phase A baseline:* the `population` regex now accepts
CHR_V051_RAWVALUE (verified: median ratio 1.000 to POP_ESTIMATE, 0 counties
off >10%), and the baseline scores both coverage-swapped questions CORRECT 3/3.

### Phase C

Built 2026-11-09; design in [CONDITIONS.md](CONDITIONS.md). Prompt and schema
byte-identical across 48 contexts. Tests: `planner/test_conditions.js` (27),
`etl/test_definitions.py` (5).

| Item | What was built |
|---|---|
| `intersect` | several conditions on different measures: each condition filters its own measure, then a semi-join |
| `compare_groups` | two groups of one measure: per-county rows tagged a / b, plus a `comparison` summary: median difference, rank-biserial, Mann-Whitney p on Moran's-I effective n. Verified against independent Python to 1.4e-7 |
| Relative time | a counted period ("last decade") is re-counted from the measure's own latest year (2013-2023 for ERS, not 2016-2026). A change reads later minus earlier. A measure covering under 70% of the period is refused with its years. The time and combine gates now see "rose / fell" and "last decade" |
| Definitions | cited, vintage-pinned data (`etl/definitions.yaml`, sidecar `definitions:`), attached only to measures retrieval returned, re-checked against the loaded data and withheld with a reason. `percentile` is the unit-free fallback. A stated percentage on a 0-1 fraction is converted |

**The scaling question, answered by construction, and tested live.** No term
list: retrieval decides which measure a word means. A definition is data with a
citation, and it is re-tested on every corpus load. Inserting the 2013 Urban
Influence rule and a percent-declared `% Rural` rule into `concept_definition`
got both withheld on reload, with readable reasons. Nothing requires an entry:
an undefined qualifier falls back to a percentile.

**Measured on one fixed build** (`eval/phaseC/answer-v3-r*.json`, `wild3-v3.json`,
`regress-r*.json`, `answer-full-r1.json`; qwen3:14b, reasoning on):

| | Phase A baseline | Phase C |
|---|--:|--:|
| phase_c tier, answer correctness | 0/12 | **3/12** |
| plan shape right on phase_c questions | ~0 (EMPTY, WRONG_SHAPE) | **12/12** |
| `r-unemp-decade` | 0/3 | **3/3** |
| wild `w-two-conditions` | EMPTY 2/3 | ROWS 3/3 |
| wild `w-ratio-question` (south vs north) | EMPTY 3/3 | ROWS 3/3 |
| wild `w-trend-where` (poverty, last decade) | ROWS 2/3 (a ratio, not a change) | refused 3/3, correctly: no loaded poverty measure spans 7+ years |
| full `research.yaml`, 1 run | 33.3 / 33.3 / 27.8% | 38.9% |
| `now` tier / refuse tier | 4,4,3 of 10 / 2 of 3 | 4 of 10 / 2 of 3 |

**The 9 remaining phase_c failures are measure choice, every time.** That is
Phase A finding 1, unchanged: the poverty questions load `S2201_C02_021E`
(households below poverty, from the SNAP table) 6 of 6 times, and south vs
northeast loads `S2101_C02_034E`, an unemployment rate from the veteran-status
table, 3 of 3. The plans are the right shape over the wrong attribute. This is
retrieval / attribute choice (Phase B's open item), not Phase C. PCTPOVALL's
catalog description is the bare code "PCTPOVALL", the `gen_desc` gap again.

**Prompt changes outside Phase C questions.** The phrasing gates now fire on 12
of 121 eval questions, all condition or comparison questions, after three false
matches were fixed (CONDITIONS.md). In `plan_correctness`, filter-high-income
is 3/3 and hotspot-clusters is 2/3, one run with no plan. That one needs a
repeat before it is called a regression.

**Defects found by measuring, all fixed, each with a test:**
1. The planner set its own years and a second measure for "last decade" (ERS
   2000 against County Health Rankings 2020).
2. `difference` read earlier minus later, so "rose the most" listed the
   biggest falls.
3. A one-year ACS table produced a "2018-2018" trend.
4. A two-vintage CHR series answered a decade as 2020-2025.
5. `repairStates` overwrote BOTH groups of a comparison with the one census
   region the question named, which emptied every comparison of that shape. A
   pre-existing repair; group comparison was the first plan to have two areas.
6. A period refusal read "could not produce a valid plan". It now says the
   loaded data does not cover the period.

*Done-when status:* `w-two-conditions` and `w-ratio-question` now produce
answers 3/3, and `w-trend-where` is an honest refusal. Their scored analogues
are correct only where the attribute choice is right. The mechanisms are done.
Correctness on these questions is now gated on attribute choice.

### Phase D

Built 2026-11-09, static version; design in [WORKFLOWS.md](WORKFLOWS.md).
`POST /api/research`, `backend/workflow.js`, tests `backend/test_workflow.js`
(12). Prompt and schema byte-identical across 48 contexts. Measured with
`answer_probe.py --endpoint research` (`eval/phaseD/`).

| | before the gate | with the gate |
|---|--:|--:|
| one-plan questions split into a workflow | **4 of 15** | **0 of 17** |
| `r-obesity-top50-income` (phase_d) | 3 of 4 runs | 2 of 3 runs |
| full research.yaml through /api/research | 56.2% (16 scored, 2 proxy timeouts) | 38.9% (18 scored) |
| mean latency | 92 s | 71 s |

`r-obesity-top50-income` is **5 of 7 correct** across all runs: top-50 median
$38,320 (gold, exact), rest $61,002 against gold $61,420. Both failures are q2
returning no valid plan after the repair rounds. A correct run takes 112-202 s.
Through plain `/api/analyze` this question has never been answerable.

**The gate came from measuring.** Without it, the decomposer split 4 one-plan
questions ("rose the most over the last decade" became "compute the change",
then "rank it"), and two of those splits cost the answer. None of the four
refers back to an earlier part; the real workflow question does ("their").
Decomposition now runs only on anaphora or several sentences. Over 121 eval
questions that fires on 1, the workflow question. A missed workflow runs as one
plan, which is exactly the behaviour before Phase D.

The answers on one-plan questions match plain analyze, within the known flakes
(`r-fire-stations-co` lost its state filter, as in the Phase A baseline).
`r-unemp-decade` was refused once: the planner chose a two-vintage series on
every attempt, though ERS has 2000-2023.

*Done-when status:* `research.yaml` correctness is now measured end to end
through workflows. A 3-step workflow under 90 s is NOT met: the 2-step one takes
112-202 s with planner reasoning on.

**Next:**
1. ~~The period refusal should name the candidate measures that DO span the
   period.~~ Done 2026-11-10 (`vintages.js` `alternatives`): the repair text
   names up to 3 candidates by label with their years. `r-unemp-decade`
   correct in all 14 runs since, every arm (the baseline below already had
   it); refused in the 2026-11-09 runs before it.
2. ~~Planner reasoning off, measured, for latency.~~ Done 2026-11-10, below.
3. Adaptive steps: decide the next step after seeing q1's summary.
4. The UI: steps, methods text, the `comparison` card.
5. "Around Detroit" -> metro, not five cities named Detroit (wrong in every
   run of every arm once the measure was right; 2 of 2 answerability
   false refusals involve it or "seniors").
6. Uninsured rate: "uninsured in the biggest counties" never loads a rate
   (DP03_0117E, a count of the insured, 3 of 3).

**Measure choice, exact distances, reasoning off (2026-11-10).** Answer
correctness over the full suite, one build and corpus per row, no run
contaminated (`eval/ersdesc/`):

| | runs | mean | s / question |
|---|---|--:|--:|
| baseline: qwen3:14b, reasoning on | 44.4 | 44.4% | 67 |
| + ERS variable descriptions | 61.1 / 61.1 / 55.6 | 59.3% | 56 |
| + executable-first retrieval | 61.1 | 61.1% | 62 |
| + `PLAN_THINK=off/on` (no exec-first) | 61.1 / 72.2 / 72.2 | 68.5% | 22 |
| qwen3.5:9b `off/512` instead | 61.1 / 50.0 / 66.7 | 59.3% | 20 |
| + dead-step rule + medical stopwords, `off/on` | 72.2 / 83.3 / 72.2 | **75.9%** | **23** |
| same fixes, reasoning on | 72.2 | 72.2% | 81 |

The WRONG_MEASURE class went from 8 of 18 to 1-2. What it took, in order of
effect:

1. **ERS descriptions.** 67 ERS rows had their code as their description
   (PCTPOVALL read "PCTPOVALL"), so the standard poverty rate was never
   retrieved. `etl/ers_variables.yaml` is ERS's documentation as data,
   checked against the loaded values; `make county-descriptions` applies it.
   Retrieval guards unmoved (known_item 91.7% / 0.944, concept 97.8 / 97.3%).
2. **Reasoning off for the planner** picks ERS `UNEMPLOYMENT_RATE` where
   reasoning on picks the veterans-table rate, every run. Answerability with
   the fixes: 10/10 refused, **2/20 false refusals** (0/20 recorded for
   reasoning on). Now the default.
3. **Exact `nearest_distance`** (`<->`'s first row was wrong for 222 of 3,233
   counties; CLAUDE.md, Geospatial ops).
4. **A step no output reads is refused**, and **generic medical words cannot
   overrule a relevance rejection** ("what drives CKD" explained COPD 3/3).

Two defects in the tooling, found on the way: `reload-corpus` swapped the
vectors but not the rows (planner saw old descriptions while retrieval used
new ones), and a catalog edit without `make reindex` reloaded the old cache
key. Both in CLAUDE.md's traps table.

Not a gain: executable-first retrieval (no change in one run, kept as the
`executable_first` flag), and qwen3.5:9b (no faster than 14b with reasoning
off, and answered 2 of 3 rainfall questions).

**Phase D closed (2026-11-11).** Done-when met: a **3-step workflow is correct
3 of 3 in 56-59 s** (`d-smallest50-diabetes10-distance`: least populous 50 ->
top 10 diabetes -> distance to a hospital), and `research.yaml` correctness is
measured end to end. Measured on `eval/research_advanced.yaml` (new, 24
questions, tiered D/E/F; see CLAUDE.md) through `/api/research`:

| | phase_d tier (6) | research.yaml (18) | s / workflow |
|---|--:|--:|--:|
| before (2026-11-10 fixes only) | 2/6 | 75.9% mean | 41-65 |
| after | **4, 5, 4 of 6** | **88.9, 83.3%** | 43-59 |

Answerability after: 10/10 refused, 1/20 false refusal ("where do seniors
live", intermittent with reasoning off since 2026-10-16).

Each fix is a deterministic repair of wiring the model gets wrong the same way
on every attempt (`planner/rewire.js`, `validate.js`), or a gate measured over
all 151 eval questions:

| failure (reasoning off, 3 of 3 unless noted) | fix |
|---|---|
| intersect(q1, income): q1's values, and q1 minus income = empty | earlier result goes second in intersect |
| nearest_distance(q1): "expects 0 inputs" | bridge given an input -> bridge, then intersect |
| step ignores the one earlier result it was handed | restrict every chain start to it |
| filter_place -> load (chain upside down), Detroit NO_ANSWER 4 of 5 | uninvert |
| "around Detroit" = five towns called Detroit | area phrasing + no state -> the metro (CBSA) |
| mean(a), mean(b), join -> EMPTY | an ungrouped aggregate may only feed an output |
| "their neighbouring counties" split into a workflow | a back-reference counts only across a clause break (1 of 151 questions changes) |
| "least populous" refused: "population" is generic | population-size phrasing exempts a total-population count |
| "different from", "poorest quarter" never offered compare_groups / percentile | gates widened (2 of 151 questions change) |

Still open: `d-poor-quarter-smoking-copd` WRONG_VALUE 3/3 (rho 0.58 against
0.65: the quarter is not built as the gold's), `d-unemp-outliers-poverty`
INCOMPLETE 2/3, and adaptive steps (the decomposition is still fixed up
front). The first advanced-suite baseline also showed what D cannot reach:
phase_e 0/8 and phase_f 1/7, all of them WRONG_MEASURE or NO_ANSWER for want
of sub-county planning and spatial methods. That is Phases E and F.

**Fixes after first use (2026-11-09).** Three demo workflows all failed. The
API log showed four separate causes, all fixed and tested
(`planner/test_rewire.js`):

1. **Earlier-result labels wired as step inputs.** The planner wrote
   `intersect(s1, "a1")` with the earlier result's LABEL as an input, 3 of 3
   attempts. Now a load is inserted in code (`loadLabelInputs`).
2. **Rate divided by a count, re-emitted.** The validator refused uninsured
   rate / population, and the model re-emitted it 3 of 3 times. Code now keeps
   the rate and reports it (`dropRateOverCount`).
3. **Planner timeouts on workflow steps.** qwen3:14b reasoning on a workflow
   step's longer prompt passed `LLM_TIMEOUT_MS` (90 s) on 2 of 3 attempts, at
   100% GPU with VRAM free. Planner calls now use `PLAN_TIMEOUT_MS` (180 s);
   gemma keeps 90 s as the stall detector.
4. **`comparison` was dropped.** The executor computed it, and the analyze
   response dropped it, so no compare_groups verdict ever reached a client.

After: all three demos complete on the first attempt, in 79-96 s (was 240 s+,
then failure). "30 lowest-income counties: obesity higher?" gives 47.8% vs
37.9%, rank-biserial 0.95, p 2.6e-5 on effective n 7 / 841. Only 23 of the 30
counties have PLACES obesity values.

### Phase E

Built 2026-11-11, in progress; mechanism in DATA_LOADING_PLAN.md ("Phases 6-7,
the planner at other levels"). Prompt and schema byte-identical across 48
contexts throughout: the model never chooses a level. Tests:
`planner/test_levels.js` (11). Measured with the `phase_e` tier of
`eval/research_advanced.yaml` through `/api/research`, 2 runs per row:

| | phase_e (8) | what changed |
|---|--:|---|
| before Phase E | 0, 0 | nothing below the county was plannable |
| levels + county kind + "city of" gate | 3, 3 | St. Louis tracts, Cook County ZIPs correct |
| + asked state, roll-ups, unit-only candidates | 3, 3 | roll-ups ran on county-only measures |
| + deep search within the unit's measures | **4, 4** | tract spread correct |
| + suite fix (weight not a required measure) | Michigan roll-up CORRECT on re-run | |

Guards on the final build: `research.yaml` 83.3, 83.3% (88.9 / 83.3 before),
answerability 10/10 refused and 1/20 false refusals (unchanged).

Correct every run: tracts in St. Louis city (gold's top three exactly), ZIP
areas in Cook County, the WorldPop county estimate, the population-weighted
tract roll-up to Michigan counties (compiled SQL: 83 of 83 counties within
0.01 of gold), the spread of tracts within Missouri counties.

**One of those passes is luck, not capability:** the spread plan was
load -> aggregate_to -> per_area -> filter_area, dividing a standard deviation
by land area. It cleared the 0.6 top-10 overlap anyway. A validator rule
against per_area on a rate is the fix; not done.

Found on the way, and fixed: 31 catalog rows the ledger records were missing
(SVI county, WorldPop), so those measures were never retrievable
(`etl/restore_ledger_catalog.py`); restoring them made SVI compete with ERS for
"unemployment rate", and a change between two named years on a one-year
measure would have read as zero everywhere (now refused with the candidates
that have both years); `SVI_E_TOTPOP` was accepted as a population by value
(median ratio 0.997 to POP_ESTIMATE, 95 of 3,133 counties off >10%).

**Still failing:**

| question | why | fix |
|---|---|---|
| densest 4 km grid cells in Colorado | correct plan, but `rank` limit 4 for an unnumbered "most"; the scorer needs 5+ | a default when the question gives no number |
| uninsured rate for every tract in Denver | 5 of 181 tracts are other states' Denvers | the user's to settle (report the spread, as `cityAmbiguity` does for features) |
| which counties ZIP 65721 falls in | no crosswalk lookup op | a lookup over `geo_crosswalk` |

Also not done: ZIP -> county roll-ups (crosswalk shares), `tract_neighbors`
and the statistics ops below the county, the grid query's 190 s.

**Correction (2026-11-11): the grid query's 190 s is not per_area.** The
relevance check's reasoning runs to the 180 s LLM timeout on it, then fails
open; the SQL takes ~0.5 s (timestamped api log, 2 of 2 runs). Same on the
tract count_near question below. Spun off as its own task (bound that call's
reasoning, measured against the refusal suites).

**Distance ops below the county (2026-11-11).** `nearest_distance` and
`count_near` now compile at any level (`planner/levels.js` LEVEL_OPS); county
SQL unchanged. Tests: `planner/test_levels.js` (15). Evidence: `eval/phaseE/`.

- `nearest_distance` measures from `geo_unit.pt` (inside its unit at every
  level, 0 of 1,064,152 outside) with the same two-step geodesic search as
  counties. **Equal to brute force on every tract** in AK, HI, MT and MO;
  2.7 s for all 85,529 tracts.
- `count_near` per unit is a LATERAL index probe, not the county form's plain
  join: Postgres estimated the EXISTS-filtered features at 1 row (7,517),
  materialized them and ran 643M ST_Intersects, **95 s** for tracts. LATERAL:
  **1.5 s**, equal to brute force on all 11,279 tracts of AK/MT/MO/CA, tract
  total = county total (7,517). It carries the per-axis prefilter fix from
  the count_near longitude session.
- **The named-unit candidate filter dropped every feature layer**, so neither
  op could ever be planned below the county. Features are now kept at the
  answer's unit when the question asks about distance (`levels.asksDistance`),
  minus layers matched only through a location column ("Zip", "City",
  `LOCATION_COLUMN`, built from the catalog's own names): "Which ZIP codes"
  retrieved the "Zip" columns of College Campuses and Biodiesel Plants, which
  the planner tried to load as ZIP data. Unconditional, the layers derailed
  the grid and Michigan roll-up questions; the gate fires on none of the 6
  existing level questions.
- `levelOf` accepts a singular ZIP after each / every / per / by: "each ZIP
  code in Montana" answered 56 counties, silently.

Live, final build: Missouri tracts from the nearest hospital 4/4 (1,654
tracts), Colorado tracts' hospitals within 3 mi of a fire station 4/4 (1,447),
"each ZIP code in Montana" 4/4 (366), county control 4/4 (Douglas 37.1 mi,
the gold). **"Which ZIP codes in Montana are farthest from a hospital" plans
1 of 5**: valid on attempt 1 once, otherwise the planner reaches for other ops
and never uses nearest_distance. Open.

Guards, final build (two runs each): phase_e **5/8, 5/8** (all five recorded
correct, misses are the three open items above); `research.yaml` 77.8, 77.8%
(83.3-88.9 earlier today: `r-refuse-schools` answered on the model's own
"proxy" verdict and `r-poverty-top-mo`'s SNAP-household flake, neither on a
path these changes touch); answerability 10/10 refused in 3 runs and 9/10 in
1 (`r-snowfall`, the model's own "broader" verdict), 1/20 false refusals
(`a-seniors`, the recorded flake). Snapshot byte-identical.

**Three regressions this work found in H0 (GIS_OPS_PLAN.md), fixed before
the final runs**, all because H0's guards were not run on the phase_e tier:
the overrule rule counted the dataset name and the "(covers N counties)"
note as part of the attribute's name, so the overrules that had rescued SVI
poverty, SVI no-vehicle and coronary heart disease from false "none" verdicts
stopped firing; and the named-data check read "How far, in miles" as data.

### Phase F

Built 2026-11-11, with GIS_OPS_PLAN.md H1 (the catchment questions are its
done-when). Evidence: `eval/gis_ops/h1/`; tests `planner/test_phase_f.js`
(6) and `planner/test_features.js` (19). Every op gated on its own phrasing;
a scan of all eval questions shows each gate fires only on its target
question; snapshot byte-identical.

| question | before | after | how |
|---|---|---|---|
| people > 20 mi from a hospital (MO) | WRONG_MEASURE | CORRECT x4 | catchment by tract (`planner/catchment.js`) |
| share within 5 mi of a hospital (CO) | WRONG_MEASURE | CORRECT x4 | same, + scalar ratio, `totalTheDenominator` |
| 2SFCA hospital access (TX) | EMPTY | INCOMPLETE, values exact | `access` op; see below |
| unemployment vs neighbours | NO_ANSWER | CORRECT x2 | `neighbors` (spatial lag over county_neighbors) |
| Midwest unemployment change | CORRECT | CORRECT | unchanged |
| least precise poverty estimates (MO) | WRONG_MEASURE | CORRECT x2 | bounds sub-queries + combine example + `repairPrecision` |
| diabetes vs income residual | INCOMPLETE | CORRECT x2 | `residual` (regr_slope / regr_intercept) |

phase_f tier **1/7 -> 6/7** (`final-advanced.json`).

- **`access` (2SFCA)** is one pass over (county, facility) pairs, each county
  centroid an index probe of the facility layer; compiled SQL equals the
  gold on all 254 Texas counties (max difference 7e-15). The plan is right
  (`load -> access -> filter_area -> rank asc 10`) and its 10 values match
  the gold exactly, all 0.0. The suite still scores INCOMPLETE because its
  compare is `values` over ~all 254 counties, chosen so that a distance list
  cannot pass, and 24 counties tie at zero access, so a top 10 is an
  arbitrary 10 of them. Not edited after the run. Options: score a ranked
  answer by its values plus tie-aware membership, or have `rank` return the
  ties at its cut (`FETCH ... WITH TIES`); both are changes to measure.
- **The precision question needed three things, all found by running it**:
  one combined "confidence interval upper and lower bound for poverty rate"
  sub-query ranked the bounds 10th-12th (two bound-specific ones rank them
  first); combine was not offered on precision phrasing; and the plan ranked
  `asc` for "least precise" (overlap 0.0). Interval width is upper minus
  lower and a wider interval is less precise, both stated by the question and
  the bounds' own descriptions, so code sets them (`planner/uncertainty.js`).
- **`derefPlan` kept its own list of label-carrying ops**, and `access` was
  not on it: the 2SFCA question was refused three attempts running for
  citing "a8", a label that was on its list. The list now comes from each
  op's `grounds` in the registry (the same trap count_features hit when it
  was added).
- **The named-data check read "30-mile catchment" as missing data.**
  catchment / radius / buffer are now exempt, like distance words.
- Not built: LISA (local Moran's I), spatial regression (lag / error), ACS
  MOE propagation for differences. The table above covers the questions
  `research_advanced.yaml` asks.
