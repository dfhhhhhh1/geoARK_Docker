/**
 * Fine sample points on the map: the 2020 block centroids + hexagon points of
 * the L48 GeoARK geodatabase, with their precomputed nearest-facility
 * distances (table fine_pt, etl/schema_fine_points.sql; plan and measurements
 * in docs/POINTS_INTEGRATION_PLAN.md).
 *
 *   GET /api/points/catalog                 columns, loaded states, colour breaks
 *   GET /api/points/tile/:z/:x/:y?m=&mode=  one 256 px map tile, as compact JSON
 *   GET /api/points/at?lat=&lon=&z=         the point under a click, every distance,
 *                                           and its Thiessen cell
 *   GET /api/points/stats?m=&(bbox=|level=&geoid=|lat=&lon=&radius_mi=)
 *                                           distribution of one distance in an area
 *
 * WHY TILES AND NOT GEOJSON. Missouri alone is 2.75M points; the whole lower
 * 48 is 118M. A tile is drawn on a canvas by the browser (no DOM per point),
 * and the server decides per tile what is drawable:
 *   - more than POINT_BUDGET points in the tile -> `agg`: the mean of the
 *     points in each 4x4-pixel cell (64x64 cells), so a zoomed-out view still
 *     shows the fine pattern without shipping millions of points;
 *   - otherwise `points`: every point, at its pixel;
 *   - `cells` (asked for, z >= CELL_MIN_Z, few enough points): the Thiessen
 *     (Voronoi) cell of every point, rebuilt on the fly. Verified against the
 *     gdb's ThiessenArea for Boone County MO (interior median ratio 1.000).
 * Tiles are cached in memory: the table only changes when a state is loaded,
 * and the cache key carries the list of loaded partitions.
 *
 * DISTANCES ARE STRAIGHT-LINE, NOT DRIVING. ArcGIS Near / Euclidean-distance
 * rasters, corrected to miles of ground distance as far as a single scale
 * factor allows (schema_fine_points.sql has the measured error per column).
 *
 * Every identifier interpolated into SQL is a column from COLUMNS below.
 */

"use strict";

const { createLimiter, rateLimit } = require("./ratelimit");

// Column -> what it measures. The order is the order of the UI's list.
const COLUMNS = [
  ["hosp_mi", "Hospital", "Euclidean-distance raster (Web Mercator), corrected by cos(latitude)"],
  ["ems_mi", "EMS station", "ArcGIS Near, World Cylindrical Equal Area"],
  ["vha_mi", "VA health facility", "ArcGIS Near, World Cylindrical Equal Area; a VHA list other than the one loaded in GeoARK"],
  ["public_health_mi", "Public health department", null],
  ["child_care_mi", "Child care center", null],
  ["public_school_mi", "Public school", null],
  ["college_mi", "College or university", null],
  ["worship_mi", "Place of worship", null],
  ["parks_mi", "Park", "Euclidean-distance raster (Web Mercator), corrected by cos(latitude); park layer not recorded"],
  ["public_transit_mi", "Public transit route or station", null],
  ["power_line_mi", "Power transmission line", null],
  ["substation_mi", "Electric substation", null],
  ["power_plant_mi", "Power plant", null],
  ["oil_refinery_mi", "Oil refinery (point)", null],
  ["oil_refinery_site_mi", "Oil refinery site (polygon)", null],
  ["biodiesel_mi", "Biodiesel plant", null],
  ["tri_facility_mi", "EPA TRI facility", null],
  ["tsca_facility_mi", "EPA TSCA facility", null],
  ["landfill_mi", "Solid waste landfill", null],
  ["tornado_track_mi", "Historical tornado track", null],
  ["construction_minerals_mi", "Construction minerals operation", null],
  ["agricultural_minerals_mi", "Agricultural minerals operation", null],
  ["abrasive_minerals_mi", "Abrasive / industrial mineral operation", null],
  ["misc_industrial_minerals_mi", "Misc. industrial mineral operation", null],
  ["mine_mineral_site_mi", "Mine or mineral site (USGS MRDS)", null],
  ["ferrous_mine_mi", "Ferrous metal mine", null],
  ["ferrous_processing_mi", "Ferrous metal processing plant", null],
  ["nonferrous_mine_mi", "Nonferrous metal mine", null],
  ["nonferrous_processing_mi", "Nonferrous metal processing plant", null],
  ["uranium_vanadium_mi", "Uranium / vanadium deposit", null],
].map(([column, label, method]) => ({
  column, label: `Distance to nearest ${/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)}`,
  short: label,
  units: "miles", method: method || "ArcGIS Near, World Cylindrical Equal Area",
}));
const BY_COLUMN = new Map(COLUMNS.map((c) => [c.column, c]));

const POINT_BUDGET = 6000;     // points drawn individually in one 256 px tile
const AGG_CELL = 4;            // px per aggregate cell when over budget
const CELL_MIN_Z = 13;         // Thiessen cells only this close in
const CELL_BUDGET = 2500;      // and only this many in a tile
const MIN_Z = 5;               // below this a tile spans several states
const STATS_MAX = 4_000_000;   // points one stats request may read
const THRESHOLDS = [1, 2, 5, 10, 20, 30];
const QUANTS = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];

/** Pixel position inside tile (z, x, y) of a lon/lat column pair, as SQL. */
function pixelSql(z, x, y, lon = "ST_X(geom)", lat = "ST_Y(geom)") {
  const n = 2 ** z;
  return {
    px: `((${lon} + 180) / 360 * ${n} - ${x}) * 256`,
    py: `((1 - ln(tan(radians(${lat})) + 1 / cos(radians(${lat}))) / pi()) / 2 * ${n} - ${y}) * 256`,
  };
}

function tileArgs(p) {
  const z = Number(p.z), x = Number(p.x), y = Number(p.y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20) return null;
  if (x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}

function parseBbox(s) {
  const b = String(s || "").split(",").map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite)) return null;
  const [w, so, e, n] = b;
  if (!(e > w && n > so)) return null;
  return [Math.max(w, -180), Math.max(so, -85), Math.min(e, 180), Math.min(n, 85)];
}

/** Two significant digits, so a legend reads 2.4 / 5.1 / 12 rather than 5.0937. */
/**
 * Breaks rounded to a step that suits the range (a tenth of its order of
 * magnitude) and kept strictly inside it. Two significant digits, used
 * before, read "36.2 · 36 · 37" for a view spanning 36.2-37.0 mi.
 */
function roundBreaks(q, lo, hi) {
  const range = hi - lo;
  if (!(range > 0)) return [];
  const exp = Math.floor(Math.log10(range)) - 1;
  const step = 10 ** exp;
  const dec = Math.max(0, -exp);
  const out = q.map((v) => Number((Math.round(v / step) * step).toFixed(dec))).filter((v) => v > lo && v < hi);
  return [...new Set(out)].sort((a, b) => a - b);
}

function nice(v) {
  if (!(v > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
}

class Lru {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k); this.m.delete(k); this.m.set(k, v); return v;
  }
  set(k, v) {
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
}

function register(app, { pool, auth }) {
  // A map view asks for ~12-30 tiles at once; its own bucket, like the explore map.
  const limitTiles = rateLimit(
    createLimiter({ capacity: Number(process.env.RATE_TILE_BURST ?? 400),
                    perMinute: Number(process.env.RATE_TILE_PER_MIN ?? 3000), name: "tiles" }),
    auth.identify);
  const limitStats = rateLimit(
    createLimiter({ capacity: 30, perMinute: 120, name: "point-stats" }), auth.identify);

  const tileCache = new Lru(Number(process.env.POINT_TILE_CACHE ?? 4000));
  let statesCache = null;          // { at, states: [{state_fp, name, bbox, points}] }
  const breaksCache = new Map();

  /** Loaded state partitions, re-read at most every 5 minutes. */
  async function loadedStates() {
    if (statesCache && Date.now() - statesCache.at < 300_000) return statesCache;
    const { rows } = await pool.query(`
      SELECT right(c.relname, 2) AS state_fp, c.reltuples::bigint AS points,
             s.name, ST_XMin(s.geom) w, ST_YMin(s.geom) s, ST_XMax(s.geom) e, ST_YMax(s.geom) n
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent AND p.relname = 'fine_pt'
        LEFT JOIN LATERAL (SELECT name, geom FROM geo_unit
                            WHERE level = 'state' AND geoid = right(c.relname, 2)) s ON true
       ORDER BY 1`);
    const states = rows.map((r) => ({
      state_fp: r.state_fp, name: r.name, points: Number(r.points),
      bbox: r.w === null ? null : [r.w, r.s, r.e, r.n].map(Number),
    }));
    statesCache = { at: Date.now(), states, key: states.map((s) => s.state_fp).join("") };
    // The planner swaps in point distances only where points exist.
    require("./planner/point_distance").setLoadedStates(states.map((s) => s.state_fp));
    return statesCache;
  }
  loadedStates().catch((err) => console.error("fine points: partitions not read:", err.message));
  setInterval(() => { loadedStates().catch(() => {}); }, 300_000).unref();

  /** Six quantile classes from a 1% block sample of every loaded point; cached. */
  async function breaksFor(col, key) {
    const k = `${col}|${key}`;
    if (breaksCache.has(k)) return breaksCache.get(k);
    const { rows } = await pool.query(
      `SELECT percentile_cont($1::float8[]) WITHIN GROUP (ORDER BY ${col}) AS q,
              min(${col}) AS lo, max(${col}) AS hi
         FROM fine_pt TABLESAMPLE SYSTEM (1) REPEATABLE (7) WHERE ${col} IS NOT NULL`, [QUANTS]);
    const q = (rows[0].q || []).map(Number);
    const breaks = roundBreaks(q, Number(rows[0].lo), Number(rows[0].hi));
    const out = { breaks, min: Number(rows[0].lo), max: Number(rows[0].hi), quantiles: QUANTS };
    breaksCache.set(k, out);
    return out;
  }

  app.get("/api/points/catalog", auth.requireAuth, limitTiles, async (req, res) => {
    try {
      const st = await loadedStates();
      res.json({
        columns: COLUMNS, states: st.states,
        total_points: st.states.reduce((a, s) => a + s.points, 0),
        min_zoom: MIN_Z, cell_min_zoom: CELL_MIN_Z, point_budget: POINT_BUDGET,
        thresholds: THRESHOLDS,
        note: "Straight-line distances to the nearest facility (not driving distance), "
            + "from the 2020 block centroids and hexagon sample points of the L48 GeoARK geodatabase.",
      });
    } catch (err) {
      console.error("points catalog:", err.message);
      res.status(500).json({ error: "points catalog failed", details: err.message });
    }
  });

  app.get("/api/points/breaks", auth.requireAuth, limitTiles, async (req, res) => {
    const col = BY_COLUMN.get(req.query.m)?.column;
    if (!col) return res.status(400).json({ error: "unknown measure" });
    try {
      const b = req.query.bbox ? parseBbox(req.query.bbox) : null;
      if (b) {
        // Breaks for the view: city-scale detail is invisible on statewide
        // classes (all of Columbia MO is in the first sixth for hospitals).
        // Up to 200k points read exactly, else a 2% block sample of the view.
        const { rows: [{ k }] } = await pool.query(
          `SELECT count(*)::int AS k FROM (SELECT 1 FROM fine_pt
            WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326) LIMIT 200001) s`, b);
        const from = k > 200000 ? "fine_pt TABLESAMPLE SYSTEM (2) REPEATABLE (7)" : "fine_pt";
        const { rows: [r] } = await pool.query(
          `SELECT percentile_cont($1::float8[]) WITHIN GROUP (ORDER BY ${col}) AS q, min(${col}) lo, max(${col}) hi
             FROM ${from} WHERE geom && ST_MakeEnvelope($2, $3, $4, $5, 4326) AND ${col} IS NOT NULL`,
          [QUANTS, ...b]);
        const breaks = roundBreaks((r.q || []).map(Number), Number(r.lo), Number(r.hi));
        return res.json({ column: col, breaks, min: Number(r.lo), max: Number(r.hi), quantiles: QUANTS,
          scope: "view", points: k > 200000 ? null : k, sampled: k > 200000 });
      }
      const st = await loadedStates();
      res.json({ column: col, scope: "all", ...(await breaksFor(col, st.key)) });
    } catch (err) {
      res.status(500).json({ error: "breaks failed", details: err.message });
    }
  });

  app.get("/api/points/tile/:z/:x/:y", auth.requireAuth, limitTiles, async (req, res) => {
    const t0 = Date.now();
    const t = tileArgs(req.params);
    const col = BY_COLUMN.get(req.query.m)?.column;
    if (!t) return res.status(400).json({ error: "bad tile" });
    if (!col) return res.status(400).json({ error: "unknown measure" });
    const want = req.query.mode === "cells" ? "cells" : req.query.mode === "points" ? "points" : "auto";
    res.set("Cache-Control", "private, max-age=3600");
    if (t.z < MIN_Z) return res.json({ mode: "empty", reason: "zoom", n: 0, d: [] });
    try {
      const st = await loadedStates();
      const key = `${st.key}|${col}|${want}|${t.z}/${t.x}/${t.y}`;
      const hit = tileCache.get(key);
      if (hit) return res.json({ ...hit, ms: Date.now() - t0, cached: true });

      // The tile plus a 6 px margin, so a dot on the edge is drawn in both tiles.
      const env = `ST_Transform(ST_TileEnvelope(${t.z}, ${t.x}, ${t.y}, margin => ${6 / 256}), 4326)`;
      const { rows: [{ n }] } = await pool.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM fine_pt WHERE geom && ${env} LIMIT ${POINT_BUDGET + 1}) s`);
      const { px, py } = pixelSql(t.z, t.x, t.y);
      let out;
      // Thiessen cells cover the ground, not just where points are: zoomed in,
      // a tile can hold no point at all and still lie inside cells, so it is
      // never "empty" in cells mode (the basemap used to show through there).
      const cellsWanted = want === "cells" && t.z >= CELL_MIN_Z && n <= CELL_BUDGET;
      if (n === 0 && !cellsWanted) {
        out = { mode: "empty", n: 0, d: [] };
      } else if (n > POINT_BUDGET && want !== "points") {
        const cells = 256 / AGG_CELL;
        const { rows } = await pool.query(`
          SELECT cx, cy, avg(v)::real AS v, count(*)::int AS k FROM (
            SELECT floor(${px} / ${AGG_CELL})::int AS cx, floor(${py} / ${AGG_CELL})::int AS cy, ${col} AS v
              FROM fine_pt WHERE geom && ${env} AND ${col} IS NOT NULL) s
           WHERE cx BETWEEN 0 AND ${cells - 1} AND cy BETWEEN 0 AND ${cells - 1}
           GROUP BY 1, 2`);
        const d = [];
        let total = 0;
        for (const r of rows) { d.push(r.cx, r.cy, Math.round(r.v * 100) / 100, r.k); total += r.k; }
        out = { mode: "agg", cell: AGG_CELL, n: total, d };
      } else if (cellsWanted) {
        // Tile centre as a constant: a KNN ORDER BY over a CTE's point is not index-ordered.
        const cLon = ((t.x + 0.5) / 2 ** t.z) * 360 - 180;
        const cLat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (t.y + 0.5)) / 2 ** t.z))) * 180) / Math.PI;
        // Voronoi in Web Mercator (conformal, so a cell has the shape the map
        // shows) over the tile plus half a tile each side, AND the 80 points
        // nearest the tile centre: zoomed in past the point spacing, the tile
        // and its margin hold few or no points, and the cells covering it come
        // from points farther out. The Voronoi extent is the box holding all of
        // them. ST_AsMVTGeom clips to the tile, in pixels (extent 256, y down).
        const { rows } = await pool.query(`
          WITH t AS (SELECT ST_TileEnvelope(${t.z}, ${t.x}, ${t.y}) e),
               b AS (SELECT ST_Expand(e, (ST_XMax(e) - ST_XMin(e)) * 0.5) b FROM t),
               p AS (SELECT DISTINCT ON (pt_id, state_fp) pt_id, v, g FROM (
                       SELECT f.state_fp, f.pt_id, f.${col} AS v, ST_Transform(f.geom, 3857) g
                         FROM fine_pt f, b WHERE f.geom && ST_Transform(b.b, 4326)
                       UNION ALL
                       SELECT * FROM (SELECT f.state_fp, f.pt_id, f.${col} AS v, ST_Transform(f.geom, 3857) g
                         FROM fine_pt f ORDER BY f.geom <-> ST_SetSRID(ST_MakePoint(${cLon}, ${cLat}), 4326) LIMIT 80) k) u),
               x AS (SELECT ST_Expand(ST_Envelope(ST_Collect(ARRAY[(SELECT b FROM b), ST_Collect(g)])),
                            (SELECT ST_XMax(e) - ST_XMin(e) FROM t)) AS x FROM p),
               c AS (SELECT (ST_Dump(ST_VoronoiPolygons(ST_Collect(g), 0, (SELECT x FROM x)))).geom AS c FROM p)
          SELECT p.v, ST_AsGeoJSON(ST_AsMVTGeom(c.c, t.e, 256, 2, true), 1) AS g
            FROM c JOIN p ON ST_Intersects(c.c, p.g) AND ST_Contains(c.c, p.g), t
           WHERE c.c && t.e`);
        const polys = [];
        for (const r of rows) {
          if (!r.g) continue;
          const g = JSON.parse(r.g);
          const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
          polys.push({ v: r.v === null ? null : Math.round(r.v * 100) / 100, r: rings.map((ring) => ring.flat()) });
        }
        out = { mode: "cells", n: polys.length, polys, d: [] };
      } else {
        const { rows } = await pool.query(`
          SELECT round((${px})::numeric, 1)::float8 AS x, round((${py})::numeric, 1)::float8 AS y,
                 ${col} AS v, is_centroid AS c
            FROM fine_pt WHERE geom && ${env} LIMIT ${want === "points" ? 50000 : POINT_BUDGET}`);
        const d = [];
        for (const r of rows) d.push(r.x, r.y, r.v === null ? null : Math.round(r.v * 100) / 100, r.c ? 1 : 0);
        out = { mode: "points", n: rows.length, d, truncated: want === "points" && rows.length === 50000 };
      }
      out.z = t.z;
      out.sql_ms = Date.now() - t0;
      tileCache.set(key, out);
      res.json({ ...out, ms: Date.now() - t0, cached: false });
    } catch (err) {
      console.error("points tile:", err.message);
      res.status(500).json({ error: "tile failed", details: err.message });
    }
  });

  app.get("/api/points/at", auth.requireAuth, limitTiles, async (req, res) => {
    const t0 = Date.now();
    const lat = Number(req.query.lat), lon = Number(req.query.lon);
    const z = Math.max(0, Math.min(20, Number(req.query.z) || 12));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat, lon required" });
    // Tolerance: 10 screen pixels at this zoom, in metres on the ground.
    const tolM = 10 * 156543.03 * Math.cos((lat * Math.PI) / 180) / 2 ** z;
    try {
      const cols = COLUMNS.map((c) => c.column).join(", ");
      // The query point is a constant expression, not a CTE column: a KNN
      // ORDER BY over a CTE's point is not index-ordered (1.3 s vs 1 ms).
      const Q = "ST_SetSRID(ST_MakePoint($1, $2), 4326)";
      const { rows } = await pool.query(`
        SELECT f.state_fp, f.pt_id, f.block20, f.grid_id, f.is_centroid, f.zip, f.huc12, f.thiessen_m2,
               f.power_line_density, f.ems_fid, ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat, ${cols},
               ST_Distance(f.geom::geography, ${Q}::geography) AS off_m
          FROM fine_pt f ORDER BY f.geom <-> ${Q} LIMIT 1`, [lon, lat]);
      const p = rows[0];
      // The nearest point IS the point whose Thiessen cell holds the click, so
      // any click inside the loaded area selects one; the tolerance only stops
      // a click far outside it picking a point.
      if (!p || p.off_m > Math.max(tolM, 3000)) {
        return res.json({ found: false, tolerance_m: Math.round(tolM), ms: Date.now() - t0 });
      }
      // Its Thiessen cell, from its 60 nearest neighbours: enough that no
      // farther point can cut the cell (checked by the area test in the plan).
      const [{ rows: cell }, { rows: units }] = await Promise.all([
        pool.query(`
          WITH nb AS (SELECT ST_Transform(f.geom, 3857) g FROM fine_pt f
                       ORDER BY f.geom <-> ${Q} LIMIT 60),
               v AS (SELECT (ST_Dump(ST_VoronoiPolygons(ST_Collect(g)))).geom c FROM nb)
          SELECT ST_AsGeoJSON(ST_Transform(v.c, 4326), 6) AS g,
                 ST_Area(ST_Transform(v.c, 4326)::geography) AS m2
            FROM v WHERE ST_Contains(v.c, ST_Transform(${Q}, 3857))`, [Number(p.lon), Number(p.lat)]),
        pool.query(`
          SELECT level, geoid, name FROM geo_unit
           WHERE (level = 'county' AND geoid = left($1, 5)) OR (level = 'tract' AND geoid = left($1, 11))
              OR (level = 'bg' AND geoid = left($1, 12)) OR (level = 'state' AND geoid = left($1, 2))`,
          [p.block20]),
      ]);
      const distances = COLUMNS.map((c) => ({ column: c.column, label: c.short,
        miles: p[c.column] === null ? null : Number(p[c.column]) }));
      res.json({
        found: true, ms: Date.now() - t0,
        point: {
          id: `${p.state_fp}:${p.pt_id}`, lon: Number(p.lon), lat: Number(p.lat), block20: p.block20,
          kind: p.is_centroid ? "block centroid" : "hexagon point", grid_id: p.is_centroid ? null : p.grid_id,
          zip: p.zip, huc12: p.huc12, thiessen_km2: p.thiessen_m2 === null ? null : Number(p.thiessen_m2) / 1e6,
          power_line_density: p.power_line_density,
        },
        units: Object.fromEntries(units.map((u) => [u.level, { geoid: u.geoid, name: u.name }])),
        distances,
        cell: cell[0] ? { geometry: JSON.parse(cell[0].g), km2: Number(cell[0].m2) / 1e6 } : null,
      });
    } catch (err) {
      console.error("points at:", err.message);
      res.status(500).json({ error: "lookup failed", details: err.message });
    }
  });

  app.get("/api/points/stats", auth.requireAuth, limitStats, async (req, res) => {
    const t0 = Date.now();
    const col = BY_COLUMN.get(req.query.m)?.column;
    if (!col) return res.status(400).json({ error: "unknown measure" });
    // The area: a named unit, a radius around a point, or the view.
    let where; const params = [];
    let area;
    const LEVEL_DIGITS = { state: 2, county: 5, tract: 11, bg: 12 };
    if (req.query.level && req.query.geoid) {
      const level = String(req.query.level), geoid = String(req.query.geoid);
      if (LEVEL_DIGITS[level] && /^\d+$/.test(geoid) && geoid.length === LEVEL_DIGITS[level]) {
        // Census units nest in blocks: a prefix of block20 is exact and indexed.
        // Compared as bpchar: as text the btree is not used (577 ms vs 10 ms, Boone).
        params.push(geoid.slice(0, 2));
        if (level !== "state") params.push(geoid);
        where = level === "state" ? "f.state_fp = $1"
          : `f.state_fp = $1 AND f.block20 >= $2::bpchar AND f.block20 < ($2::text || 'z')::bpchar`;
      } else if (/^(zcta|place)$/.test(level) && /^\d{5,7}$/.test(geoid)) {
        params.push(level, geoid);
        where = `f.geom && u.geom AND ST_Intersects(f.geom, u.geom)`;
        area = { join: "JOIN geo_unit u ON u.level = $1 AND u.geoid = $2" };
      } else {
        return res.status(400).json({ error: "level must be state, county, tract, bg, zcta or place with its GEOID" });
      }
    } else if (req.query.radius_mi) {
      const lat = Number(req.query.lat), lon = Number(req.query.lon), r = Number(req.query.radius_mi);
      if (![lat, lon, r].every(Number.isFinite) || r <= 0 || r > 100) {
        return res.status(400).json({ error: "lat, lon and radius_mi (0-100) required" });
      }
      params.push(lon, lat, r * 1609.344);
      const box = `ST_Expand(ST_SetSRID(ST_MakePoint($1,$2),4326), $3 / 110574.0 / cos(radians(least(abs($2) + $3/110574.0, 89))))`;
      where = `f.geom && ${box} AND ST_DWithin(f.geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)`;
    } else {
      const b = parseBbox(req.query.bbox);
      if (!b) return res.status(400).json({ error: "give level+geoid, lat+lon+radius_mi, or bbox" });
      params.push(...b);
      where = "f.geom && ST_MakeEnvelope($1,$2,$3,$4,4326)";
    }
    const join = area?.join || "";
    try {
      const { rows: [{ k }] } = await pool.query(
        `SELECT count(*)::int AS k FROM (SELECT 1 FROM fine_pt f ${join} WHERE ${where} LIMIT ${STATS_MAX + 1}) s`, params);
      if (k > STATS_MAX) {
        return res.status(413).json({ error: `more than ${STATS_MAX.toLocaleString()} points in that area; choose a smaller one` });
      }
      const share = THRESHOLDS.map((m) => `avg((f.${col} > ${m})::int)::float8 AS gt_${m}`).join(", ");
      const shareA = THRESHOLDS.map((m) =>
        `sum(CASE WHEN f.${col} > ${m} THEN f.thiessen_m2 ELSE 0 END)::float8 / nullif(sum(f.thiessen_m2), 0) AS agt_${m}`).join(", ");
      const { rows: [r] } = await pool.query(`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE f.is_centroid)::int AS n_centroid,
               count(DISTINCT f.block20)::int AS blocks, count(f.${col})::int AS n_value,
               avg(f.${col})::float8 AS mean,
               percentile_cont(ARRAY[0.1, 0.5, 0.9]) WITHIN GROUP (ORDER BY f.${col}) AS q,
               min(f.${col})::float8 AS min, max(f.${col})::float8 AS max,
               (sum(f.${col} * f.thiessen_m2) / nullif(sum(f.thiessen_m2) FILTER (WHERE f.${col} IS NOT NULL), 0))::float8 AS area_mean,
               (sum(f.thiessen_m2) / 1e6)::float8 AS km2,
               ${share}, ${shareA}
          FROM fine_pt f ${join} WHERE ${where}`, params);
      const q = (r.q || []).map(Number);
      // The block mean of points, then the mean of blocks: what the summary
      // tables (Step 1, hsip_proximity_*) hold, so the two can be compared.
      const { rows: [bm] } = await pool.query(`
        SELECT avg(b)::float8 AS block_mean FROM (
          SELECT avg(f.${col}) AS b FROM fine_pt f ${join} WHERE ${where} GROUP BY f.block20) s`, params);
      res.json({
        column: col, label: BY_COLUMN.get(col).label, units: "miles",
        n: r.n, n_centroid: r.n_centroid, n_value: r.n_value, blocks: r.blocks,
        km2: r.km2, mean: r.mean, block_mean: bm.block_mean, area_mean: r.area_mean,
        p10: q[0] ?? null, median: q[1] ?? null, p90: q[2] ?? null, min: r.min, max: r.max,
        beyond: THRESHOLDS.map((m) => ({ miles: m, share_points: r[`gt_${m}`], share_area: r[`agt_${m}`] })),
        ms: Date.now() - t0,
      });
    } catch (err) {
      console.error("points stats:", err.message);
      res.status(500).json({ error: "stats failed", details: err.message });
    }
  });
}

module.exports = { register, COLUMNS, BY_COLUMN, pixelSql, tileArgs, parseBbox, nice, roundBreaks, POINT_BUDGET };
