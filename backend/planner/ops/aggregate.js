const { AGGREGATES, CompileError } = require("./_sql");

/** Collapse a series to one number, or one per state. */
module.exports = {
  name: "aggregate",
  inputs: 1,
  needs: ["function"],
  produces: "series",
  kind: "sql",

  enumComment: "mean | sum | count | min | max, optional group_by",
  promptLine: `  aggregate    needs function, 1 input             -> mean/sum/count/min/max`,
  choiceLine: `  "average", "total across all", a single overall number   -> aggregate`,

  offered: () => true,

  examples: [{ text:
`QUESTION: the average median household income across all counties
  (a2 = median household income)
PLAN: {"intent":"Average of median household income over all counties",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"aggregate","attr_id":"","inputs":["s1"],"function":"mean"},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  compile(step, ctx) {
    const fn = AGGREGATES[step.function];
    if (!fn) throw new CompileError(`unsupported aggregate ${step.function}`);
    if (step.group_by === "state") {
      // Group by state FIPS, the first two digits of the county code.
      return `${ctx.name} AS (SELECT LEFT(fips, 2) AS fips, ${fn}(value) AS value ` +
             `FROM ${ctx.ins[0]} GROUP BY LEFT(fips, 2))`;
    }
    return `${ctx.name} AS (SELECT NULL::char(5) AS fips, ${fn}(value) AS value FROM ${ctx.ins[0]})`;
  },
};
