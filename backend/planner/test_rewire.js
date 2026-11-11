/**
 * Structural repairs (planner/rewire.js). Each case is a plan observed live
 * on 2026-11-09 that the repair loop failed on 3 attempts of 3.
 * Run: node backend/planner/test_rewire.js
 */

const assert = require("node:assert");
const { loadLabelInputs, splitOutputs, dropRateOverCount, earlierResultSecond,
        bridgeInputsToIntersect, restrictToEarlier, uninvertChains } = require("./rewire");
const { validatePlan } = require("./validate");
const { generatePlan } = require("./index");
const wf = require("../workflow");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["INC", { source_kind: "acs_long", census_code: "DP03_0062E", description: "Median household income",
            value_range: { lo: 12000, hi: 150000 } }],
  ["UNINS", { source_kind: "acs_long", census_code: "DP03_0099PE",
              description: "Percent Estimate|No health insurance coverage", value_range: { lo: 2, hi: 40 } }],
  ["POP", { source_kind: "acs_long", census_code: "DP05_0001E",
            description: "Estimate|SEX AND AGE|Total population", value_range: { lo: 117, hi: 10040682 } }],
]);
const TOP = [{ fips: "01001", name: "A", value: 45 }, { fips: "01003", name: "B", value: 44 }];
const result = wf.resultSource({ id: "q1", question: "top obesity" },
  { plan: { intent: "Top counties by adult obesity" }, layers: [{ mode: "values", rows: TOP }] });
const resolve = wf.withResultSources(
  async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)])),
  new Map([[result.attr_id, result]]));

(async () => {
  await test("an attribute label used as an input becomes a load of it", async () => {
    const p = { steps: [
      { id: "s1", op: "load", attr_id: "a2", inputs: [] },
      { id: "s2", op: "intersect", inputs: ["s1", "a1"] },
      { id: "s3", op: "intersect", inputs: ["s1", "a1"], exclude: true },
      { id: "s4", op: "compare_groups", inputs: ["s2", "s3"] },
      { id: "s5", op: "output", inputs: ["s4"] }] };
    assert.match(loadLabelInputs(p, new Map([["a1", "result:q1"], ["a2", "INC"]])), /loaded a1/);
    assert.deepStrictEqual(p.steps[0], { id: "load_a1", op: "load", attr_id: "a1", inputs: [] });
    assert.deepStrictEqual(p.steps[2].inputs, ["s1", "load_a1"]);
    assert.deepStrictEqual(p.steps[3].inputs, ["s1", "load_a1"]);
    assert.strictEqual(loadLabelInputs(p, new Map([["a1", "x"]])), null);
  });

  await test("the workflow plan from the log validates on attempt 1 once rewired", async () => {
    const planJSON = JSON.stringify({ intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "load", attr_id: "a2", inputs: [] },
      { id: "s2", op: "intersect", attr_id: "", inputs: ["s1", "a1"] },
      { id: "s3", op: "intersect", attr_id: "", inputs: ["s1", "a1"], exclude: true },
      { id: "s4", op: "compare_groups", attr_id: "", inputs: ["s2", "s3"] },
      { id: "s5", op: "output", attr_id: "", inputs: ["s4"] }] });
    const res = await generatePlan({
      query: "Is median household income higher in the counties from q1 than in all other counties?",
      candidates: [wf.resultCandidate(result),
        { attr_id: "INC", attr_desc: "Median household income", search_purpose: "primary" }],
      callLLM: async () => planJSON, resolve, log: () => {}, hasNeighbors: true,
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.strictEqual(res.attempts.length, 0, "needed a repair round");
    assert.strictEqual(res.plan.steps[0].attr_id, "result:q1");
  });

  await test("an output with two inputs becomes two outputs", async () => {
    const p = { steps: [{ id: "s1", op: "load" }, { id: "s2", op: "load" },
                        { id: "s8", op: "output", inputs: ["s1", "s2"] }] };
    assert.ok(splitOutputs(p));
    assert.deepStrictEqual(p.steps.slice(2).map(s => [s.id, s.inputs]),
                           [["s8", ["s1"]], ["s8_2", ["s2"]]]);
  });

  await test("a rate divided by a count keeps the rate, and drops the unused count", async () => {
    const p = { intent: "t", steps: [
      { id: "s1", op: "load", attr_id: "UNINS", inputs: [] },
      { id: "s2", op: "load", attr_id: "POP", inputs: [] },
      { id: "s3", op: "normalize", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "rank", inputs: ["s3"], direction: "desc", limit: 100 },
      { id: "s5", op: "output", inputs: ["s4"] }] };
    const v = await validatePlan(p, resolve);
    assert.match(v.errors.join(), /already a rate/);
    assert.match(dropRateOverCount(p, v.resolved), /kept the rate itself/);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["load", "rank", "output"]);
    assert.deepStrictEqual(p.steps[1].inputs, ["s1"]);
    assert.deepStrictEqual((await validatePlan(p, resolve)).errors, []);
  });

  await test("generatePlan applies the rate repair instead of looping on it", async () => {
    const planJSON = JSON.stringify({ intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "load", attr_id: "a1", inputs: [] },
      { id: "s2", op: "load", attr_id: "a2", inputs: [] },
      { id: "s3", op: "normalize", attr_id: "", inputs: ["s1", "s2"], scale: 100 },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }] });
    let calls = 0;
    const res = await generatePlan({
      query: "Which 100 counties have the highest uninsured rates?",
      candidates: [{ attr_id: "UNINS", attr_desc: "uninsured", search_purpose: "primary" },
                   { attr_id: "POP", attr_desc: "Total population", search_purpose: "normalization" }],
      callLLM: async () => { calls++; return planJSON; }, resolve, log: () => {},
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.strictEqual(calls, 1);
    assert.match(res.adjustments.join(), /kept the rate itself/);
  });

  await test("an earlier result goes second in intersect: it is the set, not the measure", () => {
    // The plan qwen3:14b (reasoning off) emitted for r-obesity-top50-income's
    // q2, 3 of 3 runs: both groups built from q1's values, one of them empty.
    const plan = { steps: [
      { id: "s1", op: "load", attr_id: "result:q1", inputs: [] },
      { id: "s2", op: "load", attr_id: "MEDIAN_HOUSEHOLD_INCOME", inputs: [] },
      { id: "s3", op: "intersect", attr_id: "", inputs: ["s1", "s2"] },
      { id: "s4", op: "load", attr_id: "MEDIAN_HOUSEHOLD_INCOME", inputs: [] },
      { id: "s5", op: "intersect", attr_id: "", inputs: ["s1", "s4"], exclude: true },
      { id: "s6", op: "compare_groups", attr_id: "", inputs: ["s3", "s5"] },
      { id: "s7", op: "output", attr_id: "", inputs: ["s6"] }] };
    assert.match(earlierResultSecond(plan), /s3, s5/);
    assert.deepStrictEqual(plan.steps[2].inputs, ["s2", "s1"]);
    assert.deepStrictEqual(plan.steps[4].inputs, ["s4", "s1"]);
    // Already right, through a filter: untouched. Two earlier results: untouched.
    const ok = { steps: [
      { id: "s1", op: "load", attr_id: "INC", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 1 },
      { id: "s3", op: "load", attr_id: "result:q1", inputs: [] },
      { id: "s4", op: "intersect", attr_id: "", inputs: ["s2", "s3"] },
      { id: "s5", op: "load", attr_id: "result:q2", inputs: [] },
      { id: "s6", op: "intersect", attr_id: "", inputs: ["s3", "s5"] }] };
    assert.strictEqual(earlierResultSecond(ok), null);
  });

  await test("a bridge given an input runs on its own, then keeps only those counties", async () => {
    // "How far is each of the counties from q1 from the nearest hospital", 3 of 3.
    const plan = { intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "load", attr_id: "result:q1", inputs: [] },
      { id: "s2", op: "nearest_distance", attr_id: "HOSP", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] };
    assert.match(bridgeInputsToIntersect(plan), /nearest_distance \(s2\)/);
    assert.deepStrictEqual(plan.steps.map(s => `${s.id}:${s.op}:${s.inputs.join(",")}`),
      ["s1:load:", "s2_nearest_distance:nearest_distance:", "s2:intersect:s2_nearest_distance,s1", "s3:output:s2"]);
    assert.strictEqual(bridgeInputsToIntersect(plan), null, "idempotent");
  });

  await test("an ignored earlier result becomes a restriction on every chain start", async () => {
    // "Within those counties, how strongly is smoking related to COPD".
    const plan = { steps: [
      { id: "s1", op: "load", attr_id: "SMOKE", inputs: [] },
      { id: "s2", op: "load", attr_id: "COPD", inputs: [] },
      { id: "s3", op: "correlate", attr_id: "", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }] };
    assert.match(restrictToEarlier(plan, ["result:q1"]), /s1, s2 to the counties from q1/);
    const by = new Map(plan.steps.map(s => [s.id, s]));
    assert.deepStrictEqual(by.get("s3").inputs, ["s1_in_earlier", "s2_in_earlier"]);
    assert.deepStrictEqual(by.get("s1_in_earlier").inputs, ["s1", "earlier"]);
    assert.strictEqual(by.get("earlier").attr_id, "result:q1");
    // Already used, or two results on offer: left alone.
    assert.strictEqual(restrictToEarlier(plan, ["result:q1"]), null);
    const two = { steps: [{ id: "s1", op: "load", attr_id: "X", inputs: [] }] };
    assert.strictEqual(restrictToEarlier(two, ["result:q1", "result:q2"]), null);
  });

  await test("a chain written upside down is put the right way round", async () => {
    // "What are the poverty rates around Detroit?", reasoning off, attempt 1.
    const plan = { intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "filter_place", attr_id: "", inputs: [], place_kind: "cbsa", place_name: "Detroit" },
      { id: "s2", op: "load", attr_id: "POV", inputs: ["s1"] },
      { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] };
    assert.match(uninvertChains(plan), /filter_place \(s1\)/);
    assert.deepStrictEqual(plan.steps.map(s => `${s.id}:${s.inputs.join(",")}`), ["s2:", "s1:s2", "s3:s1"]);
    const r = await validatePlan(plan, async (ids) => new Map(ids.map(i => [i, { source_kind: "acs_long", census_code: i }])));
    assert.ok(r.ok, r.errors.join("; "));
    assert.strictEqual(uninvertChains(plan), null, "a correct chain is left alone");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
