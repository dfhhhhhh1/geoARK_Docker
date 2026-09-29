const { CompileError } = require("./_sql");
const { toFipsPrefixes } = require("../../states");

/** Restrict a series to named states or census regions. */
module.exports = {
  name: "filter_area",
  inputs: 1,
  needs: ["states"],
  produces: "series",
  kind: "sql",

  enumComment: "keep only counties in named states or regions",
  promptLine: `  filter_area  needs states, 1 input               -> keep only those states.
                 "states" takes full state names. For a region, list its member
                 states: "New England" becomes Maine, New Hampshire, Vermont,
                 Massachusetts, Rhode Island, Connecticut. Midwest, Northeast,
                 South and West may be given by name instead. List each state
                 once.`,
  choiceLine: `  "in Missouri", "in New England", a state or region       -> filter_area`,

  // Needs the question to actually name a place. `queryMentionsArea` recognises
  // the SHAPE of a place restriction rather than a list of names, so this is
  // not a hardcoded gate -- see backend/states.js.
  offered: (ctx) => ctx.mentionsArea,

  examples: [{ text:
`QUESTION: median household income for counties in Missouri
  (a2 = median household income)
PLAN: {"intent":"Median household income for Missouri counties",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Missouri"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  validate(step) {
    // Checked here as well as in the decoding enum, because the enum only
    // constrains generation -- a repaired plan or a non-constrained caller can
    // still carry a name that has no FIPS code.
    if (!Array.isArray(step.states) || step.states.length === 0) {
      return [`step "${step.id}" (filter_area): "states" must list at least one state or region`];
    }
    return [];
  },

  compile(step, ctx) {
    // The predicate is on the first two digits of fips, which is exactly
    // county_geom.state_fp, so this stays a plain indexed comparison rather
    // than anything spatial.
    const { codes, unknown } = toFipsPrefixes(step.states);
    if (unknown.length) {
      throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
    }
    if (!codes.length) throw new CompileError("filter_area needs at least one state");
    const list = codes.map(c => ctx.bind(c)).join(", ");
    return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} ` +
           `WHERE LEFT(fips, 2) IN (${list}))`;
  },
};
