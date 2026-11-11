/**
 * Plans at another unit (planner/levels.js) and their compiled SQL.
 * No model or database. Run: node backend/planner/test_levels.js
 */

const assert = require("node:assert");
const { levelOf, applyLevel } = require("./levels");
const { compilePlan } = require("./compile");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["POV150", { source_kind: "acs_long", census_code: "SVI_EP_POV150", description: "Percent below 150% of poverty" }],
  ["PCT", { source_kind: "acs_long", census_code: "PCTPOVALL", description: "Percent of people in poverty" }],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom" }],
]);
const LEVELS = { SVI_EP_POV150: ["county", "tract"], PCTPOVALL: ["county"] };
const levelsOf = async (c) => new Set(LEVELS[c] || []);
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const load = (id) => ({ id: "s1", op: "load", attr_id: id, inputs: [] });
const out = (from) => ({ id: "s9", op: "output", attr_id: "", inputs: [from] });

(async () => {
  await test("the unit comes from the question's words; one named ZIP is not a level", () => {
    assert.strictEqual(levelOf("Which census tracts in the city of St. Louis have the most poverty?"), "tract");
    assert.strictEqual(levelOf("Show the uninsured rate for every census tract in Denver."), "tract");
    assert.strictEqual(levelOf("Which ZIP codes in Cook County have the highest diabetes?"), "zcta");
    assert.strictEqual(levelOf("Which counties does ZIP code 65721 fall in?"), null);
    assert.strictEqual(levelOf("the most densely populated 4 km grid cells in Colorado"), "grid4k");
    assert.strictEqual(levelOf("poverty by 16 km grid"), "grid16k");
    assert.strictEqual(levelOf("Which Missouri counties have the most poverty?"), null);
    // Finer data, county answers: the unit is still the county.
    assert.strictEqual(levelOf("Using census tract data, what share of people in each Michigan county live without a vehicle?"), null);
    assert.strictEqual(levelOf("In which Missouri counties does poverty vary the most from one census tract to another?"), null);
    assert.strictEqual(levelOf("Estimate the population of each Colorado county from the 1 km population grid."), null);
    // A county named as a PLACE does not count.
    assert.strictEqual(levelOf("Which ZIP codes in Cook County, Illinois have the highest diabetes prevalence?"), "zcta");
  });

  await test("a level is set only when every loaded measure has it", async () => {
    const p = plan(load("POV150"), out("s1"));
    const r = await applyLevel(p, "poverty by census tract in Missouri", SRC, levelsOf);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(p.level, "tract");
    assert.match(r.note, /census tract/);
    // County question: nothing set.
    const c = plan(load("PCT"), out("s1"));
    assert.strictEqual((await applyLevel(c, "poverty by county", SRC, levelsOf)).level, null);
    assert.strictEqual(c.level, undefined);
  });

  await test("a measure without the level goes back for repair, naming ones that have it", async () => {
    const p = plan(load("PCT"), out("s1"));
    const r = await applyLevel(p, "poverty by census tract", SRC, levelsOf,
      async () => [{ label: "a3", description: "Percent below 150% of poverty" }]);
    assert.strictEqual(p.level, undefined);
    assert.match(r.errors[0], /"Percent of people in poverty" has no values by census tract\. These on the list do: a3/);
  });

  await test("an op not ported to other levels is refused, not compiled at the county", async () => {
    const p = plan({ id: "s1", op: "nearest_distance", attr_id: "HOSP", inputs: [] }, out("s1"));
    const r = await applyLevel(p, "distance from each census tract to a hospital", SRC, levelsOf);
    assert.match(r.errors.join(" "), /nearest_distance is not available by census tract yet/);
  });

  await test("tract SQL reads geo_values and draws geo_unit; county SQL is unchanged", () => {
    const tract = compilePlan({ ...plan(load("POV150"),
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      { id: "s3", op: "per_area", attr_id: "", inputs: ["s2"] }, out("s3")), level: "tract" }, SRC);
    assert.match(tract.sql, /FROM geo_values_all WHERE level = \$\d+ AND code = \$\d+/);
    assert.match(tract.sql, /SELECT geoid FROM geo_unit WHERE level = \$\d+ AND state_fp IN/);
    assert.match(tract.sql, /JOIN geo_unit g ON g\.level = \$\d+ AND g\.geoid = r\.fips/);
    assert.match(tract.sql, /FROM geo_unit WHERE level = 'tract'\) g USING \(fips\)/);
    assert.ok(tract.params.includes("tract") && tract.params.includes("SVI_EP_POV150"));
    assert.strictEqual(tract.outputs[0].level, "tract");
    const county = compilePlan(plan(load("POV150"), out("s1")), SRC);
    assert.doesNotMatch(county.sql, /geo_unit|geo_values/);
    assert.match(county.sql, /FROM acs_county_values/);
    assert.strictEqual(county.outputs[0].level, "county");
  });

  await test("ZIP areas get their state through the crosswalk", () => {
    const z = compilePlan({ ...plan(load("POV150"),
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Illinois"] }, out("s2")),
      level: "zcta" }, SRC);
    assert.match(z.sql, /geo_crosswalk WHERE from_level = 'zcta' AND to_level = 'county' AND from_share >= 0\.5/);
  });

  await test("a level not in the closed set never reaches SQL", () => {
    const bad = compilePlan({ ...plan(load("PCT"), out("s1")), level: "x'; DROP TABLE y; --" }, SRC);
    assert.doesNotMatch(bad.sql, /DROP/);
    assert.strictEqual(bad.outputs[0].level, "county");
  });

  await test("'Cook County' is a county restriction at any level; the enum is unchanged", async () => {
    const { generatePlan } = require("./index");
    const res = await generatePlan({
      query: "Which ZIP codes in Cook County, Illinois have the highest diabetes prevalence?",
      candidates: [{ attr_id: "POV150", attr_desc: "x", search_purpose: "primary" }],
      callLLM: async () => JSON.stringify(plan(load("a1"),
        { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"], place_kind: "zcta", place_name: "Cook County" },
        out("s2"))),
      resolve: async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)])),
      log: () => {}, hasPlaceBoundaries: true,
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    const f = res.plan.steps[1];
    assert.deepStrictEqual([f.place_kind, f.place_name, f.states], ["county", "Cook", ["Illinois"]]);
    const z = compilePlan({ ...res.plan, level: "zcta" }, SRC);
    assert.match(z.sql, /FROM county_geom k JOIN geo_unit c ON c\.level = \$\d+/);
    assert.ok(z.params.includes("Cook") && z.params.includes("17"));
    const c = compilePlan(res.plan, SRC);
    assert.match(c.sql, /r\.fips IN \(SELECT k\.fips FROM county_geom k WHERE lower\(k\.name\)/);
    const { planSchemaFor } = require("../schemas");
    const kinds = JSON.stringify(planSchemaFor({ mentionsArea: true, hasPlaceBoundaries: true }));
    assert.ok(!/"county"/.test(kinds.match(/"place_kind":\{[^}]*\}/)?.[0] || ""), "county is not in the decoding enum");
  });

  await test("'in the city of St. Louis' offers a place filter", () => {
    const { queryMentionsArea } = require("../states");
    assert.ok(queryMentionsArea("Which census tracts in the city of St. Louis have the most poverty?"));
  });

  await test("one named state and no restriction in the plan: the state is added", async () => {
    const { generatePlan } = require("./index");
    const run = async (query, steps) => (await generatePlan({
      query, candidates: [{ attr_id: "POV150", attr_desc: "x", search_purpose: "primary" }],
      callLLM: async () => JSON.stringify(plan(...steps)),
      resolve: async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)])),
      log: () => {}, hasPlaceBoundaries: true,
    })).plan;
    // The grid plan, 2 of 2: national cells for a Colorado question.
    const p = await run("the most densely populated places in Colorado", [load("a1"),
      { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] },
      { id: "s3", op: "rank", attr_id: "", inputs: ["s2"], order: "desc", limit: 20 }, out("s3")]);
    const f = p.steps.find(st => st.op === "filter_area");
    assert.deepStrictEqual([f?.inputs, f?.states], [["s3"], ["Colorado"]]);
    assert.deepStrictEqual(p.steps.at(-1).inputs, [f.id]);
    // Already restricted, two states, or a comparison: untouched.
    for (const [q, steps] of [
      ["poverty in Colorado", [load("a1"), { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Colorado"] }, out("s2")]],
      ["poverty in Colorado and Utah", [load("a1"), out("s1")]],
      ["is poverty in Colorado higher than in the rest of the country", [load("a1"), out("s1")]],
    ]) {
      const r = await run(q, steps);
      assert.strictEqual(r.steps.filter(st => st.op === "filter_area").length,
        steps.filter(st => st.op === "filter_area").length, q);
    }
  });

  await test("finer data, county answers: each load is rolled up, the rest is a county plan", async () => {
    const { applyRollup, rollupOf } = require("./levels");
    const { seriesUnit } = require("./units");
    const LV = { SVI_EP_POV150: ["county", "tract"], SVI_E_TOTPOP: ["county", "tract"], PCTPOVALL: ["county"] };
    const lvOf = async (c) => new Set(LV[c] || []);
    assert.strictEqual(rollupOf("Using census tract data, what share of people in each Michigan county are poor?"), "tract");
    assert.strictEqual(rollupOf("poverty by census tract in Denver"), null);

    const p = plan(load("POV150"), { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Michigan"] }, out("s2"));
    const r = await applyRollup(p, "Using census tract data, what share of people in each Michigan county are poor?", SRC, lvOf, seriesUnit);
    assert.deepStrictEqual(r.errors, []);
    assert.match(r.note, /population-weighted mean of its census tracts \(SVI_E_TOTPOP\)/);
    assert.deepStrictEqual(p.steps.map(st => `${st.op}:${st.inputs.join(",")}`),
      ["load:", "aggregate_to:s1", "filter_area:s1_by_county", "output:s2"]);
    assert.strictEqual(p.steps[0].level, "tract");
    const sql = compilePlan(p, SRC).sql;
    assert.match(sql, /FROM geo_values_all WHERE level = \$\d+ AND code = \$\d+/);
    assert.match(sql, /sum\(r\.value \* w\.value\) \/ NULLIF\(sum\(w\.value\), 0\)/);
    assert.match(sql, /WHERE LEFT\(fips, 2\) IN/, "downstream filter is the county one");

    const q = plan(load("POV150"), out("s1"));
    const r2 = await applyRollup(q, "In which Missouri counties does poverty vary the most from one census tract to another?", SRC, lvOf, seriesUnit);
    assert.match(r2.note, /standard deviation/);
    assert.match(compilePlan(q, SRC).sql, /stddev_samp\(r\.value\).*HAVING count\(\*\) >= 3/);

    const bad = plan(load("PCT"), out("s1"));
    const r3 = await applyRollup(bad, "Using census tract data, poverty in each Ohio county", SRC, lvOf, seriesUnit);
    assert.match(r3.errors[0], /cannot be built up from census tracts/);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
