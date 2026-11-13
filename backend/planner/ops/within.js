const { CompileError, expandBox, FEATURE_LABELS } = require("./_sql");
const { featureAlgebra } = require("../features");

/**
 * Select by location: the features of input 1 within `miles` of any feature
 * of input 2, or with `exclude`, the ones farther away. Features in, features
 * out (docs/GIS_OPS_PLAN.md H1), so the result can be mapped, counted
 * (summarize) or ordered (rank).
 *
 * Each kept feature carries its distance in miles to the NEAREST feature of
 * input 2 as its value, which is what rank orders by. With no `miles` every
 * feature is kept with that distance ("the 10 farthest from a fire station").
 *
 * The distance is exact (geodesic), found the way nearest_distance finds it:
 *   - with a radius, the minimum over the second layer's features inside a
 *     box that holds the radius circle (per-axis degrees, _sql.expandBox);
 *   - otherwise, <-> gives a feature whose geodesic distance d0 bounds the
 *     true minimum, then the minimum over the box that holds a d0 circle.
 *     <-> alone orders by planar degrees and is wrong for ~7% of counties
 *     (CLAUDE.md, "Geospatial ops"); the second step is what makes it exact.
 * Input 2 is a select_features CTE declared NOT MATERIALIZED, so both probes
 * are index scans of its base table rather than scans of a materialized set.
 */
module.exports = {
  name: "within",
  inputs: 2,
  needs: [],
  produces: "features",
  accepts: [["features"], ["features"]],
  kind: "sql",

  enumComment: "features of input 1 within N miles of input 2 (or farther, with exclude)",
  promptLine: `  within       2 inputs (two select_features steps), optional miles and exclude
                 -> the features of input 1 within that many miles of any feature
                 of input 2; with "exclude": true, the ones FARTHER than that.
                 Each keeps its distance in miles to the nearest feature of
                 input 2 as its value. Leave miles out to keep every feature of
                 input 1 with that distance, e.g. to rank the farthest.`,
  choiceLine: `  "which X are within N miles of Y", "X more than N miles from any Y",
  "the X farthest from / closest to a Y"                     -> select_features twice, then within`,

  offered: (ctx) => featureAlgebra(ctx),

  examples: [
    { text:
`QUESTION: which schools in Georgia are within half a mile of a rail line
  (a3 = a schools dataset, a8 = a railroads dataset)
PLAN: {"intent":"Schools in Georgia within 0.5 miles of a railroad",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a3","inputs":[],"states":["Georgia"]},
          {"id":"s2","op":"select_features","attr_id":"a8","inputs":[]},
          {"id":"s3","op":"within","attr_id":"","inputs":["s1","s2"],"miles":0.5},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}
  NOTE: the place restriction goes on the features the question is about
  (s1). The second layer is left national, so a rail line just across the
  state line still counts.` },
    { text:
`QUESTION: the 5 police stations in Nevada farthest from a hospital
  (a6 = a police stations dataset, a2 = a hospitals dataset)
PLAN: {"intent":"The five Nevada police stations with the longest distance to a hospital",
 "output_type":"table","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a6","inputs":[],"states":["Nevada"]},
          {"id":"s2","op":"select_features","attr_id":"a2","inputs":[]},
          {"id":"s3","op":"within","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"rank","attr_id":"","inputs":["s3"],"direction":"desc","limit":5},
          {"id":"s5","op":"output","attr_id":"","inputs":["s4"]}]}` },
  ],

  validate(step) {
    const errs = [];
    if (step.miles !== undefined && step.miles !== null &&
        !(Number.isFinite(Number(step.miles)) && Number(step.miles) > 0)) {
      errs.push(`step "${step.id}" (within): "miles" must be a positive number, got ${JSON.stringify(step.miles)}`);
    }
    if (step.exclude === true && (step.miles === undefined || step.miles === null)) {
      errs.push(`step "${step.id}" (within): "exclude" needs "miles": farther than how far?`);
    }
    return errs;
  },

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    const g = "a.geom";
    const dist = `ST_Distance(${g}::geography, b.geom::geography)`;
    const keep = FEATURE_LABELS.map(c => `a.${c}`).join(", ");
    const hasMiles = step.miles !== undefined && step.miles !== null;
    if (hasMiles && !step.exclude) {
      const miles = Number(step.miles);
      if (!(miles > 0)) throw new CompileError(`within needs a positive "miles", got ${step.miles}`);
      const meters = ctx.bind(miles * 1609.344);
      return `${ctx.name} AS (SELECT a.geom, d.m / 1609.344 AS value, ${keep} FROM ${a} a ` +
             `CROSS JOIN LATERAL (SELECT min(${dist}) AS m FROM ${b} b ` +
             `WHERE b.geom && ${expandBox(g, `${meters}::float8`)} ` +
             `AND ST_DWithin(${g}::geography, b.geom::geography, ${meters})) d ` +
             `WHERE d.m IS NOT NULL)`;
    }
    // Exact nearest, in two index-assisted steps (see the header).
    const nearest =
      `LEFT JOIN LATERAL (SELECT ${dist} AS d0 FROM ${b} b ORDER BY b.geom <-> ${g} LIMIT 1) k ON true ` +
      `LEFT JOIN LATERAL (SELECT min(${dist}) AS m FROM ${b} b ` +
      `WHERE b.geom && ${expandBox(g, "k.d0 * 1.01")}) d ON true`;
    const where = step.exclude
      ? ` WHERE d.m IS NULL OR d.m > ${ctx.bind(Number(step.miles) * 1609.344)}`
      : "";
    return `${ctx.name} AS (SELECT a.geom, d.m / 1609.344 AS value, ${keep} FROM ${a} a ${nearest}${where})`;
  },

  valueLabel: "miles to the nearest feature of the second layer",
};
