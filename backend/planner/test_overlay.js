/**
 * Overlay and amounts (docs/GIS_OPS_PLAN.md H3): overlay validates, types and
 * compiles; summarize totals a length or an area in the unit the question
 * asked; geometry-only reads use a layer's parts; and the gates keep all of it
 * out of every existing prompt. No model or database.
 * Run: node backend/planner/test_overlay.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { overlayAlgebra, measureAlgebra, applyMeasures, featureAlgebra } = require("./features");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const PARTS = { parts_table: "fp_wetlands", key_column: "ogc_fid", threshold: 1024 };
const SRC = new Map([
  ["WET", { source_kind: "feature_table", table_name: "wetlands", geom_column: "geom", label_columns: ["type"],
            filter_values: { type: ["Riverine", "Lake"] }, parts: PARTS }],
  ["ROAD", { source_kind: "feature_table", table_name: "roads", geom_column: "geom", label_columns: ["name"] }],
  ["FIRE", { source_kind: "feature_table", table_name: "fire_stations", geom_column: "geom", label_columns: ["name"] }],
]);
const REP = { WET: "POLYGON", ROAD: "LINE", FIRE: "POINT" };
const repOf = (id) => REP[id] || "";
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, attr, extra = {}) => ({ id, op: "select_features", attr_id: attr, inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const ov = (id, a, b, extra = {}) => ({ id, op: "overlay", attr_id: "", inputs: [a, b], ...extra });
const sum = (id, from, extra = {}) => ({ id, op: "summarize", attr_id: "", inputs: [from], ...extra });

function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
  // No Postgres here, so at least the nesting: the first H3 dev run died on
  // "COALESCE(SUM(x), 0" written as "SUM(x, 0)" (a syntax error only the
  // database saw, 2026-11-12). Every prefix keeps depth >= 0, and it ends at 0.
  let depth = 0;
  for (const ch of o.sql.replace(/'[^']*'/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")") { depth--; assert.ok(depth >= 0, "a ) closes nothing"); }
  }
  assert.strictEqual(depth, 0, "unbalanced parentheses");
  // A function given more arguments than it takes is what that defect looked like.
  assert.doesNotMatch(o.sql, /\bSUM\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*,\s*0\)/, "SUM(x, 0)");
}

// Overlay context: two layers, one of them polygons.
const CTX = (query, extra = {}) => ({ query, hasFeatureTables: true, featureTableCount: 2,
                                      hasPolygonLayer: true, ...extra });

(async () => {
  await test("overlay validates, types as features, compiles with a union of input 2", async () => {
    const p = plan(sel("s1", "FIRE", { states: ["California"] }), sel("s2", "WET"), ov("s3", "s1", "s2"), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    assert.strictEqual(ops.stepTypes(p.steps).get("s3"), "features");
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /ST_Union\(CASE WHEN ST_IsValid\(b\.geom\)/);
    assert.match(c.sql, /WHERE k\.g IS NOT NULL/);
    // Not clipped: "which stations" keeps each feature whole.
    assert.match(c.sql, /SELECT a\.geom AS geom/);
  });

  await test("overlay exclude is a LATERAL LIMIT 1 probe (not NOT EXISTS), no measure", async () => {
    const p = plan(sel("s1", "FIRE"), sel("s2", "WET"), ov("s3", "s1", "s2", { exclude: true }), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    // NOT EXISTS became an anti-join that scanned the whole parts UNION ALL
    // (H3 held-out: statement timeout).
    assert.match(c.sql, /LEFT JOIN LATERAL \(SELECT 1 AS hit FROM step_s2 b WHERE .* LIMIT 1\) k ON true WHERE k\.hit IS NULL/);
    assert.doesNotMatch(c.sql, /NOT EXISTS/);
  });

  await test("overlay refuses a distance: that is within", async () => {
    const p = plan(sel("s1", "FIRE"), sel("s2", "WET"), ov("s3", "s1", "s2", { miles: 2 }), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(e => /use within/.test(e)), v.errors.join("; "));
  });

  await test("overlay needs features on both sides", async () => {
    const p = plan(sel("s1", "FIRE"), { id: "s2", op: "load", attr_id: "FIRE", inputs: [] },
                   ov("s3", "s1", "s2"), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
  });

  await test("miles of road through wetlands: length in miles, clipped, wetlands read as parts", async () => {
    const p = plan(sel("s1", "ROAD", { states: ["Missouri"] }), sel("s2", "WET"), ov("s3", "s1", "s2"),
                   sum("s4", "s3", { group_by: "none" }), out("s5", "s4"));
    const fix = applyMeasures(p, "How many miles of primary roads in Missouri pass through wetlands?", repOf);
    assert.ok(fix);
    assert.strictEqual(p.steps[3].measure, "length");
    assert.strictEqual(p.steps[3].unit, "miles");
    assert.strictEqual(p.steps[2].clip, true);
    assert.strictEqual(p.steps[1].geometry_only, true);
    // The roads are summed too, but they have no parts: the flag is harmless.
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /UNION ALL SELECT p\.geom AS geom/);
    assert.match(c.sql, /JOIN wetlands f ON f\.ogc_fid = p\.fid/);
    assert.match(c.sql, /SUM\(ST_Length\(ST_CollectionExtract/);
    assert.match(c.sql, /SELECT p\.part AS geom/);
  });

  await test("acres of wetland per unit: area, acres, per-unit LATERAL, parts", async () => {
    const p = plan(sel("s1", "WET"), sum("s2", "s1"), out("s3", "s2"));
    applyMeasures(p, "How many acres of wetlands are in each St. Louis ward?", repOf);
    assert.strictEqual(p.steps[1].measure, "area");
    assert.strictEqual(p.steps[1].unit, "acres");
    assert.strictEqual(p.steps[0].geometry_only, true);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /LEFT JOIN LATERAL \(SELECT SUM\(ST_Area/);
    assert.ok(c.outputs[0].params.includes(4046.8564224), "the acre factor is bound");
  });

  await test("count_features of a polygon layer, asked for acres, becomes a measured summarize", async () => {
    // H3 dev r2: "How many acres of wetlands are in each St. Louis ward?"
    // planned count_features and counted polygons.
    const p = plan({ id: "s1", op: "count_features", attr_id: "WET", inputs: [] }, out("s2", "s1"));
    const fix = applyMeasures(p, "How many acres of wetlands are in each St. Louis ward?", repOf);
    assert.match(fix, /measures WET instead of counting/);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["select_features", "summarize", "output"]);
    assert.strictEqual(p.steps[1].id, "s1", "the step keeps its id, so its readers still find it");
    assert.strictEqual(p.steps[1].measure, "area");
    assert.strictEqual(p.steps[1].unit, "acres");
    assert.strictEqual(p.steps[0].geometry_only, true);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    paramsMatch(compilePlan(p, v.resolved).outputs[0]);
    // A count of points, or a question that asks no amount, is left alone.
    const q = plan({ id: "s1", op: "count_features", attr_id: "FIRE", inputs: [] }, out("s2", "s1"));
    assert.strictEqual(applyMeasures(q, "how many acres of fire stations in each ward", repOf), null);
    const r = plan({ id: "s1", op: "count_features", attr_id: "WET", inputs: [] }, out("s2", "s1"));
    assert.strictEqual(applyMeasures(r, "how many wetlands are in each St. Louis ward", repOf), null);
    assert.strictEqual(r.steps[0].op, "count_features");
  });

  await test("square kilometers, hectares and kilometers are read from the question", () => {
    for (const [q, attr, unit] of [
      ["total area of wetlands in square kilometers in each county", "WET", "square kilometers"],
      ["how many hectares of wetland lie in Missouri", "WET", "hectares"],
      ["how many kilometers of road cross wetlands", "ROAD", "kilometers"],
      ["what is the total area of wetland in each ward", "WET", "square miles"],
    ]) {
      const p = plan(sel("s1", attr), sum("s2", "s1"), out("s3", "s2"));
      applyMeasures(p, q, repOf);
      assert.strictEqual(p.steps[1].unit, unit, q);
    }
  });

  await test("counting features stays a count: no amount asked, or points", () => {
    const a = plan(sel("s1", "FIRE"), sel("s2", "WET"), ov("s3", "s1", "s2"), sum("s4", "s3", { group_by: "none" }), out("s5", "s4"));
    applyMeasures(a, "How many college campuses in Missouri overlap a wetland?", repOf);
    assert.strictEqual(a.steps[3].measure, undefined);
    assert.strictEqual(a.steps[2].clip, undefined);
    // The features are counted, so they are read whole; the layer tested
    // against is still geometry only.
    assert.strictEqual(a.steps[0].geometry_only, undefined);
    assert.strictEqual(a.steps[1].geometry_only, true);
    const b = plan(sel("s1", "FIRE"), sum("s2", "s1", { group_by: "none" }), out("s3", "s2"));
    applyMeasures(b, "how many acres of fire stations", repOf);
    assert.strictEqual(b.steps[1].measure, undefined, "a point layer has no area");
  });

  await test("a listed overlay result is read whole, never as parts", () => {
    const p = plan(sel("s1", "WET"), sel("s2", "ROAD"), ov("s3", "s1", "s2"), out("s4", "s3"));
    applyMeasures(p, "Which wetlands do primary roads cross?", repOf);
    assert.strictEqual(p.steps[0].geometry_only, undefined);
  });

  await test("a state restriction on a parts read tests the whole feature, not the part", async () => {
    // H3 held-out: testing parts dropped the out-of-state pieces of large
    // perimeters only, 551.7 km for 563.8.
    const p = plan(sel("s1", "ROAD"), sel("s2", "WET", { states: ["Oregon"], geometry_only: true }),
                   ov("s3", "s1", "s2"), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    const [small, large] = c.sql.split("UNION ALL");
    assert.match(small, /EXISTS \(SELECT 1 FROM county_geom c WHERE c\.geom && f\.geom/);
    assert.match(large, /f\.geoark_states && ARRAY\[\$\d+\]::text\[\]/);
    assert.doesNotMatch(large, /c\.geom && p\.geom/);
  });

  await test("a layer without parts compiles as before under geometry_only", async () => {
    const p = plan(sel("s1", "ROAD", { geometry_only: true }), sum("s2", "s1", { measure: "length", unit: "miles", group_by: "none" }), out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    assert.doesNotMatch(c.sql, /UNION ALL/);
  });

  await test("gates: overlay phrasing with a polygon layer, and nothing else", () => {
    for (const q of [
      "Which fire stations in California are inside a wildfire perimeter?",
      "How many miles of primary roads in Missouri pass through wetlands?",
      "How many college campuses in Missouri overlap a wetland?",
      "List the transmission lines that cross wildfire perimeters in Oregon",
      "schools located within a flood zone in Louisiana",
    ]) assert.ok(overlayAlgebra(CTX(q)), q);
    // A distance is within's; points only has nothing to be inside; one layer
    // has nothing to overlay; people are a catchment.
    for (const [q, extra] of [
      ["Which hospitals in Ohio are within 2 miles of a fire station?", {}],
      ["Show the fire stations in Colorado located within 800 meters of a nursing home.", {}],
      ["Which fire stations are inside a wildfire perimeter?", { hasPolygonLayer: undefined }],
      ["Which fire stations are inside a wildfire perimeter?", { featureTableCount: 1 }],
      ["how many people live inside a flood zone", {}],
      ["hospitals within the state of Ohio", {}],
      ["How many child care centers are there in each St. Louis ward?", {}],
      ["What is the poverty rate across Missouri counties?", {}],
    ]) assert.ok(!overlayAlgebra(CTX(q, extra)), q);
  });

  await test("amount gate: a length or area of a line or polygon layer", () => {
    assert.ok(measureAlgebra(CTX("How many acres of wetlands are in each St. Louis ward?")));
    assert.ok(measureAlgebra(CTX("total length of primary roads in Missouri", { hasPolygonLayer: undefined, hasLineLayer: true })));
    assert.ok(!measureAlgebra(CTX("which hospitals are within 10 miles of a fire station")));
    assert.ok(!measureAlgebra(CTX("how many acres of wetland", { hasPolygonLayer: undefined })));
    assert.ok(!measureAlgebra(CTX("population per square mile", {})), "people are not an amount of a layer");
  });

  await test("the H1 proximity questions are untouched by the new gates", () => {
    for (const q of [
      "Which hospitals in Ohio are within 2 miles of a fire station?",
      "How many child care centers in Arizona are more than 5 kilometers from the nearest hospital?",
      "List the 10 nursing homes in Montana that are farthest from a hospital.",
      "How many law enforcement offices in Georgia have a hospital within 1 mile?",
    ]) {
      const ctx = CTX(q);
      assert.ok(featureAlgebra(ctx), q);
      assert.ok(!overlayAlgebra(ctx) && !measureAlgebra(ctx), q);
      assert.ok(!ops.offeredFor(ctx).includes("overlay"), q);
    }
  });

  await test("schema and prompt name overlay only when it is offered", () => {
    const { planSchemaFor } = require("../schemas");
    const on = planSchemaFor(CTX("Which fire stations in California are inside a wildfire perimeter?"));
    const off = planSchemaFor(CTX("Which hospitals in Ohio are within 2 miles of a fire station?"));
    const enumOf = (s) => JSON.stringify(s).match(/"enum":\[("load"[^\]]*)\]/)[1];
    assert.match(enumOf(on), /"overlay"/);
    assert.doesNotMatch(enumOf(off), /"overlay"/);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
