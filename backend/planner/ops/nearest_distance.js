/** A bridge like count_features, but producing a distance rather than a count. */
module.exports = {
  name: "nearest_distance",
  inputs: 0,
  needs: ["attr_id"],
  produces: "series",
  kind: "sql",

  grounds: [{ field: "attr_id", sourceKind: "feature" }],
  acceptsAttributeFilters: false,

  enumComment: "miles from each county to the nearest feature",
  promptLine: `  nearest_distance needs attr_id                 -> miles from each county to
                 the nearest such feature`,
  choiceLine: `  "how far to the nearest X", "distance to X"              -> nearest_distance`,

  offered: (ctx) => ctx.hasFeatureTables,

  examples: [{ text:
`QUESTION: how far is each county from the nearest hospital
  (a4 = a hospitals dataset)
PLAN: {"intent":"Distance in miles from each county to its nearest hospital",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"nearest_distance","attr_id":"a4","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` }],

  compile(step, ctx) {
    // Miles from each county's centroid to the nearest feature. The <->
    // operator is an index-assisted KNN scan, so this is one indexed lookup per
    // county rather than a cross join: 187ms for all 3,233 counties.
    const target = ctx.featureSource(step.attr_id);
    return `${ctx.name} AS (SELECT c.fips, (` +
           `SELECT ST_Distance(ST_Centroid(c.geom)::geography, f.${target.geom}::geography) / 1609.344 ` +
           `FROM ${target.table} f ORDER BY f.${target.geom} <-> ST_Centroid(c.geom) LIMIT 1` +
           `) AS value FROM county_geom c)`;
  },
};
