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
    // ST_Expand takes degrees, so the radius is converted at the equator
    // (111.32 km/deg). That over-expands away from the equator, which is the
    // safe direction for a prefilter -- it can only admit extra candidates,
    // never discard real ones.
    const subject = ctx.featureSource(step.attr_id);
    const near = ctx.featureSource(step.near_attr_id, "near_attr_id");
    const miles = Number(step.miles);
    if (!Number.isFinite(miles) || miles <= 0) {
      throw new CompileError(`count_near needs a positive "miles", got ${step.miles}`);
    }
    const meters = miles * 1609.344;
    const degrees = meters / 111320;

    // LEFT JOIN with the proximity test in the ON clause, not WHERE: a county
    // with no qualifying feature must yield 0, and a WHERE would delete the row.
    return `${ctx.name} AS (SELECT c.fips, COUNT(f.*)::double precision AS value ` +
           `FROM county_geom c LEFT JOIN ${subject.table} f ` +
           `ON ST_Intersects(c.geom, f.${subject.geom}) ` +
           `AND EXISTS (SELECT 1 FROM ${near.table} n ` +
           `WHERE n.${near.geom} && ST_Expand(f.${subject.geom}, ${ctx.bind(degrees)}) ` +
           `AND ST_DWithin(f.${subject.geom}::geography, n.${near.geom}::geography, ${ctx.bind(meters)})) ` +
           `GROUP BY c.fips)`;
  },
};
