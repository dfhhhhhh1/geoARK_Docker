const { nearestFieldErrors } = require("../nearest");

/**
 * A bridge like count_features, but producing a distance rather than a count.
 *
 * Two field variants, set by code from the question (planner/nearest.js),
 * never offered to the model: `identify` (each unit also carries the nearest
 * feature's name, `nearest_name`) and `k` with `k_stat` (the mean, or the
 * k-th, of the k nearest distances, the k names nearest first). Without them
 * the SQL is exactly what it was, so every number measured with it stands.
 */
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
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },
    // People at a distance (planner/catchment.js), shown only for that
    // phrasing: the population is kept where the distance passes, then summed.
    // Code then counts it by census tract rather than by county centroid.
    { when: (ctx) => require("../catchment").asksPeopleAtDistance(ctx.query), text:
`QUESTION: how many people in Utah live within 10 miles of an airport
  (a2 = total population, a5 = an airports dataset)
PLAN: {"intent":"Number of people in Utah living within ten miles of an airport",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Utah"]},
          {"id":"s3","op":"nearest_distance","attr_id":"a5","inputs":[]},
          {"id":"s4","op":"filter_attr","attr_id":"","inputs":["s3"],"operator":"<=","value":10},
          {"id":"s5","op":"intersect","attr_id":"","inputs":["s2","s4"]},
          {"id":"s6","op":"aggregate","attr_id":"","inputs":["s5"],"function":"sum"},
          {"id":"s7","op":"output","attr_id":"","inputs":["s6"]}]}
  NOTE: people, not places. Keep the population where the distance passes,
  then add it up. "More than N miles from" is ">" on the distance.` }],

  validate(step) {
    return nearestFieldErrors(step);
  },

  // nearest_name, only when a variant asked for it. compile.js also carries
  // it past row-subset ops (filters, rank) to the output.
  rowColumns: (step) => (step && (step.identify === true || Number(step.k) > 1) ? ["nearest_name"] : []),

  compile(step, ctx) {
    if (step.identify === true || Number(step.k) > 1) return compileNearestK(step, ctx);
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
    // Below the county (Phase E): the same two steps from each unit's `pt`,
    // a stored point that is always inside the unit (checked: 0 of 1,064,152
    // outside, every level). ST_Centroid stays for counties so their SQL, and
    // every number measured with it, is unchanged.
    if (ctx.level && ctx.level !== "county") {
      return `${ctx.name} AS (SELECT u.geoid AS fips, (` +
             `SELECT min(ST_Distance(k.pt::geography, ${g}::geography)) FROM ${target.table} f ` +
             `WHERE ${g} && ST_Expand(k.pt, k.d0 * 1.01 / ` +
             `(110574 * cos(radians(least(abs(ST_Y(k.pt)) + k.d0 / 110574, 89.9)))))` +
             `) / 1609.344 AS value FROM geo_unit u ` +
             `LEFT JOIN LATERAL (SELECT u.pt, ST_Distance(u.pt::geography, ${g}::geography) AS d0 ` +
             `FROM ${target.table} f ORDER BY ${g} <-> u.pt LIMIT 1) k ON true ` +
             `WHERE u.level = ${ctx.bind(ctx.level)})`;
    }
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

/**
 * The k nearest, named. Same two index-assisted steps as the plain form, and
 * exact for the same reason: the k planar-nearest (<->) are k features each
 * within d0 = the largest of their geodesic distances, so the true k-th
 * nearest is within d0, and every feature that close is inside the box that
 * holds a d0 circle. The k nearest by geodesic distance are then taken from
 * that box, ties broken by name so the answer is deterministic.
 */
function compileNearestK(step, ctx) {
  const k = Math.max(1, Math.min(25, Number(step.k) || 1));
  const target = ctx.featureSource(step.attr_id);
  const g = `f.${target.geom}`;
  const src = ctx.resolved?.get?.(step.attr_id) || {};
  const SAFE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
  const have = new Set((src.label_columns || []).filter(c => SAFE.test(c)));
  // "MERCY HOSPITAL, SPRINGFIELD, MO": city and state tell the many
  // same-named facilities apart. Address stands in for a missing name.
  const lead = have.has("name") ? "name" : have.has("address") ? "address" : null;
  const parts = lead ? [lead, ...["city", "state"].filter(c => have.has(c))] : [];
  const label = parts.length ? `concat_ws(', ', ${parts.map(c => `NULLIF(f.${c}::text, '')`).join(", ")})` : "NULL::text";
  const stat = step.k_stat === "kth" ? "max(q.d)" : "avg(q.d)";
  const kb = ctx.bind(k);
  const box = (pt) => `${g} && ST_Expand(${pt}, k.d0 * 1.01 / ` +
    `(110574 * cos(radians(least(abs(ST_Y(${pt})) + k.d0 / 110574, 89.9)))))`;
  const probes = (pt) =>
    `LEFT JOIN LATERAL (SELECT max(ST_Distance(${pt}::geography, q.g::geography)) AS d0 FROM ` +
    `(SELECT ${g} AS g FROM ${target.table} f ORDER BY ${g} <-> ${pt} LIMIT ${kb}) q) k ON true ` +
    `LEFT JOIN LATERAL (SELECT CASE WHEN count(*) >= ${kb} THEN ${stat} END / 1609.344 AS value, ` +
    `string_agg(q.lbl, '; ' ORDER BY q.d, q.lbl) AS nearest_name FROM ` +
    `(SELECT ST_Distance(${pt}::geography, ${g}::geography) AS d, ${label} AS lbl FROM ${target.table} f ` +
    `WHERE ${box(pt)} ORDER BY 1, 2 LIMIT ${kb}) q) n ON true`;
  if (ctx.level && ctx.level !== "county") {
    return `${ctx.name} AS (SELECT u.geoid AS fips, n.value, n.nearest_name FROM geo_unit u ` +
           `${probes("u.pt")} WHERE u.level = ${ctx.bind(ctx.level)})`;
  }
  return `${ctx.name} AS (SELECT c.fips, n.value, n.nearest_name FROM county_geom c ` +
         `LEFT JOIN LATERAL (SELECT ST_Centroid(c.geom) AS pt) p ON true ${probes("p.pt")})`;
}
