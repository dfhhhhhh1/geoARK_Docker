/**
 * Nearest with identity, and k (docs/GIS_OPS_PLAN.md H6 tier 1, item 3):
 * the phrasing gate, the field repair, validation, compilation (plain form
 * unchanged, k form, the name carried past filters and ranks). No model or
 * database; the brute-force check against PostGIS is in the plan's Progress.
 * Run: node backend/planner/test_nearest.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const { nearestAsk, applyNearest, nearestValueLabel } = require("./nearest");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: ["name", "city", "state"] }],
  ["WELLS", { source_kind: "feature_table", table_name: "wells", geom_column: "geom", label_columns: ["type"] }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const near = (id, extra = {}) => ({ id, op: "nearest_distance", attr_id: "HOSP", inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const labelsOf = (id) => SRC.get(id)?.label_columns ?? null;

function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

(async () => {
  await test("gate: which / what / name / list the nearest", () => {
    for (const q of [
      "which hospital is nearest to each county in Missouri",
      "what is the closest airport to each census tract in Utah",
      "what's the nearest hospital for every county in Iowa",
      "How far is each Missouri county from its nearest fire station, and which one is it?",
      "name the nearest trauma center for every county in Ohio",
      "list the nearest hospital to each county in Iowa",
      "For each census tract in Delaware, which fire station is nearest?",
      "which critical access hospital is closest to each county",
    ]) assert.deepStrictEqual(nearestAsk(q), { identify: true }, q);
  });

  await test("gate: k, mean and k-th", () => {
    assert.deepStrictEqual(nearestAsk("average distance from each county to the 3 nearest hospitals"),
      { identify: true, k: 3, k_stat: "mean" });
    assert.deepStrictEqual(nearestAsk("what are the three nearest airports to each county in Kansas"),
      { identify: true, k: 3, k_stat: "mean" });
    assert.deepStrictEqual(nearestAsk("how far is the second-nearest hospital from each county in Texas"),
      { identify: true, k: 2, k_stat: "kth" });
    assert.deepStrictEqual(nearestAsk("distance to the 3rd closest hospital for census tracts in Ohio"),
      { identify: true, k: 3, k_stat: "kth" });
  });

  await test("gate: distance only, units as the subject, people", () => {
    for (const q of [
      "how far is each county from the nearest hospital",
      "which counties are farthest from the nearest hospital",
      "what is the distance to the nearest hospital for each county",
      "the 10 closest counties to a hospital",
      "which 10 counties in Texas are farthest from a hospital",
      "how many people live more than 20 miles from the nearest hospital",
      "which tracts are closest to a fire station",
      "which Missouri census tracts are nearest to a hospital",
    ]) assert.strictEqual(nearestAsk(q), null, q);
  });

  await test("gate: k with no unit to measure from is not applied", () => {
    assert.deepStrictEqual(nearestAsk("the 5 closest hospitals to Kansas City"), { unplaced_k: 5 });
    const p = plan(near("s1"), out("s2", "s1"));
    const r = applyNearest(p, "the 5 closest hospitals to Kansas City", { labelsOf });
    assert.strictEqual(p.steps[0].k, undefined);
    assert.ok(r.notes.some(n => /names no unit/.test(n)));
  });

  await test("apply: sets fields; refuses to name a layer with no name column", () => {
    const p = plan(near("s1"), out("s2", "s1"));
    applyNearest(p, "average distance from each county to the 3 nearest hospitals", { labelsOf });
    assert.deepStrictEqual([p.steps[0].k, p.steps[0].k_stat, p.steps[0].identify], [3, "mean", true]);
    const w = plan(near("s1", { attr_id: "WELLS" }), out("s2", "s1"));
    const r = applyNearest(w, "which well is nearest to each county", { labelsOf });
    assert.strictEqual(w.steps[0].identify, undefined);
    assert.ok(r.notes.some(n => /no name or address/.test(n)));
  });

  await test("validate: fields from a browser plan are checked", async () => {
    for (const bad of [{ k: 0 }, { k: 2.5 }, { k: 99 }, { k_stat: "median" }, { identify: "yes" }]) {
      const v = await validatePlan(plan(near("s1", bad), out("s2", "s1")), resolve);
      assert.ok(!v.ok, JSON.stringify(bad));
    }
    const ok = await validatePlan(plan(near("s1", { k: 3, k_stat: "kth", identify: true }), out("s2", "s1")), resolve);
    assert.ok(ok.ok, (ok.errors || []).join("; "));
  });

  await test("compile: the plain form is unchanged (no name column, no label)", async () => {
    const p = plan(near("s1"), out("s2", "s1"));
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    assert.ok(!/nearest_name/.test(c.sql));
    assert.ok(/min\(ST_Distance/.test(c.sql));
    assert.strictEqual(c.outputs[0].valueLabel, null);
    assert.deepStrictEqual(c.outputs[0].rowColumns, []);
  });

  await test("compile: k form binds every parameter and names with city, state", async () => {
    const p = plan(near("s1", { k: 3, k_stat: "mean", identify: true }), out("s2", "s1"));
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.ok(/concat_ws\(', ', NULLIF\(f\.name::text, ''\), NULLIF\(f\.city::text, ''\), NULLIF\(f\.state::text, ''\)\)/.test(c.sql));
    assert.ok(/avg\(q\.d\)/.test(c.sql) && /r\.nearest_name/.test(c.sql));
    assert.deepStrictEqual(c.outputs[0].rowColumns, ["nearest_name"]);
    assert.strictEqual(c.outputs[0].valueLabel, "mean miles to the 3 nearest features");
    const kth = plan(near("s1", { k: 2, k_stat: "kth", identify: true }), out("s2", "s1"));
    const ck = compilePlan(kth, (await validatePlan(kth, resolve)).resolved);
    assert.ok(/max\(q\.d\)/.test(ck.sql));
    assert.strictEqual(ck.outputs[0].valueLabel, "miles to the second-nearest feature");
  });

  await test("compile: the name survives filter_area and rank, not normalize", async () => {
    const p = plan(near("s1", { identify: true }),
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      { id: "s3", op: "rank", attr_id: "", inputs: ["s2"], direction: "desc", limit: 10 },
      out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, (v.errors || []).join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.ok(/LEFT JOIN step_s1 nn ON nn\.fips = r\.fips/.test(c.sql));
    assert.ok(/nn\.nearest_name/.test(c.sql));
    assert.strictEqual(c.outputs[0].valueLabel, "miles to the nearest feature");
  });

  await test("compile: below the county, from each unit's point", async () => {
    const p = { ...plan(near("s1", { k: 2, identify: true }), out("s2", "s1")), level: "tract" };
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.ok(/FROM geo_unit u/.test(c.sql) && /u\.pt/.test(c.sql));
  });

  await test("repair: a count of the same layer joined to the distance is dropped, its filter kept", async () => {
    const q = "Which hospital is closest to the center of each Missouri county, and how many miles away is it?";
    const p = plan(
      { id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      near("s3"),
      { id: "s4", op: "join", attr_id: "", inputs: ["s2", "s3"] },
      out("s5", "s4"));
    const r = applyNearest(p, q, { labelsOf });
    assert.ok(r.fixes.some(f => /dropped the count/.test(f)), r.fixes.join("; "));
    assert.deepStrictEqual(p.steps.map(s => `${s.id}:${s.op}<${(s.inputs || []).join(",")}`),
      ["s3:nearest_distance<", "s2:filter_area<s3", "s5:output<s2"]);
    assert.strictEqual(p.steps[0].identify, true);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, (v.errors || []).join("; "));
    const c = compilePlan(p, v.resolved);
    assert.ok(/nn\.nearest_name/.test(c.sql));
  });

  await test("repair: left alone for a different layer, or without 'which'", () => {
    const mk = () => plan(
      { id: "s1", op: "count_features", attr_id: "WELLS", inputs: [] },
      near("s2"),
      { id: "s3", op: "join", attr_id: "", inputs: ["s1", "s2"] },
      out("s4", "s3"));
    const p = mk();
    applyNearest(p, "which hospital is nearest to each county", { labelsOf });
    assert.strictEqual(p.steps.length, 4);
    const same = mk(); same.steps[0].attr_id = "HOSP";
    applyNearest(same, "how many hospitals are in each county and how far is the nearest", { labelsOf });
    assert.strictEqual(same.steps.length, 4);
  });

  await test("repair: a mean over all counties of a k-mean is dropped; a plain one is kept", async () => {
    const q = "What is the average distance in miles from each Texas county to its 3 nearest hospitals?";
    const mk = () => ({ ...plan(near("s1"),
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Texas"] },
      { id: "s3", op: "aggregate", attr_id: "", inputs: ["s2"], function: "mean" },
      out("s4", "s3")), output_type: "statistics" });
    const p = mk();
    const r = applyNearest(p, q, { labelsOf });
    assert.ok(r.fixes.some(f => /mean over all units/.test(f)), r.fixes.join("; "));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["nearest_distance", "filter_area", "output"]);
    assert.strictEqual(p.steps[2].inputs[0], "s2");
    assert.ok((await validatePlan(p, resolve)).ok);
    const plain = mk();
    applyNearest(plain, "what is the average distance from Texas counties to the nearest hospital", { labelsOf });
    assert.strictEqual(plain.steps.length, 4);
  });

  await test("value label", () => {
    assert.strictEqual(nearestValueLabel({}), "miles to the nearest feature");
    assert.strictEqual(nearestValueLabel({ k: 5, k_stat: "mean" }), "mean miles to the 5 nearest features");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
