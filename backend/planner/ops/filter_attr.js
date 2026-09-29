const { OPERATORS, CompileError } = require("./_sql");

/** Keep rows whose value passes a numeric comparison. */
module.exports = {
  name: "filter_attr",
  inputs: 1,
  needs: ["operator", "value"],
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

  compile(step, ctx) {
    const op = OPERATORS[step.operator];
    if (!op) throw new CompileError(`unsupported operator ${step.operator}`);
    return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} ` +
           `WHERE value ${op} ${ctx.bind(step.value)})`;
  },
};
