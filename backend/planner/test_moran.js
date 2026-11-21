/**
 * Moran's I and LISA (planner/moran.js, ops/moran.js; GIS_OPS_PLAN.md H6
 * tier 1, item 6). No model or database. Run: node backend/planner/test_moran.js
 *
 * The live check against PySAL on real county data is
 * eval/gis_ops/moran/compare_pysal.js; this pins a 5x5 lattice esda computed.
 */
const assert = require("node:assert");
const M = require("./moran");
const ops = require("./ops");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); fail++; }
}
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// 5x5 queen lattice, ids "0".."24", as libpysal.weights.lat2W(5, 5, rook=False).
function lattice(n = 5) {
  const nb = new Map();
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) out.push(String(rr * n + cc));
    }
    nb.set(String(r * n + c), out);
  }
  return nb;
}
const Y = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3];
// esda 2.10.0: Moran(y, w, "r") and Moran_Local(y, w, "r") on this lattice.
const ESDA = {
  I: -0.013138177382819291, EI: -0.041666666666666664, VI: 0.011752743870037795,
  z: 0.26315349270203287, p: 0.792432275186073,
  Is: [0.1942080501829585, -0.046670151594354635, 0.19420805018295859, 0.07000522739153149, -0.07552535284892842,
    -0.6175013068478828, -0.3860324098274961, -0.019069524307370567, 0.03424986931521175, -0.18341871406168328,
    0.00351280710925251, 0.07972817564035568, 0.2718348144276008, 0.41297438578149515, 0.45641400940930504,
    0.03236800836382629, -0.22607422895974913, -0.2778254051228437, 0.4655096706743337, -0.16710925248301095,
    -0.47907997909043387, 0.30711970726607407, -0.18467328802927332, -0.009032932566649277, -0.1654364871928908],
  q: [3, 2, 3, 3, 4, 4, 2, 4, 1, 2, 1, 1, 1, 1, 1, 3, 2, 2, 1, 2, 4, 3, 4, 2, 2],
};
const rowsOf = (y) => y.map((v, i) => ({ fips: String(i), value: v }));
const QUAD = { "High-High": 1, "Low-High": 2, "Low-Low": 3, "High-Low": 4 };

const SRC = new Map([
  ["POV", { source_kind: "acs_long", census_code: "PCTPOVALL", description: "Poverty rate" }],
  ["OB", { source_kind: "acs_long", census_code: "PLACES_OBESITY_CrdPrv", description: "Obesity" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const load = (id, a) => ({ id, op: "load", attr_id: a, inputs: [] });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const moran = (id, from, extra = {}) => ({ id, op: "moran", attr_id: "", inputs: [from], ...extra });

(async () => {
  // --- the statistics -------------------------------------------------------
  await test("global Moran's I equals esda on a 5x5 queen lattice", async () => {
    const g = M.globalMoran(rowsOf(Y), lattice(), { permutations: 0 });
    close(g.I, ESDA.I, 1e-12, "I"); close(g.expected, ESDA.EI, 1e-15, "E[I]");
    close(g.variance, ESDA.VI, 1e-12, "Var_rand"); close(g.z, ESDA.z, 1e-10, "z");
    close(g.p_value, ESDA.p, 1e-6, "p_rand");
    assert.strictEqual(g.n, 25); assert.strictEqual(g.n_islands, 0); assert.strictEqual(g.p_sim, null);
  });

  await test("local Is and quadrants equal esda on the lattice", async () => {
    const l = M.localMoran(rowsOf(Y), lattice(), { permutations: 0 });
    l.rows.forEach((r, i) => {
      close(r.local_i, ESDA.Is[i], 1e-12, `Is[${i}]`);
      assert.strictEqual(QUAD[r.quadrant], ESDA.q[i], `q[${i}]`);
      // No permutations: no significance test, so no class.
      assert.strictEqual(r.value, 0);
    });
  });

  await test("a smooth gradient is strongly clustered, a checkerboard dispersed", async () => {
    const grad = rowsOf(Array.from({ length: 100 }, (_, i) => Math.floor(i / 10) + (i % 10)));
    const g = M.globalMoran(grad, lattice(10), { permutations: 199 });
    assert.ok(g.I > 0.8 && g.p_sim <= 0.01, `gradient I ${g.I} p ${g.p_sim}`);
    // A rook checkerboard: queen neighbours are half same, half different, plus edges.
    const cb = rowsOf(Array.from({ length: 100 }, (_, i) => (Math.floor(i / 10) + (i % 10)) % 2));
    const c = M.globalMoran(cb, lattice(10), { permutations: 199 });
    assert.ok(c.I < 0, `checkerboard I ${c.I}`);
  });

  await test("pseudo p is esda's directed form; ties count as at least as extreme", async () => {
    assert.strictEqual(M.pseudoP(5, [1, 2, 3, 4, 5, 6, 7, 8, 9]), (Math.min(5, 4) + 1) / 10);
    assert.strictEqual(M.pseudoP(10, [1, 2, 3]), 1 / 4);
    assert.strictEqual(M.pseudoP(0, [1, 2, 3]), 1 / 4);
  });

  await test("LISA finds the planted high-high and low-low blocks, and is deterministic", async () => {
    const y = Array.from({ length: 100 }, (_, i) => {
      const r = Math.floor(i / 10), c = i % 10;
      if (r < 3 && c < 3) return 10 + ((i * 7) % 3);      // high block, top left
      if (r > 6 && c > 6) return -10 - ((i * 5) % 3);     // low block, bottom right
      return ((i * 37) % 11) / 10;                         // noise
    });
    const a = M.localMoran(rowsOf(y), lattice(10), { permutations: 999, alpha: 0.05 });
    const b = M.localMoran(rowsOf(y), lattice(10), { permutations: 999, alpha: 0.05 });
    assert.deepStrictEqual(a.rows.map(r => r.p_sim), b.rows.map(r => r.p_sim), "same seed, same p");
    assert.strictEqual(a.rows[11].lisa_class, "High-High");   // centre of the high block
    assert.strictEqual(a.rows[88].lisa_class, "Low-Low");     // centre of the low block
    assert.strictEqual(a.rows[11].value, 2); assert.strictEqual(a.rows[88].value, -2);
    for (const r of a.rows) assert.ok([2, 1, 0, -1, -2].includes(r.value));
    assert.strictEqual(a.summary.expected_false, Math.round(0.05 * 100));
  });

  await test("weights are built over the units present; an island has no class", async () => {
    const nb = lattice();
    nb.set("99", []);
    const rows = [...rowsOf(Y), { fips: "99", value: 50 }, { fips: "98", value: null }];
    const l = M.localMoran(rows, nb, { permutations: 99 });
    const isl = l.rows.find(r => r.fips === "99");
    assert.strictEqual(isl.lisa_class, "No neighbours"); assert.strictEqual(isl.p_sim, null);
    assert.ok(!l.rows.some(r => r.fips === "98"), "a null value is dropped");
    assert.strictEqual(l.summary.n_islands, 1);
    const g = M.globalMoran(rows, nb, { permutations: 0 });
    assert.strictEqual(g.n, 26, "an island still counts in n, as in esda"); assert.strictEqual(g.n_islands, 1);
  });

  // --- phrasing ---------------------------------------------------------------
  await test("the gate: Moran / LISA / autocorrelation / clustered-or-random, not hot spots", async () => {
    const yes = [
      "What is the global Moran's I of poverty across counties?",
      "Show a LISA cluster map of obesity in Ohio",
      "Is diabetes spatially autocorrelated?",
      "Are unemployment rates clustered or randomly distributed?",
      "Is median income spatially clustered across Texas counties?",
      "Where are the high-high clusters of uninsured adults?",
      "Find spatial outliers in median home value",
      "local indicators of spatial association for asthma",
    ];
    const no = [
      "where are the hot spots of poverty",
      "show me clusters of counties with high uninsured rates",
      "which counties are outliers for median household income",
      "counties whose unemployment is far above their neighbors",
      "is obesity related to diabetes",
      "Which Missouri counties have a low poverty rate?",
    ];
    for (const q of yes) assert.ok(M.asksMoran(q), q);
    for (const q of no) assert.ok(!M.asksMoran(q), q);
    const mod = ops.byName("moran");
    assert.ok(!mod.offered({ query: yes[0], hasNeighbors: false }), "needs adjacency");
    assert.ok(mod.offered({ query: yes[0], hasNeighbors: true }));
  });

  await test("mode, alpha and permutations are read from the question", async () => {
    assert.strictEqual(M.readMode("Is obesity spatially clustered? Report Moran's I."), "global");
    assert.strictEqual(M.readMode("Are rates clustered or randomly distributed in Missouri counties?"), "global");
    assert.strictEqual(M.readMode("Show a LISA cluster map of poverty"), "local");
    assert.strictEqual(M.readMode("Compute local Moran's I for income"), "local");
    assert.strictEqual(M.readMode("Which counties form high-high clusters of diabetes?"), "local");
    assert.strictEqual(M.readMode("Report the global Moran's I and map the LISA clusters"), "both");
    assert.strictEqual(M.readMode("Moran's I and a LISA cluster map of obesity"), "both");
    assert.strictEqual(M.readAlpha("LISA clusters of poverty"), 0.05);
    assert.strictEqual(M.readAlpha("LISA clusters significant at p < 0.01"), 0.01);
    assert.strictEqual(M.readAlpha("LISA clusters at 99% confidence"), 0.01);
    assert.strictEqual(M.readAlpha("significance level of 0.1"), 0.1);
    assert.strictEqual(M.readPermutations("LISA with 9999 permutations"), 9999);
    assert.strictEqual(M.readPermutations("LISA with 99999 permutations"), 9999);
    assert.strictEqual(M.readPermutations("LISA"), 999);
    assert.deepStrictEqual(M.unsupportedWeights("Moran's I with k-nearest neighbour weights"), ["k-nearest-neighbour weights"]);
    assert.deepStrictEqual(M.unsupportedWeights("Moran's I with queen contiguity"), []);
  });

  // --- repairs ------------------------------------------------------------------
  await test("fields are set from the question and echoed; a template's fields are kept", async () => {
    const p = plan(load("s1", "POV"), moran("s2", "s1"), out("s3", "s2"));
    const r = M.applyMoran(p, "Show a LISA map of poverty, significant at p < 0.01");
    assert.deepStrictEqual({ ...p.steps[1], inputs: undefined },
      { id: "s2", op: "moran", attr_id: "", inputs: undefined, local: true, alpha: 0.01, permutations: 999, weights: "queen" });
    assert.ok(r.fixes.some(f => /LISA \(local Moran's I\), queen contiguity, row-standardized; a class needs pseudo p < 0.01/.test(f)), r.fixes.join(" | "));
    const t = plan(load("s1", "POV"), moran("s2", "s1", { local: false, permutations: 99 }), out("s3", "s2"));
    M.applyMoran(t, "Show a LISA map of poverty");
    assert.strictEqual(t.steps[1].local, false); assert.strictEqual(t.steps[1].permutations, 99);
  });

  await test("hotspot is swapped for moran only when the question names Moran / LISA", async () => {
    const p = plan(load("s1", "POV"), { id: "s2", op: "hotspot", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    M.applyMoran(p, "Show the LISA clusters of poverty");
    assert.strictEqual(p.steps[1].op, "moran"); assert.strictEqual(p.steps[1].local, true);
    const h = plan(load("s1", "POV"), { id: "s2", op: "hotspot", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    assert.strictEqual(M.applyMoran(h, "where are the hot spots of poverty (Gi*), and is it spatially autocorrelated"), null);
    assert.strictEqual(h.steps[1].op, "hotspot");
    const o = plan(load("s1", "POV"), { id: "s2", op: "outlier", attr_id: "", inputs: ["s1"] }, out("s3", "s2"));
    M.applyMoran(o, "find spatial outliers in poverty");
    assert.strictEqual(o.steps[1].op, "moran"); assert.strictEqual(o.steps[1].local, true);
  });

  await test("a plan that left Moran's I out gets it before the output", async () => {
    const p = plan(load("s1", "POV"), out("s2", "s1"));
    M.applyMoran(p, "What is the Moran's I of poverty?", { stepTypes: ops.stepTypes });
    assert.deepStrictEqual(p.steps.map(s => s.op), ["load", "moran", "output"]);
    assert.strictEqual(p.steps[1].local, false);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
  });

  await test("a place filter after moran moves before it; a named state is added", async () => {
    const p = plan(load("s1", "POV"), moran("s2", "s1"),
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Texas"] }, out("s4", "s3"));
    const r = M.applyMoran(p, "LISA cluster map of poverty in Texas");
    assert.deepStrictEqual(p.steps.map(s => s.op), ["load", "filter_area", "moran", "output"]);
    assert.deepStrictEqual(p.steps[2].inputs, ["s3"]); assert.deepStrictEqual(p.steps[3].inputs, ["s2"]);
    assert.ok(r.fixes.some(f => /over Texas only/.test(f)));
    assert.ok((await validatePlan(p, resolve)).ok);
    const q = plan(load("s1", "POV"), moran("s2", "s1"), out("s3", "s2"));
    M.applyMoran(q, "Is poverty spatially clustered across Missouri counties?");
    assert.deepStrictEqual(q.steps.map(s => s.op), ["load", "filter_area", "moran", "output"]);
    assert.deepStrictEqual(q.steps[1].states, ["Missouri"]);
    const n = plan(load("s1", "POV"), moran("s2", "s1"), out("s3", "s2"));
    M.applyMoran(n, "Is poverty spatially clustered nationally?");
    assert.deepStrictEqual(n.steps.map(s => s.op), ["load", "moran", "output"]);
  });

  await test("both: a global step and a LISA step, two outputs, one input", async () => {
    const p = plan(load("s1", "OB"), moran("s2", "s1"), out("s3", "s2"));
    const r = M.applyMoran(p, "Report the global Moran's I of obesity and map the LISA clusters, with rook weights");
    const ms = p.steps.filter(s => s.op === "moran");
    assert.strictEqual(ms.length, 2);
    assert.deepStrictEqual(ms.map(s => s.local), [false, true]);
    assert.deepStrictEqual(ms[1].inputs, ["s1"]);
    assert.strictEqual(p.steps.filter(s => s.op === "output").length, 2);
    assert.ok(r.notes.some(n => /rook contiguity is not built; queen contiguity/.test(n)), r.notes.join(" | "));
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    assert.strictEqual(compilePlan(p, v.resolved).outputs.length, 2);
  });

  // --- validation, types, compile -------------------------------------------------
  await test("moran is terminal: LISA classes and the statistic feed only an output", async () => {
    for (const local of [true, false]) {
      const p = plan(load("s1", "POV"), moran("s2", "s1", { local }),
        { id: "s3", op: "rank", attr_id: "", inputs: ["s2"], direction: "desc", limit: 10 }, out("s4", "s3"));
      const v = await validatePlan(p, resolve);
      assert.ok(!v.ok && v.errors.some(e => /output/.test(e)), `local ${local}: ${v.errors.join("; ")}`);
    }
  });

  await test("untrusted fields are checked", async () => {
    const bad = [{ local: "yes" }, { alpha: 0.9 }, { alpha: 0 }, { permutations: 100000 },
                 { permutations: 9.5 }, { weights: "rook" }, { seed: "x" }];
    for (const f of bad) {
      const v = await validatePlan(plan(load("s1", "POV"), moran("s2", "s1", f), out("s3", "s2")), resolve);
      assert.ok(!v.ok, JSON.stringify(f));
    }
    const ok = await validatePlan(plan(load("s1", "POV"),
      moran("s2", "s1", { local: true, alpha: 0.01, permutations: 9999, weights: "queen", seed: 3 }), out("s3", "s2")), resolve);
    assert.ok(ok.ok, ok.errors.join("; "));
  });

  await test("compile: a pass-through CTE, marked for computing after execution", async () => {
    const p = plan(load("s1", "POV"), moran("s2", "s1", { local: true }), out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    const o = compilePlan(p, v.resolved).outputs[0];
    assert.match(o.sql, /step_s2 AS \(SELECT fips, value FROM step_s1 WHERE value IS NOT NULL\)/);
    assert.strictEqual(o.post.op, "moran"); assert.strictEqual(o.post.step.local, true);
    const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    assert.strictEqual(used.size, o.params.length);
    assert.throws(() => ops.byName("moran").compile(p.steps[1], { name: "s2", ins: ["s1"], level: "tract" }), /counties only/);
  });

  await test("compute: LISA rows carry class columns; global carries stats over the measure", async () => {
    const mod = ops.byName("moran");
    const rows = rowsOf(Y).map(r => ({ ...r, name: `u${r.fips}`, state_fp: "00", geometry: null }));
    const l = mod.compute(rows, { step: { local: true, permutations: 99 }, neighbors: lattice() });
    assert.deepStrictEqual(l.rowColumns, ["lisa_class", "local_i", "lag", "p_sim", "quadrant"]);
    assert.strictEqual(l.rows.length, 25); assert.strictEqual(l.rows[0].name, "u0");
    assert.strictEqual(l.moran.kind, "local"); assert.strictEqual(l.moran.classes.length, 5);
    assert.strictEqual(l.stats, null);
    const g = mod.compute(rows, { step: { local: false, permutations: 99 }, neighbors: lattice() });
    assert.strictEqual(g.stats.kind, "moran"); close(g.stats.value, ESDA.I, 1e-12, "I");
    assert.strictEqual(g.rows.length, 25, "the measure itself, for the map");
    assert.ok(g.stats.p_sim > 0 && g.stats.p_sim <= 1);
  });

  await test("registry: in every order, absent from the default prompt", async () => {
    for (const o of [ops.SCHEMA_ORDER, ops.PROMPT_ORDER, ops.CHOICE_ORDER, ops.EXAMPLE_ORDER]) {
      assert.ok(o.includes("moran"));
    }
    assert.ok(!ops.offeredFor({ query: "where are the hot spots of poverty", hasNeighbors: true }).includes("moran"));
    assert.ok(ops.offeredFor({ query: "Moran's I of poverty", hasNeighbors: true }).includes("moran"));
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
