/**
 * Research workflows (backend/workflow.js) and the planner pieces they rely
 * on: earlier results as grounded sources, intersect `exclude`, and the
 * relevance check's fixed verdict for an earlier result.
 * Run: node backend/test_workflow.js
 */

const assert = require("node:assert");
const wf = require("./workflow");
const { generatePlan, buildSystemPrompt } = require("./planner/index");
const { validatePlan } = require("./planner/validate");
const { compilePlan } = require("./planner/compile");
const { checkRelevance } = require("./planner/relevance");
const { planSchemaFor } = require("./schemas");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const Q = "Take the 50 counties with the highest adult obesity rates. How does their median household income compare with the rest of the country?";
const twoSteps = JSON.stringify({ steps: [
  { id: "q1", question: "Which 50 counties have the highest adult obesity rates?", uses: [] },
  { id: "q2", question: "How does median household income in the counties from q1 compare with all other counties?", uses: ["q1"] },
] });

/** A minimal analyze body with one values layer. */
const body = (intent, rows, steps, extra = {}) => ({
  plan: { intent, steps }, rows, layers: [{ mode: "values", rows }], row_count: rows.length,
  provenance: { attribute_origins: extra.origins || [] }, adjustments: [], ...extra,
});
const TOP = [{ fips: "01001", name: "A", value: 45 }, { fips: "01003", name: "B", value: 44 },
             { fips: "01005", name: "C", value: 43 }];

(async () => {
  // ---------------------------------------------------------- decomposition
  await test("a forward reference, too many steps, or an idle step is refused", async () => {
    assert.match(wf.validateDecomposition({ steps: [
      { id: "q1", question: "income in the counties from q2", uses: ["q2"] },
      { id: "q2", question: "which counties are poorest", uses: [] }] }, Q).errors.join(), /not an earlier step/);
    const many = { steps: Array.from({ length: wf.MAX_STEPS + 1 }, (_, i) =>
      ({ id: `q${i + 1}`, question: `question number ${i}`, uses: i ? [`q${i}`] : [] })) };
    assert.match(wf.validateDecomposition(many, Q).errors.join(), /the limit is/);
    assert.match(wf.validateDecomposition({ steps: [
      { id: "q1", question: "which counties are poorest", uses: [] },
      { id: "q2", question: "which counties are richest", uses: [] }] }, Q).errors.join(), /feed no later step/);
  });

  await test("a reference written in the text counts as a use", async () => {
    const { steps } = wf.validateDecomposition({ steps: [
      { id: "q1", question: "Which 50 counties are most obese?", uses: [] },
      { id: "q2", question: "Income in the counties from q1 versus the rest", uses: [] }] }, Q);
    assert.deepStrictEqual(steps[1].uses, ["q1"]);
  });

  await test("a one-step decomposition runs the user's own words", async () => {
    const { steps } = wf.validateDecomposition({ steps: [
      { id: "q1", question: "Rural poor counties", uses: [] }] }, "Which rural counties have a poverty rate above 20%?");
    assert.strictEqual(steps[0].question, "Which rural counties have a poverty rate above 20%?");
  });

  await test("only a question that refers back is decomposed at all", async () => {
    // The four research.yaml questions the decomposer over-split, 2026-11-09.
    for (const q of [
      "What are the poverty rates in the counties of the St. Louis metro area?",
      "Which counties' unemployment rate rose the most over the last decade?",
      "Is the unemployment rate higher in the South than in the Northeast?",
      "Which counties with above-median poverty rates are more than 30 miles from the nearest hospital?"]) {
      assert.ok(!wf.needsWorkflow(q), q);
      let asked = false;
      const r = await wf.runWorkflow({ question: q, decompose: async () => { asked = true; return twoSteps; },
        analyze: async () => body("x", TOP, [{ op: "load", attr_id: "A" }]) });
      assert.ok(!asked && r.decomposition.gated && r.steps.length === 1);
    }
    assert.ok(wf.needsWorkflow(Q));
    assert.ok(wf.needsWorkflow("Find the 20 poorest counties and map their broadband access"));
    // A reference inside one clause is to the counties asked about: one plan.
    assert.ok(!wf.needsWorkflow("Which counties have a much higher unemployment rate than the average of their neighboring counties?"));
    assert.ok(wf.needsWorkflow("Rank counties by poverty; then show their uninsured rates"));
  });

  // ------------------------------------------------------------- execution
  await test("a later step is handed exactly its declared result, as a grounded source", async () => {
    const calls = [];
    const report = await wf.runWorkflow({
      question: Q,
      decompose: async () => twoSteps,
      analyze: async ({ query, extraSources }) => {
        calls.push({ query, ids: [...extraSources.keys()] });
        if (calls.length === 1) {
          return body("Top 50 counties by adult obesity", TOP,
            [{ op: "load", attr_id: "OB" }, { op: "rank" }, { op: "output" }],
            { origins: [{ attr_id: "OB", description: "Adult obesity", dataset: "CDC PLACES" }] });
        }
        const src = extraSources.get("result:q1");
        assert.deepStrictEqual(src.fips, ["01001", "01003", "01005"]);
        assert.strictEqual(src.source_kind, "inline");
        assert.match(src.description, /Counties from q1: Top 50 counties by adult obesity \(3 counties, values 43 to 45\)/);
        return body("Income, top-obesity counties vs the rest", TOP,
          [{ op: "load", attr_id: "INC" }, { op: "load", attr_id: "result:q1" },
           { op: "intersect" }, { op: "compare_groups" }, { op: "output" }],
          { origins: [{ attr_id: "INC", description: "Median household income", dataset: "ACS" }] });
      },
    });
    assert.strictEqual(report.status, "complete");
    assert.deepStrictEqual(calls.map(c => c.ids), [[], ["result:q1"]]);
    assert.match(report.methods, /q1\. Which 50 counties have the highest adult obesity rates\?/);
    assert.match(report.methods, /q2\..*\[uses q1\]/);
    assert.match(report.methods, /Data: Adult obesity \(CDC PLACES\)/);
  });

  await test("a step that does not use the result it declared stops the workflow", async () => {
    let n = 0;
    const report = await wf.runWorkflow({
      question: Q, decompose: async () => twoSteps,
      analyze: async () => (++n === 1
        ? body("Top 50 by obesity", TOP, [{ op: "load", attr_id: "OB" }, { op: "output" }])
        : body("Income everywhere", TOP, [{ op: "load", attr_id: "INC" }, { op: "output" }])),
    });
    assert.strictEqual(report.status, "stopped");
    assert.strictEqual(report.stopped_at, "q2");
    assert.match(report.reason, /did not use them, so it answered a different question/);
  });

  await test("a failed step stops the workflow; later steps never run", async () => {
    let n = 0;
    const report = await wf.runWorkflow({
      question: Q, decompose: async () => twoSteps,
      analyze: async () => { n++; return { error: "the data for this question has not been loaded" }; },
    });
    assert.strictEqual(n, 1);
    assert.strictEqual(report.stopped_at, "q1");
    assert.match(report.reason, /not been loaded/);
  });

  await test("a summary statistic cannot feed a step that needs counties", async () => {
    const report = await wf.runWorkflow({
      question: Q, decompose: async () => twoSteps,
      analyze: async () => ({ plan: { intent: "rho", steps: [{ op: "correlate" }] },
        layers: [{ mode: "values", rows: [{ fips: null, value: 0.4 }], stats: { value: 0.4 } }] }),
    });
    assert.strictEqual(report.stopped_at, "q1");
    assert.match(report.reason, /summary rather than a set of counties/);
  });

  await test("an unusable decomposition runs the question as asked", async () => {
    const seen = [];
    const report = await wf.runWorkflow({
      question: Q, decompose: async () => "{not json",
      analyze: async ({ query }) => { seen.push(query); return body("x", TOP, [{ op: "load", attr_id: "A" }]); },
    });
    assert.deepStrictEqual(seen, [Q]);
    assert.strictEqual(report.status, "complete");
    assert.ok(report.decomposition.fallback[0].startsWith("decomposition failed"));
  });

  // ------------------------------------------------------- planner pieces
  const SRC = new Map([
    ["INC", { source_kind: "acs_long", census_code: "DP03_0062E", description: "Median household income",
              value_range: { lo: 12000, hi: 150000 } }],
  ]);
  const result = wf.resultSource({ id: "q1", question: "top 50 obesity" },
    body("Top 50 counties by adult obesity", TOP, []));
  const resolve = wf.withResultSources(
    async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)])),
    new Map([[result.attr_id, result]]));

  await test("an earlier result loads like an upload, and exclude is its complement", async () => {
    const p = { intent: "t", steps: [
      { id: "s1", op: "load", attr_id: "INC", inputs: [] },
      { id: "s2", op: "load", attr_id: "result:q1", inputs: [] },
      { id: "s3", op: "intersect", inputs: ["s1", "s2"] },
      { id: "s4", op: "intersect", inputs: ["s1", "s2"], exclude: true },
      { id: "s5", op: "compare_groups", inputs: ["s3", "s4"] },
      { id: "s6", op: "output", inputs: ["s5"] }] };
    const v = await validatePlan(p, resolve);
    assert.deepStrictEqual(v.errors, []);
    const c = compilePlan(p, v.resolved);
    assert.match(c.sql, /unnest\(\$\d+::char\(5\)\[\], \$\d+::float8\[\]\)/);
    assert.match(c.sql, /step_s3 AS \(SELECT a\.fips, a\.value FROM step_s1 a WHERE EXISTS/);
    assert.match(c.sql, /step_s4 AS \(SELECT a\.fips, a\.value FROM step_s1 a WHERE NOT EXISTS/);
    assert.deepStrictEqual(c.outputs[0].groupLabels, { a: "counties from step 1", b: "all counties except counties from step 1" });
  });

  await test("a step with earlier results gets their heading, the note, and exclude", async () => {
    let prompt = "", system = "";
    const planJSON = JSON.stringify({ intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "load", attr_id: "a2", inputs: [] },
      { id: "s2", op: "load", attr_id: "a1", inputs: [] },
      { id: "s3", op: "intersect", attr_id: "", inputs: ["s1", "s2"] },
      { id: "s4", op: "output", attr_id: "", inputs: ["s3"] }] });
    const res = await generatePlan({
      query: "median household income in the counties from q1",
      candidates: [wf.resultCandidate(result),
        { attr_id: "INC", attr_desc: "Median household income", search_purpose: "primary" }],
      callLLM: async (sys, usr) => { system = sys; prompt = usr; return planJSON; },
      resolve, log: () => {},
    });
    assert.ok(res.ok, JSON.stringify(res.errors));
    assert.match(prompt, /## EARLIER RESULTS[^\n]*\na1: Counties from q1/);
    assert.match(system, /EARLIER RESULTS\n\n  Labels under EARLIER RESULTS/);
    assert.strictEqual(res.plan.steps[1].attr_id, "result:q1");
    const ctx = { query: "x", hasEarlierResults: true };
    assert.ok(planSchemaFor(ctx).properties.steps.items.properties.exclude);
    assert.ok(!planSchemaFor({ query: "median income by county" }).properties.steps.items.properties.exclude);
    assert.ok(!/EARLIER RESULTS/.test(buildSystemPrompt({ query: "median income by county" })));
  });

  await test("the relevance check never sends an earlier result to the model", async () => {
    let asked = "";
    const r = await checkRelevance({
      query: "income in the counties from q1",
      plan: { intent: "t", steps: [{ id: "s1", op: "load", attr_id: "result:q1" },
                                   { id: "s2", op: "output", inputs: ["s1"] }] },
      candidates: [wf.resultCandidate(result)], refs: new Map([["a1", "result:q1"]]),
      callLLM: async (s, u) => { asked = u; return "{}"; },
    });
    assert.strictEqual(asked, "", "the model was asked about an earlier result");
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.verdicts[0].verdict, "earlier_result");
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
