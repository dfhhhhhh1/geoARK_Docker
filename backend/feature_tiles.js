/**
 * Large point answers, drawn as tiles instead of capped GeoJSON.
 *
 * A `select_features` answer is capped at MAX_FEATURES (3,000) rows, because
 * the whole answer travels as GeoJSON and every point becomes a Leaflet path.
 * "Fire stations in the US" is 52,184 points, so the map showed whichever
 * 3,000 the table returned first: a few states, scattered others.
 *
 * When an answer hits the cap and is all points, executePlan runs the same
 * query once more with a far higher limit and hands the rows to `store()`:
 * coordinates in two Float64Arrays, labels kept per row, a 0.25-degree grid
 * index. The map then asks for 256 px tiles (`/api/featuresets/:id/tile`),
 * built from memory with no database work: every point in the tile, or, when
 * a tile holds more than POINT_BUDGET, a count per 4x4 px cell. Hover and
 * click ask `/at` for the nearest point. The first MAX_FEATURES rows still
 * ride in the response for the table and the exports.
 *
 * Kept in memory for TTL_MS and at most MAX_SETS sets (least recently used
 * goes first); a set that has expired answers 410 and the map says to re-run.
 * The rows are the answer's own (read-only transaction, same SQL), so nothing
 * here can show data the answer did not.
 */

"use strict";

const crypto = require("crypto");
const { createLimiter, rateLimit } = require("./ratelimit");

const MAX_POINTS = Number(process.env.FEATURE_TILE_MAX ?? 500_000);
const TTL_MS = 4 * 3600 * 1000;
const MAX_SETS = 40;
const POINT_BUDGET = 6000;
const AGG_CELL = 4;
const GRID = 0.25;   // degrees per index cell

const sets = new Map();   // id -> set, insertion order = recency

function sweep() {
  const now = Date.now();
  for (const [id, s] of sets) if (now - s.used > TTL_MS) sets.delete(id);
  while (sets.size > MAX_SETS) sets.delete(sets.keys().next().value);
}

/** First coordinate of a point geometry, or null for anything else. */
function pointOf(g) {
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "MultiPoint" && g.coordinates.length) return g.coordinates[0];
  return null;
}

/**
 * Keep an answer's rows for tiling. `rows` are executePlan's raw rows
 * ({geometry: GeoJSON text, ...labels}). Returns the set's public summary, or
 * null when it is not a point layer (lines and polygons keep the cap).
 */
function store(rows, labels) {
  const n = Math.min(rows.length, MAX_POINTS);
  const xs = new Float64Array(n), ys = new Float64Array(n);
  const props = new Array(n);
  const index = new Map();
  let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
  for (let i = 0; i < n; i++) {
    let g;
    try { g = JSON.parse(rows[i].geometry); } catch { g = null; }
    const p = pointOf(g);
    if (!p) return null;
    const [x, y] = p;
    xs[i] = x; ys[i] = y;
    props[i] = Object.fromEntries(labels.map((c) => [c, rows[i][c] ?? null]));
    const key = `${Math.floor(x / GRID)}:${Math.floor(y / GRID)}`;
    let cell = index.get(key);
    if (!cell) { cell = []; index.set(key, cell); }
    cell.push(i);
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > nn) nn = y;
  }
  const id = crypto.randomBytes(9).toString("base64url");
  sets.set(id, { xs, ys, props, index, n, used: Date.now(), truncated: rows.length > MAX_POINTS });
  sweep();
  return { id, total: n, truncated: rows.length > MAX_POINTS, bbox: n ? [w, s, e, nn] : null };
}

function get(id) {
  const s = sets.get(id);
  if (!s) return null;
  if (Date.now() - s.used > TTL_MS) { sets.delete(id); return null; }
  s.used = Date.now();
  sets.delete(id); sets.set(id, s);   // most recent last
  return s;
}

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** Indices of the points inside a lon/lat box, through the grid index. */
function inBox(set, w, s, e, n) {
  const out = [];
  const c0 = Math.floor(w / GRID), c1 = Math.floor(e / GRID);
  const r0 = Math.floor(s / GRID), r1 = Math.floor(n / GRID);
  // A box spanning more cells than the set has: scan the cells instead.
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > set.index.size) {
    for (const cell of set.index.values()) for (const i of cell) {
      const x = set.xs[i], y = set.ys[i];
      if (x >= w && x <= e && y >= s && y <= n) out.push(i);
    }
    return out;
  }
  for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
    const cell = set.index.get(`${c}:${r}`);
    if (!cell) continue;
    for (const i of cell) {
      const x = set.xs[i], y = set.ys[i];
      if (x >= w && x <= e && y >= s && y <= n) out.push(i);
    }
  }
  return out;
}

function tile(set, z, x, y) {
  // The tile plus a 6 px margin, so a dot on an edge is drawn in both tiles.
  const m = 6 / 256;
  const w = x2lon(x - m, z), e = x2lon(x + 1 + m, z);
  const n = y2lat(y - m, z), s = y2lat(y + 1 + m, z);
  const idx = inBox(set, w, s, e, n);
  if (idx.length > POINT_BUDGET) {
    const cells = new Map();
    for (const i of idx) {
      const cx = Math.floor(((lon2x(set.xs[i], z) - x) * 256) / AGG_CELL);
      const cy = Math.floor(((lat2y(set.ys[i], z) - y) * 256) / AGG_CELL);
      if (cx < 0 || cy < 0 || cx >= 256 / AGG_CELL || cy >= 256 / AGG_CELL) continue;
      const k = cx * 1000 + cy;
      cells.set(k, (cells.get(k) || 0) + 1);
    }
    const d = [];
    for (const [k, c] of cells) d.push(Math.floor(k / 1000), k % 1000, c);
    return { mode: "agg", cell: AGG_CELL, n: idx.length, d };
  }
  const d = [];
  for (const i of idx) {
    d.push(Math.round((lon2x(set.xs[i], z) - x) * 2560) / 10, Math.round((lat2y(set.ys[i], z) - y) * 2560) / 10);
  }
  return { mode: "points", n: idx.length, d };
}

/** Nearest point to (lat, lon) within `tolPx` screen pixels at zoom z. */
function nearest(set, lat, lon, z, tolPx = 8) {
  const degPerPx = 360 / (256 * 2 ** z);
  const tol = tolPx * degPerPx;
  const cos = Math.cos((lat * Math.PI) / 180);
  const idx = inBox(set, lon - tol, lat - tol * cos, lon + tol, lat + tol * cos);
  let best = -1, bd = Infinity;
  for (const i of idx) {
    const dx = (set.xs[i] - lon) * cos, dy = set.ys[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || Math.sqrt(bd) > tol * cos * 1.42) return null;
  return { lon: set.xs[best], lat: set.ys[best], properties: set.props[best] };
}

function register(app, { auth }) {
  const limit = rateLimit(
    createLimiter({ capacity: Number(process.env.RATE_TILE_BURST ?? 400),
                    perMinute: Number(process.env.RATE_TILE_PER_MIN ?? 3000), name: "featuretiles" }),
    auth.identify);

  app.get("/api/featuresets/:id/tile/:z/:x/:y", auth.requireAuth, limit, (req, res) => {
    const set = get(req.params.id);
    if (!set) return res.status(410).json({ error: "this map's points have expired; run the question again" });
    const z = Number(req.params.z), x = Number(req.params.x), y = Number(req.params.y);
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
      return res.status(400).json({ error: "bad tile" });
    }
    const t0 = process.hrtime.bigint();
    const out = tile(set, z, x, y);
    res.set("Cache-Control", "private, max-age=3600");
    res.json({ ...out, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  });

  app.get("/api/featuresets/:id/at", auth.requireAuth, limit, (req, res) => {
    const set = get(req.params.id);
    if (!set) return res.status(410).json({ error: "expired" });
    const lat = Number(req.query.lat), lon = Number(req.query.lon), z = Number(req.query.z);
    if (![lat, lon, z].every(Number.isFinite)) return res.status(400).json({ error: "lat, lon, z required" });
    res.json({ found: nearest(set, lat, lon, z) });
  });
}

module.exports = { register, store, get, tile, nearest, MAX_POINTS };
