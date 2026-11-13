/**
 * Zone sets as analysis units (docs/GIS_OPS_PLAN.md H2): matching a question
 * to a loaded zone set, the named-data exemption, counting and area at a zone
 * level, and the two repairs H2's dev runs needed.
 * No model or database. Run: node backend/planner/test_zones.js
 */

const assert = require("node:assert");
const L = require("./levels");
const { compilePlan } = require("./compile");
const { isExempt } = require("./named_data");
const { applyAreaUnit } = require("./features");
const { filterValueAsLayer } = require("./index");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const ZONES = [
  { level: "z_stl_wards", name: "St. Louis wards", unit: "ward", plural: "wards",
    aliases: ["aldermanic ward"], places: ["St. Louis", "St. Louis city"] },
  { level: "z_stl_neighborhoods", name: "St. Louis neighborhoods", unit: "neighborhood",
    plural: "neighborhoods", aliases: ["neighbourhood"], places: ["St. Louis"] },
  { level: "z_chi_community_areas", name: "Chicago community areas", unit: "community area",
    plural: "community areas", aliases: [], places: ["Chicago"] },
  { level: "z_chi_wards", name: "Chicago wards", unit: "ward", plural: "wards",
    aliases: [], places: ["Chicago"] },
];

const SRC = new Map([
  ["SNAP", { source_kind: "feature_table", table_name: "snap_retailers", geom_column: "geom",
             filter_values: { type: ["Supermarket", "Convenience Store"] } }],
  ["POP", { source_kind: "acs_long", census_code: "WORLDPOP_POP", description: "WorldPop" }],
]);
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const out = (from) => ({ id: "s9", op: "output", attr_id: "", inputs: [from] });

(async () => {
  L.registerZoneSets(ZONES);

  await test("a zone set needs its unit word AND one of its places", () => {
    assert.strictEqual(L.levelOf("How many child care centers are there in each St. Louis ward?"), "z_stl_wards");
    assert.strictEqual(L.levelOf("What is the number of transit stops in each Chicago ward?"), "z_chi_wards");
    assert.strictEqual(L.levelOf("Count the public schools in each Chicago community area."), "z_chi_community_areas");
    assert.strictEqual(L.levelOf("Which ward of St. Louis has the most hospitals?"), "z_stl_wards");
    assert.strictEqual(L.levelOf("For every neighborhood in St. Louis, how many schools?"), "z_stl_neighborhoods");
    // A city with no zones loaded, or no city at all: nothing is guessed.
    assert.strictEqual(L.levelOf("How many hospitals are in each Boston ward?"), null);
    assert.strictEqual(L.levelOf("How many hospitals are in each ward?"), null);
    // Not a unit: a singular with no each / per / which, and county answers.
    assert.strictEqual(L.levelOf("poverty in my St. Louis neighborhood"), null);
    assert.strictEqual(L.levelOf("how many hospitals in each county near St. Louis wards"), null);
    // Tracts still win where no zone word is used.
    assert.strictEqual(L.levelOf("Which census tracts in the city of St. Louis have the most poverty?"), "tract");
  });

  await test("registering again replaces the sets; a bad level name is ignored", () => {
    L.registerZoneSets([{ level: "Z-BAD", unit: "ward", places: ["X"] }, ZONES[3]]);
    assert.strictEqual(L.levelOf("each St. Louis ward"), null);
    assert.strictEqual(L.levelOf("each Chicago ward"), "z_chi_wards");
    assert.ok(!L.LEVELS.has("z_stl_wards"));
    L.registerZoneSets(ZONES);
    assert.ok(L.LEVELS.has("z_stl_wards"));
    assert.strictEqual(L.planLevel({ level: "z_stl_wards" }), "z_stl_wards");
    assert.strictEqual(L.planLevel({ level: "z_nowhere" }), "county");
  });

  await test("a zone unit is a reporting unit to the named-data check, data words are not", () => {
    assert.ok(isExempt("each Chicago ward", "x"));
    assert.ok(isExempt("Chicago community area", "x"));
    assert.ok(isExempt("each St. Louis neighborhood", "x"));
    assert.ok(!isExempt("transit stops", "x"));
    assert.ok(!isExempt("ward crime", "x"));
  });

  await test("count_features at a zone level counts into that level's units, zeros kept", () => {
    const p = plan({ id: "s1", op: "count_features", attr_id: "SNAP", inputs: [],
                     attribute_filters: [{ column: "type", value: "Supermarket" }] }, out("s1"));
    p.level = "z_stl_neighborhoods";
    const sql = compilePlan(p, SRC).outputs[0].sql;
    assert.match(sql, /FROM geo_unit c LEFT JOIN snap_retailers f ON c\.geom && f\.geom AND ST_Intersects/);
    assert.match(sql, /WHERE c\.level = \$\d+ GROUP BY c\.geoid/);
    // the filter stays in the ON clause, so a zone with none reads 0
    assert.match(sql, /ST_Intersects\(c\.geom, f\.geom\) AND f\.type/);
    assert.match(sql, /FROM geo_unit WHERE level = 'z_stl_neighborhoods'/);
  });

  await test("count_features at the county is unchanged", () => {
    const sql = compilePlan(plan({ id: "s1", op: "count_features", attr_id: "SNAP", inputs: [] }, out("s1")), SRC)
      .outputs[0].sql;
    assert.match(sql, /FROM county_geom c LEFT JOIN snap_retailers f ON ST_Intersects\(c\.geom, f\.geom\)/);
  });

  await test("per_area: square miles by default, square kilometres only from the question", () => {
    const mk = () => plan({ id: "s1", op: "load", attr_id: "POP", inputs: [] },
                          { id: "s2", op: "per_area", attr_id: "", inputs: ["s1"] }, out("s2"));
    const mi = mk(); mi.level = "z_chi_wards";
    assert.strictEqual(applyAreaUnit(mi, "people per square mile in each Chicago ward"), null);
    assert.match(compilePlan(mi, SRC).outputs[0].sql, /\* 2589988\.110336 AS value/);
    const km = mk(); km.level = "z_chi_wards";
    assert.ok(applyAreaUnit(km, "people per square kilometer in each Chicago ward"));
    assert.strictEqual(km.steps[1].area_unit, "km2");
    assert.match(compilePlan(km, SRC).outputs[0].sql, /\* 1000000 AS value/);
    // "within 5 km" is a distance, not an area
    assert.strictEqual(applyAreaUnit(mk(), "hospitals within 5 km of a school, per square mile"), null);
  });

  await test("a filter value that is the layer's own name is dropped, a real value kept", async () => {
    const cands = [{ attr_id: "SNAP", is_feature_table: true, dataset_clean: "SNAP Authorized Food Retailers" }];
    const resolve = async (ids) => new Map(ids.map(i => [i, SRC.get(i)]));
    const p = plan({ id: "s1", op: "count_features", attr_id: "SNAP", inputs: [],
                     attribute_filters: [{ column: "type", value: "SNAP Authorized Food Retailers" }] }, out("s1"));
    assert.ok(await filterValueAsLayer(p, resolve, cands));
    assert.strictEqual(p.steps[0].attribute_filters, undefined);
    const q = plan({ id: "s1", op: "count_features", attr_id: "SNAP", inputs: [],
                     attribute_filters: [{ column: "type", value: "Supermarket" }] }, out("s1"));
    assert.strictEqual(await filterValueAsLayer(q, resolve, cands), null);
    assert.strictEqual(q.steps[0].attribute_filters.length, 1);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
