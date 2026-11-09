#!/usr/bin/env bash
# Research-expansion A/B on eval/research_heldout.yaml (2026-10-29).
cd "$(dirname "$0")/../.."
run() {  # arm research-sources rep
  python eval/run.py --suite-file eval/research_heldout.yaml --endpoint unified \
    --top-k 60 --score-depth 200 --expand --research "$2" --timeout 300 \
    --save "eval/research/$1-$3.json" 2>&1 | grep -E "concept recall|query success|p50" | sed "s/^/[$1 $3] /"
}
for i in 1 2 3; do
  [ $i -le 2 ] && run base "" $i
  [ $i -le 2 ] && run pubmed pubmed $i
  run web web $i
  run both pubmed,web $i
done
