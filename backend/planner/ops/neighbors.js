const { CompileError } = require("./_sql");

/**
 * Each county against the average of its neighbours: the spatial lag
 * (docs/RESEARCH_PLAN.md Phase F). "Which counties have a much higher
 * unemployment rate than the average of their neighboring counties?" is
 * value minus mean(neighbours' values), or their ratio.
 *
 * Pure SQL over county_neighbors (contiguity by ST_Intersects, CLAUDE.md
 * "Spatial statistics without PySAL"), the same weights hotspot uses, so the
 * two agree about who a neighbour is. Neighbours are the counties of the
 * INPUT: a plan that restricted the input to a state compares each county
 * with its in-state neighbours only, which is what that plan asked.
 *
 * Gated on neighbour phrasing and on adjacency being loaded, like hotspot.
 */
const OPS = {
  difference: (u, n) => `${u} - ${n}`,
  ratio: (u, n) => `${u} / NULLIF(${n}, 0)`,
};

module.exports = {
  name: "neighbors",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",
  diverging: true,
  valueLabel: "difference from the average of neighbouring counties",

  enumComment: "each county minus the average of its neighbouring counties",
  promptLine: `  neighbors    1 input, optional operation         -> each county's value minus
                 the average of its neighbouring counties ("ratio" divides instead)`,
  choiceLine: `  "than its neighbors", "compared with surrounding counties" -> neighbors`,

  offered: (ctx) => ctx.hasNeighbors === true &&
    /\b(neighbou?r(s|ing)?|adjacent|surrounding\s+counties|bordering\s+counties|nearby\s+counties)\b/i.test(String(ctx.query || "")),

  examples: [{ text:
`QUESTION: counties whose median home value is far above the counties around them
  (a6 = median home value)
PLAN: {"intent":"Median home value minus the average of neighbouring counties, highest first",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a6","inputs":[]},
          {"id":"s2","op":"neighbors","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"rank","attr_id":"","inputs":["s2"],"direction":"desc","limit":20},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` }],

  validate(step) {
    if (step.operation && !OPS[step.operation]) {
      return [`step "${step.id}" (neighbors): operation must be "difference" or "ratio", got ${JSON.stringify(step.operation)}`];
    }
    return [];
  },

  compile(step, ctx) {
    if (ctx.level && ctx.level !== "county") {
      throw new CompileError("neighbors is available for counties only (county_neighbors)");
    }
    const f = OPS[step.operation || "difference"];
    const x = ctx.ins[0];
    return `${ctx.name} AS (SELECT u.fips, ${f("u.value", "avg(n.value)")} AS value ` +
           `FROM ${x} u JOIN county_neighbors cn ON cn.fips = u.fips ` +
           `JOIN ${x} n ON n.fips = cn.neighbor_fips ` +
           `WHERE u.value IS NOT NULL AND n.value IS NOT NULL GROUP BY u.fips, u.value)`;
  },
};
