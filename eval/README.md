# `eval/` — retrieval evaluation

Before this existed there was no way to tell whether a prompt tweak, a model
swap, or a ranking change made GeoARK better or worse. Now there is a number.

```bash
python3 eval/run.py                                    # against a running stack
python3 eval/run.py --compare eval/baseline-search.json
```

Needs `pyyaml` and a stack reachable at `http://localhost:8080` (`--base` to
point elsewhere, e.g. a tunnelled server).

## Why assertions instead of labelled answers

The obvious design is 50 queries each paired with the "correct" `attr_id`. It
does not work here. For *"poverty per capita by county"* the catalog holds 221
poverty attributes and dozens of population ones; several combinations would
satisfy a real user. Picking one as ground truth encodes an arbitrary choice,
and the metric mostly measures that choice.

So each query declares the **concepts** its results must cover, and a concept is
satisfied when at least one returned row matches its predicate:

```yaml
- id: poverty-per-capita
  query: "poverty rates normalized by population for counties"
  concepts:
    poverty:    {desc: "povert"}
    population: {desc: "populat"}
```

That measures what the pipeline actually claims to do — decompose a query and
surface *every* part of it, including the normalization variable a single-vector
search reliably drops.

Every predicate is checked against `backend/geoark_attributes.csv` before any
query runs. An unsatisfiable assertion is worse than no assertion: it looks like
a permanent retrieval failure and quietly drags the headline number down.
`--validate-only` runs just that check.

## The suites

| Suite | Queries | What it isolates |
|---|--:|---|
| `single_concept` | 10 | Basic semantic search. If this drops, something is badly broken |
| `facilities_via_tags` | 6 | Facility datasets whose `attr_desc` is just `"Name"` / `"Address"` — all meaning lives in `tags` and `dataset_clean`. Fails if embedding text drops either field |
| `multi_concept` | 8 | **The point of the system.** Queries needing two or more distinct variables |
| `geographic_level` | 3 | Does the extracted `geographic_level` actually affect results |
| `paraphrase` | 5 | Everyday wording that appears nowhere in the catalog |

## Metrics

| Metric | Meaning |
|---|---|
| **concept recall** | Concepts found ÷ concepts required, over all queries. The headline |
| **query success** | Queries where *every* concept was found. Deliberately harsh: a multi-concept query that drops the normalizer is not a success, even if the primary concept ranked first |
| **MRR** | Mean of 1/rank of each concept's first match. Moves when good results rank *higher*, which recall alone cannot see |
| **latency** | p50 / p95 wall clock |

## Results so far

`--endpoint search` (raw hybrid retrieval, no LLM), 32 queries:

| | baseline | +BM25/RRF/MOE | Δ |
|---|--:|--:|--:|
| concept recall | 87.5% | **95.0%** | +7.5pp |
| query success | 84.4% | **93.8%** | +9.4pp |
| MRR | 0.773 | **0.822** | +0.049 |
| latency p50 | 0.04s | **0.01s** | 4× faster |

By suite, the change is concentrated exactly where the weakness was:
`multi_concept` 62.5% → 87.5%, `paraphrase` 60% → 80%. Three queries flipped to
passing; none regressed.

Ablation, holding everything else fixed:

| Config | concept recall | query success |
|---|--:|--:|
| RRF + BM25 + MOE demotion | 95.0% | 93.8% |
| RRF + BM25, no MOE demotion | 92.5% | 90.6% |

So RRF+BM25 carries ~5pp and MOE demotion ~2.5pp.

### What the baseline run diagnosed

Running the suite against the original code immediately explained *why*
retrieval was weak, which reading the code had not:

- The lexical score was near-constant noise. `keywordMatchScore` matched
  `tWord.includes(qWord) || qWord.includes(tWord)` against unfiltered row
  tokens, so both paraphrase failures scored **0.833** against completely
  unrelated rows. With a 0.3 weight it was actively reshuffling a decent
  semantic ranking. BM25 with stopword filtering and IDF replaced it.
- Margin-of-error rows flooded the top 20. ~900 catalog rows are ACS MOE
  companions, near-duplicates of the estimates they accompany. They are now
  demoted (`MOE_PENALTY`, default 0.5) rather than filtered, so they stay
  reachable.

## Tuning

All knobs are environment variables on the `api` service, so an ablation is an
`.env` edit plus `docker compose up -d api`:

| Var | Default | Effect |
|---|--:|---|
| `RRF_K` | 60 | Rank-fusion constant. Higher flattens the contribution of top ranks |
| `BM25_K1` | 1.2 | Term-frequency saturation |
| `BM25_B` | 0.75 | Length normalization |
| `MOE_PENALTY` | 0.5 | Score multiplier for margin-of-error rows; 1 disables |

## Adding queries

Add to `queries.yaml`, then **always** run `--validate-only` first. Predicate
fields: `desc`, `tags`, `dataset` (regex, case-insensitive), `entity` (exact),
and `any_of` (list of predicates, OR).

Grow `multi_concept` and `paraphrase` first — they are where the headroom is,
and they are the suites that discriminate between approaches. `single_concept`
and `facilities_via_tags` are already saturated at 100% and mostly serve as
regression guards now.

## Known gaps

- **32 queries is small.** A 1-query flip moves concept recall ~2.5pp, so treat
  differences under ~3pp as noise. Getting to ~100 queries would tighten that.
- **Written by inspecting the catalog, not by observing users.** They are
  realistic, not real. Replace them with logged queries once there are any.
- **`--endpoint unified` is slow** (~11s/query on a local 4B model) and needs
  headroom; see the memory note in [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).
- **No plan-validity or execution metrics yet.** Those arrive with the Phase 3
  planner; `run.py` is structured to take them.
