/**
 * Counties whose value is unusual for the distribution, keeping only those.
 *
 * A FILTER, not a score for everyone. "Which counties are outliers" wants the
 * outliers, the way `rank` wants the top ten and `filter_area` wants one state.
 * The value it carries is how far out each one is, in interquartile ranges from
 * the median, so the map still shows severity rather than a flat mask.
 *
 * ROBUST STATISTICS ON PURPOSE. The obvious implementation is a z-score with a
 * threshold, and it is wrong for this data: county measures here are heavily
 * skewed -- this project already had to switch the choropleth to quantile bins
 * because equal intervals put 95% of counties in the first one. A mean and a
 * standard deviation are both dragged by the same extreme values the op is
 * looking for, so a z-score under-reports outliers in exactly the distributions
 * that have them. The median and the IQR are not.
 *
 * The 1.5 x IQR fence is Tukey's, the same rule a boxplot's whiskers use.
 */
module.exports = {
  name: "outlier",
  inputs: 1,
  needs: [],
  produces: "series",
  kind: "sql",

  // Signed: negative is unusually low, positive unusually high. Both are
  // outliers and a sequential ramp would rank one above the other.
  diverging: true,
  valueLabel: "IQRs from median",

  enumComment: "keep only counties far outside the usual range",
  promptLine: `  outlier      1 input                             -> keep only counties whose value
                 is unusual, scored in IQRs from the median`,
  choiceLine: `  "outliers", "unusual", "anomalies", "which stand out"    -> outlier`,

  // Gated on the question asking for them. It needs no extra data, so the only
  // cost of offering it is decision space -- which is the cost that matters.
  // Gated on the SHAPE of a deviation question, not a list of synonyms.
  //
  // A word list is written from the op outwards -- "what words mean outlier?"
  // -- and a held-out query found the gap immediately: "which counties don't
  // fit the pattern for income" contains none of outlier/unusual/anomalous, so
  // the op was never offered, and the model improvised `aggregate ->
  // filter_attr` and returned 1,524 counties as the outliers. Same failure as
  // the 60 hardcoded region names that made "New England" silently return
  // nothing: a list like that grows one commit at a time forever.
  offered: (ctx) => {
    const q = String(ctx.query || "");
    return /\b(outliers?|unusual(ly)?|anomal(y|ies|ous)|atypical|extreme|aberrant|abnormal)\b/i.test(q)
      // "don't fit the pattern", "doesn't match the trend", "not conforming"
      || /\b(do(es)?n'?t|not)\s+(\w+\s+){0,2}(fit|match|follow|conform|belong)\b/i.test(q)
      // "stands out", "out of line", "out of the ordinary"
      || /\b(stands?|sticks?)\s+out\b|\bout\s+of\s+(line|step|the\s+ordinary)\b/i.test(q)
      // "deviates from the norm", "unlike the rest", "different from average"
      || /\b(deviat\w+|unlike|differ\w*)\b[^.?]*\b(rest|others?|average|typical|pattern|norm)\b/i.test(q)
      || /\b(exceptions?|surpris\w+)\b/i.test(q);
  },

  examples: [{ text:
`QUESTION: which counties are outliers for median household income
  (a2 = median household income)
PLAN: {"intent":"Counties whose median household income is unusual for the distribution",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"outlier","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  compile(step, ctx) {
    // `q3 > q1` guards a degenerate distribution: a measure where more than
    // half the counties share one value has a zero IQR, every fence collapses
    // onto the median, and without the guard every county that differs at all
    // would be reported as an outlier.
    return `${ctx.name} AS (` +
      `WITH v AS (SELECT fips, value FROM ${ctx.ins[0]} WHERE value IS NOT NULL), ` +
      `q AS (SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY value) AS q1, ` +
            `percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med, ` +
            `percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS q3 FROM v) ` +
      `SELECT v.fips, (v.value - q.med) / NULLIF(q.q3 - q.q1, 0) AS value ` +
      `FROM v CROSS JOIN q ` +
      `WHERE q.q3 > q.q1 AND (` +
        `v.value < q.q1 - 1.5 * (q.q3 - q.q1) OR ` +
        `v.value > q.q3 + 1.5 * (q.q3 - q.q1)))`;
  },
};
