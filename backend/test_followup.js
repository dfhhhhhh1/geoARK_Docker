/**
 * Tests for follow-ups (backend/followup.js).
 *
 * The property that matters most: an edited plan is held to exactly the rules a
 * planned one is. So every edit below is pushed through the REAL validator and
 * compiler, not just inspected, and the compiled parameter count is checked
 * against the $n placeholders -- the check that caught `combine` binding three
 * parameters for two.
 *
 * Run: node backend/test_followup.js
 */

const assert = require("node:assert");
const {
  applyEdit, availableFollowups, parseQuickEdit, validateUserSeries,
  withUserSeries, rewriteFollowUp, FollowUpError, MAX_USER_ROWS,
} = require("./followup");
const { validatePlan } = require("./planner/validate");
const { compilePlan } = require("./planner/compile");

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
  }));
}

// --- fixtures ---------------------------------------------------------------

const VALUE = (id) => ({ attr_id: id, source_kind: "acs_long", census_code: `C_${id}`, description: id });
const FEATURE = (id) => ({ attr_id: id, source_kind: "feature_table", table_name: `t_${id}`,
                           geom_column: "geom", label_columns: ["name", "city", "state"], filter_values: {} });
const FEATURE_IDS = new Set(["hosp", "fire"]);
const resolve = async (ids) => new Map(ids.map(id => [id, FEATURE_IDS.has(id) ? FEATURE(id) : VALUE(id)]));
const ctx = {
  label: (id) => `label(${id})`,
  kindOf: (id) => (FEATURE_IDS.has(id) ? "feature" : "value"),
  hasNeighbors: true,
};

const LOAD = {
  intent: "Median household income by county", output_type: "map", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "load", attr_id: "inc", inputs: [] },
    { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
  ],
};
const MISSOURI = {
  intent: "Median household income for Missouri counties", output_type: "map", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "load", attr_id: "inc", inputs: [] },
    { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
    { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
  ],
};
const TOP10 = {
  intent: "Top ten", output_type: "table", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "load", attr_id: "inc", inputs: [] },
    { id: "s2", op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 10 },
    { id: "s3", op: "output", attr_id: "", inputs: ["s2"] },
  ],
};
const JOIN = {
  intent: "Income and poverty", output_type: "chart", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "load", attr_id: "inc", inputs: [] },
    { id: "s2", op: "load", attr_id: "pov", inputs: [] },
    { id: "s3", op: "join", attr_id: "", inputs: ["s1", "s2"] },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
  ],
};
const CORR = {
  intent: "Obesity and diabetes", output_type: "statistics", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "load", attr_id: "obe", inputs: [] },
    { id: "s2", op: "load", attr_id: "dia", inputs: [] },
    { id: "s3", op: "correlate", attr_id: "", inputs: ["s1", "s2"] },
    { id: "s4", op: "output", attr_id: "", inputs: ["s3"] },
  ],
};
const FEATURES = {
  intent: "Fire stations in Springfield", output_type: "map", entity_type: "COUNTY",
  steps: [
    { id: "s1", op: "select_features", attr_id: "fire", inputs: [], city: "Springfield", states: ["Missouri"] },
    { id: "s2", op: "output", attr_id: "", inputs: ["s1"] },
  ],
};

/** Validate AND compile, and check every statement binds what it references. */
async function mustRun(plan, resolver = resolve) {
  const v = await validatePlan(JSON.parse(JSON.stringify(plan)), resolver);
  assert.ok(v.ok, `edited plan did not validate: ${v.errors.join(" | ")}`);
  const compiled = compilePlan(plan, v.resolved);
  for (const out of compiled.outputs) {
    const used = new Set((out.sql.match(/\$\d+/g) || []));
    assert.strictEqual(used.size, out.params.length,
      `output ${out.id}: SQL references ${used.size} parameters, binds ${out.params.length}`);
  }
  return compiled;
}

const ops = (plan) => plan.steps.map(s => s.op).join(" -> ");

// --- recognising edits in free text ------------------------------------------

test("a place-only follow-up is an area edit", () => {
  assert.deepStrictEqual(parseQuickEdit("what about Texas?"), { kind: "restrict_area", states: ["Texas"] });
  const two = parseQuickEdit("same for Kansas and Missouri");
  assert.strictEqual(two.kind, "restrict_area");
  assert.deepStrictEqual([...two.states].sort(), ["Kansas", "Missouri"]);
  assert.deepStrictEqual(parseQuickEdit("now the Midwest"), { kind: "restrict_area", states: ["Midwest"] });
  assert.deepStrictEqual(parseQuickEdit("what about TX"), { kind: "restrict_area", states: ["Texas"] });
});

test("anything with content beyond a place goes to the model", () => {
  assert.strictEqual(parseQuickEdit("Texas hospitals"), null);
  assert.strictEqual(parseQuickEdit("compare with Texas"), null);
  // "county" is not filler: this is a county, not the state.
  assert.strictEqual(parseQuickEdit("what about Washington County"), null);
  assert.strictEqual(parseQuickEdit("what about the south side of town"), null);
});

test("'OK' is an acknowledgement, not Oklahoma", () => {
  assert.strictEqual(parseQuickEdit("OK"), null);
  assert.strictEqual(parseQuickEdit("ok"), null);
});

test("rank phrases become rank edits", () => {
  assert.deepStrictEqual(parseQuickEdit("top 10"), { kind: "rank", direction: "desc", limit: 10 });
  assert.deepStrictEqual(parseQuickEdit("show me the bottom 5 counties"), { kind: "rank", direction: "asc", limit: 5 });
  assert.deepStrictEqual(parseQuickEdit("lowest 20?"), { kind: "rank", direction: "asc", limit: 20 });
  assert.strictEqual(parseQuickEdit("top 10 hospitals"), null);
});

test("the whole country clears the area", () => {
  for (const t of ["the whole country", "nationally", "show all counties", "everywhere"]) {
    assert.deepStrictEqual(parseQuickEdit(t), { kind: "clear_area" }, t);
  }
});

// --- edits: structure, and that the result runs ------------------------------

test("restrict_area inserts a filter after the leaf and runs", async () => {
  const { plan, note } = applyEdit(LOAD, { kind: "restrict_area", states: ["Texas"] }, ctx);
  assert.strictEqual(ops(plan), "load -> filter_area -> output");
  assert.match(note, /Texas/);
  assert.match(plan.intent, /· in Texas$/);
  await mustRun(plan);
});

test("the original plan is never mutated", () => {
  const before = JSON.stringify(LOAD);
  applyEdit(LOAD, { kind: "restrict_area", states: ["Texas"] }, ctx);
  applyEdit(LOAD, { kind: "rank", direction: "desc", limit: 5 }, ctx);
  assert.strictEqual(JSON.stringify(LOAD), before);
});

test("restrict_area replaces an existing area rather than stacking", async () => {
  const { plan } = applyEdit(MISSOURI, { kind: "restrict_area", states: ["Ohio"] }, ctx);
  assert.strictEqual(plan.steps.filter(s => s.op === "filter_area").length, 1);
  assert.deepStrictEqual(plan.steps.find(s => s.op === "filter_area").states, ["Ohio"]);
  await mustRun(plan);
});

test("a second area edit replaces the first in the title", () => {
  const a = applyEdit(LOAD, { kind: "restrict_area", states: ["Texas"] }, ctx).plan;
  const b = applyEdit(a, { kind: "restrict_area", states: ["Ohio"] }, ctx).plan;
  assert.strictEqual(b.intent, "Median household income by county · in Ohio");
});

test("an area change rewrites the place the title names, not appends to it", () => {
  // Measured in the UI: appending read "... for Missouri counties · in Texas".
  const title = (intent, states, e) => {
    const plan = { intent, steps: [
      { id: "s1", op: "load", attr_id: "inc", inputs: [] },
      ...(states ? [{ id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states }] : []),
      { id: "s3", op: "output", attr_id: "", inputs: [states ? "s2" : "s1"] }] };
    return applyEdit(plan, e, ctx).plan.intent;
  };
  const tx = { kind: "restrict_area", states: ["Texas"] };
  assert.strictEqual(title("Median household income for Missouri counties", ["Missouri"], tx),
    "Median household income for Texas counties");
  assert.strictEqual(title("Poverty rate in the Midwest", ["Midwest"], { kind: "restrict_area", states: ["Ohio", "Indiana"] }),
    "Poverty rate in Ohio, Indiana");
  assert.strictEqual(title("Poverty rate in Ohio", ["Ohio"], { kind: "restrict_area", states: ["South"] }),
    "Poverty rate in the South");
  assert.strictEqual(title("Median household income for Missouri counties", ["Missouri"], { kind: "clear_area" }),
    "Median household income for all US counties");
  assert.strictEqual(title("Poverty rate for counties in Kansas and Missouri", ["Kansas", "Missouri"], { kind: "clear_area" }),
    "Poverty rate for all counties");
  // No place in the title: append rather than guess where it would go.
  assert.strictEqual(title("Poverty rate by county", null, tx), "Poverty rate by county · in Texas");
});

test("restrict_area on a correlation filters BOTH inputs", async () => {
  const { plan } = applyEdit(CORR, { kind: "restrict_area", states: ["Texas"] }, ctx);
  assert.strictEqual(plan.steps.filter(s => s.op === "filter_area").length, 2);
  const corr = plan.steps.find(s => s.op === "correlate");
  for (const input of corr.inputs) {
    assert.strictEqual(plan.steps.find(s => s.id === input).op, "filter_area");
  }
  await mustRun(plan);
});

test("restrict_area on features sets the state and drops a city from another state", async () => {
  const { plan, note } = applyEdit(FEATURES, { kind: "restrict_area", states: ["Texas"] }, ctx);
  const st = plan.steps[0];
  assert.deepStrictEqual(st.states, ["Texas"]);
  assert.strictEqual(st.city, undefined);
  assert.match(note, /Springfield/);
  await mustRun(plan);
});

test("narrowing an ambiguous city keeps the city", async () => {
  const { plan } = applyEdit(FEATURES, { kind: "restrict_area", states: ["Ohio"], keep_city: true }, ctx);
  assert.strictEqual(plan.steps[0].city, "Springfield");
  assert.deepStrictEqual(plan.steps[0].states, ["Ohio"]);
  await mustRun(plan);
});

test("map_measure needs no earlier plan", async () => {
  const { plan } = applyEdit(null, { kind: "map_measure", attr_id: "pov" }, ctx);
  assert.strictEqual(ops(plan), "load -> output");
  assert.strictEqual(plan.intent, "label(pov) by county");
  await mustRun(plan);
});

test("unknown places are refused with the name", () => {
  assert.throws(() => applyEdit(LOAD, { kind: "restrict_area", states: ["Atlantis"] }, ctx),
    (e) => e instanceof FollowUpError && /Atlantis/.test(e.message));
});

test("clear_area removes the restriction and runs", async () => {
  const { plan } = applyEdit(MISSOURI, { kind: "clear_area" }, ctx);
  assert.strictEqual(ops(plan), "load -> output");
  await mustRun(plan);
  assert.throws(() => applyEdit(LOAD, { kind: "clear_area" }, ctx), FollowUpError);
});

test("rank inserts once, then updates in place", async () => {
  const a = applyEdit(LOAD, { kind: "rank", direction: "desc", limit: 10 }, ctx).plan;
  assert.strictEqual(ops(a), "load -> rank -> output");
  const b = applyEdit(a, { kind: "rank", direction: "asc", limit: 5 }, ctx).plan;
  assert.strictEqual(b.steps.filter(s => s.op === "rank").length, 1);
  assert.strictEqual(b.steps.find(s => s.op === "rank").direction, "asc");
  await mustRun(b);
});

test("rank refuses a two-measure result instead of silently dropping one", () => {
  assert.throws(() => applyEdit(JOIN, { kind: "rank", direction: "desc", limit: 10 }, ctx),
    (e) => /second measure/.test(e.message));
  assert.throws(() => applyEdit(CORR, { kind: "rank", direction: "desc", limit: 10 }, ctx), FollowUpError);
});

test("remove_step undoes a rank", async () => {
  const { plan } = applyEdit(TOP10, { kind: "remove_step", step_id: "s2" }, ctx);
  assert.strictEqual(ops(plan), "load -> output");
  await mustRun(plan);
  assert.throws(() => applyEdit(TOP10, { kind: "remove_step", step_id: "s1" }, ctx), FollowUpError);
});

test("swap_measure replaces the attribute everywhere it is cited", async () => {
  const { plan } = applyEdit(MISSOURI, { kind: "swap_measure", from: "inc", to: "pov" }, ctx);
  assert.strictEqual(plan.steps[0].attr_id, "pov");
  assert.match(plan.intent, /using label\(pov\)/);
  await mustRun(plan);
  assert.throws(() => applyEdit(LOAD, { kind: "swap_measure", from: "nope", to: "pov" }, ctx), FollowUpError);
});

test("add_measure compare joins a second series and carries both", async () => {
  const { plan } = applyEdit(MISSOURI, { kind: "add_measure", attr_id: "pov", mode: "compare" }, ctx);
  assert.strictEqual(ops(plan), "load -> filter_area -> load -> join -> output");
  const compiled = await mustRun(plan);
  assert.strictEqual(compiled.series, 2);
});

test("add_measure correlate runs over the series BEFORE any ranking", async () => {
  const { plan } = applyEdit(TOP10, { kind: "add_measure", attr_id: "pov", mode: "correlate" }, ctx);
  const corr = plan.steps.find(s => s.op === "correlate");
  assert.strictEqual(corr.inputs[0], "s1", "correlate must read the unranked series");
  assert.strictEqual(plan.output_type, "statistics");
  await mustRun(plan);
});

test("add_measure refuses a layer of locations", () => {
  assert.throws(() => applyEdit(LOAD, { kind: "add_measure", attr_id: "hosp", mode: "compare" }, ctx),
    (e) => /locations/.test(e.message));
});

test("add_stat inserts hotspot, switches to outlier, refuses a ranked series", async () => {
  const a = applyEdit(LOAD, { kind: "add_stat", op: "hotspot" }, ctx).plan;
  assert.strictEqual(ops(a), "load -> hotspot -> output");
  await mustRun(a);
  const b = applyEdit(a, { kind: "add_stat", op: "outlier" }, ctx).plan;
  assert.strictEqual(ops(b), "load -> outlier -> output");
  await mustRun(b);
  assert.throws(() => applyEdit(TOP10, { kind: "add_stat", op: "hotspot" }, ctx), /ranking/);
  assert.throws(() => applyEdit(LOAD, { kind: "add_stat", op: "hotspot" }, { ...ctx, hasNeighbors: false }),
    /adjacency/);
});

test("map_measure starts fresh but keeps the area", async () => {
  const { plan } = applyEdit(MISSOURI, { kind: "map_measure", attr_id: "pov" }, ctx);
  assert.strictEqual(ops(plan), "load -> filter_area -> output");
  assert.deepStrictEqual(plan.steps[1].states, ["Missouri"]);
  await mustRun(plan);
  const f = applyEdit(MISSOURI, { kind: "map_measure", attr_id: "hosp" }, ctx).plan;
  assert.strictEqual(ops(f), "select_features -> output");
  assert.deepStrictEqual(f.steps[0].states, ["Missouri"]);
  await mustRun(f);
});

test("an unknown edit kind is refused", () => {
  assert.throws(() => applyEdit(LOAD, { kind: "drop_table" }, ctx), FollowUpError);
  assert.throws(() => applyEdit(null, { kind: "rank" }, ctx), FollowUpError);
});

// --- user data -----------------------------------------------------------------

const USER = { id: "u1", name: "Clinic visits per 1k", file: "clinics.csv",
               fips: ["29001", "29003", "29005"], values: [1.5, null, "2"] };

test("a well-formed upload becomes an inline source", () => {
  const { sources, errors } = validateUserSeries([USER]);
  assert.deepStrictEqual(errors, []);
  const src = sources.get("user:u1");
  assert.strictEqual(src.source_kind, "inline");
  assert.deepStrictEqual(src.values, [1.5, null, 2]);
});

test("bad uploads are refused with the reason", () => {
  const bad = (patch) => validateUserSeries([{ ...USER, ...patch }]).errors.join(" ");
  assert.match(bad({ fips: ["2901", "29003", "29005"] }), /five digits/);
  assert.match(bad({ fips: ["29001", "29001", "29005"] }), /more than once/);
  assert.match(bad({ values: [1, "abc", 2] }), /not a number/);
  assert.match(bad({ values: [1, 2] }), /equal length/);
  assert.match(bad({ id: "x; DROP" }), /not valid/);
  const big = Array.from({ length: MAX_USER_ROWS + 1 }, (_, i) => String(10000 + i).padStart(5, "0"));
  assert.match(bad({ fips: big, values: big.map(() => 1) }), /limit/);
  assert.match(validateUserSeries([USER, USER, USER]).errors.join(" "), /at most/);
});

test("a plan can only cite uploads sent with the request", async () => {
  const { sources } = validateUserSeries([USER]);
  const r = withUserSeries(resolve, sources);
  const got = await r(["user:u1", "user:u2", "inc"]);
  assert.ok(got.has("user:u1"));
  assert.ok(!got.has("user:u2"), "an upload that was not sent must not resolve");
  assert.ok(got.has("inc"));
});

test("user data compiles to bound arrays, correlates, and never touches a table", async () => {
  const { sources } = validateUserSeries([USER]);
  const r = withUserSeries(resolve, sources);
  const { plan } = applyEdit(LOAD, { kind: "add_measure", attr_id: "user:u1", mode: "correlate" }, ctx);
  const compiled = await mustRun(plan, r);
  assert.match(compiled.sql, /unnest\(\$\d+::char\(5\)\[\], \$\d+::float8\[\]\)/);
  assert.ok(compiled.params.some(p => Array.isArray(p) && p.includes("29001")));
  assert.ok(!/29001/.test(compiled.sql), "user values must be bound, not interpolated");
});

// --- what the UI is offered -------------------------------------------------------

test("offers follow a per-county series", () => {
  const f = availableFollowups(LOAD, { candidates: [{ attr_id: "inc", attr_desc: "Income" },
                                                    { attr_id: "pov", attr_desc: "Poverty" }] });
  assert.ok(f.can.rank && f.can.hotspot && f.can.outlier && f.can.compare && f.can.correlate && f.can.restrict_area);
  assert.ok(!f.can.clear_area && !f.can.add_factor);
  assert.deepStrictEqual(f.in_use.map(u => u.attr_id), ["inc"]);
  assert.deepStrictEqual(f.alternatives.map(a => a.attr_id), ["pov"]);
});

test("a correlation is not offered a rank or a second measure", () => {
  const f = availableFollowups(CORR, {});
  assert.ok(!f.can.rank && !f.can.compare && !f.can.hotspot);
  assert.ok(f.can.restrict_area);
});

test("filters and ranks are offered for removal, by name", () => {
  const f = availableFollowups(MISSOURI, {});
  assert.deepStrictEqual(f.removable, [{ step_id: "s2", op: "filter_area", label: "Missouri" }]);
  assert.ok(f.can.clear_area);
  const t = availableFollowups(TOP10, {});
  assert.strictEqual(t.removable[0].label, "top 10");
});

// --- rewriting free text -----------------------------------------------------------

test("with no history the text runs as typed, without a model call", async () => {
  let called = false;
  const out = await rewriteFollowUp({ text: "poverty in Ohio", history: [], callLLM: async () => { called = true; } });
  assert.deepStrictEqual(out, { question: "poverty in Ohio", rewritten: false });
  assert.ok(!called);
});

test("a rewrite is returned and flagged as one", async () => {
  const out = await rewriteFollowUp({
    text: "and unemployment?",
    history: [{ query: "poverty rate in Ohio", intent: "Poverty rate for Ohio counties" }],
    callLLM: async () => JSON.stringify({ question: "poverty rate and unemployment rate in Ohio" }),
  });
  assert.strictEqual(out.rewritten, true);
  assert.strictEqual(out.question, "poverty rate and unemployment rate in Ohio");
});

test("a failed or empty rewrite falls back to the text, and says so", async () => {
  for (const reply of [null, "", "not json", JSON.stringify({ question: "" }),
                       JSON.stringify({ question: "x".repeat(500) })]) {
    const out = await rewriteFollowUp({
      text: "and unemployment?", history: [{ query: "q" }], callLLM: async () => reply,
    });
    assert.strictEqual(out.question, "and unemployment?");
    assert.strictEqual(out.rewritten, false);
    assert.ok(out.note);
  }
});

test("a complete, unrelated question skips the model and runs as typed", async () => {
  // Measured: gemma3:4b added "Ohio" to this after an Ohio question, 3 of 3.
  let called = false;
  const out = await rewriteFollowUp({
    text: "how far is each county from the nearest airport",
    history: [{ query: "poverty rate in Ohio" }],
    callLLM: async () => { called = true; return JSON.stringify({ question: "airports in Ohio" }); },
  });
  assert.ok(!called, "a standalone question must not reach the model");
  assert.strictEqual(out.question, "how far is each county from the nearest airport");
  assert.strictEqual(out.standalone, true);
});

test("continuations are recognised by shape, not by a list of topics", () => {
  const { isContinuation } = require("./followup");
  for (const t of ["and within 5 miles?", "what about fire stations?", "is it related to diabetes?",
                   "compare it with educational attainment", "Texas hospitals", "same for 2020"]) {
    assert.ok(isContinuation(t), t);
  }
  for (const t of ["how far is each county from the nearest airport",
                   "show the unemployment rate for counties in Kansas"]) {
    assert.ok(!isContinuation(t), t);
  }
});

test("a rewrite that drops a word the user typed is discarded", async () => {
  // Measured: "Texas hospitals" -> "What is the poverty rate by Texas county?", 3 of 3.
  const out = await rewriteFollowUp({
    text: "Texas hospitals", history: [{ query: "poverty rate by county" }],
    callLLM: async () => JSON.stringify({ question: "What is the poverty rate by Texas county?" }),
  });
  assert.strictEqual(out.question, "Texas hospitals");
  assert.strictEqual(out.rewritten, false);
  assert.match(out.note, /hospitals/);
});

test("rephrasing is not dropping: plurals, number words and function words pass", () => {
  const { droppedWords } = require("./followup");
  assert.deepStrictEqual(droppedWords("and within 5 miles?", "hospitals within five miles of a transmission line"), []);
  assert.deepStrictEqual(droppedWords("what about fire stations?", "How many fire stations are in each county?"), []);
  assert.deepStrictEqual(droppedWords("where does it cluster?", "Where does the poverty rate cluster?"), []);
  assert.deepStrictEqual(droppedWords("and police stations?", "What about police?"), ["station"].map(w => `${w}s`));
});

test("a state list is never abbreviated into something a model could guess at", () => {
  // Regression: "Alabama, Arkansas and 14 more" in a title was copied into a
  // rewrite, and the planner guessed the 14 wrong.
  const { describeAreas } = require("./followup");
  const SOUTH = ["Alabama", "Arkansas", "Delaware", "District of Columbia", "Florida", "Georgia",
    "Kentucky", "Louisiana", "Maryland", "Mississippi", "North Carolina", "Oklahoma",
    "South Carolina", "Tennessee", "Texas", "Virginia", "West Virginia"];
  assert.strictEqual(describeAreas(SOUTH), "the South");
  assert.strictEqual(describeAreas(["Midwest"]), "the Midwest");
  assert.strictEqual(describeAreas(SOUTH.slice(0, 16)), "16 states");
  assert.ok(!/more/.test(describeAreas(SOUTH.slice(0, 16))));
});

test("the rewrite is given the exact area, and an abbreviated list is discarded", async () => {
  const { rewritePrompt, areaOf } = require("./followup");
  assert.deepStrictEqual(areaOf(MISSOURI), ["Missouri"]);
  assert.strictEqual(areaOf(LOAD), null);
  assert.match(rewritePrompt([{ query: "q" }], "normalize by population", ["Alabama", "Texas"]),
    /restricted to: Alabama, Texas/);
  const out = await rewriteFollowUp({
    text: "normalize by population", history: [{ query: "q" }], area: ["Alabama"],
    callLLM: async () => JSON.stringify({ question: "normalize by population across Alabama, Arkansas and 14 more" }),
  });
  assert.strictEqual(out.rewritten, false);
  assert.match(out.note, /abbreviated/);
});

test("an operation-only follow-up keeps the measure on screen", async () => {
  // Regression: "normalize by population" on a South cancer result became
  // "normalize Alabama, ... by population" and planned population alone.
  const { namesNewMeasure, primaryAttr } = require("./followup");
  assert.ok(!namesNewMeasure("normalize by population"));
  assert.ok(!namesNewMeasure("per square mile in Texas"));
  assert.ok(namesNewMeasure("what about fire stations?"));
  assert.strictEqual(primaryAttr(MISSOURI), "inc");
  const out = await rewriteFollowUp({
    text: "normalize by population", history: [{ query: "q" }],
    area: ["Alabama", "Texas"], measure: "Cancer among adults",
    callLLM: async () => JSON.stringify({ question: "normalize Alabama, Texas by population?" }),
  });
  assert.match(out.question, /Cancer among adults/);
  assert.match(out.question, /Alabama, Texas/);
  assert.match(out.note, /measure/);
  // A rewrite that kept the measure is left alone.
  const kept = await rewriteFollowUp({
    text: "normalize by population", history: [{ query: "q" }], measure: "Cancer among adults",
    callLLM: async () => JSON.stringify({ question: "cancer among adults normalized by population" }),
  });
  assert.strictEqual(kept.question, "cancer among adults normalized by population");
});

test("a discarded rewrite of an operation falls back to the measure and area, not bare text", async () => {
  // Regression: the rewrite said "per capita" for "normalize", the dropped-word
  // guard discarded it, and "normalize by population" ran alone -- population
  // by census tract, nothing about cancer or the South.
  const out = await rewriteFollowUp({
    text: "normalize by population", history: [{ query: "q" }],
    area: ["South"], measure: "Cancer among adults",
    callLLM: async () => JSON.stringify({ question: "cancer among adults per capita in the South" }),
  });
  assert.strictEqual(out.question, "Cancer among adults: normalize by population in the South");
  assert.match(out.note, /normalize/);
  // A follow-up that names its own measure still runs as typed.
  const own = await rewriteFollowUp({
    text: "Texas hospitals", history: [{ query: "q" }], measure: "Poverty rate",
    callLLM: async () => JSON.stringify({ question: "poverty rate by Texas county" }),
  });
  assert.strictEqual(own.question, "Texas hospitals");
});

(async () => {
  for (const p of pending) await p();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
