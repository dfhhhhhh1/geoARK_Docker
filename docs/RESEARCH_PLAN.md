# Research workflows: plan

Status (2026-10-30): **Phase A in progress.** Everything below Phase A is a
plan, not a result.

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
