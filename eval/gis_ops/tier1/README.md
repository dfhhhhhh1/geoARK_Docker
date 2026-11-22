# Tier 1 evaluation (GIS_OPS_PLAN.md "H6 tier 1, evaluated")

- `sweep.sh`: every tier 1 family (dev and held out), the H1-H5 dev
  families and the guards, on one API build. `bash eval/gis_ops/tier1/sweep.sh <label>`.
- `t1-*`: the sweep on the item 5 build. `t1-*-r2`: repeats of the families
  and questions that dipped. `head-*`: the same questions on an API built from
  HEAD without the item 5 diff, which is how overlay / network / three
  research_advanced misses were attributed to commits before it.
- `t1-ki.*` and `t1-queries-<suite>.*` were re-run apart after the first
  attempt was rate-limited (HTTP 429); `t1-queries.*` still holds 6 429s and
  is not a measurement.
