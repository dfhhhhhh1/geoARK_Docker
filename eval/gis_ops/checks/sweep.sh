#!/usr/bin/env bash
# Checks fix (2026-11-22): method words and thresholds in the named-data
# check, share versus threshold on categorical rasters, self-ratio removal.
#   bash eval/gis_ops/checks/sweep.sh <label>
# Run from anywhere. Writes eval/gis_ops/checks/<label>-*.{json,log}.
# Retrieval is untouched, so queries.yaml / known_item.yaml are not run (and
# back to back they trip the search rate limit, CLAUDE.md traps).
set -u
L=${1:-fix}
cd "$(dirname "$0")/../../.."
D=eval/gis_ops/checks
ap() { python eval/answer_probe.py --suite-file eval/gis_ops.yaml --endpoint research "$@"; }

# The three new families: dev x3, held out once.
for fam in method_words thresholds share_threshold; do
  for r in a b c; do ap --tier ${fam}_dev --save $D/$L-${fam}_dev-$r.json > $D/$L-${fam}_dev-$r.log 2>&1; done
done
for fam in method_words thresholds share_threshold; do
  ap --tier ${fam}_heldout --save $D/$L-${fam}_heldout.json > $D/$L-${fam}_heldout.log 2>&1
done

# Every other gis_ops dev family once: the named-data check reads every plan.
for fam in proximity overlay aggregation density raster network enrichment value_filters nearest composite zonal_features moran; do
  ap --tier ${fam}_dev --save $D/$L-${fam}_dev.json > $D/$L-${fam}_dev.log 2>&1
done

# Guards (CLAUDE.md: every suite after touching a check).
python eval/answer_probe.py --suite-file eval/research.yaml --save $D/$L-research.json > $D/$L-research.log 2>&1
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --save $D/$L-advanced.json > $D/$L-advanced.log 2>&1
python eval/answerability_probe.py --save $D/$L-answerability.json > $D/$L-answerability.log 2>&1
python eval/plan_probe.py --save $D/$L-plan.json > $D/$L-plan.log 2>&1
python eval/gis_ops/run_heldout.py $D/$L-heldout16.json > $D/$L-heldout16.log 2>&1
echo "sweep $L done"
