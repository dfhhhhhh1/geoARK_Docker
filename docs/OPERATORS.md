# Operators

The plan vocabulary, and how to add to it.

The model never writes SQL. It emits a plan in this closed vocabulary and a
compiler turns that plan into SQL, which is why injection is structurally
impossible rather than filtered for. Adding an operator therefore means adding
a capability to the compiler, not loosening what the model may say.

---

## Adding one

**One file: `backend/planner/ops/<name>.js`.** It used to take seven, spread
across the decoding schema, the validator's arity table, the compiler's switch,
three places in the prompt builder, and the frontend. Nothing enforced that
they agreed, and twice they did not.

```js
module.exports = {
  name: "hotspot",
  inputs: 1,              // arity, checked by the validator
  needs: [],              // fields that must be present
  produces: "series",     // "series" | "features" | null
  kind: "sql",            // "sql" | "compute"

  enumComment: "spatial clusters of high and low values",
  promptLine:  `  hotspot      1 input  -> cluster class per county`,
  choiceLine:  `  "hotspots", "clusters of", "unusually high"  -> hotspot`,

  offered: (ctx) => ctx.hasFeatureTables,     // narrowing predicate
  examples: [{ text: `QUESTION: ...\nPLAN: {...}` }],

  validate(step) { return []; },              // op-specific checks
  compile(step, ctx) { return `${ctx.name} AS (SELECT ...)`; },
};
```

Then add it to `MODULES` in `ops/index.js`, and to the four ordering arrays.

**Ordering is behavior, which is why it stays central.** The decoder reads the
enum in order and the model reads the prompt top to bottom, so the four orders
(`SCHEMA_ORDER`, `PROMPT_ORDER`, `CHOICE_ORDER`, `EXAMPLE_ORDER`) are explicit
and pinned by `snapshot_prompt.js`. They genuinely differ: the schema groups by
op family, the prompt groups the feature ops together, and the phrasing table is
ordered by how common the phrasing is.

### What you get for free

- The op appears in the decoding enum and the prompt **together**, because both
  are derived from the same `offered(ctx)` call. An op named in the prompt but
  absent from the enum costs a repair round on a plan the model was never able
  to emit; that can no longer happen.
- Arity and required-field validation.
- Grounding: declare `grounds` and every cited `attr_id` is checked against
  `attribute_source` and its shape verified.
- Worked examples withheld when the op is not offered.
- Composition with every other op, if it keeps to the `(fips, value)` contract.

### Measure before and after

Op-set size costs accuracy **on its own**. Going from 7 ops to 8 coincided with
plan validity falling from 62.5% to 12.5%, and narrowing the offered set per
query recovered half of that (see [RUNBOOK](RUNBOOK.md)). So:

```bash
python3 eval/plan_probe.py --save before.json
```

register the op, then

```bash
python3 eval/plan_probe.py --compare before.json
```

`--endpoint analyze` cannot see this. It measures whether a plan came back, not
whether the plan answers the question.

---

## The two result shapes

This decides whether a new op is cheap or expensive.

| Shape | Ops | Composes |
|---|---|---|
| `(fips, value)` | everything except `select_features` and `correlate` | Yes, with all of them |
| one statistic row + `statColumns` | `correlate` | No: read only by an `output`; the extra columns reach the response as `stats` |
| computed factor table | `explain` | No: read only by an `output`. SQL builds the matrix, `compute()` runs after execution; the response carries `explain` |
| GeoJSON features | `select_features` | No: read only by an `output` |

An op that consumes and returns `(fips, value)` chains with `normalize`, `rank`,
`filter_area` and the rest for nothing. An op that returns something else needs
its own terminal handling and its own frontend component, which is what
`select_features` cost.

---

## The plan is a DAG

Not a chain. Three shapes are supported and tested in
`backend/planner/test_dag.js`:

- **Converge.** Several sources into one series: `normalize` and `join` take two
  inputs, and nothing stops a chain of them.
- **Split.** One step feeding several consumers. A step is a named CTE, so
  referencing it twice costs nothing, and it is declared once.
- **Multiple outputs.** A plan may carry several `output` steps. Each compiles
  into its own statement over the CTEs it actually reaches, and comes back as a
  separate layer. A features layer and a value layer can coexist this way.

All outputs run in **one read-only transaction**, so every layer sees the same
snapshot. Two layers of one result read at different instants would be a subtle
way to publish an inconsistent map.

The response keeps the flat single-layer shape and adds `layers` alongside it,
so a client that knows nothing about layers still gets the first one rather than
an empty result.

> **The planner is not yet told it may emit more than one output.** The backend
> accepts, validates, compiles and executes multi-output plans; the prompt still
> says to end with exactly one. Changing that is a prompt change and has to be
> measured on its own, not smuggled in with a refactor. Enabling it means
> editing `PLAN_PREAMBLE` and the `output` op's `promptLine`, then re-running
> `plan_probe.py`.

---

## Current operators

| Op | Inputs | Required | Optional | Produces |
|---|:--:|---|---|---|
| `load` | 0 | `attr_id` | | one attribute as a series |
| `count_features` | 0 | `attr_id` *(layer)* | `attribute_filters` | count per county, zeros kept |
| `count_near` | 0 | `attr_id`, `near_attr_id`, `miles` | | count of X within N miles of Y |
| `nearest_distance` | 0 | `attr_id` *(layer)* | | miles to the nearest feature |
| `select_features` | 0 | `attr_id` *(layer)* | `states`, `city`, `attribute_filters`, `limit` | the locations themselves |
| `filter_attr` | 1 | `operator`, `value` | | rows passing a comparison |
| `filter_area` | 1 | `states` | | counties in named states/regions |
| `filter_place` | 1 | `place_kind`, `place_name` | `states` | counties inside a named boundary |
| `per_area` | 1 | | | per square mile of land |
| `normalize` | 2 | | `scale` | ratio, zero-guarded |
| `aggregate` | 1 | `function` | `group_by` | one number, or one per state |
| `rank` | 1 | | `direction`, `limit` | top or bottom n |
| `join` | 2 | | | two measures in one layer |
| `combine` | 2 | `operation` | `scale` | ratio / sum / difference / percent change |
| `hotspot` | 1 | | | Gi\* z-score per county **(signed)** |
| `outlier` | 1 | | | only the unusual counties, in IQRs **(signed)** |
| `correlate` | 2 | | | **one row**: Spearman rho, CI, p on effective n (see [CORRELATE.md](CORRELATE.md)) |
| `explain` | 1 | | *(factors attached by code)* | **ranked factor table**, partial rho after controls ([EXPLAIN.md](EXPLAIN.md)) |
| `output` | 1 | | | terminal |

### Gated on the question, not just on the data

`hotspot`, `outlier` and `combine` read the query text in `offered(ctx)`:

```js
offered: (ctx) => /\b(outliers?|unusual|anomal|atypical)\b/i.test(ctx.query || "")
```

For every question that is not asking for them they are absent from both the
enum and the prompt, so they cost nothing on the queries that already worked.
This is what makes op-set growth affordable — without it, the measured cost of
going from 7 ops to 8 says three more would hurt.

`hotspot` is additionally gated on `county_neighbors` being populated, the same
way `filter_place` is gated on `place_geom`. An op that can only fail should
never be offered.

### Statistics are SQL, not a sidecar

Getis-Ord Gi\* over binary contiguity weights is a join against an adjacency
table plus two aggregates, so it stays in the read-only transaction and in the
`(fips, value)` contract. Build the weights once:

```bash
make neighbors
```

PySAL would earn its keep for weights schemes this does not implement —
distance bands, kernels, k-nearest — not for this.

### Signed output

An op that emits values around zero sets `diverging: true` and a `valueLabel`.
That travels with the layer to the frontend, which switches to a diverging ramp
with bins symmetric about zero. It cannot be inferred from the numbers: a run
that happens to be all-positive is still a diverging measure.

---

## Compute ops

`kind: "compute"` marks an op whose work is not SQL. Nothing implements it yet;
the shape is fixed so that hotspot clustering and outlier detection drop in
without re-litigating the architecture.

The contract is deliberately the same as everything else:

```
(fips, value)[]  ->  HTTP to a sidecar  ->  (fips, value)[]
```

materialized back into the chain as a `VALUES` CTE. Results are capped at 5,000
rows, so the payload is a couple hundred KB of JSON: no shared volumes, no file
handoff, no GDAL in the API container. Keeping to the series contract is what
makes such an op compose with `rank` and `filter_area` for free.

Two constraints worth stating before anyone writes one:

- **`executePlan` runs inside `BEGIN READ ONLY`.** That is a real safety
  property. A compute step cannot run inside that transaction, so it materializes
  its input, calls out, and feeds the result back.
- **The model names the op; it never supplies code.** A sandboxed interpreter
  driven by generated code is the opposite of this design, and would discard the
  property that makes the output trustworthy.
