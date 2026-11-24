const { CompileError, OPERATORS } = require("./_sql");
const C = require("../composite");

/**
 * One score per unit from several measures (docs/GIS_OPS_PLAN.md H6 tier 1,
 * item 4). See planner/composite.js for how the method is read.
 *
 * The model's part is only which measures: one input per measure the question
 * lists. weights, directions, method and standardize are set by code from the
 * question (applyComposite) and absent from the decoding schema, so a model
 * that cannot weigh things cannot weigh them wrongly. Absent, they mean equal
 * weights, every input "high", a weighted sum of percentile ranks.
 *
 * SQL, so it composes like every other series op: an inner join of the inputs
 * on the unit key (a unit missing from any input has no score, which is also
 * how a threshold mask works: filter that input first), each value
 * standardized over the joined units, then combined.
 *
 *   percentile  PERCENT_RANK over the joined units, ascending for "high",
 *               descending for "low": 0 for the least, 1 for the most
 *   zscore      (v - mean) / sample sd, negated for "low"
 *   minmax      (v - min) / (max - min), or (max - v) / ... for "low"
 *
 *   sum         sum of w_i * s_i              compensatory
 *   geometric   exp(sum of w_i * ln s_i), 0 when any s_i is 0
 *   minimum     least s_i                     bottleneck
 *   count       number of inputs past their own threshold (0 to N): an
 *               accumulated-inequity score, as in deprivation indices that
 *               sum yes/no flags. `thresholds[i]` = {operator, value} on the
 *               input's RAW value; weights and standardize are not used. A
 *               unit below every threshold scores 0, it is not dropped.
 *               Up to MAX_COUNT_INPUTS inputs (a flag count is not weighted,
 *               so the 6-input cap of a weighted score does not apply).
 */

// Threshold comparisons a count may use: the ordering ones of filter_attr.
const COUNT_OPS = [">", ">=", "<", "<="];

const stdExpr = (i, std, dir) => {
  const v = `v${i}`;
  if (std === "zscore") {
    const z = `(${v} - AVG(${v}) OVER ()) / NULLIF(STDDEV_SAMP(${v}) OVER (), 0)`;
    return `COALESCE(${dir === "low" ? `-(${z})` : z}, 0)`;
  }
  if (std === "minmax") {
    const range = `NULLIF(MAX(${v}) OVER () - MIN(${v}) OVER (), 0)`;
    return dir === "low"
      ? `COALESCE((MAX(${v}) OVER () - ${v}) / ${range}, 0.5)`
      : `COALESCE((${v} - MIN(${v}) OVER ()) / ${range}, 0.5)`;
  }
  return `PERCENT_RANK() OVER (ORDER BY ${v} ${dir === "low" ? "DESC" : "ASC"})`;
};

module.exports = {
  name: "composite",
  // Words that name this method, never data (planner/named_data.js).
  methodTerms: /\bcomposite\b|\bindex\b|\bscores?\b|\bweight(?:s|ed|ing)?\b|\bequal(?:ly)?\b|\bz[-\s]?scores?\b|\bstandardi[sz]\w*|\bpercentile\s+ranks?\b|\bgeometric\s+mean\b|\bahp\b|\banalytic\s+hierarchy\b/gi,
  // The validator reads a [min, max] pair. The structural max is the count
  // method's; validate() holds every other method to MAX_INPUTS.
  inputs: [2, C.MAX_COUNT_INPUTS],
  needs: [],
  produces: "series",
  kind: "sql",
  // A weighted sum of z-scores is signed around zero.
  diverging: (step) => step.standardize === "zscore" && !["geometric", "count"].includes(step.method || "sum"),
  valueLabel: (step) => C.compositeValueLabel(step),

  enumComment: "one score per county from 2 to 6 measures",
  promptLine: `  composite    2 to 6 inputs, one per measure      -> one score per county from several
                 measures (weights and direction are set for you)`,
  // "High on all of A, B and C" with a SCORE is the bottleneck composite, not
  // three conditions: dev r2 planned rank x3 -> intersect for it while the
  // question asked for "the lowest of its three percentile ranks".
  choiceLine: `  "index / score of A, B and C", "rank by A, B and C", "most vulnerable",
  "score high on all of A, B and C"                         -> load each, then composite`,

  // Gated on phrasing (planner/composite.js asksComposite): a score built from
  // a list of criteria, or a stated weighting. Every other question sees the
  // op set it saw before, and the 48-context snapshot has no query at all.
  offered: (ctx) => C.asksComposite(ctx.query),

  examples: [
    { text:
`QUESTION: an index of unemployment rate, adults without health insurance and distance to the nearest hospital for Kentucky counties
  (a2 = unemployment rate, a4 = adults without health insurance, a7 = Hospitals)
PLAN: {"intent":"Composite of unemployment, uninsured adults and distance to the nearest hospital, Kentucky counties",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Kentucky"]},
          {"id":"s3","op":"load","attr_id":"a4","inputs":[]},
          {"id":"s4","op":"nearest_distance","attr_id":"a7","inputs":[]},
          {"id":"s5","op":"composite","attr_id":"","inputs":["s2","s3","s4"]},
          {"id":"s6","op":"output","attr_id":"","inputs":["s5"]}]}
  NOTE: one input per measure the question lists, each measure once. Restrict
  the place on the first input; the others follow it.` },
  ],

  validate(step) {
    const errs = [];
    const ins = step.inputs || [];
    const n = ins.length;
    if (new Set(ins).size !== n) {
      errs.push(`step "${step.id}" (composite): an input is listed twice. Use each measure once.`);
    }
    // Set by code, but a follow-up plan comes back from the browser.
    if (step.weights !== undefined) {
      const w = step.weights;
      if (!Array.isArray(w) || w.length !== n || !w.every(x => Number.isFinite(x) && x >= 0) ||
          !(w.reduce((s, x) => s + x, 0) > 0)) {
        errs.push(`step "${step.id}" (composite): weights must be ${n} non-negative numbers, not all zero`);
      }
    }
    if (step.directions !== undefined &&
        (!Array.isArray(step.directions) || step.directions.length !== n ||
         !step.directions.every(d => C.DIRECTIONS.includes(d)))) {
      errs.push(`step "${step.id}" (composite): directions must be ${n} of ${C.DIRECTIONS.join(" / ")}`);
    }
    if (step.method !== undefined && !C.METHODS.includes(step.method)) {
      errs.push(`step "${step.id}" (composite): method must be one of ${C.METHODS.join(", ")}`);
    }
    if (step.standardize !== undefined && !C.STANDARDIZE.includes(step.standardize)) {
      errs.push(`step "${step.id}" (composite): standardize must be one of ${C.STANDARDIZE.join(", ")}`);
    }
    if (n > C.MAX_INPUTS && step.method !== "count") {
      errs.push(`step "${step.id}" (composite): a weighted score takes at most ${C.MAX_INPUTS} measures, got ${n}; ` +
                `only a count of thresholds met (method "count") takes up to ${C.MAX_COUNT_INPUTS}`);
    }
    if (step.method === "count") {
      const t = step.thresholds;
      if (!Array.isArray(t) || t.length !== n ||
          !t.every(x => x && COUNT_OPS.includes(x.operator) && Number.isFinite(Number(x.value)) && x.value !== null && x.value !== "")) {
        errs.push(`step "${step.id}" (composite): a count needs ${n} thresholds, one {operator, value} per input, ` +
                  `operator one of ${COUNT_OPS.join(" ")}`);
      }
    } else if (step.thresholds !== undefined) {
      errs.push(`step "${step.id}" (composite): thresholds apply only to method "count"`);
    }
    if (step.method === "geometric" && step.standardize === "zscore") {
      errs.push(`step "${step.id}" (composite): a geometric mean needs non-negative scores; use percentile or minmax`);
    }
    return errs;
  },

  compile(step, ctx) {
    const ins = ctx.ins || [];
    const n = ins.length;
    if (n < 2) throw new CompileError("composite needs at least two inputs");
    if (step.method === "count") return compileCount(step, ctx, ins);
    const std = step.standardize || "percentile";
    const method = step.method || "sum";
    const dirs = step.directions || new Array(n).fill("high");
    const raw = Array.isArray(step.weights) && step.weights.length === n ? step.weights : new Array(n).fill(1);
    const total = raw.reduce((s, x) => s + x, 0);
    if (!(total > 0)) throw new CompileError("composite weights sum to zero");
    // Bound ONLY when the expression uses them: `minimum` does not, and
    // binding three weights it never references put 12 parameters on a
    // statement with 9 placeholders, which Postgres refused at execution on a
    // plan that had validated (composite_dev r3a, 2026-11-21; the same trap
    // combine's `scaled` flag exists for).
    const w = method === "minimum" ? [] : raw.map(x => `${ctx.bind(x / total)}::float8`);

    const vals = ins.map((_, i) => `i${i}.value::float8 AS v${i}`).join(", ");
    const from = ins.map((t, i) => (i === 0 ? `${t} i0` : `JOIN ${t} i${i} USING (fips)`)).join(" ");
    const notNull = ins.map((_, i) => `i${i}.value IS NOT NULL`).join(" AND ");
    const scored = ins.map((_, i) => `${stdExpr(i, std, dirs[i])} AS s${i}`).join(", ");
    const s = ins.map((_, i) => `s${i}`);

    let score;
    if (method === "minimum") score = `LEAST(${s.join(", ")})`;
    else if (method === "geometric") {
      score = `CASE WHEN LEAST(${s.join(", ")}) <= 0 THEN 0 ` +
              `ELSE EXP(${s.map((x, i) => `${w[i]} * LN(${x})`).join(" + ")}) END`;
    } else score = s.map((x, i) => `${w[i]} * ${x}`).join(" + ");

    return `${ctx.name} AS (SELECT fips, ${score} AS value FROM (` +
           `SELECT fips, ${scored} FROM (` +
           `SELECT fips, ${vals} FROM ${from} WHERE ${notNull}` +
           `) j) z)`;
  },
};

/**
 * method "count": SUM of 0/1 flags, one per input, on raw values. Inner join
 * like the other methods (a unit with no value for an input has no score:
 * an unknown is not a 0), but no threshold removes a unit.
 */
function compileCount(step, ctx, ins) {
  const t = step.thresholds || [];
  if (t.length !== ins.length) throw new CompileError("a count needs one threshold per input");
  const vals = ins.map((_, i) => `i${i}.value::float8 AS v${i}`).join(", ");
  const from = ins.map((x, i) => (i === 0 ? `${x} i0` : `JOIN ${x} i${i} USING (fips)`)).join(" ");
  const notNull = ins.map((_, i) => `i${i}.value IS NOT NULL`).join(" AND ");
  const flags = ins.map((_, i) => {
    const op = OPERATORS[t[i].operator];
    if (!op || !COUNT_OPS.includes(t[i].operator)) throw new CompileError(`unsupported threshold operator ${t[i].operator}`);
    return `(CASE WHEN v${i} ${op} ${ctx.bind(Number(t[i].value))}::float8 THEN 1 ELSE 0 END)`;
  });
  return `${ctx.name} AS (SELECT fips, (${flags.join(" + ")})::float8 AS value FROM (` +
         `SELECT fips, ${vals} FROM ${from} WHERE ${notNull}) j)`;
}

