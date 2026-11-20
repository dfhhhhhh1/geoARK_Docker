/**
 * Network distance (docs/GIS_OPS_PLAN.md H5): reading mode, cost, limit and
 * side from the question; `within` in its network form; the people rewrite
 * to network_population; and that none of it reaches a question without
 * network phrasing. No model or database.
 * Run: node backend/planner/test_network.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { networkOf, applyNetwork, applyNetworkPopulation, networkUnitErrors } = require("./network");
const { featureAlgebra } = require("./features");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["SCH", { source_kind: "feature_table", table_name: "public_schools_nces", geom_column: "geom", label_columns: ["name"] }],
  ["FIRE", { source_kind: "feature_table", table_name: "fire_stations", geom_column: "geom", label_columns: ["name"] }],
  ["WORLDPOP_POP", { source_kind: "acs_long", census_code: "WORLDPOP_POP", description: "Estimated population from the WorldPop 1 km gridded estimate" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, attr, extra = {}) => ({ id, op: "select_features", attr_id: attr, inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

(async () => {
  await test("reads mode, cost, limit and side", async () => {
    const a = networkOf("Which schools are more than a 4-minute drive from the nearest fire station?");
    assert.deepStrictEqual([a.mode, a.cost, a.limit, a.side], ["drive", "time", 240, "beyond"]);
    const b = networkOf("clinics within a 15 minute walk of a bus stop");
    assert.deepStrictEqual([b.mode, b.cost, b.limit, b.side, b.walk_mps], ["walk", "time", 900, "within", 1.34112]);
    const c = networkOf("offices within 3 kilometers driving distance of a hospital");
    assert.deepStrictEqual([c.mode, c.cost, c.limit, c.side], ["drive", "length", 3000, "within"]);
    const d = networkOf("the 5 stations with the longest driving distance to a hospital, in road miles");
    assert.deepStrictEqual([d.mode, d.cost, d.limit], ["drive", "length", undefined]);
    const e = networkOf("homes within a 1-hour drive of an airport");
    assert.strictEqual(e.limit, 3600);
    const f = networkOf("within 20 minutes walk at 2 mph");
    assert.strictEqual(f.walk_mps, 0.89408);
  });

  await test("no network phrasing, no network", async () => {
    for (const q of ["Which hospitals in Ohio are within 2 miles of a fire station?",
                     "How far is each county from the nearest hospital?",
                     "what share of workers drive alone to work",
                     "Which counties have the longest commute times?"]) {
      assert.strictEqual(networkOf(q), null, q);
    }
  });

  await test("the feature gate opens on a network cost stated with 'from'", async () => {
    const ctx = { hasFeatureTables: true, featureTableCount: 2 };
    assert.ok(featureAlgebra({ ...ctx, query: "Which schools are more than a 4-minute drive from a fire station?" }));
    assert.ok(!featureAlgebra({ ...ctx, query: "Which schools are more than a 4-minute drive" + " in each county?" }));
  });

  await test("applyNetwork replaces miles, sets exclude from the words", async () => {
    const p = plan(sel("s1", "SCH", { city: "St. Louis" }), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 4 }, out("s4", "s3"));
    const fix = applyNetwork(p, "Which public schools in St. Louis are more than a 4-minute drive from the nearest fire station?");
    assert.ok(fix);
    const w = p.steps[2];
    assert.strictEqual(w.miles, undefined);
    assert.strictEqual(w.exclude, true);
    assert.deepStrictEqual(w.network, { mode: "drive", cost: "time", limit: 240, unit: "minutes" });
    assert.strictEqual(applyNetwork(plan(), "Which hospitals are within 2 miles of a fire station?"), null);
  });

  await test("a filter restating the network limit is removed", async () => {
    const p = plan(sel("s1", "SCH"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 2.5 },
      { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], operator: ">", value: 150 }, out("s5", "s4"));
    const fix = applyNetwork(p, "Which schools are more than a 2.5-minute drive from the nearest fire station?");
    assert.match(fix, /restated the network limit/);
    assert.deepStrictEqual(p.steps.map(s => s.id), ["s1", "s2", "s3", "s5"]);
    assert.deepStrictEqual(p.steps[3].inputs, ["s3"]);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
  });

  await test("within (network, beyond) compiles to one pgr_dijkstraCost from a super-source", async () => {
    const p = plan(sel("s1", "SCH"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], exclude: true,
        network: { mode: "drive", cost: "time", limit: 240, unit: "minutes" } }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /pgr_dijkstraCost\(/);
    assert.match(c.sql, /road_region_for\(/);
    assert.match(c.sql, /drive_cc/);
    assert.match(c.sql, /r\.agg_cost IS NULL OR r\.agg_cost > /);
    assert.ok(c.params.includes(240));
    assert.ok(c.params.includes(60));                       // seconds -> minutes
    assert.match(c.outputs[0].sql, /drive_minutes_to_nearest/);
  });

  await test("within (walk, time) bounds the search in metres and keeps the reached", async () => {
    const p = plan(sel("s1", "SCH"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"],
        network: { mode: "walk", cost: "time", limit: 300, walk_mps: 1.34112, unit: "minutes" } }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /walk_cc/);
    assert.match(c.sql, /WHERE r\.agg_cost <= /);
    assert.ok(c.params.some(x => Math.abs(x - 402.336) < 1e-6), "300 s at 1.34112 m/s");
  });

  await test("exclude without a network limit is refused", async () => {
    const p = plan(sel("s1", "SCH"), sel("s2", "FIRE"),
      { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], exclude: true,
        network: { mode: "drive", cost: "length", unit: "miles" } }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
  });

  await test("people at a network cost become network_population", async () => {
    const p = plan({ id: "s1", op: "load", attr_id: "WORLDPOP_POP", inputs: [] },
      { id: "s2", op: "nearest_distance", attr_id: "FIRE", inputs: [] },
      { id: "s3", op: "filter_place", attr_id: "", inputs: ["s1"], place_kind: "place", place_name: "Chicago", states: ["Illinois"] },
      out("s4", "s3"));
    const note = applyNetworkPopulation(p, "How many people in Chicago live more than a 10-minute walk from a fire station?",
      { popAttr: "WORLDPOP_POP", isFeature: (id) => id === "FIRE" });
    assert.ok(note);
    const np = p.steps.find(s => s.op === "network_population");
    assert.strictEqual(np.exclude, true);
    assert.strictEqual(np.stat, "people");
    assert.strictEqual(np.group_by, "none");
    assert.strictEqual(np.place_name, "Chicago");
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    assert.strictEqual(ops.stepTypes(p.steps).get("np"), "scalar");
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /ST_PixelAsCentroids/);
    assert.match(c.sql, /raster_worldpop/);
  });

  await test("a share per zone groups by the zone and divides by its people", async () => {
    const p = plan({ id: "s1", op: "load", attr_id: "WORLDPOP_POP", inputs: [] },
      { id: "s2", op: "nearest_distance", attr_id: "FIRE", inputs: [] }, out("s3", "s2"));
    applyNetworkPopulation(p, "What share of each St. Louis ward's population lives within a 5-minute drive of a fire station?",
      { popAttr: "WORLDPOP_POP", isFeature: (id) => id === "FIRE", zone: "z_stl_wards" });
    assert.strictEqual(p.level, "z_stl_wards");
    const np = p.steps.find(s => s.op === "network_population");
    assert.strictEqual(np.stat, "share");
    assert.strictEqual(np.zones, "z_stl_wards");
    assert.strictEqual(np.group_by, undefined);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    paramsMatch(c.outputs[0]);
    assert.match(c.sql, /GROUP BY x\.fips/);
  });

  await test("the area may be a city on the feature step", async () => {
    const p = plan(sel("s1", "FIRE", { city: "Chicago", states: ["Illinois"] }), out("s2", "s1"));
    const note = applyNetworkPopulation(p, "How many people in Chicago live more than a 10-minute walk from a fire station?",
      { popAttr: "WORLDPOP_POP", isFeature: (id) => id === "FIRE" });
    assert.ok(note);
    const np = p.steps.find(s => s.op === "network_population");
    assert.deepStrictEqual([np.place_name, np.states], ["Chicago", ["Illinois"]]);
  });

  await test("a network question measured by a per-unit op is refused", async () => {
    const q = "census tracts where transit stops are within a 10-minute walk";
    const p = plan({ id: "s1", op: "nearest_distance", attr_id: "FIRE", inputs: [] }, out("s2", "s1"));
    assert.strictEqual(networkUnitErrors(p, q).length, 1);
    assert.match(networkUnitErrors(p, q)[0], /straight-line/);
    assert.deepStrictEqual(networkUnitErrors(p, "How far is each county from the nearest hospital?"), []);
  });

  await test("a plan sent back cannot name a raster table", async () => {
    const p = plan(sel("nr", "FIRE"),
      { id: "np", op: "network_population", attr_id: "pg_authid", inputs: ["nr"], stat: "people", group_by: "none",
        place_name: "Chicago", network: { mode: "drive", cost: "time", limit: 300, unit: "minutes" } }, out("o", "np"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
  });

  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
