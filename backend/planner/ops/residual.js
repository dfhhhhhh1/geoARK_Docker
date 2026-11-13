/**
 * How far each county is from what a predictor would predict: the residual of
 * a least-squares line, outcome ~ predictor (docs/RESEARCH_PLAN.md Phase F).
 * "How much higher or lower is the diabetes rate than its median household
 * income would predict?" is diabetes minus (a + b * income), in the outcome's
 * own units.
 *
 * Linear in the predictor as given. A log predictor fits income better, and
 * research_advanced.yaml accepts either; the ranking of residuals barely moves
 * between the two (the residual gold's second alternative). Ordinary least
 * squares, unweighted, over the counties both series cover: regr_slope and
 * regr_intercept, so it is one aggregate and a join, inside the read-only
 * transaction like every other op.
 *
 * Gated on "than X would predict / expected given / after accounting for"
 * phrasing; 2SFCA's "account for how many people each hospital serves" is
 * access's, and is excluded here.
 */
const PREDICT =
  /\b(would\s+predict|predicted\s+by|than\s+(?:would\s+be\s+)?expected|expected\s+(?:from|given)|given\s+(?:its|their)|after\s+(?:accounting|controlling|adjusting)\s+for|controlling\s+for|adjusted\s+for|residuals?)\b/i;
const ACCESS = /\baccess(?:ibility)?\b/i;

module.exports = {
  name: "residual",
  inputs: 2,
  needs: [],
  produces: "series",
  kind: "sql",
  diverging: true,
  valueLabel: "above (+) or below (-) what the predictor predicts",

  enumComment: "outcome minus what a linear fit on the predictor predicts",
  promptLine: `  residual     2 inputs (outcome, predictor)       -> how far each county's outcome is
                 above (+) or below (-) what the predictor predicts, from a straight-line fit`,
  choiceLine: `  "higher than X would predict", "than expected given X"    -> residual`,

  offered: (ctx) => {
    const q = String(ctx.query || "");
    return PREDICT.test(q) && !ACCESS.test(q);
  },

  examples: [{ text:
`QUESTION: which counties have more heart disease than their smoking rate would predict
  (a2 = heart disease prevalence, a7 = adult smoking rate)
PLAN: {"intent":"Heart disease prevalence minus what the smoking rate predicts, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a7","inputs":[]},
          {"id":"s3","op":"residual","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}
  NOTE: the outcome first, the predictor second.` }],

  compile(step, ctx) {
    const [y, x] = ctx.ins;
    return `${ctx.name} AS (SELECT j.fips, j.y - (f.a + f.b * j.x) AS value FROM ` +
           `(SELECT y.fips, y.value AS y, x.value AS x FROM ${y} y JOIN ${x} x USING (fips) ` +
           `WHERE y.value IS NOT NULL AND x.value IS NOT NULL) j CROSS JOIN ` +
           `(SELECT regr_slope(y.value, x.value) AS b, regr_intercept(y.value, x.value) AS a ` +
           `FROM ${y} y JOIN ${x} x USING (fips) WHERE y.value IS NOT NULL AND x.value IS NOT NULL) f)`;
  },
};
