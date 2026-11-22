# Zonal over features evidence (GIS_OPS_PLAN.md "H6 tier 1, item 5")

- `live_check.js`, `live_check.txt`: the op's compiled SQL (hand-written
  plans, validated and compiled by the planner's own code) run on the live DB
  and compared with `eval_raster_gold`, which `raster_gold.py` computes from
  the source GeoTIFFs with GDAL. Six cases, 0 missing, 0 extra.
- `r1.json` ... `r4c.json`: `zonal_features_dev` through `/api/research`,
  qwen3:14b `off/2048`, one build per round (table in the plan). r3b
  overlapped a manual API call and is contaminated.
- The held-out pair and a fifth dev run are in `../tier1/t1-zonal_features_*`.
