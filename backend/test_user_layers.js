/**
 * Per-session uploaded layers (backend/user_layers.js): what is accepted, what
 * is refused and why, how a plan reads one, and "our ..." preferring it.
 * No model, database or GDAL. Run: node backend/test_user_layers.js
 */

const assert = require("node:assert");
const U = require("./user_layers");
const { compilePlan } = require("./planner/compile");
const L = require("./planner/levels");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const fc = (features) => Buffer.from(JSON.stringify({ type: "FeatureCollection", features }));
const pt = (x, y, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x, y] }, properties: props });
const refuses = async (buf, name, re) => {
  await assert.rejects(U.ingest(buf, name), (e) => e instanceof U.UploadError && re.test(e.message));
};

(async () => {
  let clinics;
  await test("a GeoJSON point file becomes a layer with safe columns and filter values", async () => {
    clinics = await U.ingest(fc([
      pt(-90.2, 38.6, { Name: "North Clinic", "Clinic Type": "x", type: "walk-in", "1st": 1 }),
      pt(-90.25, 38.63, { Name: "South Clinic", type: "urgent care" }),
    ]), "our_clinics.geojson");
    assert.strictEqual(clinics.name, "our clinics");
    assert.strictEqual(clinics.geometry, "point");
    assert.strictEqual(clinics.features, 2);
    assert.deepStrictEqual(clinics.columns, ["name", "clinic_type", "type", "c_1st"]);
    assert.deepStrictEqual(clinics.filter_values.type, ["walk-in", "urgent care"]);
  });

  await test("refused with a reason: projected, mixed, empty, oversize, bare .shp, unknown format", async () => {
    await refuses(fc([pt(871505, 982643)]), "wards.geojson", /longitude \/ latitude/);
    await refuses(fc([pt(-90, 38), { type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: [[-90, 38], [-91, 39]] } }]), "x.geojson", /mixes/);
    await refuses(fc([]), "x.geojson", /no features/);
    await refuses(Buffer.from("{not json"), "x.geojson", /not valid JSON/);
    await refuses(Buffer.alloc(U.MAX_BYTES + 1, 32), "x.geojson", /limit/);
    await refuses(Buffer.from("x"), "parcels.shp", /as one \.zip/);
    await refuses(Buffer.from("x"), "parcels.csv", /upload GeoJSON/);
  });

  await test("only ids this process holds resolve; an unknown id is reported missing", () => {
    const { sources, missing } = U.sourcesFor([clinics.id, "ffffffffffffffffffffffff", "../etc"]);
    assert.ok(sources.has(`layer:${clinics.id}`));
    assert.deepStrictEqual(missing, ["ffffffffffffffffffffffff", "../etc"]);
  });

  await test("count_features over an uploaded layer binds its features, at the county and at a zone", () => {
    const { sources } = U.sourcesFor([clinics.id]);
    const id = `layer:${clinics.id}`;
    const plan = { intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "count_features", attr_id: id, inputs: [],
        attribute_filters: [{ column: "type", value: "walk-in" }] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] }] };
    const out = compilePlan(plan, sources).outputs[0];
    assert.match(out.sql, /LEFT JOIN \(SELECT ST_SetSRID\(ST_GeomFromGeoJSON\(u\.g\), 4326\) AS geom, u\.p->>'name' AS name/);
    assert.match(out.sql, /unnest\(\$1::text\[\], \$2::jsonb\[\]\) AS u\(g, p\)\) f/);
    assert.strictEqual(out.params[0].length, 2);
    assert.ok(out.params.includes("walk-in"));
    L.registerZoneSets([{ level: "z_stl_wards", unit: "ward", places: ["St. Louis"] }]);
    const zoned = compilePlan({ ...plan, level: "z_stl_wards" }, sources).outputs[0];
    assert.match(zoned.sql, /FROM geo_unit c LEFT JOIN \(SELECT ST_SetSRID/);
  });

  await test("select_features maps an uploaded layer with its own label columns", () => {
    const { sources } = U.sourcesFor([clinics.id]);
    const id = `layer:${clinics.id}`;
    const out = compilePlan({ intent: "t", output_type: "map", entity_type: "COUNTY", steps: [
      { id: "s1", op: "select_features", attr_id: id, inputs: [] },
      { id: "s2", op: "output", attr_id: "", inputs: ["s1"] }] }, sources).outputs[0];
    assert.strictEqual(out.mode, "features");
    assert.match(out.sql, /SELECT ST_AsGeoJSON\(f\.geom\) AS geometry, f\.name::text AS name, f\.type::text AS type/);
  });

  await test('"our clinics" swaps a catalog layer for the upload; without the possessive, nothing', () => {
    const { sources } = U.sourcesFor([clinics.id]);
    const id = `layer:${clinics.id}`;
    const cands = [{ attr_id: "HOSP", is_feature_table: true, dataset_clean: "Hospitals" },
                   { attr_id: "CLIN", is_feature_table: true, dataset_clean: "Urgent Care Clinics" }];
    const mk = () => ({ steps: [{ id: "s1", op: "count_features", attr_id: "CLIN", inputs: [],
                                  attribute_filters: [{ column: "type", value: "CLINIC" }] }] });
    const p = mk();
    assert.ok(U.preferUserLayer(p, "how many of our clinics are in each St. Louis ward", sources, cands));
    assert.strictEqual(p.steps[0].attr_id, id);
    assert.strictEqual(p.steps[0].attribute_filters, undefined);   // not one of the upload's values
    const q = mk();
    assert.strictEqual(U.preferUserLayer(q, "how many clinics are in each St. Louis ward", sources, cands), null);
    assert.strictEqual(q.steps[0].attr_id, "CLIN");
    // two layers read and no shared word: which is "ours" is not decidable
    const r = { steps: [{ id: "s1", op: "count_near", attr_id: "HOSP", near_attr_id: "FIRE", inputs: [] }] };
    assert.strictEqual(U.preferUserLayer(r, "our sites near fire stations", sources,
      [...cands, { attr_id: "FIRE", is_feature_table: true, dataset_clean: "Fire Stations" }]), null);
  });

  await test("layers expire and the store is capped", () => {
    const before = U._store.size;
    for (const l of U._store.values()) l.used = 0;
    U._sweep(Date.now());
    assert.ok(U._store.size < before || before === 0);
    assert.strictEqual(U.sourcesFor([clinics.id]).missing.length, 1);
  });

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
