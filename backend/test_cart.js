/**
 * backend/cart.js: the shelf, the default cart, the checkout plan and the wide
 * table. No database; `node test_cart.js`.
 */
const assert = require("assert");
const { buildShelf, defaultCart, cartPlan, wideTable, partialCompanion, CartError, MAX_ITEMS } = require("./cart");

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

const row = (attr_id, extra = {}) => ({ attr_id, attr_desc: attr_id, attr_orig: attr_id,
                                        search_purpose: "primary", hybrid_score: 1, ...extra });
const value = (n) => ({ source_kind: "acs_long", census_code: "C", value_range: { n } });
const layer = (table) => ({ source_kind: "feature_table", table_name: table });

// ---------------------------------------------------------------------------
console.log("shelf");

test("rows without data are dropped and counted", () => {
  const search = { all_results: [row("CHD"), row("GHOST")], results_by_query: [] };
  const { items, dropped } = buildShelf(search, new Map([["CHD", value(3000)]]), { label: r => r.attr_id });
  assert.deepStrictEqual(items.map(i => i.id), ["CHD"]);
  assert.strictEqual(dropped.no_data, 1);
  assert.strictEqual(items[0].coverage, 3000);
});

test("a layer is one item, and a location or id column is noise", () => {
  const search = { results_by_query: [], all_results: [
    row("H_name", { attr_orig: "Name" }),          // identifier column of a layer
    row("H_beds", { attr_orig: "BEDS" }),          // first real match of Hospitals
    row("H_type", { attr_orig: "TYPE" }),          // same layer again
    row("X", { attr_orig: "latitude" }),           // a value column that is a location
  ] };
  const resolved = new Map([["H_name", layer("hosp")], ["H_beds", layer("hosp")],
                            ["H_type", layer("hosp")], ["X", value(10)]]);
  const { items, dropped } = buildShelf(search, resolved,
    { label: r => r.attr_id, isLocationColumn: s => /^latitude$/i.test(s) });
  assert.deepStrictEqual(items.map(i => i.id), ["H_beds"]);
  assert.strictEqual(items[0].kind, "feature");
  assert.strictEqual(dropped.location_or_id, 2);
  assert.strictEqual(dropped.duplicate_layer_column, 1);
});

test("why: literature and PubMed links are carried, and roles follow purpose", () => {
  const search = {
    all_results: [row("CHD"), row("OBES", { search_purpose: "expanded" }),
                  row("PM25", { search_purpose: "expanded" }), row("POP", { search_purpose: "normalization" })],
    results_by_query: [
      { query: "coronary heart disease", purpose: "primary", results: [{ attr_id: "CHD" }] },
      { query: "Obesity", purpose: "expanded", results: [{ attr_id: "OBES" }],
        expansion: { name: "Obesity", support: 178, seed: "Coronary Arteriosclerosis" } },
      { query: "air pollution", purpose: "expanded", results: [{ attr_id: "PM25" }],
        research: { source: "pubmed", keyword: "air pollution" } },
      { query: "population", purpose: "normalization", results: [{ attr_id: "POP" }] },
    ] };
  const resolved = new Map(["CHD", "OBES", "PM25", "POP"].map(id => [id, value(3000)]));
  const { items } = buildShelf(search, resolved, { label: r => r.attr_id });
  const by = Object.fromEntries(items.map(i => [i.id, i]));
  assert.strictEqual(by.CHD.role, "subject");
  assert.strictEqual(by.OBES.role, "linked");
  assert.match(by.OBES.why[0].text, /Coronary Arteriosclerosis → Obesity, 178 papers/);
  assert.strictEqual(by.PM25.why[0].kind, "pubmed");
  assert.strictEqual(by.POP.role, "denominator");
  // Subject first, then linked, then the denominator.
  assert.deepStrictEqual(items.map(i => i.role), ["subject", "linked", "linked", "denominator"]);
  assert.deepStrictEqual(defaultCart(items), ["CHD", "OBES", "PM25", "POP"]);
});

test("variants of one measure are grouped under the best-ranked one, not hidden", () => {
  const search = { results_by_query: [], all_results: [
    row("A", { attr_desc: "Obesity among adults (crude prevalence)" }),
    row("B", { attr_desc: "Obesity among adults (age-adjusted prevalence)" }),
  ] };
  const resolved = new Map([["A", value(3000)], ["B", value(3000)]]);
  const { items } = buildShelf(search, resolved, { label: r => r.attr_desc });
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual(items[0].variants.map(v => v.id), ["B"]);
});

test("the catalog's coverage note neither shows nor splits variants", () => {
  const search = { results_by_query: [], all_results: [
    row("A", { attr_desc: "Obesity among adults (crude prevalence) (covers 2,957 counties)" }),
    row("B", { attr_desc: "Obesity among adults (age-adjusted prevalence) (covers 2,957 counties)" }),
  ] };
  const { items } = buildShelf(search, new Map([["A", value(1)], ["B", value(1)]]), { label: r => r.attr_desc });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].label, "Obesity among adults (crude prevalence)");
});

test("a layer matched to the denominator is never the default denominator", () => {
  const items = [{ id: "S", role: "subject", kind: "value", why: [] },
                 { id: "CC", role: "denominator", kind: "feature", why: [] },
                 { id: "POP", role: "denominator", kind: "value", why: [] }];
  assert.deepStrictEqual(defaultCart(items), ["S", "POP"]);
});

test("the default cart skips rasters and takes one row per linked concept", () => {
  const items = [
    { id: "S", role: "subject", why: [] },
    { id: "R", role: "linked", why: [{ text: "x" }], checkout: "map only (raster)" },
    { id: "L1", role: "linked", why: [{ text: "obesity" }] },
    { id: "L2", role: "linked", why: [{ text: "obesity" }] },
  ];
  assert.deepStrictEqual(defaultCart(items), ["S", "L1"]);
});

// ---------------------------------------------------------------------------
console.log("checkout plan");

test("one independent branch per item, ending in its own output", () => {
  const { plan, outputs } = cartPlan([{ id: "CHD", kind: "value" }, { id: "HOSP", kind: "feature" }],
                                     { states: ["Missouri"] });
  assert.deepStrictEqual(plan.steps.map(s => s.op),
    ["load", "filter_area", "output", "count_features", "filter_area", "output"]);
  assert.deepStrictEqual(outputs.map(o => o.item), ["CHD", "HOSP"]);
  const ids = plan.steps.map(s => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, "step ids are unique");
  for (const s of plan.steps) for (const i of s.inputs) assert.ok(ids.includes(i));
});

test("empty, oversized and raster carts are refused", () => {
  assert.throws(() => cartPlan([]), CartError);
  assert.throws(() => cartPlan(Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ id: `a${i}`, kind: "value" }))), CartError);
  assert.throws(() => cartPlan([{ id: "NLCD", kind: "raster" }]), /raster/);
});

// ---------------------------------------------------------------------------
console.log("wide table");

test("LEFT join: a county one item lacks keeps its row, with an empty cell", () => {
  const counties = [{ fips: "29001", name: "Adair" }, { fips: "29003", name: "Andrew" },
                    { fips: "17001", name: "Adams" }];
  const columns = [{ item: "A", step: "o1" }, { item: "B", step: "o2" }];
  const layers = [
    { id: "o1", rows: [{ fips: "29001", value: 1 }, { fips: "29003", value: 2 }, { fips: "17001", value: 3 }] },
    { id: "o2", rows: [{ fips: "29001", value: 0 }] },       // 0 is a value, not missing
  ];
  const t = wideTable(counties, columns, layers, { stateNames: new Map([["29", "Missouri"], ["17", "Illinois"]]) });
  assert.strictEqual(t.rows.length, 3);
  assert.deepStrictEqual(t.rows[0].values, [1, 0]);
  assert.deepStrictEqual(t.rows[1].values, [2, null]);
  assert.deepStrictEqual(t.missing, [0, 2]);
  assert.strictEqual(t.rows[2].state, "Illinois");
});

test("a state restriction keeps only that state's counties", () => {
  const counties = [{ fips: "29001", name: "Adair" }, { fips: "17001", name: "Adams" }];
  const t = wideTable(counties, [{ item: "A", step: "o1" }], [{ id: "o1", rows: [] }],
    { states: ["Missouri"], stateNames: new Map([["29", "Missouri"], ["17", "Illinois"]]) });
  assert.deepStrictEqual(t.rows.map(r => r.fips), ["29001"]);
  assert.deepStrictEqual(t.missing, [1]);
});

// ---------------------------------------------------------------------------
console.log("model companion");

test("a duplicated column is set aside, and the others still get a partial rho", () => {
  // y depends on a and b; c is a copy of a (two sources of one estimate).
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const rows = Array.from({ length: 200 }, (_, i) => {
    const a = rnd(), b = rnd();
    return { fips: String(10000 + i), y: 2 * a + b + 0.3 * rnd(), x: [a, b, a * 1.0001 + 1] };
  });
  const out = partialCompanion(rows, ["A", "B", "A copy"], new Map());
  assert.strictEqual(out[2].status, "same_measure_as_another_column");
  assert.strictEqual(out[2].same_as, "A");
  assert.strictEqual(out[0].status, "ok");
  assert.strictEqual(out[1].status, "ok");
  assert.ok(out[0].partial_rho > 0.8, `A partial ${out[0].partial_rho}`);
  assert.ok(out[1].partial_rho > 0.5, `B partial ${out[1].partial_rho}`);
});

console.log(`\n${passed} passed`);
