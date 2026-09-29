/** Numerator divided by denominator, optionally scaled. */
module.exports = {
  name: "normalize",
  inputs: 2,
  needs: [],
  produces: "series",
  kind: "sql",

  enumComment: "numerator / denominator * scale",
  promptLine: `  normalize    2 inputs (numerator, denominator)   -> ratio, optional scale`,
  choiceLine: `  "rate", "per capita", "percentage of", "normalized by"   -> normalize`,

  offered: () => true,

  examples: [{ text:
`QUESTION: poverty rate per capita by county
  (a3 = a poverty count, a8 = total population)
PLAN: {"intent":"Poverty count divided by total population, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s3","op":"normalize","attr_id":"","inputs":["s1","s2"],"scale":100},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` }],

  compile(step, ctx) {
    // NULLIF guards division by zero, which is common: many ACS denominators
    // are legitimately 0 for small counties.
    const scale = step.scale ?? 1;
    return `${ctx.name} AS (SELECT n.fips, n.value / NULLIF(d.value, 0) * ${ctx.bind(scale)} AS value ` +
           `FROM ${ctx.ins[0]} n JOIN ${ctx.ins[1]} d USING (fips))`;
  },
};
