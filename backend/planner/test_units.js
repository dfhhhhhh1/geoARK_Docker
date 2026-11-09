/**
 * Units (planner/units.js), the rate / count validator rule, and the coverage
 * repair (planner/coverage.js).
 *
 * The unit cases are real catalog rows, chosen because each one decided a rule:
 * the label alone is wrong for 243 of the 3,557 series, in both directions.
 * Run: node backend/planner/test_units.js
 */

const assert = require("node:assert");
const { seriesUnit } = require("./units");
const { validatePlan } = require("./validate");
const { preferCoverage } = require("./coverage");
const { unaskedSubjectErrors } = require("./outcome");

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
  // The Detroit plan's numerator: household poverty PERCENT.
  ["POVPCT", acs("S1702_C02_001E",
    "Estimate|Percent|Households|POVERTY STATUS IN THE PAST 12 MONTHS|Below", 0, 62.5)],
  ["POVCOUNT", acs("POVALL", "POVALL", 2, 1299957)],
  ["TOTPOP", acs("DP05_0001E", "Estimate|SEX AND AGE|Total population", 117, 10040682)],
  ["HALFPOP", acs("S0102_C01_001E", "Estimate|Total|Total population", 16953, 10040682)],
  ["OBESITY", acs("CHR_V011_RAWVALUE", "Adult obesity", 0.177, 0.53)],
  ["DIABETES", acs("PLACES_DIABETES_CrdPrv",
    "Diagnosed diabetes among adults (crude prevalence)", 3, 27.1)],
  ["INCOME", acs("DP03_0062E",
    "Estimate!!INCOME AND BENEFITS (IN 2018 INFLATION-ADJUSTED DOLLARS)!!Total households!!Median household income (dollars)",
    12283, 147111)],
  ["HOSPITAL", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom" }],
  ["UPLOAD", { source_kind: "inline" }],
]);
const resolve = async (ids) =>
  new Map(ids.filter(i => SOURCES.has(i)).map(i => [i, SOURCES.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const normalizeOf = (num, den, ...middle) => plan(
  { id: "s1", op: "load", attr_id: num },
  { id: "s2", op: "load", attr_id: den },
  ...middle,
  { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100 },
  { id: "s4", op: "output", inputs: ["s3"] },
);

(async () => {
  // ------------------------------------------------------------------ units
  await test("labels decide only where the range cannot", async () => {
    // S0801 "Estimate|Total" columns are percentages; the label says count.
    assert.strictEqual(seriesUnit(acs("S0801_C01_002E",
      "Estimate|Total|Workers 16 years and over|MEANS OF TRANSPORTATION TO WORK|Car_truck_or van",
      40.1, 100)), "rate");
    // A DP universe row labelled "Percent Estimate" holds the count itself.
    assert.strictEqual(seriesUnit(acs("DP03_0001PE",
      "Percent Estimate!!EMPLOYMENT STATUS!!Population 16 years and over", 64, 8112148)), "count");
    // Without a range, the label is all there is.
    assert.strictEqual(seriesUnit(acs("DP03_0009PE",
      "Percent Estimate!!EMPLOYMENT STATUS!!Civilian labor force!!Unemployment Rate")), "rate");
    assert.strictEqual(seriesUnit(acs("DP05_0001E", "Estimate|SEX AND AGE|Total population")), "count");
  });

  await test("a category label is not a percentage", async () => {
    // DP04's SMOCAPI section title and its "35.0 percent or more" leaves head
    // COUNTS of housing units.
    assert.strictEqual(seriesUnit(acs("DP04_0115E",
      "Estimate!!SELECTED MONTHLY OWNER COSTS AS A PERCENTAGE OF HOUSEHOLD INCOME (SMOCAPI)!!Housing units with a mortgage!!35.0 percent or more")),
      "count");
  });

  await test("medians are rates at any magnitude; margins of error are neither", async () => {
    assert.strictEqual(seriesUnit(SOURCES.get("INCOME")), "rate");
    assert.strictEqual(seriesUnit(acs("DP05_0001M",
      "Margin of Error|SEX AND AGE|Total population", 0, 4000)), null);
  });

  await test("non-ACS sources: code, description, then range", async () => {
    assert.strictEqual(seriesUnit(SOURCES.get("POVCOUNT")), "count");
    assert.strictEqual(seriesUnit(acs("PCTPOVALL", "PCTPOVALL", 3.3, 49.6)), "rate");
    assert.strictEqual(seriesUnit(SOURCES.get("DIABETES")), "rate");
    // CHR stores fractions under names that say nothing about units.
    assert.strictEqual(seriesUnit(SOURCES.get("OBESITY")), "rate");
    // A per-100k rate the name does not reveal stays unknown, never "count".
    assert.strictEqual(seriesUnit(acs("CHR_V043_RAWVALUE", "Violent crime", 0, 1819.5)), null);
    assert.strictEqual(seriesUnit(SOURCES.get("UPLOAD")), null);
  });

  // -------------------------------------------------------- validator rule
  await test("refuses the Detroit plan: a percentage divided by total population", async () => {
    const r = await validatePlan(normalizeOf("POVPCT", "TOTPOP"), resolve);
    assert.ok(!r.ok);
    assert.match(r.errors.join(" "), /already a rate or percentage/);
  });

  await test("the rate is traced through filters and rank to its load", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "load", attr_id: "OBESITY" },
      { id: "f1", op: "filter_area", inputs: ["s1"], states: ["Michigan"] },
      { id: "s2", op: "load", attr_id: "TOTPOP" },
      { id: "s3", op: "normalize", inputs: ["f1", "s2"] },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), resolve);
    assert.match(r.errors.join(" "), /already a rate/);
  });

  await test("a count over a count, the op's purpose, still validates", async () => {
    const r = await validatePlan(normalizeOf("POVCOUNT", "TOTPOP"), resolve);
    assert.deepStrictEqual(r.errors, []);
  });

  await test("hospitals per person (feature count over population) still validates", async () => {
    const r = await validatePlan(plan(
      { id: "s1", op: "count_features", attr_id: "HOSPITAL" },
      { id: "s2", op: "load", attr_id: "TOTPOP" },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100000 },
      { id: "s4", op: "output", inputs: ["s3"] },
    ), resolve);
    assert.deepStrictEqual(r.errors, []);
  });

  await test("a rate over a rate, and anything unknown, are not this rule's business", async () => {
    assert.deepStrictEqual((await validatePlan(normalizeOf("DIABETES", "OBESITY"), resolve)).errors, []);
    assert.deepStrictEqual((await validatePlan(normalizeOf("UPLOAD", "TOTPOP"), resolve)).errors, []);
  });

  // -------------------------------------------------------------- coverage
  const loadPlan = (attr, ...rest) => plan(
    { id: "s1", op: "load", attr_id: attr }, ...rest,
    { id: "s9", op: "output", inputs: [rest.length ? rest.at(-1).id : "s1"] });
  const deps = (cov, alts) => ({
    coverageOf: async (ids) => new Map(ids.filter(i => cov[i]).map(i => [i, cov[i]])),
    equivalentsOf: async (id) => alts[id] || [],
  });

  await test("a half-coverage total population is swapped for a verified equivalent", async () => {
    const p = loadPlan("HALFPOP", { id: "s2", op: "per_area", inputs: ["s1"] });
    const r = await preferCoverage(p, [{ attr_id: "HALFPOP" }], deps(
      { HALFPOP: { n: 98, total: 254, desc: "Estimate|Total|Total population" } },
      { HALFPOP: [{ attr_id: "TOTPOP", attr_desc: "Estimate|SEX AND AGE|Total population", n: 254, total: 254 }] }));
    assert.strictEqual(p.steps[0].attr_id, "TOTPOP");
    assert.match(r.swaps[0], /only 98 of 254 counties/);
    assert.deepStrictEqual(r.added.map(a => a.attr_id), ["TOTPOP"], "not shown to the planner, so added");
  });

  await test("an equivalent the planner was shown wins over a wider one it was not", async () => {
    const p = loadPlan("HALFPOP");
    await preferCoverage(p, [{ attr_id: "HALFPOP" }, { attr_id: "POPEST" }], deps(
      { HALFPOP: { n: 1524, total: 3233 } },
      { HALFPOP: [
        { attr_id: "TOTPOP", n: 3221, total: 3233 },
        { attr_id: "POPEST", n: 3211, total: 3233 },
      ] }));
    assert.strictEqual(p.steps[0].attr_id, "POPEST");
  });

  await test("no qualifying equivalent: the plan stands and coverage is reported", async () => {
    const p = loadPlan("HALFPOP");
    const r = await preferCoverage(p, [], deps(
      { HALFPOP: { n: 1524, total: 3233, desc: "Estimate|Total|Total population" } },
      { HALFPOP: [{ attr_id: "NARROW", n: 2000, total: 3233 }] }));
    assert.strictEqual(p.steps[0].attr_id, "HALFPOP");
    assert.deepStrictEqual(r.swaps, []);
    assert.match(r.notes[0], /1524 of 3233 counties/);
  });

  await test("full coverage is left alone and nothing is said", async () => {
    const p = loadPlan("TOTPOP");
    const r = await preferCoverage(p, [], deps({ TOTPOP: { n: 3221, total: 3233 } }, {}));
    assert.strictEqual(p.steps[0].attr_id, "TOTPOP");
    assert.deepStrictEqual([r.swaps, r.notes], [[], []]);
  });

  await test("generatePlan applies the swap and re-grounds the plan", async () => {
    const { generatePlan } = require("./index");
    const planJSON = JSON.stringify({
      intent: "density", output_type: "map", entity_type: "COUNTY",
      steps: [
        { id: "s1", op: "load", attr_id: "a1", inputs: [] },
        { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
      ],
    });
    const candidates = [{ attr_id: "HALFPOP", attr_desc: "Estimate|Total|Total population",
                          search_purpose: "primary" }];
    const res = await generatePlan({
      query: "population density by county", candidates,
      callLLM: async () => planJSON, resolve, log: () => {},
      coverage: deps({ HALFPOP: { n: 1524, total: 3233 } },
                     { HALFPOP: [{ attr_id: "TOTPOP", n: 3221, total: 3233 }] }),
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.strictEqual(res.plan.steps[0].attr_id, "TOTPOP");
    assert.ok(res.resolved.has("TOTPOP"), "the swapped-in series must be resolved for the compiler");
    assert.match(res.adjustments.join(" "), /Coverage:/);
    assert.ok(candidates.some(c => c.attr_id === "TOTPOP"), "described for the response");
  });

  await test("a coverage failure never costs a plan that passed every check", async () => {
    const { generatePlan } = require("./index");
    const res = await generatePlan({
      query: "total population by county",
      candidates: [{ attr_id: "TOTPOP", attr_desc: "Total population", search_purpose: "primary" }],
      callLLM: async () => JSON.stringify({ intent: "x", output_type: "map", entity_type: "COUNTY",
        steps: [{ id: "s1", op: "load", attr_id: "a1", inputs: [] },
                { id: "s2", op: "output", attr_id: "", inputs: ["s1"] }] }),
      resolve, log: () => {},
      coverage: { coverageOf: async () => { throw new Error("db down"); }, equivalentsOf: async () => [] },
    });
    assert.ok(res.ok);
  });

  // ------------------------------------------------- expanded subject guard
  const CKD_CANDIDATES = [
    { attr_id: "COPD", attr_desc: "COPD among adults", search_purpose: "primary" },
    { attr_id: "DIAB", attr_desc: "Diabetes prevalence", search_purpose: "expanded" },
    { attr_id: "OBES", attr_desc: "Adult obesity", search_purpose: "expanded" },
  ];
  const explainOf = (attr) => plan(
    { id: "s1", op: "load", attr_id: attr },
    { id: "s2", op: "explain", inputs: ["s1"] },
    { id: "s3", op: "output", inputs: ["s2"] });

  await test("refuses the CKD plan: explaining an expanded candidate", async () => {
    const e = unaskedSubjectErrors(explainOf("DIAB"), CKD_CANDIDATES);
    assert.strictEqual(e.length, 1);
    assert.match(e[0], /explains "Diabetes prevalence", which the question does not ask about/);
    assert.match(e[0], /no steps/);
  });

  await test("explaining a named condition is fine, whatever factors expansion adds", async () => {
    assert.deepStrictEqual(unaskedSubjectErrors(explainOf("COPD"), CKD_CANDIDATES), []);
  });

  await test("a plan built only from expanded series is refused; one named series is enough", async () => {
    const onlyExpanded = plan(
      { id: "s1", op: "load", attr_id: "DIAB" },
      { id: "s2", op: "load", attr_id: "OBES" },
      { id: "s3", op: "correlate", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", inputs: ["s3"] });
    assert.match(unaskedSubjectErrors(onlyExpanded, CKD_CANDIDATES).join(" "), /every attribute this plan uses/);
    const mixed = plan(
      { id: "s1", op: "load", attr_id: "COPD" },
      { id: "s2", op: "load", attr_id: "DIAB" },
      { id: "s3", op: "correlate", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", inputs: ["s3"] });
    assert.deepStrictEqual(unaskedSubjectErrors(mixed, CKD_CANDIDATES), []);
  });

  await test("generatePlan sends an expanded subject back, and accepts the refusal", async () => {
    const { generatePlan } = require("./index");
    const plans = [
      { intent: "x", output_type: "table", entity_type: "COUNTY", steps: [
        { id: "s1", op: "load", attr_id: "a2", inputs: [] },
        { id: "s2", op: "explain", attr_id: "", inputs: ["s1"] },
        { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] },
      { intent: "x", output_type: "table", entity_type: "COUNTY", steps: [] },
    ];
    const prompts = [];
    const res = await generatePlan({
      query: "what drives chronic kidney disease rates", candidates: CKD_CANDIDATES,
      callLLM: async (sys, usr) => { prompts.push(usr); return JSON.stringify(plans.shift()); },
      resolve: async (ids) => new Map(ids.map(i => [i, { source_kind: "acs_long", census_code: i }])),
      log: () => {},
    });
    assert.ok(!res.ok, "the second answer is a refusal, not a plan");
    assert.match(prompts[1], /does not ask about/);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
