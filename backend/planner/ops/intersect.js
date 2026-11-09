const { statesCondition } = require("../conditions");

/**
 * Counties that meet two conditions at once.
 *
 * "Rural counties with a poverty rate above 20% and no hospital" is three
 * conditions on three different measures. filter_attr can only test the
 * series it is applied to, so before this the planner chained filter_attr
 * steps over ONE series, or joined and filtered `value` (which is input 1's
 * measure, never input 2's), and returned nothing at all, 3 runs of 3.
 *
 * Each condition is now its own filter on its own measure, and intersect keeps
 * input 1's rows (fips AND value: the answer's measure) whose county also
 * appears in input 2. Three conditions are two intersects. A semi-join, so a
 * county is never duplicated however many rows input 2 has for it.
 *
 * Offered only when the question states a condition (planner/conditions.js),
 * so every other question sees the op set it saw before.
 */
module.exports = {
  name: "intersect",
  inputs: 2,
  needs: [],
  produces: "series",
  kind: "sql",

  enumComment: "keep input 1's counties that also appear in input 2",
  promptLine: `  intersect    2 inputs                            -> input 1's rows, only for counties
                 that are also in input 2 (both conditions hold)`,
  choiceLine: `  "X counties that also ...", several conditions at once   -> filter each, then intersect`,

  offered: (ctx) => statesCondition(ctx),

  examples: [
    { usesDefinitions: true, text:
`QUESTION: mostly rural counties where the unemployment rate is above 6 percent
  (a2 = unemployment rate, a5 = % rural, listed with  d1 = "mostly rural")
PLAN: {"intent":"Unemployment rate in mostly rural counties where it is above 6 percent",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_attr","attr_id":"","inputs":["s1"],"operator":">","value":6},
          {"id":"s3","op":"load","attr_id":"a5","inputs":[]},
          {"id":"s4","op":"filter_attr","attr_id":"","inputs":["s3"],"definition":"d1"},
          {"id":"s5","op":"intersect","attr_id":"","inputs":["s2","s4"]},
          {"id":"s6","op":"output","attr_id":"","inputs":["s5"]}]}
  NOTE: each condition filters its OWN measure; intersect keeps input 1's values.` },
    { usesDefinitions: false, text:
`QUESTION: counties where median household income is below 40000 and more than 20 percent of adults smoke
  (a1 = median household income, a4 = adult smoking)
PLAN: {"intent":"Median household income in counties with income below 40000 and adult smoking above 20 percent",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a1","inputs":[]},
          {"id":"s2","op":"filter_attr","attr_id":"","inputs":["s1"],"operator":"<","value":40000},
          {"id":"s3","op":"load","attr_id":"a4","inputs":[]},
          {"id":"s4","op":"filter_attr","attr_id":"","inputs":["s3"],"operator":">","value":20},
          {"id":"s5","op":"intersect","attr_id":"","inputs":["s2","s4"]},
          {"id":"s6","op":"output","attr_id":"","inputs":["s5"]}]}
  NOTE: each condition filters its OWN measure; intersect keeps input 1's values.` },
  ],

  validate(step) {
    const ins = step.inputs || [];
    if (ins.length === 2 && ins[0] === ins[1]) {
      return [`step "${step.id}" (intersect): both inputs are "${ins[0]}". ` +
              `Intersect two DIFFERENT conditions.`];
    }
    return [];
  },

  compile(step, ctx) {
    const [a, b] = ctx.ins;
    return `${ctx.name} AS (SELECT a.fips, a.value FROM ${a} a ` +
           `WHERE EXISTS (SELECT 1 FROM ${b} b WHERE b.fips = a.fips))`;
  },
};
