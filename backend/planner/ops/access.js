const { CompileError, expandBox } = require("./_sql");

/**
 * Two-step floating catchment area (2SFCA) accessibility (docs/RESEARCH_PLAN.md
 * Phase F): supply from a feature layer, demand from a population series, a
 * catchment radius in miles.
 *
 *   step 1  each facility's ratio = 1 / (population within `miles` of it)
 *   step 2  each county's access = sum of the ratios of the facilities within
 *           `miles` of it, per 100,000 people
 *
 * So a county near several hospitals that each serve few people scores high,
 * and one near a single hospital shared with a city scores low. Distance is
 * Euclidean (geodesic) between county centroids and facilities; road travel
 * time is H5's (GIS_OPS_PLAN.md).
 *
 * One pass over (county, facility) pairs: each county centroid probes the
 * facility layer's GIST index for the facilities in its circle, and both
 * steps aggregate those pairs. The pairs are the same both ways, so step 1's
 * "population within miles of the facility" is the sum over the counties
 * paired with it. A facility is identified by its row (ctid), stable inside
 * the statement's snapshot.
 *
 * Demand is the input series as given. Catchments cross state lines, so a
 * plan that restricted the population to a state BEFORE access would
 * undercount demand at its borders; rewire.js areaAfterAccess moves such a
 * restriction to after the op.
 */

// Access that accounts for the people a facility serves: a 2SFCA question.
// Also read by the server, which adds a total-population sub-query for it.
const ACCESS = /\baccess(?:ibility)?\b/i;
const SHARED_SUPPLY =
  /\b(catchments?|2sfca|floating|serve[sd]?|demand|share[sd]?\s+(?:by|among|between)|account(?:ing)?\s+for\s+how\s+many)\b/i;
function asksAccess(query) {
  const q = String(query || "");
  return ACCESS.test(q) && SHARED_SUPPLY.test(q);
}

module.exports = {
  asksAccess,
  name: "access",
  inputs: 1,
  needs: ["attr_id", "miles"],
  produces: "series",
  kind: "sql",
  valueLabel: "facilities per 100,000 people within reach (2SFCA)",

  grounds: [{ field: "attr_id", sourceKind: "feature" }],
  acceptsAttributeFilters: false,

  enumComment: "2SFCA access: facilities within N miles, shared by the people they serve",
  promptLine: `  access       needs attr_id (facilities), miles, 1 input (population)
                 -> each county's access to those facilities per 100,000 people,
                 counting how many people each facility within reach must serve`,
  choiceLine: `  "access to X accounting for how many people it serves", "catchment" -> access`,

  offered: (ctx) => ctx.hasFeatureTables === true && asksAccess(ctx.query),

  examples: [{ text:
`QUESTION: access to pharmacies in Ohio, given how many people each pharmacy serves within 10 miles
  (a5 = a pharmacies dataset, a2 = total population)
PLAN: {"intent":"Pharmacy access per 100,000 people within a 10-mile catchment, Ohio counties",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"access","attr_id":"a5","inputs":["s1"],"miles":10},
          {"id":"s3","op":"filter_area","attr_id":"","inputs":["s2"],"states":["Ohio"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}
  NOTE: restrict the area AFTER access: people across the state line use the
  same pharmacies.` }],

  validate(step) {
    if (!(Number(step.miles) > 0)) {
      return [`step "${step.id}" (access): "miles" must be a positive catchment radius, got ${JSON.stringify(step.miles)}`];
    }
    return [];
  },

  compile(step, ctx) {
    if (ctx.level && ctx.level !== "county") {
      throw new CompileError("access is available for counties only");
    }
    const fac = ctx.featureSource(step.attr_id);
    const meters = ctx.bind(Number(step.miles) * 1609.344);
    const g = `f.${fac.geom}`;
    return `${ctx.name} AS (WITH c AS (SELECT d.fips, d.value AS pop, ST_Centroid(cg.geom) AS pt ` +
           `FROM ${ctx.ins[0]} d JOIN county_geom cg USING (fips) WHERE d.value > 0), ` +
           `p AS (SELECT c.fips, c.pop, h.id FROM c CROSS JOIN LATERAL (SELECT f.ctid AS id FROM ${fac.table} f ` +
           `WHERE ${g} && ${expandBox("c.pt", `${meters}::float8`)} ` +
           `AND ST_DWithin(${g}::geography, c.pt::geography, ${meters})) h), ` +
           `r AS (SELECT id, 1.0 / NULLIF(sum(pop), 0) AS ratio FROM p GROUP BY id) ` +
           `SELECT c.fips, COALESCE(sum(r.ratio), 0) * 100000 AS value FROM c ` +
           `LEFT JOIN p ON p.fips = c.fips LEFT JOIN r ON r.id = p.id GROUP BY c.fips)`;
  },
};
