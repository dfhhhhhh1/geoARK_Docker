/**
 * Phase C: conditions, published definitions, intersect, compare_groups, and
 * periods anchored to a measure's own years.
 *
 * The definition cases are the ones that decided a rule, mostly from the real
 * database: CHR "% Rural" is a 0-1 fraction; ERS Urban Influence Codes mean
 * different things in 2013 (12 codes) and 2024 (9 codes).
 * Run: node backend/planner/test_conditions.js
 */

const assert = require("node:assert");
const { fitToData } = require("../definitions");
const {
  derefDefinitions, checkThresholds, describeGroup, statesCondition,
  RELATIVE_PHRASES, GROUP_COMPARISON,
} = require("./conditions");
const { anchorYears } = require("./vintages");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const { generatePlan, buildSystemPrompt, resolveRelativeYears } = require("./index");
const { planSchemaFor } = require("../schemas");
const ops = require("./ops");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const acs = (code, description, lo, hi) => ({
  source_kind: "acs_long", census_code: code, description,
  ...(hi === undefined ? {} : { value_range: { lo, hi } }),
});
const SOURCES = new Map([
  ["POV", acs("PCTPOVALL", "PCTPOVALL", 3.3, 49.6)],
  ["RURAL", acs("CHR_V058_RAWVALUE", "% Rural", 0, 1)],
  ["RUCC", acs("RURAL_URBAN_CONTINUUM_CODE", "Rural-urban Continuum Code", 1, 9)],
  ["UNEMP", acs("UNEMPLOYMENT_RATE", "Unemployment rate", 0.6, 22)],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom" }],
]);
const resolve = async (ids) =>
  new Map(ids.filter(i => SOURCES.has(i)).map(i => [i, SOURCES.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });

// As backend/definitions.js hands them out: a row of concept_definition plus
// what the data check found.
const DEF_MOSTLY_RURAL = {
  id: "census_mostly_rural", measure_code: "CHR_V058_RAWVALUE", term: "mostly rural",
  op: ">=", value: 0.5, scale: "fraction", vintage_from: 2020, vintage_to: 2025,
  source: "U.S. Census Bureau", selected: 2006, n: 3133, year: 2025,
};
const DEF_NONMETRO = {
  id: "ers_rucc_nonmetro", measure_code: "RURAL_URBAN_CONTINUUM_CODE",
  term: "nonmetropolitan (rural)", op: ">=", value: 4, scale: "code",
  vintage_from: 2013, vintage_to: 2023, source: "USDA ERS", selected: 1966, n: 3211, year: 2023,
};

(async () => {
  // ------------------------------------------------- definitions vs the data
  await test("a definition that fits the loaded data is applied", async () => {
    assert.strictEqual(fitToData(DEF_NONMETRO,
      { year: 2023, n: 3211, lo: 1, hi: 9, integers: true, selected: 1966 }), null);
    assert.strictEqual(fitToData(DEF_MOSTLY_RURAL,
      { year: 2025, n: 3133, lo: 0, hi: 1, integers: false, selected: 2006 }), null);
  });

  await test("a rule written for one vintage is withheld from another", async () => {
    // The real hazard: UIC 2013 "3-12 nonmetro" passes every range check on the
    // 2024 codes, which mean something else. Only the vintage can catch it.
    const uic2013 = { id: "uic", measure_code: "URBAN_INFLUENCE_CODE", op: ">=", value: 3,
                      scale: "code", vintage_from: 2013, vintage_to: 2013 };
    const why = fitToData(uic2013, { year: 2024, n: 3211, lo: 1, hi: 9, integers: true, selected: 2599 });
    assert.match(why || "", /published for 2013-2013.*2024/);
  });

  await test("a definition whose scale no longer matches is withheld", async () => {
    // A reload that switched % Rural to 0-100 would make ">= 0.5" select
    // almost every county. Both the scale and the share check catch it.
    const why = fitToData(DEF_MOSTLY_RURAL,
      { year: 2025, n: 3133, lo: 0, hi: 100, integers: false, selected: 3100 });
    assert.match(why || "", /fraction/);
    const pct = { ...DEF_MOSTLY_RURAL, scale: "percent", value: 20 };
    assert.match(fitToData(pct, { year: 2025, n: 3133, lo: 0, hi: 1, integers: false,
      selected: 0 }) || "", /percent/);
  });

  await test("a rule that selects nothing or everything is withheld", async () => {
    const none = fitToData({ ...DEF_NONMETRO, value: 9, op: ">" },
      { year: 2023, n: 3211, lo: 1, hi: 9, integers: true, selected: 0 });
    assert.match(none || "", /real subset/);
    const all = fitToData({ ...DEF_NONMETRO, value: 1 },
      { year: 2023, n: 3211, lo: 1, hi: 9, integers: true, selected: 3211 });
    assert.match(all || "", /real subset/);
    assert.match(fitToData(DEF_NONMETRO, null) || "", /no values/);
  });

  // ------------------------------------------------------ definition labels
  await test("a definition label becomes the rule it stands for", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "RURAL", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], definition: "d1" },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] });
    const { unknown, used } = derefDefinitions(p, new Map([["d1", DEF_MOSTLY_RURAL]]));
    assert.deepStrictEqual(unknown, []);
    assert.strictEqual(used.length, 1);
    const st = p.steps[1];
    assert.strictEqual(st.definition, "census_mostly_rural");
    assert.strictEqual(st.operator, ">=");
    assert.strictEqual(st.value, 0.5);
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const th = checkThresholds(p, v.resolved, new Map([["census_mostly_rural", [DEF_MOSTLY_RURAL]]]));
    assert.deepStrictEqual(th.errors, []);
  });

  await test("an unlisted definition label is reported, never guessed", async () => {
    const p = plan({ id: "s2", op: "filter_attr", inputs: ["s1"], definition: "d7" });
    const { unknown } = derefDefinitions(p, new Map([["d1", DEF_MOSTLY_RURAL]]));
    assert.deepStrictEqual(unknown, ["d7"]);
  });

  await test("a definition applied to a different measure is refused", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_attr", inputs: ["s1"], definition: "d1" },
      { id: "s3", op: "output", inputs: ["s2"] });
    derefDefinitions(p, new Map([["d1", DEF_MOSTLY_RURAL]]));
    const v = await validatePlan(p, resolve);
    const th = checkThresholds(p, v.resolved, new Map([["census_mostly_rural", [DEF_MOSTLY_RURAL]]]));
    assert.match(th.errors.join(" "), /applies to CHR_V058_RAWVALUE.*filters PCTPOVALL/);
  });

  await test("a definition is refused on a load from outside its vintages", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "RUCC", inputs: [], year: 2003 },
      { id: "s2", op: "filter_attr", inputs: ["s1"], definition: "d1" },
      { id: "s3", op: "output", inputs: ["s2"] });
    derefDefinitions(p, new Map([["d1", DEF_NONMETRO]]));
    const v = await validatePlan(p, resolve);
    const th = checkThresholds(p, v.resolved, new Map([["ers_rucc_nonmetro", [DEF_NONMETRO]]]));
    assert.match(th.errors.join(" "), /published for 2013-2023/);
  });

  await test("a client plan that edits a definition's number is refused", async () => {
    // Follow-ups send the plan back from the browser; the citation must not
    // be shown beside a number it does not say.
    const p = plan(
      { id: "s1", op: "load", attr_id: "RURAL", inputs: [] },
      { id: "s2", op: "filter_attr", inputs: ["s1"], definition: "census_mostly_rural",
        operator: ">=", value: 0.2 },
      { id: "s3", op: "output", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    const th = checkThresholds(p, v.resolved, new Map([["census_mostly_rural", [DEF_MOSTLY_RURAL]]]));
    assert.match(th.errors.join(" "), /is >= 0.5, but the step says >= 0.2/);
  });

  // ------------------------------------------------- stated numbers vs scale
  await test("a percentage against a 0-1 fraction is converted, and said", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "RURAL", inputs: [] },
      { id: "s2", op: "filter_attr", inputs: ["s1"], operator: ">", value: 50 },
      { id: "s3", op: "output", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    const th = checkThresholds(p, v.resolved);
    assert.deepStrictEqual(th.errors, []);
    assert.strictEqual(p.steps[1].value, 0.5);
    assert.match(th.repairs[0], /fraction from 0 to 1.*50 was read as 0.5/);
  });

  await test("a threshold beyond the measure's range is refused with the range", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_area", inputs: ["s1"], states: ["Texas"] },
      { id: "s3", op: "filter_attr", inputs: ["s2"], operator: ">", value: 2000 },
      { id: "s4", op: "output", inputs: ["s3"] });
    const v = await validatePlan(p, resolve);
    const th = checkThresholds(p, v.resolved);
    // Traced through filter_area back to the load: the range is the measure's.
    assert.match(th.errors.join(" "), /outside the values this measure takes \(3.3 to 49.6\).*keep nothing/);
  });

  await test("a threshold on a count of features is not range-checked", async () => {
    const p = plan(
      { id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "filter_attr", inputs: ["s1"], operator: "=", value: 0 },
      { id: "s3", op: "output", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(checkThresholds(p, v.resolved).errors, []);
  });

  // -------------------------------------------------------------- percentile
  await test("percentile compiles against the input's own distribution", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">=", percentile: 75 },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql, params } = compilePlan(p, v.resolved);
    assert.match(sql, /value >= \(SELECT percentile_cont\(\$\d+::float8\) WITHIN GROUP \(ORDER BY value\) FROM step_s1/);
    assert.ok(params.includes(0.75), `expected 0.75 bound, got ${params}`);
  });

  await test("filter_attr needs an operator and exactly one threshold", async () => {
    const mod = ops.byName("filter_attr");
    assert.match(mod.validate({ id: "s2", value: 3 }).join(), /missing required field "operator"/);
    assert.match(mod.validate({ id: "s2", operator: ">" }).join(), /missing required field "value"/);
    assert.match(mod.validate({ id: "s2", operator: ">", value: 3, percentile: 50 }).join(), /not both/);
    assert.deepStrictEqual(mod.validate({ id: "s2", operator: ">", percentile: 50 }), []);
    const p = plan({ id: "s1", op: "load", attr_id: "POV" },
                   { id: "s2", op: "filter_attr", inputs: ["s1"], operator: ">", percentile: 120 },
                   { id: "s3", op: "output", inputs: ["s2"] });
    const v = await validatePlan(p, resolve);
    assert.match(checkThresholds(p, v.resolved).errors.join(), /1 to 99/);
  });

  // --------------------------------------------------------------- intersect
  await test("intersect keeps input 1's values for counties in input 2", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "POV", inputs: [] },
      { id: "s2", op: "filter_attr", inputs: ["s1"], operator: ">", value: 20 },
      { id: "s3", op: "load", attr_id: "RUCC", inputs: [] },
      { id: "s4", op: "filter_attr", inputs: ["s3"], operator: ">=", value: 4 },
      { id: "s5", op: "count_features", attr_id: "HOSP", inputs: [] },
      { id: "s6", op: "filter_attr", inputs: ["s5"], operator: "=", value: 0 },
      { id: "s7", op: "intersect", inputs: ["s2", "s4"] },
      { id: "s8", op: "intersect", inputs: ["s7", "s6"] },
      { id: "s9", op: "output", inputs: ["s8"] });
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const { sql } = compilePlan(p, v.resolved);
    assert.match(sql, /step_s7 AS \(SELECT a\.fips, a\.value FROM step_s2 a WHERE EXISTS \(SELECT 1 FROM step_s4 b WHERE b\.fips = a\.fips\)\)/);
    assert.match(sql, /step_s8 AS \(SELECT a\.fips, a\.value FROM step_s7 a WHERE EXISTS \(SELECT 1 FROM step_s6/);
    assert.match(ops.byName("intersect").validate({ id: "s7", inputs: ["s2", "s2"] }).join(), /DIFFERENT/);
  });

  // ---------------------------------------------------------- compare_groups
  await test("compare_groups names its groups from the plan, and carries a summary", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s2", op: "filter_area", inputs: ["s1"], states: ["South"] },
      { id: "s3", op: "load", attr_id: "RURAL", inputs: [] },
      { id: "s4", op: "filter_attr", inputs: ["s3"], definition: "d1" },
      { id: "s5", op: "intersect", inputs: ["s1", "s4"] },
      { id: "s6", op: "compare_groups", inputs: ["s2", "s5"] },
      { id: "s7", op: "output", inputs: ["s6"] });
    derefDefinitions(p, new Map([["d1", DEF_MOSTLY_RURAL]]));
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const c = compilePlan(p, v.resolved);
    const out = c.outputs[0];
    assert.deepStrictEqual(out.groupLabels, { a: "South", b: "mostly rural" });
    assert.ok(out.summaryColumns.includes("p_value") && out.rowColumns.includes("grp"));
    assert.match(out.sql, /r\.grp,/);
    assert.match(out.sql, /r\.p_value,/);
    // The statistic is a comparison, not a one-row correlation: no statColumns,
    // or the UI would hide the map these rows draw.
    assert.deepStrictEqual(out.statColumns, []);
  });

  await test("describeGroup reads states, places, definitions and percentiles", async () => {
    const byId = new Map([
      ["s1", { id: "s1", op: "load" }],
      ["s2", { id: "s2", op: "filter_place", inputs: ["s1"], place_name: "St. Louis" }],
      ["s3", { id: "s3", op: "filter_attr", inputs: ["s2"], operator: ">=", percentile: 75 }],
    ]);
    assert.strictEqual(describeGroup("s3", byId), "St. Louis; >= 75th percentile");
  });

  // ------------------------------------------------------------------- gates
  await test("new fields and ops are offered only when the question calls for them", async () => {
    const plain = { query: "median household income by county" };
    assert.ok(!ops.fieldOffered("percentile", plain));
    assert.ok(!ops.fieldOffered("definition", plain));
    assert.ok(!ops.offeredFor(plain).includes("intersect"));
    assert.ok(!ops.offeredFor({ ...plain, hasNeighbors: true }).includes("compare_groups"));

    // Superlatives are rank's, not a threshold.
    assert.ok(!RELATIVE_PHRASES.test("which counties have the highest poverty"));
    assert.ok(RELATIVE_PHRASES.test("rural counties with high poverty and few hospitals"));
    assert.ok(RELATIVE_PHRASES.test("counties with above-median poverty rates"));

    const cond = { query: "Which rural counties have a poverty rate above 20% and no hospital?" };
    assert.ok(statesCondition(cond));
    assert.ok(ops.offeredFor(cond).includes("intersect"));
    // Definitions gate on DATA: retrieval returned a defined measure.
    assert.ok(ops.fieldOffered("definition", { query: "x", hasDefinitions: true }));

    assert.ok(GROUP_COMPARISON.test("Is the unemployment rate higher in the South than in the Northeast?"));
    assert.ok(GROUP_COMPARISON.test("obesity in rural counties compared with urban ones"));
    assert.ok(!GROUP_COMPARISON.test("compare obesity and poverty by county"));
    assert.ok(ops.offeredFor({ query: "Is unemployment higher in the South than in the Northeast?",
                               hasNeighbors: true }).includes("compare_groups"));
    // Thresholds and arithmetic are not two groups.
    assert.ok(!GROUP_COMPARISON.test("Among counties with more than 100,000 residents, which ten"));
    assert.ok(!GROUP_COMPARISON.test("the difference between the poverty rate and the unemployment rate"));
    assert.ok(!GROUP_COMPARISON.test("counties where poverty is higher than average"));
    // Counting is not a qualifier; a period is not a threshold.
    assert.ok(!RELATIVE_PHRASES.test("how many hospitals are in each county"));
    assert.ok(!statesCondition({ query: "Which counties saw the biggest increase in poverty over the last decade?" }));
    assert.ok(statesCondition({ query: "counties with over 50,000 people" }));
  });

  await test("a counted period offers the year field and combine", async () => {
    const q = { query: "Which counties' unemployment rate rose the most over the last decade?" };
    assert.ok(ops.fieldOffered("year", q));
    assert.ok(ops.offeredFor(q).includes("combine"));
    assert.ok(!ops.offeredFor({ query: "unemployment rate by county" }).includes("combine"));
  });

  await test("prompt and schema agree on the new fields, and show one intersect example", async () => {
    const ctx = { query: "rural counties with high poverty", hasDefinitions: true };
    const prompt = buildSystemPrompt(ctx);
    const props = planSchemaFor(ctx).properties.steps.items.properties;
    assert.ok(props.percentile && props.definition);
    assert.match(prompt, /CONDITIONS/);
    assert.match(prompt, /"definition":"d1"/);
    assert.match(prompt, /"percentile":75/);
    assert.strictEqual((prompt.match(/op":"intersect"/g) || []).length, 1);
    assert.match(prompt, /mostly rural counties where the unemployment rate/);

    const noDefs = { query: "counties with high poverty and few hospitals" };
    const p2 = buildSystemPrompt(noDefs);
    assert.ok(!/"definition":"d1"/.test(p2), "definition taught without the field");
    assert.ok(!planSchemaFor(noDefs).properties.steps.items.properties.definition);
    assert.match(p2, /smoke/);   // the plain intersect example instead
  });

  // ------------------------------------------------- end to end, scripted LLM
  await test("generatePlan lists definitions, applies one, and cites it", async () => {
    let seenPrompt = "";
    const planJSON = JSON.stringify(plan(
      { id: "s1", op: "load", attr_id: "a1", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 20 },
      { id: "s3", op: "load", attr_id: "a2", inputs: [] },
      { id: "s4", op: "filter_attr", attr_id: "", inputs: ["s3"], definition: "d1" },
      { id: "s5", op: "intersect", attr_id: "", inputs: ["s2", "s4"] },
      { id: "s6", op: "output", attr_id: "", inputs: ["s5"] }));
    const res = await generatePlan({
      query: "mostly rural counties with a poverty rate above 20%",
      candidates: [
        { attr_id: "POV", attr_desc: "Poverty rate", search_purpose: "primary" },
        { attr_id: "RURAL", attr_desc: "% Rural", search_purpose: "filter",
          definitions: [DEF_MOSTLY_RURAL] }],
      callLLM: async (sys, usr) => { seenPrompt = usr; return planJSON; },
      resolve, log: () => {},
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.match(seenPrompt, /d1 = "mostly rural": value >= 0.5 \(2006 of 3133 counties\)/);
    assert.strictEqual(res.plan.steps[3].value, 0.5);
    assert.strictEqual(res.definitions[0].id, "census_mostly_rural");
    assert.strictEqual(res.definitions[0].source, "U.S. Census Bureau");
  });

  // ------------------------------------------------------------------- years
  await test("'the last decade' counts back from the measure's latest year", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "difference" },
      { id: "s4", op: "output", inputs: ["s3"] });
    const note = resolveRelativeYears(p, "Which counties' unemployment rate rose the most over the last decade?");
    assert.ok(note);
    assert.strictEqual(p.steps[0]._back, 10);
    const years = Array.from({ length: 24 }, (_, i) => 2000 + i);    // ERS: 2000-2023
    const { notes } = await anchorYears(p, await resolve(["UNEMP"]), async () => years);
    assert.strictEqual(p.steps[0].year, 2013);
    assert.strictEqual(p.steps[1].year, 2023);
    assert.match(notes[0], /runs to 2023, so the last 10 years were read as 2013-2023/);
  });

  await test("the question's period overrides years and a second measure the model chose", async () => {
    // Observed live, 2026-11-09: ERS 2000 vs County Health Rankings 2020.
    SOURCES.set("CHR_UNEMP", acs("CHR_V023_RAWVALUE", "Unemployment", 0.01, 0.2));
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2000 },
      { id: "s2", op: "load", attr_id: "CHR_UNEMP", inputs: [], year: 2020 },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "difference" },
      { id: "s4", op: "rank", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s5", op: "output", inputs: ["s4"] });
    const note = resolveRelativeYears(p, "Which counties' unemployment rate rose the most over the last decade?");
    assert.match(note, /against itself/);
    assert.match(note, /replaced the planner's years \(2000 to 2020\)/);
    assert.strictEqual(p.steps[1].attr_id, "UNEMP");
    assert.strictEqual(p.steps[1].year, undefined);
    const years = Array.from({ length: 24 }, (_, i) => 2000 + i);
    await anchorYears(p, await resolve(["UNEMP"]), async () => years);
    assert.deepStrictEqual([p.steps[0].year, p.steps[1].year], [2013, 2023]);
    // The model's years stand when they are the question's own.
    const q = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2007 },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [], year: 2023 },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "percent_change" },
      { id: "s4", op: "output", inputs: ["s3"] });
    assert.strictEqual(resolveRelativeYears(q, "percent change in unemployment from 2007 to 2023"), null);
  });

  await test("a change over time is later minus earlier, and needs two years", async () => {
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "difference" },
      { id: "s4", op: "rank", inputs: ["s3"], direction: "desc", limit: 10 },
      { id: "s5", op: "output", inputs: ["s4"] });
    const note = resolveRelativeYears(p, "Which counties' unemployment rate rose the most over the last decade?");
    assert.match(note, /later minus earlier/);
    assert.deepStrictEqual(p.steps[2].inputs, ["s2", "s1"]);
    const years = Array.from({ length: 24 }, (_, i) => 2000 + i);
    await anchorYears(p, await resolve(["UNEMP"]), async () => years);
    // Input 1 is now the later year, so difference = 2023 - 2013.
    assert.deepStrictEqual([p.steps[1].year, p.steps[0].year], [2023, 2013]);

    // A measure with one year cannot show a decade's change: refused, not zero.
    const q = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "percent_change" },
      { id: "s4", op: "output", inputs: ["s3"] });
    resolveRelativeYears(q, "how did unemployment change over the last decade");
    const r = await anchorYears(q, await resolve(["UNEMP"]), async () => [2018]);
    assert.match(r.errors.join(), /only 2018, so it cannot show a change over the last 10 years/);
  });

  await test("a period the measure covers much less of is refused", async () => {
    // CHR has 2020 and 2025: "the last decade" would read as 2020-2025.
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [] },
      { id: "s3", op: "combine", inputs: ["s1", "s2"], operation: "percent_change" },
      { id: "s4", op: "output", inputs: ["s3"] });
    resolveRelativeYears(p, "how did unemployment change over the last decade");
    const r = await anchorYears(p, await resolve(["UNEMP"]), async () => [2020, 2025]);
    assert.match(r.errors.join(), /values for 2020, 2025, so it cannot show a change over the last 10 years/);
  });

  await test("a period refusal names the candidates that DO span it, and the repair uses one", async () => {
    // r-unemp-decade: the planner chose a two-vintage CHR series on every
    // attempt while ERS unemployment, 2000-2023, was on its list.
    const SRC = new Map([...SOURCES,
      ["CHR_UNEMP", acs("CHR_V023_RAWVALUE", "Unemployment", 0.01, 0.2)]]);
    const res2 = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
    const years = { CHR_V023_RAWVALUE: [2020, 2025], UNEMPLOYMENT_RATE: [2000, 2010, 2013, 2023],
                    PCTPOVALL: [2023] };
    const decade = (label) => JSON.stringify(plan(
      { id: "s1", op: "load", attr_id: label, inputs: [] },
      { id: "s2", op: "load", attr_id: label, inputs: [] },
      { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }));
    const answers = [decade("a1"), decade("a2")];
    const prompts = [];
    const res = await generatePlan({
      query: "which counties saw unemployment rise the most over the last decade",
      candidates: [
        { attr_id: "CHR_UNEMP", attr_desc: "Unemployment", search_purpose: "primary" },
        { attr_id: "UNEMP", attr_desc: "Unemployment rate", search_purpose: "primary" },
        { attr_id: "POV", attr_desc: "Poverty rate", search_purpose: "primary" }],
      callLLM: async (sys, usr) => { prompts.push(usr); return answers.shift(); },
      resolve: res2, log: () => {}, yearsOf: async (c) => years[c] || [],
    });
    // Named by label, with its years; the one-year poverty series is not.
    assert.match(prompts[1], /These on the list do: a2 "Unemployment rate" \(2013-2023\)\./);
    assert.doesNotMatch(prompts[1], /a3 "Poverty/);
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.strictEqual(res.plan.steps[0].attr_id, "UNEMP");
    assert.deepStrictEqual(res.plan.steps.slice(0, 2).map(s => s.year).sort(), [2013, 2023]);
  });

  await test("'around Detroit' with no state is the metro; a named state keeps the city", async () => {
    const run = async (query, placeStep) => {
      const res = await generatePlan({
        query,
        candidates: [{ attr_id: "POV", attr_desc: "Poverty rate", search_purpose: "primary" }],
        callLLM: async () => JSON.stringify(plan(
          { id: "s1", op: "load", attr_id: "a1", inputs: [] },
          { id: "s2", op: "filter_place", attr_id: "", inputs: ["s1"], ...placeStep },
          { id: "s3", op: "output", attr_id: "", inputs: ["s2"] })),
        resolve, log: () => {}, hasPlaceBoundaries: true,
      });
      assert.ok(res.ok, JSON.stringify(res.errors));
      return res.plan.steps[1];
    };
    // Every run once the measure was right: five towns called Detroit.
    assert.strictEqual((await run("What are the poverty rates around Detroit?",
      { place_kind: "place", place_name: "Detroit" })).place_kind, "cbsa");
    // A named state: the city, as the filter_place example plans it.
    const mo = await run("poverty for counties in the Springfield, Missouri area",
      { place_kind: "place", place_name: "Springfield" });
    assert.strictEqual(mo.place_kind, "place");
    assert.deepStrictEqual(mo.states, ["Missouri"]);
    // No area phrasing: untouched.
    assert.strictEqual((await run("poverty rates in Detroit",
      { place_kind: "place", place_name: "Detroit" })).place_kind, "place");
  });

  await test("a change between two named years on a one-year measure is refused, not zero", async () => {
    // SVI unemployment has 2022 only: both loads would move to 2022.
    const p = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2019 },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [], year: 2020 },
      { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] });
    const r = await anchorYears(p, await resolve(["UNEMP"]), async () => [2022], {
      alternatives: async (back, exclude, want) => (want ? [{ label: "a2", description: "ERS rate", from: 2000, to: 2023 }] : []),
    });
    assert.match(r.errors.join(), /has values for 2022 only, so it cannot show a change between 2019 and 2020.*a2 "ERS rate" \(2000-2023\)/);
    // Both years present: no error, years kept.
    const q = plan(
      { id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2019 },
      { id: "s2", op: "load", attr_id: "UNEMP", inputs: [], year: 2020 },
      { id: "s3", op: "output", attr_id: "", inputs: ["s1"] });
    const ok = await anchorYears(q, await resolve(["UNEMP"]), async () => [2019, 2020, 2021]);
    assert.deepStrictEqual(ok.errors, []);
  });

  await test("two different areas are a comparison: the one-region override leaves them", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify(plan(
      { id: "s1", op: "load", attr_id: "a1", inputs: [] },
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["South"] },
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Northeast", "Northeast"] },
      { id: "s4", op: "compare_groups", attr_id: "", inputs: ["s2", "s3"] },
      { id: "s5", op: "output", attr_id: "", inputs: ["s4"] }));
    const res = await generatePlan({
      query: "Is there more unemployment in the south than the north?",
      candidates: [{ attr_id: "UNEMP", attr_desc: "Unemployment rate", search_purpose: "primary" }],
      callLLM: async () => planJSON, resolve, log: () => {}, hasNeighbors: true,
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.deepStrictEqual(res.plan.steps[2].states, ["Northeast"]);   // deduped, not overridden
    assert.deepStrictEqual(res.plan.steps[1].states, ["South"]);
  });

  await test("a named year the measure lacks moves to the nearest it has, and says so", async () => {
    const p = plan({ id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2009 },
                   { id: "s2", op: "output", inputs: ["s1"] });
    const { notes } = await anchorYears(p, await resolve(["UNEMP"]), async () => [2013, 2018, 2023]);
    assert.strictEqual(p.steps[0].year, 2013);
    assert.match(notes[0], /no 2009 figures; used 2013 \(available 2013-2023\)/);
    // A year it has is left alone, silently.
    const q = plan({ id: "s1", op: "load", attr_id: "UNEMP", inputs: [], year: 2018 });
    assert.deepStrictEqual(await anchorYears(q, await resolve(["UNEMP"]), async () => [2013, 2018]), { notes: [], errors: [] });
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
