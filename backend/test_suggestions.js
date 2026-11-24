/**
 * Tests for follow-up suggestions.
 *
 * The property that matters: a suggestion is only ever built from a candidate
 * that RESOLVED. Suggesting something that fails the same way is worse than
 * suggesting nothing, because it costs the user another 30-second round trip to
 * find out.
 *
 * Run: node backend/test_suggestions.js
 */

const assert = require("node:assert");
const {
  buildSuggestions, unavailableDatasets, cityAmbiguity, shortLabel,
} = require("./suggestions");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

test("shortLabel strips ACS path noise down to the measure", () => {
  assert.strictEqual(
    shortLabel("Estimate!!INCOME AND BENEFITS!!Total households!!Median income (dollars)"),
    "Median income (dollars)");
  assert.strictEqual(shortLabel("Estimate|Total|Total population"), "Total population");
  assert.strictEqual(shortLabel(""), null);
});

test("suggested queries read as questions, with no path punctuation", () => {
  const s = buildSuggestions([
    { attr_id: "a1", attr_desc: "Estimate!!EMPLOYMENT!!Population 16 years and over!!In labor force" },
  ]);
  assert.ok(!/[›|!]/.test(s[0].query),
    `query still contains path punctuation: ${s[0].query}`);
  assert.strictEqual(s[0].query, "show in labor force by county");
  // The disambiguating context belongs in the explanation, not the query text.
  assert.match(s[0].why, /Population 16 years and over/);
});

test("value-series suggestions are phrased as answerable questions", () => {
  const s = buildSuggestions([
    { attr_id: "a1", attr_desc: "Estimate|Total|Total population" },
  ]);
  assert.ok(s.length >= 1);
  assert.match(s[0].query, /^show .* by county$/);
  assert.match(s[0].query, /total population/);
});

test("each feature dataset contributes once, alternating shape", () => {
  const s = buildSuggestions([
    { attr_id: "f1", dataset_clean: "Hospitals", is_feature_table: true },
    { attr_id: "f2", dataset_clean: "Fire Stations", is_feature_table: true },
  ], 4);
  const queries = s.map(x => x.query);
  assert.ok(queries.some(q => /how many Hospitals are in each county/.test(q)));
  assert.ok(queries.some(q => /where are the Fire Stations/.test(q)));
  assert.ok(!queries.some(q => /where are the Hospitals/.test(q)),
    "one dataset was offered twice instead of showing a second dataset");
});

test("suggestions interleave kinds rather than repeating one dataset", () => {
  const s = buildSuggestions([
    { attr_id: "f1", dataset_clean: "Hospitals", is_feature_table: true },
    { attr_id: "f2", dataset_clean: "Fire Stations", is_feature_table: true },
    { attr_id: "a1", attr_desc: "Estimate|Total|Total population" },
    { attr_id: "a2", attr_desc: "Estimate|Total|Median age" },
  ], 4);
  assert.strictEqual(s.length, 4);
  assert.ok(s.some(x => x.kind === "value"), "no value suggestion offered");
  assert.ok(s.some(x => x.kind === "feature"), "no feature suggestion offered");
});

test("suggestions are deduplicated and capped", () => {
  const dupes = Array.from({ length: 20 }, (_, i) => ({
    attr_id: `a${i}`, dataset_clean: "Hospitals", is_feature_table: true,
  }));
  const s = buildSuggestions(dupes, 5);
  assert.ok(s.length <= 5);
  assert.strictEqual(new Set(s.map(x => x.query)).size, s.length, "duplicate queries offered");
});

test("unavailableDatasets names catalog entries with no table", () => {
  const resolved = new Map([["a1", { source_kind: "acs_long" }]]);
  const names = unavailableDatasets([
    { attr_id: "a1", dataset_clean: "ACS_combined" },
    { attr_id: "x1", dataset_clean: "Public Schools" },
    { attr_id: "x2", dataset_clean: "Public Schools" },
    { attr_id: "x3", dataset_clean: "Road Tunnels" },
  ], resolved);
  assert.deepStrictEqual(names, ["Public Schools", "Road Tunnels"]);
});

test("cityAmbiguity fires when a city filter spans several states", () => {
  const plan = { steps: [{ op: "select_features", city: "Springfield" }] };
  const features = [
    ...Array(21).fill({ properties: { state: "MO" } }),
    ...Array(14).fill({ properties: { state: "OH" } }),
    ...Array(13).fill({ properties: { state: "IL" } }),
  ];
  const a = cityAmbiguity(plan, features);
  assert.ok(a);
  assert.strictEqual(a.city, "Springfield");
  assert.strictEqual(a.state_count, 3);
  assert.deepStrictEqual(a.states[0], { state: "MO", state_name: "Missouri", count: 21 });
});

test("cityAmbiguity stays quiet when the state was already pinned", () => {
  const plan = { steps: [{ op: "select_features", city: "Springfield", states: ["Missouri"] }] };
  const features = Array(21).fill({ properties: { state: "MO" } });
  assert.strictEqual(cityAmbiguity(plan, features), null);
});

test("cityAmbiguity stays quiet for a single-state result", () => {
  const plan = { steps: [{ op: "select_features", city: "Springfield" }] };
  const features = Array(21).fill({ properties: { state: "MO" } });
  assert.strictEqual(cityAmbiguity(plan, features), null);
});

const PLACE_PLAN = (extra = {}) => ({
  steps: [{ id: "s2", op: "filter_place", place_kind: "place", place_name: "Springfield", ...extra }],
});
const fakeQuery = (rows) => async () => ({ rows });

(async () => {
  const { placeAmbiguity } = require("./suggestions");
  const rows = [
    { geoid: "1", name: "Springfield", state_fp: "29", aland: 200e6 },
    { geoid: "2", name: "Springfield", state_fp: "17", aland: 150e6 },
    { geoid: "3", name: "Springfield", state_fp: "17", aland: 1e6 }, // same state: one candidate
  ];
  const a = await placeAmbiguity(PLACE_PLAN(), fakeQuery(rows));
  try {
    assert.strictEqual(a.kind, "place");
    assert.strictEqual(a.state_count, 2);
    assert.deepStrictEqual(a.candidates.map(c => c.state_name), ["Missouri", "Illinois"]);
    assert.strictEqual(a.candidates[0].state, "MO");
    console.log("  ok   placeAmbiguity lists one candidate per state, largest first"); pass++;
  } catch (e) { console.log(`  FAIL placeAmbiguity lists candidates\n       ${e.message}`); fail++; }

  try {
    assert.strictEqual(await placeAmbiguity(PLACE_PLAN({ states: ["Missouri"] }), fakeQuery(rows)), null);
    assert.strictEqual(await placeAmbiguity(PLACE_PLAN(), fakeQuery(rows.slice(0, 1))), null);
    assert.strictEqual(await placeAmbiguity(PLACE_PLAN({ place_kind: "zcta" }), fakeQuery(rows)), null);
    console.log("  ok   placeAmbiguity stays quiet when pinned, unique, or a ZIP"); pass++;
  } catch (e) { console.log(`  FAIL placeAmbiguity quiet cases\n       ${e.message}`); fail++; }

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
