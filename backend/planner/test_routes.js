/**
 * Service areas and routes (docs/GIS_OPS_PLAN.md H5): reading the question
 * (bands, sides, names), the plan rebuilds, that questions without the
 * phrasing are untouched, and that every compiled statement binds exactly the
 * parameters it uses. No model or database; live checks against independent
 * gold are recorded in the plan.
 * Run: node backend/planner/test_routes.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const SA = require("./service_area");
const R = require("./route");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["FIRE", { source_kind: "feature_table", table_name: "fire_stations", geom_column: "geom", label_columns: ["name", "city"] }],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: ["name"] }],
  ["LIB", { source_kind: "feature_table", table_name: "libraries", geom_column: "geom", label_columns: [] }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, attr, extra = {}) => ({ id, op: "select_features", attr_id: attr, inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const isFeature = (id) => SRC.has(id);
const LAYERS = [{ attr_id: "FIRE", label: "Fire Stations" }, { attr_id: "HOSP", label: "Hospitals" },
                { attr_id: "LIB", label: "Public Libraries" }];
function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
  for (let i = 1; i <= o.params.length; i++) assert.ok(used.has(i), `parameter $${i} is bound and never used`);
}
async function compiles(p) {
  const v = await validatePlan(p, resolve);
  assert.deepStrictEqual(v.errors || [], [], `validation: ${(v.errors || []).join("; ")}`);
  const c = compilePlan(p, await resolve(p.steps.map(s => s.attr_id).filter(Boolean)));
  for (const o of c.outputs) paramsMatch(o);
  return c;
}

(async () => {
  console.log("service areas: reading the question");
  await test("a stated list of bands", async () => {
    assert.deepStrictEqual(SA.serviceAreaOf("Map the 5, 10 and 15-minute drive times around the fire stations in St. Louis").bands, [5, 10, 15]);
    assert.deepStrictEqual(SA.serviceAreaOf("show 10/20/30 minute walk sheds around libraries").bands, [10, 20, 30]);
    assert.deepStrictEqual(SA.serviceAreaOf("map the 10- and 20-minute drive time zones around hospitals").bands, [10, 20]);
  });
  await test("steps up to a limit, and hours", async () => {
    assert.deepStrictEqual(SA.serviceAreaOf("service areas of fire stations in 5-minute bands up to 20 minutes").bands, [5, 10, 15, 20]);
    assert.deepStrictEqual(SA.serviceAreaOf("drive time areas of 30 minutes and 1 hour around hospitals").bands, [30, 60]);
  });
  await test("one limit is banded inside it; none takes the default", async () => {
    assert.deepStrictEqual(SA.serviceAreaOf("Show the area within a 10-minute walk of each library").bands, [5, 10]);
    assert.deepStrictEqual(SA.serviceAreaOf("drive-time isochrones for hospitals").bands, [5, 10, 15]);
    assert.deepStrictEqual(SA.splitLimit(7), [7]);
    assert.deepStrictEqual(SA.splitLimit(60), [15, 30, 45, 60]);
  });
  await test("mode and cost", async () => {
    const w = SA.serviceAreaOf("Show the area within a 10-minute walk of each library");
    assert.deepStrictEqual([w.network.mode, w.network.cost], ["walk", "time"]);
    const l = SA.serviceAreaOf("what parts of the city are within a 3 mile drive of a hospital");
    assert.deepStrictEqual([l.network.mode, l.network.cost, l.bands], ["drive", "length", [1, 2, 3]]);
  });
  await test("features, people and beyond questions are not service areas", async () => {
    for (const q of ["Which schools are within a 10-minute drive of a fire station?",
                     "How many people live within a 10-minute drive of a hospital in St. Louis?",
                     "Which areas have a hospital within 10 miles?",
                     "how far is each county from the nearest hospital",
                     "where are the fire stations in St. Louis"]) {
      assert.strictEqual(SA.serviceAreaOf(q), null, q);
    }
  });
  await test("the phrase for retrieval", async () => {
    assert.strictEqual(SA.serviceAreaPhrase("Map the 5, 10 and 15-minute drive times around the fire stations in St. Louis"), "fire stations");
    assert.strictEqual(SA.serviceAreaPhrase("drive-time isochrones for hospitals in St. Louis"), "hospitals");
  });

  console.log("service areas: the plan");
  const qSA = "Map the 5, 10 and 15-minute drive times around the fire stations in St. Louis";
  await test("rebuilt from the model's layer and place", async () => {
    const p = plan(sel("s1", "FIRE", { city: "St. Louis", states: ["Missouri"] }), out("s2", "s1"));
    const msg = SA.applyServiceArea(p, qSA, { isFeature, popAttr: "WORLDPOP_POP" });
    assert.ok(msg && /5, 10, 15 minutes/.test(msg), msg);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["select_features", "service_area", "output", "output"]);
    assert.deepStrictEqual([p.steps[0].city, p.steps[0].states], ["St. Louis", ["Missouri"]]);
    assert.strictEqual(p.steps[1].population, "WORLDPOP_POP");
    const c = await compiles(p);
    assert.strictEqual(c.outputs.length, 2);
    assert.strictEqual(c.outputs[0].style.kind, "bands");
    assert.deepStrictEqual(c.outputs[0].style.stops, [5, 10, 15]);
    assert.deepStrictEqual(c.outputs[0].labels, ["band", "minutes_to", "area_sq_mi", "cumulative_sq_mi", "people"]);
  });
  await test("the layer measured TO, from within", async () => {
    const p = plan(sel("s1", "LIB"), sel("s2", "FIRE"), { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"] }, out("s4", "s3"));
    SA.applyServiceArea(p, "map the areas within a 10 minute drive of fire stations", { isFeature });
    assert.strictEqual(p.steps[0].attr_id, "FIRE");
    assert.strictEqual(p.steps[1].population, undefined);
    await compiles(p);
  });
  await test("walk and road-mile bands compile", async () => {
    for (const q of ["Show the area within a 10-minute walk of each library", "what parts of the city are within a 3 mile drive of a hospital"]) {
      const p = plan(sel("s1", q.includes("library") ? "LIB" : "HOSP"), out("s2", "s1"));
      assert.ok(SA.applyServiceArea(p, q, { isFeature }));
      await compiles(p);
    }
  });
  await test("no feature layer: plan untouched", async () => {
    const p = plan({ id: "s1", op: "load", attr_id: "X", inputs: [] }, out("s2", "s1"));
    const before = JSON.stringify(p);
    assert.strictEqual(SA.applyServiceArea(p, qSA, { isFeature }), null);
    assert.strictEqual(JSON.stringify(p), before);
  });
  await test("bands are validated", async () => {
    const p = plan(sel("s1", "FIRE"), { id: "s2", op: "service_area", attr_id: "", inputs: ["s1"],
      network: { mode: "drive", cost: "time" }, bands: [10, 5] }, out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    assert.ok((v.errors || []).some(e => /bands/.test(e)), JSON.stringify(v.errors));
  });

  console.log("routes: reading the question");
  await test("route phrasing, and layers named route", async () => {
    assert.ok(R.asksRoute("What is the fastest driving route from each fire station in St. Louis to the nearest hospital?"));
    assert.ok(R.asksRoute("Show driving directions from Barnes-Jewish Hospital to every fire station in St. Louis"));
    assert.ok(R.asksRoute("shortest walking route between the Central Library and the nearest hospital"));
    assert.ok(!R.asksRoute("Which bus routes run from downtown to the airport?"));
    assert.ok(!R.asksRoute("how far is each county from the nearest hospital"));
    assert.ok(!R.asksRoute("map the fire stations in St. Louis"));
  });
  await test("sides: nearest, every, named", async () => {
    const s = R.sidesOf("What is the fastest driving route from each fire station in St. Louis to the nearest hospital?");
    assert.deepStrictEqual([s.origin, s.destination], ["each fire station", "the nearest hospital"]);
    const o = R.readSide(s.origin), d = R.readSide(s.destination);
    assert.deepStrictEqual([o.every, o.named, d.nearest, d.named], [true, false, true, false]);
    const n = R.readSide("Barnes-Jewish Hospital");
    assert.deepStrictEqual([n.named, n.phrase], [true, "Barnes-Jewish Hospital"]);
    assert.ok(R.readSide("Station 4").named);
    assert.ok(!R.readSide("the fire stations").named);
  });
  await test("the phrases for retrieval", async () => {
    assert.deepStrictEqual(R.routePhrases("What is the fastest driving route from each fire station in St. Louis to the nearest hospital?"),
      ["fire station", "hospital"]);
  });

  console.log("routes: the plan");
  const qR = "What is the fastest driving route from each fire station in St. Louis to the nearest hospital?";
  await test("each origin to its nearest destination, place on the origins", async () => {
    const p = plan(sel("s1", "FIRE", { city: "St. Louis", states: ["Missouri"] }), sel("s2", "HOSP"),
                   { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"] }, out("s4", "s3"));
    assert.ok(R.applyRoute(p, qR, { isFeature, layers: LAYERS }));
    const [o, d, r] = p.steps;
    assert.deepStrictEqual([o.attr_id, o.city, d.attr_id, d.city, r.to], ["FIRE", "St. Louis", "HOSP", undefined, "nearest"]);
    assert.deepStrictEqual(r.network, { mode: "drive", cost: "time" });
    const c = await compiles(p);
    assert.strictEqual(c.outputs.length, 1);
    assert.strictEqual(c.outputs[0].endpoints, true);
    assert.strictEqual(c.outputs[0].style.kind, "ramp");
    assert.ok(/pgr_dijkstra/.test(c.outputs[0].sql));
    assert.ok(c.outputs[0].params.some(x => /target AS source, source AS target/.test(String(x))), "reversed graph");
  });
  await test("a named origin to every feature, place on the layer side", async () => {
    const p = plan(sel("s1", "HOSP"), sel("s2", "FIRE", { city: "St. Louis" }), out("s3", "s2"));
    R.applyRoute(p, "Show driving directions from Barnes-Jewish Hospital to every fire station in St. Louis", { isFeature, layers: LAYERS });
    const [o, d, r] = p.steps;
    assert.deepStrictEqual([o.attr_id, o.name_like, o.pick_one, o.city], ["HOSP", "Barnes-Jewish Hospital", true, undefined]);
    assert.deepStrictEqual([d.attr_id, d.city, r.to], ["FIRE", "St. Louis", "each"]);
    const c = await compiles(p);
    assert.ok(!c.outputs[0].params.some(x => /target AS source/.test(String(x))), "forward graph");
  });
  await test("a layer the plan lacks is taken from the candidates", async () => {
    const p = plan(sel("s1", "FIRE", { city: "St. Louis" }), out("s2", "s1"));
    assert.ok(R.applyRoute(p, qR, { isFeature, layers: LAYERS }));
    assert.strictEqual(p.steps[1].attr_id, "HOSP");
  });
  await test("walking routes compile; a layer with no name column matches nothing", async () => {
    const p = plan(sel("s1", "LIB"), sel("s2", "HOSP"), out("s3", "s1"));
    R.applyRoute(p, "shortest walking route between the Central Library and the nearest hospital", { isFeature, layers: LAYERS });
    assert.strictEqual(p.steps[2].network.mode, "walk");
    const c = await compiles(p);
    assert.ok(/WHERE false/.test(c.outputs[0].sql) || / false\)/.test(c.outputs[0].sql));
  });
  await test("the place from the question when the plan carried none", async () => {
    assert.deepStrictEqual(R.sidesOf("Show driving directions from Barnes-Jewish Hospital to every fire station in St. Louis, Missouri").place,
      { city: "St. Louis", states: ["Missouri"] });
    assert.deepStrictEqual(R.sidesOf("route from each fire station in Missouri to the nearest hospital?").place, { states: ["Missouri"] });
    const p = plan({ id: "s1", op: "count_features", attr_id: "FIRE", inputs: [] }, out("s2", "s1"));
    R.applyRoute(p, "Show driving directions from Barnes-Jewish Hospital to every fire station in St. Louis, Missouri", { isFeature, layers: LAYERS });
    assert.deepStrictEqual([p.steps[1].attr_id, p.steps[1].city, p.steps[1].states], ["FIRE", "St. Louis", ["Missouri"]]);
    await compiles(p);
  });
  await test("no route phrasing: plan untouched", async () => {
    const p = plan(sel("s1", "FIRE"), out("s2", "s1"));
    const before = JSON.stringify(p);
    assert.strictEqual(R.applyRoute(p, "where are the fire stations in St. Louis", { isFeature, layers: LAYERS }), null);
    assert.strictEqual(JSON.stringify(p), before);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
