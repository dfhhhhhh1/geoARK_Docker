#!/bin/sh
# H3 final runs, one build (overlay_dev r3-r5 ran on it first). Usage:
#   sh eval/gis_ops/h3/guards.sh <tag>
set -u
T=${1:-final}
D=eval/gis_ops/h3
cd "$(dirname "$0")/../../.."
for t in overlay_heldout proximity_dev proximity_heldout aggregation_dev density_dev aggregation_heldout density_heldout; do
  python eval/answer_probe.py --suite-file eval/gis_ops.yaml --tier $t --endpoint research --save $D/$T-$t.json > $D/$T-$t.log 2>&1
done
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --save $D/$T-advanced.json > $D/$T-advanced.log 2>&1
python eval/answer_probe.py --save $D/$T-research.json > $D/$T-research.log 2>&1
python eval/answerability_probe.py --save $D/$T-ansab.json > $D/$T-ansab.log 2>&1
python eval/plan_probe.py --save $D/$T-plan.json > $D/$T-plan.log 2>&1
python eval/run.py --endpoint unified --save $D/$T-queries.json > $D/$T-queries.log 2>&1
python eval/run.py --suite-file eval/known_item.yaml --save $D/$T-ki.json > $D/$T-ki.log 2>&1
python eval/gis_ops/run_heldout.py $D/$T-heldout16.json > $D/$T-heldout16.log 2>&1
echo ALL DONE
