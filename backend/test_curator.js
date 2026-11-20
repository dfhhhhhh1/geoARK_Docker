/** backend/curator.js rules after the model. No model, no database: `node test_curator.js`. */
const assert = require("assert");
const { applyRules, topByScore, conceptOf } = require("./curator");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };
const item = (id, extra = {}) => ({ id, label: id, description: id, dataset: null, kind: "value",
                                    role: "linked", why: [], score: 1, checkout: null, ...extra });
const lit = (name) => [{ kind: "literature", text: `Coronary Arteriosclerosis → ${name}, 100 papers (SemMedDB)` }];

test("a direct measure the model left out is put first", () => {
  const shelf = [item("CHD", { role: "subject" }), item("OB", { why: lit("Obesity") })];
  const { cart } = applyRules(shelf, new Map([["CHD", "direct"], ["OB", "related"]]), ["OB"], "heart disease");
  assert.deepStrictEqual(cart, ["CHD", "OB"]);
});

test("none is dropped, unless the row shares a word with the question", () => {
  const shelf = [item("Coronary heart disease among adults", { role: "subject" }), item("Ferry terminals")];
  const v = new Map([["Coronary heart disease among adults", "none"], ["Ferry terminals", "none"]]);
  const { cart } = applyRules(shelf, v, ["Coronary heart disease among adults", "Ferry terminals"],
                              "coronary heart disease in each county");
  assert.deepStrictEqual(cart, ["Coronary heart disease among adults"]);
});

test("at most two rows per linked concept", () => {
  const shelf = ["a", "b", "c"].map(id => item(id, { why: lit("Obesity") }));
  const v = new Map(shelf.map(s => [s.id, "related"]));
  assert.deepStrictEqual(applyRules(shelf, v, ["a", "b", "c"], "q").cart, ["a", "b"]);
  assert.strictEqual(conceptOf(shelf[0]), "obesity");
});

test("an empty proposal with nothing direct stays empty (rainfall)", () => {
  const shelf = [item("Reading scores", { role: "subject" })];
  assert.deepStrictEqual(applyRules(shelf, new Map([["Reading scores", "none"]]), [], "average rainfall").cart, []);
});

test("an empty proposal over rows the model judged useful uses those rows", () => {
  const shelf = [item("Heat Wave risk", { role: "subject" }), item("Max temperature"), item("Storm tracks")];
  const v = new Map([["Heat Wave risk", "related"], ["Max temperature", "related"], ["Storm tracks", "none"]]);
  assert.deepStrictEqual(applyRules(shelf, v, [], "extreme heat days").cart, ["Heat Wave risk", "Max temperature"]);
});

test("rasters never enter a cart; top-8 is by score", () => {
  const shelf = [item("r", { checkout: "map only (raster)", score: 9 }), item("x", { score: 2 }), item("y", { score: 3 })];
  assert.deepStrictEqual(applyRules(shelf, new Map([["r", "direct"]]), ["r"], "q").cart, []);
  assert.deepStrictEqual(topByScore(shelf), ["y", "x"]);
});

console.log(`\n${passed} passed`);
