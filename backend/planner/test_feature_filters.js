/**
 * Numeric and date filters on feature columns (planner/feature_filters.js,
 * docs/GIS_OPS_PLAN.md H6 tier 1 item 2): parsing, grounding, what it refuses
 * to guess, validation and compilation. No model or database.
 * Run: node backend/planner/test_feature_filters.js
 */

const assert = require("node:assert");
const { numericMentions, dateMentions, groundColumn, applyValueFilters } = require("./feature_filters");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const col = (column, kind, extra = {}) => ({ column, kind, min: 0, max: 1000, n: 10, sentinel: null,
  record: false, label: "", description: "", tags: [], ...extra });
// Columns as discovery reports them, from the live layers (2026-11-20).
const LAYERS = {
  HOSP: { name: "Hospitals", columns: [
    col("population", "number", { sentinel: -999 }),
    col("beds", "number", { max: 1592, sentinel: -999, label: "Beds", tags: ["hospital beds", "capacity"] }),
    col("sourcedate", "date", { record: true, min: "2012-06-05", max: "2020-04-27" }),
    col("val_date", "date", { record: true }),
  ] },
  NH: { name: "Nursing Homes", columns: [
    col("tot_res", "number"), col("beds", "number", { sentinel: -999 }), col("excess_bed", "number"),
  ] },
  TORN: { name: "Hist Tornado Tracks", columns: [
    col("yr", "year", { min: 1950, max: 2015, tags: ["tornado year"] }),
    col("mo", "number", { max: 12 }),
    col("mag", "number", { max: 5, tags: ["Tornado Intensity", "Tornado Magnitude"] }),
    col("inj", "number", { tags: ["injection rate", "tornado intensity"] }),
    col("fat", "number", { max: 158, tags: ["tornado intensity", "wind speed"] }),
    col("len", "number"),
  ] },
  COLL: { name: "College University Campuses", columns: [
    col("tot_enroll", "number", { sentinel: -999, label: "Tot Enroll", tags: ["total enrollment", "student population"] }),
    col("tot_emp", "number", { sentinel: -999 }),
  ] },
  LINES: { name: "Transmission Lines", columns: [col("voltage", "number", { sentinel: -999999, label: "Voltage" })] },
  PLANTS: { name: "Power Plants", columns: [
    col("capacity_mw", "number", { description: "Total nameplate capacity of the plant's operating generators (MW)" }),
    col("generators", "number"),
  ] },
  FIRE: { name: "Public Nifs Perimeters", columns: [
    col("gisacres", "number"),
    col("createdate", "date", { record: true }), col("datecurrent", "date", { record: true }),
    col("polygondatetime", "date", { min: "2019-09-15", max: "2021-05-11" }),
  ] },
  TUN: { name: "Road Tunnels", columns: [col("year_built", "year", { min: 1900, max: 2020, label: "Year built" }), col("lanes", "number")] },
  FUDS: { name: "Formerly Used Defense Sites", columns: [
    col("remedyinpl", "date"), col("responseco", "date"), col("sitecloseo", "date")] },
};
const info = (id) => LAYERS[id] || null;
const TODAY = new Date(Date.UTC(2026, 10, 20));
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const sel = (id, attr, extra = {}) => ({ id, op: "select_features", attr_id: attr, inputs: [], ...extra });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const run = (q, p) => { const r = applyValueFilters(p, q, info, TODAY); return { r, p }; };
const vf = (p, i = 0) => p.steps[i].value_filters?.map(({ said, ...f }) => f);

(async () => {
  await test("parse: prefix, suffix, between, thousands, k", () => {
    const m = (q) => numericMentions(q).map(x => `${x.operator}${x.value}:${x.words.join("+")}`);
    assert.deepStrictEqual(m("hospitals with more than 100 beds"), [">100:beds"]);
    assert.deepStrictEqual(m("colleges with at least 20,000 students"), [">=20000:students"]);
    assert.deepStrictEqual(m("power plants over 1.5k MW"), [">1500:mw"]);
    assert.deepStrictEqual(m("tornadoes of magnitude 4 or greater"), [">=4:magnitude"]);
    assert.deepStrictEqual(m("How many tornadoes of magnitude 3 or greater have crossed Oklahoma since 2005?"), [">=3:magnitude"]);
    assert.deepStrictEqual(m("hospitals with 200 beds or more"), [">=200:beds"]);
    assert.deepStrictEqual(m("nursing homes with between 50 and 100 beds"), [">=50:beds", "<=100:beds"]);
    assert.deepStrictEqual(m("lines with a voltage above 345"), [">345:voltage"]);
  });

  await test("parse: distances, percentages and years are not value comparisons", () => {
    assert.deepStrictEqual(numericMentions("hospitals more than 5 miles from a fire station"), []);
    assert.deepStrictEqual(numericMentions("counties with poverty over 20%"), []);
    assert.deepStrictEqual(numericMentions("tornadoes between 2000 and 2010"), []);
  });

  await test("parse: dates, absolute and relative", () => {
    const d = (q) => dateMentions(q, TODAY).map(x => `${x.from || ""}..${x.to || ""}`);
    assert.deepStrictEqual(d("tornadoes since 2010"), ["2010-01-01.."]);
    assert.deepStrictEqual(d("tornadoes after 2010"), ["2011-01-01.."]);
    assert.deepStrictEqual(d("tunnels built before 1950"), ["..1950-01-01"]);
    assert.deepStrictEqual(d("tornadoes in 2011"), ["2011-01-01..2012-01-01"]);
    assert.deepStrictEqual(d("the wildfire perimeters from 2020"), ["2020-01-01..2021-01-01"]);
    assert.deepStrictEqual(d("tornadoes from 2010 onward"), ["2010-01-01.."]);
    assert.deepStrictEqual(d("tornadoes from 2000 to 2010"), ["2000-01-01..2011-01-01"]);
    assert.deepStrictEqual(d("tornadoes between 2000 and 2010"), ["2000-01-01..2011-01-01"]);
    assert.deepStrictEqual(d("wildfires in the last 12 months"), ["2025-11-20.."]);
    assert.deepStrictEqual(d("wildfires in the past year"), ["2025-11-20.."]);
  });

  await test("ground: the column the words name; tags alone are not enough to choose", () => {
    assert.strictEqual(groundColumn(["beds"], LAYERS.HOSP.columns).column.column, "beds");
    assert.strictEqual(groundColumn(["students"], LAYERS.COLL.columns).column.column, "tot_enroll");
    assert.strictEqual(groundColumn(["kv"], LAYERS.LINES.columns).column.column, "voltage");
    assert.strictEqual(groundColumn(["mw"], LAYERS.PLANTS.columns).column.column, "capacity_mw");
    assert.strictEqual(groundColumn(["fatalities"], LAYERS.TORN.columns).column.column, "fat");
    assert.strictEqual(groundColumn(["magnitude"], LAYERS.TORN.columns).column.column, "mag");
    // "intensity" is a tag on mag, inj and fat alike: reported, not chosen.
    assert.deepStrictEqual(groundColumn(["intensity"], LAYERS.TORN.columns), { ambiguous: ["mag", "inj", "fat"] });
    // A word no column has is not a filter at all.
    assert.strictEqual(groundColumn(["poverty"], LAYERS.HOSP.columns), null);
    // beds vs excess_bed: the column that is wholly the asked word.
    assert.strictEqual(groundColumn(["beds"], LAYERS.NH.columns).column.column, "beds");
  });

  await test("apply: hospitals with more than 100 beds", () => {
    const { r, p } = run("Which hospitals in Missouri have more than 100 beds?", plan(sel("s1", "HOSP"), out("s2", "s1")));
    assert.deepStrictEqual(vf(p), [{ column: "beds", operator: ">", value: 100, kind: "number" }]);
    assert.match(r.fixes[0], /-999/);
  });

  await test("apply: a unit's comparison is not a feature filter", () => {
    for (const q of ["hospitals in counties with more than 100,000 people",
                     "counties with more than 1,000 hospital beds",
                     "how many hospitals are in tracts with more than 5000 residents"]) {
      const { p } = run(q, plan(sel("s1", "HOSP"), out("s2", "s1")));
      assert.strictEqual(vf(p), undefined, q);
    }
  });

  await test("apply: the layer's own name is not a column (counts of hospitals)", () => {
    const { p } = run("counties with more than 5 hospitals", plan(
      { id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] }, out("s2", "s1")));
    assert.strictEqual(vf(p), undefined);
  });

  await test("apply: dates, year column and event date; record dates never chosen", () => {
    let { p } = run("tornadoes since 2010 in Oklahoma", plan(sel("s1", "TORN"), out("s2", "s1")));
    assert.deepStrictEqual(vf(p), [{ column: "yr", operator: ">=", value: 2010, kind: "year" }]);
    ({ p } = run("tornadoes in 2011", plan(sel("s1", "TORN"), out("s2", "s1"))));
    assert.deepStrictEqual(vf(p).map(f => `${f.operator}${f.value}`), [">=2011", "<2012"]);
    ({ p } = run("wildfire perimeters since 2020", plan(sel("s1", "FIRE"), out("s2", "s1"))));
    assert.deepStrictEqual(vf(p), [{ column: "polygondatetime", operator: ">=", value: "2020-01-01", kind: "date" }]);
    ({ p } = run("road tunnels built before 1950", plan(sel("s1", "TUN"), out("s2", "s1"))));
    assert.deepStrictEqual(vf(p), [{ column: "year_built", operator: "<", value: 1950, kind: "year" }]);
    // Hospitals' only dates are record keeping: "since 2015" is not about them.
    ({ p } = run("hospitals opened since 2015", plan(sel("s1", "HOSP"), out("s2", "s1"))));
    assert.strictEqual(vf(p), undefined);
  });

  await test("apply: several event dates are reported, not chosen", () => {
    const { r, p } = run("defense sites since 2005", plan(sel("s1", "FUDS"), out("s2", "s1")));
    assert.strictEqual(vf(p), undefined);
    assert.match(r.notes[0], /could be any of remedyinpl, responseco, sitecloseo/);
  });

  await test("apply: a date past the layer's last record says so", () => {
    const { r } = run("tornadoes since 2020", plan(sel("s1", "TORN"), out("s2", "s1")));
    assert.match(r.notes.join(" "), /only through 2015/);
  });

  await test("apply: two layers, the filter goes to the one named before it", () => {
    const { p } = run("nursing homes within 5 miles of a hospital with more than 300 beds",
      plan(sel("s1", "NH"), sel("s2", "HOSP"),
           { id: "s3", op: "within", attr_id: "", inputs: ["s1", "s2"], miles: 5 }, out("s4", "s3")));
    assert.strictEqual(vf(p, 0), undefined);
    assert.deepStrictEqual(vf(p, 1), [{ column: "beds", operator: ">", value: 300, kind: "number" }]);
  });

  await test("apply: the model's filter_attr on a bare selection is folded in", () => {
    const { r, p } = run("hospitals with more than 100 beds", plan(sel("s1", "HOSP"),
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 100 }, out("s3", "s2")));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["select_features", "output"]);
    assert.deepStrictEqual(p.steps[1].inputs, ["s1"]);
    assert.match(r.fixes.join(" "), /folded/);
  });

  await test("apply: the model's filter_attr on a count, with the bed number, is folded; another number stays", () => {
    const cnt = (extra) => ({ id: "s1", op: "count_features", attr_id: "HOSP", inputs: [], ...extra });
    let { p } = run("hospitals in Missouri with more than 100 beds", plan(cnt(),
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 100 }, out("s3", "s2")));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["count_features", "output"]);
    // ... and an aggregate count after it then counted counties: it becomes a sum.
    ({ p } = run("How many hospitals in Arizona have fewer than 50 beds?", plan(cnt(),
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: "<", value: 50 },
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Arizona"] },
      { id: "s4", op: "aggregate", attr_id: "", inputs: ["s3"], function: "count" }, out("s5", "s4"))));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["count_features", "filter_area", "aggregate", "output"]);
    assert.strictEqual(p.steps[2].function, "sum");
    ({ p } = run("counties with more than 3 hospitals with more than 100 beds", plan(cnt(),
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 3 }, out("s3", "s2"))));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["count_features", "filter_attr", "output"]);
    assert.deepStrictEqual(vf(p), [{ column: "beds", operator: ">", value: 100, kind: "number" }]);
  });

  await test("apply: a filter_attr after an area step is folded too (Missouri tornadoes, over 50 injuries)", () => {
    const cnt = { id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] };
    const { p } = run("Count the Missouri hospitals with more than 100 beds", plan(cnt,
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      { id: "s3", op: "filter_attr", attr_id: "", inputs: ["s2"], operator: ">", value: 100 },
      { id: "s4", op: "aggregate", attr_id: "", inputs: ["s3"], function: "count" }, out("s5", "s4")));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["count_features", "filter_area", "aggregate", "output"]);
    assert.deepStrictEqual(p.steps[2].inputs, ["s2"]);
    assert.strictEqual(p.steps[2].function, "sum");
    // A number the question did not state on the layer stays a county threshold.
    const r = run("hospitals in Missouri counties with more than 3 hospitals with more than 100 beds", plan(cnt,
      { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      { id: "s3", op: "filter_attr", attr_id: "", inputs: ["s2"], operator: ">", value: 3 }, out("s4", "s3")));
    assert.deepStrictEqual(r.p.steps.map(s => s.op), ["count_features", "filter_area", "filter_attr", "output"]);
  });

  await test("load of the compared column becomes a count; an uncompared column load is left alone", () => {
    const { loadedColumnAsCount } = require("./feature_filters");
    const srcOf = (id) => ({ MAG: { source_kind: "feature_table", value_column: "mag", value_columns: LAYERS.TORN.columns },
                             BEDS: { source_kind: "feature_table", value_column: "beds", value_columns: LAYERS.HOSP.columns } })[id];
    const name = (id) => ({ MAG: "Hist Tornado Tracks", BEDS: "Hospitals" })[id];
    const q = "How many tornadoes of magnitude 3 or greater have crossed Oklahoma since 2005?";
    const p = plan({ id: "s1", op: "load", attr_id: "MAG", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">=", value: 3 }, out("s3", "s2"));
    assert.match(loadedColumnAsCount(p, q, srcOf, name), /counts Hist Tornado Tracks/);
    assert.strictEqual(p.steps[0].op, "count_features");
    const info2 = (id) => ({ MAG: LAYERS.TORN })[id];
    applyValueFilters(p, q, info2, TODAY);
    assert.deepStrictEqual(p.steps.map(s => s.op), ["count_features", "output"]);
    // "average beds per hospital": no comparison on beds, so no rewrite.
    const p2 = plan({ id: "s1", op: "load", attr_id: "BEDS", inputs: [] }, out("s2", "s1"));
    assert.strictEqual(loadedColumnAsCount(p2, "average beds per hospital in each county", srcOf, name), null);
    assert.strictEqual(p2.steps[0].op, "load");
  });

  await test("apply: no comparison, no change (and nothing returned)", () => {
    const p = plan(sel("s1", "HOSP"), out("s2", "s1"));
    assert.strictEqual(applyValueFilters(p, "where are the hospitals in Ohio", info, TODAY), null);
    assert.strictEqual(vf(p), undefined);
  });

  // ---- validation and compilation, against resolved rows
  const SRC = new Map([["HOSP", { source_kind: "feature_table", table_name: "hospitals", geom_column: "geom",
    label_columns: ["name", "city"], filter_values: {}, value_columns: LAYERS.HOSP.columns }],
    ["FIRE", { source_kind: "feature_table", table_name: "fires", geom_column: "geom",
    label_columns: ["name"], filter_values: {}, value_columns: LAYERS.FIRE.columns }]]);
  const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
  const paramsMatch = (o) => {
    const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
  };
  const compiled = async (p) => {
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    return c.outputs ? c.outputs : [c];
  };

  await test("compile: standalone selection, sentinel excluded, params bound", async () => {
    const [o] = await compiled(plan(sel("s1", "HOSP", { value_filters: [{ column: "beds", operator: "<", value: 50, kind: "number" }] }), out("s2", "s1")));
    assert.match(o.sql, /f\.beds < \$\d+ AND f\.beds <> \$\d+/);
    assert.ok(o.params.includes(50) && o.params.includes(-999));
    paramsMatch(o);
  });

  await test("compile: count_features puts it in the ON clause", async () => {
    const [o] = await compiled(plan({ id: "s1", op: "count_features", attr_id: "HOSP", inputs: [],
      value_filters: [{ column: "beds", operator: ">", value: 100, kind: "number" }] }, out("s2", "s1")));
    assert.match(o.sql, /LEFT JOIN hospitals f ON ST_Intersects\([^)]*\) AND f\.beds > \$\d+/);
    paramsMatch(o);
  });

  await test("compile: a date bound is cast to date", async () => {
    const [o] = await compiled(plan(sel("s1", "FIRE", { value_filters: [{ column: "polygondatetime", operator: ">=", value: "2020-01-01", kind: "date" }] }), out("s2", "s1")));
    assert.match(o.sql, /f\.polygondatetime >= \$\d+::date/);
    paramsMatch(o);
  });

  await test("validate: an undiscovered column, an equality or a non-date is refused", async () => {
    for (const [f, re] of [
      [{ column: "id; DROP TABLE x", operator: ">", value: 1 }, /no numeric or date column/],
      [{ column: "beds", operator: "=", value: 1 }, /not a comparison/],
      [{ column: "polygondatetime", operator: ">", value: "yesterday" }, /needs a date/],
    ]) {
      const attr = f.column === "polygondatetime" ? "FIRE" : "HOSP";
      const v = await validatePlan(plan(sel("s1", attr, { value_filters: [f] }), out("s2", "s1")), resolve);
      assert.ok(!v.ok && v.errors.some(e => re.test(e)), v.errors.join("; "));
    }
    const v = await validatePlan(plan(sel("s1", "HOSP"), { id: "s2", op: "output", attr_id: "", inputs: ["s1"],
      value_filters: [{ column: "beds", operator: ">", value: 1 }] }), resolve);
    assert.ok(!v.ok && v.errors.some(e => /only apply to/.test(e)));
  });

  await test("named data: a comparison a value filter carries is covered by its layer", async () => {
    const { checkNamedData } = require("./named_data");
    const q = "Show the wildfire perimeters from 2020 that burned more than 100,000 acres.";
    const p = plan(sel("s1", "FIRE"), out("s2", "s1"));
    applyValueFilters(p, q, info, TODAY);
    const callLLM = async () => JSON.stringify({ named: [
      { phrase: "wildfire perimeters from 2020", covered_by: "a1" },
      { phrase: "burned more than 100,000 acres", covered_by: "" }] });
    const args = { query: q, used: [{ attr_id: "FIRE", op: "select_features" }],
      candidates: [{ attr_id: "FIRE", attr_desc: "Wildfire perimeters", dataset_clean: "Public Nifs Perimeters" }],
      refs: new Map([["a1", "FIRE"]]), callLLM };
    const r = await checkNamedData({ ...args, plan: p });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.named.find(n => /acres/.test(n.phrase)).value_filter, "gisacres");
    // Without the filter it is still refused: the rule reads the plan, not the words.
    const bare = await checkNamedData({ ...args, plan: plan(sel("s1", "FIRE"), out("s2", "s1")) });
    assert.strictEqual(bare.errors.length, 1);
    // A different number is not covered by this filter.
    const other = await checkNamedData({ ...args, plan: p, callLLM: async () => JSON.stringify({ named: [
      { phrase: "more than 50,000 acres", covered_by: "" }] }), query: q + " Also more than 50,000 acres." });
    assert.strictEqual(other.errors.length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
