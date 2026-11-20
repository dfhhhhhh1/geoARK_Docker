// level_measures.js: finding measures that exist only below the county.
const assert = require("assert");
const { create, tokens } = require("./level_measures");

const ROWS = [
  { code: "EPA_EJSCREEN_PM25", label: "PM25", description: "Annual average fine particulate matter (PM2.5) concentration", units: "micrograms per cubic meter", dataset_id: "d1", dataset_name: "EPA EJScreen", min_year: 2023, max_year: 2023 },
  { code: "EPA_EJSCREEN_OZONE", label: "OZONE", description: "Annual average ozone concentration", units: "ppb", dataset_id: "d1", dataset_name: "EPA EJScreen" },
  { code: "USALEEP_LE", label: "e(0)", description: "Life expectancy at birth", units: "years", dataset_id: "d2", dataset_name: "USALEEP" },
  { code: "FARA_LILATRACTS", label: "LILATracts_1And10", description: "Low income and low access tract using 1 mile for urban areas and 10 miles for rural areas", dataset_id: "d3", dataset_name: "USDA Food Access Research Atlas" },
  { code: "SLD_WALKABILITY", label: "NatWalkInd", description: "National Walkability Index", dataset_id: "d4", dataset_name: "EPA Smart Location" },
];
const pool = { query: async (sql, args) => /FROM geo_measure m\s+LEFT JOIN dataset_info/.test(sql) ? { rows: ROWS } : { rows: [] } };
(async () => {
  const lm = create({ pool });
  const top = async (q) => (await lm.search("tract", q, 3)).map((r) => r.code);
  assert.deepStrictEqual((await top("highest PM2.5")).slice(0, 1), ["EPA_EJSCREEN_PM25"]);
  assert.deepStrictEqual((await top("life expectancy")).slice(0, 1), ["USALEEP_LE"]);
  assert.deepStrictEqual((await top("walkability index")).slice(0, 1), ["SLD_WALKABILITY"]);
  assert.deepStrictEqual((await top("low income low access food desert")).slice(0, 1), ["FARA_LILATRACTS"]);
  // One shared word of four is not a match (the "mobile" lesson).
  assert.deepStrictEqual(await top("mobile home parks per capita value"), []);
  assert.deepStrictEqual(await top("hospitals"), []);
  // Unit words and generic words alone never match.
  assert.deepStrictEqual(await top("census tracts in Missouri"), ["EPA_EJSCREEN_PM25", "EPA_EJSCREEN_OZONE"].slice(0, 0));
  // Candidate rows look like catalog rows.
  const c = lm.candidate(ROWS[0], "tract");
  assert.strictEqual(c.attr_id, "EPA_EJSCREEN_PM25");
  assert.strictEqual(c.entity_type, "TRACT");
  assert.match(c.attr_desc, /PM2\.5.*micrograms/);
  assert.deepStrictEqual(tokens("PM2.5 and ozone"), ["pm", "2", "5", "ozone"]);
  // "Jackson County" planned as the city of Jackson becomes the county.
  const { repairCountyKind } = require("./planner");
  const plan = () => ({ steps: [{ id: "s3", op: "filter_place", place_kind: "place", place_name: "Jackson", city: "Jackson", states: ["Missouri"] }] });
  let p = plan();
  assert.ok(repairCountyKind(p, "Which census tracts in Jackson County, Missouri have the lowest life expectancy?"));
  assert.strictEqual(p.steps[0].place_kind, "county");
  assert.strictEqual(p.steps[0].place_name, "Jackson");
  p = plan(); // the city, as asked
  assert.strictEqual(repairCountyKind(p, "hospitals in Jackson, Missouri"), null);
  assert.strictEqual(p.steps[0].place_kind, "place");
  p = { steps: [{ op: "filter_place", place_kind: "zcta", place_name: "63101" }] };
  assert.strictEqual(repairCountyKind(p, "63101 County"), null);
  // Covered: something already offered says what the query asks.
  assert.strictEqual(lm.covered("households without a vehicle", ["Percent of households with no vehicle available SVI"]), true);
  assert.strictEqual(lm.covered("below 150% of poverty", ["Percent of persons below 150% poverty estimate"]), true);
  assert.strictEqual(lm.covered("PM2.5", ["Expected annual loss from winter weather", "Terrain slope"]), false);
  console.log("level_measures: ok");
})().catch((e) => { console.error(e); process.exit(1); });
