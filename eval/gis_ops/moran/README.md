# `moran`: global Moran's I and LISA, checked against PySAL

GIS_OPS_PLAN.md H6 tier 1, item 6. Code: `backend/planner/moran.js` (statistics,
phrasing, plan repairs), `backend/planner/ops/moran.js` (the op). Unit tests:
`backend/planner/test_moran.js` (18, includes a 5x5 lattice pinned from esda).

## Reproduce

Data is dumped from the live database, outside the repo:

```bash
docker exec geoark-db-1 psql -U geoark -d mygisdb -c "\copy (select fips, neighbor_fips from county_neighbors order by 1,2) to stdout csv header" > <dir>/neighbors.csv
# one per measure: PCTPOVALL, PLACES_OBESITY_CrdPrv, UNEMPLOYMENT_RATE (latest year, non-null)
docker exec geoark-db-1 psql -U geoark -d mygisdb -c "\copy (select fips, value from acs_county_values where census_code='PCTPOVALL' and year=(select max(year) from acs_county_values where census_code='PCTPOVALL') and value is not null order by 1) to stdout csv header" > <dir>/PCTPOVALL.csv
```

Then, in a scratch venv with `esda libpysal numpy`:

```bash
python -I pysal_gold.py <dir> <dir>/pysal.json 9999
node compare_pysal.js <dir> <dir>/pysal.json pysal_compare.json
```

## Result (esda 2.10.0, 9,999 permutations each side, 2026-11-21)

| case | n | islands | I (ours = esda) | z_rand | max \|ΔIs\| | LISA classes agree | p beyond 4 sd |
|---|--:|--:|--:|--:|--:|--:|--:|
| poverty, national | 3,132 | 8 | 0.583243 | 54.139 | 8e-14 | 99.07% | 0 |
| obesity, national | 2,945 | 7 | 0.579049 | 51.600 | 2e-13 | 99.56% | 0 |
| unemployment, national | 3,218 | 10 | 0.660206 | 62.064 | 1e-13 | 99.59% | 0 (+5 ties) |
| poverty, Texas only | 254 | 0 | 0.502312 | 13.457 | 7e-15 | 100% | 0 |
| obesity, Missouri only | 115 | 0 | 0.207754 | 3.687 | 3e-14 | 100% | 0 |

- **Deterministic quantities are equal**: global I, E[I], Var under randomization,
  z, p_rand, and every local Is and quadrant, to floating-point rounding.
- **Pseudo p-values agree within Monte Carlo error.** They come from different
  random draws, so they cannot match digit for digit. Every class disagreement
  (27, 13, 13, 0, 0) is a county whose p sits within 4 sd of 0.05.
- **Ties, the one real difference.** With one neighbour and values rounded to
  0.1 (unemployment), 3% of draws tie the observed statistic exactly. Ours counts
  a tie as "at least as extreme", which is the definition of M in (M + 1) / (R + 1).
  esda's floating-point order drops those ties, so our p is higher by about
  P(tie) on 5 counties (0.027 to 0.040). This is the conservative direction, and
  it is reported apart, not folded into the tolerance. The first version counted
  ties in both tails, and 8 counties fell outside; esda's directed form (high
  tail >=, low tail strict) fixed 3 of them.
- **Time** in Node at 9,999 permutations: global 0.5 s, LISA 1.2 s nationally.
  At the default 999, about a tenth of that; end to end through the executor on
  the live database, 40 to 600 ms per question.

## Eval family (written before any planner run)

`eval/gis_ops.yaml` tiers `moran_dev` (4) and `moran_heldout` (2). Global
questions use `kind: scalar` against a closed-form SQL gold, which equals esda.
LISA questions use a new `kind: lisa` comparison in `answer_probe.py`, because
SQL cannot hold a permutation test: gold is the analytic conditional-randomization
p (Sokal 1998, esda's EIc/VIc), which agrees with permutation classes on
93.5-100% of counties. So `lisa` requires every unit the answer calls significant
to sit in the right quadrant (>= 99%, deterministic), class agreement >= 90%,
coverage of the area, and nothing significant outside it.

`--check-gold` 0 problems; `--self-test` 22/22 on the family, including binary
weights instead of row-standardized (WRONG_VALUE), a national statistic for a
state question, the national LISA shown for Georgia, and the raw measure mapped.

One suite fix made before any run: CDC PLACES has no Kentucky rows, so the
Kentucky question accepts only ACS / CHR / SVI uninsured measures
(`uninsured_adults_ky`); a plan that loads PLACES there is an empty answer.

**Not yet run through the planner**: that needs the API rebuilt from this
working tree, which other sessions share.
