// Tests for planner/relevance.js with a scripted LLM. No model or database.
//   node planner/test_relevance.js
const assert = require("node:assert");
const { checkRelevance, usedAttributes, grounded, sharedWords } = require("./relevance");

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
    ]) assert.deepStrictEqual(sharedWords(desc, query), [], `${desc} / ${query}`);
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

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
