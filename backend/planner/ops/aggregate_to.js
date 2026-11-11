const { CompileError } = require("./_sql");

/**
 * A finer unit's values rolled up to counties (Phase E).
 *
 * INTERNAL: never offered to the model, so the decoding enum and the prompt
 * are unchanged. planner/levels.js applyRollup inserts it right after a load
 * that reads tract values, when the question uses finer data to answer about
 * counties ("using census tract data ... each Michigan county", "which
 * counties vary most from one tract to another"). Every op downstream then
 * works at the county, exactly as before.
 *
 *   wmean   a rate: the population-weighted mean of the parts
 *   sum     a count: the sum of the parts
 *   stddev  the spread of the parts within each county (3+ parts)
 *
 * Tracts and block groups nest exactly in counties (geo_unit.county_fips), so
 * no crosswalk share is involved. Validated by the same roll-up in
 * geoark_aggregate: SVI tract population summed matched the county file
 * exactly for all 3,133 counties; the weighted poverty rate r 0.9975.
 */
const FROM = new Set(["tract", "bg"]);
const METHODS = new Set(["wmean", "sum", "stddev"]);

module.exports = {
  name: "aggregate_to",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",
  internal: true,

  offered: () => false,

  validate(step) {
    const errs = [];
    if (!FROM.has(step.from_level)) errs.push(`step "${step.id}" (aggregate_to): from_level must be tract or bg`);
    if (!METHODS.has(step.method)) errs.push(`step "${step.id}" (aggregate_to): method must be wmean, sum or stddev`);
    if (step.method === "wmean" && !step.weight_code) errs.push(`step "${step.id}" (aggregate_to): wmean needs a weight`);
    return errs;
  },

  compile(step, ctx) {
    if (!FROM.has(step.from_level) || !METHODS.has(step.method)) {
      throw new CompileError(`aggregate_to: unsupported ${step.from_level} / ${step.method}`);
    }
    const lv = ctx.bind(step.from_level);
    const parts = `FROM ${ctx.ins[0]} r JOIN geo_unit u ON u.level = ${lv} AND u.geoid = r.fips`;
    if (step.method === "stddev") {
      return `${ctx.name} AS (SELECT u.county_fips::text AS fips, stddev_samp(r.value) AS value ` +
             `${parts} WHERE r.value IS NOT NULL GROUP BY u.county_fips HAVING count(*) >= 3)`;
    }
    if (step.method === "sum") {
      return `${ctx.name} AS (SELECT u.county_fips::text AS fips, sum(r.value) AS value ` +
             `${parts} WHERE r.value IS NOT NULL GROUP BY u.county_fips)`;
    }
    const w = ctx.bind(String(step.weight_code));
    return `${ctx.name} AS (SELECT u.county_fips::text AS fips, ` +
           `sum(r.value * w.value) / NULLIF(sum(w.value), 0) AS value ${parts} ` +
           `JOIN (SELECT geoid, value FROM geo_values_all WHERE level = ${lv} AND code = ${w} ` +
           `AND year = (SELECT max(year) FROM geo_values_all WHERE level = ${lv} AND code = ${w})) w ` +
           `ON w.geoid = r.fips WHERE r.value IS NOT NULL AND w.value > 0 GROUP BY u.county_fips)`;
  },
};
