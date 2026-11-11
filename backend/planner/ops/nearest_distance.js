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
    // Miles from each county's centroid to the nearest feature, exactly.
    //
    // <-> alone is NOT the nearest: it orders by planar distance in DEGREES,
    // and a degree of longitude shrinks with cos(latitude). Taking its first
    // row was wrong for 222 of 3,233 counties nationally (worst +39.7%; Denali
    // AK 148 mi for 105.6), caught by research.yaml r-hospital-distance-mo.
    // A fixed K is not a fix either: K=10 still missed Denali.
    //
    // So two index-assisted steps: <-> gives a feature, whose geodesic
    // distance d0 bounds the true minimum; then the minimum over every feature
    // in the box that holds a d0 circle (longitude widened by 1/cos of the
    // circle's poleward edge). Same result as brute force on AK/MO/MT/HI and
    // as K=200 nationally, 181 ms for all counties (was 187 ms). Keep the &&:
    // without it this is a cross join. Not handled: a nearest feature across
    // the antimeridian (the Aleutians), which the old form missed too.
    const target = ctx.featureSource(step.attr_id);
    const g = `f.${target.geom}`;
    return `${ctx.name} AS (SELECT c.fips, (` +
           `SELECT min(ST_Distance(k.pt::geography, ${g}::geography)) FROM ${target.table} f ` +
           `WHERE ${g} && ST_Expand(k.pt, k.d0 * 1.01 / ` +
           `(110574 * cos(radians(least(abs(ST_Y(k.pt)) + k.d0 / 110574, 89.9)))))` +
           `) / 1609.344 AS value FROM county_geom c ` +
           `LEFT JOIN LATERAL (SELECT ST_Centroid(c.geom) AS pt) p ON true ` +
           `LEFT JOIN LATERAL (SELECT p.pt, ST_Distance(p.pt::geography, ${g}::geography) AS d0 ` +
           `FROM ${target.table} f ORDER BY ${g} <-> p.pt LIMIT 1) k ON true)`;
  },
};
