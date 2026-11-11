# Research workflows

Phase D of [RESEARCH_PLAN.md](RESEARCH_PLAN.md): questions that need the
RESULT of one analysis as the input to another.

> Take the 50 counties with the highest adult obesity rates. How does their
> median household income compare with the rest of the country?

| Piece | Where |
|---|---|
| Decompose, run, ground, stop, report | `backend/workflow.js` |
| Endpoint | `POST /api/research` (`unified_search_server.js`, `runResearch`) |
| Earlier results in a plan | `runAnalysis({ extraSources })`, `buildRefs` "EARLIER RESULTS", `EARLIER_NOTE` |
| Complement group | `intersect` with `exclude: true` |
| Tests | `backend/test_workflow.js` (11) |
| Measurement | `eval/answer_probe.py --endpoint research` |

## Shape

A workflow is a short list of ordinary questions, at most `WORKFLOW_MAX_STEPS`
(4). Each one is answered by the ordinary pipeline: retrieve, plan, validate,
execute. A later question can use the counties an earlier one produced. The
alternative was a larger single plan, and the wrong one: op-set size is what has
cost this planner accuracy every time it was measured.

0. **Gate.** Decomposition runs only when a part of the question refers back
   to another ("their", "those", "among them") or it is several sentences.
   Without the gate, 4 of 15 one-plan questions were split, and 2 of those
   splits cost the answer. With it, 0 of 17 were. A missed workflow runs as one
   plan, which is the behaviour before Phase D.
1. **Decompose.** One constrained call to `PLAN_MODEL` returns `{steps: [{id,
   question, uses}]}`. Most questions should come back as ONE step. A split is
   for a later part that needs an earlier part's counties, not for several
   conditions on one set of counties. The worked examples are deliberately not
   questions from `eval/research.yaml`.
2. **Validate in code.** A decomposition is refused, and the question runs as
   one step, when any of these holds:
   - ids are not q1, q2 ...;
   - a step uses a later step;
   - there are more than 4 steps;
   - a step feeds nothing later (the question did not ask for it).

   A "q1" written in a step's text counts as a use even if it is not listed. A
   one-step result runs the user's ORIGINAL text, never the model's restatement
   (the follow-up rewriter's lesson: a rewrite that drops a word changes the
   question).
3. **Run each step** through `runAnalysis`, handing it ONLY the results it
   declared, as `result:qN` sources.

## What keeps it honest

- **Earlier results are grounded sources, not text.** A step's executed rows
  become an inline series (`source_kind: "inline"`, the upload path: bound into
  `unnest(...)`, READ ONLY, nothing written). The validator's rule, "cite only
  what a tool returned", covers workflow references with no new code. A later
  step cannot cite q1's counties unless it was handed them.
- **A step must use what it said it uses.** A step that declares it works on q1
  and then plans over the whole country has answered a different question. The
  workflow stops there, and the response carries NO rows, so that answer can
  never be read as the final one.
- **Failure stops the workflow.** A refusal or failure at any step ends it with
  a partial report naming the step. Later steps never run on a missing input. A
  step whose answer is a summary (a correlation) cannot feed a step that needs
  counties.
- **The relevance check skips earlier results.** "Counties from q1" has no
  subject for the model to judge, and judged anyway it reads as unrelated. It
  gets a fixed `earlier_result` verdict. Everything else in the plan is judged
  as usual.
- **Provenance spans every step.** The response is the last step's body, so
  every existing reader works unchanged. But `provenance.attribute_origins`
  lists the data of all steps, because the final answer depends on all of it.
  `workflow.methods` is a methods paragraph built from what each step actually
  did: plan, data, definitions applied, adjustments, result size. An earlier
  result's own origin reads `workflow_result`, never `user_upload`.

## Planner changes, all gated

- "EARLIER RESULTS" heading and `EARLIER_NOTE`: present only when a step has
  earlier results.
- `intersect` is also offered then, or on complement phrasing ("the rest of",
  "all other", "except").
- `exclude` (anti-join, `NOT EXISTS`): offered with those, and nowhere else.

The 48-context prompt snapshot is byte-identical: no question outside a workflow
that does not use complement phrasing sees any of this.

## Not done yet

- **Measured** (RESEARCH_PLAN.md, Progress, Phase D): `r-obesity-top50-income`
  is 5 of 7 correct, and over-splitting is 0 of 17 with the gate.
- **Adaptive steps.** The decomposition is fixed up front. A step cannot look at
  q1's result and decide what to ask next. The plan names it ("decide the next
  step"); it needs the static version measured first.
- **Latency.** Each step is a full analysis (~45-80 s on qwen3:14b with
  reasoning on). A 2-step workflow is 2-3 minutes. The plan's target was 3 steps
  under 90 s, which needs planner reasoning off (now safe for the Detroit shape,
  Phase B), and measuring.

## The UI (2026-11-09)

The analysis page runs a workflow automatically. `/api/analyze/stream` hands a
question to `runResearch` when `needsWorkflow` fires, and streams
`workflow_planned` / `workflow_step` events, so progress reads "step 2 of 2".
Pass `workflow=false` to opt out.

| Piece | Where |
|---|---|
| Pipeline strip over the map | `frontend/src/components/WorkflowPipeline.tsx` |
| Group verdict | `ComparisonCard.tsx`, also shown under any single-plan compare_groups answer |
| Panel summary | `WorkflowSummary` in `AnalysisPage.tsx` |
| Progress | `AnalysisProgress.tsx` reads the workflow events |
| Change data | `useConversation.editStep` -> `lib/workflow.ts reviseWorkflow` -> `POST /api/research/revise` |

The strip shows:

- **Steps** left to right, each with its number, question, operations, the data
  it uses and what it produced.
- **The hand-off** between steps, e.g. "50 counties, feeds next".
- **Status**: complete, or stopped at step N with the reason; "Step N data
  changed" after an edit.
- **Steps that never ran**, greyed out.

From the strip, a step can be:

- **put on the map** (the map, legend, table and panel all follow it);
- **inspected**: its result, data, definitions, adjustments, and full plan
  and SQL;
- **changed**: its data swapped.

**Change data** reuses the follow-up `MeasurePanel`, so it shows the step's own
alternatives and a catalog search. An earlier step's counties are locked: you
change them by editing that step. `POST /api/research/revise` re-executes
EVERY step with the plan it already has (`executeGivenPlan`, the same
validation path as `/api/analyze/revise`), applying the edit to one step. That
takes about 2 s, with no planner call. Upstream steps are re-executed rather
than trusting rows sent back from the browser, because their counties become
grounded sources for the next step.

The normal follow-up chips are hidden under a workflow answer. They would
revise the final step alone, and that step depends on an earlier step's
counties, so the server would refuse the edit.

**Verified in the browser at 1440x900.** Both demo questions:

- ran through the UI, with step progress;
- rendered the pipeline, the comparison card and the panel summary;
- switched the map between steps;
- had step 1's data swapped (ERS -> County Health Rankings income), after which
  step 2 re-ran automatically in 2 s.

No console errors. Two defects found this way were fixed:

1. The map legend was titled "difference in medians" over per-county values.
2. The strip reported its height including the open inspector, which pushed
   the map's fit into a sliver. It now measures the strip alone.

The phone layout (strip under the header, inspector below it) type-checks but
has not been checked by eye.
