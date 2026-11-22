/**
 * Rasters over units (docs/GIS_OPS_PLAN.md H4): zonal validates, compiles per
 * year, maps class labels AND groups to codes, takes a pixel threshold, and
 * reports share / area / mean as code decides from the question. A raster
 * cannot be loaded as a series. No model or database.
 * Run: node backend/planner/test_zonal.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const ops = require("./ops");
const { applyRasterMeasures } = require("./features");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const classes = [
  { value: 21, label: "Developed, Open Space", grp: "Developed" },
  { value: 22, label: "Developed, Low Intensity", grp: "Developed" },
  { value: 41, label: "Deciduous Forest", grp: "Forest" },
  { value: 82, label: "Cultivated Crops", grp: "Planted/Cultivated" },
];
const layer = (year) => ({ id: `lc${year}`, year, table_name: `raster_lc${year}`, srid: 5070,
                           extent: [0, 0, 1000, 1000] });
const SRC = new Map([
  ["LC", { source_kind: "raster", raster_kind: "categorical", aggregate: "class", pixel_area_m2: 900,
           layers: [layer(2001), layer(2021)], classes, label_columns: ["type"],
           filter_values: { type: ["Developed", "Forest", "Planted/Cultivated", ...classes.map(c => c.label)] } }],
  ["SLOPE", { source_kind: "raster", raster_kind: "continuous", aggregate: "mean", pixel_area_m2: 100,
              layers: [layer(2026)], classes: [], label_columns: [], filter_values: {} }],
  ["POP", { source_kind: "acs_long", census_code: "POP", description: "Total population" }],
]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const srcOf = (id) => SRC.get(id);
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
const zonal = (id, attr, extra = {}) => ({ id, op: "zonal", attr_id: attr, inputs: [], ...extra });

function sane(o) {
  const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  assert.strictEqual(used.size, o.params.length, `uses ${[...used]} binds ${o.params.length}`);
  let d = 0;
  for (const ch of o.sql.replace(/'[^']*'/g, "")) { if (ch === "(") d++; if (ch === ")") { d--; assert.ok(d >= 0); } }
  assert.strictEqual(d, 0, "unbalanced parentheses");
}

(async () => {
  await test("a class GROUP maps to every code in it; share of each unit", async () => {
    const p = plan(zonal("s1", "LC", { year: 2021, attribute_filters: [{ column: "type", value: "Developed" }] }),
                   out("s2", "s1"));
    applyRasterMeasures(p, "What percentage of each Chicago community area was developed land in 2021?", srcOf);
    assert.strictEqual(p.steps[0].stat, "share");
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const c = compilePlan(p, v.resolved);
    sane(c.outputs[0]);
    assert.ok(c.outputs[0].params.some(x => Array.isArray(x) && x.join() === "21,22"), "Developed = 21, 22");
    assert.match(c.sql, /FROM raster_lc2021 r/);
    assert.match(c.sql, /100\.0 \* count\(v\) FILTER/);
    assert.match(c.sql, /ST_Clip\(r\.rast, 1, gg\.g, true\)/);
  });

  await test("year picks the vintage; no year is the latest; a missing year names the ones loaded", async () => {
    const a = plan(zonal("s1", "LC", { year: 2001, attribute_filters: [{ column: "type", value: "Forest" }] }), out("s2", "s1"));
    assert.match(compilePlan(a, (await validatePlan(a, resolve)).resolved).sql, /raster_lc2001/);
    const b = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Forest" }] }), out("s2", "s1"));
    assert.match(compilePlan(b, (await validatePlan(b, resolve)).resolved).sql, /raster_lc2021/);
    const c = plan(zonal("s1", "LC", { year: 2011, attribute_filters: [{ column: "type", value: "Forest" }] }), out("s2", "s1"));
    assert.throws(() => compilePlan(c, new Map([["LC", SRC.get("LC")]])), /years loaded: 2001, 2021/);
  });

  await test("acres asked: area in acres, from the pixel area", async () => {
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Cultivated Crops" }] }), out("s2", "s1"));
    applyRasterMeasures(p, "How many acres of cropland are in each county?", srcOf);
    assert.strictEqual(p.steps[0].stat, "area");
    assert.strictEqual(p.steps[0].unit, "acres");
    const c = compilePlan(p, (await validatePlan(p, resolve)).resolved);
    sane(c.outputs[0]);
    assert.ok(c.outputs[0].params.some(x => Math.abs(x - 900 / 4046.8564224) < 1e-12), "900 m2 per pixel, in acres");
  });

  await test("a threshold on a continuous raster: share when asked, not a percent threshold", async () => {
    const p = plan(zonal("s1", "SLOPE", { operator: "<", value: 5 }), out("s2", "s1"));
    applyRasterMeasures(p, "What percentage of each St. Louis ward has a slope under 5 percent?", srcOf);
    assert.strictEqual(p.steps[0].stat, "share");
    const c = compilePlan(p, (await validatePlan(p, resolve)).resolved);
    sane(c.outputs[0]);
    assert.match(c.sql, /FILTER \(WHERE v < \$\d+::float8\)/);
    const q = plan(zonal("s1", "SLOPE", { operator: ">", value: 10 }), out("s2", "s1"));
    applyRasterMeasures(q, "Which neighborhoods have the most land with slope over 10 percent?", srcOf);
    assert.strictEqual(q.steps[0].stat, "area", "'10 percent' is the threshold, not a share");
  });

  await test("a continuous raster with nothing selected is its mean", async () => {
    const p = plan(zonal("s1", "SLOPE"), out("s2", "s1"));
    applyRasterMeasures(p, "What is the average slope of each St. Louis neighborhood?", srcOf);
    assert.strictEqual(p.steps[0].stat, "mean");
    const c = compilePlan(p, (await validatePlan(p, resolve)).resolved);
    sane(c.outputs[0]);
    assert.match(c.sql, /avg\(v\) AS value/);
  });

  await test("a raster cannot be loaded as a series, and zonal reads only rasters", async () => {
    const a = plan({ id: "s1", op: "load", attr_id: "LC", inputs: [] }, out("s2", "s1"));
    const va = await validatePlan(a, resolve);
    assert.ok(!va.ok && va.errors.some(e => /is a raster .*Use op "zonal"/.test(e)), va.errors.join("; "));
    const b = plan(zonal("s1", "POP"), out("s2", "s1"));
    const vb = await validatePlan(b, resolve);
    assert.ok(!vb.ok && vb.errors.some(e => /is not a raster/.test(e)), vb.errors.join("; "));
  });

  await test("an unknown class is refused by the validator with the real ones", async () => {
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Cropland" }] }), out("s2", "s1"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok && v.errors.some(e => /Valid values: .*Planted\/Cultivated/.test(e)), v.errors.join("; "));
  });

  await test("zonal composes: two years into combine is a change", async () => {
    const f = [{ column: "type", value: "Developed" }];
    const p = plan(zonal("s1", "LC", { year: 2001, attribute_filters: f }),
                   zonal("s2", "LC", { year: 2021, attribute_filters: f }),
                   { id: "s3", op: "combine", attr_id: "", inputs: ["s2", "s1"], operation: "difference" },
                   out("s4", "s3"));
    applyRasterMeasures(p, "How many acres of developed land were added in St. Charles County between 2001 and 2021?", srcOf);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    sane(compilePlan(p, v.resolved).outputs[0]);
  });

  await test("counties of a categorical raster read the load-time class cache", async () => {
    const cached = { ...SRC.get("LC"), layers: [{ ...layer(2021), cached_levels: ["county"] }] };
    const r = async (ids) => new Map(ids.map(i => [i, i === "LC" ? cached : SRC.get(i)]));
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Developed" }] }), out("s2", "s1"));
    applyRasterMeasures(p, "what percent of each Missouri county is developed", srcOf);
    const c = compilePlan(p, (await validatePlan(p, r)).resolved);
    sane(c.outputs[0]);
    // Area too: the live path's pixel factor must not stay bound and unused
    // (H4 dev f1: "could not determine data type of parameter $2").
    const a = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Cultivated Crops" }] }), out("s2", "s1"));
    applyRasterMeasures(a, "how many acres of cropland in each county", srcOf);
    sane(compilePlan(a, (await validatePlan(a, r)).resolved).outputs[0]);
    assert.match(c.sql, /FROM raster_unit_count c WHERE c\.raster_id = \$\d+ AND c\.level = 'county'/);
    assert.match(c.sql, /FILTER \(WHERE \(c\.value = ANY/);
    assert.doesNotMatch(c.sql, /ST_Clip/);
    // A threshold, or a unit below the county, is clipped live.
    const t = plan(zonal("s1", "SLOPE", { operator: "<", value: 5 }), out("s2", "s1"));
    assert.match(compilePlan(t, (await validatePlan(t, r)).resolved).sql, /ST_Clip/);
  });

  await test("an equality filter on a number the question never states is dropped", () => {
    // H4 dev: "average elevation of each St. Louis ward" planned filter_attr(= 1).
    const { dropUnaskedEquality } = require("./index");
    const p = plan(zonal("s1", "SLOPE"), { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: "=", value: 1 }, out("s3", "s2"));
    assert.ok(dropUnaskedEquality(p, "What is the average elevation of each St. Louis ward?"));
    assert.deepStrictEqual(p.steps.map(s => s.op), ["zonal", "output"]);
    assert.deepStrictEqual(p.steps[1].inputs, ["s1"]);
    const q = plan(zonal("s1", "SLOPE"), { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: "=", value: 3 }, out("s3", "s2"));
    assert.strictEqual(dropUnaskedEquality(q, "counties with code 3"), null, "a stated value stays");
    const r = plan(zonal("s1", "SLOPE"), { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: ">", value: 100000 }, out("s3", "s2"));
    assert.strictEqual(dropUnaskedEquality(r, "uninsured rates in big counties"), null, "inequalities stay");
    // "... and no hospital": count_features "= 0" is the question (H4 guards).
    const n = plan({ id: "s1", op: "count_features", attr_id: "HOSP", inputs: [] },
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: "=", value: 0 }, out("s3", "s2"));
    assert.strictEqual(dropUnaskedEquality(n, "Which rural counties have a poverty rate above 20% and no hospital?"), null);
  });

  await test("a land-class raster with no classes chosen is refused, listing them", async () => {
    const p = plan(zonal("s1", "LC"), out("s2", "s1"));
    const v = await validatePlan(p, resolve);
    assert.ok(!v.ok && v.errors.some(e => /land-class raster; say which classes .*"Cultivated Crops"/.test(e)), v.errors.join("; "));
    const q = plan(zonal("s1", "SLOPE"), out("s2", "s1"));
    assert.ok((await validatePlan(q, resolve)).ok, "a continuous raster needs no classes");
  });

  await test("a class filter survives the unasked-filter drop by its stem", () => {
    const { dropUnaskedFilters } = require("./index");
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Cultivated Crops" }] }), out("s2", "s1"));
    assert.strictEqual(dropUnaskedFilters(p, "How many acres of cultivated cropland did each county gain"), null);
    const q = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Deciduous Forest" }] }), out("s2", "s1"));
    assert.ok(dropUnaskedFilters(q, "how many acres of cultivated cropland"), "an unrelated class is still dropped");
  });

  await test("classes the question names are filled from the legend when the model leaves them out", () => {
    const { fillRasterClasses } = require("./features");
    const go = (q) => { const p = plan(zonal("s1", "LC"), out("s2", "s1")); fillRasterClasses(p, q, srcOf); return p.steps[0].attribute_filters?.map(f => f.value) || null; };
    assert.deepStrictEqual(go("How many acres of cultivated cropland did each Missouri county gain"), ["Cultivated Crops"]);
    assert.deepStrictEqual(go("What percentage of each Chicago community area was developed land"), ["Developed"]);
    assert.deepStrictEqual(go("What share of Cook County was forest in 2001"), ["Forest"]);
    assert.strictEqual(go("what is the land cover of each county"), null, "nothing named, nothing added");
    const kept = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Forest" }] }), out("s2", "s1"));
    assert.strictEqual(fillRasterClasses(kept, "developed land", srcOf), null, "the model's own choice stands");
  });

  await test("a change over two years reads later minus earlier", () => {
    const { orderChangeByYear } = require("./rewire");
    const f = [{ column: "type", value: "Cultivated Crops" }];
    const mk = (op, inputs) => plan(zonal("s1", "LC", { year: 2001, attribute_filters: f }),
      zonal("s2", "LC", { year: 2021, attribute_filters: f }),
      { id: "s3", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] },
      { id: "s4", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Missouri"] },
      { id: "s5", op: "combine", attr_id: "", inputs, operation: op }, out("s6", "s5"));
    // H4 dev f1: 2001 - 2021, right size, wrong sign.
    const d = mk("difference", ["s3", "s4"]);
    assert.ok(orderChangeByYear(d));
    assert.deepStrictEqual(d.steps[4].inputs, ["s4", "s3"]);
    const ok = mk("difference", ["s4", "s3"]);
    assert.strictEqual(orderChangeByYear(ok), null);
    // percent_change takes the baseline first.
    const pc = mk("percent_change", ["s4", "s3"]);
    assert.ok(orderChangeByYear(pc));
    assert.deepStrictEqual(pc.steps[4].inputs, ["s3", "s4"]);
    // Two different measures are not a change over time.
    const two = plan(zonal("s1", "LC", { year: 2001, attribute_filters: f }), zonal("s2", "SLOPE", { year: 2026 }),
      { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" }, out("s4", "s3"));
    assert.strictEqual(orderChangeByYear(two), null);
  });

  await test("a raster's year given as a value is read as the year", () => {
    const { yearAsVintage } = require("./features");
    // H4 dev: the DEM's year 2026 as a pixel threshold, and as filter_attr steps.
    const a = plan(zonal("s1", "SLOPE", { operator: "=", value: 2026 }), out("s2", "s1"));
    assert.ok(yearAsVintage(a, srcOf));
    assert.strictEqual(a.steps[0].operator, undefined);
    assert.strictEqual(a.steps[0].year, 2026);
    const b = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Forest" }] }),
      { id: "s2", op: "filter_attr", attr_id: "", inputs: ["s1"], operator: "=", value: 2001 }, out("s3", "s2"));
    assert.ok(yearAsVintage(b, srcOf));
    assert.deepStrictEqual(b.steps.map(s => s.op), ["zonal", "output"]);
    assert.strictEqual(b.steps[0].year, 2001);
    // A real threshold is left alone.
    const c = plan(zonal("s1", "SLOPE", { operator: "<", value: 5 }), out("s2", "s1"));
    assert.strictEqual(yearAsVintage(c, srcOf), null);
  });

  await test("a lone result with no output gets one; two unread results do not", () => {
    const { addMissingOutput } = require("./rewire");
    const a = plan(zonal("s1", "SLOPE"));
    assert.ok(addMissingOutput(a));
    assert.deepStrictEqual(a.steps.map(s => [s.op, s.inputs]), [["zonal", []], ["output", ["s1"]]]);
    const b = plan(zonal("s1", "SLOPE"), zonal("s2", "LC"));
    assert.strictEqual(addMissingOutput(b), null);
    const c = plan(zonal("s1", "SLOPE"), out("s2", "s1"));
    assert.strictEqual(addMissingOutput(c), null);
  });

  await test("a runaway op is withheld from a retry's schema, never from the original", () => {
    const { withoutOps } = require("./index");
    const { planSchemaFor } = require("../schemas");
    const s = planSchemaFor({ query: "x", hasRaster: true });
    const t = withoutOps(s, new Set(["filter_attr"]));
    assert.ok(!t.properties.steps.items.properties.op.enum.includes("filter_attr"));
    assert.ok(s.properties.steps.items.properties.op.enum.includes("filter_attr"), "the original schema is not mutated");
  });

  await test("zonal is offered only with a raster on the list", () => {
    assert.ok(ops.offeredFor({ query: "share of cropland", hasRaster: true }).includes("zonal"));
    assert.ok(!ops.offeredFor({ query: "share of cropland" }).includes("zonal"));
  });

  // ------------------------------------------------ zonal over features (H4 remainder)
  SRC.set("CAMPUS", { source_kind: "feature_table", table_name: "campus_tbl", geom_column: "geom",
                      label_columns: ["name", "city", "state"], filter_values: {}, value_columns: [] });
  const { zonalFeatureAlgebra, zonalOverFeatures, namedPolygonLayers } = require("./features");
  const sel = (id, extra = {}) => ({ id, op: "select_features", attr_id: "CAMPUS", inputs: [], ...extra });
  const cands = [
    { attr_id: "CAMPUS", is_feature_table: true, spatial_rep: "POLYGON", dataset_clean: "College University Campuses" },
    { attr_id: "HOSP", is_feature_table: true, spatial_rep: "POINT", dataset_clean: "Hospitals" },
    { attr_id: "LC", is_raster: true },
  ];

  for (const [stat, q, filt] of [
    ["share", "What percentage of each college campus in Missouri is forest?", { attribute_filters: [{ column: "type", value: "Forest" }] }],
    ["area", "How many acres of developed land are on each college campus in Missouri?", { attribute_filters: [{ column: "type", value: "Developed" }] }],
  ]) {
    await test(`over features: ${stat} compiles, features out, every bind used`, async () => {
      const p = plan(sel("s1", { states: ["Missouri"] }), zonal("s2", "LC", { inputs: ["s1"], ...filt }), out("s3", "s2"));
      applyRasterMeasures(p, q, srcOf);
      assert.strictEqual(p.steps[1].stat, stat);
      const v = await validatePlan(p, resolve);
      assert.ok(v.ok, v.errors.join("; "));
      const c = compilePlan(p, v.resolved);
      const o = c.outputs[0];
      sane(o);
      assert.strictEqual(o.mode, "features");
      assert.ok(o.labels.includes("zonal_value"), o.labels.join(","));
      assert.match(o.sql, /ST_Clip\(r\.rast, 1, gg\.g, true\)/);
      assert.match(o.sql, /ST_PointOnSurface/, "a sub-pixel polygon reads its interior pixel");
      assert.match(o.sql, /pt\.pv = ANY/, "the fallback applies the same classes");
      assert.doesNotMatch(o.sql, /raster_unit_count/, "the county cache never stands in for features");
      assert.match(o.valueLabel, stat === "share" ? /percent of its area/ : /acres/);
    });
  }

  await test("over features: a continuous mean, ranked; the rank reads features", async () => {
    const p = plan(sel("s1", { city: "St. Louis", states: ["Missouri"] }), zonal("s2", "SLOPE", { inputs: ["s1"] }),
                   { id: "s3", op: "rank", attr_id: "", inputs: ["s2"], direction: "desc", limit: 5 }, out("s4", "s3"));
    applyRasterMeasures(p, "Which five college campuses in St. Louis have the steepest average slope?", srcOf);
    const v = await validatePlan(p, resolve);
    assert.ok(v.ok, v.errors.join("; "));
    const o = compilePlan(p, v.resolved).outputs[0];
    sane(o);
    assert.strictEqual(o.mode, "features");
    assert.match(o.sql, /ORDER BY r\.value DESC/);
  });

  await test("a series cannot feed zonal; a features zonal cannot feed filter_area", async () => {
    const p1 = plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] }, zonal("s2", "SLOPE", { inputs: ["s1"] }), out("s3", "s2"));
    assert.ok(!(await validatePlan(p1, resolve)).ok);
    const p2 = plan(sel("s1"), zonal("s2", "SLOPE", { inputs: ["s1"] }),
                    { id: "s3", op: "filter_area", attr_id: "", inputs: ["s2"], states: ["Missouri"] }, out("s4", "s3"));
    assert.ok(!(await validatePlan(p2, resolve)).ok);
  });

  await test("a raster without a pixel area refuses features", async () => {
    SRC.set("WP", { source_kind: "raster", aggregate: "sum", layers: [layer(2025)], classes: [], label_columns: [], filter_values: {} });
    const p = plan(sel("s1"), zonal("s2", "WP", { inputs: ["s1"] }), out("s3", "s2"));
    const v = await validatePlan(p, resolve);
    assert.throws(() => compilePlan(p, v.resolved), /equal-area raster/);
  });

  await test("gate: a named polygon layer beside a raster, not units, not people", () => {
    const ctx = (q) => ({ query: q, hasRaster: true, hasFeatureTables: true, featureTableCount: 2,
                          ...(namedPolygonLayers(q, cands).length ? { namesPolygonLayer: true } : {}) });
    assert.deepStrictEqual(namedPolygonLayers("What percentage of each college campus in Missouri is forest?", cands), ["CAMPUS"]);
    assert.ok(zonalFeatureAlgebra(ctx("What percentage of each college campus in Missouri is forest?")));
    assert.ok(!zonalFeatureAlgebra(ctx("What percentage of each Missouri county is forest?")), "no layer named");
    assert.ok(!zonalFeatureAlgebra(ctx("What share of each county's college campus land is forest?")), "per county");
    assert.ok(!zonalFeatureAlgebra(ctx("How many people live on college campuses in forest?")), "people");
    assert.ok(!zonalFeatureAlgebra({ query: "each college campus forest share", namesPolygonLayer: true }), "no raster");
    // Hospitals are points: not a zone.
    assert.deepStrictEqual(namedPolygonLayers("average elevation of each hospital", cands), []);
    const offered = ops.offeredFor(ctx("What percentage of each college campus in Missouri is forest?"));
    assert.ok(offered.includes("select_features") && offered.includes("zonal"));
  });

  await test("repair: zonal -> filter_area becomes select_features(states) -> zonal", () => {
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Forest" }] }),
                   { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] }, out("s3", "s2"));
    const fix = zonalOverFeatures(p, { asks: true, layers: ["CAMPUS"] });
    assert.ok(fix, "repaired");
    const s = p.steps.find(x => x.op === "select_features");
    assert.deepStrictEqual(s.states, ["Missouri"]);
    assert.deepStrictEqual(p.steps.find(x => x.op === "zonal").inputs, [s.id]);
    assert.ok(!p.steps.some(x => x.op === "filter_area"));
    assert.strictEqual(p.steps.find(x => x.op === "output").inputs[0], p.steps.find(x => x.op === "zonal").id);
  });

  await test("repair: a city filter moves on, a bare features output is dropped, rank stays", () => {
    const p = plan(sel("s1"), out("s2", "s1"), zonal("s3", "SLOPE"),
                   { id: "s4", op: "filter_place", attr_id: "", inputs: ["s3"], place_kind: "place", place_name: "St. Louis", states: ["Missouri"] },
                   { id: "s5", op: "rank", attr_id: "", inputs: ["s4"], direction: "desc", limit: 5 }, out("s6", "s5"));
    zonalOverFeatures(p, { asks: true, layers: ["CAMPUS"] });
    assert.strictEqual(p.steps[0].city, "St. Louis");
    assert.deepStrictEqual(p.steps[0].states, ["Missouri"]);
    assert.deepStrictEqual(p.steps.map(x => x.op), ["select_features", "zonal", "rank", "output"]);
    assert.deepStrictEqual(p.steps.find(x => x.op === "rank").inputs, ["s3"]);
  });

  await test("repair: zones on a point layer swap to the named polygon layer", () => {
    const p = plan({ id: "s1", op: "select_features", attr_id: "PTS", inputs: [], states: ["Illinois"],
                     attribute_filters: [{ column: "status", value: "Not on the NPL" }] },
                   zonal("s2", "LC", { inputs: ["s1"] }), out("s3", "s2"));
    const fix = zonalOverFeatures(p, { asks: true, layers: ["CAMPUS"], isNotPolygon: (id) => id === "PTS" });
    assert.match(fix, /polygon layer/);
    assert.strictEqual(p.steps[0].attr_id, "CAMPUS");
    assert.deepStrictEqual(p.steps[0].states, ["Illinois"], "the place stays");
    assert.strictEqual(p.steps[0].attribute_filters, undefined, "the point layer's filter goes with it");
  });

  await test("repair: inert without the gate, and on units zonal", () => {
    const p = plan(zonal("s1", "LC", { attribute_filters: [{ column: "type", value: "Forest" }] }),
                   { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] }, out("s3", "s2"));
    const before = JSON.stringify(p);
    assert.strictEqual(zonalOverFeatures(p, { asks: false, layers: ["CAMPUS"] }), null);
    assert.strictEqual(JSON.stringify(p), before);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
