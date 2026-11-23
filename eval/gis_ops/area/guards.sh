#!/usr/bin/env bash
# Guards after the area rule + once-per-feature total (CLAUDE.md list), one API build.
set -u
cd "$(dirname "$0")/../../.."
L=${1:-g1}; D=eval/gis_ops/area
ap() { python eval/answer_probe.py --suite-file eval/gis_ops.yaml --endpoint research "$@"; }
for fam in composite moran enrichment zonal_features nearest; do
  ap --tier ${fam}_dev --save $D/$L-${fam}_dev.json > $D/$L-${fam}_dev.log 2>&1
  ap --tier ${fam}_heldout --save $D/$L-${fam}_heldout.json > $D/$L-${fam}_heldout.log 2>&1
done
for fam in proximity overlay aggregation density raster network; do
  ap --tier ${fam}_dev --save $D/$L-${fam}_dev.json > $D/$L-${fam}_dev.log 2>&1
done
python eval/answer_probe.py --suite-file eval/research.yaml --save $D/$L-research.json > $D/$L-research.log 2>&1
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --save $D/$L-advanced.json > $D/$L-advanced.log 2>&1
python eval/answerability_probe.py --save $D/$L-answerability.json > $D/$L-answerability.log 2>&1
python eval/plan_probe.py --save $D/$L-plan.json > $D/$L-plan.log 2>&1
python eval/gis_ops/run_heldout.py $D/$L-heldout16.json > $D/$L-heldout16.log 2>&1
# search suites last, a minute apart (rate limit: CLAUDE.md trap)
sleep 70
for s in single_concept facilities_via_tags multi_concept geographic_level paraphrase temporal; do
  python eval/run.py --suite-file eval/queries.yaml --suite $s --save $D/$L-queries-$s.json > $D/$L-queries-$s.log 2>&1; sleep 70
done
python eval/run.py --suite-file eval/known_item.yaml --save $D/$L-ki.json > $D/$L-ki.log 2>&1
echo "guards $L done"
