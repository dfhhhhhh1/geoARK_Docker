const { CompileError } = require("./_sql");

/**
 * Arithmetic on two series.
 *
 * ONE op with an `operation` field rather than four ops, deliberately. Op-set
 * size costs accuracy on its own -- 7 ops to 8 coincided with plan validity
 * falling from 62.5% to 12.5% -- while a field is a cheaper choice for the
 * model: it has already decided to combine two things, and only has to say how.
 * Four sibling ops would spend that budget four times over.
 *
 * `ratio` overlaps `normalize`, which is the older, narrower op for the same
 * arithmetic. They coexist on purpose: normalize carries the worked example
 * that teaches "rate" and "per capita", and retiring it is a prompt change that
 * has to be measured on its own rather than smuggled in alongside a new op.
 * The gate below keeps them from competing on the same questions -- combine
 * only appears when the phrasing is about differences and changes, which
 * normalize has never covered.
 */
/**
 * `scaled` is not decoration. The compiler must bind a parameter only if the
 * expression actually references it: binding `scale` for every operation put
 * three parameters on a statement with two placeholders, and Postgres rejected
 * it at execution with "bind message supplies 3 parameters, but prepared
 * statement requires 2" -- on a plan that had validated and compiled.
 */
const OPERATIONS = {
  // NULLIF guards division by zero, which is common: many ACS denominators are
  // legitimately 0 for small counties.
  ratio: { scaled: true, expr: (a, b, scale) => `${a}.value / NULLIF(${b}.value, 0) * ${scale}` },
  sum: { scaled: false, expr: (a, b) => `${a}.value + ${b}.value` },
  difference: { scaled: false, expr: (a, b) => `${a}.value - ${b}.value` },
  // Input 1 is the baseline, input 2 the later value, so the sign reads the way
  // "change from A to B" does. The 100 is a constant, not a parameter.
  percent_change: {
    scaled: false,
    expr: (a, b) => `(${b}.value - ${a}.value) / NULLIF(${a}.value, 0) * 100`,
  },
};

module.exports = {
  name: "combine",
  inputs: 2,
  needs: ["operation"],
  produces: "series",
  kind: "sql",

  enumComment: "ratio | sum | difference | percent_change of two steps",
  promptLine: `  combine      needs operation, 2 inputs           -> ratio, sum, difference or
                 percent_change of the two, as one series`,
  choiceLine: `  "difference between", "total of A and B", "change from A to B" -> combine`,

  // Gated on arithmetic phrasing, so it does not enlarge the decision space on
  // the many questions that have no second series to combine with.
  offered: (ctx) =>
    /\b(difference|differ|minus|subtract|change\s+(from|in|between)|combined|sum\s+of|total\s+of|added|plus|versus\s+.*\bchange)\b/i
      .test(String(ctx.query || "")),

  examples: [
    // Shown only when the year field is on offer. Without it the ONLY combine
    // example loads two DIFFERENT attributes, and the model copies that shape
    // for time questions too: "percent change in unemployment from 2007 to
    // 2023" planned unemployment-rate against a County-Health-Rankings
    // unemployment measure and produced -99% everywhere. Valid, executable,
    // and answering a question nobody asked.
    { usesYear: true, text:
`QUESTION: percent change in the unemployment rate from 2007 to 2023
  (a2 = unemployment rate)
PLAN: {"intent":"Percent change in the unemployment rate from 2007 to 2023, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[],"year":2007},
          {"id":"s2","op":"load","attr_id":"a2","inputs":[],"year":2023},
          {"id":"s3","op":"combine","attr_id":"","inputs":["s1","s2"],"operation":"percent_change"},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}
  NOTE: the SAME attr_id twice, with different years. A change over time
  compares one measure against itself, never two different attributes.` },

    { text:
`QUESTION: the difference between the poverty rate and the unemployment rate
  (a3 = poverty rate, a1 = unemployment rate)
PLAN: {"intent":"Poverty rate minus unemployment rate, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a1","inputs":[]},
          {"id":"s3","op":"combine","attr_id":"","inputs":["s1","s2"],"operation":"difference"},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` },
  ],

  validate(step) {
    // Checked here as well as in the decoding enum, because the enum only
    // constrains generation -- a repaired plan or a non-constrained caller can
    // still carry an operation that has no implementation.
    if (step.operation && !OPERATIONS[step.operation]) {
      return [
        `step "${step.id}" (combine): unknown operation ${JSON.stringify(step.operation)}. ` +
        `Use one of: ${Object.keys(OPERATIONS).join(", ")}.`,
      ];
    }
    return [];
  },

  compile(step, ctx) {
    const op = OPERATIONS[step.operation];
    if (!op) throw new CompileError(`unsupported combine operation ${step.operation}`);
    // Bound, like every other literal -- but ONLY when the expression uses it.
    const expr = op.scaled
      ? op.expr("a", "b", ctx.bind(step.scale ?? 1))
      : op.expr("a", "b");
    return `${ctx.name} AS (SELECT a.fips, ${expr} AS value ` +
           `FROM ${ctx.ins[0]} a JOIN ${ctx.ins[1]} b USING (fips))`;
  },
};
