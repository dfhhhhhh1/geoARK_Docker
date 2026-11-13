/**
 * Phase F spatial methods (docs/RESEARCH_PLAN.md): neighbors (spatial lag),
 * residual, access (2SFCA), the precision path, and the rewires they need.
 * No model or database. Run: node backend/planner/test_phase_f.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { areaAfterAccess } = require("./rewire");
const { asksPrecision, boundsQueries } = require("./uncertainty");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["UNEMP", { source_kind: "acs_long", census_code: "UNEMPLOYMENT_RATE", description: "Unemployment rate" }],
  ["DIAB", { source_kind: "acs_long", census_code: "PLACES_DIABETES_CrdPrv", description: "Diabetes" }],
  ["INC", { source_kind: "acs_long", census_code: "MEDHHINC", description: "Median household income" }],
  ["POP", { source_kind: "acs_long", census_code: "POP_ESTIMATE", description: "Total population" }],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const load = (id, attr) => ({ id, op: "load", attr_id: attr, inputs: [] });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

(async () => {
  await test("neighbors: value minus the mean of contiguous neighbours, or the ratio", async () => {
    const p = plan(load("s1", "UNEMP"), { id: "s2", op: "neighbors", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /u\.value - avg\(n\.value\)/);
    assert.match(o.sql, /JOIN county_neighbors cn ON cn\.fips = u\.fips/);
    assert.strictEqual(o.diverging, true);
    p.steps[1].operation = "ratio";
    assert.match(compilePlan(p, v.resolved).sql, /u\.value \/ NULLIF\(avg\(n\.value\), 0\)/);
    p.steps[1].operation = "percent_change";
    assert.ok((await validatePlan(p, resolve)).errors.some(e => /"difference" or "ratio"/.test(e)));
  });

  await test("residual: outcome minus the least-squares line on the predictor", async () => {
    const p = plan(load("s1", "DIAB"), load("s2", "INC"),
      { id: "s3", op: "residual", attr_id: "", inputs: ["s1", "s2"] }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /j\.y - \(f\.a \+ f\.b \* j\.x\)/);
    assert.match(o.sql, /regr_slope\(y\.value, x\.value\)/);
    paramsMatch(o);
  });

  await test("access: one pass over county-facility pairs, per 100,000, index-probed", async () => {
    const p = plan(load("s1", "POP"), { id: "s2", op: "access", attr_id: "HOSP", inputs: ["s1"], miles: 30 },
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Texas"] }, out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /1\.0 \/ NULLIF\(sum\(pop\), 0\) AS ratio FROM p GROUP BY id/);
    assert.match(o.sql, /COALESCE\(sum\(r\.ratio\), 0\) \* 100000/);
    assert.match(o.sql, /f\.geom && ST_Expand\(c\.pt/);
    paramsMatch(o);
    // A per-county value series is not a facility layer.
    p.steps[1].attr_id = "INC";
    assert.ok((await validatePlan(p, resolve)).errors.some(e => /already a per-county value series/.test(e)));
  });

  await test("a state restriction on access's demand moves after the op", () => {
    const p = plan(load("s1", "POP"), { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Texas"] },
      { id: "s3", op: "access", attr_id: "HOSP", inputs: ["s2"], miles: 30 },
      { id: "s4", op: "rank", attr_id: "", inputs: ["s3"], direction: "asc", limit: 10 }, out("s5", "s4"));
    assert.ok(areaAfterAccess(p));
    assert.deepStrictEqual(p.steps.map(s => `${s.id}<${s.inputs.join(",")}`),
      ["s1<", "s3<s1", "s2<s3", "s4<s2", "s5<s4"]);
  });

  await test("each Phase F op is offered only on its own phrasing", () => {
    const base = { hasFeatureTables: true, featureTableCount: 1, hasNeighbors: true };
    const has = (q, op) => ops.offeredFor({ ...base, query: q }).includes(op);
    assert.ok(has("Which counties have a much higher unemployment rate than the average of their neighboring counties?", "neighbors"));
    assert.ok(!has("Which counties have the highest unemployment rate?", "neighbors"));
    assert.ok(has("how much higher or lower is the diabetes rate than its median household income would predict?", "residual"));
    assert.ok(!has("Is diabetes related to income?", "residual"));
    const tx = "Which Texas counties have the worst access to hospitals once you account for how many people each hospital has to serve, using a 30-mile catchment?";
    assert.ok(has(tx, "access"));
    assert.ok(!has(tx, "residual"));   // "account for" belongs to access here
    assert.ok(!has("How far is each county from the nearest hospital?", "access"));
    assert.ok(!ops.offeredFor({ ...base, hasNeighbors: false, query: "than their neighboring counties" }).includes("neighbors"));
  });

  await test("precision: combine and its interval example are offered, bounds are searched for", () => {
    const q = "Which 10 Missouri counties have the least precise poverty rate estimates?";
    assert.ok(asksPrecision(q));
    assert.ok(ops.offeredFor({ query: q }).includes("combine"));
    assert.ok(ops.examplesFor(ops.offeredFor({ query: q }), { query: q }).some(t => /confidence interval/.test(t)));
    assert.ok(!ops.examplesFor(ops.offeredFor({ query: "difference between poverty and unemployment" }),
      { query: "difference between poverty and unemployment" }).some(t => /confidence interval/.test(t)));
    assert.deepStrictEqual(boundsQueries(q, {}), ["upper bound of the 90% confidence interval margin of error poverty rate", "lower bound of the 90% confidence interval margin of error poverty rate"]);
    assert.deepStrictEqual(boundsQueries("Which counties have the highest poverty rate?", {}), []);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
