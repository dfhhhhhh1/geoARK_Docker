const { GROUP_COMPARISON } = require("../conditions");

/**
 * Is a measure higher in one group of counties than in another?
 *
 * "Is the unemployment rate higher in the South than in the Northeast?" used
 * to plan load -> filter_area -> aggregate, twice, then join: two one-row
 * aggregates with fips NULL, which share no key, so the join returned nothing
 * (3 runs of 3). The question needs both groups and a verdict.
 *
 * INPUTS are two series, each already restricted to its group by the usual
 * filters (filter_area, filter_place, filter_attr with a definition), so this
 * op knows nothing about how a group is defined and composes with all of them.
 * A county in BOTH groups is dropped from both and counted in `overlap`: the
 * test assumes two separate samples.
 *
 * RESULT. Per-county rows, tagged `grp` a / b, so the map shows both groups,
 * plus one summary carried on every row and lifted out by the executor:
 *
 *   value          median(a) - median(b), in the measure's own units. Medians,
 *                  because these distributions are skewed (why `outlier` and
 *                  the choropleth bins use quantiles).
 *   rank_biserial  P(a > b) - P(a < b) for a random pair: -1..1, unit free.
 *   p_value        Mann-Whitney, normal approximation, on EFFECTIVE sizes.
 *
 * WHY EFFECTIVE SIZES. Neighbouring counties resemble each other, and two
 * regions are two spatial blocks: 1,422 Southern counties are not 1,422
 * independent draws. n_eff = n (1 - I) / (1 + I), I the global Moran's I of
 * the pooled values (binary contiguity, county_neighbors), the same
 * discount `correlate` applies; floored at 2 per group. The z statistic is
 * re-expressed through the rank-biserial so it can be evaluated at n_eff:
 * z = r * sqrt(3 n_a n_b / (n_a + n_b + 1)). Ties are not variance-corrected,
 * which makes p slightly too LARGE, the safe direction.
 */

const ROW_COLUMNS = ["grp"];
const SUMMARY_COLUMNS = [
  "diff", "median_a", "median_b", "mean_a", "mean_b", "n_a", "n_b", "overlap",
  "rank_biserial", "moran_i", "n_eff_a", "n_eff_b", "p_value",
];

// Two-sided normal tail; see correlate.js for the approximation and the guard.
const erfc = (u) =>
  `CASE WHEN ${u} > 26 THEN 0 ELSE (` +
  `0.254829592 * (1 / (1 + 0.3275911 * ${u})) ` +
  `- 0.284496736 * (1 / (1 + 0.3275911 * ${u}))^2 ` +
  `+ 1.421413741 * (1 / (1 + 0.3275911 * ${u}))^3 ` +
  `- 1.453152027 * (1 / (1 + 0.3275911 * ${u}))^4 ` +
  `+ 1.061405429 * (1 / (1 + 0.3275911 * ${u}))^5) * exp(-(${u}) * (${u})) END`;

module.exports = {
  name: "compare_groups",
  inputs: 2,
  needs: [],
  produces: "series",
  kind: "sql",
  rowColumns: ROW_COLUMNS,
  summaryColumns: SUMMARY_COLUMNS,
  valueLabel: "difference in medians (group A - group B)",

  enumComment: "is a measure higher in one group of counties than another",
  promptLine: `  compare_groups 2 inputs                          -> both groups' counties, and whether
                 the measure is higher in input 1's group than input 2's`,
  choiceLine: `  "higher in A than in B", "A compared with B" (two groups) -> compare_groups`,

  // Needs adjacency for the effective sizes, like correlate and hotspot.
  offered: (ctx) => ctx.hasNeighbors === true && GROUP_COMPARISON.test(String(ctx.query || "")),

  examples: [{ text:
`QUESTION: are obesity rates higher in the Midwest than in the West
  (a3 = obesity among adults)
PLAN: {"intent":"Adult obesity in Midwestern counties compared with Western counties",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Midwest"]},
          {"id":"s3","op":"filter_area","attr_id":"","inputs":["s1"],"states":["West"]},
          {"id":"s4","op":"compare_groups","attr_id":"","inputs":["s2","s3"]},
          {"id":"s5","op":"output","attr_id":"","inputs":["s4"]}]}
  NOTE: ONE measure, filtered two ways. Do not aggregate first: the
  comparison needs every county of both groups.` }],

  validate(step) {
    const ins = step.inputs || [];
    if (ins.length === 2 && ins[0] === ins[1]) {
      return [`step "${step.id}" (compare_groups): both inputs are "${ins[0]}". ` +
              `Restrict the measure to each group separately, then compare the two.`];
    }
    return [];
  },

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    const u = "abs(t.z) / sqrt(2)";
    return `${ctx.name} AS (` +
      `WITH ga AS (SELECT fips, value::float8 AS value FROM ${a} WHERE value IS NOT NULL), ` +
      `gb AS (SELECT fips, value::float8 AS value FROM ${b} WHERE value IS NOT NULL), ` +
      `both_ AS (SELECT fips FROM ga INTERSECT SELECT fips FROM gb), ` +
      `g AS (SELECT fips, value, 'a'::text AS grp FROM ga WHERE fips NOT IN (SELECT fips FROM both_) ` +
        `UNION ALL SELECT fips, value, 'b'::text FROM gb WHERE fips NOT IN (SELECT fips FROM both_)), ` +
      // Average ranks over the pooled sample, so ties share their positions.
      `rk AS (SELECT grp, (rank() OVER (ORDER BY value) + count(*) OVER () + 1 ` +
        `- rank() OVER (ORDER BY value DESC)) / 2.0 AS r FROM g), ` +
      `z AS (SELECT fips, value - avg(value) OVER () AS d FROM g), ` +
      `mo AS (SELECT (SELECT count(*) FROM z)::float8 / NULLIF(count(*), 0) * sum(zi.d * zj.d) ` +
        `/ NULLIF((SELECT sum(d * d) FROM z), 0) AS i ` +
        `FROM county_neighbors nb JOIN z zi ON zi.fips = nb.fips ` +
        `JOIN z zj ON zj.fips = nb.neighbor_fips), ` +
      `s AS (SELECT ` +
        `count(*) FILTER (WHERE grp = 'a')::float8 AS na, ` +
        `count(*) FILTER (WHERE grp = 'b')::float8 AS nb, ` +
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FILTER (WHERE grp = 'a') AS med_a, ` +
        `percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FILTER (WHERE grp = 'b') AS med_b, ` +
        `avg(value) FILTER (WHERE grp = 'a') AS mean_a, ` +
        `avg(value) FILTER (WHERE grp = 'b') AS mean_b FROM g), ` +
      `ra AS (SELECT sum(r) AS rsum FROM rk WHERE grp = 'a'), ` +
      `e AS (SELECT s.*, ` +
        `2 * (ra.rsum - s.na * (s.na + 1) / 2) / NULLIF(s.na * s.nb, 0) - 1 AS rb, ` +
        `mo.i, ` +
        // Discount, never inflate: a negative I would otherwise claim more
        // independent information than there are counties.
        `LEAST(1, GREATEST(0, (1 - coalesce(mo.i, 0)) / NULLIF(1 + coalesce(mo.i, 0), 0))) AS f ` +
        `FROM s CROSS JOIN ra CROSS JOIN mo), ` +
      `t AS (SELECT e.*, GREATEST(2, e.na * e.f) AS ea, GREATEST(2, e.nb * e.f) AS eb, ` +
        `e.rb * sqrt(3 * GREATEST(2, e.na * e.f) * GREATEST(2, e.nb * e.f) ` +
          `/ (GREATEST(2, e.na * e.f) + GREATEST(2, e.nb * e.f) + 1)) AS z FROM e) ` +
      `SELECT g.fips, g.value, g.grp, ` +
        `t.med_a - t.med_b AS diff, t.med_a AS median_a, t.med_b AS median_b, ` +
        `t.mean_a, t.mean_b, t.na::int AS n_a, t.nb::int AS n_b, ` +
        `(SELECT count(*)::int FROM both_) AS overlap, ` +
        `t.rb AS rank_biserial, t.i AS moran_i, round(t.ea)::int AS n_eff_a, ` +
        `round(t.eb)::int AS n_eff_b, ${erfc(u)} AS p_value ` +
      `FROM g CROSS JOIN t WHERE t.na >= 3 AND t.nb >= 3)`;
  },

  ROW_COLUMNS, SUMMARY_COLUMNS,
};
