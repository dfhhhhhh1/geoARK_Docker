/**
 * Tests for the multi-scale map's decisions (backend/geo_layers.js).
 *
 * The two that would mislead without anything looking wrong:
 *   - which level is drawn (too fine drowns the browser; too coarse hides the
 *     detail the user zoomed in for), and
 *   - which levels a measure may be ESTIMATED at. A percentile averaged across
 *     tracts is not a county percentile, and a rate with nothing to weight it
 *     by would be weighted by empty land.
 *
 * The database half (geoark_aggregate against published values) is checked in
 * docs/DATA_LOADING_PLAN.md, Progress, Phase 6.
 *
 * Run: node backend/test_geo_layers.js
 */

const assert = require("node:assert");
const {
  parseBbox, derivationsFor, chooseLevel, BUDGET_POLY, BUDGET_CELL,
} = require("./geo_layers");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

// --- bbox -------------------------------------------------------------------
test("bbox parses west,south,east,north", () => {
  assert.deepStrictEqual(parseBbox("-95.8,35.9,-89.1,40.6"), [-95.8, 35.9, -89.1, 40.6]);
});
test("bbox clamps a pan past the antimeridian and the poles", () => {
  assert.deepStrictEqual(parseBbox("-200,-89,190,89"), [-180, -85, 180, 85]);
});
test("bbox rejects inverted, degenerate and malformed boxes", () => {
  assert.strictEqual(parseBbox("-89,35,-95,40"), null);
  assert.strictEqual(parseBbox("-90,38,-90,38"), null);
  assert.strictEqual(parseBbox("a,b,c,d"), null);
  assert.strictEqual(parseBbox("1,2,3"), null);
  assert.strictEqual(parseBbox(undefined), null);
});

// --- level choice -------------------------------------------------------------
const admin = [{ level: "tract" }, { level: "county" }];
test("the finest level that fits is drawn", () => {
  assert.deepStrictEqual(chooseLevel(admin, { tract: 264, county: 5 }).level, "tract");
});
test("too many tracts falls back to counties", () => {
  assert.strictEqual(chooseLevel(admin, { tract: 14300, county: 896 }).level, "county");
});
test("every county fits: the national county map is the baseline view", () => {
  assert.ok(BUDGET_POLY >= 3233);
  assert.strictEqual(chooseLevel(admin, { tract: 85529, county: 3233 }).level, "county");
});
test("nothing fits: coarsest level, flagged, not a truncated subset", () => {
  const r = chooseLevel([{ level: "tract" }], { tract: 85529 });
  assert.strictEqual(r.level, "tract");
  assert.match(r.reason, /over budget/);
});
test("pixels use the denser cell budget", () => {
  const grid = [{ level: "pixel" }, { level: "grid4k" }];
  assert.ok(BUDGET_CELL > BUDGET_POLY);
  assert.strictEqual(chooseLevel(grid, { pixel: BUDGET_POLY + 1, grid4k: 100 }).level, "pixel");
  assert.strictEqual(chooseLevel(grid, { pixel: BUDGET_CELL + 1, grid4k: 100 }).level, "grid4k");
});

// --- what may be estimated ------------------------------------------------------
const lv = (...names) => Object.fromEntries(names.map((n) => [n, { min_year: 2022, max_year: 2022 }]));
const sviPop = { code: "SVI_E_TOTPOP", dataset_id: "ing_svi_01", units: "persons", levels: lv("tract", "county") };
const sviPov = { code: "SVI_EP_POV150", dataset_id: "ing_svi_01", units: "percent", levels: lv("tract", "county") };
const sviRpl = { code: "SVI_RPL_THEMES", dataset_id: "ing_svi_01", units: "percentile 0-1", levels: lv("tract", "county") };
const plPop = { code: "PLACES_TOTALPOPULATION", dataset_id: "ing_places_01", units: "persons", levels: lv("zcta") };
const plDia = { code: "PLACES_DIABETES_CrdPrv", dataset_id: "ing_places_01", units: null, levels: lv("zcta", "county") };
const wp = { code: "WORLDPOP_POP", dataset_id: "ing_worldpop_01", units: "persons", levels: lv("tract", "zcta", "county") };
const all = [sviPop, sviPov, sviRpl, plPop, plDia, wp];

test("a rate is filled at county from tracts, weighted by its own dataset's population", () => {
  const d = derivationsFor(sviPov, false, all);
  assert.deepStrictEqual(d.county, { from: "tract", method: "wmean", weight: "SVI_E_TOTPOP" });
  assert.deepStrictEqual(d.zcta, { from: "tract", method: "wmean", weight: "SVI_E_TOTPOP" });
});
test("a count is summed, with no weight", () => {
  const d = derivationsFor(sviPop, true, all);
  assert.deepStrictEqual(d.county, { from: "tract", method: "sum", weight: null });
});
test("a percentile rank is never estimated", () => {
  assert.deepStrictEqual(derivationsFor(sviRpl, false, all), {});
});
test("ZIP-level data fills counties through the crosswalk", () => {
  const d = derivationsFor(plDia, false, all);
  assert.deepStrictEqual(d.county, { from: "zcta", method: "wmean", weight: "PLACES_TOTALPOPULATION" });
  assert.strictEqual(d.zcta, undefined);
});
test("a rate falls back to WorldPop population when its dataset has none", () => {
  const other = { code: "X_RATE", dataset_id: "ing_x_01", units: "percent", levels: lv("tract") };
  assert.strictEqual(derivationsFor(other, false, [...all, other]).county.weight, "WORLDPOP_POP");
});
test("a rate with no population anywhere is not offered", () => {
  const lone = { code: "Y_RATE", dataset_id: "ing_y_01", units: "percent", levels: lv("tract") };
  assert.deepStrictEqual(derivationsFor(lone, false, [lone]), {});
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
