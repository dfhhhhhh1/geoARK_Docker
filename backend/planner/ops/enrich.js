const { FEATURE_LABELS } = require("./_sql");
const { enrichAlgebra } = require("../features");

/**
 * Spatial join, units -> features (docs/GIS_OPS_PLAN.md H6 tier 1): each
 * feature of input 1 takes the value of input 2 at the unit it lies in, the
 * county, or the tract / ZIP area / zone when the question names one
 * (planner/levels.js sets the level; the model never does). Features in,
 * features out, so the result maps, counts (summarize), filters or ranks:
 * "hospitals in census tracts where poverty is above 30 percent", "the
 * poverty rate of the tract each school is in".
 *
 * Only features whose unit is IN input 2 are kept. That is what makes a
 * condition on the units compose: load -> filter_attr -> enrich keeps the
 * features inside the units that passed, and a percentile ("high-poverty
 * tracts") is then a percentile of the units, not of the features. A feature
 * whose unit has no value is dropped for the same reason; `features.
 * repairEnrichPercentile` moves a percentile filter the model put after
 * enrich to before it.
 *
 * Which unit: the one holding the feature's ST_PointOnSurface (the point
 * itself for a point). A point on a boundary goes to the lowest geoid, so
 * each feature is one row. The lookup is a LATERAL index probe of the unit
 * polygons per feature; the series is then joined by key.
 */
module.exports = {
  name: "enrich",
  inputs: 2,
  needs: [],
  produces: "features",
  accepts: [["features"], ["series"]],
  kind: "sql",

  enumComment: "features of input 1, each with the value of input 2 at the county (or unit) it lies in",
  promptLine: `  enrich       2 inputs (a select_features step, then per-county values)
                 -> the features of input 1 that lie in a county still in
                 input 2, each carrying that county's value. Put a condition
                 on the counties (filter_attr) BEFORE enrich, on input 2.`,
  choiceLine: `  "X in counties where ...", "X in high-poverty areas",
  "the income of the county each X is in"                   -> select_features, load, then enrich`,

  offered: (ctx) => enrichAlgebra(ctx),

  examples: [{ text:
`QUESTION: which nursing homes in Florida are in counties where median household income is below 50000
  (a3 = a nursing homes dataset, a6 = median household income)
PLAN: {"intent":"Florida nursing homes located in counties with median household income under 50000",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a3","inputs":[],"states":["Florida"]},
          {"id":"s2","op":"load","attr_id":"a6","inputs":[]},
          {"id":"s3","op":"filter_attr","attr_id":"","inputs":["s2"],"operator":"<","value":50000},
          {"id":"s4","op":"enrich","attr_id":"","inputs":["s1","s3"]},
          {"id":"s5","op":"output","attr_id":"","inputs":["s4"]}]}
  NOTE: the condition is on the counties (s3), so it comes before enrich.
  Without s3, enrich gives every nursing home its county's income.` }],

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    const level = ctx.level && ctx.level !== "county" ? ctx.level : null;
    const units = level
      ? `(SELECT geoid AS fips, geom FROM geo_unit WHERE level = ${ctx.bind(level)})`
      : `county_geom`;
    const keep = FEATURE_LABELS.map(c => `a.${c}`).join(", ");
    const p = "ST_PointOnSurface(a.geom)";
    return `${ctx.name} AS (SELECT a.geom, s.value, ${keep} FROM ${a} a ` +
           `CROSS JOIN LATERAL (SELECT u.fips FROM ${units} u ` +
           `WHERE u.geom && ${p} AND ST_Intersects(u.geom, ${p}) ORDER BY u.fips LIMIT 1) k ` +
           `JOIN ${b} s ON s.fips = k.fips WHERE s.value IS NOT NULL)`;
  },
};
