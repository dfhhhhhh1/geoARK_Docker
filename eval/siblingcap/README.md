# Layer-column sibling cap (2026-11-13)

`SIBLING_CAP` (default 3) in `backend/unified_search_server.js`,
`capLayerSiblings`. Per sub-query, rows that are NOT a value series
(`acs_long` / `table_column`), meaning feature-table columns, rasters and rows
with no data, keep at most N rows per dataset. Value series are never capped.
`sibling_cap` per request (unified-search, analyze, research; `?sibling_cap=`
on /api/search) for the A/B.

## Why

A map layer is one candidate to the planner (runAnalysisInner collapses it),
but it is one catalog row per COLUMN in retrieval. HSIP layers carry 30-70
column rows; `make ingest` writes 2-14; a raster writes 1. The planner's
retrieval budget (60) is split across sub-queries, so a 5-concept question
gives each one 12 slots. For "public schools", the never-loaded HSIP "Public
Schools" table (31 rows, no data) took ranks 1-17, and the loaded "Public
School Locations" came 18th. The named-data check then refused "Identify all
public schools within a 2-mile buffer of Superfund sites in Missouri" with
`the loaded data does not include "public schools"`.

## Measured (same build, api recreated 2026-11-13 18:24 UTC)

| suite | cap 0 | cap 3 |
|---|--:|--:|
| known_item.yaml (search) R@1 / MRR | 91.7% / 0.944 | 91.7% / 0.944, every rank identical |
| queries.yaml (unified) recall / success / MRR | 97.8 / 97.3 / 0.740 (recorded) | **100 / 100 / 0.773** |
| layer_reach.py, 74 loaded layers by own name, @1 / @5 / MRR | 70 / 73 / 0.968 | 70 / 74 / 0.970 |
| concept_reach.py, 28 concept questions x2, reached | 54/56 | **56/56** |
| plan_correctness op appr / validity | (92.3 / 96.2 recorded) | 92.3 / 96.2 |
| research.yaml answer correctness, 2 runs | 66.7, 66.7 | 61.1, 52.9 (n=17) |

- Name queries were already fine: only Private School Locations moved (8 -> 4).
  The losses need a competing twin, which is how people phrase questions.
- concept_reach: schools-buffer unreachable -> rank 4, schools-count 18 -> 4,
  private-schools 19 -> 4. No other question moved.
- End to end at cap 3 (`analyze_reach.py`, `analyze_cap3.json`): 27/28 offered
  the layer, 23 used it, 24 answered. All four failures had the layer in hand
  and wired it wrong (`load` on a point layer, NLCD with no class for
  "cropland", filter_place with no input). Brownfields and fire stations
  fail about 1 in 3 with the cap OFF as well (`analyze_fail_cap0.json`).
- research.yaml per question: every miss common to both arms except
  hospitals-per-capita-tx (planner picks "CMS long-term care hospitals";
  also in cap-0 run 2), access-gap (1/2 cap 0, 0/2 cap 3; a known
  reasoning-off flake), and cap-3 run 2, which hit an HTTP 504 and a NO_ANSWER
  on r-hospital-distance-mo, the stall signature. Not attributable to the cap
  on this evidence; two runs cannot exclude a small cost.
- **This build's research.yaml baseline is 66.7%, not the 83-89% recorded on
  2026-11-11**, in both arms. Shared misses: rainfall and schools answered
  instead of refused, poverty and uninsured on the wrong measure,
  obesity-top50. That drift predates this change.

## Files

`layer_reach.py`, `concept_reach.py` + `layer_concepts.yaml`,
`analyze_reach.py`; results `*.json`, `guards.log`.
