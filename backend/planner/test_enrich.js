/**
 * Feature enrichment, units -> features (docs/GIS_OPS_PLAN.md H6 tier 1):
 * the gate, the percentile repair, types, compilation at the county and at a
 * named unit. No model or database; the live check is in the plan's Progress.
 * Run: node backend/planner/test_enrich.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { enrichAlgebra, asksEnrichment, repairEnrichPercentile } = require("./features");
const { planSchemaFor } = require("../schemas");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: ["name", "city"] }],
  ["POV", { source_kind: "acs_long", census_code: "SVI_EP_POV150", description: "Percent below 150% of poverty" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, extra = {}) => ({ id, op: "select_features", attr_id: "HOSP", inputs: [], ...extra });
const load = (id) => ({ id, op: "load", attr_id: "POV", inputs: [] });
const enrich = (id, a, b) => ({ id, op: "enrich", attr_id: "", inputs: [a, b] });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const ctx = (query, n = 1) => ({ query, hasFeatureTables: true, featureTableCount: n });

function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

(async () => {
  await test("gate: the three phrasings reach it", () => {
    for (const q of [
      "Which hospitals in Ohio are in census tracts where poverty is above 30 percent?",
      "List the fire stations in counties with an uninsured rate over 15%",
      "Show the schools in high-poverty tracts in St. Louis",
      "Which nursing homes are in low-income neighborhoods?",
      "Map the hospitals in the poorest counties of Mississippi",
      "Show each hospital in Texas with the poverty rate of its tract",
      "What is the median income of the county each power plant is in?",
      "How many hospitals are in counties where median income is below 40000?",
    ]) assert.ok(enrichAlgebra(ctx(q)), q);
  });

  await test("gate: not for units as the answer, regions, people or plain places", () => {
    for (const q of [
      "Which counties have the highest poverty rate?",
      "Where are the hospitals in Missouri?",
      "Which hospitals are within 2 miles of a fire station?",
      "How many people live in census tracts where poverty is above 30%?",
      "Show the hospitals in Southwest counties",
      "hospitals in western states",
      "How many hospitals are in each county?",
      "Count the hospitals in census tracts in St. Louis",
    ]) assert.ok(!enrichAlgebra(ctx(q, 2)), q);
    // No feature layer, nothing to enrich.
    assert.ok(!enrichAlgebra({ query: "hospitals in counties where poverty is high", hasFeatureTables: false, featureTableCount: 0 }));
  });

  await test("offered with select_features, summarize only when counting", () => {
    const names = (q) => ops.offeredFor(ctx(q));
    const a = names("Which hospitals are in counties where poverty is above 20%?");
    assert.ok(a.includes("enrich") && a.includes("select_features"));
    assert.ok(!a.includes("summarize"));
    const b = names("How many hospitals are in counties where poverty is above 20%?");
    assert.ok(b.includes("enrich") && b.includes("summarize"));
    const enumOps = planSchemaFor(ctx("How many hospitals are in counties where poverty is above 20%?"))
      .properties.steps.items.properties.op.enum;
    assert.ok(enumOps.includes("enrich"));
    assert.ok(!planSchemaFor({ hasFeatureTables: true, featureTableCount: 2 })
      .properties.steps.items.properties.op.enum.includes("enrich"));
  });

  await test("types: features x series -> features; series first is refused", async () => {
    const p = plan(sel("s1"), load("s2"),
      { id: "s3", op: "filter_attr", attr_id: "", inputs: ["s2"], operator: ">", value: 30 },
      enrich("s4", "s1", "s3"), out("s5", "s4"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    assert.strictEqual(ops.stepTypes(p.steps).get("s4"), "features");
    const bad = plan(sel("s1"), load("s2"), enrich("s3", "s2", "s1"), out("s4", "s3"));
    assert.ok(!(await validatePlan(bad, resolve)).ok);
  });

  await test("compiles at the county: point-on-surface probe, joined by key", async () => {
    const p = plan(sel("s1", { states: ["Ohio"] }), load("s2"), enrich("s3", "s1", "s2"), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    const o = c.outputs[0];
    assert.strictEqual(o.mode, "features");
    assert.match(o.sql, /FROM county_geom u WHERE u\.geom && ST_PointOnSurface\(a\.geom\)/);
    assert.match(o.sql, /JOIN step_s2 s ON s\.fips = k\.fips/);
    assert.ok(o.labels.includes("county_value"), o.labels.join(","));
    assert.match(o.valueLabel, /^Percent below 150% of poverty of the county it lies in$/);
    paramsMatch(o);
  });

  await test("compiles at a named unit (tract) and names the column for it", async () => {
    const p = plan(sel("s1"), load("s2"), enrich("s3", "s1", "s2"), out("s4", "s3"));
    p.level = "tract";
    const v = await validatePlan(p, resolve);
    const c = compilePlan(p, v.resolved);
    const o = c.outputs[0];
    assert.match(o.sql, /FROM geo_unit WHERE level = \$\d+\) u/);
    assert.ok(o.labels.includes("tract_value"));
    assert.match(o.valueLabel, /census tract it lies in/);
    paramsMatch(o);
  });

  await test("enrich -> filter_attr -> summarize(none) counts features", async () => {
    const p = plan(sel("s1"), load("s2"), enrich("s3", "s1", "s2"),
      { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], operator: ">", value: 20 },
      { id: "s5", op: "summarize", attr_id: "", inputs: ["s4"], group_by: "none" }, out("s6", "s5"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    paramsMatch(compilePlan(p, v.resolved).outputs[0]);
  });

  await test("repair: a percentile after enrich moves to the units", async () => {
    const p = plan(sel("s1"), load("s2"), enrich("s3", "s1", "s2"),
      { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], operator: ">=", percentile: 75 },
      out("s5", "s4"));
    assert.ok(repairEnrichPercentile(p));
    const by = Object.fromEntries(p.steps.map(s => [s.id, s]));
    assert.deepStrictEqual(by.s4.inputs, ["s2"]);
    assert.deepStrictEqual(by.s3.inputs, ["s1", "s4"]);
    assert.deepStrictEqual(by.s5.inputs, ["s3"]);
    assert.ok(p.steps.indexOf(by.s4) < p.steps.indexOf(by.s3));
    assert.ok((await validatePlan(p, resolve)).ok);
    // A stated number is left alone: it means the same on either side.
    const q = plan(sel("s1"), load("s2"), enrich("s3", "s1", "s2"),
      { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], operator: ">", value: 30 }, out("s5", "s4"));
    assert.strictEqual(repairEnrichPercentile(q), null);
  });

  await test("phrase helper is the server's retrieval keep rule", () => {
    assert.ok(asksEnrichment("hospitals in census tracts where poverty is above 30%"));
    assert.ok(!asksEnrichment("how far is each census tract from the nearest hospital"));
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
