# Follow-ups: refining an answer, adding data, asking the next question

The analysis page is a conversation. Each question and each refinement is a
turn; the answer on screen is the one a follow-up applies to, and any earlier
answer can be brought back and refined from (a branch, not an undo).

Files: `backend/followup.js` (all logic), `backend/test_followup.js`,
`frontend/src/hooks/useConversation.ts`, `frontend/src/components/FollowUpBar.tsx`,
`UploadPanel.tsx`, `ResultBlock.tsx`, `eval/followup.yaml`, `eval/followup_probe.py`.

## Two paths, deliberately separate

| | **Edit** | **Question** |
|---|---|---|
| What | a structural change to the plan that just ran | anything else typed |
| How | applied in code, re-validated by `validatePlan`, compiled, run | small model rewrites it into one standalone question, which is **shown**, then the normal pipeline runs |
| Model calls | none | one gemma3:4b call (~0.2s), then the usual plan |
| Latency | 30-600 ms measured | the planner's ~20-30 s |
| Can drift to another measure? | no | yes, like any planned question |

**The planner prompt is untouched.** Nothing here reaches `buildSystemPrompt`;
`snapshot_prompt.js` is byte-identical across all 48 contexts, so every planner
number in CLAUDE.md still describes the planner.

### Edits (`POST /api/analyze/revise`)

| edit | what it does | refuses when |
|---|---|---|
| `restrict_area` | filter every leaf series to states/regions; replaces an earlier area; sets `states` on `select_features` | unknown place; no county series |
| `clear_area` | removes every area / place restriction | nothing to clear |
| `rank` | top/bottom N; updates an existing rank | two-measure result (rank would drop `value_b`), statistic |
| `remove_step` | undoes one `filter_area` / `filter_place` / `filter_attr` / `rank` | other ops |
| `swap_measure` | the same plan over another attribute | attribute not in the plan |
| `add_measure` | `join` (side by side) or `correlate` a second series; correlation reads the series **before** any rank | not a single per-county series; a layer of locations |
| `add_stat` | insert `hotspot` or `outlier`; switch between them | ranked series; no adjacency |
| `map_measure` | fresh `load -> output` (or `select_features`), keeping the current area; needs no earlier plan | - |
| `add_factor` | add an attribute (e.g. the user's) to an `explain` table | not an explain result |

Which edits the UI offers comes from `result.followups`, which the server
computes by **trying each edit on a copy** of the plan. A second set of
applicability rules in the browser would drift the way the prompt and the
decoding enum once did.

The plan comes back from the browser and is treated exactly like a plan from
the model: untrusted, validated, compiled with every literal bound. Revise
requests are capped at 24 steps.

**Titles.** Edits are recorded as labelled revisions on the plan
(`base_intent`, `revisions`), and a later edit of the same kind replaces the
earlier one. An area change rewrites the place in the planner's own title
rather than appending: appending produced "Median household income for Missouri
counties · in Texas", a title naming the wrong state first.

### Recognising an edit in free text

`parseQuickEdit` catches "what about Texas?", "same thing but for the West",
"top 10", "the whole country" with no model call. It is strict: every word must
be a place, a rank phrase or a filler word, so "Texas hospitals" and "what about
Washington County" go to the model. Postal codes count only in capitals and
only with a locative word ("what about TX"), because "OK" alone is not Oklahoma.

### Rewriting a question

Two deterministic guards sit around the model, both added because of a
measured failure:

1. **Standalone gate** (`isContinuation`). A message with no continuation cue
   ("and", "what about"), no word pointing back ("it", "that", "instead") and
   5+ words is a complete question and runs as typed. Without it, gemma3:4b
   added "Ohio" to "how far is each county from the nearest airport" after an
   Ohio question, 3 of 3.
2. **Dropped-word check** (`droppedWords`). If the rewrite loses a content word
   the user typed, it is discarded and the text runs as typed, with a note in
   the thread. Without it, "Texas hospitals" became "What is the poverty rate
   by Texas county?", 3 of 3.

## Measured (`eval/followup_probe.py`, 3 repeats each)

| | run 1 (20 cases) | run 2 (28 cases) |
|---|--:|--:|
| edits classified and parsed correctly | 100% | 100% |
| questions misread as edits | 0.0% | 0.0% |
| question rewrites passing | 71.4% (10/14) | **95.2%** (20/21) |
| held-out cases (written before run 2 was measured) | - | **100%** (8/8) |
| p50 latency, question / edit | 0.19 s / <10 ms | 0.21 s / <10 ms |

Run 2 changed the prompt (replacement rules, five worked examples on topics
absent from the suite) and added the two guards. The 20 original cases shaped
those changes, so their 95.0% is optimistic; the held-out 8/8 is the honest
number, and 8 cases is small.

The one remaining failure is `q-change-year`: "and in 2020?" after a 2015
question becomes "unemployment rate by county, 2015 and 2020". That is arguably
a trend reading; it is recorded as a failure and not tuned away.

**Temperature 0 is not fully deterministic here.** Three cases produced
different wording across repeats (all passing). Repeat before believing.

**What this suite cannot see:** whether the rewritten question then plans
well. That is `plan_probe.py`'s job. It scores the text handed to the planner.

## Your own data

A CSV with a county FIPS column and numeric columns. Parsed and matched in the
browser (`lib/csv.ts`) against the same `counties.geojson` the map draws, so
the upload summary reports "115 of 116 rows match a county" and names what did
not. Tolerates a BOM, quoting, `;`/tab delimiters, `$ , %`, 4-digit FIPS (lost
leading zero) and census `0500000US29001` GEO_IDs. Rows are never matched by
county NAME: duplicate names within a state are the ambiguity this project
keeps paying for.

**Nothing is stored server-side.** Each request that uses an upload sends its
FIPS and values (at most 2 series, 5,000 rows each), validated in
`validateUserSeries`, bound as two arrays into
`unnest($1::char(5)[], $2::float8[])` in `load`, and discarded when the
transaction ends. The transaction stays `READ ONLY`. A plan can only cite an
upload sent with that request (`withUserSeries`), the same grounding rule every
catalog attribute obeys. Provenance reports it as `source_kind: user_upload`,
so no export can present user numbers as catalog data.

**Verified against a known answer.** An upload of 2 × ERS unemployment + noise
in [0, 0.1), correlated with ERS unemployment over Texas: ρ 0.999, slope
1.9996 (true 2), intercept 0.053 (expected 0.05), n 254 = Texas counties. A
random upload against Missouri unemployment: ρ −0.04, p 0.66, and Moran's I of
the random series 0.03.

## Things found on the way

- **National maps opened on the whole globe.** Aleutians West (02016) spans
  −179 to +179 longitude, so any fit that included it wrapped the planet.
  Pre-existing, in both `ChoroplethMap` and `LayeredMap`; antimeridian-crossing
  features are now excluded from the fit (they still draw).
- **A correlation showed a "Summary" tab of one row** ("Counties 1, Minimum
  −0.042 ... Maximum −0.042"), because `hasRows` was true for a statistic.
  Pre-existing; the county tabs are now limited to per-county layers.
- **Near-duplicate measures share labels.** "Civilian labor force 18 to 64
  years › Unemployment rate" appears twice in one picker; colliding labels now
  show the full description.

### Correction: follow-ups on a restricted answer lost the restriction or the measure

Two defects, both found from one real session ("what causes lung cancer in
the south", then "normalize by population"), both mine:

1. **Abbreviated place lists leaked into questions.** Titles shortened a
   16-state list to "Alabama, Arkansas and 14 more". The rewrite read the
   title, wrote "... across Alabama, Arkansas and 14 more", and the planner
   guessed the 14: the answer was restricted to the wrong states. Now a list
   that equals a census region is named as the region, any other long list is
   a count ("16 states"), the rewrite is given the EXACT states from the plan
   (`areaOf`), and a rewrite containing "and N more" is discarded.
2. **Operation-only follow-ups lost the measure.** The same rewrite produced
   "normalize Alabama, ... by population", which planned population alone. The
   rewrite is now told the measure on screen (`primaryAttr`, named from the
   catalog), and when the follow-up names no new measure (`namesNewMeasure`:
   only operation words like normalize, per capita, per square mile, top), a
   rewrite that lost it is replaced by `"<measure>: <follow-up> in <area>"`.
   Every other discard path (dropped word, abbreviated list, no rewrite) now
   falls back to that composition too. The first version fell back to the bare
   text, and "normalize by population" alone planned population by tract.

Replayed after the fix: the follow-up read as "Cancer (non-skin) or melanoma
among adults (crude prevalence) normalized by population in South counties",
and returned 1,301 counties, all in the South (the original: 1,300).
`followup_probe.py` run 3: 28/28 x 3, held-out 8/8. The probe's canned plans
carry no catalog measure, so it does not exercise guard 2; the unit tests do.

A note on that answer: a crude prevalence is already per person, so dividing
it by population ranks the smallest counties highest (King County TX first).
The pipeline answered what was asked; the question is the problem.

### Explain results now map the outcome

`explain` already fetched the outcome for every county to rank factors against
it, then discarded it. The layer now returns it as ordinary rows (with county
names), so a "what causes X" answer shows where X is, with the county table
under it, and each factor has "Map this factor".

### The results table

Was the first 50 rows at full height under the map. Now `CountyTable`: every
row in a fixed-height scroll box, a find box that matches county, state code
or FIPS, sortable columns, a stable rank, a state column (so the two Harris
counties are told apart), and a click zooms the map to the county and outlines
it, on both the single and the layered map.

## Limits

- Free text cannot reference an upload ("correlate my data with obesity"). The
  planner never sees uploads; use the buttons. Offering uploads to the planner
  is a prompt change and would need its own `plan_probe.py` run.
- Uploads are FIPS-keyed county series only. No tracts, ZIPs or points.
- Uploads live in the browser tab and are gone on reload.
- A follow-up's rewrite reads at most the last 3 turns of its branch.
