# People-at-a-distance fixes (GIS_OPS_PLAN.md "People questions", 2026-11-22)

All runs were against a throwaway API container built from the working tree on
:4100 (shared DB, embedder and ollama, the shared API untouched), qwen3:14b,
`off/2048`, `--endpoint research`.

- `target-*`: the four people-count questions, 3 runs each.
- `g-*`: guards on the same build: the tier 1 / H1-H5 dev families that use
  feature filters, research_advanced, research, answerability, plan_correctness,
  and the held-out 16 (`run_heldout.py` pointed at :4100).
- `rerun-*`: the questions that dipped in `g-*`, re-run.
