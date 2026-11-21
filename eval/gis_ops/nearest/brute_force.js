/**
 * Brute-force check of nearest_distance's identify / k forms (GIS_OPS_PLAN.md
 * H6 item 3). Compiles plans with the real compiler, inlines the bound
 * parameters, and compares against an exhaustive cross join (every county
 * centroid x every hospital, ranked by geodesic distance).
 * Run from backend/: node ../eval/gis_ops/nearest/brute_force.js
 */
const { execFileSync } = require("node:child_process");
const { compilePlan } = require("../../../backend/planner/compile");
const T = "table_7fd78ade6d9847dab7aff72866124f79_hospitals";
const resolved = new Map([["H", { source_kind: "feature_table", table_name: T, geom_column: "geom",
  label_columns: ["name", "address", "city", "state"] }]]);
const psql = (sql) => execFileSync("docker", ["exec", "-i", "geoark-db-1", "psql", "-U", "geoark", "-d", "mygisdb",
  "-AtF", "\t", "-v", "ON_ERROR_STOP=1"], { input: sql, maxBuffer: 1 << 28 }).toString();
const inline = (sql, params) => sql.replace(/\$(\d+)/g, (_, i) => {
  const v = params[i - 1];
  return typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
});

function compiled(k, stat, states, level) {
  const plan = { intent: "t", output_type: "map", entity_type: "COUNTY", level,
    steps: [{ id: "s1", op: "nearest_distance", attr_id: "H", inputs: [], identify: true, k, k_stat: stat },
            { id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states },
            { id: "s3", op: "output", attr_id: "", inputs: ["s2"] }] };
  const o = compilePlan(plan, resolved).outputs[0];
  const sql = inline(o.sql, o.params).replace(/,\s*CASE WHEN g\.geom IS NULL[\s\S]*?AS geometry/, "");
  return { sql, label: o.valueLabel };
}

function brute(k, stat, fps, level) {
  const units = level === "tract"
    ? `SELECT geoid AS fips, pt FROM geo_unit WHERE level = 'tract' AND state_fp IN (${fps})`
    : `SELECT fips, ST_Centroid(geom) AS pt FROM county_geom WHERE LEFT(fips,2) IN (${fps})`;
  return `WITH u AS (${units}), d AS (
    SELECT u.fips, ST_Distance(u.pt::geography, h.geom::geography) AS d,
      concat_ws(', ', NULLIF(h.name::text,''), NULLIF(h.city::text,''), NULLIF(h.state::text,'')) AS lbl
    FROM u CROSS JOIN ${T} h),
  r AS (SELECT *, row_number() OVER (PARTITION BY fips ORDER BY d, lbl) AS rn FROM d)
  SELECT fips, ${stat === "kth" ? "max(d)" : "avg(d)"} / 1609.344, string_agg(lbl, '; ' ORDER BY d, lbl)
  FROM r WHERE rn <= ${k} GROUP BY fips`;
}

const parse = (txt) => new Map(txt.trim().split("\n").filter(Boolean).map(l => {
  const [f, v, n] = l.split("\t"); return [f, { v: Number(v), n }];
}));

const cases = [
  { k: 1, stat: "mean", states: ["Missouri"], fps: "'29'" },
  { k: 3, stat: "mean", states: ["Missouri"], fps: "'29'" },
  { k: 2, stat: "kth", states: ["Alaska"], fps: "'02'" },
  { k: 5, stat: "mean", states: ["Alaska", "Montana", "Hawaii"], fps: "'02','30','15'" },
  { k: 3, stat: "kth", states: ["Rhode Island"], fps: "'44'", level: "tract" },
];
let bad = 0;
for (const c of cases) {
  const { sql, label } = compiled(c.k, c.stat, c.states, c.level);
  let t = Date.now();
  const got = parse(psql(sql.replace(/^WITH/, "WITH") + ";").replace(/^([^\t]*)\t[^\t]*\t[^\t]*\t/gm, "$1\t"));
  const ms = Date.now() - t;
  const want = parse(psql(brute(c.k, c.stat, c.fps, c.level) + ";"));
  let diffs = 0, maxRel = 0, nameDiffs = 0;
  for (const [f, w] of want) {
    const g = got.get(f);
    if (!g) { diffs++; continue; }
    const rel = Math.abs(g.v - w.v) / Math.max(w.v, 1e-9);
    maxRel = Math.max(maxRel, rel);
    if (rel > 1e-9) diffs++;
    if (g.n !== w.n) nameDiffs++;
  }
  if (got.size !== want.size || diffs || nameDiffs) bad++;
  console.log(`${c.level || "county"} ${c.states.join("/")} k=${c.k} ${c.stat}: ${want.size} units, ` +
    `compiled ${got.size}, value diffs ${diffs} (max rel ${maxRel.toExponential(1)}), name diffs ${nameDiffs}, ${ms} ms  [${label}]`);
}
process.exit(bad ? 1 : 0);
