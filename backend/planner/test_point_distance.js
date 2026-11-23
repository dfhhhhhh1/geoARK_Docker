/**
 * Tests for planner/point_distance.js and ops/point_distance.js.
 * Run: node backend/planner/test_point_distance.js
 */
"use strict";
const assert = require("assert");
const { pointStatOf, columnFor, applyPointDistance, setLoadedStates } = require("./point_distance");
const op = require("./ops/point_distance");

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`ok ${n} ${name}`); };

t("share, farther", () => {
  const s = pointStatOf("What share of each Missouri county is more than 20 miles from a hospital?");
  assert.deepStrictEqual([s.stat, s.threshold, s.cmp], ["share", 20, ">"]);
});
t("share, within, km", () => {
  const s = pointStatOf("percent of each tract in Missouri within 5 km of a school");
  assert.deepStrictEqual([s.stat, s.cmp], ["share", "<="]);
  assert.ok(Math.abs(s.threshold - 3.107) < 0.001);
});
t("percentile / median / max / mean", () => {
  assert.strictEqual(pointStatOf("the 90th percentile distance to a hospital in each Missouri county").q, 90);
  assert.strictEqual(pointStatOf("median distance to the nearest hospital for each tract in Missouri").q, 50);
  assert.strictEqual(pointStatOf("the farthest point in each Missouri county from a hospital").stat, "max");
  assert.strictEqual(pointStatOf("average distance to a hospital across each county in Missouri").stat, "mean");
  assert.strictEqual(pointStatOf("using the fine points, how far is each Missouri county from a hospital").stat, "mean");
});
t("not a distribution: untouched", () => {
  for (const q of [
    "how far is each county from the nearest hospital",
    "How far is the center of each Missouri county from the nearest hospital?",
    "which counties in Missouri are farthest from a hospital",
    "how many people live more than 20 miles from a hospital in Missouri",
    "the center of each county, 90th percentile distance",
    // the three eval questions the first gate wrongly reached
    "Score every Texas county on poverty rate, median household income and distance to the nearest hospital, weighting poverty at 50%, income at 25% and hospital distance at 25%.",
    "What share of Colorado's population lives within 5 miles of a hospital?",
    "Which counties with above-median poverty rates are more than 30 miles from the nearest hospital?",
  ]) assert.strictEqual(pointStatOf(q), null, q);
});
t("layer names", () => {
  assert.strictEqual(columnFor("Hospitals"), "hosp_mi");
  assert.strictEqual(columnFor("CMS long-term care hospitals"), null);
  assert.strictEqual(columnFor("Epa Emergency Response (Er) Toxic Release Inventory (Tri) Facilities"), "tri_facility_mi");
  assert.strictEqual(columnFor("Public Transit Stops"), null);
  assert.strictEqual(columnFor("Fire Stations"), null);
});

const plan = (states) => ({ steps: [
  { id: "s1", op: "nearest_distance", attr_id: "a4", inputs: [] },
  ...(states ? [{ id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states }] : []),
  { id: "s3", op: "output", attr_id: "", inputs: [states ? "s2" : "s1"] },
] });
const nameOf = () => "Hospitals";

t("swap in a loaded state", () => {
  setLoadedStates(["29"]);
  const p = plan(["Missouri"]);
  const r = applyPointDistance(p, "What share of each Missouri county is more than 20 miles from a hospital?", { nameOf });
  assert.strictEqual(r.fixes.length, 1);
  assert.deepStrictEqual(p.steps[0], { id: "s1", attr_id: "a4", inputs: [], op: "point_distance",
    column: "hosp_mi", stat: "share", state_fips: ["29"], threshold: 20, cmp: ">" });
  assert.deepStrictEqual(op.validate(p.steps[0]), []);
});
t("not loaded / national: note, no swap", () => {
  setLoadedStates(["29"]);
  const p1 = plan(["Kansas"]);
  const r1 = applyPointDistance(p1, "90th percentile distance to a hospital in each Kansas county", { nameOf });
  assert.strictEqual(p1.steps[0].op, "nearest_distance");
  assert.ok(/Kansas/.test(r1.notes[0]));
  const p2 = plan(null);
  const r2 = applyPointDistance(p2, "90th percentile distance to a hospital in each county", { nameOf });
  assert.strictEqual(p2.steps[0].op, "nearest_distance");
  assert.strictEqual(r2.notes.length, 1);
});
t("threshold filter keeps the centre distance", () => {
  setLoadedStates(["29"]);
  const p = { steps: [
    { id: "s1", op: "nearest_distance", attr_id: "a4", inputs: [] },
    { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
    { id: "s3", op: "filter_attr", attr_id: "", inputs: ["s2"], operator: ">", value: 20 },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }] };
  // filter_attr reads s2, not s1, so the swap is allowed here; a direct reader is not.
  p.steps[2].inputs = ["s1"];
  const r = applyPointDistance(p, "median distance to a hospital in each Missouri county over 20 miles", { nameOf });
  assert.strictEqual(p.steps[0].op, "nearest_distance");
  assert.strictEqual(r.fixes.length, 0);
});

t("share absorbs the model's own threshold filter", () => {
  setLoadedStates(["29"]);
  const p = { steps: [
    { id: "s1", op: "nearest_distance", attr_id: "a4", inputs: [] },
    { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 20 },
    { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Missouri"] },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }] };
  const r = applyPointDistance(p, "What share of each Missouri county is more than 20 miles from a hospital?", { nameOf });
  assert.strictEqual(p.steps[0].op, "point_distance");
  assert.deepStrictEqual(p.steps.map(s => s.id), ["s1", "s3", "s4"]);
  assert.deepStrictEqual(p.steps[1].inputs, ["s1"]);
  assert.strictEqual(r.fixes.length, 2);
});

t("a summary load is read from the points for a median", () => {
  setLoadedStates(["29"]);
  const p = { steps: [
    { id: "s1", op: "load", attr_id: "HSIP_PROXIMITY_DIST_PUBLIC_SCHOOL", inputs: [] },
    { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
    { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] };
  applyPointDistance(p, "For each Missouri county, what is the median distance to the nearest public school?", { nameOf });
  assert.deepStrictEqual(p.steps[0], { id: "s1", inputs: [], op: "point_distance", measure_id: "HSIP_PROXIMITY_DIST_PUBLIC_SCHOOL",
    column: "public_school_mi", stat: "pct", state_fips: ["29"], q: 50 });
});

const ctx = (level) => {
  const params = [];
  return { name: "s1", level, bind: (v) => { params.push(v); return `$${params.length}`; }, params };
};
t("compile: county prefix, tract, zcta spatial", () => {
  const st = { id: "s1", op: "point_distance", column: "hosp_mi", stat: "pct", q: 90, state_fips: ["29"] };
  const c = ctx("county");
  const sql = op.compile(st, c);
  assert.ok(sql.includes("left(f.block20, 5)") && sql.includes("percentile_cont") && sql.includes("ANY($2::bpchar[])"));
  assert.deepStrictEqual(c.params, [0.9, ["29"]]);
  assert.ok(op.compile(st, ctx("tract")).includes("left(f.block20, 11)"));
  assert.ok(op.compile({ ...st, stat: "share", threshold: 20, cmp: ">" }, ctx("zcta")).includes("ST_Intersects"));
  assert.throws(() => op.compile(st, ctx("grid4k")));
});

console.log(`${n} passed`);
