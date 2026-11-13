const { CompileError } = require("./_sql");
const { featureAlgebra, asksCount, overlayAlgebra, measureAlgebra, UNIT_PER_M } = require("../features");

/**
 * Count a features step: one number per unit of the plan (counties, or the
 * level the question named), per state, or one total. Features in, series or
 * scalar out (docs/GIS_OPS_PLAN.md H1), which is how a selection made by
 * `within` becomes a number that rank, filter_area or an output can read.
 *
 * Per unit is a LEFT JOIN from the units, so a unit with none of the features
 * reads 0 rather than vanishing, the rule count_features already follows.
 * group_by reuses aggregate's field and enum: "none" for one total, "state"
 * per state, absent for one per unit. A new enum value would change the
 * decoding schema of every question; this changes none.
 */
module.exports = {
  name: "summarize",
  inputs: 1,
  needs: [],
  accepts: [["features"]],
  produces: "series",
  // One number when group_by is "none": the same single NULL-fips row an
  // ungrouped aggregate yields, typed the same way.
  resultType: (step) => (step.group_by === "none" ? "scalar" : "series"),
  kind: "sql",

  enumComment: "count features: per county, per state, or one total",
  promptLine: `  summarize    1 input (features), optional group_by -> how many of them: one
                 count per county, per state with group_by "state", or a single
                 total with group_by "none"`,
  choiceLine: `  "how many of the X that ...", "the number of X within ..."  -> summarize`,

  offered: (ctx) => (featureAlgebra(ctx) && asksCount(ctx.query)) ||
    (overlayAlgebra(ctx) && asksCount(ctx.query)) || measureAlgebra(ctx),

  // H3: the same op totals a length or an area when the question asks for an
  // amount of a line or polygon layer. Whether it counts or measures, and in
  // which unit, is set in code (features.applyMeasures), so the line only
  // changes when that reading is on offer.
  promptLineFor: (ctx) => measureAlgebra(ctx) ? MEASURE_LINE : null,

  examples: [{ text:
`QUESTION: how many libraries in Oregon are more than 10 miles from a hospital
  (a4 = a libraries dataset, a1 = a hospitals dataset)
PLAN: {"intent":"Number of Oregon libraries farther than 10 miles from any hospital",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a4","inputs":[],"states":["Oregon"]},
          {"id":"s2","op":"select_features","attr_id":"a1","inputs":[]},
          {"id":"s3","op":"within","attr_id":"","inputs":["s1","s2"],"miles":10,"exclude":true},
          {"id":"s4","op":"summarize","attr_id":"","inputs":["s3"],"group_by":"none"},
          {"id":"s5","op":"output","attr_id":"","inputs":["s4"]}]}` }],

  compile(step, ctx) {
    const f = ctx.ins[0];
    if (step.measure === "length" || step.measure === "area") return measured(step, ctx, f);
    if (step.group_by === "none") {
      return `${ctx.name} AS (SELECT NULL::char(5) AS fips, COUNT(*)::double precision AS value FROM ${f})`;
    }
    const level = ctx.level && ctx.level !== "county" ? ctx.level : null;
    const units = level
      ? `(SELECT geoid AS fips, geom FROM geo_unit WHERE level = ${ctx.bind(level)})`
      : `county_geom`;
    // A feature is counted in each unit it touches: a point on a county line
    // in both, as count_features counts it.
    const perUnit =
      `SELECT u.fips, COUNT(f.geom)::double precision AS value FROM ${units} u ` +
      `LEFT JOIN ${f} f ON f.geom && u.geom AND ST_Intersects(u.geom, f.geom) GROUP BY u.fips`;
    if (step.group_by === "state") {
      if (level) throw new CompileError(`summarize by state is not available by ${level}`);
      // Each feature once, in the state of one county it touches: summing the
      // per-county counts would count a feature on a county line twice.
      return `${ctx.name} AS (SELECT LEFT(c.fips, 2) AS fips, COUNT(*)::double precision AS value ` +
             `FROM ${f} f CROSS JOIN LATERAL (SELECT fips FROM county_geom c WHERE c.geom && f.geom ` +
             `AND ST_Intersects(c.geom, f.geom) LIMIT 1) c GROUP BY LEFT(c.fips, 2))`;
    }
    return `${ctx.name} AS (${perUnit})`;
  },
};

const MEASURE_LINE = `  summarize    1 input (features), optional group_by -> how many of them, or
                 for lines and areas their total length or area (the unit
                 is set for you): one number per county, per state with
                 group_by "state", or a single total with group_by "none"`;

/**
 * Total length or area (H3). Per unit, each feature is clipped to the unit,
 * so a road crossing two counties puts each county's own miles in each, and
 * a county's total is what lies inside it. A unit with none reads 0. Per
 * state sums the counties, which partition it. The features may already be
 * the clipped parts inside another layer (overlay with clip).
 */
function measured(step, ctx, f) {
  const unit = step.unit || (step.measure === "area" ? "square miles" : "miles");
  if (!(unit in UNIT_PER_M)) throw new CompileError(`summarize: unknown unit ${unit}`);
  const per = `${ctx.bind(UNIT_PER_M[unit])}::float8`;
  const fn = step.measure === "area" ? "ST_Area" : "ST_Length";
  const dim = step.measure === "area" ? 3 : 2;
  const g = `CASE WHEN ST_IsValid(f.geom) THEN f.geom ELSE ST_MakeValid(f.geom) END`;
  if (step.group_by === "none") {
    return `${ctx.name} AS (SELECT NULL::char(5) AS fips, ` +
           `COALESCE(SUM(${fn}(ST_CollectionExtract(${g}, ${dim})::geography)), 0) / ${per} AS value FROM ${f} f)`;
  }
  const level = ctx.level && ctx.level !== "county" ? ctx.level : null;
  if (level && step.group_by === "state") throw new CompileError(`summarize by state is not available by ${level}`);
  const units = level
    ? `(SELECT geoid AS fips, geom FROM geo_unit WHERE level = ${ctx.bind(level)})`
    : `county_geom`;
  // Wholly inside: the feature itself; otherwise its intersection with the unit.
  const inside =
    `CASE WHEN ST_CoveredBy(f.geom, u.geom) THEN ${g} ` +
    `ELSE ST_CollectionExtract(ST_Intersection(${g}, u.geom), ${dim}) END`;
  // LATERAL, not a join: the unit's box then reaches each branch of a parts
  // read (select_features geometry_only is a UNION ALL), which a plain join
  // did not, scanning all 2.4M rows per county (2026-11-12).
  const perUnit =
    `SELECT u.fips, COALESCE(s.v, 0) / ${per} AS value FROM ${units} u ` +
    `LEFT JOIN LATERAL (SELECT SUM(${fn}((${inside})::geography)) AS v FROM ${f} f ` +
    `WHERE f.geom && u.geom AND ST_Intersects(u.geom, f.geom)) s ON true`;
  if (step.group_by === "state") {
    return `${ctx.name} AS (SELECT LEFT(c.fips, 2) AS fips, SUM(c.value) AS value FROM (${perUnit}) c GROUP BY 1)`;
  }
  return `${ctx.name} AS (${perUnit})`;
}

