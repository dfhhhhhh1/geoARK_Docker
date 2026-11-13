#!/bin/sh
# Named-data check on workflow-result steps (d-asthma-then-rainfall), 2026-11-12.
set -x
D=eval/gis_ops/h2/fix-inline
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --save $D/advanced-r1.json > $D/advanced-r1.log 2>&1
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --tier refuse --save $D/advanced-refuse-r2.json > $D/advanced-refuse-r2.log 2>&1
python eval/answer_probe.py --suite-file eval/research_advanced.yaml --endpoint research --tier refuse --save $D/advanced-refuse-r3.json > $D/advanced-refuse-r3.log 2>&1
python eval/answer_probe.py --suite-file eval/research.yaml --endpoint research --save $D/research.json > $D/research.log 2>&1
python eval/answerability_probe.py --save $D/answerability.json > $D/answerability.log 2>&1
echo DONE
