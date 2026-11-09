# Conditions, definitions, and group comparisons

Phase C of [RESEARCH_PLAN.md](RESEARCH_PLAN.md). Questions like "rural counties
with a poverty rate above 20% and no hospital", "is unemployment higher in the
South than in the Northeast", and "which counties' unemployment rose the most
over the last decade".

| Piece | Where |
|---|---|
| Published definitions (data) | `etl/definitions.yaml`, sidecar `columns.<col>.definitions` |
| Loader (shape checks) | `etl/definitions.py`, `make definitions` / `make definitions-dry` |
| Fit to the loaded data | `backend/definitions.js`, reported on `/api/health` |
| Thresholds, gates, labels | `backend/planner/conditions.js` |
| Ops | `planner/ops/filter_attr.js` (`definition`, `percentile`), `intersect.js`, `compare_groups.js` |
| Periods | `resolveRelativeYears` (index.js) + `planner/vintages.js` |
| Tests | `planner/test_conditions.js`, `etl/test_definitions.py` |

## Where a threshold comes from

A `filter_attr` threshold has three possible sources, in this order of trust:

1. **definition**: a published cut on that exact measure, with a citation.
   The model writes `"definition": "d1"`. Code stamps the operator and number
   onto the step, so the plan shown to the user carries the real rule, and
   provenance lists the source.
2. **value**: a number the question states ("above 20%").
3. **percentile**: "high", "few", "above average" with no number. The input is
   compared against a percentile of **its own** values, computed in the query.
   This is unit-free, so it works on a measure loaded tomorrow without anyone
   knowing whether that measure is a percent, a fraction or a count.

A stated number is checked against the measure's national range. A percentage
written against a 0-1 fraction ("% rural > 50" on CHR's `% Rural`, which is a
fraction) is converted and reported. Any other out-of-range number goes back
through repair with the range in the message.

## Why the definitions do not become a hard-coded dictionary

The risk was a term list (`rural -> % rural > 50`) that grows one commit at a
time and breaks silently when data changes. Five rules prevent that.

1. **Definitions are data with a citation, not code.** They live in
   `etl/definitions.yaml` for measures loaded outside the sidecar path, and in
   the dataset's own sidecar for anything loaded with `make ingest`. They reach
   the server through the ledger, like tags do. An entry describes what a
   publisher defined, never what seemed reasonable.
2. **No term matching.** A definition is attached to a MEASURE. It reaches the
   planner only on a candidate that retrieval already returned. Getting from
   "rural" (or "countryside") to `% Rural` is retrieval's job, and
   `known_item.yaml` measures it. There is no second, unmeasured matcher keyed on
   the terms, and so no cutoff to tune.
3. **Every definition is re-tested against the data actually loaded**, in the
   API, every time the corpus loads, not once at load time. It is withheld,
   with the reason on `/api/health`, if any of these fail:
   - **vintage**: the loaded year is outside the `vintages` it was published for;
   - **scale**: percent, fraction, code, flag or count against the observed
     range;
   - **range**: the threshold lies outside the observed values;
   - **share**: the rule selects under 0.5% or over 99.5% of counties.

   A withheld definition is never applied, and the percentile fallback takes
   over.
4. **Vintages are required.** Range checks cannot see a changed code scheme.
   ERS Urban Influence Codes have 12 codes in 2013 and 9 in 2024, with different
   meanings. The 2013 rule "3-12 = nonmetro" passes every range check on the 2024
   data while selecting the wrong counties. Only the vintage catches it, which is
   why there is no UIC entry.
5. **Nothing requires an entry.** A qualifier with no definition uses the
   percentile fallback, labelled as such. Adding data never requires adding an
   entry; an entry only replaces "top quarter" with a citable cut.

Verified live (2026-11-09): with the 2013 UIC rule and a percent-declared
`% Rural` rule inserted into `concept_definition`, the API withheld both on
reload with these reasons:

    published for 2013-2013, but the loaded URBAN_INFLUENCE_CODE is 2024; code schemes change between releases
    declared percent (0-100), but values run 0 to 1

The 8 real bindings are all active. The two ERS metro encodings, `METRO = 1` and
`RUCC <= 3`, agree on all 3,210 counties both cover.

### Adding a definition

1. Find the publisher's own statement of the cut, and cite it in `source` and `url`.
2. For an ingested dataset, put it under the column in the sidecar
   (`etl/templates/dataset.meta.yaml` has an example). Otherwise, add it to
   `etl/definitions.yaml` with `vintages`.
3. Run `make definitions-dry`, then `make definitions` and `make reload-corpus`.
   Check `/api/health` under `definitions`: it shows active or withheld, the
   reason, and how many counties the rule selects.

## The phrasing gates

The `percentile` field, `intersect` and `compare_groups` are offered only when
the question calls for them. That keeps the 48-context prompt snapshot
byte-identical, and with it every number measured before. The gates are English
grammar (comparatives, quantifiers, "than", "compared with"), a closed set that
does not grow with the data. The `definition` field is gated on data instead: a
retrieved attribute carries one.

Blast radius over all 121 questions in `eval/*.yaml`: 12 see a changed prompt,
all of them condition or comparison questions. Three false matches were found
this way and fixed:
- "how **many** hospitals" is counting, not a qualifier.
- "**over** the last decade" is a period, so `over`/`under` now need a number.
- "**more than** 100,000" and "the **difference between** A and B" are not two groups.

The time gates gained counted periods ("last decade", "past 5 years") and
change verbs ("rose", "fell"). Before, "rose the most over the last decade"
offered neither `year` nor `combine`, so the change could not be planned at all.

## `intersect`

Keeps input 1's rows, including its value (the answer's measure), for counties
that also appear in input 2. It is a semi-join, so a county is never
duplicated. Three conditions take two intersects. Each condition is a
`filter_attr` on its own measure.

## `compare_groups`

Takes two series, each already restricted to its group by any of the usual
filters. It returns per-county rows tagged `grp` a/b, so the map shows both
groups, plus a `comparison` summary:

- `diff`: median(a) − median(b), in the measure's units
- per-group medians, means and n
- `rank_biserial`
- `p_value`: Mann-Whitney on **effective** sizes, n·(1−I)/(1+I) with I the
  pooled Moran's I, the same discount `correlate` applies

A county in both groups is dropped from both and counted in `overlap`. Group
labels ("South", "mostly rural") come from the plan's own filters, never from
model text. The summary is named `comparison`, not `stats`, because the UI
reads `stats` as a correlation card and would hide the map.

Verified against an independent Python implementation on South vs Northeast
unemployment (ERS 2023):

| | value |
|---|--:|
| medians | 3.5 / 3.5 |
| counties | 1,422 / 217 |
| rank-biserial | 0.0232002696 |
| Moran's I | 0.5053322462 |
| p (SQL / Python) | 0.7521712692 / 0.7521711313 |

The p values differ only by the erf approximation (< 1.5e-7). A classical test
with no spatial discount reads p 0.58 on the same data.

## Periods

`resolveRelativeYears` now marks a counted period ("last decade"), and
`anchorYears` re-counts it from the measure's own latest year once ids are
real. ERS unemployment ends in 2023, so the period is 2013-2023, not 2016-2026.
A named year the measure lacks moves to the nearest year it has, and the move
is reported.

When the question counts its period, the model's own years and a second measure
are overridden. Live, the model had planned ERS 2000 against County Health
Rankings 2020 for "the last decade". A model year against a named period ("since
2010" -> 2015) is still left alone, as `test_dag.js` pins.

Named events ("since the recession") are not resolved. That would need a
dictionary of events, which is exactly what this design avoids. They are left
to the model.

## Not done

- **Frontend.** `comparison` is returned but not rendered. A compare_groups
  answer shows its rows on the map and the table, but no verdict card.
- **Complement groups** ("Appalachia vs the rest of the country") have no op.
  The phase_d question `r-obesity-top50-income` needs one.
- **Definition terms are not searchable.** "Nonmetropolitan counties" does not
  retrieve RUCC today, so its definitions never show. Making definition terms
  part of a measure's search text is a corpus change, and would need
  `known_item.yaml` before and after.
