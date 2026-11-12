// Tests for planner/relevance.js with a scripted LLM. No model or database.
//   node planner/test_relevance.js
const assert = require("node:assert");
const { checkRelevance, usedAttributes, grounded, sharedWords, overrules } = require("./relevance");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const refs = new Map([["a1", "READ"], ["a2", "POP"], ["a3", "INC"], ["a4", "CANCER"]]);
const candidates = [
  { attr_id: "READ", attr_desc: "Reading scores (covers 2,917 counties)" },
  { attr_id: "POP", attr_desc: "Total population" },
  { attr_id: "INC", attr_desc: "Median household income" },
  { attr_id: "CANCER", attr_desc: "Cancer (non-skin) or melanoma among adults" },
];
const plan = (...steps) => ({ intent: "t", steps });
const v = (label, fit, question_phrase = "", measures = "x") => ({ label, fit, question_phrase, measures });
const scripted = (verdicts) => async () => JSON.stringify({ verdicts });
const load = (id) => ({ id: "s1", op: "load", attr_id: id, inputs: [] });

(async () => {
  await test("grounded: the quoted phrase must occur in the question", () => {
    assert.ok(grounded("lung cancer", "what causes lung cancer in the South"));
    assert.ok(grounded("Lung  Cancer", "what causes lung cancer in the South"), "case and spacing");
    assert.ok(!grounded("rainfall", "what causes lung cancer in the South"));
    assert.ok(!grounded("", "anything"));
  });

  await test("rainfall: fit none with no phrase is a rejection naming what it measures", async () => {
    const r = await checkRelevance({
      query: "What is the average rainfall by county?", plan: plan(load("READ")),
      candidates, refs, callLLM: scripted([v("a1", "none", "", "student reading test scores")]),
    });
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0], /^NOT_RELEVANT: a1 \("Reading scores/);
    assert.match(r.errors[0], /measures student reading test scores, which the question does not name/);
    assert.match(r.errors[0], /empty "steps" array/);
  });

  await test("question shape cannot reject the outcome: causes / explains read as 'same' or 'broader'", async () => {
    // What the extractive prompt returns for the two questions that were
    // refused under the old holistic one.
    for (const [query, id, label, fit, phrase] of [
      ["what causes lung cancer in the south", "CANCER", "a4", "broader", "lung cancer"],
      ["what explains asthma rates", "READ", "a1", "same", "asthma rates"],
    ]) {
      const r = await checkRelevance({ query, plan: plan(load(id)), candidates, refs,
        callLLM: scripted([v(label, fit, phrase)]) });
      assert.deepStrictEqual(r.errors, [], query);
      assert.strictEqual(r.verdicts[0].verdict, fit === "same" ? "direct" : "proxy");
      assert.ok(r.verdicts[0].grounded);
    }
  });

  await test("'none' rejects even when it quotes the unmeasured thing (how qwen3 answers)", async () => {
    // Real qwen3:14b reply for the rainfall case, from the benchmark.
    const r = await checkRelevance({
      query: "What is the average rainfall by county?", plan: plan(load("READ")),
      candidates, refs, callLLM: scripted([v("a1", "none", "average rainfall by county",
        "educational performance (e.g., student test results)")]),
    });
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.verdicts[0].verdict, "unrelated");
  });

  await test("a 'none' contradicted by the attribute's own name is overruled, never refused", async () => {
    // Both real qwen3:14b rejections from the 2026-09-29 probes.
    const cases = [
      ["risk factors for heart disease by county", "Coronary heart disease among adults (crude prevalence)"],
      ["hospitals within 10 miles of electric power transmission lines", "Transmission Lines (mapped locations)"],
    ];
    for (const [query, desc] of cases) {
      const r = await checkRelevance({ query, plan: plan(load("X")),
        candidates: [{ attr_id: "X", attr_desc: desc }], refs: new Map([["a1", "X"]]),
        callLLM: scripted([v("a1", "none", "", "something")]) });
      assert.deepStrictEqual(r.errors, [], query);
      assert.strictEqual(r.verdicts[0].verdict, "unchecked");
      assert.match(r.verdicts[0].reason, /overruled/);
    }
  });

  await test("the cross-check keeps every correct rejection measured so far", () => {
    for (const [desc, query] of [
      ["Reading scores (covers 2,917 counties)", "What is the average rainfall by county?"],
      ["Median household income", "What does a gallon of milk cost in each county?"],
      ["Estimate|Total|Households", "How many pet dogs live in each county?"],
      ["Adverse Climate Events", "Which counties get the most snow each year?"],
      // 2026-11-10: "chronic, disease" overruled this rejection 3 of 3 runs.
      ["Chronic obstructive pulmonary disease among adults (age-adjusted prevalence)",
       "What drives chronic kidney disease rates across counties?"],
    ]) assert.deepStrictEqual(sharedWords(desc, query), [], `${desc} / ${query}`);
    // A named condition still connects through its own word.
    assert.deepStrictEqual(sharedWords("Chronic kidney disease among adults", "what drives kidney disease"), ["kidney"]);
  });

  await test("one incidental shared word no longer overrules a correct rejection", async () => {
    // Three rejections overruled in one run of analyst questions, 2026-11-11.
    const cases = [
      ["Group our mobile field inspection locations into five balanced service clusters",
       "Mobile Home Parks (mapped locations)"],
      ["Aggregate annual solar radiation raster values across commercial building footprints",
       "Percent Estimate!!HOUSE HEATING FUEL!!Occupied housing units!!Solar energy"],
      ["Intersect FEMA flood zones with tax parcels and aggregate assessed property value at risk",
       "Estimate!!VALUE!!Owner-occupied units"],
    ];
    for (const [query, desc] of cases) {
      assert.ok(!overrules(desc, query), desc);
      const r = await checkRelevance({ query, plan: plan(load("X")),
        candidates: [{ attr_id: "X", attr_desc: desc }], refs: new Map([["a1", "X"]]),
        callLLM: scripted([v("a1", "none", "", "something else")]) });
      assert.strictEqual(r.verdicts[0].verdict, "unrelated", desc);
      assert.strictEqual(r.errors.length, 1, desc);
    }
    // ...while both recorded overrules still hold.
    assert.ok(overrules("Coronary heart disease among adults (crude prevalence)", "risk factors for heart disease by county"));
    assert.ok(overrules("Transmission Lines (mapped locations)", "hospitals within 10 miles of electric power transmission lines"));
  });

  await test("the overrule counts the attribute's own name, not its dataset's", async () => {
    // Two real qwen3:14b false rejections the overrule rescued until the
    // dataset name diluted it (research_advanced phase_e, 2026-11-11).
    const cases = [
      ["Using census tract data, what share of people in each Michigan county live in households without a vehicle, weighting each tract by its population?",
       "Percent of households with no vehicle available", "CDC Social Vulnerability Index"],
      ["In which Missouri counties does poverty vary the most from one census tract to another?",
       "Percent of persons below 150% of the poverty level", "CDC Social Vulnerability Index"],
    ];
    for (const [query, desc, ds] of cases) {
      assert.ok(overrules(desc, query, ds), desc);
      const r = await checkRelevance({ query, plan: plan(load("X")),
        candidates: [{ attr_id: "X", attr_desc: desc, dataset_clean: ds }], refs: new Map([["a1", "X"]]),
        callLLM: scripted([v("a1", "none", "", "something")]) });
      assert.deepStrictEqual(r.errors, [], desc);
      assert.match(r.verdicts[0].reason, /overruled/);
    }
    // The catalog text carries a coverage note; it is not part of the name
    // (answerability a-expl-heart was refused while it counted).
    assert.ok(overrules("Coronary heart disease among adults (age-adjusted prevalence) (covers 2,957 counties)",
      "risk factors for heart disease by county", "CDC PLACES"));
    // A facility column whose own name shares nothing still connects through
    // its dataset ("Name" of Hospitals).
    assert.ok(overrules("Name", "where are the hospitals in Ohio", "Hospitals"));
    // The three it exists to stop, with their real dataset names.
    assert.ok(!overrules("Mobile Home Parks (mapped locations)",
      "Group our mobile field inspection locations into five balanced service clusters", "Mobile Home Parks"));
    assert.ok(!overrules("Percent Estimate!!HOUSE HEATING FUEL!!Occupied housing units!!Solar energy",
      "Aggregate annual solar radiation raster values across commercial building footprints", "ACS_combined"));
    assert.ok(!overrules("Estimate!!VALUE!!Owner-occupied units",
      "aggregate assessed property value at risk in FEMA flood zones", "ACS_combined"));
  });

  await test("broader, stand-in and denominator pass and say why", async () => {
    const r = await checkRelevance({
      query: "where do the wealthiest people live, per person",
      plan: plan(load("INC"), { id: "s2", op: "load", attr_id: "POP", inputs: [] }),
      candidates, refs,
      callLLM: scripted([v("a3", "stand_in", "wealthiest", "household income"),
                         v("a2", "denominator", "per person", "population")]),
    });
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.verdicts.map(x => x.verdict), ["proxy", "denominator"]);
    assert.match(r.verdicts[0].reason, /stand-in for "wealthiest": measures household income/);
  });

  await test("a failed check never blocks a plan, and says it did not run", async () => {
    const r = await checkRelevance({ query: "q", plan: plan(load("INC")), candidates, refs,
      callLLM: async () => { throw new Error("timeout"); } });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.skipped, "timeout");
  });

  await test("no matching verdict is reported as SKIPPED, never as a pass", async () => {
    const r = await checkRelevance({ query: "q", plan: plan(load("INC")), candidates, refs,
      callLLM: scripted([]) });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.verdicts[0].verdict, "unchecked");
    assert.match(r.skipped, /no verdict matched/);
  });

  await test("a model that returns nothing is skipped, not passed", async () => {
    const r = await checkRelevance({ query: "q", plan: plan(load("INC")), candidates, refs,
      callLLM: async () => null });
    assert.match(r.skipped, /returned nothing/);
  });

  await test("verdicts match when the model decorates or omits the label", async () => {
    const two = plan(load("READ"), { id: "s2", op: "load", attr_id: "POP", inputs: [] });
    const q = "rainfall per person";
    const decorated = await checkRelevance({ query: q, plan: two, candidates, refs,
      callLLM: scripted([v("a1: Reading scores", "none"), v("POP", "denominator", "per person")]) });
    assert.deepStrictEqual(decorated.verdicts.map(x => x.verdict), ["unrelated", "denominator"]);
    const positional = await checkRelevance({ query: q, plan: two, candidates, refs,
      callLLM: scripted([v("Reading scores", "none"), v("Total population", "denominator", "per person")]) });
    assert.deepStrictEqual(positional.verdicts.map(x => x.verdict), ["unrelated", "denominator"]);
  });

  await test("the check is told each attribute's role in the plan", async () => {
    let seen = "";
    await checkRelevance({
      query: "what explains asthma rates",
      plan: plan(load("READ"), { id: "s2", op: "explain", inputs: ["s1"] },
                 { id: "s3", op: "output", inputs: ["s2"] }),
      candidates, refs,
      callLLM: async (sys, usr) => { seen = usr; return JSON.stringify({ verdicts: [] }); },
    });
    assert.match(seen, /used by load, feeding explain\)/);
  });

  await test("both attr_id and near_attr_id are checked, each once", () => {
    const u = usedAttributes(plan(
      { id: "s1", op: "count_near", attr_id: "A", near_attr_id: "B", inputs: [] },
      { id: "s2", op: "load", attr_id: "A", inputs: [] }));
    assert.deepStrictEqual(u.map(x => x.attr_id), ["A", "B"]);
  });

  await test("a plan with no attributes costs no LLM call", async () => {
    let called = false;
    const r = await checkRelevance({ query: "q", plan: plan({ id: "s1", op: "output", inputs: [] }),
      candidates, refs, callLLM: async () => { called = true; return "{}"; } });
    assert.ok(!called);
    assert.deepStrictEqual(r.errors, []);
  });

  // backend/population.js. Measured: qwen3:14b refused Total population for
  // both of these, though density is defined by it.
  await test("density: a total-population count is not rejected as unnamed", async () => {
    for (const query of ["how densely populated are the counties in Texas",
                         "people per square mile by county"]) {
      const r = await checkRelevance({
        query, plan: plan(load("POP")), candidates, refs,
        callLLM: scripted([v("a2", "none", "", "total population")]),
      });
      assert.deepStrictEqual(r.errors, [], query);
      assert.match(r.verdicts[0].reason, /defined by a total population/);
      // An overruled rejection is a check that RAN, not one that matched
      // nothing; it was reported as `skipped` before.
      assert.strictEqual(r.skipped, undefined, "overruled must not read as skipped");
    }
  });

  await test("density: the WorldPop gridded count is a population too", async () => {
    // Refused once a reasoning budget let the check finish, 2026-11-11.
    const grid = [{ attr_id: "WP", attr_desc: "Estimated population from the WorldPop 1 km gridded estimate" }];
    const r = await checkRelevance({
      query: "Where are the most densely populated 4 km grid cells in Colorado?", plan: plan(load("WP")),
      candidates: grid, refs: new Map([["a1", "WP"]]),
      callLLM: scripted([v("a1", "none", "", "population")]) });
    assert.deepStrictEqual(r.errors, []);
    assert.match(r.verdicts[0].reason, /defined by a total population/);
  });

  await test("population size: 'least populous' is about a total-population count", async () => {
    // Step 1 of a three-step workflow was refused for this, 2026-11-11.
    const r = await checkRelevance({
      query: "Take the 50 least populous counties in the country", plan: plan(load("POP")),
      candidates, refs, callLLM: scripted([v("a2", "none", "", "total population")]) });
    assert.deepStrictEqual(r.errors, []);
    assert.match(r.verdicts[0].reason, /population-size question/);
  });

  await test("density: the population rule exempts ONLY a total-population count", async () => {
    const r = await checkRelevance({
      query: "how densely populated are the counties in Texas", plan: plan(load("READ")),
      candidates, refs, callLLM: scripted([v("a1", "none", "", "student reading test scores")]),
    });
    assert.strictEqual(r.errors.length, 1, "reading scores must still be refused");
  });

  await test("density: no exemption when the question is not about density or per-person", async () => {
    const r = await checkRelevance({
      query: "average rainfall by county", plan: plan(load("POP")),
      candidates, refs, callLLM: scripted([v("a2", "none", "", "total population")]),
    });
    assert.strictEqual(r.errors.length, 1);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
