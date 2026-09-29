# `explain`: ranked factors for one outcome

`backend/planner/ops/explain.js`, `backend/planner/stats.js`. Answers "what
explains X", "risk factors for X", "what drives X": the factors most strongly
associated with an outcome across counties once income, age and rurality are
held fixed, ranked.

This is where literature expansion (`docs/EXPANSION.md`) and `correlate`
(`docs/CORRELATE.md`) meet. Expansion proposes the candidates; this tests them
against the county data.

## Shape

The plan the model writes is three steps: `load(outcome) -> explain -> output`.
**The model never lists factors.** It is unreliable at enumerating several
attributes and has copied worked examples verbatim before. After the plan
validates, code attaches them (`chooseFactors`):

1. **Literature**: the best usable attribute of each concept expansion kept.
2. **Named in the question**: the best attribute of each other primary
   sub-query ("does income, obesity or smoking explain diabetes"). A sub-query
   made only of why-words ("drivers") is ignored: one run turned "what drives
   obesity" into a "drivers" sub-query, which retrieved **Driving alone to
   work** and ranked it #2.
3. **Fallback** when neither yields anything (non-health outcomes): median
   income, % 65+, % rural, % adults without a high-school diploma.

**Controls**: County Health Rankings median household income, % 65 and older,
% rural (~3,133 counties each; `EXPLAIN_CONTROLS`). A factor is never
controlled for itself.

## Statistics, per factor

Computed in Node, not SQL: partial correlation with several controls needs a
least-squares solve, which Postgres lacks. SQL assembles the county x variable
matrix in the same read-only transaction; `compute()` does the rest.

| field | meaning |
|---|---|
| `rho` | Spearman with the outcome, no controls |
| `partial_rho` | Spearman after residualizing both ranked series on the ranked controls |
| `ci_low/high`, `p_value` | on an effective n from the Moran's I of the two **residuals**, with the controls taken from the degrees of freedom |
| `q_value` | Benjamini-Hochberg across the factors tested |
| `importance` | the CI bound nearest zero, or 0 if the CI spans zero. **Rank order**: a factor must be strong AND well measured |
| `context: "consequence"` | literature mostly reports it as a result of the outcome; shown, not ranked |

Not fitted, with the reason reported: `same_measure_as_outcome` (|rho| >= 0.97,
crude vs age-adjusted of the same thing), `same_measure_as_control`,
`too_few_counties` (< 30).

### Verified

`test_stats.js` (9) and `test_dag.js` (explain cases):

- residualized partial correlation equals the closed form for one control to
  1e-10; a purely confounded association drops from > 0.7 to < 0.06
- Moran's I is ~+1 on a smooth series, -1 on alternation, ~0 on noise
- the CI reproduces correlate's SQL interval for income ~ diabetes
- Benjamini-Hochberg matches a hand-worked example
- **synthetic counties**: a true driver ranks first; a factor that only tracks
  income (r ~0.93) is > 0.5 raw and < 0.08 after controls; a copy of the
  outcome and a second income measure are reported, not ranked

### Two bugs the synthetic test caught before any real data

1. **Dropping a collinear control.** The first version dropped a control that
   correlated >= 0.9 with the factor, to avoid "erasing" it. That is exactly the
   confounder that must be kept: the income-tracking factor lost its income
   control and came out at partial -0.69, presented as a strong driver. Now the
   control always stays, and a factor >= 0.97 with a control is reported as the
   same measure.
2. **Giving up on a concept.** When a concept's top result was already taken
   (a control), `chooseFactors` skipped the whole concept instead of taking the
   next result.

## Direction, and why it needed its own counts

Expansion first recorded `roles: [cause, effect]`, which is true of nearly
every neighbour and hides the split that matters:

| | concept -> diabetes | diabetes -> concept |
|---|--:|--:|
| Obesity | 743 papers | 227 |
| Cardiovascular disease | 153 | **733** |

With roles only, coronary heart disease ranked **#1** "explanation" of
diabetes. It is mostly a consequence. Expansion now returns papers per
direction, consequence-dominant factors are shown as context, and for why-
questions expansion ranks concepts by papers **as a cause**
(`causesFirst`, decided by the same phrasing test that offers `explain`).
Before that, obesity's slots were all filled by its consequences and the table
had **no drivers at all**.

## Measured end to end (2026-09-29, qwen3:14b)

| question | ranked drivers (adjusted rho, 95% CI) | context |
|---|---|---|
| what drives obesity | physical inactivity **+0.48** [0.44, 0.51] | diabetes, coronary heart disease |
| risk factors for heart disease | diabetes +0.38 [0.35, 0.42]; obesity +0.29 [0.25, 0.32] | |
| what explains diabetes | obesity **+0.42** [0.38, 0.45] (raw +0.67) | coronary heart disease |
| what explains asthma | smoking +0.30 [0.25, 0.34]; particulate matter +0.02 (CI spans 0); obesity +0.00 | |
| what drives unemployment (fallback) | income -0.48; % rural -0.20; < HS diploma +0.16; % 65+ -0.10 | |

Effective n is 60-75% of n throughout. The asthma result, air pollution null
once income is controlled, is a real county-level finding worth stating as
such, not a bug.

Re-run after the relevance redesign and the temperature/context fixes: asthma
and "what causes lung cancer in the South" (smoking +0.36 [0.30, 0.42] over
1,301 southern counties) both plan on the first attempt, and all four explain
questions in answerability.yaml answer.

## Not done

- **Regression, not only partial correlation.** Each factor is adjusted for the
  controls but not for the other factors, so two overlapping factors can both
  rank high. A joint model (standardized coefficients, VIF) is the next step,
  and where the PySAL sidecar starts to earn its place (spatial lag/error).
- **PLACES ~ PLACES inflation** is stated in the UI, not corrected.
- **Answerability suite has no explain questions**, which is why the false
  refusal above went unseen. Add them.
- Frontend: a factor's map (residuals) is not drawable yet.
