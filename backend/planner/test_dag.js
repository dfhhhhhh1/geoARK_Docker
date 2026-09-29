/**
 * Tests for the op registry and the DAG shape of a plan.
 *
 * The registry is a refactor with one promise -- an op declares itself in one
 * place and every view of it is derived -- so the tests that matter are the
 * ones that check the views AGREE. The prompt and decoding schema disagreeing
 * is not hypothetical here: an op named in the prompt but absent from the enum
 * costs a repair round on a plan the model was never able to emit, and it has
 * happened twice.
 *
 * The DAG tests cover the shapes a linear chain could not express: one step
 * feeding several consumers, several steps converging, and more than one
 * output. Split has always worked structurally, because a step is a named CTE
 * and referencing it twice is free -- these tests exist so it keeps working.
 *
 * Run: node backend/planner/test_dag.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { planSchemaFor } = require("../schemas");
const { buildSystemPrompt } = require("./index");

const SOURCES = new Map([
  ["POV", { source_kind: "acs_long", census_code: "S1701_C03_001E" }],
  ["POP", { source_kind: "acs_long", census_code: "B01003_001E" }],
  ["INC", { source_kind: "acs_long", census_code: "B19013_001E" }],
  ["HOSPITAL", { source_kind: "feature_table", table_name: "hospitals",
                 geom_column: "geom", label_columns: ["name", "city"] }],
]);
const resolve = async (ids) =>
  new Map(ids.filter(i => SOURCES.has(i)).map(i => [i, SOURCES.get(i)]));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });

/** Every narrowing context, so agreement is checked on all branches. */
function allContexts() {
  const out = [];
  for (const hasFeatureTables of [false, true]) {
    for (const featureTableCount of hasFeatureTables ? [1, 2] : [0]) {
      for (const mentionsArea of [false, true]) {
        for (const wantsLocations of [false, true]) {
          for (const hasFilterableValues of [false, true]) {
            for (const hasPlaceBoundaries of [false, true]) {
              out.push({ hasFeatureTables, featureTableCount, mentionsArea,
                         wantsLocations, hasFilterableValues, hasPlaceBoundaries });
            }
          }
        }
      }
    }
  }
  return out;
}

const statPlan = (op) => plan(
  { id: "s1", op: "load", attr_id: "POV", inputs: [] },
  { id: "s2", op, attr_id: "", inputs: ["s1"] },
  { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
);

(async () => {
  // ------------------------------------------------------------- registry
  await test("every registered op declares what the planner needs from it", () => {
    for (const mod of ops.MODULES) {
      assert.ok(mod.name, "an op has no name");
      assert.ok(Number.isInteger(mod.inputs), `${mod.name}: inputs must be a number`);
      assert.ok(Array.isArray(mod.needs), `${mod.name}: needs must be an array`);
      assert.strictEqual(typeof mod.offered, "function", `${mod.name}: no offered()`);
      assert.ok(mod.promptLine, `${mod.name}: no promptLine`);
      // Terminal ops produce nothing and compile to nothing; everything else
      // must be able to emit its own SQL.
      if (mod.terminal) continue;
      const emits = typeof mod.compile === "function"
                 || typeof mod.compileStandalone === "function";
      assert.ok(emits, `${mod.name}: no compile()`);
    }
  });

  await test("every op appears in all four orderings", () => {
    for (const mod of ops.MODULES) {
      for (const [label, order] of [
        ["SCHEMA_ORDER", ops.SCHEMA_ORDER],
        ["PROMPT_ORDER", ops.PROMPT_ORDER],
      ]) {
        assert.ok(order.includes(mod.name), `${mod.name} missing from ${label}`);
      }
      // An op with no phrasing hint is legitimately absent from CHOICE_ORDER,
      // and one with no examples from EXAMPLE_ORDER -- output is both.
      if (mod.choiceLine) {
        assert.ok(ops.CHOICE_ORDER.includes(mod.name),
          `${mod.name} has a choiceLine but is missing from CHOICE_ORDER`);
      }
      if ((mod.examples || []).length) {
        assert.ok(ops.EXAMPLE_ORDER.includes(mod.name),
          `${mod.name} has examples but is missing from EXAMPLE_ORDER`);
      }
    }
  });

  // THE invariant the registry exists to guarantee. These were two
  // hand-maintained lists that had to be kept in step by hand, and were not.
  await test("the prompt never offers an op the decoding schema dropped", () => {
    for (const ctx of allContexts()) {
      const enumOps = planSchemaFor(ctx).properties.steps.items.properties.op.enum;
      const prompt = buildSystemPrompt(ctx);
      for (const mod of ops.MODULES) {
        const inPrompt = prompt.includes(mod.promptLine);
        const inEnum = enumOps.includes(mod.name);
        assert.strictEqual(inPrompt, inEnum,
          `${mod.name}: prompt=${inPrompt} enum=${inEnum} for ${JSON.stringify(ctx)}`);
      }
    }
  });

  await test("a worked example is never shown for an unavailable op", () => {
    for (const ctx of allContexts()) {
      const enumOps = planSchemaFor(ctx).properties.steps.items.properties.op.enum;
      const shown = ops.examplesFor(ops.offeredFor(ctx), ctx);
      for (const mod of ops.MODULES) {
        if (enumOps.includes(mod.name)) continue;
        for (const ex of mod.examples || []) {
          assert.ok(!shown.includes(ex.text),
            `${mod.name}: example shown while the op was dropped`);
        }
      }
    }
  });

  await test("the attribute_filters field and its explanation appear together", () => {
    for (const ctx of allContexts()) {
      const fields = planSchemaFor(ctx).properties.steps.items.properties;
      assert.strictEqual("attribute_filters" in fields, ctx.hasFilterableValues,
        `attribute_filters presence wrong for ${JSON.stringify(ctx)}`);
    }
  });

  // ------------------------------------------------------------------ split
  await test("one step may feed several consumers", async () => {
    // POP is loaded once and read by two different downstream steps.
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "load", attr_id: "POP", inputs: [] },
      { id: "s3", op: "normalize", attr_id: "", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "per_area", attr_id: "", inputs: ["s2"] },
      { id: "s5", op: "join", attr_id: "", inputs: ["s3", "s4"] },
      { id: "s6", op: "output", attr_id: "", inputs: ["s5"] },
    );
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const { sql } = compilePlan(p, v.resolved);
    // The shared step is declared once and referenced twice.
    assert.strictEqual((sql.match(/step_s2 AS \(/g) || []).length, 1,
      "the shared step was declared more than once");
    assert.ok(/FROM step_s2/.test(sql) || /step_s2 d/.test(sql),
      "the shared step is never read");
  });

  // -------------------------------------------------------------- converge
  await test("three sources converge into one series", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "load", attr_id: "POP", inputs: [] },
      { id: "s3", op: "load", attr_id: "INC", inputs: [] },
      { id: "s4", op: "normalize", attr_id: "", inputs: ["s1", "s2"], scale: 100 },
      { id: "s5", op: "join", attr_id: "", inputs: ["s4", "s3"] },
      { id: "s6", op: "output", attr_id: "", inputs: ["s5"] },
    );
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const compiled = compilePlan(p, v.resolved);
    assert.strictEqual(compiled.outputs.length, 1);
    assert.strictEqual(compiled.series, 2, "the converged join should carry both measures");
  });

  // ------------------------------------------------------- multiple outputs
  await test("two outputs compile to two statements over one prelude", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "load", attr_id: "POP", inputs: [] },
      { id: "s3", op: "normalize", attr_id: "", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
      { id: "s5", op: "rank", attr_id: "", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s6", op: "output", attr_id: "", inputs: ["s5"] },
    );
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const compiled = compilePlan(p, v.resolved);
    // Two explicit outputs, plus the two inputs of the normalize the first one
    // reads: an arithmetic result is not interpretable without its parts.
    assert.strictEqual(compiled.outputs.length, 4);
    assert.strictEqual(compiled.outputs.filter(o => o.part).length, 2);
    for (const out of compiled.outputs) {
      assert.match(out.sql, /^WITH /, "each output must carry its own prelude");
      assert.strictEqual(out.mode, "values");
    }
    assert.match(compiled.outputs[0].sql, /FROM step_s3 r/);
    assert.match(compiled.outputs[1].sql, /FROM step_s5 r/);
    // Each statement carries its OWN parameter list. Sharing one was a real
    // bug: each prelude is pruned to the CTEs it reaches, so a shared list
    // keeps bindings for CTEs the statement does not declare and Postgres
    // rejects the mismatch at execution.
    assert.notStrictEqual(compiled.outputs[0].params, compiled.outputs[1].params);
    for (const out of compiled.outputs) {
      const highest = [...out.sql.matchAll(/\$(\d+)/g)]
        .reduce((m, x) => Math.max(m, Number(x[1])), 0);
      assert.strictEqual(highest, out.params.length,
        `output ${out.id} references $1..$${highest} but binds ${out.params.length}`);
    }
  });

  await test("a values layer and a features layer coexist as separate outputs", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "load", attr_id: "POV", inputs: [] },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
    );
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const compiled = compilePlan(p, v.resolved);
    assert.deepStrictEqual(compiled.outputs.map(o => o.mode), ["features", "values"]);
    // The features statement is standalone: no prelude, and its own params.
    assert.ok(!/^WITH /.test(compiled.outputs[0].sql));
    assert.notStrictEqual(compiled.outputs[0].params, compiled.outputs[1].params);
  });

  await test("the flat single-layer shape is unchanged for a one-output plan", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    const compiled = compilePlan(p, v.resolved);
    assert.strictEqual(compiled.outputs.length, 1);
    assert.strictEqual(compiled.sql, compiled.outputs[0].sql);
    assert.strictEqual(compiled.mode, "values");
  });

  // A features step may sit ALONGSIDE a value series now, but still may not be
  // chained into one -- it has no county key for per_area to divide.
  await test("a features step still refuses to be chained", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [] },
      { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /cannot be combined with per_area/);
  });

  await test("a features step that no output reads is rejected", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [] },
      { id: "s2", op: "load", attr_id: "POV", inputs: [] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /never used by an output step/);
  });

  await test("two outputs may not name the same step", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /Each output must name a different step/);
  });

  await test("a plan must still end on an output", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 5 },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /must be last/);
  });

  // ---------------------------------------------------------------- combine
  //
  // Exercised as a module, because it is deliberately NOT registered: adding an
  // op is the change the op-budget measurement exists to gate, so it goes in
  // behind its own plan_probe run rather than riding along with a refactor.
  // These tests mean that when it is registered, its SQL is already known good.
  const combine = require("./ops/combine");

  /** A full two-load combine plan, for the end-to-end parameter check. */
  const statCombine = (operation) => plan(
    { id: "s1", op: "load", attr_id: "POV", inputs: [], year: 2013 },
    { id: "s2", op: "load", attr_id: "POV", inputs: [], year: 2023 },
    { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
  );

  const compileCombine = (step) => {
    const params = [];
    const ctx = {
      name: "step_s3",
      ins: ["step_s1", "step_s2"],
      bind: (v) => { params.push(v); return `$${params.length}`; },
    };
    return { sql: combine.compile(step, ctx), params };
  };

  await test("combine emits each of its four operations", () => {
    const cases = {
      ratio: /a\.value \/ NULLIF\(b\.value, 0\) \* \$1/,
      sum: /a\.value \+ b\.value/,
      difference: /a\.value - b\.value/,
      percent_change: /\(b\.value - a\.value\) \/ NULLIF\(a\.value, 0\) \* 100/,
    };
    for (const [operation, pattern] of Object.entries(cases)) {
      const { sql } = compileCombine({ id: "s3", operation, inputs: ["s1", "s2"] });
      assert.match(sql, pattern, `combine ${operation} emitted the wrong expression`);
      assert.match(sql, /JOIN step_s2 b USING \(fips\)/);
    }
  });

  await test("combine binds its scale rather than interpolating it", () => {
    const { params } = compileCombine(
      { id: "s3", operation: "ratio", scale: 100, inputs: ["s1", "s2"] });
    assert.deepStrictEqual(params, [100]);
  });

  // A bound parameter the SQL never references is not harmless: Postgres
  // rejects the statement at EXECUTION -- "bind message supplies 3 parameters,
  // but prepared statement requires 2" -- on a plan that validated and
  // compiled. combine did exactly this, binding `scale` for operations whose
  // expression ignores it. Checked across every op, because nothing about the
  // mistake was specific to combine.
  await test("every op binds exactly the parameters its SQL uses", async () => {
    const plans = {
      "combine ratio": statCombine("ratio"),
      "combine sum": statCombine("sum"),
      "combine difference": statCombine("difference"),
      "combine percent_change": statCombine("percent_change"),
      hotspot: statPlan("hotspot"),
      outlier: statPlan("outlier"),
      "load with year": plan(
        { id: "s1", op: "load", attr_id: "POV", inputs: [], year: 2019 },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] }),
      "rank": plan(
        { id: "s1", op: "load", attr_id: "POV", inputs: [] },
        { id: "s2", op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 5 },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }),
      "filter_area": plan(
        { id: "s1", op: "load", attr_id: "POV", inputs: [] },
        { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }),
    };
    for (const [label, p] of Object.entries(plans)) {
      const v = await validatePlan(p, resolve);
      assert.ok(v.ok, `${label}: ${v.errors.join("; ")}`);
      for (const out of compilePlan(p, v.resolved).outputs) {
        const highest = [...out.sql.matchAll(/\$(\d+)/g)]
          .reduce((m, x) => Math.max(m, Number(x[1])), 0);
        assert.strictEqual(highest, out.params.length,
          `${label}: SQL references $1..$${highest} but ${out.params.length} ` +
          `parameter(s) are bound`);
      }
    }
  });

  await test("combine refuses an operation with no implementation", () => {
    assert.deepStrictEqual(
      combine.validate({ id: "s3", operation: "exponentiate" }).length, 1);
    assert.throws(
      () => compileCombine({ id: "s3", operation: "'; DROP TABLE county_geom; --" }),
      /unsupported combine operation/);
  });

  await test("combine divides by zero safely, like normalize", () => {
    for (const operation of ["ratio", "percent_change"]) {
      const { sql } = compileCombine({ id: "s3", operation, inputs: ["s1", "s2"] });
      assert.match(sql, /NULLIF/, `${operation} must guard division by zero`);
    }
  });

  // ------------------------------------------------------------- statistics
  await test("hotspot builds Gi* over the adjacency table", async () => {
    const p = statPlan("hotspot");
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, /county_neighbors/, "lost the weights matrix");
    assert.match(sql, /LEFT JOIN county_neighbors/,
      "an inner join would silently drop the 20 counties that have no neighbours");
    assert.match(sql, /stddev_pop/,
      "Gi* is defined over all observations, not a sample");
    // The county itself must be in its own neighbourhood -- that is the star.
    assert.match(sql, /a\.value \+ COALESCE\(sum\(b\.value\)/);
  });

  await test("outlier keeps only the unusual counties, robustly", async () => {
    const p = statPlan("outlier");
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, /percentile_cont\(0\.25\)/);
    assert.match(sql, /percentile_cont\(0\.75\)/);
    assert.match(sql, /1\.5 \* \(q\.q3 - q\.q1\)/, "lost the Tukey fence");
    // A zero IQR would otherwise mark every county that differs at all.
    assert.match(sql, /q\.q3 > q\.q1/, "lost the degenerate-distribution guard");
    assert.ok(!/\bavg\(/.test(sql) && !/stddev/.test(sql),
      "a mean or sd is dragged by the very outliers this op looks for");
  });

  await test("the statistics ops compose with the rest of the chain", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "hotspot", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Missouri"] },
      { id: "s4", op: "rank", attr_id: "", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s5", op: "output", attr_id: "", inputs: ["s4"] },
    );
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const compiled = compilePlan(p, v.resolved);
    assert.match(compiled.sql, /FROM step_s4 r/);
    // Only the op that produced the FINAL layer decides how it is read; a
    // hotspot consumed by rank still yields Gi* values, so it stays diverging.
    assert.strictEqual(compiled.outputs[0].diverging, false,
      "rank is the producing op here, and rank is not a signed measure");
  });

  await test("a signed measure declares itself for the renderer", async () => {
    for (const op of ["hotspot", "outlier"]) {
      const p = statPlan(op);
      const v = await validatePlan(p, resolve);
      const compiled = compilePlan(p, v.resolved);
      assert.strictEqual(compiled.outputs[0].diverging, true,
        `${op} must tell the frontend to diverge around zero`);
      assert.ok(compiled.outputs[0].valueLabel, `${op} must name its unit`);
    }
  });

  // The gates are what let three ops be added without enlarging the decision
  // space on the queries that already worked.
  await test("the statistics ops are absent unless the question asks for them", () => {
    const base = {
      hasFeatureTables: false, featureTableCount: 0, mentionsArea: false,
      wantsLocations: false, hasFilterableValues: false,
      hasPlaceBoundaries: false, hasNeighbors: true,
    };
    const offeredFor = (query) => ops.offeredFor({ ...base, query });

    for (const q of ["median household income by county",
                     "the 10 counties with the highest poverty rate",
                     "how many hospitals are in each county"]) {
      const got = offeredFor(q);
      for (const op of ["hotspot", "outlier", "combine"]) {
        assert.ok(!got.includes(op), `${op} leaked into "${q}"`);
      }
    }

    assert.ok(offeredFor("where are the hot spots of poverty").includes("hotspot"));
    assert.ok(offeredFor("which counties are outliers for income").includes("outlier"));
    assert.ok(offeredFor("the difference between poverty and unemployment").includes("combine"));
  });

  await test("hotspot is withheld when adjacency was never built", () => {
    const ctx = {
      hasFeatureTables: false, featureTableCount: 0, mentionsArea: false,
      wantsLocations: false, hasFilterableValues: false, hasPlaceBoundaries: false,
      query: "where are the hot spots of poverty",
    };
    assert.ok(!ops.offeredFor({ ...ctx, hasNeighbors: false }).includes("hotspot"),
      "offering hotspot with no weights matrix gives the model an op that can only fail");
    assert.ok(ops.offeredFor({ ...ctx, hasNeighbors: true }).includes("hotspot"));
  });

  // ------------------------------------------------- relative time
  //
  // Held-out queries showed the year field going unused whenever the period was
  // relative: "since 2010" and "over the last decade" both planned two
  // DIFFERENT attributes divided by each other, which is not a trend under any
  // reading. Resolved deterministically rather than by prompting, because the
  // years are in the database and asking the model to guess at an anchor the
  // text does not contain is asking it to invent one.
  const { resolveRelativeYears } = require("./index");
  const nowYear = new Date().getFullYear();

  const trendPlan = (a, b, op = "normalize") => plan(
    { id: "s1", op: "load", attr_id: a, inputs: [] },
    { id: "s2", op: "load", attr_id: b, inputs: [] },
    { id: "s3", op, attr_id: "", inputs: ["s1", "s2"], scale: 100 },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
  );

  await test('"since 2010" becomes one measure at two points in time', () => {
    const p = trendPlan("POV", "INC");
    assert.ok(resolveRelativeYears(p, "has poverty gotten worse since 2010"));
    assert.strictEqual(p.steps[0].year, 2010);
    assert.strictEqual(p.steps[1].attr_id, "POV",
      "the second load must read the SAME measure, not a different one");
    assert.strictEqual(p.steps[1].year, undefined,
      "the later end is unset so the compiler takes each measure's latest year");
    assert.strictEqual(p.steps[2].op, "combine");
    assert.strictEqual(p.steps[2].operation, "percent_change");
  });

  await test('"over the last decade" anchors to the current year', () => {
    const p = trendPlan("POV", "INC");
    assert.ok(resolveRelativeYears(p, "biggest increase in poverty over the last decade"));
    assert.strictEqual(p.steps[0].year, nowYear - 10);
  });

  await test("two named years are used as the span", () => {
    const p = trendPlan("POV", "POV", "combine");
    assert.ok(resolveRelativeYears(p, "change in poverty from 2007 to 2023"));
    assert.deepStrictEqual([p.steps[0].year, p.steps[1].year], [2007, 2023]);
  });

  await test("a single year on a single load is stamped", () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    assert.ok(resolveRelativeYears(p, "what was the poverty rate in 2009"));
    assert.strictEqual(p.steps[0].year, 2009);
  });

  // It must not fire on questions that are not about time, and must not
  // overrule a model that already answered the question itself.
  await test("a question with no time reference is left alone", () => {
    const p = trendPlan("POV", "INC");
    assert.strictEqual(resolveRelativeYears(p, "poverty rate divided by population"), null);
    assert.strictEqual(p.steps[0].year, undefined);
    assert.strictEqual(p.steps[1].attr_id, "INC", "a genuine ratio must survive");
  });

  await test("years the model already set are not overwritten", () => {
    const p = trendPlan("POV", "POV", "combine");
    p.steps[0].year = 2015;
    assert.strictEqual(resolveRelativeYears(p, "poverty since 2010"), null);
    assert.strictEqual(p.steps[0].year, 2015);
  });

  // ------------------------------------------------------------- correlate
  const corr = ops.byName("correlate");
  const corrPlan = (...extra) => plan(
    { id: "s1", op: "load", attr_id: "POV", inputs: [] },
    { id: "s2", op: "load", attr_id: "INC", inputs: [] },
    { id: "s3", op: "correlate", attr_id: "", inputs: ["s1", "s2"] },
    ...(extra.length ? extra : [{ id: "s4", op: "output", attr_id: "", inputs: ["s3"] }]),
  );

  await test("correlate is offered only for relationship questions, with adjacency", () => {
    const yes = ["is obesity related to diabetes", "correlation between income and asthma",
                 "does smoking go with COPD", "how does poverty affect life expectancy",
                 "the higher the income, the lower the diabetes rate"];
    const no = ["median household income by county", "compare obesity and poverty by county",
                "How far do people in rural counties have to drive to a hospital?",
                "where are the hot spots of poverty", "top 10 counties by unemployment"];
    for (const q of yes) assert.ok(corr.offered({ query: q, hasNeighbors: true }), q);
    for (const q of no) assert.ok(!corr.offered({ query: q, hasNeighbors: true }), q);
    // n_effective needs county_neighbors; never offer an op that can only fail.
    assert.ok(!corr.offered({ query: yes[0], hasNeighbors: false }));
  });

  await test("correlate compiles to one row carrying its statistics", async () => {
    const p = corrPlan();
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    for (const col of corr.STAT_COLUMNS) {
      assert.ok(c.sql.includes(`r.${col},`), `final SELECT lacks ${col}`);
    }
    assert.deepStrictEqual(c.outputs[0].statColumns, corr.STAT_COLUMNS);
    // Every bound parameter is referenced, and nothing references a missing one.
    const refs = new Set((c.sql.match(/\$\d+/g) || []).map(s => Number(s.slice(1))));
    assert.strictEqual(Math.max(0, ...refs), c.params.length);
  });

  await test("a statistic cannot be chained into a per-county op", async () => {
    const p = corrPlan(
      { id: "s4", op: "rank", attr_id: "", inputs: ["s3"], limit: 5 },
      { id: "s5", op: "output", attr_id: "", inputs: ["s4"] });
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => /one summary row/.test(e)), v.errors.join("; "));
  });

  await test("correlate refuses a measure against itself", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "correlate", attr_id: "", inputs: ["s1", "s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    assert.ok(v.errors.some(e => /DIFFERENT measures/.test(e)), v.errors.join("; "));
  });

  await test("per-county layers carry no statColumns", async () => {
    const p = statPlan("rank");
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    assert.deepStrictEqual(c.outputs[0].statColumns, []);
    assert.ok(!/r\.p_value/.test(c.sql));
  });

  // --------------------------------------------------------------- explain
  const ex = ops.byName("explain");
  const INCOME = ex.DEFAULT_CONTROLS[0];

  await test("explain is offered for why-questions, not for two named measures", () => {
    const yes = ["what explains diabetes rates across counties", "risk factors for heart disease",
                 "what drives obesity", "why are asthma rates higher in some counties"];
    const no = ["is obesity related to diabetes", "median household income by county",
                "where are the hot spots of poverty"];
    for (const q of yes) assert.ok(ex.offered({ query: q, hasNeighbors: true }), q);
    for (const q of no) assert.ok(!ex.offered({ query: q, hasNeighbors: true }), q);
    assert.ok(!ex.offered({ query: yes[0], hasNeighbors: false }));
  });

  await test("chooseFactors: literature first, then named concepts, never the outcome or a control", () => {
    const cand = (id, extra = {}) => ({ attr_id: id, attr_desc: id, ...extra });
    const candidates = [cand("DIAB"), cand("OBES"), cand("SMOK"), cand("POVR"), cand(INCOME),
                        cand("HOSP", { is_feature_table: true })];
    const resultsByQuery = [
      { query: "diabetes", purpose: "primary", results: [{ attr_id: "DIAB" }] },
      { query: "poverty", purpose: "primary", results: [{ attr_id: "POVR" }] },
      { query: "Obesity", purpose: "expanded", results: [{ attr_id: "OBES" }] },
      { query: "Smoking", purpose: "expanded", results: [{ attr_id: INCOME }, { attr_id: "SMOK" }] },
      { query: "hospitals", purpose: "primary", results: [{ attr_id: "HOSP" }] },
    ];
    const expansion = { concepts: [{ name: "Obesity", kept: true, support: 180, seed: "Diabetes",
                                     predicates: ["PREDISPOSES"], roles: ["cause"] }] };
    const f = ex.chooseFactors({ outcomeAttrId: "DIAB", candidates, resultsByQuery, expansion });
    const factors = f.filter(x => x.role === "factor");
    assert.deepStrictEqual(factors.map(x => x.attr_id), ["OBES", "SMOK", "POVR"]);
    assert.strictEqual(factors[0].literature.papers, 180);
    assert.ok(f.filter(x => x.role === "control").some(x => x.attr_id === INCOME));
    assert.ok(!factors.some(x => x.attr_id === "HOSP"), "a facility layer is not a value series");
  });

  await test("chooseFactors ignores sub-queries that only restate the why-question", () => {
    const candidates = [{ attr_id: "OBES", attr_desc: "obesity" }, { attr_id: "DRIVE", attr_desc: "Driving alone to work" }];
    const resultsByQuery = [
      { query: "obesity", purpose: "primary", results: [{ attr_id: "OBES" }] },
      { query: "drivers", purpose: "primary", results: [{ attr_id: "DRIVE" }] },
    ];
    const f = ex.chooseFactors({ outcomeAttrId: "OBES", candidates, resultsByQuery });
    assert.ok(!f.some(x => x.attr_id === "DRIVE"), "a verb is not a factor");
  });

  await test("chooseFactors falls back to the default covariates when the question yields none", () => {
    const f = ex.chooseFactors({ outcomeAttrId: "UNEMP", candidates: [], resultsByQuery: [] });
    assert.ok(f.filter(x => x.role === "factor").length >= 3);
    assert.ok(f.every(x => x.attr_id !== "UNEMP"));
  });

  await test("explain compiles to one matrix query with every bind referenced", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "explain", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    p.steps[1].factors = [{ attr_id: "INC", role: "factor" }, { attr_id: "POP", role: "control" }];
    // Factors are resolved by the server after validation; mirror that here.
    for (const [k, val] of await resolve(["INC", "POP"])) v.resolved.set(k, val);
    const c = compilePlan(p, v.resolved);
    const out = c.outputs[0];
    assert.strictEqual(out.mode, "factors");
    assert.match(out.sql, /SELECT o\.fips, o\.value::float8 AS y, fx_0\.value::float8 AS v0, fx_1/);
    const refs = new Set((out.sql.match(/\$\d+/g) || []).map(s => Number(s.slice(1))));
    assert.strictEqual(Math.max(0, ...refs), out.params.length);
  });

  await test("explain cannot feed anything but an output", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "explain", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "rank", attr_id: "", inputs: ["s2"] },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] });
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
  });

  await test("compute: a true driver outranks a factor that is only confounded by income", () => {
    // Deterministic synthetic counties on a line, so the adjacency is real.
    let s = 42;
    const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
    const n = 1500, rows = [], neighbors = new Map();
    for (let i = 0; i < n; i++) {
      const income = g();
      const driver = g();
      const confounded = income + 0.4 * g();          // tracks income, no effect of its own
      const copy = 0;                                  // filled below
      rows.push({ fips: String(i), income, driver, confounded, copy });
      neighbors.set(String(i), [i - 1, i + 1].filter(j => j >= 0 && j < n).map(String));
    }
    for (const row of rows) row.y = -0.8 * row.income + 0.6 * row.driver + 0.3 * g();
    for (const row of rows) row.copy = row.y + 0.01 * g();   // the outcome under another name
    const factors = [
      { attr_id: "CONF", role: "factor" }, { attr_id: "DRIV", role: "factor" },
      { attr_id: "COPY", role: "factor" }, { attr_id: "INC2", role: "factor" },
      { attr_id: INCOME, role: "control" }];
    const matrix = rows.map(x => ({ fips: x.fips, y: x.y, v0: x.confounded, v1: x.driver,
                                    v2: x.copy, v3: x.income + 0.01 * g(), v4: x.income }));
    const res = ex.compute(matrix, { factors, neighbors });
    const byId = Object.fromEntries(res.factors.map(f => [f.attr_id, f]));
    assert.strictEqual(res.factors[0].attr_id, "DRIV", "the true driver ranks first");
    assert.ok(Math.abs(byId.CONF.rho) > 0.5, "confounded factor looks strong without controls");
    assert.ok(Math.abs(byId.CONF.partial_rho) < 0.08, `and vanishes with them: ${byId.CONF.partial_rho}`);
    assert.strictEqual(byId.COPY.status, "same_measure_as_outcome");
    // A second income measure is the control under another name: reported, not fitted.
    assert.strictEqual(byId.INC2.status, "same_measure_as_control");
    assert.ok(byId.DRIV.q_value < 0.001 && byId.DRIV.importance > 0.5);
  });

  await test("compute: a factor the literature calls a consequence is context, not a ranked driver", () => {
    const n = 300, rows = [], neighbors = new Map();
    for (let i = 0; i < n; i++) {
      const a = Math.sin(i), b = Math.cos(i * 1.7), c = Math.sin(i * 0.3);
      rows.push({ fips: String(i), y: a + b, v0: a + 0.1 * c, v1: b + 0.1 * c, v2: c });
      neighbors.set(String(i), []);
    }
    const res = ex.compute(rows, { neighbors, factors: [
      { attr_id: "CAUSE", role: "factor", literature: { direction: "cause" } },
      { attr_id: "CONSEQ", role: "factor", literature: { direction: "effect" } },
      { attr_id: INCOME, role: "control" }] });
    const byId = Object.fromEntries(res.factors.map(f => [f.attr_id, f]));
    assert.strictEqual(byId.CAUSE.rank, 1);
    assert.strictEqual(byId.CONSEQ.rank, undefined);
    assert.strictEqual(byId.CONSEQ.context, "consequence");
    assert.ok(typeof byId.CONSEQ.q_value === "number", "still tested and adjusted");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
