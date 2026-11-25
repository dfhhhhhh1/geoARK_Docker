/**
 * Per-component diagnostics of a composite score (planner/composite_diagnostics.js):
 * Pearson / Spearman against independent arithmetic, ties, constant inputs,
 * flags, rural / urban strata, and finding the composite behind a rank.
 * No database. Run: node backend/planner/test_composite_diagnostics.js
 */
const assert = require("node:assert");
const D = require("./composite_diagnostics");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const near = (a, b, t = 1e-9) => Math.abs(a - b) < t;

(async () => {
  await test("pearson matches a hand computation", () => {
    // x = 1..5, y = 2,4,5,4,5: r = 0.7745966692 (textbook example)
    assert.ok(near(D.pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]), 0.7745966692414834));
  });

  await test("spearman averages tied ranks", () => {
    assert.deepStrictEqual(D.ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
    // Monotone but not linear: rho = 1, r < 1.
    const xs = [1, 2, 3, 4, 5, 6], ys = xs.map(x => x ** 3);
    assert.ok(near(D.spearman(xs, ys), 1));
    assert.ok(D.pearson(xs, ys) < 0.99);
  });

  await test("a constant input or too few units has no coefficient, not 0 or NaN", () => {
    assert.strictEqual(D.pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5]), null);
    assert.strictEqual(D.pearson([1, 2, 3], [1, 2, 3]), null);
  });

  const units = Array.from({ length: 12 }, (_, i) => `u${i}`);
  const score = new Map(units.map((u, i) => [u, i % 4]));
  const a = new Map(units.map((u, i) => [u, i * 2]));            // tracks the score loosely
  const b = new Map(units.map((u, i) => [u, 50]));               // constant
  const density = new Map(units.map((u, i) => [u, i < 6 ? 20 : 500]));

  await test("components: per input, all units, flags counted on the raw value", () => {
    const d = D.diagnose({ score, method: "count", inputs: [
      { step: "s1", name: "A", values: a, threshold: { operator: ">", value: 10 } },
      { step: "s2", name: "B", values: b, threshold: { operator: ">=", value: 50 } },
    ] });
    assert.strictEqual(d.components.length, 2);
    assert.strictEqual(d.components[0].by.all.n, 12);
    assert.strictEqual(d.components[0].by.all.flagged, 6);       // 12..22
    assert.strictEqual(d.components[1].by.all.flagged, 12);
    assert.strictEqual(d.components[1].by.all.pearson, null);    // constant
    const xs = units.map(u => a.get(u)), ys = units.map(u => score.get(u));
    assert.ok(near(d.components[0].by.all.pearson, Math.round(D.pearson(xs, ys) * 1000) / 1000));
    assert.strictEqual(d.strata.length, 1, "no density: no rural / urban split");
    assert.strictEqual(d.rural_rule, null);
  });

  await test("strata: rural under 100 per sq mi, urban the rest, means per stratum, rule stated", () => {
    const d = D.diagnose({ score, density, inputs: [{ step: "s1", name: "A", values: a }] });
    assert.deepStrictEqual(d.strata.map(s => [s.name, s.n]), [["all", 12], ["rural", 6], ["urban", 6]]);
    // rural u0..u5 -> 0,1,2,3,0,1 = mean 1.17
    assert.strictEqual(d.strata[1].mean_score, 1.17);
    assert.ok(/100 people per square mile/.test(d.rural_rule));
    assert.ok(d.components[0].by.rural && d.components[0].by.urban);
    assert.strictEqual(d.components[0].by.rural.flagged, undefined, "no threshold, no flag count");
  });

  await test("strata: a split with too few units on one side is not reported", () => {
    const lop = new Map(units.map((u, i) => [u, i < 2 ? 20 : 500]));
    const d = D.diagnose({ score, density: lop, inputs: [{ step: "s1", name: "A", values: a }] });
    assert.strictEqual(d.strata.length, 1);
  });

  await test("findComposite reaches through rank and filters, not through two-input ops", () => {
    const byId = new Map([
      ["c", { id: "c", op: "composite", inputs: ["x", "y"] }],
      ["r", { id: "r", op: "rank", inputs: ["c"] }],
      ["f", { id: "f", op: "filter_attr", inputs: ["r"] }],
      ["j", { id: "j", op: "join", inputs: ["c", "x"] }],
    ]);
    assert.strictEqual(D.findComposite(byId, "f").id, "c");
    assert.strictEqual(D.findComposite(byId, "j"), null);
  });

  await test("attach: fills the main layer from its part layers, names inputs, skips parts", async () => {
    const plan = { steps: [
      { id: "s1", op: "load", attr_id: "A", inputs: [] }, { id: "s2", op: "load", attr_id: "B", inputs: [] },
      { id: "c", op: "composite", inputs: ["s1", "s2"], method: "count",
        thresholds: [{ operator: ">", value: 10 }, { operator: "<", value: 60 }] },
      { id: "o", op: "output", inputs: ["c"] }] };
    const rows = (m) => [...m].map(([fips, value]) => ({ fips, value }));
    const layers = [
      { step: "c", composite: true, rows: rows(score) },
      { step: "s1", part: true, rows: rows(a) }, { step: "s2", part: true, rows: rows(b) },
    ];
    const client = { query: async () => ({ rows: units.map((u, i) => ({ geoid: u, d: i < 6 ? 20 : 500 })) }) };
    await D.attach({ client, plan, layers, level: "county", nameOf: (id) => `name ${id}` });
    const c = layers[0].components;
    assert.ok(c && !c.error, JSON.stringify(c));
    assert.deepStrictEqual(c.components.map(x => x.name), ["name s1", "name s2"]);
    assert.strictEqual(c.components[1].by.all.flagged, 12);
    assert.strictEqual(c.strata.length, 3);
    assert.strictEqual(layers[1].components, undefined);
  });

  await test("attach: a failed density query still reports the components, without strata", async () => {
    const plan = { steps: [{ id: "s1", op: "load", attr_id: "A", inputs: [] }, { id: "s2", op: "load", attr_id: "B", inputs: [] },
      { id: "c", op: "composite", inputs: ["s1", "s2"] }] };
    const rows = (m) => [...m].map(([fips, value]) => ({ fips, value }));
    const layers = [{ step: "c", composite: true, rows: rows(score) },
      { step: "s1", part: true, rows: rows(a) }, { step: "s2", part: true, rows: rows(b) }];
    const seen = [];
    const client = { query: async (sql) => { seen.push(sql); if (/WORLDPOP/.test(sql)) throw new Error("no worldpop"); return { rows: [] }; } };
    await D.attach({ client, plan, layers });
    assert.strictEqual(layers[0].components.strata.length, 1);
    assert.strictEqual(layers[0].components.method, "sum");
    assert.ok(seen.some(q => /ROLLBACK TO SAVEPOINT/.test(q)), "the failed statement is rolled back to its savepoint");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
