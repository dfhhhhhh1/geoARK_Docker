/**
 * Comprehensive Unit Tests for GeoARK 1-Line DSL Parser.
 *
 * Covers:
 * - All 28 GeoARK operators
 * - REFUSE handling with all parameter shapes
 * - INTENT handling (custom, quoted, piped, omitted default)
 * - Implicit wiring (1-input, 2-input, 0-input)
 * - Explicit wiring (s1, s2, custom IDs, named inputs=[...], in1/in2)
 * - Argument styles (positional, named key=value, key: value)
 * - Arrays (unquoted [MO], mixed space, postal normalization)
 * - Numbers (integers, floats, negative values)
 * - Booleans (true, false, case-insensitive)
 * - String escaping (\", \', \\, \n, \t)
 * - Attribute filters (inline type="...", attribute_filters=[...], negate=true)
 * - Conformance with GeoARK's validatePlan across all valid operations
 * - Error rejection (empty, malformed, duplicate IDs, unmatched delimiters, unknown ops)
 *
 * Run: node tests/dsl_parser.test.js
 */

const assert = require("node:assert");
const { parsePlan, DslParseError } = require("../backend/planner/dsl_parser");
const { validatePlan } = require("../backend/planner/validate");

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.stack || e.message}`);
    fail++;
  }
}

// Mock resolver for validatePlan
const SOURCES = new Map([
  ["POV", { attr_id: "POV", source_kind: "series" }],
  ["POP", { attr_id: "POP", source_kind: "series" }],
  ["UNEMP", { attr_id: "UNEMP", source_kind: "series" }],
  ["MEDINC", { attr_id: "MEDINC", source_kind: "series" }],
  ["HOSP", {
    attr_id: "HOSP",
    source_kind: "feature_table",
    table_name: "hospitals",
    geom_column: "geom",
    label_columns: ["name", "city", "state", "type", "status"],
    filter_values: {
      type: ["GENERAL ACUTE CARE", "CRITICAL ACCESS", "PSYCHIATRIC"],
      status: ["OPEN", "CLOSED"],
    },
  }],
  ["CLINIC", {
    attr_id: "CLINIC",
    source_kind: "feature_table",
    table_name: "clinics",
    geom_column: "geom",
  }],
  ["RAST_ELEV", {
    attr_id: "RAST_ELEV",
    source_kind: "raster",
    raster_kind: "continuous",
  }],
  ["RAST_LAND", {
    attr_id: "RAST_LAND",
    source_kind: "raster",
    raster_kind: "categorical",
    filter_values: {
      type: ["cropland", "forest", "water"],
    },
  }],
]);

const mockResolve = async (ids) => {
  return new Map(ids.map(id => [id, SOURCES.get(id) || { attr_id: id, source_kind: "series" }]));
};

(async () => {
  console.log("=================================================");
  console.log("GeoARK 1-Line DSL Parser - Complete Test Suite");
  console.log("=================================================\n");

  // =========================================================================
  // 1. REFUSAL HANDLING
  // =========================================================================
  console.log("--- 1. REFUSE Handling ---");

  await test("REFUSE() with no arguments", () => {
    const ast = parsePlan("REFUSE()");
    assert.strictEqual(ast.intent, "Refusal: requested data unavailable");
    assert.strictEqual(ast.output_type, "map");
    assert.strictEqual(ast.entity_type, "COUNTY");
    assert.deepStrictEqual(ast.steps, []);
  });

  await test("REFUSE(missing: ['rainfall'])", () => {
    const ast = parsePlan("REFUSE(missing: ['rainfall'])");
    assert.strictEqual(ast.intent, "Refusal: requested data unavailable");
    assert.strictEqual(ast.output_type, "map");
    assert.strictEqual(ast.entity_type, "COUNTY");
    assert.deepStrictEqual(ast.steps, []);
  });

  await test("REFUSE(missing=['rainfall', 'elevation']) with key=value", () => {
    const ast = parsePlan('REFUSE(missing=["rainfall", "elevation"])');
    assert.strictEqual(ast.intent, "Refusal: requested data unavailable");
    assert.deepStrictEqual(ast.steps, []);
  });

  await test("REFUSE(reason: 'data_unavailable')", () => {
    const ast = parsePlan("REFUSE(reason: 'data_unavailable')");
    assert.strictEqual(ast.intent, "Refusal: data_unavailable");
    assert.deepStrictEqual(ast.steps, []);
  });

  await test("REFUSE(reason='custom domain refusal explanation')", () => {
    const ast = parsePlan("REFUSE(reason='custom domain refusal explanation')");
    assert.strictEqual(ast.intent, "Refusal: custom domain refusal explanation");
    assert.deepStrictEqual(ast.steps, []);
  });

  await test("REFUSE positional string argument", () => {
    const ast = parsePlan("REFUSE('vintage out of bounds')");
    assert.strictEqual(ast.intent, "Refusal: vintage out of bounds");
    assert.deepStrictEqual(ast.steps, []);
  });

  // =========================================================================
  // 2. INTENT & METADATA
  // =========================================================================
  console.log("\n--- 2. Intent & Root AST Metadata ---");

  await test("INTENT prefix extraction with double quotes", () => {
    const ast = parsePlan('INTENT("Poverty analysis in Missouri") | load(POV) | output');
    assert.strictEqual(ast.intent, "Poverty analysis in Missouri");
    assert.strictEqual(ast.output_type, "map");
    assert.strictEqual(ast.entity_type, "COUNTY");
  });

  await test("INTENT prefix extraction with single quotes", () => {
    const ast = parsePlan("INTENT('Unemployment study') | load(UNEMP) | output");
    assert.strictEqual(ast.intent, "Unemployment study");
  });

  await test("INTENT containing pipe '|' character does not split early", () => {
    const ast = parsePlan("INTENT('Compare group A | group B') | load(POV) | output");
    assert.strictEqual(ast.intent, "Compare group A | group B");
    assert.strictEqual(ast.steps.length, 2);
  });

  await test("INTENT with colon syntax INTENT: '...'", () => {
    const ast = parsePlan("INTENT: 'Direct colon intent' | load(POV) | output");
    assert.strictEqual(ast.intent, "Direct colon intent");
    assert.strictEqual(ast.steps.length, 2);
  });

  await test("Default intent derived when INTENT omitted", () => {
    const ast = parsePlan("load(POV) | filter_area([MO]) | output");
    assert.strictEqual(ast.intent, "Spatial analysis: load -> filter_area -> output");
  });

  // =========================================================================
  // 3. ALL 28 OPERATORS (INDIVIDUAL TESTS)
  // =========================================================================
  console.log("\n--- 3. Individual Coverage of All 28 Operators ---");

  // 1. load
  await test("Op 1: load (positional attr, named year)", () => {
    const ast = parsePlan("load(POV, year=2021) | output");
    assert.strictEqual(ast.steps[0].op, "load");
    assert.strictEqual(ast.steps[0].attr_id, "POV");
    assert.strictEqual(ast.steps[0].year, 2021);
    assert.deepStrictEqual(ast.steps[0].inputs, []);
  });

  await test("Op 1: load (positional year)", () => {
    const ast = parsePlan("load(POV, 2020) | output");
    assert.strictEqual(ast.steps[0].year, 2020);
  });

  // 2. count_features
  await test("Op 2: count_features (with column filter)", () => {
    const ast = parsePlan("count_features(HOSP, type='CRITICAL ACCESS') | output");
    assert.strictEqual(ast.steps[0].op, "count_features");
    assert.strictEqual(ast.steps[0].attr_id, "HOSP");
    assert.deepStrictEqual(ast.steps[0].inputs, []);
    assert.deepStrictEqual(ast.steps[0].attribute_filters, [{ column: "type", value: "CRITICAL ACCESS" }]);
  });

  // 3. count_near
  await test("Op 3: count_near (positional attr, near_attr, miles)", () => {
    const ast = parsePlan("count_near(HOSP, CLINIC, 15) | output");
    assert.strictEqual(ast.steps[0].op, "count_near");
    assert.strictEqual(ast.steps[0].attr_id, "HOSP");
    assert.strictEqual(ast.steps[0].near_attr_id, "CLINIC");
    assert.strictEqual(ast.steps[0].miles, 15);
    assert.deepStrictEqual(ast.steps[0].inputs, []);
  });

  await test("Op 3: count_near (named arguments)", () => {
    const ast = parsePlan("count_near(attr_id=HOSP, near_attr_id=CLINIC, miles=25.5) | output");
    assert.strictEqual(ast.steps[0].miles, 25.5);
  });

  // 4. nearest_distance
  await test("Op 4: nearest_distance", () => {
    const ast = parsePlan("nearest_distance(HOSP) | output");
    assert.strictEqual(ast.steps[0].op, "nearest_distance");
    assert.strictEqual(ast.steps[0].attr_id, "HOSP");
    assert.deepStrictEqual(ast.steps[0].inputs, []);
  });

  // 5. select_features
  await test("Op 5: select_features (states, city, limit)", () => {
    const ast = parsePlan("select_features(HOSP, states=['Missouri'], city='Springfield', limit=100) | output");
    assert.strictEqual(ast.steps[0].op, "select_features");
    assert.strictEqual(ast.steps[0].attr_id, "HOSP");
    assert.deepStrictEqual(ast.steps[0].states, ["Missouri"]);
    assert.strictEqual(ast.steps[0].city, "Springfield");
    assert.strictEqual(ast.steps[0].limit, 100);
    assert.deepStrictEqual(ast.steps[0].inputs, []);
  });

  // 6. within
  await test("Op 6: within (explicit inputs, miles, exclude)", () => {
    const ast = parsePlan("select_features(HOSP) | select_features(CLINIC) | within(s1, s2, miles=5, exclude=true) | output");
    assert.strictEqual(ast.steps[2].op, "within");
    assert.strictEqual(ast.steps[2].attr_id, "");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
    assert.strictEqual(ast.steps[2].miles, 5);
    assert.strictEqual(ast.steps[2].exclude, true);
  });

  // 7. overlay
  await test("Op 7: overlay (implicit wiring, exclude=true)", () => {
    const ast = parsePlan("select_features(HOSP) | select_features(CLINIC) | overlay(exclude=true) | output");
    assert.strictEqual(ast.steps[2].op, "overlay");
    assert.strictEqual(ast.steps[2].attr_id, "");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
    assert.strictEqual(ast.steps[2].exclude, true);
  });

  // 8. summarize
  await test("Op 8: summarize (named group_by)", () => {
    const ast = parsePlan("select_features(HOSP) | summarize(group_by='state') | output");
    assert.strictEqual(ast.steps[1].op, "summarize");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
    assert.strictEqual(ast.steps[1].group_by, "state");
  });

  await test("Op 8: summarize (positional group_by)", () => {
    const ast = parsePlan("select_features(HOSP) | summarize(state) | output");
    assert.strictEqual(ast.steps[1].group_by, "state");
  });

  // 9. filter_attr
  await test("Op 9: filter_attr (operator & value)", () => {
    const ast = parsePlan("load(POV) | filter_attr('>', 10) | output");
    assert.strictEqual(ast.steps[1].op, "filter_attr");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
    assert.strictEqual(ast.steps[1].operator, ">");
    assert.strictEqual(ast.steps[1].value, 10);
  });

  await test("Op 9: filter_attr (operator & percentile)", () => {
    const ast = parsePlan("load(POV) | filter_attr(operator='>=', percentile=80) | output");
    assert.strictEqual(ast.steps[1].operator, ">=");
    assert.strictEqual(ast.steps[1].percentile, 80);
  });

  await test("Op 9: filter_attr (definition)", () => {
    const ast = parsePlan("load(POV) | filter_attr(definition='d1') | output");
    assert.strictEqual(ast.steps[1].definition, "d1");
  });

  // 10. filter_area
  await test("Op 10: filter_area ([MO] normalized to Missouri)", () => {
    const ast = parsePlan("load(POV) | filter_area([MO]) | output");
    assert.strictEqual(ast.steps[1].op, "filter_area");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].states, ["Missouri"]);
  });

  await test("Op 10: filter_area (multiple postal codes and regions)", () => {
    const ast = parsePlan("load(POV) | filter_area([IL, MO, Midwest]) | output");
    assert.deepStrictEqual(ast.steps[1].states, ["Illinois", "Missouri", "Midwest"]);
  });

  // 11. filter_place
  await test("Op 11: filter_place (positional kind & name)", () => {
    const ast = parsePlan("load(POV) | filter_place(cbsa, 'Chicago') | output");
    assert.strictEqual(ast.steps[1].op, "filter_place");
    assert.strictEqual(ast.steps[1].place_kind, "cbsa");
    assert.strictEqual(ast.steps[1].place_name, "Chicago");
  });

  await test("Op 11: filter_place (named kind, name, states)", () => {
    const ast = parsePlan("load(POV) | filter_place(place_kind='place', place_name='Springfield', states=[IL]) | output");
    assert.strictEqual(ast.steps[1].place_kind, "place");
    assert.strictEqual(ast.steps[1].place_name, "Springfield");
    assert.deepStrictEqual(ast.steps[1].states, ["Illinois"]);
  });

  // 12. per_area
  await test("Op 12: per_area", () => {
    const ast = parsePlan("load(POV) | per_area | output");
    assert.strictEqual(ast.steps[1].op, "per_area");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
  });

  // 13. normalize
  await test("Op 13: normalize (implicit 2-inputs, scale)", () => {
    const ast = parsePlan("load(POV) | load(POP) | normalize(scale=100) | output");
    assert.strictEqual(ast.steps[2].op, "normalize");
    assert.strictEqual(ast.steps[2].attr_id, "");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
    assert.strictEqual(ast.steps[2].scale, 100);
  });

  // 14. aggregate
  await test("Op 14: aggregate (positional function & group_by)", () => {
    const ast = parsePlan("load(POV) | aggregate(mean, state) | output");
    assert.strictEqual(ast.steps[1].op, "aggregate");
    assert.strictEqual(ast.steps[1].function, "mean");
    assert.strictEqual(ast.steps[1].group_by, "state");
  });

  // 15. rank
  await test("Op 15: rank (positional direction & limit)", () => {
    const ast = parsePlan("load(POV) | rank(desc, 10) | output");
    assert.strictEqual(ast.steps[1].op, "rank");
    assert.strictEqual(ast.steps[1].direction, "desc");
    assert.strictEqual(ast.steps[1].limit, 10);
  });

  // 16. join
  await test("Op 16: join (implicit wiring)", () => {
    const ast = parsePlan("load(POV) | load(POP) | join | output");
    assert.strictEqual(ast.steps[2].op, "join");
    assert.strictEqual(ast.steps[2].attr_id, "");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  // 17. combine
  await test("Op 17: combine (operation difference and scale)", () => {
    const ast = parsePlan("load(POV) | load(POP) | combine(difference, scale=10) | output");
    assert.strictEqual(ast.steps[2].op, "combine");
    assert.strictEqual(ast.steps[2].operation, "difference");
    assert.strictEqual(ast.steps[2].scale, 10);
  });

  // 18. hotspot
  await test("Op 18: hotspot", () => {
    const ast = parsePlan("load(POV) | hotspot | output");
    assert.strictEqual(ast.steps[1].op, "hotspot");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
  });

  // 19. outlier
  await test("Op 19: outlier", () => {
    const ast = parsePlan("load(POV) | outlier | output");
    assert.strictEqual(ast.steps[1].op, "outlier");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
  });

  // 20. correlate
  await test("Op 20: correlate (output_type: statistics)", () => {
    const ast = parsePlan("load(POV) | load(POP) | correlate | output");
    assert.strictEqual(ast.steps[2].op, "correlate");
    assert.strictEqual(ast.steps[2].attr_id, "");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
    assert.strictEqual(ast.output_type, "statistics");
  });

  // 21. explain
  await test("Op 21: explain (output_type: statistics)", () => {
    const ast = parsePlan("load(POV) | explain | output");
    assert.strictEqual(ast.steps[1].op, "explain");
    assert.strictEqual(ast.steps[1].attr_id, "");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
    assert.strictEqual(ast.output_type, "statistics");
  });

  // 22. intersect
  await test("Op 22: intersect (with exclude=true)", () => {
    const ast = parsePlan("load(POV) | load(POP) | intersect(s1, s2, exclude=true) | output");
    assert.strictEqual(ast.steps[2].op, "intersect");
    assert.strictEqual(ast.steps[2].exclude, true);
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  // 23. compare_groups
  await test("Op 23: compare_groups", () => {
    const ast = parsePlan("load(POV) | load(POP) | compare_groups | output");
    assert.strictEqual(ast.steps[2].op, "compare_groups");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  // 24. neighbors
  await test("Op 24: neighbors (operation difference)", () => {
    const ast = parsePlan("load(POV) | neighbors(difference) | output");
    assert.strictEqual(ast.steps[1].op, "neighbors");
    assert.strictEqual(ast.steps[1].operation, "difference");
  });

  // 25. residual
  await test("Op 25: residual", () => {
    const ast = parsePlan("load(POV) | load(POP) | residual | output");
    assert.strictEqual(ast.steps[2].op, "residual");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  // 26. access
  await test("Op 26: access (attr_id HOSP and catchment miles)", () => {
    const ast1 = parsePlan("load(POP) | access(HOSP, 30) | output");
    assert.strictEqual(ast1.steps[1].op, "access");
    assert.strictEqual(ast1.steps[1].attr_id, "HOSP");
    assert.strictEqual(ast1.steps[1].miles, 30);
    assert.deepStrictEqual(ast1.steps[1].inputs, ["s1"]);

    const ast2 = parsePlan("load(POP) | access(s1, HOSP, miles=45) | output");
    assert.strictEqual(ast2.steps[1].miles, 45);
    assert.strictEqual(ast2.steps[1].attr_id, "HOSP");
  });

  // 27. zonal
  await test("Op 27: zonal (continuous elevation raster with threshold)", () => {
    const ast = parsePlan("zonal(RAST_ELEV, operator='>', value=100) | output");
    assert.strictEqual(ast.steps[0].op, "zonal");
    assert.strictEqual(ast.steps[0].attr_id, "RAST_ELEV");
    assert.strictEqual(ast.steps[0].operator, ">");
    assert.strictEqual(ast.steps[0].value, 100);
    assert.deepStrictEqual(ast.steps[0].inputs, []);
  });

  await test("Op 27: zonal (categorical land-cover raster with type filter)", () => {
    const ast = parsePlan("zonal(RAST_LAND, type='cropland') | output");
    assert.strictEqual(ast.steps[0].op, "zonal");
    assert.strictEqual(ast.steps[0].attr_id, "RAST_LAND");
    assert.deepStrictEqual(ast.steps[0].attribute_filters, [{ column: "type", value: "cropland" }]);
  });

  // 28. output
  await test("Op 28: output (bare identifier without parentheses)", () => {
    const ast = parsePlan("load(POV) | output");
    assert.strictEqual(ast.steps[1].op, "output");
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
  });

  await test("Op 28: output (explicit reference)", () => {
    const ast = parsePlan("load(POV) | filter_area([MO]) | output(s1)");
    assert.strictEqual(ast.steps[2].op, "output");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1"]);
  });

  // =========================================================================
  // 4. DAG & ADVANCED WIRING
  // =========================================================================
  console.log("\n--- 4. DAG & Advanced Wiring ---");

  await test("Multi-step pipeline auto-wiring sequential IDs", () => {
    const ast = parsePlan("load(POV) | filter_area([MO]) | rank(desc, 10) | output");
    assert.deepStrictEqual(ast.steps.map(s => s.id), ["s1", "s2", "s3", "s4"]);
    assert.deepStrictEqual(ast.steps[0].inputs, []);
    assert.deepStrictEqual(ast.steps[1].inputs, ["s1"]);
    assert.deepStrictEqual(ast.steps[2].inputs, ["s2"]);
    assert.deepStrictEqual(ast.steps[3].inputs, ["s3"]);
  });

  await test("Mixed explicit and auto-generated step IDs", () => {
    const ast = parsePlan("s1: load(POV) | custom_step: filter_area([MO]) | output(custom_step)");
    assert.strictEqual(ast.steps[0].id, "s1");
    assert.strictEqual(ast.steps[1].id, "custom_step");
    assert.strictEqual(ast.steps[2].id, "s2");
    assert.deepStrictEqual(ast.steps[2].inputs, ["custom_step"]);
  });

  await test("Branching DAG: two parallel loads feeding normalize", () => {
    const ast = parsePlan("s1: load(POV) | s2: filter_area([MO]) | s3: load(POP) | s4: filter_area([MO]) | s5: normalize(s2, s4) | s6: output(s5)");
    assert.deepStrictEqual(ast.steps[4].inputs, ["s2", "s4"]);
    assert.deepStrictEqual(ast.steps[5].inputs, ["s5"]);
  });

  await test("Wiring via named inputs=[s1, s2]", () => {
    const ast = parsePlan("load(POV) | load(POP) | normalize(inputs=[s1, s2]) | output");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  await test("Wiring via named in1=s1, in2=s2", () => {
    const ast = parsePlan("load(POV) | load(POP) | combine(in1=s1, in2=s2, operation='difference') | output");
    assert.deepStrictEqual(ast.steps[2].inputs, ["s1", "s2"]);
  });

  // =========================================================================
  // 5. PARSER ROBUSTNESS & SYNTAX VARIATIONS
  // =========================================================================
  console.log("\n--- 5. Parser Robustness & Syntax Variations ---");

  await test("Whitespace tolerance around delimiters", () => {
    const ast = parsePlan("  load( POV , year = 2021 )   |   filter_area( [  MO  ,  IL  ] )   |   output  ");
    assert.strictEqual(ast.steps[0].attr_id, "POV");
    assert.strictEqual(ast.steps[0].year, 2021);
    assert.deepStrictEqual(ast.steps[1].states, ["Missouri", "Illinois"]);
    assert.strictEqual(ast.steps[2].op, "output");
  });

  await test("Comments (# and //) and multiline string", () => {
    const dsl = `
      # Load poverty dataset
      load(POV) |
      // Filter to Illinois
      filter_area([IL]) |
      output
    `;
    const ast = parsePlan(dsl);
    assert.strictEqual(ast.steps.length, 3);
    assert.strictEqual(ast.steps[0].op, "load");
    assert.deepStrictEqual(ast.steps[1].states, ["Illinois"]);
  });

  await test("Trailing commas in argument and array lists", () => {
    const ast = parsePlan("load(POV, year=2021,) | filter_area([MO, IL,]) | output");
    assert.strictEqual(ast.steps[0].year, 2021);
    assert.deepStrictEqual(ast.steps[1].states, ["Missouri", "Illinois"]);
  });

  await test("String escape sequences (quotes, newlines, tabs)", () => {
    const ast = parsePlan('INTENT("Analysis: \\"Quote\\"\\nLine 2\\tTabbed") | load(POV) | output');
    assert.strictEqual(ast.intent, 'Analysis: "Quote"\nLine 2\tTabbed');
  });

  await test("Negative and float numbers", () => {
    const ast = parsePlan("load(POV) | filter_attr('>', -12.5) | output");
    assert.strictEqual(ast.steps[1].value, -12.5);
  });

  await test("Case-insensitivity for operators and booleans", () => {
    const ast = parsePlan("SELECT_FEATURES(HOSP) | SELECT_FEATURES(CLINIC) | WITHIN(s1, s2, miles=5, exclude=TRUE) | OUTPUT");
    assert.strictEqual(ast.steps[0].op, "select_features");
    assert.strictEqual(ast.steps[2].op, "within");
    assert.strictEqual(ast.steps[2].exclude, true);
    assert.strictEqual(ast.steps[3].op, "output");
  });

  await test("Attribute filters with negate=true", () => {
    const ast = parsePlan("count_features(HOSP, attribute_filters=[{column: 'type', value: 'CRITICAL ACCESS', negate: true}]) | output");
    assert.deepStrictEqual(ast.steps[0].attribute_filters, [
      { column: "type", value: "CRITICAL ACCESS", negate: true },
    ]);
  });

  // =========================================================================
  // 6. VALIDATEPLAN VALIDATION (GEOARK AST CONFORMANCE)
  // =========================================================================
  console.log("\n--- 6. Conformance with GeoARK validatePlan ---");

  await test("validatePlan: load -> filter_area -> output", async () => {
    const ast = parsePlan("load(POV) | filter_area([MO]) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: 2-series load -> normalize -> output", async () => {
    const ast = parsePlan("load(POV) | load(POP) | normalize(scale=100) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: facility count_features with attribute filter", async () => {
    const ast = parsePlan("count_features(HOSP, type='CRITICAL ACCESS') | filter_area([MO]) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: count_near proximity between facilities", async () => {
    const ast = parsePlan("count_near(HOSP, CLINIC, miles=15) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: nearest_distance", async () => {
    const ast = parsePlan("nearest_distance(HOSP) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: select_features with state and limit", async () => {
    const ast = parsePlan("select_features(HOSP, states=['Missouri'], limit=50) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: feature within and overlay algebra", async () => {
    const astW = parsePlan("select_features(HOSP) | select_features(CLINIC) | within(s1, s2, miles=10) | output");
    const resW = await validatePlan(astW, mockResolve);
    assert.strictEqual(resW.ok, true, `Validation failed: ${resW.errors.join("; ")}`);

    const astO = parsePlan("select_features(HOSP) | select_features(CLINIC) | overlay(s1, s2) | output");
    const resO = await validatePlan(astO, mockResolve);
    assert.strictEqual(resO.ok, true, `Validation failed: ${resO.errors.join("; ")}`);
  });

  await test("validatePlan: summarize", async () => {
    const ast = parsePlan("select_features(HOSP) | summarize(group_by='state') | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: filter_place", async () => {
    const ast = parsePlan("load(POV) | filter_place(cbsa, 'Chicago') | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: per_area", async () => {
    const ast = parsePlan("load(POV) | per_area | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: aggregate", async () => {
    const ast = parsePlan("load(POV) | aggregate(mean, group_by='state') | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: rank", async () => {
    const ast = parsePlan("load(POV) | rank(desc, 10) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: combine", async () => {
    const ast = parsePlan("load(POV) | load(POP) | combine(difference) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: hotspot & outlier", async () => {
    const astH = parsePlan("load(POV) | hotspot | output");
    const resH = await validatePlan(astH, mockResolve);
    assert.strictEqual(resH.ok, true, `Validation failed: ${resH.errors.join("; ")}`);

    const astO = parsePlan("load(POV) | outlier | output");
    const resO = await validatePlan(astO, mockResolve);
    assert.strictEqual(resO.ok, true, `Validation failed: ${resO.errors.join("; ")}`);
  });

  await test("validatePlan: correlate & explain (statistics output_type)", async () => {
    const astC = parsePlan("load(POV) | load(POP) | correlate | output");
    const resC = await validatePlan(astC, mockResolve);
    assert.strictEqual(resC.ok, true, `Validation failed: ${resC.errors.join("; ")}`);
    assert.strictEqual(astC.output_type, "statistics");

    const astE = parsePlan("load(POV) | explain | output");
    const resE = await validatePlan(astE, mockResolve);
    assert.strictEqual(resE.ok, true, `Validation failed: ${resE.errors.join("; ")}`);
    assert.strictEqual(astE.output_type, "statistics");
  });

  await test("validatePlan: intersect, compare_groups, residual", async () => {
    const astI = parsePlan("load(POV) | load(POP) | intersect | output");
    const resI = await validatePlan(astI, mockResolve);
    assert.strictEqual(resI.ok, true, `Validation failed: ${resI.errors.join("; ")}`);

    const astC = parsePlan("load(POV) | load(POP) | compare_groups | output");
    const resC = await validatePlan(astC, mockResolve);
    assert.strictEqual(resC.ok, true, `Validation failed: ${resC.errors.join("; ")}`);

    const astR = parsePlan("load(POV) | load(POP) | residual | output");
    const resR = await validatePlan(astR, mockResolve);
    assert.strictEqual(resR.ok, true, `Validation failed: ${resR.errors.join("; ")}`);
  });

  await test("validatePlan: neighbors", async () => {
    const ast = parsePlan("load(POV) | neighbors(operation='difference') | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: access 2SFCA", async () => {
    const ast = parsePlan("load(POP) | access(HOSP, miles=30) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: zonal continuous raster", async () => {
    const ast = parsePlan("zonal(RAST_ELEV, operator='>', value=100) | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  await test("validatePlan: zonal categorical raster with class filter", async () => {
    const ast = parsePlan("zonal(RAST_LAND, type='cropland') | output");
    const res = await validatePlan(ast, mockResolve);
    assert.strictEqual(res.ok, true, `Validation failed: ${res.errors.join("; ")}`);
  });

  // =========================================================================
  // 7. SYNTAX REJECTION & ERROR HANDLING
  // =========================================================================
  console.log("\n--- 7. Syntax Rejection & Error Handling ---");

  await test("Rejects empty string", () => {
    assert.throws(() => parsePlan(""), DslParseError);
    assert.throws(() => parsePlan("   \n\t  "), DslParseError);
  });

  await test("Rejects unknown operator", () => {
    assert.throws(() => parsePlan("unknown_op(POV) | output"), (err) => {
      return err instanceof DslParseError && err.message.includes("unknown_op");
    });
  });

  await test("Rejects unmatched string quotes", () => {
    assert.throws(() => parsePlan("load('POV) | output"), DslParseError);
    assert.throws(() => parsePlan('load("POV) | output'), DslParseError);
  });

  await test("Rejects unmatched brackets", () => {
    assert.throws(() => parsePlan("filter_area([MO) | output"), DslParseError);
  });

  await test("Rejects unmatched parentheses", () => {
    assert.throws(() => parsePlan("load(POV | output"), DslParseError);
  });

  await test("Rejects duplicate explicit step IDs", () => {
    assert.throws(() => parsePlan("s1: load(POV) | s1: load(POP) | output"), (err) => {
      return err instanceof DslParseError && err.message.includes("Duplicate step id");
    });
  });

  await test("Rejects consecutive or trailing empty pipes", () => {
    assert.throws(() => parsePlan("load(POV) || output"), DslParseError);
    assert.throws(() => parsePlan("load(POV) | output |"), DslParseError);
    assert.throws(() => parsePlan("| load(POV) | output"), DslParseError);
  });

  await test("Rejects INTENT only without steps", () => {
    assert.throws(() => parsePlan("INTENT('Missing steps plan')"), DslParseError);
  });

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log(`\n=================================================`);
  console.log(`Test Execution Complete: ${pass} passed, ${fail} failed.`);
  console.log(`=================================================\n`);

  if (fail > 0) {
    process.exit(1);
  }
})();
