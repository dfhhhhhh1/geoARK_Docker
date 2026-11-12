const { CompileError } = require("./_sql");

/**
 * "X within N miles of Y", counted per county. Needs TWO feature datasets, so
 * with a single facility layer on offer the op is unusable by construction.
 */
module.exports = {
  name: "count_near",
  inputs: 0,
  needs: ["attr_id", "near_attr_id", "miles"],
  produces: "series",
  kind: "sql",

  // near_attr_id names a real dataset the SQL reads from, so it is exactly as
  // much a grounding boundary as attr_id. Leaving it out would let a proximity
  // step cite a dataset that was never retrieved.
  grounds: [
    { field: "attr_id", sourceKind: "feature" },
    { field: "near_attr_id", sourceKind: "feature",
      message: "is a per-county value series, not a mappable dataset. Proximity " +
               "needs two datasets that have locations on the map." },
  ],
  // Deliberately does NOT accept attribute_filters: it involves two layers, and
  // "which one does this filter apply to" has no obvious answer.
  acceptsAttributeFilters: false,

  enumComment: "count features within N miles of another dataset",
  promptLine: `  count_near   needs attr_id, near_attr_id, miles  -> features of the first within
                 that many miles of the second, per county`,
  choiceLine: `  "X within N miles of Y", "X near Y", "close to"          -> count_near`,

  offered: (ctx) => ctx.featureTableCount >= 2,

  examples: [{ text:
`QUESTION: hospitals within 10 miles of transmission lines
  (a4 = a hospitals dataset, a6 = an electric transmission lines dataset)
PLAN: {"intent":"Hospitals within ten miles of a transmission line, per county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_near","attr_id":"a4","near_attr_id":"a6","miles":10,"inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` }],

  compile(step, ctx) {
    // The distance test runs on geography so "miles" means miles, but a
    // geography cast cannot use the GIST index built on the geometry column,
    // and the reference layers are large (transmission lines is 89,744 rows).
    // The && bounding-box prefilter IS index-assisted and cheap, and it is a
    // strict superset of the geography answer, so the exact ST_DWithin only
    // ever runs on survivors. Measured: 1.2s for hospitals-near-transmission-
    // lines nationally; without the prefilter the same query is a seq scan.
    //
    // ST_Expand takes degrees, and the conversion is per axis. CORRECTION
    // (2026-11-11): this used to be one radius / 111320 for both axes, with a
    // comment claiming it "over-expands away from the equator". That is
    // backwards for longitude: a degree of longitude is ~111.32 km * cos(lat),
    // so the box was too NARROW east-west and silently dropped real neighbours
    // (hospitals within 3 mi of a fire station, nationally: 7,491 vs 7,517).
    // Latitude was short too: a meridian degree is 110,574 m at the equator.
    //   dy: radius / 110574, the shortest degree of latitude anywhere.
    //   dx: dy / cos(lat) at the feature's poleward edge plus dy, where the
    //       circle's degree of longitude is shortest; clamped below the pole.
    // Same form as nearest_distance. Not handled: a neighbour across the
    // antimeridian (the Aleutians), which the old form missed too.
    const subject = ctx.featureSource(step.attr_id);
    const near = ctx.featureSource(step.near_attr_id, "near_attr_id");
    const miles = Number(step.miles);
    if (!Number.isFinite(miles) || miles <= 0) {
      throw new CompileError(`count_near needs a positive "miles", got ${step.miles}`);
    }
    const meters = miles * 1609.344;
    const fg = `f.${subject.geom}`;
    const dy = `${ctx.bind(meters / 110574)}::float8`;
    const poleward = `least(greatest(abs(ST_YMin(${fg})), abs(ST_YMax(${fg}))) + ${dy}, 89.9)`;
    const dx = `${dy} / cos(radians(${poleward}))`;

    const exists = `EXISTS (SELECT 1 FROM ${near.table} n ` +
           `WHERE n.${near.geom} && ST_Expand(${fg}, ${dx}, ${dy}) ` +
           `AND ST_DWithin(f.${subject.geom}::geography, n.${near.geom}::geography, ${ctx.bind(meters)}))`;

    // Below the county (Phase E): the same count per unit of geo_unit. A
    // LATERAL probe, not the county form's plain LEFT JOIN: Postgres estimates
    // the EXISTS-filtered features at 1 row (7,517 in fact), materializes them
    // and tests every unit against every feature with no index, 643M
    // ST_Intersects and 95 s for tracts. The LATERAL makes each unit an index
    // probe of the feature layer whatever the estimate: 1.5 s for all 85,529
    // tracts, equal to brute force on every tract in AK, MT, MO and CA, and
    // the tract total equals the county total (7,517 hospitals within 3 mi of
    // a fire station). The county form keeps its SQL: 222 ms already.
    if (ctx.level && ctx.level !== "county") {
      return `${ctx.name} AS (SELECT c.geoid AS fips, COUNT(x.one)::double precision AS value ` +
             `FROM geo_unit c LEFT JOIN LATERAL (SELECT 1 AS one FROM ${subject.table} f ` +
             `WHERE ${fg} && c.geom AND ST_Intersects(c.geom, ${fg}) AND ${exists}) x ON true ` +
             `WHERE c.level = ${ctx.bind(ctx.level)} GROUP BY c.geoid)`;
    }

    // LEFT JOIN with the proximity test in the ON clause, not WHERE: a county
    // with no qualifying feature must yield 0, and a WHERE would delete the row.
    return `${ctx.name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
           `FROM county_geom c LEFT JOIN ${subject.table} f ` +
           `ON ST_Intersects(c.geom, f.${subject.geom}) ` +
           `AND ${exists} ` +
           `GROUP BY c.fips)`;
  },
};
