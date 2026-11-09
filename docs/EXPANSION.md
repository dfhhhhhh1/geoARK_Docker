# Literature expansion (SemMedDB)

Tags and embeddings find attributes that are **described like** the question.
They cannot find attributes that are **related to** it. "Coronary heart disease
by county" retrieves heart-disease columns and never the obesity, smoking and
blood-pressure measures that are loaded and that anyone studying heart disease
would want next.

Expansion adds that. It links condition mentions in the question to UMLS
concepts, looks up what the biomedical literature says causes or is associated
with them, and searches the catalog for those too. It was integrated from the
prototype in `searchImprovement/` (gitignored, holds the 3.3 GB SemMedDB file).

```
question ─► decompose ─► hybrid search per sub-query        (unchanged)
                │
                └─► link seeds      semmed_alias      "heart disease" -> C0018799
                    related         semmed_relation   Obesity PREDISPOSES, 180 papers
                    catalog gate    hybrid search     keep if best match >= EXPAND_MIN_SIM
                                                      and it adds an unseen attribute
                    ─► results_by_query, purpose "expanded", appended LAST
```

## What changed from the prototype, and why

| prototype (`searchImprovement/`) | integrated | reason |
|---|---|---|
| scans the 3.3 GB gzip per query | `make semmed` builds `semmed_relation` once; queries are two indexed lookups | minutes vs milliseconds |
| scispaCy UMLS linker at runtime | alias table built from scispaCy's KB **file** (optional) | the linker is several GB resident, next to an LLM already filling the GPU box |
| PubMed efetch for abstracts | dropped from the query path | sends the question off the machine; paper text is not something retrieval can use |
| location / year extraction via gazetteer + dateparser | not ported | `filter_area`, `filter_place` (`place_geom`, TIGER) and the year dimension already do this, better grounded |
| first entity only | up to `EXPAND_MAX_SEEDS` (2), longest-match | "coronary heart disease" links once, as itself |

## The noise controls, all measured on real SemMedDB output

A scan of 130,480,195 predications for four seed diseases found useful
neighbors and some that would only add noise:

- **Diabetes:** cardiovascular diseases, end-stage renal failure, stroke,
  hypertension, obesity ...
- **Coronary heart disease:** hypertension, atherosclerosis, obesity, diabetes,
  hypercholesterolemia, smoking, alcohol consumption, diet ...
- **Asthma:** inflammation, obesity, wheezing, ..., air pollutants, smoking,
  environmental tobacco smoke ...

The controls:

1. **Causal predicates only** (CAUSES, PREDISPOSES, ASSOCIATED_WITH, AFFECTS,
   INCREASES, DECREASES, STIMULATES, DISRUPTS), as in the prototype.
2. **Novelty = 1.** SemMedDB marks generic hubs ("Disease", "Patients") novelty
   0; 9.6% of the seed-disease rows were those.
3. **Semantic types.** A seed must be a condition or health behavior, so
   "poverty", "income" and "hospitals" never trigger expansion. Genes,
   proteins, drugs and anatomy are dropped at build time (the largest dropped
   groups were `aapp` proteins, `bacs`, `gngm`). `patf` ("Inflammation",
   "Pathogenesis") and `orga` ("sex", "Gender") are excluded as neighbors at
   query time (`EXPAND_EXCLUDE_TYPES`). They were among the top neighbors of
   every disease, and `sex` would pull in ACS sex-by-age columns.
4. **Catalog gate, per row.** A related concept adds only attributes whose own
   semantic score clears `EXPAND_MIN_SIM` (0.61) and that were not already
   retrieved. Gating on the top match alone let "Ischemic stroke" (top 0.632)
   add "Vision disability" at 0.51, and COPD add bare column names "Conthow"
   and "Rrtp".
4b. **Seed rules**, each from a false positive on `plan_correctness.yaml`,
   questions with nothing to do with health:
   - `patf` is not a seed type: "power **transmission** lines" linked
     "disease transmission" and pulled in COVID-19.
   - `inbe` (behaviors) link only by the concept's own name, never a UMLS
     synonym: "educational attainment" is a genuine alias of "Academic
     achievement", which pulled in Smoking. "smoking" still links.
   - Mention and concept must mean the same thing (`EXPAND_MIN_LINK_SIM`, 0.6).
     "hot spots" is a UMLS alias of Pyotraumatic dermatitis, a dog skin
     condition: 0.479. Every correct link measured was 0.738 or higher
     (colorectal cancer -> Carcinoma of the Large Intestine 0.739, COPD 0.764,
     stroke -> Cerebrovascular accident 0.794).
   A popularity floor (`n_rel`) was checked and rejected: the false positives
   sit at 18-35 related concepts, but suicide (12), drug overdose (46) and air
   pollution (47) are real conditions in the same range.
5. **Same-concept rule.** "Diabetes" is a top neighbor of "Diabetes Mellitus".
   A neighbor whose words all appear in a searched phrase is skipped.
6. **Placement.** Expanded results are appended after every decomposed
   sub-query, get their own quota (`EXPAND_QUOTA`, 4), go after facility
   layers when `top_k` truncates, and appear in the planner prompt under their
   own heading ("LINKED IN MEDICAL LITERATURE ... use only if it asks about
   causes, risk factors or related conditions"). With expansion off, or on a
   question that links nothing, the prompt is byte-identical:
   `snapshot_prompt.js` still passes across all 48 contexts.

## Standing it up

```bash
# once: the scan is ~2 min (measured: 109s), then COPY + aggregate
make semmed-dry                     # counts only, writes nothing
make semmed                         # builds semmed_relation / _concept / _alias
make semmed UMLS_KB=umls_2022_ab_cat0129.jsonl    # + UMLS aliases (recommended)
```

`SEMMED_DIR` (default `../searchImprovement/search/search`) is mounted at
`/semmed` in the `etl` job. The UMLS KB is scispaCy's own data file; put it in
the same folder:
`https://ai2-s2-scispacy.s3-us-west-2.amazonaws.com/data/kbs/2023-04-23/umls_2022_ab_cat0129.jsonl`.
**Without it, half of `eval/expansion.yaml` cannot fire.** Only SemMedDB's
preferred names are aliases then, and those are clinical: "Hypertensive
disease", "Cerebrovascular accident", "Chronic Obstructive Airway Disease". A
question saying "high blood pressure", "stroke" or "COPD" links to nothing.

Dry-run on the full file: **1,894,930 of 130,480,195 predications** pass the
filters (CAUSES 844k, PREDISPOSES 448k, AFFECTS 370k, ASSOCIATED_WITH 224k).
INCREASES/DECREASES/STIMULATES barely occur between these types; they mostly
relate substances and physiological functions, which are filtered out.

The API re-checks the index at most once a minute, so building it needs no
restart. `/api/health` reports `expansion_enabled` and `expansion_index`.

## Turning it on

It is **on by default** (`EXPAND_ENABLED=1`) since 2026-09-29, on the evidence
below. Without `make semmed` it does nothing. Any request can opt in or out, so
an A/B needs no container recreate:

```bash
curl -s localhost:8080/api/unified-search -H 'content-type: application/json' \
  -d '{"q":"asthma rates by county","top_k":60,"expand":true}' | jq .expansion
```

`/api/analyze` takes the same `expand` field, and `/api/analyze/stream` takes
`?expand=true`. Its response carries `expansion` (seeds, every neighbor
considered, kept or skipped and why), and `provenance.retrieval.expansion`
records which candidates came from the literature.

## Measuring it

Three instruments, and they answer different questions:

| question | instrument |
|---|---|
| does expansion **reach** related data? | `eval/expansion.yaml`, `related` concept, A/B with `--expand` / `--no-expand`, `--score-depth` > `--top-k` |
| does it stay **quiet** on non-health questions? | same file, `expansion_must_not_fire`: `expansion_seeds` must be empty in the saved JSON |
| does the **planner** get worse with more candidates? | `plan_probe.py --expand` vs `--no-expand` on `plan_correctness.yaml`; op appropriateness must not move. Repeat 3x, it is temperature 0.1 |

`known_item.yaml` **cannot** see this change: expanded results are appended
after the decomposed ones, so no known item's rank can move. That is by design,
and it is also why a flat known-item result says nothing either way here.

## Measured (2026-09-28, qwen3:14b planner, GPU)

**Index.** 1,894,930 predications staged in 272s; 107,844 relations with >= 3
papers; 9,253 seed concepts; 82,688 aliases (9,188 SemMedDB names + 73,500 new
from the UMLS KB).

**The first cutoff was wrong, and the logs showed it.** `EXPAND_MIN_SIM=0.72`
rejected every concept on every query. BGE similarity between a SemMedDB
concept name and a catalog row runs lower than for a user's phrasing:

| kept at 0.61 (has catalog data) | | rejected (no catalog data) | |
|---|--:|---|--:|
| Chronic Obstructive Airway Disease | 0.681 | Kidney Failure, Chronic | 0.604 |
| Obesity | 0.658 | Hypertensive disease | 0.592 |
| Diabetes | 0.649 | Wheezing | 0.516 |
| Cigarette Smoking | 0.639 | Cerebrovascular accident | 0.503 |
| Air Pollutants | 0.625 | Diet | 0.490 |
| Smoking | 0.622 | Tolylene Diisocyanate | 0.432 |

The cutoff was set on the same 8 questions it is then scored on, so treat the
suite numbers below as optimistic.

**Reach** (`eval/expansion.yaml`, unified, top_k 60, score depth 200):
related-concept recall 93.8% -> 100% (7/8 -> 8/8). Only **stroke** and **CHD**
actually depended on expansion; the other six already reached a related measure
without it (ranks 3-24 of 60). The suite is lenient, and "is it anywhere in 60"
is not the question that matters. What reaches the planner is: with expansion
on, each health question put 1-5 literature-linked candidates in front of it
(diabetes and obesity for CHD; COPD, obesity and particulate matter for asthma;
cigarette smoking for lung cancer).

**Quiet.** 0 of 41 planner-probe questions (`plan_correctness.yaml` +
`stats_probe.yaml`) and 0 of 37 regression questions (`queries.yaml`) expand, so
their prompts are byte-identical and re-probing them measures only temperature.
`queries.yaml` concept recall 97.8% / success 97.3% in both arms.

**Planner** (`/api/analyze`, 8 health questions, one run each arm): all 8 used
the same primary attribute in both arms, and none planned over a
literature-linked candidate it was not asked about. 7/8 identical op sequences;
lung cancer added a `filter_attr` with expansion on, a single run at
temperature 0.1. Saved in `eval/exp-analyze-ab.json`.

**MRR is not readable from one run here.** On `queries.yaml` an identical
no-expand arm moved MRR 0.757 -> 0.740, and the expand arm (which appended
nothing) 0.757 -> 0.716. Decomposition runs at temperature 0.2.

**Known noise that remains:** "Chronic disease" is a vague concept that clears
the gate and adds the bare column "Conthow" (0.688), the `gen_desc` gap again.
Near-synonym neighbors (Smoking, Cigarette Smoking, Cigarette smoke) spend
separate slots on the same smoking columns.

**Turned on 2026-09-29** on that evidence. Eight questions, one run each, is
enough to say it reaches data and does not visibly hurt the planner; it is not
enough to say more. It cannot touch any question that links no condition, and
`{"expand": false}` or `EXPAND_ENABLED=0` reverts it.

## Held-out re-evaluation (2026-10-29)

The 2026-09-28 numbers came from the 8 questions `EXPAND_MIN_SIM` was tuned on.
`eval/expansion_heldout.yaml` is 12 health questions with different conditions
and lay phrasings ("sugar diabetes", "heart attacks"), plus 8 non-health
questions built around health-adjacent words. Results in `eval/exp-heldout/`.

**Reach holds up out of sample.** Related-measure recall 83.9% -> 100%, query
success 75% -> 100%, identical in all 3 runs per arm. Five questions only reach
a related measure with expansion: heart attacks, depression, binge drinking,
smoking, tooth loss. Every new hit sits at rank ~60, because expanded rows are
appended.

**MRR fell 0.596 -> 0.491, and that is the metric, not a regression.**
`run.py` averages 1/rank over HITS only, so a new hit at rank 61 lowers the
mean even though no existing rank moved (all subject ranks are identical).

**Quiet does not hold up: 2 of 8 non-health questions fired.** The earlier
"0 of 41" was on questions the seed rules were written against.
- "the economic **depression** in unemployment" -> Depressive disorder -> COVID-19,
  Obesity, Diabetes, Mental disorders.
- "cold winters and high **heating** costs" -> Heating (`eehu`, linked by its own
  name, so no similarity check runs) -> Thermal injury.

A question-level similarity check would separate the first one (question vs
concept 0.472, against 0.596+ for every real health question measured) and not
the second (0.677). Neither is fixed: a threshold set on 21 examples is the
mistake this file already records once.

**Noise among kept concepts:** COVID-19 (for kidney disease and depression),
"Respiratory Distress Syndrome, Adult" for drug overdose, "Chronic disease".
**Missed:** "Hypertensive disease" is rejected at 0.592 although high blood
pressure is loaded; the gate searches the clinical name, not its lay aliases.

**Planner** (`eval/expansion_planner_ab.py`, 10 questions x 2 arms x 2 reps):
expanded candidates DO reach the planner (1-4 per health question survive the
top_k 25 cut), and all 8 plain map questions planned identically with expansion
on and off. On "why" questions the `explain` table changes completely, from the
default covariates to literature factors: heart attacks -> smoking +0.49/+0.60
and diabetes; tooth loss -> smoking and diabetes. Some of what it surfaces is
weak: depression -> COPD +0.45 is a PLACES ~ PLACES pair (inflated, see
CORRELATE.md), binge drinking -> smoking -0.01.

## Research expansion: keywords read from text (2026-10-29)

`backend/research.js`, from `searchImprovement/newsearch`. Literature expansion
walks SemMedDB's relation graph; this READS papers (PubMed) or web pages
(SearXNG) about the question and has `LLM_MODEL` extract "geospatial or
environmental factor" keywords (the prototype's own instruction), then searches
the catalog for each through the same gate (`EXPAND_MIN_SIM`, new rows only).
Results join under purpose `expanded`, so placement and quota are unchanged.

Off by default; `{"research": ["pubmed"]}`, `["web"]` or both per request,
`RESEARCH_SOURCES` for a default. Both leave the machine: `pubmed` sends the
linked condition's NAME to NCBI (never the question), `web` sends the QUESTION
to public search engines.

| prototype | integrated | reason |
|---|---|---|
| PMIDs from a scan of the 3.3 GB gzip | E-utilities search: seed name AND risk-factor terms | `semmed_relation` stores counts, not PMIDs; the scan takes minutes |
| scispaCy linker | expansion.js seeds | already linked, measured, gated |
| MiniLM screening | BGE embedder already running | no new model |
| qwen3:1.7b | `LLM_MODEL` (gemma3:4b) | a third model on 16 GB is the VRAM stall |
| 10 pages x 5,000 chars | 5 texts x 1,500 chars | the prototype's prompt overflows a 4,096 window, and Ollama then discards the instructions |
| SearXNG on host :8080 | compose profile `research`, no host port | :8080 is GeoARK's web container |

**Measured** on `eval/research_heldout.yaml`: the held-out questions plus an
`environment` concept (air pollution, PM2.5, ozone, air toxics, drinking water,
superfund, food environment, lead paint, traffic), which is what the prototype
is for and what the relation graph does not reach. Literature expansion on in
every arm; `base` and `pubmed` 2 runs, `web` and `both` 3. `eval/research/`.

| arm | environment reached | related | non-health runs that added rows | p50 / p95 |
|---|--:|--:|--:|--:|
| base (literature only) | 4/24 (17%) | 100% | 0 of 16 | 0.9s / 1.2s |
| + pubmed | **14/24 (58%)** | 100% | 4 of 16 (the 2 homonyms) | 3.9s / 4.5s |
| + web | 16/36 (44%) | 100% | **21 of 24** | 6.6-9.3s / 9-22s |
| + both | 25/36 (69%) | 100% | 20 of 24 | 8.9-10.8s / 12-20s |

- **PubMed is the useful half.** Identical in both runs. Its keywords are what
  the instruction asks for: heart attacks -> air pollution, PM2.5, ozone;
  depression -> air pollution, PM2.5, SO2; smoking -> air pollution. It fires
  only where literature expansion linked a condition, so it inherits that
  gate's quiet, and its only non-health hits are the two homonyms above. Misses:
  "cancer" (in `ALIAS_STOP`) and "poor mental health days" link no seed, so
  PubMed is never asked. Some keywords are generic ("prevalence", "age",
  "mortality") and occasionally clear the gate.
- **Web reaches about as much and is mostly noise.** Its keywords are often
  method words ("county-level", "spatial analysis", "rural", "prevalence",
  "United States"), and with no condition gate it added rows to 21 of 24
  non-health runs: climate change and greenhouse gases for "population growth
  in Texas", air pollution for "commute burden". Many result pages refuse the
  fetch (HTTP 403 from publishers), and results drift between runs (web 1-3
  differ). It is also the source that sends the question off the machine.
- `both` has the best reach and carries web's noise with it.

**Planner** (`eval/expansion_planner_ab.py --arms expand,pubmed,web --only why-`,
6 "why" questions, one run each, `eval/research/planner.json`):

- **PubMed adds an environmental factor to the explain table, with an honest
  small effect**: heart attacks -> particulate air pollution +0.16 (after
  smoking +0.49 and diabetes +0.38); depression -> particulate +0.01. Tooth
  loss and binge drinking unchanged.
- **Web makes the table worse.** Heart attacks: Stroke ranked #1 at +0.80, a
  sibling outcome and a PLACES ~ PLACES pair. Binge drinking: high blood
  pressure -0.44, stroke -0.39, STIs. Tooth loss: COPD first. Its keywords name
  other conditions ("stroke", "heart disease", "chronic conditions"), and
  `explain` ranks whatever is loaded.
- **Research turned an honest refusal into a wrong answer.** No kidney measure
  is loaded. "what drives chronic kidney disease rates" is refused (422) with
  literature expansion alone; with pubmed or web it answers by explaining
  **Diabetes prevalence** as the outcome (+0.88 with diagnosed diabetes). The
  extra candidates gave the planner a plausible stand-in, and the relevance
  check passed it. Same family as "average rainfall" -> reading scores
  (CORRELATE.md). One run, but it is the failure that matters most.
  **Guarded 2026-10-30** (`backend/planner/outcome.js`): an `expanded`
  candidate may be a factor, never the explained outcome or a plan's only
  subject. Same question, PubMed on: rejected on attempt 1, then refused.
- "what factors explain arthritis prevalence" was refused in the expand and
  pubmed arms and planned 5 correlates in 180s with web; it was already erratic
  (128-256s, two shapes) in the expansion-only A/B above.

**Recommendation: both stay off by default.** PubMed is a reasonable opt-in for
"why" questions: deterministic, +3s, condition-gated, and it reaches the
environmental measures the relation graph cannot. Before it is a default, the
outcome substitution above needs a guard (the explained outcome must match the
question's condition, or the plan refuses). Web is not worth it: about the
reach of PubMed, mostly noise, fires on non-health questions, slower, and the
only source that sends the question itself off the machine.
