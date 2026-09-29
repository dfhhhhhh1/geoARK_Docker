/**
 * Tests for the plan validator and SQL compiler.
 *
 * These two modules are the boundary between "text a language model produced"
 * and "a query that runs against the database", so they get tested directly.
 * Run: node backend/planner/test_planner.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan, CompileError, MAX_FEATURES } = require("./compile");

const SOURCES = new Map([
  ["POV", { source_kind: "acs_long", census_code: "S1701_C03_001E" }],
  ["POP", { source_kind: "acs_long", census_code: "B01003_001E" }],
  ["REFINERY", { source_kind: "feature_table", table_name: "oil_refineries",
                 geom_column: "geom" }],
  // A second feature table, so proximity between two datasets is testable.
  ["PIPELINE", { source_kind: "feature_table", table_name: "natural_gas_pipelines",
                 geom_column: "geom" }],
  // Carries label columns, so select_features can be tested against a layer
  // that has them AND one (REFINERY) that does not.
  ["HOSPITAL", { source_kind: "feature_table", table_name: "hospitals",
                 geom_column: "geom",
                 label_columns: ["name", "city", "state", "type", "status"],
                 filter_values: {
                   type: ["GENERAL ACUTE CARE", "CRITICAL ACCESS", "PSYCHIATRIC"],
                   status: ["OPEN", "CLOSED"],
                 } }],
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

  // A join that reaches the output is how "population AND poverty rate" comes
  // back as one result with two numbers per county. The second column was
  // always computed; the final SELECT used to drop it, so the map could only
  // ever show half of what was asked for.
  await test("a join at the output keeps both measures", () => {
    const { sql, series } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "load", attr_id: "POP" },
      { id: "s3", op: "join", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), SOURCES);
    assert.match(sql, /r\.value_b/, "the second measure never reached the SELECT");
    assert.strictEqual(series, 2);
  });

  // The guard that makes the above safe: every other op selects (fips, value)
  // explicitly, so it DROPS value_b. Emitting r.value_b for those would be a
  // SQL error at runtime rather than a wrong number, on a query that validated.
  await test("a join consumed by a later step exposes one measure", () => {
    const { sql, series } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "load", attr_id: "POP" },
      { id: "s3", op: "join", inputs: ["s1", "s2"] },
      { id: "s4", op: "rank", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s5", op: "output", inputs: ["s4"] },
    ), SOURCES);
    assert.ok(!/r\.value_b/.test(sql),
      "selected value_b from a CTE that does not have it");
    assert.strictEqual(series, 1);
  });

  await test("a single-measure plan is unchanged", () => {
    const { sql, series } = compilePlan(plan(
      { id: "s1", op: "load", attr_id: "POV" },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), SOURCES);
    assert.ok(!/value_b/.test(sql));
    assert.strictEqual(series, 1);
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

  await test("accepts a real ETL table name (50 chars)", () => {
    // Regression: a 31-char cap rejected legitimate tables such as
    // c862525677cf485a84b2ba86a78e277d_histtornadotracks.
    const long = new Map([["T", { source_kind: "feature_table",
      table_name: "c862525677cf485a84b2ba86a78e277d_histtornadotracks",
      geom_column: "geom", srid: 4326 }]]);
    const { sql } = compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "T", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), long);
    assert.match(sql, /c862525677cf485a84b2ba86a78e277d_histtornadotracks/);
  });

  await test("still refuses an over-length identifier (>63)", () => {
    const tooLong = new Map([["T", { source_kind: "feature_table",
      table_name: "a".repeat(64), geom_column: "geom", srid: 4326 }]]);
    assert.throws(() => compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "T", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), tooLong), CompileError);
  });

  await test("refuses an unsafe table name from attribute_source", () => {
    const bad = new Map([["X", { source_kind: "feature_table",
      table_name: 'x"; DROP TABLE county_geom; --', geom_column: "geom" }]]);
    assert.throws(() => compilePlan(plan(
      { id: "s1", op: "count_features", attr_id: "X", inputs: [] },
      { id: "s2", op: "output", inputs: ["s1"] },
    ), bad), CompileError);
  });

  await test("count_features labels are dereferenced like load labels", async () => {
    // Mirrors derefPlan in index.js: both ops carry a reference label. When
    // count_features was omitted there, valid plans were rejected as citing an
    // unknown attribute.
    const { generatePlan } = require("./index");
    const refs = { a1: "REFINERY", a2: "POP" };
    const planJSON = JSON.stringify({
      intent: "t", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "count_features", attr_id: "a1", inputs: [] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "refineries",
      candidates: [{ attr_id: "REFINERY", attr_desc: "Oil Refineries", search_purpose: "primary" },
                   { attr_id: "POP", attr_desc: "Total population", search_purpose: "normalization" }],
      callLLM: async () => planJSON,
      resolve,
      log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.strictEqual(res.plan.steps[0].attr_id, "REFINERY", "label was not dereferenced");
  });

  // ------------------------------------------------------ geospatial ops
  await test("filter_area compiles named states to fips prefixes", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri", "Kansas"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /LEFT\(fips, 2\) IN \(\$\d+, \$\d+\)/);
    assert.ok(params.includes("29") && params.includes("20"), `expected MO+KS codes, got ${params}`);
  });

  await test("filter_area expands a region to its member states", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Midwest"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { params } = compilePlan(p, v.resolved);
    assert.ok(params.includes("29"), "Midwest should include Missouri");
    assert.ok(params.includes("17"), "Midwest should include Illinois");
    assert.ok(!params.includes("06"), "Midwest must not include California");
  });

  await test("filter_area rejects a state that does not exist", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Westeros"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /unknown state or region "Westeros"/);
  });

  await test("count_near grounds BOTH datasets and stays index-assisted", async () => {
    const p = plan(
      { id: "s1", op: "count_near", attr_id: "REFINERY", near_attr_id: "PIPELINE",
        miles: 10, inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    // The && bbox prefilter is what keeps the GIST index usable; without it the
    // geography ST_DWithin degrades to a sequential scan over the whole layer.
    assert.match(sql, /&& ST_Expand/, "lost the index-assisted bbox prefilter");
    assert.match(sql, /ST_DWithin\(.*::geography, .*::geography/);
    assert.match(sql, /LEFT JOIN/, "counties with zero matches must yield 0, not vanish");
    assert.ok(params.some(p => Math.abs(p - 16093.44) < 0.01), `expected 10mi in metres, got ${params}`);
  });

  await test("count_near rejects a value series as the proximity target", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "count_near", attr_id: "REFINERY", near_attr_id: "POP",
        miles: 5, inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /not a mappable dataset/);
  });

  await test("count_near refuses a non-positive radius", async () => {
    const p = plan(
      { id: "s1", op: "count_near", attr_id: "REFINERY", near_attr_id: "PIPELINE",
        miles: 0, inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.throws(() => compilePlan(p, v.resolved), CompileError);
  });

  await test("nearest_distance returns miles via an indexed KNN scan", async () => {
    const p = plan(
      { id: "s1", op: "nearest_distance", attr_id: "REFINERY", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, /<->/, "lost the KNN operator; this becomes a cross join");
    assert.match(sql, /1609\.344/, "distance must be converted to miles");
  });

  await test("nearest_distance rejects a non-feature attribute", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "nearest_distance", attr_id: "POP", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /already a per-county value series/);
  });

  await test("per_area divides by land area only, guarding zero", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POP", inputs: [] },
      { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, /NULLIF\(g\.aland, 0\)/, "must guard division by zero land area");
    assert.ok(!/awater/.test(sql), "water area must not be included in density");
  });

  await test("count_near dereferences near_attr_id as well as attr_id", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "refineries near pipelines", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "count_near", attr_id: "a1", near_attr_id: "a2", miles: 5, inputs: [] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "refineries within 5 miles of pipelines",
      candidates: [
        { attr_id: "REFINERY", attr_desc: "Oil Refineries", search_purpose: "primary",
          is_feature_table: true },
        { attr_id: "PIPELINE", attr_desc: "Natural Gas Pipelines", search_purpose: "primary",
          is_feature_table: true },
      ],
      callLLM: async () => planJSON,
      resolve,
      log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.strictEqual(res.plan.steps[0].attr_id, "REFINERY");
    assert.strictEqual(res.plan.steps[0].near_attr_id, "PIPELINE",
                       "near_attr_id label was not dereferenced");
  });

  // ------------------------------------------------- select_features (points)
  await test("select_features emits geometry plus only the columns that exist", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, mode, labels } = compilePlan(p, v.resolved);
    assert.strictEqual(mode, "features");
    assert.match(sql, /ST_AsGeoJSON/);
    assert.match(sql, /f\.name::text AS name/);
    assert.match(sql, /f\.city::text AS city/);
    // HOSPITAL declares name/city/state/type/status but not county or address,
    // so those two must be absent from the SELECT list.
    assert.ok(!/f\.address/.test(sql), "must not select a column the layer lacks");
    assert.ok(!/f\.county/.test(sql), "must not select a column the layer lacks");
    assert.deepStrictEqual(labels, ["name", "city", "state", "type", "status"]);
  });

  await test("select_features restricts to a state spatially", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [], states: ["Missouri"] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /JOIN county_geom c ON ST_Intersects/);
    assert.ok(params.includes("29"));
  });

  await test("select_features filters by city when the layer has one", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [], city: "Springfield" },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /f\.city ILIKE/);
    assert.ok(params.includes("Springfield"));
  });

  await test("select_features refuses a city filter on a layer with no city column", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "REFINERY", inputs: [], city: "Houston" },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.throws(() => compilePlan(p, v.resolved), /no city column/);
  });

  await test("select_features may not be chained with per-county ops", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [] },
      { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /cannot be combined with per_area/);
  });

  await test("select_features caps the number of features returned", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [], limit: 999999 },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, new RegExp(`LIMIT ${MAX_FEATURES}$`), "an absurd limit must be clamped");
  });

  await test("select_features rejects a per-county value series", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "POP", inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /already a per-county value series/);
  });

  // -------------------------------------------------- attribute filters
  await test("select_features binds an attribute filter as an exact match", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [{ column: "type", value: "CRITICAL ACCESS" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /f\.type = \$\d+/);
    assert.ok(params.includes("CRITICAL ACCESS"));
  });

  await test("a filter value is normalized to the layer's own spelling", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [{ column: "type", value: "critical access" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    // Lower-case would have matched nothing and returned an empty answer that
    // looked valid; validation rewrites it to the stored value.
    assert.strictEqual(p.steps[0].attribute_filters[0].value, "CRITICAL ACCESS");
  });

  await test("a filter value the layer does not hold is rejected, with the valid ones", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [{ column: "type", value: "VETERINARY" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    const msg = r.errors.join(" ");
    assert.match(msg, /"VETERINARY" is not a value of "type"/);
    assert.match(msg, /CRITICAL ACCESS/, "the repair message must list valid values");
  });

  await test("a filter on a column the layer lacks is rejected", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "REFINERY", inputs: [],
        attribute_filters: [{ column: "type", value: "anything" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /no filterable "type" column/);
  });

  await test("count_features filters in the ON clause so zero-match counties stay", async () => {
    const p = plan(
      { id: "s1", op: "count_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [{ column: "type", value: "CRITICAL ACCESS" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql } = compilePlan(p, v.resolved);
    // In ON, not WHERE: a WHERE would delete every county whose only hospitals
    // are general ones, instead of showing them as 0.
    assert.match(sql, /ON ST_Intersects\([^)]*\) AND f\.type = \$\d+/);
    assert.ok(!/WHERE f\.type/.test(sql), "filter must not move to WHERE");
  });

  await test("two filters compose", async () => {
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [
          { column: "type", value: "CRITICAL ACCESS" },
          { column: "status", value: "OPEN" },
        ] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /f\.type = \$\d+ AND f\.status = \$\d+/);
    assert.ok(params.includes("OPEN"));
  });

  await test("attribute filters are refused on ops that read two layers", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "count_near", attr_id: "HOSPITAL", near_attr_id: "PIPELINE",
        miles: 5, inputs: [],
        attribute_filters: [{ column: "type", value: "CRITICAL ACCESS" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /only apply to select_features or count_features/);
  });

  await test("a filter column outside the allow-list never reaches SQL", () => {
    // Bypassing the validator entirely, as a malformed repair could.
    const p = plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        attribute_filters: [{ column: "geom); DROP TABLE hospitals;--", value: "x" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    );
    assert.throws(() => compilePlan(p, SOURCES), /unsupported filter column/);
  });

  await test("a filter the question never mentioned is dropped, not failed on", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "select_features", attr_id: "a1", inputs: [], city: "Springfield",
          attribute_filters: [{ column: "status", value: "OPEN" }] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "show me the locations of fire stations in Springfield, Missouri",
      candidates: [{ attr_id: "REFINERY", attr_desc: "Fire Stations",
                     search_purpose: "primary", is_feature_table: true }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.ok(!res.plan.steps[0].attribute_filters,
      "an invented filter should be dropped rather than failing the plan");
  });

  await test("a filter the question DID ask for is kept", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "count_features", attr_id: "a1", inputs: [],
          attribute_filters: [{ column: "type", value: "CRITICAL ACCESS" }] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "how many critical access hospitals are in each county",
      candidates: [{ attr_id: "HOSPITAL", attr_desc: "Hospitals",
                     search_purpose: "primary", is_feature_table: true }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.deepStrictEqual(res.plan.steps[0].attribute_filters,
      [{ column: "type", value: "CRITICAL ACCESS" }],
      "a filter the question asked for must survive");
  });

  // ------------------------------------------------------ named boundaries
  await test("filter_place restricts counties to a named city", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "place", place_name: "Springfield", states: ["Missouri"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    // EXISTS, not a join: Springfield MO spans Greene and Christian, and a join
    // would emit each county once per intersecting polygon.
    assert.match(sql, /WHERE EXISTS \(SELECT 1 FROM place_geom p/);
    assert.match(sql, /ST_Intersects\(c\.geom, p\.geom\)/);
    // Plain intersection returns 27 counties for a 13-county metro, because the
    // layers are drawn at different generalizations and every neighbour clips
    // a sliver in. The overlap threshold is what makes the answer right.
    assert.match(sql, /ST_Area\(ST_Intersection\(c\.geom, p\.geom\)\) >/);
    assert.match(sql, /LEAST\(ST_Area\(c\.geom\), ST_Area\(p\.geom\)\)/);
    // And the index-assisted prefilter must come before that expensive test.
    assert.match(sql, /c\.geom && p\.geom AND ST_Intersects/);
    assert.ok(params.includes("place") && params.includes("Springfield"));
    assert.ok(params.includes("29"), "the state should narrow the 22 Springfields");
  });

  await test("filter_place matches a compound metro name from its lead city", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "cbsa", place_name: "Chicago" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    const { sql } = compilePlan(p, v.resolved);
    // "Chicago" has to reach "Chicago-Naperville-Elgin, IL-IN" without also
    // letting "Springfield" reach "Springfield Gardens".
    assert.match(sql, /LIKE lower\(\$\d+\) \|\| '-%'/);
    assert.match(sql, /LIKE lower\(\$\d+\) \|\| ', %'/);
  });

  await test("filter_place accepts a ZIP code as its name", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "zcta", place_name: "63101" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, [], "a ZIP is digits, not a place name");
    const { params } = compilePlan(p, v.resolved);
    assert.ok(params.includes("63101"));
  });

  await test("filter_place rejects a ZIP that is not five digits", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "zcta", place_name: "Springfield" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /5-digit ZIP code/);
  });

  await test("filter_place refuses a place name with leaked structure", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "place", place_name: "Springfield','states':['Missouri']" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    ), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /does not look like a place name/);
  });

  await test("an unsupported place_kind never reaches SQL", () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
        place_kind: "geom); DROP TABLE place_geom;--", place_name: "x" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
    );
    assert.throws(() => compilePlan(p, SOURCES), /unsupported place_kind/);
  });

  await test("a five-digit place name is corrected to a ZIP code", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        // What the model actually emitted: searching 32,642 city names for
        // one called "63101", finding none, returning zero rows.
        { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
          place_kind: "place", place_name: "63101" },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const res = await generatePlan({
      query: "median household income for counties in ZIP code 63101",
      candidates: [{ attr_id: "POV", attr_desc: "income", search_purpose: "primary" }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.strictEqual(res.plan.steps[1].place_kind, "zcta");
  });

  await test("a filter_place with no state gains the one the question named", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"],
          place_kind: "place", place_name: "Springfield" },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const res = await generatePlan({
      query: "median household income for counties in the Springfield, Missouri area",
      candidates: [{ attr_id: "POV", attr_desc: "income", search_purpose: "primary" }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.deepStrictEqual(res.plan.steps[1].states, ["Missouri"],
      "without this the filter keeps counties near all 22 Springfields");
  });

  await test("a runaway region enumeration is replaced by the region itself", async () => {
    const { generatePlan } = require("./index");
    // Observed verbatim: "counties in the South" produced the census South plus
    // the entire Northeast plus Arizona and New Mexico, with duplicates.
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"],
          states: ["Alabama", "Texas", "New York", "Maine", "Arizona",
                   "New York", "Maine"] },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const res = await generatePlan({
      query: "median household income for counties in the South",
      candidates: [{ attr_id: "POV", attr_desc: "income", search_purpose: "primary" }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.deepStrictEqual(res.plan.steps[1].states, ["South"],
      "a list spanning three regions should collapse to the named one");
    assert.ok(res.adjustments.length, "the correction must be reported, not silent");
  });

  await test("an unknown region's enumeration is left to the model", async () => {
    const { generatePlan } = require("./index");
    const newEngland = ["Maine", "New Hampshire", "Vermont", "Massachusetts",
                        "Rhode Island", "Connecticut"];
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: newEngland },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const res = await generatePlan({
      query: "median household income for counties in New England",
      candidates: [{ attr_id: "POV", attr_desc: "income", search_purpose: "primary" }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok);
    // Nothing in the code knows what New England is, and that is the point.
    assert.deepStrictEqual(res.plan.steps[1].states, newEngland);
  });

  await test("duplicates are removed even for a region we do not know", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"],
          states: ["Oregon", "Washington", "Oregon"] },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const res = await generatePlan({
      query: "counties in the Pacific Northwest",
      candidates: [{ attr_id: "POV", attr_desc: "income", search_purpose: "primary" }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.deepStrictEqual(res.plan.steps[1].states, ["Oregon", "Washington"]);
  });

  await test("a city value with leaked JSON structure is salvaged", async () => {
    const { generatePlan } = require("./index");
    // Observed verbatim from qwen3:14b on roughly half of runs.
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "select_features", attr_id: "a1", inputs: [],
          city: "Springfield','states':['Missouri']", states: ["Missouri"] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "fire stations in Springfield, Missouri",
      candidates: [{ attr_id: "HOSPITAL", attr_desc: "Fire Stations",
                     search_purpose: "primary", is_feature_table: true }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.strictEqual(res.plan.steps[0].city, "Springfield",
      "the real city name was not recovered from the mangled value");
  });

  await test("a city that is entirely unusable is dropped, not searched for", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [],
        city: "{'x':1}" },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
    ), resolve);
    assert.ok(!r.ok, "the validator must refuse a non-place-name city");
    assert.match(r.errors.join(" "), /is not a place name/);
  });

  await test("ordinary city names with punctuation are accepted", async () => {
    for (const city of ["St. Louis", "Winston-Salem", "O'Fallon"]) {
      const r = await validatePlan(plan(
        { id: "s1", op: "select_features", attr_id: "HOSPITAL", inputs: [], city },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ), resolve);
      assert.deepStrictEqual(r.errors, [], `rejected a real city: ${city}`);
    }
  });

  await test("a city-only locations plan gains the state the question named", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "fire stations in Springfield, Missouri",
      output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "select_features", attr_id: "a1", inputs: [], city: "Springfield" },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "show me the fire stations in Springfield, Missouri",
      candidates: [{ attr_id: "HOSPITAL", attr_desc: "Fire Stations", search_purpose: "primary",
                     is_feature_table: true }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.ok(res.ok, `expected a valid plan, got: ${JSON.stringify(res.errors)}`);
    assert.deepStrictEqual(res.plan.steps[0].states, ["Missouri"],
      "the state named in the question was not applied");
  });

  await test("an explicit state on a locations plan is left alone", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "x", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "select_features", attr_id: "a1", inputs: [],
          city: "Springfield", states: ["Illinois"] },
        { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
      ],
    });
    const res = await generatePlan({
      query: "fire stations in Springfield, Missouri",
      candidates: [{ attr_id: "HOSPITAL", attr_desc: "Fire Stations", search_purpose: "primary",
                     is_feature_table: true }],
      callLLM: async () => planJSON,
      resolve, log: () => {},
    });
    assert.deepStrictEqual(res.plan.steps[0].states, ["Illinois"],
      "an explicit choice must not be overwritten");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
