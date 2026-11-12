// Tests for planner/named_data.js with a scripted LLM. No model or database.
//   node planner/test_named_data.js
// The scripted replies are real qwen3:14b outputs from the 2026-11-11 prototype.
const assert = require("node:assert");
const { checkNamedData, missingConcepts, isExempt } = require("./named_data");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const scripted = (named) => async () => JSON.stringify({ named });
const n = (phrase, covered_by) => ({ phrase, covered_by });
const used = (...ids) => ids.map(id => ({ attr_id: id, op: "load", feeds: [] }));
const refs = new Map([["a1", "A"], ["a2", "B"], ["a3", "C"]]);
const candidates = [
  { attr_id: "A", attr_desc: "Estimate!!VALUE!!Owner-occupied units" },
  { attr_id: "B", attr_desc: "Total population" },
  { attr_id: "C", attr_desc: "Hospitals (mapped locations)" },
];

(async () => {
  await test("exempt: places, units, periods and the reporting unit name no data", () => {
    for (const [phrase, q] of [
      ["the Midwest", "population density per square mile in the Midwest"],
      ["Missouri", "where are the critical access hospitals in Missouri"],
      ["each county", "how many hospitals are within 10 miles of transmission lines in each county"],
      ["within 10 miles", "how many hospitals are within 10 miles of transmission lines"],
      ["between 2019 and 2020", "How did unemployment change between 2019 and 2020 in Michigan counties?"],
      ["Michigan counties", "How did unemployment change between 2019 and 2020 in Michigan counties?"],
      ["by county", "What is the average rainfall by county?"],
      ["per square kilometer", "density of retail food stores per square kilometer"],
      ["last 12 months", "requests over the last 12 months"],
      ["around Detroit", "What are the poverty rates around Detroit?"],
      ["the Rust Belt", "unemployment in the Rust Belt"],
      // Two false refusals on research.yaml, 2026-11-11.
      ["the center of each Missouri county", "How many miles is the center of each Missouri county from the nearest hospital?"],
      ["the rest of the country", "how does their income compare with the rest of the country"],
      ["How far, in miles", "How far, in miles, is the center of each Missouri county from the nearest hospital?"],
    ]) assert.ok(isExempt(phrase, q), `${phrase} / ${q}`);
  });

  await test("not exempt: anything that could name data", () => {
    for (const [phrase, q] of [
      ["average rainfall", "What is the average rainfall by county?"],
      ["tax parcel data", "intersect flood zones with local county tax parcel data"],
      ["city council district", "requests within each city council district"],
      ["neighborhood planning unit", "across each neighborhood planning unit"],
      ["total road centerline mileage", "normalize by total road centerline mileage"],
      ["state forest boundary", "within the state forest boundary"],
      // A data word inside a place-shaped phrase still counts.
      ["Missouri hospitals", "Missouri hospitals"],
    ]) assert.ok(!isExempt(phrase, q), `${phrase} / ${q}`);
  });

  await test("flood zones x parcels: uncovered phrases become NOT_COVERED errors", async () => {
    const q = "Intersect the current 100-year FEMA flood zones with local county tax parcel data to export a list of parcel IDs and aggregate assessed property value at risk.";
    const r = await checkNamedData({ query: q, used: used("A"), candidates, refs,
      callLLM: scripted([n("current 100-year FEMA flood zones", "layer"),
                         n("local county tax parcel data", "a layer the analysis must read"),
                         n("parcel IDs", ""), n("aggregate assessed property value", "a1")]) });
    // "layer" and "a layer the analysis must read" are not labels: uncovered.
    assert.deepStrictEqual(r.uncovered,
      ["current 100-year FEMA flood zones", "local county tax parcel data", "parcel IDs"]);
    assert.strictEqual(r.errors.length, 3);
    assert.match(r.errors[0], /^NOT_COVERED: the question asks about "current 100-year FEMA flood zones"/);
    assert.match(r.errors[0], /empty "steps" array/);
  });

  await test("answerable questions pass even when the model lists places and periods", async () => {
    for (const [q, named, ids] of [
      ["population density per square mile in the Midwest",
        [n("population density per square mile", "a2"), n("the Midwest", "")], ["B"]],
      ["How did unemployment change between 2019 and 2020 in Michigan counties?",
        [n("unemployment", "a1"), n("between 2019 and 2020", ""), n("Michigan counties", "")], ["A"]],
      ["how many hospitals are within 10 miles of electric power transmission lines in each county",
        [n("hospitals", "a3"), n("within 10 miles", "count_near"), n("each county", "")], ["C"]],
    ]) {
      const r = await checkNamedData({ query: q, used: used(...ids), candidates, refs, callLLM: scripted(named) });
      assert.deepStrictEqual(r.errors, [], q);
    }
  });

  await test("covered_by accepts the label however it is decorated", async () => {
    const r = await checkNamedData({ query: "where are the hospitals", used: used("C"), candidates, refs,
      callLLM: scripted([n("hospitals", "a3: Hospitals (mapped locations)")]) });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.named[0].covered_by, "a3");
  });

  await test("a phrase that is not in the question is ignored, not refused", async () => {
    const r = await checkNamedData({ query: "where are the hospitals", used: used("C"), candidates, refs,
      callLLM: scripted([n("hospitals", "a3"), n("emergency rooms", "")]) });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.named[1].grounded, false);
  });

  await test("a check that fails blocks nothing and says it did not run", async () => {
    const r = await checkNamedData({ query: "q", used: used("C"), candidates, refs,
      callLLM: async () => { throw new Error("timeout"); } });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.skipped, "timeout");
  });

  await test("an earlier workflow result is not judged", async () => {
    let called = false;
    const r = await checkNamedData({ query: "income in those counties",
      used: [{ attr_id: "result:q1", op: "load", feeds: [] }, ...used("A")], candidates, refs,
      callLLM: async () => { called = true; return "{}"; } });
    assert.deepStrictEqual(r.errors, []);
    assert.ok(!called);
  });

  await test("the call asks for reasoning off with no budget", async () => {
    let extra;
    await checkNamedData({ query: "where are the hospitals", used: used("C"), candidates, refs,
      callLLM: async (s, u, t, schema, x) => { extra = x; return JSON.stringify({ named: [] }); } });
    assert.deepStrictEqual(extra, { role: "named_data", think: false, thinkBudget: 0 });
  });

  await test("missingConcepts labels candidates a1.. and reports what none covers", async () => {
    let user;
    const r = await missingConcepts({
      query: "Find every residential parcel within 500 meters of a planned transit stop",
      candidates, callLLM: async (s, u) => { user = u;
        return JSON.stringify({ named: [n("residential parcel", ""), n("planned transit stop", "")] }); } });
    assert.match(user, /a1: Estimate!!VALUE!!Owner-occupied units/);
    assert.match(user, /a3: Hospitals/);
    assert.deepStrictEqual(r.uncovered, ["residential parcel", "planned transit stop"]);
  });

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
