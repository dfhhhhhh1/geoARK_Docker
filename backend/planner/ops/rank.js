/** Order a series and take the top or bottom n. */
module.exports = {
  name: "rank",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",

  enumComment: "order and take the top/bottom n",
  promptLine: `  rank         1 input, direction and limit        -> top or bottom n`,
  choiceLine: `  "top N", "highest", "lowest", "bottom N"                 -> rank`,

  offered: () => true,

  examples: [{ text:
`QUESTION: the 10 counties with the highest median household income
  (a2 = median household income)
PLAN: {"intent":"The ten counties ranked highest on median household income",
 "output_type":"table","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"rank","attr_id":"","inputs":["s1"],"direction":"desc","limit":10},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  compile(step, ctx) {
    const dir = step.direction === "asc" ? "ASC" : "DESC";
    const limit = Number.isInteger(step.limit) && step.limit > 0
      ? Math.min(step.limit, 1000) : 20;
    return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} ` +
           `WHERE value IS NOT NULL ORDER BY value ${dir} LIMIT ${ctx.bind(limit)})`;
  },
};
