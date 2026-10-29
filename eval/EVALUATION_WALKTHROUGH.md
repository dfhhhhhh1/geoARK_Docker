# How GeoARK is evaluated, by example

GeoARK answers a question in two stages, and each stage is measured
separately:

```
question ──► retrieval (decompose → BM25 + vectors → RRF) ──► candidate attributes
                                                                    │
                     planner (qwen3:14b) ──► plan (ops) ──► SQL ──► map / table
                                     ▲
                                     └── relevance check (refuse if unanswerable)
```

Each suite below is listed with **what it can see**, **an example query from
the suite file**, **how that query is scored**, and **the latest recorded
number**. The suites are not interchangeable: several of them cannot detect the
failures the others are built to catch.

| Suite | Stage | Sensitive to | Blind to |
|---|---|---|---|
| `queries.yaml` | retrieval | a concept vanishing from results | ranking changes |
| `known_item.yaml` | retrieval | rank of one specific attribute | multi-concept coverage |
| `run.py --endpoint analyze` | planning | malformed / failing plans | whether the plan is *right* |
| `plan_correctness.yaml` | planning | wrong op choice, template copying | wrong attribute choice |
| `denominator.yaml` | planning | wrong attribute (e.g. no population) | — |
| `answerability.yaml` | relevance | answering the unanswerable, over-refusing | — |
| `expansion.yaml` | retrieval | literature-linked measures | (needs `--score-depth`) |
| `followup.yaml` | follow-ups | misread edits / rewrites | — |

---

## 1. Concept coverage: `queries.yaml`

**Question it asks:** did the top-20 results cover every *part* of the query?

There is rarely one correct attribute (the catalog has 221 poverty rows), so
each query declares **concepts**, and a concept passes if *any* returned row
matches its regex predicate.

```yaml
- id: poverty-rate
  query: "poverty rate"
  concepts:
    poverty: {desc: "povert"}
```

A multi-concept query such as "poverty per capita by county" needs both a
poverty row **and** a population row; the second is the normalization variable
a naive single-vector search drops.

**Scoring**
- *concept recall* = concepts satisfied / concepts declared
- *query success* = queries where every concept was satisfied

```bash
python eval/run.py --endpoint unified --save eval/results/latest.json
```

**Latest:** 97.8% concept recall, 97.3% query success (37 queries).

**Limit:** satisfied by hundreds of rows, so it **cannot see re-ranking**.
Regression guard only. It once "showed" that tags don't matter; they cost
41.7pp when measured with the next suite.

---

## 2. Known-item rank: `known_item.yaml`

**Question it asks:** where does *this exact* attribute land?

```yaml
- id: ki-petrochemical
  query: "petrochemical production facility name"
  expect_attr_id: cc51c539_01_01_03      # Oil Refineries / Name
  note: "'petrochemical' appears only in tags"
```

The target row's description is just `"Name"`; the word "petrochemical" exists
only in its tags. If tags stop contributing, this row falls out of rank 1.

**Scoring:** rank of `expect_attr_id` → **recall@1** and **MRR** (1/rank,
averaged). An `absent` suite also asks for data that does not exist and checks
whether the top score is visibly lower.

```bash
python eval/run.py --suite-file eval/known_item.yaml --save eval/ki.json
```

**Latest:** 91.7% recall@1, MRR 0.944. Tags off: 50.0%.

---

## 3. Plan validity: `run.py --endpoint analyze`

**Question it asks:** did the planner emit a plan that validates, compiles and
executes?

**Scoring:** `planned = "plan" in payload and not payload.get("error")`, plus
execution success.

**Limit — read this before quoting it:** well-formedness only. A plan answering
"top 10 counties by median income" with *percentage in poverty* scored a
full success. Never judge planner quality with it.

---

## 4. Op appropriateness: `plan_correctness.yaml` + `plan_probe.py`

**Question it asks:** did the plan use the operation the question demands?

```yaml
- id: rank-top-income
  query: "list the top 10 counties with the highest median household income"
  expect_op: rank

- id: count-hospitals
  query: "how many hospitals are in each county"
  expect_op: count_features

- id: place-zip
  query: "median household income for counties in ZIP code 63101"
  expect_op: filter_place

- id: distance-to-nearest
  query: "how far is each county from the nearest hospital"
  expect_op: nearest_distance
```

**Scoring**
- *op appropriateness*: share of plans containing `expect_op`
- *forbidden-op rate*: share containing a `forbid_op` (an op that is clearly wrong)
- *op diversity*: distinct op sequences / queries. Caught a planner copying one
  worked example (0.12). Decays as the suite grows, so compare only on a fixed suite.
- The chosen attributes are printed (`attrs`) for a human to eyeball.

```bash
python eval/plan_probe.py --save eval/plan-latest.json --compare eval/plan-P-crosscheck.json
```

**Latest:** 100% op appropriateness, 100% validity, op diversity 0.62
(qwen3:14b, one run, 26 queries).

**Repeat small suites.** A 5-query stats suite read 1/5 once and 4/5 on three
re-runs: temperature variance, not regression.

---

## 5. Attribute appropriateness: `denominator.yaml`

**Question it asks:** did the plan load the *right data*, not just the right op?

Example: "population density per square mile in the Midwest". A plan that
divides *domestic migration* by land area contains `per_area` and passes suite
4. Here `expect_attr` is a regex on the loaded attribute, so it fails unless a
total-population series is used.

```bash
python eval/plan_probe.py --suite-file eval/denominator.yaml --save eval/den/run-1.json
```

**Latest:** 100% attr and op appropriateness ×3 (was 33% / 50% before the
population-denominator fix).

---

## 6. Honest refusal: `answerability.yaml`

**Question it asks:** does the system refuse what the data cannot answer, *and
only that*?

```yaml
- {id: r-rainfall, expect: refuse, query: "What is the average rainfall by county?"}
- {id: r-dogs,     expect: refuse, query: "How many pet dogs live in each county?"}
- {id: r-bitcoin,  expect: refuse, query: "bitcoin mining hash rate difficulty adjustment"}
```

The `answer` half leans on proxy questions ("wealthiest" → income), which an
over-eager check would wrongly reject.

**Scoring:** *catch rate* (refuse questions not answered) and *false
refusals* (answer questions refused). Both are needed: refusing everything
scores a perfect catch rate.

```bash
python eval/answerability_probe.py --relevance-check on --save eval/ans-on.json
```

**Latest:** qwen3:14b 10/10 refused, 0/20 false refusals.

---

## Rules for reading any of these numbers

1. **Show the metric can move before trusting that it didn't.** A flat result
   from a blind instrument is not evidence of no effect.
2. **Recreate the API container** (`--force-recreate`) between ablation arms,
   and check `corpus_stale` on `/api/health`.
3. **Check the GPU and VRAM** before timing anything (`ollama ps`, `nvidia-smi`).
4. **Bundle the environment** with `python eval/collect.py --label <name>` so
   runs are comparable across machines.

See [README.md](README.md) for the full suite reference and the history of
corrections.
