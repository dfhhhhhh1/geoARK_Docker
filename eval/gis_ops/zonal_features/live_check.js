/**
 * zonal over features (GIS_OPS_PLAN.md H4 remainder): the compiled op against
 * the GDAL gold in eval_raster_gold, on the live database, outside the API.
 * Plans are written by hand (the planner is not under test here); each is
 * validated and compiled by the same code the API runs, then executed.
 *
 * Run inside geoark-api-1 with backend/ copied to /tmp/zf (PG* env is set):
 *   node /tmp/zf/eval_live_check.js
 */
const path = require("path");
const BACKEND = process.env.ZF_BACKEND || path.resolve(__dirname, "../../../backend");
const { Pool } = require(require.resolve("pg", { paths: [BACKEND, "/app"] }));
const { validatePlan } = require(path.join(BACKEND, "planner/validate"));
const { compilePlan } = require(path.join(BACKEND, "planner/compile"));
const { applyRasterMeasures } = require(path.join(BACKEND, "planner/features"));

const pool = new Pool();
const CAMPUS = "table_3c5026522e6841d4ad3ed482c0fb1b30_collegeuniversitycampuse";

async function raster(code) {
  const { rows } = await pool.query(
    `SELECT * FROM raster_layer WHERE code = $1 AND kind IS NOT NULL ORDER BY year`, [code]);
  const r0 = rows[0];
  const { rows: cls } = await pool.query(
    `SELECT DISTINCT c.value, c.label, c.grp FROM raster_class c WHERE c.raster_id = ANY($1) ORDER BY c.value`,
    [rows.map(r => r.id)]);
  return {
    source_kind: "raster", raster_kind: r0.kind, aggregate: r0.aggregate, units: r0.units,
    pixel_area_m2: Number(r0.pixel_area_m2), description: r0.label,
    layers: rows.map(r => ({ id: r.id, year: r.year, table_name: r.table_name, srid: r.srid,
      cached_levels: r.cached_levels || [],
      extent: [r.origin_x, r.origin_y + r.pixel_y * r.height, r.origin_x + r.pixel_x * r.width, r.origin_y] })),
    classes: cls, label_columns: cls.length ? ["type"] : [],
    filter_values: cls.length ? { type: [...new Set([...cls.map(c => c.grp).filter(Boolean), ...cls.map(c => c.label)])] } : {},
  };
}
const feature = (table) => ({ source_kind: "feature_table", table_name: table, geom_column: "geom",
  label_columns: ["name", "city", "state"], filter_values: {}, value_columns: [] });

const sel = (attr, extra) => ({ id: "s1", op: "select_features", attr_id: attr, inputs: [], ...extra });
const zon = (attr, extra = {}) => ({ id: "s2", op: "zonal", attr_id: attr, inputs: ["s1"], ...extra });
const CASES = [
  { qid: "zf-mo-campus-forest-2021", q: "What percentage of each college campus in Missouri is forest, based on 2021 land cover?",
    steps: [sel("CAMPUS", { states: ["Missouri"] }), zon("NLCD", { year: 2021, attribute_filters: [{ column: "type", value: "Forest" }] })] },
  { qid: "zf-il-npl-developed-acres", q: "How many acres of developed land does each Superfund site in Illinois have, according to 2021 land cover?",
    steps: [sel("NPL", { states: ["Illinois"] }), zon("NLCD", { year: 2021, attribute_filters: [{ column: "type", value: "Developed" }] })] },
  { qid: "zf-stl-campus-slope-mean", q: "the average slope of each college campus in St. Louis",
    steps: [sel("CAMPUS", { city: "St. Louis", states: ["Missouri"] }), zon("SLOPE")] },
  { qid: "zf-chi-npl-elev-mean", q: "What is the average elevation of each Superfund site in Chicago?",
    steps: [sel("NPL", { city: "Chicago", states: ["Illinois"] }), zon("DEM")] },
  { qid: "zf-il-campus-dev-share-2001", q: "what percent of each college campus in Illinois was developed land in 2001",
    steps: [sel("CAMPUS", { states: ["Illinois"] }), zon("NLCD", { year: 2001, attribute_filters: [{ column: "type", value: "Developed" }] })] },
  { qid: "zf-chi-campus-flat-share", q: "For each college campus in Chicago, what share of its land has a slope under 2 percent?",
    steps: [sel("CAMPUS", { city: "Chicago", states: ["Illinois"] }), zon("SLOPE", { operator: "<", value: 2 })] },
];

(async () => {
  const SRC = new Map([["NLCD", await raster("NLCD_LANDCOVER")], ["SLOPE", await raster("TERRAIN_SLOPE")],
                       ["DEM", await raster("DEM_ELEVATION")], ["CAMPUS", feature(CAMPUS)], ["NPL", feature("epa_npl_sites")]]);
  const resolve = async (ids) => new Map(ids.filter(i => SRC.has(i)).map(i => [i, SRC.get(i)]));
  let bad = 0;
  for (const c of CASES) {
    const plan = { intent: c.qid, output_type: "map", entity_type: "COUNTY",
                   steps: [...c.steps, { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] };
    applyRasterMeasures(plan, c.q, (id) => SRC.get(id));
    const v = await validatePlan(plan, resolve);
    if (!v.ok) { console.log(`${c.qid}: INVALID ${v.errors.join("; ")}`); bad++; continue; }
    const o = compilePlan(plan, v.resolved).outputs[0];
    const t0 = Date.now();
    const { rows } = await pool.query(o.sql, o.params);
    const ms = Date.now() - t0;
    const got = new Map(rows.map(r => {
      let g = JSON.parse(r.geometry).coordinates;
      while (Array.isArray(g[0])) g = g[0];
      // Half away from zero on the decimal value, as Postgres round(numeric)
      // keys gold (toFixed rounds the binary float: -88.866745 -> -88.86674).
      const r5 = (x) => (Math.sign(x) * Math.round(Math.abs(x) * 1e5 + 1e-6) / 1e5).toFixed(5);
      return [`${r5(g[0])},${r5(g[1])}`, Number(r.zonal_value)];
    }));
    const { rows: gold } = await pool.query(`SELECT geoid, value FROM eval_raster_gold WHERE qid = $1`, [c.qid]);
    let missing = 0, extra = 0, maxd = 0, worst = null;
    const want = new Map(gold.map(r => [r.geoid, Number(r.value)]));
    for (const [k, w] of want) {
      if (!got.has(k)) { missing++; continue; }
      const d = Math.abs(got.get(k) - w);
      if (d > maxd) { maxd = d; worst = { k, gold: w, got: got.get(k) }; }
    }
    for (const k of got.keys()) if (!want.has(k)) extra++;
    const ok = !missing && !extra && maxd < 1e-6 * Math.max(1, Math.abs(worst?.gold || 1));
    if (!ok) bad++;
    console.log(`${ok ? "EQUAL" : "DIFF "} ${c.qid}: ${got.size} features vs ${want.size} gold, missing ${missing}, extra ${extra}, ` +
                `max |diff| ${maxd.toExponential(2)} (${o.valueLabel}), ${ms} ms` + (ok ? "" : ` worst ${JSON.stringify(worst)}`));
  }
  await pool.end();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
