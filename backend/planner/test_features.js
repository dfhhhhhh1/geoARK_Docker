/**
 * The typed DAG and the feature algebra (docs/GIS_OPS_PLAN.md H1): types on
 * every edge, select_features -> within -> summarize / rank, scalars into
 * combine, distance units in code, and the gates that keep all of it out of
 * every existing prompt. No model or database.
 * Run: node backend/planner/test_features.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const {
  featureAlgebra, repairDistanceUnits, distanceMentions, repairWithinDirection,
  widenReferenceLayer, referencePhrase,
} = require("./features");
const { applyCatchment } = require("./catchment");
const { totalTheDenominator, bridgeFromLoadedLayer } = require("./rewire");
const { planSchemaFor } = require("../schemas");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const LABELS = ["name", "city", "state"];
const SRC = new Map([
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: LABELS, filter_values: { type: ["CRITICAL ACCESS", "GENERAL ACUTE CARE"] } }],
  ["FIRE", { source_kind: "feature_table", table_name: "fire_stations", geom_column: "geom", label_columns: ["name"] }],
  ["POP", { source_kind: "acs_long", census_code: "POP_ESTIMATE", description: "Total population" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, attr, extra = {}) => ({ id, op: "select_features", attr_id: attr, inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });

// Every $n a statement uses must be bound, and nothing more: the defect
// combine once shipped (CLAUDE.md, "Two defects this load introduced").
function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

(async () => {
  await test("within -> summarize(none) validates and yields a scalar", async () => {
    const p = plan(sel("s1", "HOSP", { states: ["Ohio"] }), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 2 },
      { id: "s4", op: "summarize", attr_id: "", inputs: ["s3"], group_by: "none" },
      out("s5", "s4"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const t = ops.stepTypes(p.steps);
    assert.strictEqual(t.get("s3"), "features");
    assert.strictEqual(t.get("s4"), "scalar");
    const c = compilePlan(p, v.resolved);
    assert.strictEqual(c.mode, "values");
    paramsMatch(c.outputs[0]);
    // Both feature steps are inlinable CTEs, so the probe of s2 is an index scan.
    assert.match(c.sql, /step_s1 AS NOT MATERIALIZED/);
    assert.match(c.sql, /step_s2 AS NOT MATERIALIZED/);
    assert.match(c.sql, /ST_DWithin\(a\.geom::geography, b\.geom::geography/);
  });

  await test("within -> rank is a features output, ordered, with the distance as a property", async () => {
    const p = plan(sel("s1", "HOSP", { states: ["Montana"] }), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"] },
      { id: "s4", op: "rank", attr_id: "", inputs: ["s3"], direction: "desc", limit: 5 },
      out("s5", "s4"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    const o = c.outputs[0];
    assert.strictEqual(o.mode, "features");
    assert.deepStrictEqual(o.labels, ["miles_to_nearest", "name", "city", "state"]);
    assert.match(o.sql, /ORDER BY r\.value DESC/);
    assert.match(o.sql, /SELECT \* FROM step_s3/);       // rank passes features through
    assert.match(o.sql, /ORDER BY b\.geom <-> a\.geom LIMIT 1/);  // exact nearest, step 1
    paramsMatch(o);
  });

  await test("within exclude keeps the farther ones and needs miles", async () => {
    const p = plan(sel("s1", "HOSP"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 5, exclude: true },
      out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /d\.m IS NULL OR d\.m >/);
    paramsMatch(o);
    p.steps[2].miles = undefined;
    const bad = await validatePlan(p, resolve);
    assert.ok(bad.errors.some(e => /"exclude" needs "miles"/.test(e)), bad.errors.join("; "));
  });

  await test("a plain select_features -> output still compiles standalone, unchanged", async () => {
    const p = plan(sel("s1", "HOSP", { states: ["Missouri"] }), out("s2", "s1"));
    const v = await validatePlan(p, resolve);
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.strictEqual(o.mode, "features");
    assert.match(o.sql, /^SELECT ST_AsGeoJSON\(f\.geom\)/);
    assert.match(o.sql, /JOIN county_geom c ON ST_Intersects/);
  });

  await test("type errors keep the messages the repair loop has always read", async () => {
    // features into a series op
    let v = await validatePlan(plan(sel("s1", "HOSP"),
      { id: "s2", op: "normalize", attr_id: "", inputs: ["s1", "s1"] }, out("s3", "s2")), resolve);
    assert.ok(v.errors.some(e => /returns individual locations, not per-county values/.test(e)), v.errors.join("; "));
    // an ungrouped aggregate into a series op
    v = await validatePlan(plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum" },
      { id: "s3", op: "rank", attr_id: "", inputs: ["s2"], direction: "desc", limit: 5 },
      out("s4", "s3")), resolve);
    assert.ok(v.errors.some(e => /returns one national number/.test(e)), v.errors.join("; "));
    // a series into within
    v = await validatePlan(plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] }, sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 1 }, out("s4", "s3")), resolve);
    assert.ok(v.errors.some(e => /within needs features.*select_features/.test(e)), v.errors.join("; "));
  });

  await test("combine reads scalars: a share of a total", async () => {
    const p = plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 100000 },
      { id: "s3", op: "aggregate", attr_id: "", inputs: ["s2"], function: "sum" },
      { id: "s4", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum" },
      { id: "s5", op: "combine", attr_id: "", inputs: ["s3", "s4"], operation: "ratio", scale: 100 },
      out("s6", "s5"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    assert.strictEqual(ops.stepTypes(p.steps).get("s5"), "scalar");
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /SELECT NULL::char\(5\) AS fips, a\.value \/ NULLIF\(b\.value, 0\)/);
    assert.match(o.sql, /CROSS JOIN step_s4 b/);
    paramsMatch(o);
    // series over scalar: each county's share of the national total, keyed by the series side
    p.steps[4].inputs = ["s1", "s4"];
    const o2 = compilePlan(p, (await validatePlan(p, resolve)).resolved).outputs[0];
    assert.match(o2.sql, /SELECT a\.fips AS fips/);
  });

  await test("a features step read only by a dead branch is dead", async () => {
    const v = await validatePlan(plan(sel("s1", "HOSP"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 1 },
      sel("s4", "HOSP"), out("s5", "s4")), resolve);
    // within has no consumer at all; the layers only it read are dead with it.
    assert.ok(v.errors.some(e => /"s3" \(within\) is never used by an output/.test(e)), v.errors.join("; "));
    assert.ok(v.errors.some(e => /"s1" \(select_features\), "s2" \(select_features\) are not used/.test(e)), v.errors.join("; "));
  });

  await test("summarize per county is a LEFT JOIN from the units; per state counts each feature once", async () => {
    const p = plan(sel("s1", "HOSP"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 1 },
      { id: "s4", op: "summarize", attr_id: "", inputs: ["s3"] }, out("s5", "s4"));
    let o = compilePlan(p, (await validatePlan(p, resolve)).resolved).outputs[0];
    assert.match(o.sql, /FROM county_geom u LEFT JOIN step_s3 f/);
    p.steps[3].group_by = "state";
    o = compilePlan(p, (await validatePlan(p, resolve)).resolved).outputs[0];
    assert.match(o.sql, /CROSS JOIN LATERAL \(SELECT fips FROM county_geom c .* LIMIT 1\)/);
  });

  await test("NOT filter compiles to IS DISTINCT FROM", async () => {
    const p = plan(sel("s1", "HOSP", { attribute_filters: [{ column: "type", value: "critical access", negate: true }] }),
      sel("s2", "FIRE"), { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 1 }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /f\.type IS DISTINCT FROM \$1/);
    assert.strictEqual(o.params[0], "CRITICAL ACCESS");    // normalized to the stored spelling
  });

  await test("units: km / meters / feet become miles; miles and unmatched numbers are left alone", () => {
    const p = plan(sel("s1", "HOSP"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 500 }, out("s4", "s3"));
    assert.match(repairDistanceUnits(p, "which hospitals are within 500 meters of a fire station"), /500 meters/);
    assert.ok(Math.abs(p.steps[2].miles - 0.310686) < 1e-5);
    const q = plan({ id: "s1", op: "nearest_distance", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 30 }, out("s3", "s2"));
    repairDistanceUnits(q, "counties more than 30 km from a hospital");
    assert.ok(Math.abs(q.steps[1].value - 18.6411) < 1e-3, q.steps[1].value);
    const r = plan({ id: "s1", op: "count_near", attr_id: "HOSP", near_attr_id: "FIRE", miles: 3, inputs: [] }, out("s2", "s1"));
    assert.strictEqual(repairDistanceUnits(r, "hospitals within 3 miles of a fire station"), null);
    assert.strictEqual(repairDistanceUnits(r, "hospitals within 5 km of a fire station"), null);   // 3 is not 5
    assert.strictEqual(r.steps[0].miles, 3);
    assert.deepStrictEqual(distanceMentions("2,500 feet").map(m => Math.round(m.miles * 1000)), [473]);
  });

  await test("the gate: two layers, a distance, a question about the features, nothing per unit", () => {
    const g = (q, n = 2) => featureAlgebra({ query: q, hasFeatureTables: true, featureTableCount: n });
    assert.ok(g("Which hospitals in Ohio are within 2 miles of a fire station?"));
    assert.ok(g("How many child care centers in Texas are more than 5 miles from a hospital?"));
    assert.ok(g("List the 10 nursing homes in Montana farthest from a hospital"));
    assert.ok(!g("Which hospitals in Ohio are within 2 miles of a fire station?", 1));  // one layer
    assert.ok(!g("hospitals within 10 miles of electric power transmission lines"));   // plan_correctness
    assert.ok(!g("How many hospitals are within 3 miles of a fire station in each county?"));
    assert.ok(!g("Which counties are farthest from a hospital?"));
    assert.ok(!g("How many people in Missouri live more than 20 miles from the nearest hospital?"));
    assert.ok(!g("Which census tracts in Colorado have the most hospitals within 3 miles of a fire station?"));
  });

  await test("gated variants change nothing for a question that does not ask", () => {
    const base = { hasFeatureTables: true, featureTableCount: 2, hasFilterableValues: true, wantsLocations: true };
    const plain = planSchemaFor({ ...base, query: "where are the hospitals in Missouri" });
    const props = plain.properties.steps.items.properties;
    assert.ok(!props.op.enum.includes("within"));
    assert.ok(!("negate" in props.attribute_filters.items.properties));
    const neg = planSchemaFor({ ...base, query: "where are the hospitals that are not critical access" });
    assert.ok("negate" in neg.properties.steps.items.properties.attribute_filters.items.properties);
    const alg = planSchemaFor({ ...base, query: "which hospitals are within 2 miles of a fire station" });
    const ap = alg.properties.steps.items.properties;
    assert.ok(ap.op.enum.includes("within") && ap.op.enum.includes("select_features"));
    assert.match(ap.exclude.description, /op=within/);
  });

  await test("direction: the words before the distance set exclude, both ways", () => {
    const w = (q, st) => { const p = plan({ id: "s3", op: "within", inputs: ["s1", "s2"], ...st }); repairWithinDirection(p, q); return p.steps[0]; };
    assert.strictEqual(w("child care centers more than 5 kilometers from the nearest hospital", { miles: 3.10686 }).exclude, true);
    assert.strictEqual(w("hospitals in Kansas not within 3 miles of any fire station", { miles: 3 }).exclude, true);
    assert.strictEqual(w("hospitals within 2 miles of a fire station", { miles: 2, exclude: true }).exclude, undefined);
    assert.strictEqual(w("offices that have a hospital within 1 mile", { miles: 1 }).exclude, undefined);
    // "farthest" with no distance stated: keep every feature, for rank
    const f = w("the 10 nursing homes farthest from a hospital", { exclude: true, miles: 0 });
    assert.strictEqual(f.exclude, undefined); assert.strictEqual(f.miles, undefined);
  });

  await test("a reference layer restricted exactly like its subject is widened; a different one is kept", () => {
    const p = plan(sel("s1", "HOSP", { states: ["Ohio"] }), sel("s2", "FIRE", { states: ["Ohio"] }),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 2 }, out("s4", "s3"));
    assert.ok(widenReferenceLayer(p));
    assert.strictEqual(p.steps[1].states, undefined);
    assert.deepStrictEqual(p.steps[0].states, ["Ohio"]);
    const k = plan(sel("s1", "HOSP", { states: ["Ohio"] }), sel("s2", "FIRE", { states: ["Kentucky"] }),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 2 }, out("s4", "s3"));
    assert.strictEqual(widenReferenceLayer(k), null);
  });

  await test("the reference phrase is the LAST thing measured to, only for gated questions", () => {
    assert.strictEqual(referencePhrase("List the 10 nursing homes in Montana that are farthest from a hospital."), "hospital");
    assert.strictEqual(referencePhrase("How many hospitals in Kansas are not within 3 miles of any fire station?"), "fire station");
    assert.strictEqual(referencePhrase("How many law enforcement offices in Georgia have a hospital within 1 mile?"), "hospital");
    assert.strictEqual(referencePhrase("How far do people in rural counties have to drive to a hospital?"), "hospital");
    assert.strictEqual(referencePhrase("How far is each Missouri county from the nearest hospital?"), null);
  });

  // ------------------------------------------------------------ catchments
  const CSRC = new Map([
    ["POP", { attr_id: "POP", source_kind: "acs_long", census_code: "POP_ESTIMATE", description: "Total population (resident population estimate, July 1)" }],
    ["SVI_E_TOTPOP", { attr_id: "SVI_E_TOTPOP", source_kind: "acs_long", census_code: "SVI_E_TOTPOP", description: "Total population estimate" }],
    ["HOSP", SRC.get("HOSP")],
  ]);
  const cdeps = {
    resolve: async (ids) => new Map(ids.filter(i => CSRC.has(i)).map(i => [i, CSRC.get(i)])),
    levelsOf: async (c) => new Set(c === "SVI_E_TOTPOP" ? ["county", "tract"] : ["county"]),
    stepTypes: ops.stepTypes,
  };
  const far = (fn = "sum") => plan(
    { id: "s1", op: "load", attr_id: "POP", inputs: [] },
    { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
    { id: "s3", op: "nearest_distance", attr_id: "HOSP", inputs: [] },
    { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], operator: ">", value: 20 },
    { id: "s5", op: "intersect", attr_id: "", inputs: ["s2", "s4"] },
    { id: "s6", op: "aggregate", attr_id: "", inputs: ["s5"], function: fn },
    out("s7", "s6"));

  await test("catchment: people at a distance are counted by tract, from each tract's own point", async () => {
    const p = far();
    const c = await applyCatchment(p, "How many people in Missouri live more than 20 miles from the nearest hospital?", CSRC, cdeps);
    assert.ok(c.note);
    assert.strictEqual(p.steps[0].attr_id, "SVI_E_TOTPOP");
    assert.strictEqual(p.steps[0].level, "tract");
    assert.strictEqual(p.steps[2].level, "tract");
    const o = compilePlan(p, CSRC).outputs[0];
    assert.match(o.sql, /FROM geo_values_all WHERE level = \$\d+ AND code = \$\d+/);
    assert.match(o.sql, /FROM geo_unit u LEFT JOIN LATERAL/);            // distance from u.pt
    assert.match(o.sql, /SELECT geoid FROM geo_unit WHERE level = \$\d+ AND state_fp IN/);  // filter_area, inherited
    paramsMatch(o);
  });

  await test("catchment per county sums tracts back; not about people, or a mean of distances, is left alone", async () => {
    const p = far(); p.steps.splice(5, 1); p.steps[5].inputs = ["s5"];
    const c = await applyCatchment(p, "How many people in each Missouri county live more than 20 miles from a hospital?", CSRC, cdeps);
    assert.match(c.note, /summed to counties/);
    assert.strictEqual(p.steps.at(-2).op, "aggregate_to");
    assert.match(compilePlan(p, CSRC).sql, /LEFT JOIN county_geom g USING \(fips\)/);
    const q = far();
    assert.strictEqual((await applyCatchment(q, "Which Missouri counties are more than 20 miles from a hospital?", CSRC, cdeps)).note, null);
    const m = far("mean");
    assert.strictEqual((await applyCatchment(m, "How far do people in Missouri live from a hospital beyond 20 miles?", CSRC, cdeps)).note, null);
    assert.strictEqual(m.steps[0].attr_id, "POP");
  });

  await test("catchment share: a share of the population gets the denominator in code", async () => {
    const p = far(); p.steps[1].states = ["Colorado"]; p.steps[3] = { ...p.steps[3], operator: "<=", value: 5 };
    const c = await applyCatchment(p, "What share of Colorado's population lives within 5 miles of a hospital?", CSRC, cdeps);
    assert.match(c.note, /share/);
    const ratio = p.steps.find(s => s.op === "combine");
    assert.strictEqual(ratio.operation, "ratio"); assert.strictEqual(ratio.scale, 100);
    assert.strictEqual(ops.stepTypes(p.steps).get(ratio.id), "scalar");
    paramsMatch(compilePlan(p, CSRC).outputs[0]);
  });

  await test("a total over a per-county series totals the denominator; a loaded layer moves onto its bridge", () => {
    const p = plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] },
      { id: "s2", op: "aggregate", attr_id: "", inputs: ["s1"], function: "sum" },
      { id: "s3", op: "normalize", attr_id: "", inputs: ["s2", "s1"], scale: 100 }, out("s4", "s3"));
    assert.match(totalTheDenominator(p, ops.stepTypes), /sum of s1/);
    assert.strictEqual(ops.stepTypes(p.steps).get("s3"), "scalar");
    const b = plan({ id: "s1", op: "load", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "nearest_distance", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    assert.ok(bridgeFromLoadedLayer(b, new Set(["HOSP"])));
    assert.deepStrictEqual(b.steps.map(s => s.op), ["nearest_distance", "output"]);
    assert.strictEqual(b.steps[0].attr_id, "HOSP");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
