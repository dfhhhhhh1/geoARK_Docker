const { CompileError } = require("./_sql");
const M = require("../moran");

/**
 * Moran's I: is a measure spatially clustered (global, one row), and where are
 * its clusters and spatial outliers (LISA, one class per county).
 * docs/GIS_OPS_PLAN.md H6 tier 1, item 6; the statistics are planner/moran.js.
 *
 * ONE op, two result types, decided by code: `local` is set from the question
 * (planner/moran.js applyMoran), never by the model, and is not in the
 * decoding schema. A paper-reproduction template sets it directly.
 *
 *   local false  -> statistic: I, E[I], z and p under randomization, pseudo p
 *   local true   -> classes: a diverging series of LISA classes, HH +2, HL +1,
 *                   not significant 0, LH -1, LL -2, with the local I, the
 *                   spatial lag and the pseudo p on every row
 *
 * Both are terminal (they feed an output only): the numbers are computed in
 * Node after the SQL runs, so there is no CTE for a later step to read. A
 * place filter the model put after it is moved before it by code, which is
 * also what the question means (Moran's I "in Texas" is over Texas counties).
 *
 * Gated on asking for it (planner/moran.js asksMoran) and on county_neighbors
 * being loaded, like hotspot. County only: there is no tract adjacency.
 */
module.exports = {
  name: "moran",
  inputs: 1,
  needs: [],
  produces: "statistic",
  kind: "compute",
  // Signed for LISA (HH red, LL blue, not significant neutral).
  diverging: true,
  resultType: (step) => (step && step.local === true ? "classes" : "statistic"),

  enumComment: "Moran's I: is the measure spatially clustered; LISA clusters",
  promptLine: `  moran        1 input                             -> Moran's I: whether the measure
                 is spatially clustered, or its local (LISA) clusters`,
  choiceLine: `  "Moran's I", "LISA", "spatially clustered or random"     -> moran`,

  offered: (ctx) => ctx.hasNeighbors === true && M.asksMoran(ctx.query),

  examples: [{ text:
`QUESTION: is adult obesity spatially clustered across counties (Moran's I)
  (a4 = obesity among adults)
PLAN: {"intent":"Global Moran's I of adult obesity across counties",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a4","inputs":[]},
          {"id":"s2","op":"moran","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  // The browser sends plans back for follow-ups, so these fields are untrusted.
  validate(step) {
    const e = [];
    const where = `step "${step.id}" (moran)`;
    if (step.local !== undefined && typeof step.local !== "boolean") e.push(`${where}: local must be true or false`);
    if (step.alpha !== undefined && !(typeof step.alpha === "number" && step.alpha > 0 && step.alpha <= 0.5)) {
      e.push(`${where}: alpha must be a number in (0, 0.5]`);
    }
    if (step.permutations !== undefined &&
        !(Number.isInteger(step.permutations) && step.permutations >= 0 && step.permutations <= 9999)) {
      e.push(`${where}: permutations must be an integer from 0 to 9999`);
    }
    if (step.weights !== undefined && step.weights !== "queen") {
      e.push(`${where}: only queen contiguity weights are available`);
    }
    if (step.seed !== undefined && !Number.isInteger(step.seed)) e.push(`${where}: seed must be an integer`);
    return e;
  },

  compile(step, ctx) {
    if (ctx.level && ctx.level !== "county") {
      throw new CompileError("Moran's I is available for counties only (county_neighbors)");
    }
    return `${ctx.name} AS (SELECT fips, value FROM ${ctx.ins[0]} WHERE value IS NOT NULL)`;
  },

  /**
   * After execution: `rows` are the output query's rows (fips, name, state_fp,
   * value, geometry), `neighbors` the county adjacency.
   * Returns { rows, rowColumns, stats, moran } for the layer.
   */
  compute(rows, { step, neighbors }) {
    const opts = { permutations: step.permutations ?? 999, alpha: step.alpha ?? 0.05,
                   seed: step.seed ?? 12345 };
    const method = M.describe({ ...step, ...opts });
    if (step.local === true) {
      const r = M.localMoran(rows, neighbors, opts);
      if (!r) return { rows: [], rowColumns: [], stats: null, moran: null };
      const byFips = new Map(r.rows.map(x => [x.fips, x]));
      const out = rows.filter(x => byFips.has(String(x.fips))).map(x => ({ ...x, ...byFips.get(String(x.fips)) }));
      return {
        rows: out,
        rowColumns: ["lisa_class", "local_i", "lag", "p_sim", "quadrant"],
        stats: null,
        moran: { kind: "local", method, classes: M.CLASSES, ...r.summary },
      };
    }
    const g = M.globalMoran(rows, neighbors, opts);
    return {
      // The measure itself, per county, so the card can sit over its map.
      rows,
      rowColumns: [],
      stats: g && { kind: "moran", value: g.I, expected: g.expected, variance: g.variance,
                    z: g.z, p_value: g.p_value, p_sim: g.p_sim, permutations: g.permutations,
                    n: g.n, n_islands: g.n_islands },
      moran: g && { kind: "global", method },
    };
  },
};
