#!/usr/bin/env bash
# Area rule + once-per-feature totals (docs/GIS_OPS_PLAN.md "One area rule"):
# the tiers each fix touches, then the guards. bash eval/gis_ops/area/run.sh <label>
set -u
cd "$(dirname "$0")/../../.."
L=${1:-a1}; D=eval/gis_ops/area
ap() { python eval/answer_probe.py --suite-file eval/gis_ops.yaml --endpoint research "$@"; }
for t in value_filters_heldout composite_heldout value_filters_dev composite_dev thresholds_dev thresholds_heldout moran_dev moran_heldout; do
  ap --tier $t --save $D/$L-$t.json > $D/$L-$t.log 2>&1
done
echo "targeted $L done"
