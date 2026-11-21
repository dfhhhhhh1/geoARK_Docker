# Composite index evidence (GIS_OPS_PLAN.md "H6 tier 1, item 4")

- `dev-r1.json` ... `dev-r5c.json`: `composite_dev` through `/api/research`,
  qwen3:14b `off/2048`, one build per round (table in the plan).
- `heldout.json`: `composite_heldout`, scored once on the r5 build.
- `guard-research.*`, `guard-answerability.*`: guards on the r5 build.

The op's own SQL was checked against the suite's gold outside the planner:
each dev plan (and the geometric held-out shape) was compiled with the fields
`applyComposite` sets, both were run on the live DB, and every county was
compared. 743 counties, max |diff| 2.2e-16. The gold counts strictly smaller
values over n - 1 instead of calling PERCENT_RANK, so it cannot share the
op's definition by accident.
