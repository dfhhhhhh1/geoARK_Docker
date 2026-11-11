/**
 * Re-running a workflow with one step's data changed (workflow.rerunWorkflow),
 * which backs the pipeline UI's "change data".
 * Run: node backend/test_workflow_rerun.js
 */

const assert = require("node:assert");
const wf = require("./workflow");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const rows = (fipsList, v = 1) => fipsList.map((f, i) => ({ fips: f, name: f, value: v + i }));
const body = (intent, r, steps) => ({ plan: { intent, steps }, rows: r, layers: [{ mode: "values", rows: r }] });
const STEPS = [
  { id: "q1", question: "Which 30 counties have the lowest median income?", uses: [],
    plan: { steps: [{ id: "s1", op: "load", attr_id: "INC" }, { id: "s2", op: "rank" }, { id: "s3", op: "output" }] } },
  { id: "q2", question: "Is obesity higher in the counties from q1?", uses: ["q1"],
    plan: { steps: [{ id: "s1", op: "load", attr_id: "OB" }, { id: "s2", op: "load", attr_id: "result:q1" },
                    { id: "s3", op: "intersect" }, { id: "s4", op: "output" }] } },
];

(async () => {
  await test("only the edited step gets the edit; the next step sees its new counties", async () => {
    const seen = [];
    const report = await wf.rerunWorkflow({
      question: "q", steps: STEPS, edit: { step: "q1", kind: "swap_measure", from: "INC", to: "INC2" },
      execute: async ({ step, plan, extraSources, edit }) => {
        seen.push({ id: step.id, edit: edit?.kind ?? null, sources: [...extraSources.keys()] });
        if (step.id === "q1") {
          // The edited step answers with different counties.
          return body("lowest income (new measure)", rows(["29001", "29003"]),
                      plan.steps.map(s => (s.attr_id === "INC" ? { ...s, attr_id: "INC2" } : s)));
        }
        assert.deepStrictEqual(extraSources.get("result:q1").fips, ["29001", "29003"]);
        return body("obesity in those counties", rows(["29001"]), plan.steps);
      },
    });
    assert.strictEqual(report.status, "complete");
    assert.deepStrictEqual(seen, [
      { id: "q1", edit: "swap_measure", sources: [] },
      { id: "q2", edit: null, sources: ["result:q1"] }]);
    assert.strictEqual(report.edited_step, "q1");
    assert.ok(report.steps[0].edited && !report.steps[1].edited);
  });

  await test("an edit that breaks a later step stops there, with the reason", async () => {
    const report = await wf.rerunWorkflow({
      question: "q", steps: STEPS, edit: { step: "q2", kind: "swap_measure", from: "OB", to: "X" },
      execute: async ({ step, plan }) => (step.id === "q1"
        ? body("x", rows(["01001"]), plan.steps)
        : { error: "the changed analysis is not valid", detail: "X is a facility dataset" }),
    });
    assert.strictEqual(report.status, "stopped");
    assert.strictEqual(report.stopped_at, "q2");
    assert.match(report.reason, /not valid \(X is a facility dataset\)/);
  });

  await test("a plan sent back that no longer cites its input is refused", async () => {
    const broken = [STEPS[0], { ...STEPS[1], plan: { steps: [{ id: "s1", op: "load", attr_id: "OB" }, { id: "s2", op: "output" }] } }];
    const report = await wf.rerunWorkflow({
      question: "q", steps: broken, edit: null,
      execute: async ({ plan }) => body("x", rows(["01001"]), plan.steps),
    });
    assert.strictEqual(report.stopped_at, "q2");
    assert.match(report.reason, /no longer uses the counties from q1/);
  });

  await test("malformed workflows and edits naming no step are refused before running", async () => {
    let ran = false;
    const exec = async () => { ran = true; return {}; };
    const r1 = await wf.rerunWorkflow({ question: "q", steps: STEPS, edit: { step: "q9" }, execute: exec });
    assert.strictEqual(r1.status, "invalid");
    const r2 = await wf.rerunWorkflow({ question: "q",
      steps: [{ ...STEPS[1], id: "q1", uses: ["q2"] }], edit: null, execute: exec });
    assert.match(r2.errors.join(), /not an earlier step/);
    assert.ok(!ran);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
