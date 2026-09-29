# `correlate`, and the relevance check

Two changes from the research-readiness review (2026-09-29): an op that
**tests** a relationship instead of showing two maps side by side, and a check
that stops the planner from answering a question with data that measures
something else.

---

## `correlate`

`backend/planner/ops/correlate.js`. Two county series in, **one row** out.

| column | meaning |
|---|---|
| `value` | Spearman's rho, the headline. Rank-based: county distributions here are heavily skewed |
| `pearson_r` | for comparison. A gap over 0.15 from rho means a few counties drive the linear fit, and the UI says so |
| `slope`, `intercept` | least-squares line of B on A, in B's units per unit of A |
| `n` | counties with both values |
| `n_effective` | n discounted for spatial autocorrelation |
| `ci_low`, `ci_high` | 95% interval for rho, Fisher z on `n_effective` |
| `p_value` | two-sided, on `n_effective` |
| `moran_a`, `moran_b` | global Moran's I of each input, binary contiguity |

**Why `n_effective`.** Neighbouring counties resemble each other: Moran's I is
about 0.6 for the CDC PLACES measures. Treating 2,945 counties as 2,945
independent observations makes every p-value far too small.
`n_eff = n (1 - Ia·Ib) / (1 + Ia·Ib)` (Bretherton et al. 1999) roughly halves n
on these data. It is an approximation, and it errs in the safe direction.

**Pure SQL**, like `hotspot`: `corr()`, `regr_slope()`, window ranks, and a
join against `county_neighbors`. Postgres has no `erf`, so the p-value uses
Abramowitz & Stegun 7.1.26 (error < 1.5e-7), guarded because Postgres `exp()`
raises on underflow instead of returning 0.

**Gated on phrasing and on adjacency.** It is offered only when the question
asks about a relationship ("related to", "associated", "does A affect B", "the
more X, the more Y") and `county_neighbors` is built. For every other question
the op set is unchanged: the 48-context prompt snapshot is still byte-identical.

**A statistic cannot be chained.** The validator refuses `correlate -> rank` or
anything but an `output`: ranking one NULL-fips row would validate, compile and
return a plausible-looking nothing. The op declares `statColumns`; the compiler
carries exactly those columns when an output reads it, and the response carries
them as `stats`.

### Verified against known answers, and independently

| pair | rho | Pearson r | n | n_eff |
|---|--:|--:|--:|--:|
| smoking ~ COPD | 0.936 | 0.941 | 2,945 | 1,354 |
| inactivity ~ obesity | 0.716 | 0.746 | 2,945 | 1,344 |
| obesity ~ diabetes | 0.650 | 0.681 | 2,945 | 1,329 |
| asthma ~ median income | -0.362 | -0.378 | 2,944 | 1,375 |
| median income ~ diabetes | **-0.691** | **-0.631** | 2,944 | 1,339 |

The last row was reproduced **exactly** by a separate Python implementation
(average ranks, from scratch) over the same 2,944 pairs. Moran's I of random
noise over the same adjacency: **-0.011**, where zero is the right answer.

**End to end:** "is obesity related to diabetes across counties", "does median
household income affect asthma rates" and "what is the relationship between
smoking and COPD" all plan `load -> load -> correlate -> output`, with the
right two attributes, on the first attempt.

### Caveats the UI states, and why

- **Association, not cause.**
- **Ecological fallacy.** County averages describe places, not people.
- **PLACES ~ PLACES is inflated.** CDC PLACES values are small-area model
  estimates built partly from the same census covariates, so two PLACES
  measures share structure by construction. The card warns when both inputs
  are PLACES. The smoking ~ COPD 0.936 above is the case to be wary of.

### Not done yet

- **Controls.** rho between A and B ignores income, age and rurality. Partial
  correlation, or the ranked `explain` op from the review, is the next step, and
  is what literature expansion was built to feed.
- **Grouped** correlation (per state), and a **residual** map ("which counties
  have more diabetes than their obesity predicts").

---

## The relevance check (#1)

`backend/planner/relevance.js`. "What is the average rainfall by county?"
planned a mean of **reading scores** and returned one confident number. The plan
was valid: the attribute resolves, the ops compose, the SQL runs.

**Retrieval confidence could not catch this; measured first.** Top BGE
similarity per concept (`eval/answerability-scan.json`) overlaps completely:
unanswerable concepts reach 0.65 ("football attendance") and 0.61 ("crater
diameters"), answerable ones go down to 0.48 ("struggling renters") and 0.47
("wealthiest people"). "Average rainfall" scored 0.54, inside the answerable
range. Any threshold either misses it or refuses real questions.

**So it judges the plan, not retrieval.** After a plan validates, one
constrained call to the resident planner model classifies each attribute the
plan **uses** as `direct`, `proxy`, `denominator` or `unrelated`. Only
`unrelated` is an error. It goes back through the existing repair loop, which
either finds a better attribute or returns no steps. If every attempt ends that
way, the response is a 422 with `not_measured: true`, the rejected attributes
named, and grounded suggestions. It is never reported as an answer.

`proxy` verdicts are kept and shown ("Answered with a stand-in: median household
income, for 'wealthiest'").

This is not the LLM verification step measured at -10pp recall. That filtered
the whole retrieved list before planning. This sees only the 1-3 attributes a
finished plan depends on, and can only send the plan back.

`RELEVANCE_CHECK=1` by default; `relevance_check: false` per request for A/B.
`eval/answerability.yaml` + `eval/answerability_probe.py` measure it:

### Measured (2026-09-29, qwen3:14b, 10 must-refuse + 16 answerable)

| run | not answered | **honest refusal** | false refusals |
|---|--:|--:|--:|
| check off | 10/10 | 7/10 | 0/16 |
| check on (after the matching fix), run 1 | 9/10 | 7/10 | 0/16 |
| check on, run 2 | 9/10 | 6/10 | 0/16 |
| check on + last-word rule | 9/10 | **9/10** | 1/16* |

\* "where do seniors live" failed validation three times without reaching the
check (no relevance verdict was logged), then answered 2/2 on retry with the
check on: planner flakiness, not a refusal by the check.

**What this does and does not show.**

- **The first "on" run measured nothing.** Every verdict came back `unchecked`:
  the model does not always echo a label verbatim, an exact-match lookup found
  nothing, and `|| "{}"` turned a missing reply into an empty list, so the check
  looked live and never ran. Matching is now tolerant (label, leading `aN`,
  attr_id, or position), and a reply that matches nothing is reported as
  `skipped`, never as a pass. Tests pin both.
- **In these runs the check rejected nothing.** qwen3:14b now declines most
  unanswerable questions on its own (the rainfall -> reading scores answer from
  the wild run did not recur in 4 attempts). The check is insurance for the
  runs where it does not, verified per case, but a 10-question suite at
  temperature 0.1 cannot show a rate for a rare event.
- **What moved the number was the planner's own "nothing".** It said so in
  malformed ways: `[{op: "output", inputs: []}]`, or a final no-steps after an
  earlier invalid attempt. Both surfaced as "could not produce a valid plan",
  which reads like a crash. An output-only plan is now treated as no steps, and
  the last attempt decides: honest refusals 6-7/10 -> 9/10.
- **The one persistent miss** is snowfall -> County Health Rankings "Adverse
  Climate Events", judged `proxy` once and `direct` once. That is a genuine
  judgement call rather than a rainfall-style error; when judged a proxy, the
  UI says so.
- **Verdicts are informative on the answerable half**: "Hospitals" for "hardest
  to see a doctor" and "Medicare coverage alone" for "where do seniors live"
  come back as `proxy`, and the UI names them as stand-ins.

**Verdicts are not perfectly stable.** "Medicare coverage alone" for seniors
was `proxy` in one run and `direct` in two; "Uninsured" was `proxy` once. The
verdict decides only whether a stand-in banner shows, so this costs wording,
not answers. One run also left a second attribute `unchecked` when the model
returned fewer verdicts than attributes.

### Redesign: extraction, not judgement (2026-09-29, second pass)

The first version asked a holistic question ("is this attribute relevant to the
question?") and question SHAPE pulled it off course. "What explains asthma
rates" and "what causes lung cancer in the South" had their own OUTCOME judged
unrelated ("it measures cancer, not the factors that cause it") and correct
plans were refused. Patching per op fixes one shape at a time, so the check was
rebuilt to ask something narrower and checkable:

- **Per attribute: what it `measures`, the `question_phrase` it corresponds to
  (copied from the question), and a `fit`**: same / broader / narrower /
  stand_in / denominator / none. The prompt says to ignore what the question
  wants to learn ABOUT a thing (causes, trend, ranking, correlates). Only `none`
  can reject. `broader` surfaces a real caveat: "Cancer (non-skin) or melanoma"
  is broader than "lung cancer", and the UI says so.
- **A rejection must survive a lexical cross-check.** If the attribute's own
  name shares a content word with the question, a `none` is overruled to
  `unchecked`. qwen3 rejected "Coronary heart disease" for "risk factors for
  heart disease" and "Transmission Lines" for "...within 10 miles of electric
  power transmission lines", each time writing "measures X, which the question
  does not name" while the question named X. Every correct rejection measured
  shares nothing (reading scores / rainfall, household income / milk, household
  counts / pet dogs, climate events / snowfall); tests pin both sides.
- **A rule the benchmark killed before it shipped.** I first treated `none` +
  a quoted phrase as a contradiction and let it pass. That is how qwen3 answers
  a rejection: it quotes the UNMEASURED thing ("average rainfall by county").
  In production it would have disabled every rainfall-style catch.

### Which model (benchmark: 16 cases x 3, production prompt and settings)

| | right fit | wrong rejections | missed rejections | p50 / p90 |
|---|--:|--:|--:|--:|
| **qwen3:14b** (kept) | 42/48 | 3* | **0** | 5.7s / 12.1s |
| gemma3:4b | 33/48 | 0 | **3** | 0.7s / 0.7s |

gemma is 8x faster and unusable here: it describes the QUESTION instead of the
attribute ("Reading scores" measures "average rainfall amount"; "Households"
measures "total number of pet dogs") and passes exactly the plans the check
exists to stop. \* qwen3's three were one case, "Medicare coverage alone" for
"where do seniors live", a poor stand-in when "% 65 and older" is loaded;
end to end it came back as a flagged proxy.

The earlier "10-58s" cost was the holistic prompt; the extractive one is
5.7s p50.

### Measured, all versions (answerability.yaml)

| version | honest refusals | false refusals |
|---|--:|--:|
| check off | 7/10 | 0/16 |
| v1 holistic (after the matching fix) | 9/10 | 1/16, plus asthma and lung-cancer explain refused outside the suite |
| v2 extractive | **10/10** | 1/20 (heart-disease explain) |
| v3 extractive + cross-check | 9/10 | **0/20** |

v3's one miss is snowfall -> "Adverse Climate Events", judged a stand-in this
run and `none` the previous one: the one genuine judgement call in the suite.

plan_probe with v3 and the temperature fix: op appropriateness **92.3%**
(unchanged), plan validity 92.3% -> **96.2%**, forbidden 0%. proximity-count,
refused under v2, is correct again; place-metro flipped wrong (the known flake,
not a refusal).

**Cost, corrected.** This section first said "~1-3s". Measured on qwen3:14b it
is **10-58s** per plan: one run of "what explains asthma rates" spent 58s in the
check alone, most of it in the model's hidden reasoning. `think: false` did not
reliably help (10s with, 15s without, on an idle GPU). Whether gemma3:4b, also
resident, judges as well for a fraction of the time is the open measurement.

**A false refusal the probe could not see.** "What explains asthma rates" had
its own outcome judged `unrelated` ("it measures asthma, not the factors that
explain it") and was refused twice. The answerability suite had no explain
questions. The check is now told each attribute's role in the plan ("used by
load, feeding explain") and that an outcome being explained is `direct`.
