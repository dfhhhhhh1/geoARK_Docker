/**
 * What the database knows about a value series that its description does not.
 *
 * Three questions, each answered from acs_county_values at the series' latest
 * vintage (the year `load` uses when a plan names none):
 *
 *   valueRanges   national min / max. planner/units.js uses it to tell a
 *                 percentage from a count where the ACS label is wrong, which
 *                 it is for 243 of 3,557 series.
 *   coverageOf    how many counties of the PLAN'S area have a value.
 *   equivalentsOf series that measure the same thing, verified by agreeing
 *                 values, with their coverage of the same area.
 *
 * The last two feed planner/coverage.js.
 */

const planOps = require("./planner/ops");
const { isTotalPopulation } = require("./population");

/** Median ratio, equivalent / original, over counties both cover. */
const AGREEMENT = [0.9, 1.1];

function createSeriesStats(pool, { log = () => {} } = {}) {
  const latest = new Map();       // census_code -> year | null
  const ranges = new Map();       // census_code -> {lo, hi, n} | null
  let countyTotal = null;
  let populationRows = null;      // catalog rows that describe a whole-population count

  async function latestYears(codes) {
    const need = [...new Set(codes)].filter(c => c && !latest.has(c));
    if (need.length) {
      const { rows } = await pool.query(
        `SELECT census_code, max(year)::int AS y FROM acs_county_values
          WHERE census_code = ANY($1) GROUP BY census_code`, [need]);
      for (const c of need) latest.set(c, null);
      for (const r of rows) latest.set(r.census_code, r.y);
    }
    return codes.filter(c => latest.get(c) != null);
  }

  /** Map<census_code, {lo, hi, n}> for the codes that have any values. */
  async function valueRanges(codes) {
    const have = await latestYears(codes);
    const need = have.filter(c => !ranges.has(c));
    if (need.length) {
      const { rows } = await pool.query(
        `SELECT v.census_code, min(v.value) AS lo, max(v.value) AS hi, count(*)::int AS n
           FROM acs_county_values v
           JOIN unnest($1::text[], $2::int[]) AS l(code, y)
             ON v.census_code = l.code AND v.year = l.y
          WHERE v.value IS NOT NULL
          GROUP BY v.census_code`,
        [need, need.map(c => latest.get(c))]);
      for (const c of need) ranges.set(c, null);
      for (const r of rows) ranges.set(r.census_code, { lo: Number(r.lo), hi: Number(r.hi), n: r.n });
    }
    return new Map(have.filter(c => ranges.get(c)).map(c => [c, ranges.get(c)]));
  }

  /**
   * The counties a plan restricts itself to, or null for the whole country.
   *
   * Built from the plan's own area filters, compiled by their own op modules
   * over every county, so this cannot disagree with what the plan will keep:
   * filter_place's 1% overlap rule, compound metro names and the state list
   * come along rather than being re-implemented here and drifting. Not through
   * compilePlan, whose output statement serializes every county's geometry.
   */
  async function areaFips(plan) {
    const filters = (plan.steps || []).filter(
      s => s.op === "filter_area" || s.op === "filter_place");
    if (!filters.length) return null;
    const params = [];
    const bind = (v) => { params.push(v); return `$${params.length}`; };
    const ctes = [`area0 AS (SELECT fips, 0::double precision AS value FROM county_geom)`];
    filters.forEach((f, i) => ctes.push(planOps.byName(f.op).compile(f, {
      name: `area${i + 1}`, ins: [`area${i}`], bind, resolved: new Map(),
    })));
    const { rows } = await pool.query(
      `WITH ${ctes.join(",\n     ")}\nSELECT fips FROM area${filters.length}`, params);
    return rows.map(r => r.fips);
  }

  async function totalCounties() {
    if (countyTotal == null) {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM county_geom`);
      countyTotal = rows[0].n;
    }
    return countyTotal;
  }

  /** Map<census_code, counties with a value> inside `fips` (null = national). */
  async function countIn(codes, fips) {
    const have = await latestYears(codes);
    if (!have.length) return new Map();
    const { rows } = await pool.query(
      `SELECT v.census_code, count(*)::int AS n
         FROM acs_county_values v
         JOIN unnest($1::text[], $2::int[]) AS l(code, y)
           ON v.census_code = l.code AND v.year = l.y
        WHERE v.value IS NOT NULL
          ${fips ? "AND v.fips = ANY($3)" : ""}
        GROUP BY v.census_code`,
      fips ? [have, have.map(c => latest.get(c)), fips] : [have, have.map(c => latest.get(c))]);
    const out = new Map(have.map(c => [c, 0]));
    for (const r of rows) out.set(r.census_code, r.n);
    return out;
  }

  async function sources(attrIds) {
    const { rows } = await pool.query(
      `SELECT attr_id, census_code, description FROM attribute_source
        WHERE attr_id = ANY($1) AND source_kind = 'acs_long'`, [attrIds]);
    return rows;
  }

  /** Map<attr_id, {n, total, desc}> for the value series among attrIds. */
  async function coverageOf(attrIds, plan) {
    const srcs = await sources(attrIds);
    if (!srcs.length) return new Map();
    const fips = await areaFips(plan);
    const total = fips ? fips.length : await totalCounties();
    const counts = await countIn(srcs.map(s => s.census_code), fips);
    return new Map(srcs.filter(s => counts.has(s.census_code)).map(s =>
      [s.attr_id, { n: counts.get(s.census_code), total, desc: s.description }]));
  }

  /**
   * Series that measure what attrId measures, verified by their values.
   *
   * The class comes from the description (today only whole-population counts,
   * population.js); membership is then CHECKED: the median ratio to the
   * original, over counties both cover, must sit within AGREEMENT. Without
   * that check "Estimate|ANCESTRY|Total population" (DP02_0122E, max 108,101)
   * would pass as total population.
   */
  async function equivalentsOf(attrId, plan) {
    const [src] = await sources([attrId]);
    if (!src || !isTotalPopulation(src.description)) return [];

    if (!populationRows) {
      const { rows } = await pool.query(
        `SELECT attr_id, census_code, description FROM attribute_source
          WHERE source_kind = 'acs_long'`);
      populationRows = rows.filter(r => isTotalPopulation(r.description));
    }
    const others = populationRows.filter(r => r.attr_id !== attrId);
    const codes = await latestYears([src.census_code, ...others.map(r => r.census_code)]);
    if (!codes.includes(src.census_code)) return [];
    const otherCodes = codes.filter(c => c !== src.census_code);
    if (!otherCodes.length) return [];

    const { rows: agree } = await pool.query(
      `WITH a AS (SELECT fips, value FROM acs_county_values
                   WHERE census_code = $1 AND year = $2 AND value > 0)
       SELECT v.census_code,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY v.value / a.value) AS ratio
         FROM acs_county_values v
         JOIN unnest($3::text[], $4::int[]) AS l(code, y)
           ON v.census_code = l.code AND v.year = l.y
         JOIN a USING (fips)
        GROUP BY v.census_code`,
      [src.census_code, latest.get(src.census_code), otherCodes, otherCodes.map(c => latest.get(c))]);
    const ok = new Set(agree
      .filter(r => r.ratio >= AGREEMENT[0] && r.ratio <= AGREEMENT[1])
      .map(r => r.census_code));
    const rejected = agree.filter(r => !ok.has(r.census_code));
    if (rejected.length) {
      log(`   Coverage: not equivalent to ${src.census_code} by value: ` +
          rejected.map(r => `${r.census_code} (median ratio ${Number(r.ratio).toFixed(3)})`).join(", "));
    }

    const fips = await areaFips(plan);
    const total = fips ? fips.length : await totalCounties();
    const counts = await countIn([...ok], fips);
    return others
      .filter(r => ok.has(r.census_code))
      .map(r => ({ attr_id: r.attr_id, attr_desc: r.description, census_code: r.census_code,
                   n: counts.get(r.census_code) || 0, total, entity_type: "COUNTY" }));
  }

  /** For /api/reload-corpus: the values may have been reloaded underneath. */
  function clear() {
    latest.clear(); ranges.clear(); countyTotal = null; populationRows = null;
  }

  return { valueRanges, coverageOf, equivalentsOf, areaFips, clear };
}

module.exports = { createSeriesStats, AGREEMENT };
