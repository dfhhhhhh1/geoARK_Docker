/**
 * How strongly two county measures move together.
 *
 * "Compare obesity and poverty" used to return two maps side by side and no
 * statistic, which leaves the actual research question -- do they go together,
 * and how strongly -- to the reader's eye. This answers it with one row.
 *
 * WHAT IT REPORTS
 *   value         Spearman's rho, the headline. Rank-based because these
 *                 distributions are heavily skewed (the reason the choropleth
 *                 uses quantile bins and `outlier` uses the median), and a
 *                 handful of extreme counties can carry Pearson's r.
 *   pearson_r     for comparison; a large gap between the two means a few
 *                 counties are driving the linear fit.
 *   slope, intercept   the least-squares line of B on A, in B's units per A unit.
 *   n             counties with both values.
 *   n_effective   n discounted for spatial autocorrelation (below).
 *   ci_low/high   95% interval for rho, Fisher z on n_effective.
 *   p_value       two-sided, on n_effective.
 *   moran_a/b     global Moran's I of each input.
 *
 * WHY n_effective. Neighbouring counties resemble each other: Moran's I is
 * about 0.6 for the CDC PLACES measures. 2,945 counties are not 2,945
 * independent observations, and a p-value computed as though they were is far
 * too small. n_effective = n (1 - Ia*Ib) / (1 + Ia*Ib) (Bretherton et al. 1999),
 * which roughly halves n on these data. It is an approximation, and the
 * direction of its error is the safe one here.
 *
 * VERIFIED against known answers and independently (docs/CORRELATE.md): smoking
 * ~ COPD rho 0.936; median income ~ diabetes rho -0.691, Pearson -0.631,
 * reproduced exactly by a separate Python implementation over the same 2,944
 * pairs; Moran's I of random noise -0.011.
 *
 * A single-row result, like an ungrouped `aggregate`: it is terminal in
 * practice, and its extra columns travel through the output via `statColumns`.
 */

// Declared once so the compiler, the executor and the tests agree on them.
const STAT_COLUMNS = [
  "pearson_r", "n", "n_effective", "ci_low", "ci_high", "p_value",
  "slope", "intercept", "moran_a", "moran_b",
];

// Two-sided normal tail, erfc(u) with u = |t| / sqrt(2), Abramowitz & Stegun
// 7.1.26 (|error| < 1.5e-7). Postgres has no erf, and exp() raises on
// underflow rather than returning 0, hence the guard.
const erfc = (u) =>
  `CASE WHEN ${u} > 26 THEN 0 ELSE (` +
  `0.254829592 * (1 / (1 + 0.3275911 * ${u})) ` +
  `- 0.284496736 * (1 / (1 + 0.3275911 * ${u}))^2 ` +
  `+ 1.421413741 * (1 / (1 + 0.3275911 * ${u}))^3 ` +
  `- 1.453152027 * (1 / (1 + 0.3275911 * ${u}))^4 ` +
  `+ 1.061405429 * (1 / (1 + 0.3275911 * ${u}))^5) * exp(-(${u}) * (${u})) END`;

module.exports = {
  name: "correlate",
  inputs: 2,
  needs: [],
  produces: "series",
  kind: "sql",
  statColumns: STAT_COLUMNS,
  valueLabel: "Spearman rho",

  enumComment: "how strongly two measures go together across counties",
  promptLine: `  correlate    2 inputs                            -> one row: how strongly the two
                 measures go together (rank correlation), with significance`,
  choiceLine: `  "is A related to B", "does A go with B", "correlation"   -> correlate`,

  // Needs the adjacency table for n_effective, and the question to be asking
  // about a relationship. Gated on phrasing SHAPE like outlier and hotspot:
  // every question not asking this sees the op set it saw before.
  offered: (ctx) => {
    if (ctx.hasNeighbors !== true) return false;
    const q = String(ctx.query || "");
    return /\b(correlat\w*|associat\w*|relationship|related|relates?|linked|link\s+between|connection|connected|go(es)?\s+(together|with|hand\s+in\s+hand)|track(s)?\s+with|vary\s+with|varies\s+with|predict\w*|explain\w*|tied\s+to|depend\w*\s+on)\b/i.test(q)
      // "does X affect Y", "the effect of X on Y", "impact of X on Y". Not
      // "drive": "how far do people have to drive to a hospital" matched it,
      // and "what drives X" is explain's question anyway.
      || /\b(affect\w*|effect\s+of|impact\w*|influenc\w*)\b/i.test(q)
      // "the more X, the more Y", "higher X ... higher Y"
      || /\bthe\s+(more|less|higher|lower)\b[^.?]*\bthe\s+(more|less|higher|lower)\b/i.test(q);
  },

  examples: [{ text:
`QUESTION: is obesity related to diabetes across counties
  (a1 = obesity among adults, a3 = diagnosed diabetes among adults)
PLAN: {"intent":"How strongly adult obesity and diagnosed diabetes go together across counties",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a1","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s3","op":"correlate","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` }],

  validate(step) {
    const ins = step.inputs || [];
    if (ins.length === 2 && ins[0] === ins[1]) {
      return [`step "${step.id}" (correlate): both inputs are "${ins[0]}". ` +
              `Correlate two DIFFERENT measures.`];
    }
    return [];
  },

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    const u = "t.u";
    return `${ctx.name} AS (` +
      `WITH p AS (SELECT a.fips, a.value::float8 AS x, b.value::float8 AS y ` +
        `FROM ${a} a JOIN ${b} b USING (fips) ` +
        `WHERE a.value IS NOT NULL AND b.value IS NOT NULL), ` +
      // Average ranks, so ties get the mean of the positions they span.
      `rk AS (SELECT ` +
        `(rank() OVER (ORDER BY x) + count(*) OVER () + 1 - rank() OVER (ORDER BY x DESC)) / 2.0 AS rx, ` +
        `(rank() OVER (ORDER BY y) + count(*) OVER () + 1 - rank() OVER (ORDER BY y DESC)) / 2.0 AS ry ` +
        `FROM p), ` +
      `z AS (SELECT fips, x - avg(x) OVER () AS zx, y - avg(y) OVER () AS zy FROM p), ` +
      // Global Moran's I with binary contiguity; county_neighbors holds both
      // directions of every pair, which the formula needs.
      `mo AS (SELECT ` +
        `(SELECT count(*) FROM z)::float8 / NULLIF(count(*), 0) * sum(zi.zx * zj.zx) ` +
          `/ NULLIF((SELECT sum(zx * zx) FROM z), 0) AS ia, ` +
        `(SELECT count(*) FROM z)::float8 / NULLIF(count(*), 0) * sum(zi.zy * zj.zy) ` +
          `/ NULLIF((SELECT sum(zy * zy) FROM z), 0) AS ib ` +
        `FROM county_neighbors nb JOIN z zi ON zi.fips = nb.fips ` +
        `JOIN z zj ON zj.fips = nb.neighbor_fips), ` +
      `s AS (SELECT corr(x, y) AS r, regr_slope(y, x) AS slope, ` +
        `regr_intercept(y, x) AS intercept, count(*)::float8 AS n FROM p), ` +
      `e AS (SELECT s.*, (SELECT corr(rx, ry) FROM rk) AS rho, mo.ia, mo.ib, ` +
        // Floor of 4 keeps the Fisher interval defined; ceiling of n because a
        // negative Ia*Ib would otherwise claim MORE information than exists.
        `GREATEST(4, LEAST(s.n, s.n * (1 - coalesce(mo.ia * mo.ib, 0)) ` +
          `/ NULLIF(1 + coalesce(mo.ia * mo.ib, 0), 0))) AS n_eff ` +
        `FROM s CROSS JOIN mo), ` +
      // rho clamped off +/-1 so atanh and the t statistic stay finite.
      `t AS (SELECT e.*, LEAST(GREATEST(e.rho, -0.999999), 0.999999) AS rc, ` +
        `abs(e.rho) * sqrt((e.n_eff - 2) / NULLIF(1 - e.rho * e.rho, 0)) / sqrt(2) AS u ` +
        `FROM e) ` +
      `SELECT NULL::char(5) AS fips, t.rho AS value, t.r AS pearson_r, ` +
        `t.n::int AS n, round(t.n_eff)::int AS n_effective, ` +
        `tanh(atanh(t.rc) - 1.96 / sqrt(t.n_eff - 3)) AS ci_low, ` +
        `tanh(atanh(t.rc) + 1.96 / sqrt(t.n_eff - 3)) AS ci_high, ` +
        `${erfc(u)} AS p_value, ` +
        `t.slope, t.intercept, t.ia AS moran_a, t.ib AS moran_b ` +
      `FROM t WHERE t.n >= 10)`;
  },

  STAT_COLUMNS,
};
