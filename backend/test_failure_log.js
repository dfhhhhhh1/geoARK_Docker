// node test_failure_log.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createFailureLog, createTrace, classify, buildEntry } = require("./failure_log");

let n = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { n++; }, (e) => { console.error(`FAIL ${name}`); throw e; });

(async () => {
  await t("classify: answered runs are not failures", () => {
    assert.strictEqual(classify({ status: 200, body: { plan: {}, row_count: 12 } }), null);
    assert.strictEqual(classify({ status: 200, body: { plan: {}, row_count: 1, stats: { rho: 0.4 } } }), null);
    // execute:false has no row_count at all; that is not "empty".
    assert.strictEqual(classify({ status: 200, body: { plan: {} } }), null);
  });
  await t("classify: bad input and overload are not the query's fault", () => {
    assert.strictEqual(classify({ status: 400, body: { error: "field 'q' is required" } }), null);
    assert.strictEqual(classify({ status: 503, body: { error: "server is busy" } }), null);
  });
  await t("classify: the failure kinds", () => {
    const c = (status, body) => classify({ status, body });
    assert.strictEqual(c(422, { error: "could not produce a valid plan" }), "planner_failed");
    assert.strictEqual(c(422, { error: "no analysis could be built from the available data" }), "no_plan");
    assert.strictEqual(c(422, { error: "the loaded data does not measure what this question asks about" }), "not_measured");
    assert.strictEqual(c(422, { error: "the loaded data does not cover the period this question asks about" }), "period_not_covered");
    assert.strictEqual(c(500, { error: "analyze failed" }), "internal_error");
    assert.strictEqual(c(500, { plan: {}, execution_error: "syntax error" }), "execution_error");
    assert.strictEqual(c(422, { error: "x", unavailable_datasets: ["Prisons"] }), "data_not_loaded");
    assert.strictEqual(c(200, { plan: {}, row_count: 0, rows: [] }), "empty_result");
    assert.strictEqual(c(200, { error: "workflow stopped at q2: ignored its input" }), "workflow_stopped");
  });
  await t("classify: a layer-only result is not empty", () => {
    assert.strictEqual(classify({ status: 200, body: { plan: {}, row_count: 0, layers: [{ row_count: 3 }] } }), null);
    assert.strictEqual(classify({ status: 200, body: { plan: {}, row_count: 0, features: [{}] } }), null);
  });

  await t("trace taps emit and still forwards every event", () => {
    const seen = [];
    const trace = createTrace();
    const emit = trace.tap((ev) => seen.push(ev.stage));
    emit({ stage: "started" });
    emit({ stage: "decomposed", decomposition: ["a", "b"], retrieved: 40 });
    emit({ stage: "planning", attempt: 1 });
    emit({ stage: "plan_invalid", attempt: 1, errors: ["step s2 divides a rate by a count"] });
    emit({ stage: "planning", attempt: 2 });
    emit({ stage: "plan_adjusted", detail: "restricted to Missouri" });
    assert.deepStrictEqual(seen, ["started", "decomposed", "planning", "plan_invalid", "planning", "plan_adjusted"]);
    assert.strictEqual(trace.data.retrieved, 40);
    assert.strictEqual(trace.data.planning_attempts, 2);
    assert.deepStrictEqual(trace.data.attempts[0].errors, ["step s2 divides a rate by a count"]);
    assert.strictEqual(trace.data.stages.at(-1), "plan_adjusted");
  });
  await t("trace survives a malformed event", () => {
    const trace = createTrace();
    const emit = trace.tap(() => {});
    emit(null); emit({}); emit({ stage: "plan_invalid", errors: null });
  });

  await t("buildEntry keeps what is needed to reproduce and clips what is large", () => {
    const e = buildEntry({
      query: "q", kind: "planner_failed", status: 422,
      body: { error: "could not produce a valid plan", validation_errors: ["bad".repeat(500)],
              candidates: Array.from({ length: 20 }, (_, i) => ({ attr_id: `a${i}`, attr_desc: "d" })) },
      trace: createTrace().data, flags: { plan_model: "qwen3:14b" }, env: { corpus_cache_key: "k" }, ms: 5,
    });
    assert.strictEqual(e.class, "failure");
    assert.strictEqual(e.candidates.length, 8);
    assert.ok(e.validation_errors[0].length <= 301);
    assert.strictEqual(e.flags.plan_model, "qwen3:14b");
    assert.strictEqual(e.env.corpus_cache_key, "k");
    assert.match(e.id, /^[0-9a-f]{10}$/);
  });
  await t("refusals are classed apart from failures", () => {
    assert.strictEqual(buildEntry({ query: "q", kind: "not_measured", status: 422 }).class, "refusal");
    assert.strictEqual(buildEntry({ query: "q", kind: "empty_result", status: 200 }).class, "empty");
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faillog-"));
  await t("record then read, newest first, filtered", async () => {
    const log = createFailureLog({ dir });
    for (const [i, kind] of ["planner_failed", "not_measured", "planner_failed"].entries()) {
      assert.ok(await log.record(buildEntry({ query: `query ${i}`, kind, status: 422 })));
    }
    const all = await log.read();
    assert.deepStrictEqual(all.map((e) => e.query), ["query 2", "query 1", "query 0"]);
    assert.strictEqual((await log.read({ kind: "planner_failed" })).length, 2);
    assert.strictEqual((await log.read({ cls: "refusal" })).length, 1);
    assert.strictEqual((await log.read({ q: "QUERY 1" })).length, 1);
    assert.strictEqual((await log.read({ limit: 1 })).length, 1);
  });
  await t("a corrupt line does not hide the others", async () => {
    const log = createFailureLog({ dir });
    fs.appendFileSync(log.file, "{not json\n");
    await log.record(buildEntry({ query: "after", kind: "no_plan", status: 422 }));
    assert.strictEqual((await log.read()).at(0).query, "after");
    assert.strictEqual((await log.read({ limit: 100 })).length, 4);
  });
  await t("rotates at the size cap", async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "faillog-"));
    const log = createFailureLog({ dir: d2, maxBytes: 200 });
    for (let i = 0; i < 4; i++) await log.record(buildEntry({ query: `r${i}`, kind: "no_plan", status: 422 }));
    assert.ok(fs.existsSync(`${log.file}.1`));
  });
  await t("an unwritable directory never throws", async () => {
    const warnings = [];
    // A path under a regular file cannot be created.
    const log = createFailureLog({ dir: path.join(dir, "failures.jsonl", "sub"), warn: (m) => warnings.push(m) });
    assert.strictEqual(await log.record({ query: "x" }), false);
    assert.ok(warnings.length >= 1);
  });
  await t("disabled (no dir) is a no-op", async () => {
    const log = createFailureLog({ dir: "" });
    assert.strictEqual(await log.record({ query: "x" }), false);
    assert.deepStrictEqual(await log.read(), []);
  });

  console.log(`failure_log: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
