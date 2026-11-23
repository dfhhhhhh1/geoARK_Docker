/**
 * The area rule (planner/area.js) and the once-per-feature total
 * (planner/distinct_count.js). No model or database.
 * Run: node backend/planner/test_area.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const A = require("./area");
const C = require("./composite");
const M = require("./moran");
const { countFeaturesOnce, touchingNote } = require("./distinct_count");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["POV", { source_kind: "acs_long", census_code: "PCTPOVALL", description: "Poverty rate" }],
  ["UNINS", { source_kind: "acs_long", census_code: "UNINS", description: "Adults without health insurance" }],
  ["LINES", { source_kind: "feature_table", table_name: "transmission_lines", geom_column: "geom", label_columns: ["name"], value_columns: [{ column: "voltage", kind: "number", min: 0, max: 765, record: false }] }],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: ["name"] }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const load = (id, attr) => ({ id, op: "load", attr_id: attr, inputs: [] });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const fa = (id, from, ...states) => ({ id, op: "filter_area", attr_id: "", inputs: [from], states });
const comp = (id, inputs, extra = {}) => ({ id, op: "composite", attr_id: "", inputs, ...extra });
const rep = (id) => ({ LINES: "LINE", HOSP: "POINT" })[id] || "";

(async () => {
  console.log("area.js");

  await test("the ops that read states say so, and only those", () => {
    const readers = ["filter_area", "filter_place", "select_features", "network_population"];
    for (const n of readers) assert.ok(A.takesStates(n), n);
    for (const n of ["composite", "moran", "count_features", "load", "aggregate", "within", "summarize"]) {
      assert.ok(!A.takesStates(n), n);
    }
  });

  await test("states on a composite is not a restriction", () => {
    assert.ok(!A.hasAreaRestriction(plan(load("s1", "POV"), load("s2", "UNINS"),
      comp("s3", ["s1", "s2"], { states: ["Colorado"] }), out("s4", "s3"))));
    assert.ok(A.hasAreaRestriction(plan(load("s1", "POV"), fa("s2", "s1", "Colorado"), out("s3", "s2"))));
    assert.ok(A.hasAreaRestriction(plan({ id: "s1", op: "select_features", attr_id: "HOSP", inputs: [], states: ["Ohio"] }, out("s2", "s1"))));
  });

  await test("composite held out: states on the composite step becomes a filter_area before it", async () => {
    const p = plan(load("s1", "POV"), load("s2", "UNINS"),
      comp("s3", ["s1", "s2"], { states: ["Colorado"] }), out("s4", "s3"));
    const fixes = A.liftStrayStates(p);
    assert.strictEqual(fixes.length, 1);
    const c = p.steps.find(s => s.op === "composite");
    assert.strictEqual(c.states, undefined);
    // Every input is restricted, so the units it combines are the area's.
    for (const i of c.inputs) {
      const f = p.steps.find(s => s.id === i);
      assert.strictEqual(f.op, "filter_area"); assert.deepStrictEqual(f.states, ["Colorado"]);
    }
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved);
    // The composite reads the restricted inputs: the area is in the SQL that scores it.
    assert.deepStrictEqual(o.params.filter(x => x === "08"), ["08", "08"], "Colorado (08) binds once per restricted input");
    assert.ok(/IN \(\$\d+\)/.test(o.sql) && /JOIN step_\w+_in_area/.test(o.sql), o.sql);
  });

  await test("states on a step that reads nothing: the restriction goes after it", async () => {
    const p = plan({ ...load("s1", "POV"), states: ["Ohio"] }, out("s2", "s1"));
    A.liftStrayStates(p);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["load", "filter_area", "output"]);
    assert.deepStrictEqual(p.steps[2].inputs, [p.steps[1].id]);
    assert.ok((await validatePlan(p, resolve)).ok);
  });

  await test("a filter_area already in place is not doubled", () => {
    const p = plan(load("s1", "POV"), fa("s2", "s1", "Ohio"), { ...comp("s3", ["s2"]), states: ["Ohio"] }, out("s4", "s3"));
    A.liftStrayStates(p);
    assert.strictEqual(p.steps.filter(s => s.op === "filter_area").length, 1);
  });

  await test("states on a features step cannot be moved: validation names the fix", async () => {
    const p = plan({ id: "s1", op: "select_features", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "select_features", attr_id: "HOSP", inputs: [] },
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 5, states: ["Ohio"] },
      { id: "s4", op: "summarize", attr_id: "", inputs: ["s3"], group_by: "none" }, out("s5", "s4"));
    assert.deepStrictEqual(A.liftStrayStates(p), []);
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok && v.errors.some(e => /step "s3" \(within\): "states" has no effect/.test(e)), v.errors.join("; "));
  });

  await test("states on the ops that read it still validate", async () => {
    const p = plan({ id: "s1", op: "select_features", attr_id: "HOSP", inputs: [], states: ["Ohio"] },
      { id: "s2", op: "summarize", attr_id: "", inputs: ["s1"], group_by: "none" }, out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
  });

  await test("composite: the one named state is added when only a stray states was set", () => {
    // Order the repairs run in: lift first, so the plan is already restricted.
    const q = "Score every Colorado county on poverty and uninsured rate";
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"], { states: ["Colorado"] }), out("s4", "s3"));
    A.liftStrayStates(p);
    assert.strictEqual(C.restrictToNamedArea(p, q), null);
    // Without the lift, the rule now sees an unrestricted plan and adds the state itself.
    const p2 = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"], { states: ["Colorado"] }), out("s4", "s3"));
    const msg = C.restrictToNamedArea(p2, q);
    assert.ok(/restricted the scores to Colorado/.test(msg), msg);
    assert.strictEqual(p2.steps.find(s => s.op === "composite").inputs[0].endsWith("_area"), true);
  });

  await test("composite and moran share the rule: national, two states and an existing filter stand down", () => {
    const p = () => plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"]), out("s4", "s3"));
    assert.strictEqual(C.restrictToNamedArea(p(), "score counties nationally, Colorado first"), null);
    assert.strictEqual(C.restrictToNamedArea(p(), "score Colorado and Utah counties"), null);
    const withFilter = plan(load("s1", "POV"), fa("f", "s1", "Utah"), load("s2", "UNINS"), comp("s3", ["f", "s2"]), out("s4", "s3"));
    assert.strictEqual(C.restrictToNamedArea(withFilter, "score Colorado counties"), null);
    const m = plan(load("s1", "POV"), { id: "s2", op: "moran", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    assert.ok(/restricted Moran's I to Texas/.test(M.applyMoran(m, "is poverty clustered across Texas counties?", { stepTypes: ops.stepTypes }).fixes.join(" ")));
  });

  console.log("distinct_count.js");

  const lineTotal = (extra = {}, tail = []) => plan(
    { id: "s1", op: "count_features", attr_id: "LINES", inputs: [], ...extra },
    fa("s2", "s1", "Kansas"),
    { id: "s3", op: "aggregate", attr_id: "", inputs: ["s2"], function: "sum" },
    ...tail, out("s4", "s3"));

  await test("a sum of line counts becomes select_features -> summarize (345 kV, 157 for 68)", async () => {
    const p = lineTotal({ value_filters: [{ column: "voltage", operator: ">=", value: 345, kind: "number" }] });
    const note = countFeaturesOnce(p, rep);
    assert.ok(/counted each feature once/.test(note), note);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["select_features", "summarize", "output"]);
    const sel = p.steps[0];
    assert.deepStrictEqual(sel.states, ["Kansas"]);
    assert.strictEqual(sel.attr_id, "LINES");
    assert.strictEqual(sel.value_filters[0].value, 345);
    assert.strictEqual(p.steps[1].group_by, "none");
    assert.deepStrictEqual(p.steps[2].inputs, ["s3"]);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved);
    const sql = o.sql;
    // One row per feature, then COUNT(*): not a sum of per-county counts.
    assert.ok(/COUNT\(\*\)/.test(sql) && !/county_geom c LEFT JOIN/.test(sql), sql);
    assert.ok(/EXISTS \(SELECT 1 FROM county_geom/.test(sql), sql);
  });

  await test("by state keeps group_by state", () => {
    const p = plan({ id: "s1", op: "count_features", attr_id: "LINES", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum", group_by: "state" }, out("s3", "s2"));
    assert.ok(countFeaturesOnce(p, rep));
    assert.strictEqual(p.steps.find(s => s.op === "summarize").group_by, "state");
  });

  await test("left alone: points, a rank in the chain, a second reader, a mean", () => {
    const pts = plan({ id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum" }, out("s3", "s2"));
    assert.strictEqual(countFeaturesOnce(pts, rep), null);
    const ranked = plan({ id: "s1", op: "count_features", attr_id: "LINES", inputs: [] },
      { id: "s2", op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 5 },
      { id: "s3", op: "aggregate", attr_id: "", inputs: ["s2"], function: "sum" }, out("s4", "s3"));
    assert.strictEqual(countFeaturesOnce(ranked, rep), null);
    const shared = plan({ id: "s1", op: "count_features", attr_id: "LINES", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum" }, out("s3", "s2"), out("s4", "s1"));
    assert.strictEqual(countFeaturesOnce(shared, rep), null);
    const mean = plan({ id: "s1", op: "count_features", attr_id: "LINES", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "mean" }, out("s3", "s2"));
    assert.strictEqual(countFeaturesOnce(mean, rep), null);
  });

  await test("a per-county count of lines says what it counts; points do not", () => {
    const lines = plan({ id: "s1", op: "count_features", attr_id: "LINES", inputs: [] }, out("s2", "s1"));
    assert.ok(/touches it/.test(touchingNote(lines, rep)));
    const pts = plan({ id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] }, out("s2", "s1"));
    assert.strictEqual(touchingNote(pts, rep), null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
