const { OPERATORS, CompileError } = require("./_sql");

/**
 * Keep rows whose value passes a comparison.
 *
 * The threshold is one of (planner/conditions.js):
 *   value        a number the question states
 *   definition   a cited definition, already stamped into operator + value by
 *                derefDefinitions before validation, so it compiles as a value
 *   percentile   for "high" / "few" with no number: compared against that
 *                percentile of THIS INPUT's values, computed in the query. Unit
 *                free, so it works on any measure without knowing its scale.
 *
 * `needs` is empty because the requirement is "one of these", which the
 * arity table cannot express; validate() enforces it. The prompt line is
 * unchanged on purpose: the two new fields are explained only in a note that
 * appears when they are offered, so every other prompt is byte-identical.
 */
module.exports = {
  name: "filter_attr",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",

  enumComment: "keep rows matching a numeric comparison",
  promptLine: `  filter_attr  needs operator and value, 1 input   -> keep matching rows`,
  choiceLine: `  "where X is above / below N", "only counties that ..."   -> filter_attr`,

  offered: () => true,

  examples: [{ text:
`QUESTION: counties where median household income is above 75000
  (a2 = median household income)
PLAN: {"intent":"Counties whose median household income is greater than 75000",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_attr","attr_id":"","inputs":["s1"],"operator":">","value":75000},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  validate(step) {
    const has = (k) => step[k] !== undefined && step[k] !== null && step[k] !== "";
    const errs = [];
    if (!has("operator")) {
      errs.push(`step "${step.id}" (filter_attr): missing required field "operator"`);
    }
    const kinds = ["value", "percentile"].filter(has);
    if (kinds.length === 0) {
      errs.push(`step "${step.id}" (filter_attr): missing required field "value"`);
    } else if (kinds.length === 2 && !has("definition")) {
      errs.push(`step "${step.id}" (filter_attr): give "value" or "percentile", not both`);
    }
    return errs;
  },

  compile(step, ctx) {
    const op = OPERATORS[step.operator];
    if (!op) throw new CompileError(`unsupported operator ${step.operator}`);
    if (step.percentile !== undefined && step.percentile !== null && !step.definition) {
      const p = Number(step.percentile);
      if (!Number.isInteger(p) || p < 1 || p > 99) {
        throw new CompileError(`percentile ${step.percentile} out of range`);
      }
      // Over the input itself, so "high" means high among the counties this
      // plan is looking at: after an area filter, high within that area.
      return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} ` +
             `WHERE value ${op} (SELECT percentile_cont(${ctx.bind(p / 100)}::float8) ` +
             `WITHIN GROUP (ORDER BY value) FROM ${ctx.ins[0]} WHERE value IS NOT NULL))`;
    }
    return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} ` +
           `WHERE value ${op} ${ctx.bind(step.value)})`;
  },
};
