/**
 * Composite index (docs/GIS_OPS_PLAN.md H6 tier 1, item 4): the phrasing
 * gate, the four weight tiers (stated shares, stated ratios / AHP, emphasis,
 * equal), directions, method, standardization, the place-filter move,
 * validation and compilation. No model or database; the SQL is checked
 * against an independent Python computation on the live DB in
 * eval/gis_ops/composite/.
 * Run: node backend/planner/test_composite.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const C = require("./composite");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const SRC = new Map([
  ["POV", { source_kind: "acs_long", census_code: "PCTPOVALL", description: "Poverty rate, all ages" }],
  ["UNINS", { source_kind: "acs_long", census_code: "UNINS", description: "Percent of adults without health insurance" }],
  ["INC", { source_kind: "acs_long", census_code: "MEDHHINC", description: "Median household income" }],
  ["TRANSIT", { source_kind: "acs_long", census_code: "TRANSIT", description: "Workers commuting by public transportation" }],
  ["RENT", { source_kind: "acs_long", census_code: "RENT", description: "Rent burden: rent 30 percent or more of income" }],
  ["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom", label_columns: ["name"] }],
]);
const NAMES = { POV: "Poverty rate", UNINS: "Adults without health insurance", INC: "Median household income",
  TRANSIT: "Public transportation commuters", RENT: "Rent burden", HOSP: "Hospitals" };
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const load = (id, attr) => ({ id, op: "load", attr_id: attr, inputs: [] });
const near = (id, attr = "HOSP") => ({ id, op: "nearest_distance", attr_id: attr, inputs: [] });
const comp = (id, inputs, extra = {}) => ({ id, op: "composite", attr_id: "", inputs, ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const deps = (phrases = {}) => ({
  info: (id) => ({ name: NAMES[id], text: `${NAMES[id]} ${SRC.get(id)?.description || ""}` }),
  // The relevance check's quoted phrase: what ties "uninsured" to a measure
  // whose name says "without health insurance".
  phrasesOf: (id) => phrases[id] || (id === "UNINS" ? ["uninsured"] : []),
});
const inputsOf = (p, phrases) => {
  const byId = new Map(p.steps.map(s => [s.id, s]));
  return C.describeInputs(p.steps.find(s => s.op === "composite"), byId, deps(phrases));
};
const near1 = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
function paramsMatch(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
}

const P3 = () => plan(load("s1", "POV"), load("s2", "UNINS"), near("s3"), comp("s4", ["s1", "s2", "s3"]), out("s5", "s4"));

(async () => {
  await test("gate: lists of criteria, composite words, stated weights", () => {
    for (const q of [
      "rank Missouri counties by poverty, uninsured rate and distance to the nearest hospital",
      "build a composite index of poverty and unemployment for Ohio counties",
      "which counties are most vulnerable based on poverty, lack of insurance and age over 65",
      "a vulnerability score combining poverty and rent burden",
      "weight proximity to transit at 50%, poverty at 30%, and rent burden at 20%",
      "make flood risk twice as important as income",
      "score tracts in Illinois using median income, unemployment and no-vehicle households",
      "prioritize counties considering obesity, diabetes, and physical inactivity",
    ]) assert.ok(C.asksComposite(q), q);
  });

  await test("gate: one measure, two shown side by side, a published composite, thresholds", () => {
    for (const q of [
      "rank counties by poverty rate",
      "show me population and poverty rates",
      "show fema national risk index composite risk value (dollars) by county",
      "counties where poverty is above 20% and unemployment above 6%",
      "what is the correlation between income and diabetes",
      "difference between the poverty rate and the unemployment rate",
      "which counties have the highest rates of poverty and unemployment",
      "how many hospitals are in each county by state",
      "rank counties by state and county",
      "What are the poverty rates around Detroit?",
    ]) assert.ok(!C.asksComposite(q), q);
  });

  await test("op is offered only on the gate, snapshot contexts never see it", () => {
    assert.ok(ops.offeredFor({ query: "rank counties by poverty, income and unemployment" }).includes("composite"));
    assert.ok(!ops.offeredFor({ query: "rank counties by poverty" }).includes("composite"));
    assert.ok(!ops.offeredFor({}).includes("composite"));
  });

  await test("weights tier 4: equal by default", () => {
    const w = C.readWeights("rank counties by poverty, uninsured rate and distance to the nearest hospital", inputsOf(P3()));
    assert.strictEqual(w.how, "equal");
    assert.ok(w.weights.every(x => near1(x, 1 / 3)));
  });

  await test("weights tier 1: stated percentages, matched by words", () => {
    const p = plan(load("s1", "TRANSIT"), load("s2", "POV"), load("s3", "RENT"), comp("s4", ["s1", "s2", "s3"]), out("s5", "s4"));
    const q = "weight proximity to transit at 50%, poverty at 30%, and rent burden at 20%";
    const w = C.readWeights(q, inputsOf(p, { TRANSIT: ["proximity to transit"] }));
    assert.strictEqual(w.how, "stated");
    assert.deepStrictEqual(w.weights.map(x => Math.round(x * 100)), [50, 30, 20]);
  });

  await test("weights tier 1: shares that do not total 100 are rescaled, and said so", () => {
    const q = "an index weighting poverty 60%, uninsured 60% and hospital distance 30%";
    const w = C.readWeights(q, inputsOf(P3()));
    assert.ok(near1(w.weights[0], 0.4) && near1(w.weights[2], 0.2));
    assert.ok(w.notes.some(n => /rescaled/.test(n)));
  });

  await test("weights tier 1: a threshold percentage is not a weight", () => {
    const q = "rank counties with poverty above 20% by poverty, uninsured rate and distance to a hospital, weighted equally";
    const w = C.readWeights(q, inputsOf(P3()));
    assert.strictEqual(w.how, "equal");
  });

  await test("weights tier 1: an unmatched stated weight falls back to equal, loudly", () => {
    const q = "weight crime at 50%, poverty at 25% and uninsured at 25%";
    const w = C.readWeights(q, inputsOf(P3()));
    assert.strictEqual(w.how, "equal");
    assert.ok(w.notes.some(n => /not applied/.test(n)));
  });

  await test("weights tier 1: a ratio, 'twice as important as'", () => {
    const p = plan(load("s1", "POV"), load("s2", "INC"), comp("s3", ["s1", "s2"]), out("s4", "s3"));
    const w = C.readWeights("an index where poverty is twice as important as income", inputsOf(p));
    assert.ok(near1(w.weights[0], 2 / 3) && near1(w.weights[1], 1 / 3), JSON.stringify(w));
  });

  await test("weights tier 1: 'double weight on X' against the rest", () => {
    const w = C.readWeights("score counties by poverty, uninsured and hospital distance, with double weight on hospital distance",
      inputsOf(P3()));
    assert.deepStrictEqual(w.weights.map(x => Math.round(x * 100)), [25, 25, 50]);
  });

  await test("AHP: consistent pairwise judgments recover the weights, CR 0", () => {
    // w = 4 : 2 : 1
    const r = C.ahpWeights(3, [{ a: 0, b: 1, r: 2 }, { a: 1, b: 2, r: 2 }, { a: 0, b: 2, r: 4 }]);
    assert.ok(near1(r.weights[0], 4 / 7) && near1(r.weights[2], 1 / 7));
    assert.ok(near1(r.cr, 0));
  });

  await test("AHP: inconsistent judgments are flagged (CR >= 0.10)", () => {
    const r = C.ahpWeights(3, [{ a: 0, b: 1, r: 5 }, { a: 1, b: 2, r: 5 }, { a: 2, b: 0, r: 5 }]);
    assert.ok(r.cr > 0.1, String(r.cr));
  });

  await test("weights tier 2: emphasis is 2 to 1", () => {
    const q = "rank counties focusing primarily on poverty, while also considering uninsured adults and hospital distance";
    const w = C.readWeights(q, inputsOf(P3()));
    assert.strictEqual(w.how, "emphasis");
    assert.deepStrictEqual(w.weights.map(x => Math.round(x * 100)), [50, 25, 25]);
  });

  await test("data-driven weights are not guessed: noted, equal used", () => {
    const w = C.readWeights("rank counties by poverty, uninsured and hospital distance using entropy weights", inputsOf(P3()));
    assert.strictEqual(w.how, "equal");
    assert.ok(w.notes.some(n => /entropy/.test(n)));
  });

  await test("directions: high by default, 'low income' flips, a cue never crosses 'and'", () => {
    const p = plan(load("s1", "POV"), load("s2", "INC"), load("s3", "UNINS"), comp("s4", ["s1", "s2", "s3"]), out("s5", "s4"));
    assert.deepStrictEqual(C.readDirections("most vulnerable counties by high poverty, low income and uninsured adults", inputsOf(p)),
      ["high", "low", "high"]);
    assert.deepStrictEqual(C.readDirections("rank counties by low poverty and income and uninsured adults", inputsOf(p)),
      ["low", "high", "high"]);
  });

  await test("directions: a negation naming the measure is not a cue; on a count it is", () => {
    // "adults without health insurance" IS the uninsured rate (dry run, 2026-11-21).
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"]), out("s4", "s3"));
    const ins = inputsOf(p, { UNINS: [] });
    assert.deepStrictEqual(C.readDirections("an index of the poverty rate and the share of adults without health insurance", ins),
      ["high", "high"]);
    // A cue word inside the measure's own name ("Low birth weight") stays the name.
    const lbw = C.describeInputs({ inputs: ["s1"] }, new Map([["s1", load("s1", "LBW")]]),
      { info: () => ({ name: "Low birth weight", text: "Low birth weight births (percent)" }) });
    assert.deepStrictEqual(C.readDirections("rank counties by low birth weight, poverty and obesity", lbw), ["high"]);
    // On a count, "without" / "lack of" flip it.
    const cnt = plan(load("s1", "POV"), { id: "s2", op: "count_features", attr_id: "HOSP", inputs: [] },
      comp("s3", ["s1", "s2"]), out("s4", "s3"));
    assert.deepStrictEqual(C.readDirections("score counties on poverty and a lack of hospitals", inputsOf(cnt)), ["high", "low"]);
  });

  await test("directions: distance reads near vs far", () => {
    assert.deepStrictEqual(C.readDirections("rank counties by poverty, uninsured and distance to the nearest hospital", inputsOf(P3())),
      ["high", "high", "high"]);
    assert.deepStrictEqual(C.readDirections("best counties: low poverty, low uninsured rate and close to a hospital", inputsOf(P3())),
      ["low", "low", "low"]);
    assert.deepStrictEqual(C.readDirections("most underserved: poverty, uninsured adults and lack of access to hospitals", inputsOf(P3())),
      ["high", "high", "high"]);
  });

  await test("method: compensatory by default, geometric, bottleneck", () => {
    assert.strictEqual(C.readMethod("rank counties by poverty, income and unemployment"), "sum");
    assert.strictEqual(C.readMethod("a geometric mean of poverty, income and unemployment"), "geometric");
    assert.strictEqual(C.readMethod("an index of A, B and C where a high A cannot compensate for a low B"), "minimum");
    assert.strictEqual(C.readMethod("counties that are bad on all three of poverty, income and unemployment"), "minimum");
    assert.strictEqual(C.readMethod("treat it as a bottleneck: the weakest factor decides"), "minimum");
  });

  await test("standardize: percentile by default, z-score, min-max", () => {
    assert.strictEqual(C.readStandardize("rank by A, B and C"), "percentile");
    assert.strictEqual(C.readStandardize("sum of z-scores of A, B and C"), "zscore");
    assert.strictEqual(C.readStandardize("rescale A, B and C to 0 to 1 and add them"), "minmax");
  });

  await test("apply: fields set, echo names every input with its weight and direction", () => {
    const p = P3();
    const r = C.applyComposite(p, "rank counties by poverty, uninsured rate and distance to the nearest hospital", deps());
    const c = p.steps.find(s => s.op === "composite");
    assert.deepStrictEqual(c.directions, ["high", "high", "high"]);
    assert.strictEqual(c.method, "sum");
    assert.strictEqual(c.standardize, "percentile");
    assert.ok(/Poverty rate 33.3% \(higher scores higher\)/.test(r.fixes[0]), r.fixes[0]);
    assert.ok(/distance to the nearest Hospitals/.test(r.fixes[0]), r.fixes[0]);
  });

  await test("apply: geometric over z-scores falls back to percentile, and says so", () => {
    const p = P3();
    const r = C.applyComposite(p, "a multiplicative index of z-scores of poverty, uninsured and hospital distance", deps());
    const c = p.steps.find(s => s.op === "composite");
    assert.strictEqual(c.method, "geometric");
    assert.strictEqual(c.standardize, "percentile");
    assert.ok(r.notes.some(n => /non-negative/.test(n)));
  });

  await test("place filter after the composite moves onto its first input", () => {
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"]),
      { id: "s4", op: "filter_area", attr_id: "", inputs: ["s3"], states: ["Missouri"] },
      { id: "s5", op: "rank", attr_id: "", inputs: ["s4"], direction: "desc", limit: 10 }, out("s6", "s5"));
    const fix = C.scoreWithinArea(p, "the 10 most vulnerable Missouri counties by poverty and uninsured rate, as a score");
    assert.ok(fix);
    const ids = p.steps.map(s => s.id);
    assert.deepStrictEqual(ids, ["s1", "s2", "s4", "s3", "s5", "s6"]);
    assert.deepStrictEqual(p.steps.find(s => s.id === "s4").inputs, ["s1"]);
    assert.deepStrictEqual(p.steps.find(s => s.id === "s3").inputs, ["s4", "s2"]);
    assert.deepStrictEqual(p.steps.find(s => s.id === "s5").inputs, ["s3"]);
  });

  await test("a rank on an input moves after the composite (dev r3a)", () => {
    const rk = (id, from) => ({ id, op: "rank", attr_id: "", inputs: [from], direction: "desc", limit: 20 });
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), load("s3", "INC"), rk("r1", "s1"), rk("r2", "s2"), rk("r3", "s3"),
      comp("c", ["r1", "r2", "r3"]), out("o", "c"));
    const fix = C.ranksAroundComposite(p, "Which counties score high on all three? Give each the lowest of its three percentile ranks.");
    assert.ok(/ranked after scoring/.test(fix), fix);
    assert.deepStrictEqual(p.steps.find(s => s.op === "composite").inputs, ["s1", "s2", "s3"]);
    const after = p.steps.find(s => s.op === "rank");
    assert.deepStrictEqual([after.inputs[0], after.direction, after.limit], ["c", "desc", 20]);
    assert.deepStrictEqual(p.steps.find(s => s.op === "output").inputs, [after.id]);
  });

  await test("bottleneck asked, intersected top lists planned: rebuilt as the minimum composite (dev r3b/c)", async () => {
    const rk = (id, from) => ({ id, op: "rank", attr_id: "", inputs: [from], direction: "desc", limit: 20 });
    const fa = (id, from) => ({ id, op: "filter_area", attr_id: "", inputs: [from], states: ["Georgia"] });
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), load("s3", "INC"), fa("f1", "s1"), fa("f2", "s2"), fa("f3", "s3"),
      rk("r1", "f1"), rk("r2", "f2"), rk("r3", "f3"),
      { id: "i1", op: "intersect", attr_id: "", inputs: ["r1", "r2"] },
      { id: "i2", op: "intersect", attr_id: "", inputs: ["i1", "r3"] }, out("o", "i2"));
    const q = "Which Georgia counties score high on all three of poverty, uninsured and income? Give each county the lowest of its three percentile ranks, so one good measure cannot make up for a bad one.";
    const r = C.applyComposite(p, q, deps());
    assert.ok(/weakest of its 3 measures/.test(r.fixes[0]), r.fixes[0]);
    const c = p.steps.find(s => s.op === "composite");
    assert.deepStrictEqual(c.inputs, ["f1", "f2", "f3"]);
    assert.strictEqual(c.method, "minimum");
    assert.ok(!p.steps.some(s => s.op === "intersect" || s.op === "rank"));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    // Without the minimum method stated, an intersect is left alone.
    const p2 = plan(load("s1", "POV"), load("s2", "UNINS"), rk("r1", "s1"), rk("r2", "s2"),
      { id: "i1", op: "intersect", attr_id: "", inputs: ["r1", "r2"] }, out("o", "i1"));
    assert.strictEqual(C.intersectAsComposite(p2, "rank counties by poverty, uninsured and income"), null);
  });

  await test("the rank after a composite runs toward what was asked", () => {
    const mk = (dir) => plan(load("s1", "POV"), load("s2", "UNINS"), comp("c", ["s1", "s2"]),
      { id: "r", op: "rank", attr_id: "", inputs: ["c"], direction: dir, limit: 10 }, out("o", "r"));
    let p = mk("asc");
    C.ranksAroundComposite(p, "Which Kentucky counties are most in need, by poverty and uninsured?");
    assert.strictEqual(p.steps.find(s => s.op === "rank").direction, "desc");
    p = mk("desc");
    C.ranksAroundComposite(p, "the 10 least vulnerable counties by poverty and uninsured rate");
    assert.strictEqual(p.steps.find(s => s.op === "rank").direction, "asc");
    p = mk("desc");
    assert.strictEqual(C.ranksAroundComposite(p, "score with the lowest of its percentile ranks, at least 20 counties"), null);
  });

  await test("a named state the plan left out goes on the first input (dev r4a)", async () => {
    const p = P3();
    const r = C.applyComposite(p, "Score every Texas county on poverty rate, uninsured adults and distance to the nearest hospital", deps());
    const f = p.steps.find(s => s.op === "filter_area");
    assert.ok(f && f.states[0] === "Texas" && f.inputs[0] === "s1", JSON.stringify(p.steps));
    assert.strictEqual(p.steps.find(s => s.op === "composite").inputs[0], f.id);
    assert.ok(r.fixes.some(x => /restricted the scores to Texas/.test(x)));
    assert.ok((await validatePlan(p, resolve)).ok);
    // Two places named, or one already applied: left alone.
    const q = P3();
    C.applyComposite(q, "score counties in Kansas and Nebraska by poverty, uninsured and hospital distance", deps());
    assert.ok(!q.steps.some(s => s.op === "filter_area"));
  });

  await test("place filter stays after the composite when the question asks for national ranks", () => {
    const p = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"]),
      { id: "s4", op: "filter_area", attr_id: "", inputs: ["s3"], states: ["Missouri"] }, out("s5", "s4"));
    assert.strictEqual(C.scoreWithinArea(p, "Missouri counties scored by poverty and uninsured rate, ranked nationally"), null);
  });

  await test("validate: 2 to 6 inputs, distinct, fields checked", async () => {
    let v = await validatePlan(P3(), resolve);
    assert.ok(v.ok, v.errors.join("; "));
    v = await validatePlan(plan(load("s1", "POV"), comp("s2", ["s1"]), out("s3", "s2")), resolve);
    // The structural bound is the count method's (12); a weighted score is
    // still held to 6 by the op's own check (tested below).
    assert.ok(v.errors.some(e => /expects 2 to 12 input/.test(e)), v.errors.join("; "));
    v = await validatePlan(plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s1"]), out("s4", "s3")), resolve);
    assert.ok(v.errors.some(e => /listed twice/.test(e)));
    const bad = P3(); Object.assign(bad.steps[3], { weights: [1, -1, 1], directions: ["up", "high", "high"], method: "max" });
    v = await validatePlan(bad, resolve);
    assert.strictEqual(v.errors.filter(e => /composite/.test(e)).length, 3, v.errors.join("; "));
  });

  await test("validate: a composite of a features step is a type error", async () => {
    const p = plan({ id: "s1", op: "select_features", attr_id: "HOSP", inputs: [] }, load("s2", "POV"),
      comp("s3", ["s1", "s2"]), out("s4", "s3"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok);
  });

  await test("compile: weighted sum of percentile ranks, weights bound, directions in the ORDER BY", async () => {
    const p = P3();
    Object.assign(p.steps[3], { weights: [0.5, 0.3, 0.2], directions: ["high", "low", "high"] });
    const v = await validatePlan(p, resolve);
    const o = compilePlan(p, v.resolved);
    paramsMatch(o);
    assert.ok(/PERCENT_RANK\(\) OVER \(ORDER BY v1 DESC\)/.test(o.sql));
    assert.ok(/PERCENT_RANK\(\) OVER \(ORDER BY v0 ASC\)/.test(o.sql));
    assert.ok(/JOIN \w+ i2 USING \(fips\)/.test(o.sql));
    for (const w of [0.5, 0.3, 0.2]) assert.ok(o.params.some(x => near1(x, w, 1e-9)), `weight ${w} bound`);
    assert.strictEqual(o.outputs[0].diverging, false);
    assert.ok(/composite score \(0 to 1, weighted sum of percentile ranks\)/.test(o.outputs[0].valueLabel));
  });

  await test("compile: geometric and minimum, z-scores diverging, label survives a rank", async () => {
    const g = P3(); Object.assign(g.steps[3], { method: "geometric" });
    let o = compilePlan(g, (await validatePlan(g, resolve)).resolved);
    assert.ok(/CASE WHEN LEAST\(s0, s1, s2\) <= 0 THEN 0 ELSE EXP\(/.test(o.sql));
    const m = P3(); Object.assign(m.steps[3], { method: "minimum", standardize: "minmax" });
    o = compilePlan(m, (await validatePlan(m, resolve)).resolved);
    assert.ok(/SELECT fips, LEAST\(s0, s1, s2\) AS value/.test(o.sql));
    // Every method binds exactly the parameters its SQL uses (dev r3a:
    // minimum bound unused weights, 12 params for 9 placeholders).
    for (const method of ["sum", "geometric", "minimum"]) {
      const q = plan(load("s1", "POV"), load("s2", "UNINS"), load("s3", "INC"),
        { id: "r1", op: "rank", attr_id: "", inputs: ["s1"], direction: "desc", limit: 20 },
        comp("c", ["r1", "s2", "s3"], { method, weights: [0.2, 0.3, 0.5] }), out("o", "c"));
      for (const x of compilePlan(q, (await validatePlan(q, resolve)).resolved).outputs) paramsMatch(x);
    }
    const z = plan(load("s1", "POV"), load("s2", "UNINS"), comp("s3", ["s1", "s2"], { standardize: "zscore" }),
      { id: "s4", op: "rank", attr_id: "", inputs: ["s3"], direction: "desc", limit: 10 }, out("s5", "s4"));
    o = compilePlan(z, (await validatePlan(z, resolve)).resolved);
    assert.strictEqual(o.outputs[0].diverging, true);
    assert.ok(/weighted z-score/.test(o.outputs[0].valueLabel));
    assert.strictEqual(o.outputs[0].composite, true);
  });

  await test("compile: the inputs come back as part layers", async () => {
    const p = P3();
    const o = compilePlan(p, (await validatePlan(p, resolve)).resolved);
    assert.strictEqual(o.outputs.filter(x => x.part).length, 3);
  });


  // --- method "count": a fourth method; the three above are unchanged ------

  const FLT = (id, from, operator, value) => ({ id, op: "filter_attr", attr_id: "", inputs: [from], operator, value });

  await test("count: read only from count phrasing; the other methods read as before", () => {
    for (const q of [
      "how many of these thresholds does each county meet: poverty above 15%, uninsured above 20%",
      "number of factors above their thresholds for each tract",
      "an accumulated inequity score from poverty, uninsured and no vehicle",
      "a cumulative disadvantage index of poverty above 20% and unemployment above 8%",
      "count how many criteria each county passes",
      "a sum of binary flags for poverty, income and rent",
    ]) assert.strictEqual(C.readMethod(q), "count", q);
    for (const q of [
      "how many hospitals are in each county",
      "count of hospitals per county",
      "rank counties by poverty, income and unemployment",
      "number of people below poverty by county",
    ]) assert.notStrictEqual(C.readMethod(q), "count", q);
    assert.strictEqual(C.readMethod("a geometric mean of poverty, income and unemployment"), "geometric");
    assert.strictEqual(C.readMethod("treat it as a bottleneck: the weakest factor decides"), "minimum");
  });

  await test("count: stated thresholds parse operators, percents, commas and k", () => {
    const t = C.statedThresholds("poverty above 15%, income less than $40,000, at least 2 hospitals, rent under 30 percent, pop over 5k");
    assert.deepStrictEqual(t.map(x => [x.operator, x.value]),
      [[">", 15], ["<", 40000], [">=", 2], ["<", 30], [">", 5000]]);
  });

  await test("count: gate opens on count phrasing with two stated thresholds, not on one", () => {
    assert.ok(C.asksComposite("how many of these thresholds does each county meet: poverty above 15% and uninsured above 20%"));
    assert.ok(!C.asksComposite("how many counties have poverty above 15%"));
  });

  await test("count: thresholds from the question; filter masks fold into flags instead of dropping units", () => {
    const p = plan(load("s1", "POV"), FLT("f1", "s1", ">", 15), load("s2", "UNINS"), near("s3"),
      comp("s4", ["f1", "s2", "s3"]), out("s5", "s4"));
    const q = "how many of these thresholds does each county meet: poverty above 15%, uninsured above 20%, " +
              "hospital distance more than 2 miles";
    const r = C.applyComposite(p, q, deps());
    const c = p.steps.find(s => s.op === "composite");
    assert.strictEqual(c.method, "count");
    assert.deepStrictEqual(c.inputs, ["s1", "s2", "s3"]);
    assert.ok(!p.steps.some(s => s.id === "f1"), "the folded filter is removed");
    assert.deepStrictEqual(c.thresholds.map(t => [t.operator, t.value]), [[">", 15], [">", 20], [">", 2]]);
    assert.ok(r.fixes.some(f => /count of thresholds met \(0 to 3\)/.test(f)), r.fixes.join(" | "));
    assert.ok(r.notes.some(n => /score 0 instead of being dropped/.test(n)));
  });

  await test("count: a 'below' threshold flags the low end", () => {
    const p = plan(load("s1", "POV"), load("s2", "INC"), comp("s3", ["s1", "s2"]), out("s4", "s3"));
    C.applyComposite(p, "number of factors each county meets: poverty above 20% and median household income below 40000", deps());
    const c = p.steps.find(s => s.op === "composite");
    assert.deepStrictEqual(c.thresholds.map(t => t.operator), [">", "<"]);
    assert.deepStrictEqual(c.directions, ["high", "low"]);
  });

  await test("count: a measure with no threshold leaves the plan untouched and builds the weighted score", () => {
    const p = plan(load("s1", "POV"), FLT("f1", "s1", ">", 15), load("s2", "UNINS"), near("s3"),
      comp("s4", ["f1", "s2", "s3"]), out("s5", "s4"));
    const before = JSON.stringify(p.steps.filter(s => s.op !== "composite"));
    const r = C.applyComposite(p, "an accumulated inequity score of poverty above 15%, uninsured and hospital distance", deps());
    const c = p.steps.find(s => s.op === "composite");
    assert.strictEqual(c.method, "sum");
    assert.strictEqual(c.thresholds, undefined);
    assert.deepStrictEqual(c.inputs, ["f1", "s2", "s3"]);
    assert.strictEqual(JSON.stringify(p.steps.filter(s => s.op !== "composite")), before);
    assert.ok(r.notes.some(n => /needs a stated threshold for every measure/.test(n)), r.notes.join(" | "));
  });

  await test("count: validation needs one threshold per input; only a count passes 6 inputs", async () => {
    const many = (k, extra) => {
      const ls = Array.from({ length: k }, (_, i) => load(`l${i}`, ["POV", "UNINS", "INC", "TRANSIT", "RENT"][i % 5]));
      return plan(...ls, comp("c", ls.map(x => x.id), extra), out("o", "c"));
    };
    const th = (k) => Array.from({ length: k }, () => ({ operator: ">", value: 1 }));
    let v = await validatePlan(many(7, {}), resolve);
    assert.ok(v.errors.some(e => /at most 6 measures/.test(e)), v.errors.join("; "));
    v = await validatePlan(many(11, { method: "count", thresholds: th(11) }), resolve);
    assert.ok(v.ok, v.errors.join("; "));
    v = await validatePlan(many(3, { method: "count" }), resolve);
    assert.ok(v.errors.some(e => /needs 3 thresholds/.test(e)), v.errors.join("; "));
    v = await validatePlan(many(3, { method: "count", thresholds: [{ operator: "=", value: 1 }, ...th(2)] }), resolve);
    assert.ok(!v.ok);
    v = await validatePlan(many(3, { method: "sum", thresholds: th(3) }), resolve);
    assert.ok(v.errors.some(e => /only to method "count"/.test(e)));
  });

  await test("compile: count is a sum of 0/1 flags on raw values, params bound, label 0 to N", async () => {
    const p = P3();
    Object.assign(p.steps[3], { method: "count", thresholds: [{ operator: ">", value: 15 }, { operator: ">=", value: 20 }, { operator: "<", value: 2 }] });
    const o = compilePlan(p, (await validatePlan(p, resolve)).resolved);
    paramsMatch(o.outputs[0]);
    assert.ok(/CASE WHEN v0 > \$\d+::float8 THEN 1 ELSE 0 END/.test(o.sql), o.sql);
    assert.ok(/CASE WHEN v1 >= /.test(o.sql) && /CASE WHEN v2 < /.test(o.sql));
    assert.ok(!/PERCENT_RANK/.test(o.sql), "no standardization in a count");
    for (const t of [15, 20, 2]) assert.ok(o.params.includes(t), `threshold ${t} bound`);
    assert.strictEqual(o.outputs[0].diverging, false);
    assert.strictEqual(o.outputs[0].valueLabel, "number of thresholds met (0 to 3)");
  });


  await test("count: question thresholds get the filter_attr scale check (percent on a 0-1 fraction)", () => {
    const { checkCountThresholds } = require("./conditions");
    const p = P3();
    Object.assign(p.steps[3], { method: "count", thresholds: [{ operator: ">", value: 15 }, { operator: ">", value: 500 }, { operator: ">", value: 2 }] });
    const resolved = new Map([
      ["POV", { description: "Poverty rate", value_range: { lo: 0, hi: 1 } }],
      ["UNINS", { description: "Uninsured", value_range: { lo: 0, hi: 60 } }],
    ]);
    const r = checkCountThresholds(p, resolved);
    assert.strictEqual(p.steps[3].thresholds[0].value, 0.15);
    assert.ok(r.repairs.some(x => /read as 0.15/.test(x)));
    assert.ok(r.errors.some(e => /outside its values \(0 to 60\)/.test(e)), r.errors.join("; "));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
