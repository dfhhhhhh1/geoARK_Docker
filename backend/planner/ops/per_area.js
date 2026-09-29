/** Value per square mile of county LAND area. */
module.exports = {
  name: "per_area",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",

  enumComment: "value per square mile of county land area",
  promptLine: `  per_area     1 input                             -> value per square mile of land`,
  choiceLine: `  "per square mile", "density of", "how concentrated"      -> per_area`,

  offered: () => true,

  // Deliberately does NOT chain filter_area: that op is only offered when the
  // question names a place, and an example may never demonstrate an op the
  // decoding schema has dropped.
  examples: [{ text:
`QUESTION: population density per square mile
  (a8 = total population)
PLAN: {"intent":"Population per square mile of land in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s2","op":"per_area","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  compile(step, ctx) {
    // aland is square metres; awater is deliberately excluded, because dividing
    // by total area makes coastal and Great Lakes counties look artificially
    // sparse.
    return `${ctx.name} AS (SELECT r.fips, ` +
           `r.value / NULLIF(g.aland, 0) * 2589988.110336 AS value ` +
           `FROM ${ctx.ins[0]} r JOIN county_geom g USING (fips))`;
  },
};
