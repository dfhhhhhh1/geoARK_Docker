/**
 * Tests for the plan validator and SQL compiler.
 *
 * These two modules are the boundary between "text a language model produced"
 * and "a query that runs against the database", so they get tested directly.
 * Run: node backend/planner/test_planner.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan, CompileError } = require("./compile");

const SOURCES = new Map([
  ["POV", { source_kind: "acs_long", census_code: "S1701_C03_001E" }],
  ["POP", { source_kind: "acs_long", census_code: "B01003_001E" }],
  ["REFINERY", { source_kind: "feature_table", table_name: "oil_refineries",
                 geom_column: "geom" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SOURCES.has(i)).map(i => [i, SOURCES.get(i)]));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });

(async () => {
  // ---------------------------------------------------------------- validate
  await test("accepts a well-formed grounded plan", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "load", attr_id: "POP" },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), resolve);
    assert.deepStrictEqual(r.errors, []);
    assert.ok(r.ok);
  });

  await test("rejects a hallucinated attr_id", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "TOTALLY_MADE_UP" },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /not a known attribute/);
  });

  await test("rejects a forward reference", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "normalize", inputs: ["s2", "s3"] },
      { id: "s2", op: "load", attr_id: "POV" },
      { id: "s3", op: "load", attr_id: "POP" },
      { id: "s4", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /defined later/);
  });

  await test("rejects an unknown op", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "drop_table", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /unknown op/);
  });

  await test("rejects wrong input arity", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "normalize", inputs: ["s1"] },     // needs 2
      { id: "s3", op: "output", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /expects 2 input/);
  });

  await test("rejects a missing required field", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "filter_attr", inputs: ["s1"] },   // no operator/value
      { id: "s3", op: "output", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /missing required field/);
  });

  await test("requires exactly one terminal output", async () => {
    const none = await validatePlan(plan({ id: "s1", op: "load", attr_id: "POV" }), resolve);
    assert.match(none.errors.join(" "), /must end with an "output" step/);

    const notLast = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "output", inputs: ["s1"] },
      { id: "s3", op: "rank", inputs: ["s1"] },
    ), resolve);
    assert.match(notLast.errors.join(" "), /must be last/);
  });

  await test("rejects duplicate step ids", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s1", op: "load", attr_id: "POP" },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.match(r.errors.join(" "), /duplicate step id/);
  });

  // ----------------------------------------------------------------- compile
  await test("compiles to parameterized SQL with no inlined literals", () => {
    const { sql, params } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "load", attr_id: "POP" },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "rank", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s5", op: "output", inputs: ["s4"] },
    ), SOURCES);
    assert.match(sql, /census_code = \$1/);
    assert.deepStrictEqual(params, ["S1701_C03_001E", "B01003_001E", 100, 10]);
    // The census codes must appear ONLY as bound params, never in the text.
    assert.ok(!sql.includes("S1701_C03_001E"));
  });

  await test("normalize guards division by zero", () => {
    const { sql } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "load", attr_id: "POP" },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), SOURCES);
    assert.match(sql, /NULLIF\(d\.value, 0\)/);
  });

  await test("refuses an unsafe step id (SQL identifier injection)", () => {
    assert.throws(() => compilePlan(plan(
      { id: 'x"; DROP TABLE county_geom; --', op: "load", attr_id: "POV" },
      { id: "s2", op: "output", inputs: ['x"; DROP TABLE county_geom; --'] },
    ), SOURCES), CompileError);
  });

  await test("refuses an operator outside the allow-list", () => {
    assert.throws(() => compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "filter_attr", inputs: ["s1"], operator: "; DROP TABLE x; --", value: 1 },
      { id: "s3", op: "output", inputs: ["s2"] },
    ), SOURCES), CompileError);
  });

  await test("refuses an aggregate outside the allow-list", () => {
    assert.throws(() => compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "aggregate", inputs: ["s1"], function: "system" },
      { id: "s3", op: "output", inputs: ["s2"] },
    ), SOURCES), CompileError);
  });

  await test("clamps an absurd rank limit", () => {
    const { params } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "rank", inputs: ["s1"], direction: "desc", limit: 999999999 },
      { id: "s3", op: "output", inputs: ["s2"] },
    ), SOURCES);
    assert.ok(params.includes(1000), `expected clamp to 1000, got ${params}`);
  });

  // ------------------------------------------------- feature tables
  await test("rejects load on a feature table", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "REFINERY", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /Use op "count_features"/);
  });

  await test("rejects count_features on a value series", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "count_features", attr_id: "POV", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /Use op "load"/);
  });

  await test("compiles count_features to a spatial aggregation", () => {
    const { sql } = compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "REFINERY", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), SOURCES);
    // The facility geometry must NOT be wrapped in ST_Transform: that would
    // make the predicate non-sargable and disable its GIST index.
    assert.match(sql, /ST_Intersects\(c\.geom, f\.geom\)/);
    assert.ok(!/ST_Transform\(f\./.test(sql), "facility geom must not be transformed");
    assert.match(sql, /LEFT JOIN oil_refineries/);   // zero-count counties survive
    assert.match(sql, /COUNT\(f\.\*\)/);
  });

  await test("facility counts compose with normalize (per-capita)", () => {
    const { sql, params } = compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "REFINERY", inputs: [] },
      { id: "s2", op: "load", attr_id: "POP", inputs: [] },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100000 },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), SOURCES);
    assert.match(sql, /NULLIF\(d\.value, 0\)/);
    assert.ok(params.includes(100000));
  });

  await test("transforms the county side when SRIDs differ", () => {
    const proj = new Map([["P", { source_kind: "feature_table", table_name: "p_tbl",
                                  geom_column: "geom", srid: 3857 }]]);
    const { sql } = compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "P", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), proj);
    assert.match(sql, /ST_Transform\(c\.geom, 3857\)/);
    assert.ok(!/ST_Transform\(f\./.test(sql));
  });

  await test("refuses an unsafe table name from attribute_source", () => {
    const bad = new Map([["X", { source_kind: "feature_table",
      table_name: 'x"; DROP TABLE county_geom; --', geom_column: "geom" }]]);
    assert.throws(() => compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "X", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), bad), CompileError);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
