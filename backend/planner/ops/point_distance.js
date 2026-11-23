const { CompileError } = require("./_sql");
const { COLUMNS, STATS } = require("../point_distance");

/**
 * Distance to the nearest facility, summarised over the FINE SAMPLE POINTS
 * inside each unit (table fine_pt: 2020 block centroids + hexagon points,
 * each with a precomputed straight-line distance; backend/fine_points.js,
 * docs/POINTS_INTEGRATION_PLAN.md).
 *
 * INTERNAL: never offered to the model, so the decoding enum and the prompt
 * are unchanged. planner/point_distance.js swaps a `nearest_distance` step for
 * this one when the question asks for a distribution over the unit ("what
 * share of each county is more than 20 miles from a hospital", "the 90th
 * percentile distance", "the farthest point") and every state in the plan's
 * area has points loaded. nearest_distance measures from ONE point per unit
 * (its centroid); this reads every point in it.
 *
 *   mean   mean over points
 *   pct    percentile q (0-100) over points
 *   max    the farthest point
 *   share  percent of the unit's AREA (Thiessen-cell weighted) where the
 *          distance is > threshold (cmp ">") or <= threshold (cmp "<=")
 *
 * Counties, tracts and block groups are prefixes of the block code (exact,
 * indexed); ZIP areas and places use point-in-polygon.
 */
const PREFIX = { county: 5, tract: 11, bg: 12 };
const SPATIAL = new Set(["zcta", "place"]);

module.exports = {
  name: "point_distance",
  inputs: 0,
  needs: ["column", "stat"],
  produces: "series",
  kind: "sql",
  internal: true,
  // The facility layer the plan measured to, kept for provenance.
  // Or, swapped in for a load of a Step 1 summary, that measure.
  grounds: [{ field: "attr_id", sourceKind: "feature" }, { field: "measure_id", sourceKind: "value" }],

  offered: () => false,

  validate(step) {
    const errs = [];
    if (!COLUMNS.has(step.column)) errs.push(`step "${step.id}" (point_distance): unknown column "${step.column}"`);
    if (!STATS.has(step.stat)) errs.push(`step "${step.id}" (point_distance): stat must be ${[...STATS].join(", ")}`);
    if (step.stat === "pct" && !(Number(step.q) > 0 && Number(step.q) < 100)) {
      errs.push(`step "${step.id}" (point_distance): pct needs q between 0 and 100`);
    }
    if (step.stat === "share" && !(Number(step.threshold) > 0 && (step.cmp === ">" || step.cmp === "<="))) {
      errs.push(`step "${step.id}" (point_distance): share needs a threshold > 0 and cmp ">" or "<="`);
    }
    if (!Array.isArray(step.state_fips) || !step.state_fips.length || !step.state_fips.every(s => /^\d{2}$/.test(s))) {
      errs.push(`step "${step.id}" (point_distance): state_fips must list the plan's states`);
    }
    return errs;
  },

  compile(step, ctx) {
    if (!COLUMNS.has(step.column)) throw new CompileError(`point_distance: unknown column ${step.column}`);
    const c = `f.${step.column}`;
    const level = ctx.level || "county";
    let value;
    switch (step.stat) {
      case "mean": value = `avg(${c})`; break;
      case "max": value = `max(${c})`; break;
      case "pct": value = `percentile_cont(${ctx.bind(Number(step.q) / 100)}::float8) WITHIN GROUP (ORDER BY ${c})`; break;
      case "share": {
        const t = ctx.bind(Number(step.threshold));
        const test = step.cmp === ">" ? `${c} > ${t}` : `${c} <= ${t}`;
        value = `100.0 * sum(CASE WHEN ${test} THEN f.thiessen_m2 ELSE 0 END) / NULLIF(sum(f.thiessen_m2), 0)`;
        break;
      }
      default: throw new CompileError(`point_distance: unsupported stat ${step.stat}`);
    }
    // Partition pruning: only the plan's states are read.
    const states = ctx.bind(step.state_fips.map(String));
    const where = `f.state_fp = ANY(${states}::bpchar[]) AND ${c} IS NOT NULL`;
    if (PREFIX[level]) {
      return `${ctx.name} AS (SELECT left(f.block20, ${PREFIX[level]}) AS fips, ${value}::float8 AS value ` +
             `FROM fine_pt f WHERE ${where} GROUP BY 1)`;
    }
    if (SPATIAL.has(level)) {
      return `${ctx.name} AS (SELECT u.geoid AS fips, ${value}::float8 AS value FROM geo_unit u ` +
             `JOIN fine_pt f ON f.geom && u.geom AND ST_Intersects(f.geom, u.geom) ` +
             `WHERE u.level = ${ctx.bind(level)} AND ${where} GROUP BY u.geoid)`;
    }
    throw new CompileError(`point_distance: no ${level} level for fine points`);
  },
};
