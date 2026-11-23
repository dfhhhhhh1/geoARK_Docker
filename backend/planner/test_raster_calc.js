/**
 * raster_calc (planner/raster_calc.js, ops/raster_calc.js): the WHERE gate,
 * the rebuild from zonal steps (thresholds, two rasters, a class change), the
 * plans it leaves alone, and that every compiled statement binds exactly the
 * parameters it uses. No model or database; the live check against GDAL gold
 * is recorded in docs/GIS_OPS_PLAN.md.
 * Run: node backend/planner/test_raster_calc.js
 */

const assert = require("node:assert");
const { validatePlan } = require("./validate");
const { compilePlan } = require("./compile");
const RC = require("./raster_calc");

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}

const grid = { srid: 5070, origin_x: 0, origin_y: 0, pixel_x: 30, pixel_y: -30, tile_size: 256, width: 100, height: 100 };
const fine = { ...grid, pixel_x: 10, pixel_y: -10 };
const NLCD = {
  source_kind: "raster", raster_kind: "categorical", pixel_area_m2: 900, label: "Land cover class",
  layers: [{ ...grid, year: 2001, table_name: "raster_nlcd2001", id: "nlcd2001" }, { ...grid, year: 2021, table_name: "raster_nlcd2021", id: "nlcd2021" }],
  classes: [{ value: 41, label: "Deciduous Forest", grp: "Forest" }, { value: 42, label: "Evergreen Forest", grp: "Forest" },
            { value: 21, label: "Developed, Open Space", grp: "Developed" }, { value: 22, label: "Developed, Low Intensity", grp: "Developed" },
            { value: 82, label: "Cultivated Crops", grp: "Planted/Cultivated" }],
};
const DEM = { source_kind: "raster", raster_kind: "continuous", pixel_area_m2: 100, units: "meters", label: "Ground elevation",
  layers: [{ ...fine, year: 2026, table_name: "raster_dem" }] };
const SLOPE = { source_kind: "raster", raster_kind: "continuous", pixel_area_m2: 100, units: "percent", label: "Terrain slope",
  layers: [{ ...fine, year: 2026, table_name: "raster_slope" }] };
const SRC = new Map([["NLCD", NLCD], ["DEM", DEM], ["SLOPE", SLOPE]]);
const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
const srcOf = (id) => SRC.get(id);
const plan = (...steps) => ({ intent: "t", output_type: "map", entity_type: "COUNTY", steps });
const z = (id, attr, extra = {}) => ({ id, op: "zonal", attr_id: attr, inputs: [], ...extra });
const county = (id, from, name = "St. Louis") => ({ id, op: "filter_place", attr_id: "", inputs: [from], place_kind: "county", place_name: name, states: ["Missouri"] });
const out = (id, from) => ({ id, op: "output", attr_id: "", inputs: [from] });
async function compiles(p) {
  const v = await validatePlan(p, resolve);
  assert.deepStrictEqual(v.errors || [], [], `validation: ${(v.errors || []).join("; ")}`);
  const c = compilePlan(p, await resolve([p.steps[0].attr_id, p.steps[0].attr_id_b].filter(Boolean)));
  for (const o of c.outputs) {
    const used = new Set([...o.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    for (let i = 1; i <= o.params.length; i++) assert.ok(used.has(i), `parameter $${i} is bound and never used`);
    assert.strictEqual(used.size, o.params.length);
  }
  return c;
}

(async () => {
  console.log("the WHERE gate");
  await test("asks where vs how much per unit", async () => {
    for (const q of ["Map where forest became developed land in St. Louis County between 2001 and 2021",
                     "Show the areas of St. Louis with a slope over 15 percent",
                     "Where in St. Louis County is the land above 180 meters with slope under 5 percent?"]) {
      assert.ok(RC.asksRasterWhere(q), q);
    }
    for (const q of ["what share of each Missouri county is forest", "how much land in St. Louis County is steep",
                     "map the percent of cropland by county in Illinois", "average slope of each ward in St. Louis"]) {
      assert.ok(!RC.asksRasterWhere(q), q);
    }
  });

  console.log("the rebuild");
  await test("a threshold over a county", async () => {
    const p = plan(z("s1", "SLOPE", { operator: ">", value: 15 }), county("s2", "s1"), out("s3", "s2"));
    assert.ok(RC.applyRasterCalc(p, "Show the areas of St. Louis County with a slope over 15 percent", srcOf));
    const s = p.steps[0];
    assert.deepStrictEqual([s.op, s.operator, s.value, s.area.kind, s.area.name], ["raster_calc", ">", 15, "county", "St. Louis"]);
    const c = await compiles(p);
    assert.strictEqual(c.outputs[0].style.kind, "mask");
    assert.ok(/substring\(k\.fips, 3, 3\) < '500'/.test(c.outputs[0].sql), "a bare county name prefers the county over the independent city");
  });
  await test("two rasters on one grid", async () => {
    const p = plan(z("s1", "DEM", { operator: ">", value: 180 }), z("s2", "SLOPE", { operator: "<", value: 5 }),
                   { id: "s3", op: "intersect", attr_id: "", inputs: ["s1", "s2"] }, county("s4", "s3"), out("s5", "s4"));
    assert.ok(RC.applyRasterCalc(p, "Where in St. Louis County is the land above 180 meters with slope under 5 percent?", srcOf));
    const s = p.steps[0];
    assert.deepStrictEqual([s.attr_id, s.operator, s.attr_id_b, s.operator_b], ["DEM", ">", "SLOPE", "<"]);
    await compiles(p);
  });
  await test("a class change: from the earlier year to the later one", async () => {
    const both = [{ column: "type", value: "Forest" }, { column: "type", value: "Developed" }];
    const p = plan(z("s1", "NLCD", { year: 2021, attribute_filters: both }), z("s2", "NLCD", { year: 2001, attribute_filters: both }),
                   { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" }, county("s4", "s3"), out("s5", "s4"));
    const msg = RC.applyRasterCalc(p, "Map where forest became developed land in St. Louis County between 2001 and 2021", srcOf);
    assert.ok(/Forest \(2001\) to Developed \(2021\)/.test(msg), msg);
    const s = p.steps[0];
    assert.deepStrictEqual([s.year, s.classes, s.year_b, s.classes_b], [2001, [41, 42], 2021, [21, 22]]);
    await compiles(p);
  });
  await test("\"X city\" is the independent city", async () => {
    const p = plan(z("s1", "SLOPE", { operator: ">", value: 15 }), county("s2", "s1", "St. Louis city"), out("s3", "s2"));
    RC.applyRasterCalc(p, "Show the areas of St. Louis city with a slope over 15 percent", srcOf);
    const c = await compiles(p);
    assert.ok(/substring\(k\.fips, 3, 3\) >= '500'/.test(c.outputs[0].sql));
    assert.ok(c.outputs[0].params.includes("St. Louis"));
  });
  await test("rasters on different grids are refused at compile", async () => {
    const p = plan(z("s1", "NLCD", { year: 2021, attribute_filters: [{ column: "type", value: "Forest" }] }),
                   z("s2", "SLOPE", { operator: ">", value: 15 }), { id: "s3", op: "intersect", attr_id: "", inputs: ["s1", "s2"] },
                   county("s4", "s3"), out("s5", "s4"));
    assert.ok(RC.applyRasterCalc(p, "Show the forest areas of St. Louis County with slope over 15 percent", srcOf));
    await assert.rejects(async () => compiles(p), /not on one grid/);
  });

  console.log("left alone");
  await test("per-unit, state-wide, no place, no condition", async () => {
    const cases = [
      [plan(z("s1", "SLOPE", { operator: ">", value: 15 }), out("s2", "s1")), "Show the areas with a slope over 15 percent"],
      [plan(z("s1", "SLOPE", { operator: ">", value: 15 }), { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: ["Missouri"] }, out("s3", "s2")),
        "Show the areas of Missouri with a slope over 15 percent"],
      [plan(z("s1", "SLOPE"), county("s2", "s1"), out("s3", "s2")), "Show the areas of St. Louis County by slope"],
      [plan(z("s1", "SLOPE", { operator: ">", value: 15 }), county("s2", "s1"), out("s3", "s2")), "What share of each county in St. Louis County is steep"],
      [plan(z("s1", "NLCD", { year: 2001, attribute_filters: [{ column: "type", value: "Forest" }] }),
            z("s2", "NLCD", { year: 2021, attribute_filters: [{ column: "type", value: "Forest" }] }),
            { id: "s3", op: "combine", attr_id: "", inputs: ["s1", "s2"], operation: "difference" }, county("s4", "s3"), out("s5", "s4")),
        "Map the forest areas of St. Louis County in 2001 and 2021"],
    ];
    for (const [p, q] of cases) {
      const before = JSON.stringify(p);
      assert.strictEqual(RC.applyRasterCalc(p, q, srcOf), null, q);
      assert.strictEqual(JSON.stringify(p), before);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
