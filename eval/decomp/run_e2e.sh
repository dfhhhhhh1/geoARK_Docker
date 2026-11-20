#!/bin/sh
# Decomposition A/B, end to end (2026-11-19). Experiment API on :4100.
cd "$(dirname "$0")/.."
B=http://localhost:4100
BASE='{"decomp":{"prompt":"v1","model":"gemma3:4b"}}'
V3Q='{"decomp":{"prompt":"v3","model":"qwen3:14b"}}'
WIDE='{"decomp":{"prompt":"v3","model":"qwen3:14b"},"top_k":35,"candidates":{"feature_cap":10,"primary":14,"normalization":8,"related":6}}'
python decomp/reach.py --base $B --repeats 2 --save decomp/reach_caps.json --arm v3-qwen-wide "$WIDE" > decomp/reach_caps.log 2>&1
for arm in base:$BASE v3q:$V3Q wide:$WIDE; do
  name=${arm%%:*}; js=${arm#*:}
  python answer_probe.py --base $B --extra "$js" --save decomp/ans_research_$name.json > decomp/ans_research_$name.log 2>&1
  python answer_probe.py --base $B --suite-file research_advanced.yaml --endpoint research --extra "$js" --save decomp/ans_adv_$name.json > decomp/ans_adv_$name.log 2>&1
  python plan_probe.py --base $B --extra "$js" --save decomp/plan_$name.json > decomp/plan_$name.log 2>&1
done
echo done
