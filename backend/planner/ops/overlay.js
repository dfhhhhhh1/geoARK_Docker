const { CompileError, FEATURE_LABELS } = require("./_sql");
const { overlayAlgebra, UNIT_PER_M } = require("../features");

/**
 * Select by location and intersect, with no distance (docs/GIS_OPS_PLAN.md
 * H3): the features of input 1 that intersect any feature of input 2, or with
 * `exclude`, the ones that intersect none. Features in, features out, so the
 * result maps, counts (summarize), totals (summarize with a measure) or ranks.
 *
 * GENERAL ON PURPOSE. Nothing here knows about floods, wetlands or fires.
 * Input 2 is any polygon layer (a hazard zone, a wetland, a perimeter, a
 * field, an uploaded district), restricted the usual way: states, and its own
 * `type` values through attribute_filters or a cited definition.
 *
 * Each kept feature's value is the amount of it INSIDE input 2: length for a
 * line, area for a polygon, in the unit the question asked (set in code by
 * features.applyMeasures; default miles / square miles), NULL for a point.
 * Overlapping polygons of input 2 are unioned first, so a road through two
 * overlapping fire perimeters is not counted twice. `clip` (set in code when
 * a total of that amount is asked for) hands on the clipped part as the
 * geometry, so a summarize per county measures only what is inside; without
 * it the whole feature is kept, which is what "which roads cross" means.
 *
 * Invalid polygons (81 of 1,670 wildfire perimeters) are made valid on the
 * fly: ST_Intersection raises on a self-intersecting ring, and an uploaded
 * layer can hold anything.
 */
const valid = (g) => `CASE WHEN ST_IsValid(${g}) THEN ${g} ELSE ST_MakeValid(${g}) END`;

module.exports = {
  name: "overlay",
  inputs: 2,
  needs: [],
  produces: "features",
  accepts: [["features"], ["features"]],
  kind: "sql",

  enumComment: "features of input 1 that intersect (or with exclude, avoid) input 2's polygons",
  promptLine: `  overlay      2 inputs (two select_features steps), optional exclude
                 -> the features of input 1 that are inside, cross or overlap
                 any feature of input 2 (an area layer); with "exclude": true,
                 the ones that touch none. Each keeps the amount of it inside
                 input 2 as its value (length of a line, area of a polygon).
                 Use it when no distance is given; with a distance, use within.`,
  choiceLine: `  "X inside / crossing / overlapping Y", "X that fall in Y"   -> select_features twice, then overlay`,

  offered: (ctx) => overlayAlgebra(ctx),

  examples: [
    { text:
`QUESTION: which schools in Louisiana are inside a hurricane evacuation zone
  (a2 = a schools dataset, a5 = an evacuation zones dataset)
PLAN: {"intent":"Louisiana schools located inside an evacuation zone",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a2","inputs":[],"states":["Louisiana"]},
          {"id":"s2","op":"select_features","attr_id":"a5","inputs":[]},
          {"id":"s3","op":"overlay","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}
  NOTE: input 1 is what the question asks about; input 2 is the area layer
  it is tested against.` },
  ],

  validate(step) {
    const errs = [];
    if (step.miles !== undefined && step.miles !== null) {
      errs.push(`step "${step.id}" (overlay): overlay takes no distance; for "within N miles of" use within`);
    }
    if (step.unit !== undefined && !(step.unit in UNIT_PER_M)) {
      errs.push(`step "${step.id}" (overlay): unknown unit ${JSON.stringify(step.unit)}`);
    }
    return errs;
  },

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    const keep = FEATURE_LABELS.map(c => `a.${c}`).join(", ");
    const probe = `b.geom && a.geom AND ST_Intersects(a.geom, b.geom)`;
    if (step.exclude === true) {
      // A LATERAL probe with LIMIT 1, not NOT EXISTS: Postgres turns NOT
      // EXISTS into an anti-join that does not push a's box into a parts
      // UNION ALL, and "Missouri campuses that do not overlap any wetland"
      // seq-scanned 2.4M rows into the 30 s timeout (H3 held-out, 2026-11-12).
      return `${ctx.name} AS (SELECT a.geom, NULL::double precision AS value, ${keep} FROM ${a} a ` +
             `LEFT JOIN LATERAL (SELECT 1 AS hit FROM ${b} b WHERE ${probe} LIMIT 1) k ON true ` +
             `WHERE k.hit IS NULL)`;
    }
    const unit = step.unit;
    if (unit !== undefined && !(unit in UNIT_PER_M)) throw new CompileError(`overlay: unknown unit ${unit}`);
    const isArea = unit && /square|acres|hectares/.test(unit);
    const lenPer = ctx.bind(unit && !isArea ? UNIT_PER_M[unit] : UNIT_PER_M.miles);
    const areaPer = ctx.bind(isArea ? UNIT_PER_M[unit] : UNIT_PER_M["square miles"]);
    // The part of a inside the union of the b's it touches, same dimension as
    // a (a polygon pair touching along an edge yields a line; that is not area).
    const part =
      `CASE WHEN ST_Dimension(a.geom) = 0 THEN a.geom ELSE ` +
      `ST_CollectionExtract(ST_Intersection(${valid("a.geom")}, k.g), ST_Dimension(a.geom) + 1) END`;
    const value =
      `CASE ST_Dimension(a.geom) WHEN 1 THEN ST_Length(p.part::geography) / ${lenPer}::float8 ` +
      `WHEN 2 THEN ST_Area(p.part::geography) / ${areaPer}::float8 END`;
    return `${ctx.name} AS (SELECT ${step.clip === true ? "p.part" : "a.geom"} AS geom, ${value} AS value, ${keep} ` +
           `FROM ${a} a ` +
           `CROSS JOIN LATERAL (SELECT ST_Union(${valid("b.geom")}) AS g FROM ${b} b WHERE ${probe}) k ` +
           `CROSS JOIN LATERAL (SELECT ${part} AS part) p ` +
           `WHERE k.g IS NOT NULL AND NOT ST_IsEmpty(p.part))`;
  },

  valueLabel: "amount inside the second layer",
};
