/**
 * Terminal step. Produces no CTE of its own; it names the step whose result
 * becomes a returned layer.
 *
 * A plan may carry SEVERAL of these. Each one is compiled into its own SELECT
 * over the shared CTE prelude and comes back as a separate layer, which is what
 * lets a question that fans out ("hospitals, and the poverty rate around them")
 * return a point layer and a choropleth from one plan.
 */
module.exports = {
  name: "output",
  inputs: 1,
  needs: [],
  produces: null,
  terminal: true,
  kind: "sql",

  enumComment: "terminal step",
  promptLine: `  output       1 input                             -> terminal step`,

  offered: () => true,
  examples: [],

  // No compile: the compiler reads `terminal` and collects the input instead.
};
