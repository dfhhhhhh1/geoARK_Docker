/**
 * Carry two series through to the output side by side.
 *
 * `secondValue: true` is what tells the compiler this CTE has a `value_b`
 * column. Every other op selects (fips, value) explicitly and therefore DROPS
 * it, so `load -> load -> join -> rank -> output` is a one-measure result;
 * emitting `r.value_b` for that would be a SQL error at runtime, on a plan that
 * validated. The flag is declared here rather than special-cased in the
 * compiler so a future two-measure op only has to set it.
 */
module.exports = {
  name: "join",
  inputs: 2,
  needs: [],
  produces: "series",
  secondValue: true,
  kind: "sql",

  enumComment: "combine two steps on the shared entity key",
  promptLine: `  join         2 inputs                            -> combine on the shared area`,
  choiceLine: `  "compare A against B", "A versus B", "A alongside B"     -> join`,

  offered: () => true,

  examples: [{ text:
`QUESTION: compare unemployment against educational attainment
  (a1 = unemployment rate, a4 = share with a bachelor's degree)
PLAN: {"intent":"Unemployment rate set alongside educational attainment, by county",
 "output_type":"chart","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a1","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a4","inputs":[]},
          {"id":"s3","op":"join","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` }],

  compile(step, ctx) {
    return `${ctx.name} AS (SELECT a.fips, a.value AS value, b.value AS value_b ` +
           `FROM ${ctx.ins[0]} a JOIN ${ctx.ins[1]} b USING (fips))`;
  },
};
