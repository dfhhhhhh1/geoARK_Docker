#!/usr/bin/env bash
# H6 tier 1 evaluation (docs/GIS_OPS_PLAN.md "H6 tier 1, evaluated"): every
# tier 1 family, dev and held out, plus the guards, all on ONE API build, so
# the items are measured together rather than each on its own build.
#   bash eval/gis_ops/tier1/sweep.sh <label>
# Run from the repo root. Writes eval/gis_ops/tier1/<label>-*.{json,log}.
set -u
L=${1:-t1}
D=eval/gis_ops/tier1
cd "$(dirname "$0")/../../.."
ap() { python eval/answer_probe.py --suite-file eval/gis_ops.yaml --endpoint research "$@"; }

# Tier 1 families (items 1-6). enrichment and moran had never been run
# through the planner, so their dev tiers get three runs; the others one.
for fam in enrichment moran; do
  for r in a b c; do ap --tier ${fam}_dev --save $D/$L-${fam}_dev-$r.json > $D/$L-${fam}_dev-$r.log 2>&1; done
done
for fam in value_filters nearest composite zonal_features; do
  ap --tier ${fam}_dev --save $D/$L-${fam}_dev.json > $D/$L-${fam}_dev.log 2>&1
done
for fam in enrichment value_filters nearest composite zonal_features moran; do
  ap --tier ${fam}_heldout --save $D/$L-${fam}_heldout.json > $D/$L-${fam}_heldout.log 2>&1
done

# Earlier GIS families (H1-H5), dev only: did tier 1 break them?
for fam in proximity overlay aggregation density raster network; do
  ap --tier ${fam}_dev --save $D/$L-${fam}_dev.json > $D/$L-${fam}_dev.log 2>&1
done

# Guards (CLAUDE.md list).
python eval/answer_probe.py --suite-file eval/research.yaml --save $D/$L-research.json > $D/$L-research.log 2>&1
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --save $D/$L-advanced.json > $D/$L-advanced.log 2>&1
python eval/answerability_probe.py --save $D/$L-answerability.json > $D/$L-answerability.log 2>&1
python eval/plan_probe.py --save $D/$L-plan.json > $D/$L-plan.log 2>&1
python eval/run.py --suite-file eval/queries.yaml --save $D/$L-queries.json > $D/$L-queries.log 2>&1
python eval/run.py --suite-file eval/known_item.yaml --save $D/$L-ki.json > $D/$L-ki.log 2>&1
python eval/gis_ops/run_heldout.py $D/$L-heldout16.json > $D/$L-heldout16.log 2>&1
echo "sweep $L done"
