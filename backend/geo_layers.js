/**
 * The multi-scale map: any loaded measure, at whatever geographic level fits
 * the screen. docs/DATA_LOADING_PLAN.md, Phase 5.
 *
 *   GET /api/geo/catalog                        measures, the levels each exists at, datasets
 *   GET /api/geo/layer?code=&bbox=&z=[&level=][&year=][&per=km2][&family=]
 *                                               GeoJSON for the view, at the chosen level
 *
 * THE RULE: DRAW THE FINEST LEVEL WHOSE UNIT COUNT IN VIEW FITS THE BUDGET.
 * Not zoom alone. At the same zoom Manhattan holds hundreds of tracts and
 * Nevada a dozen, so a zoom threshold would either drown the browser in
 * Manhattan or show counties in Nevada long after tracts would have fit.
 * Counting units in the bounding box is one indexed query per level.
 *
 * BINS ARE NATIONAL AND COMPUTED ONCE per (measure, level, year, per). If the
 * colour breaks were recomputed per viewport, the same tract would change
 * colour as you panned past it, which reads as the data changing.
 *
 * COUNTS ARE SHOWN AS DENSITIES BY DEFAULT. A choropleth of a COUNT mostly
 * maps unit size: tracts are drawn to hold ~4,000 people each, so "population
 * by tract" is a flat map, and a big rural county outshines a dense small one.
 * `per=km2` divides by area; it is on by default for count measures and the
 * readout always carries the raw value too.
 *
 * Everything here is read-only and parameterised. The one identifier that is
 * interpolated, a raster's table name, comes from raster_layer and is checked
 * against a strict pattern first.
 */

"use strict";

const { createLimiter, rateLimit } = require("./ratelimit");

const LEVELS = {
  pixel:   { label: "1 km pixels",     family: "grid",  order: 1 },
  grid4k:  { label: "4 km grid",       family: "grid",  order: 2 },
  grid16k: { label: "16 km grid",      family: "grid",  order: 4 },
  grid64k: { label: "64 km grid",      family: "grid",  order: 7 },
  bg:      { label: "Block groups",    family: "admin", order: 2 },
  tract:   { label: "Census tracts",   family: "admin", order: 3 },
  zcta:    { label: "ZIP code areas",  family: "admin", order: 4 },
  place:   { label: "Places",          family: "admin", order: 4.5 },
  county:  { label: "Counties",        family: "admin", order: 6 },
  state:   { label: "States",          family: "admin", order: 8 },
};

// Units drawn at once. Must admit every county (3,233): the national county
// map is the baseline view. Measured worst payloads at this density: 3,108
// counties ~1 MB, 2,912 tracts (z9 tier) 2.0 MB, 1,991 ZCTAs 3.1 MB.
// Pixels and grid cells are 5-vertex squares and can be denser.
const BUDGET_POLY = 3600;
const BUDGET_CELL = 8000;

const COUNT_UNITS = /\b(person|persons|people|count|households?|housing units?|residents?)\b/i;
const SAFE_TABLE = /^raster_[a-z0-9]{1,24}$/;
const QUANTS = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];
// Densities are heavily right-skewed: most of the country's 4 km cells are
// rural, so even sixths put every city in the top class and a metro reads as
// one flat block. Breaks deeper in the tail keep them national and stable but
// resolve the urban gradient. Used whenever a count is shown per km^2.
const QUANTS_TAIL = [0.35, 0.6, 0.8, 0.92, 0.98];

/**
 * km^2 of a lat/long pixel, from its centre latitude. Analytic rather than
 * ST_Area(geography): a pixel's area depends on latitude alone, and the
 * geography call made the first pixel-level request take 11 s.
 */
const pixelKm2Sql = (geomExpr, r) =>
  `((6371.0088 * radians(${r.pixel_x})) * (6371.0088 * radians(${-r.pixel_y}))` +
  ` * cos(radians(ST_Y(ST_Centroid(${geomExpr})))))`;

function budgetFor(level) {
  return LEVELS[level]?.family === "grid" ? BUDGET_CELL : BUDGET_POLY;
}

/** Display geometry for a zoom: the coarsest pre-simplified tier still finer than a pixel. */
function geomFor(z) {
  if (z < 7.5) return "COALESCE(u.geom_z6, u.geom_z9, u.geom_z12, u.geom)";
  if (z < 10.5) return "COALESCE(u.geom_z9, u.geom_z12, u.geom)";
  return "COALESCE(u.geom_z12, u.geom)";
}

/** Coordinate precision for a zoom: ~11 m (4 places) is invisible below z11. */
const precisionFor = (z) => (z < 11 ? 4 : 5);

function parseBbox(s) {
  const p = String(s || "").split(",").map(Number);
  if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
  let [w, so, e, n] = p;
  // Leaflet reports longitudes past +-180 after a pan across the antimeridian.
  w = Math.max(-180, Math.min(180, w)); e = Math.max(-180, Math.min(180, e));
  so = Math.max(-85, Math.min(85, so)); n = Math.max(-85, Math.min(85, n));
  if (e <= w || n <= so) return null;
  return [w, so, e, n];
}

// ------------------------------------------------- derived values (Phase 6)
/**
 * Levels a measure can be ESTIMATED at from a finer level it is stored at,
 * via geoark_aggregate (etl/schema_geo.sql). Validated against published
 * values (docs/DATA_LOADING_PLAN.md, Progress): counts summed from tracts
 * match the county file exactly; rates weighted by population track it at
 * r 0.998 (tract) and 0.978 (ZIP areas via the crosswalk).
 *
 *   county  from tract (nested) or ZIP areas (crosswalk). Where county is
 *           also stored, only units WITHOUT a stored value are filled:
 *           Connecticut and Valdez-Cordova, the newer county vintage.
 *   zcta    from tract, through the crosswalk.
 *
 * Never for percentile ranks: a population-weighted mean of tract
 * percentiles is not a county percentile, so those stay blank.
 */
function derivationsFor(m, isCount, all) {
  if (/percentile/i.test(m.units || "")) return {};
  const has = (l) => Boolean(m.levels[l] && !m.levels[l].derived);
  const method = isCount ? "sum" : "wmean";
  const weightAt = (lvl) => {
    if (isCount) return null;
    const same = all.find((x) => x.dataset_id === m.dataset_id && x.levels[lvl]
      && /(_E_TOTPOP|_TOTALPOPULATION)$/i.test(x.code));
    if (same) return same.code;
    return all.find((x) => x.code === "WORLDPOP_POP" && x.levels[lvl]) ? "WORLDPOP_POP" : null;
  };
  const out = {};
  const countyFrom = has("tract") ? "tract" : has("zcta") ? "zcta" : null;
  if (countyFrom) out.county = { from: countyFrom, method, weight: weightAt(countyFrom) };
  if (!has("zcta") && has("tract")) out.zcta = { from: "tract", method, weight: weightAt("tract") };
  // A rate with no population to weight by would fall back to land area,
  // which over-weights empty land; better not to offer it.
  for (const [k, d] of Object.entries(out)) if (method === "wmean" && !d.weight) delete out[k];
  return out;
}

/**
 * The level to draw: the finest of `levels` (ordered fine to coarse) whose
 * count in view fits its budget, else the coarsest, flagged as over.
 */
function chooseLevel(levels, counts) {
  const fit = levels.find((l) => counts[l.level] <= budgetFor(l.level));
  return fit
    ? { level: fit.level, reason: "finest level that fits the view" }
    : { level: levels[levels.length - 1].level, reason: "even the coarsest level is over budget" };
}

function register(app, { pool, auth }) {
  // Panning fires a request per settle; the search limiter (60/min) would 429
  // a user exploring a city. Its own bucket, generous but finite.
  const limitMap = rateLimit(
    createLimiter({ capacity: Number(process.env.RATE_MAP_BURST ?? 120),
                    perMinute: Number(process.env.RATE_MAP_PER_MIN ?? 600), name: "map" }),
    auth.identify);

  const derivedCache = new Map();
  async function derivedValues(code, level, d, year) {
    const key = `${code}|${level}|${year}`;
    if (derivedCache.has(key)) return derivedCache.get(key);
    const { rows } = await pool.query(
      "SELECT geoid, value, coverage, parts FROM geoark_aggregate($1, $2, $3, $4, $5, $6)",
      [code, year, d.from, level, d.method, d.weight]);
    const map = new Map(rows.map((r) => [r.geoid, { value: Number(r.value),
      coverage: r.coverage === null ? null : Number(r.coverage), parts: r.parts }]));
    derivedCache.set(key, map);
    return map;
  }

  /** Linear-interpolated percentiles, the same definition as percentile_cont. */
  function quantilesOf(sorted, qs) {
    return qs.map((q) => {
      const pos = q * (sorted.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, sorted.length - 1);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    });
  }

  // ---------------------------------------------------------------- catalog
  let catalogCache = null;
  let catalogAt = 0;

  async function loadCatalog() {
    if (catalogCache && Date.now() - catalogAt < 60_000) return catalogCache;
    const { rows: gm } = await pool.query(`
      SELECT m.code, m.level, m.label, m.description, m.units, m.min_year, m.max_year,
             m.n_units, m.dataset_id, d.name AS dataset_name, d.source_url, d.originator
        FROM geo_measure m LEFT JOIN dataset_info d USING (dataset_id)`);
    const { rows: rasters } = await pool.query(
      `SELECT id, table_name, code, aggregate, year, origin_x, origin_y, pixel_x, pixel_y,
              width, height FROM raster_layer`);
    const codes = [...new Set(gm.map((r) => r.code))];
    // A measure loaded at ZCTA under an EXISTING county code (PLACES) has its
    // county values in acs_county_values, not geo_measure. Find them.
    const { rows: cty } = codes.length ? await pool.query(`
      SELECT census_code AS code, min(year) AS min_year, max(year) AS max_year,
             count(DISTINCT fips) AS n_units
        FROM acs_county_values WHERE census_code = ANY($1) GROUP BY 1`, [codes]) : { rows: [] };
    const { rows: desc } = codes.length ? await pool.query(
      `SELECT attr_id, description FROM attribute_source WHERE attr_id = ANY($1)`, [codes])
      : { rows: [] };
    const descOf = Object.fromEntries(desc.map((d) => [d.attr_id, d.description]));

    const byCode = new Map();
    for (const r of gm) {
      const m = byCode.get(r.code) || {
        code: r.code, label: r.description || descOf[r.code] || r.label, units: r.units || null,
        dataset_id: r.dataset_id, dataset: r.dataset_name || r.dataset_id,
        source_url: r.source_url, originator: r.originator, levels: {},
      };
      if (!m.units && r.units) m.units = r.units;
      m.levels[r.level] = { min_year: r.min_year, max_year: r.max_year, n_units: r.n_units };
      byCode.set(r.code, m);
    }
    for (const r of cty) {
      const m = byCode.get(r.code);
      if (m && !m.levels.county) {
        m.levels.county = { min_year: r.min_year, max_year: r.max_year, n_units: Number(r.n_units) };
      }
    }
    const rasterByCode = new Map();
    for (const r of rasters) {
      if (!SAFE_TABLE.test(r.table_name)) continue;
      rasterByCode.set(r.code, r);
      const m = byCode.get(r.code);
      if (m) {
        m.raster = { id: r.id, aggregate: r.aggregate };
        m.levels.pixel = { min_year: r.year, max_year: r.year, n_units: null };
      }
    }
    const all = [...byCode.values()];
    const measures = all.map((m) => {
      const count = m.raster ? m.raster.aggregate === "sum" : COUNT_UNITS.test(m.units || "");
      const derive = m.raster ? {} : derivationsFor(m, count, all);
      for (const [lvl, d] of Object.entries(derive)) {
        if (m.levels[lvl]) m.levels[lvl].fill = d;
        else m.levels[lvl] = { derived: d, min_year: m.levels[d.from].min_year,
                               max_year: m.levels[d.from].max_year, n_units: null };
      }
      const levels = Object.keys(m.levels)
        .filter((l) => LEVELS[l])
        .sort((a, b) => LEVELS[a].order - LEVELS[b].order)
        .map((l) => ({ level: l, label: LEVELS[l].label, family: LEVELS[l].family, ...m.levels[l] }));
      return { ...m, levels, is_count: count };
    }).filter((m) => m.levels.length)
      .sort((a, b) => (a.dataset || "").localeCompare(b.dataset || "") || a.label.localeCompare(b.label));

    catalogCache = { measures, rasterByCode };
    catalogAt = Date.now();
    // Warm the slowest breaks (the raster's pixel level) in the background,
    // so the first zoom to 1 km does not wait on them.
    for (const m of measures.filter((x) => x.raster)) {
      const r = rasterByCode.get(m.code);
      binsFor(m, "pixel", r.year, m.is_count ? "km2" : "none", r).catch(() => {});
    }
    return catalogCache;
  }

  app.get("/api/geo/catalog", auth.requireAuth, limitMap, async (req, res) => {
    try {
      const { measures } = await loadCatalog();
      res.json({
        measures: measures.map(({ levels, ...m }) => ({ ...m, levels })),
        level_labels: Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.label])),
      });
    } catch (err) {
      res.status(500).json({ error: "catalog failed", details: err.message });
    }
  });

  // ------------------------------------------------------------------ values
  /**
   * SQL for (geoid, value[, area_km2]) of one measure at one level, plus its
   * parameters. Grid levels are filtered to the raster's own cells by prefix.
   */
  function valuesSql(code, level, year, raster) {
    if (level === "county") {
      return { sql: `SELECT fips::text AS geoid, value FROM acs_county_values
                      WHERE census_code = $1 AND year = $2`, params: [code, year] };
    }
    return { sql: `SELECT geoid, value FROM geo_values
                    WHERE level = $3 AND code = $1 AND year = $2`, params: [code, year, level] };
  }

  // ------------------------------------------------------------------- bins
  const binCache = new Map();

  async function binsFor(m, level, year, per, raster) {
    const key = `${m.code}|${level}|${year}|${per}`;
    if (binCache.has(key)) return binCache.get(key);
    const quants = per === "km2" ? QUANTS_TAIL : QUANTS;
    const lv = m.levels.find((l) => l.level === level);
    if (lv && lv.derived) {
      const vals = await derivedValues(m.code, level, lv.derived, year);
      let xs = [...vals.entries()].map(([g, v]) => [g, v.value]);
      if (per === "km2") {
        const { rows: ar } = await pool.query(
          "SELECT geoid, aland FROM geo_unit WHERE level = $1", [level]);
        const area = new Map(ar.map((r) => [r.geoid, Number(r.aland) / 1e6]));
        xs = xs.map(([g, v]) => [g, area.get(g) ? v / area.get(g) : null]);
      }
      const sorted = xs.map(([, v]) => v).filter((v) => v !== null && Number.isFinite(v))
        .sort((a, b) => a - b);
      const out = { breaks: [...new Set(quantilesOf(sorted, quants))], min: sorted[0],
                    max: sorted[sorted.length - 1], quantiles: quants };
      binCache.set(key, out);
      return out;
    }
    let rows;
    if (level === "pixel") {
      // A 20% tile sample of the raster: 6M pixels sorted once would cost
      // seconds for no visible difference in five quantile breaks.
      const expr = per === "km2" ? `(pp).val / ${pixelKm2Sql("(pp).geom", raster)}` : "(pp).val";
      ({ rows } = await pool.query(`
        SELECT percentile_cont($1::float8[]) WITHIN GROUP (ORDER BY v) AS q,
               min(v) AS lo, max(v) AS hi
          FROM (SELECT ${expr} AS v
                  FROM (SELECT ST_PixelAsCentroids(rast, 1, true) AS pp
                          FROM ${raster.table_name} TABLESAMPLE SYSTEM (20) REPEATABLE (7)) s
                 WHERE (pp).val IS NOT NULL) t`, [quants]));
    } else {
      const v = valuesSql(m.code, level, year, raster);
      const k = v.params.length;
      const expr = per === "km2" ? "v.value / NULLIF(u.aland / 1e6, 0)" : "v.value";
      ({ rows } = await pool.query(`
        SELECT percentile_cont($${k + 2}::float8[]) WITHIN GROUP (ORDER BY x) AS q,
               min(x) AS lo, max(x) AS hi
          FROM (SELECT ${expr} AS x FROM (${v.sql}) v
                  JOIN geo_unit u ON u.level = $${k + 1} AND u.geoid = v.geoid) t
         WHERE x IS NOT NULL`, [...v.params, level, quants]));
    }
    const q = rows[0]?.q || [];
    const out = { breaks: [...new Set(q.map(Number))], min: Number(rows[0]?.lo), max: Number(rows[0]?.hi),
                  quantiles: quants };
    binCache.set(key, out);
    return out;
  }

  // ---------------------------------------------------------------- counting
  async function countInView(level, bbox, raster) {
    const [w, s, e, n] = bbox;
    if (level === "pixel") {
      // Pixels in the box, an upper bound (water and empty land carry no data).
      return Math.ceil(((e - w) / raster.pixel_x) * ((n - s) / -raster.pixel_y));
    }
    const prefix = LEVELS[level].family === "grid" ? `${raster?.id}:%` : null;
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM geo_unit
        WHERE level = $1 AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
          ${prefix ? "AND geoid LIKE $6" : ""}`,
      prefix ? [level, w, s, e, n, prefix] : [level, w, s, e, n]);
    return rows[0].n;
  }

  // ------------------------------------------------------------------- layer
  app.get("/api/geo/layer", auth.requireAuth, limitMap, async (req, res) => {
    const t0 = Date.now();
    try {
      const { measures, rasterByCode } = await loadCatalog();
      const m = measures.find((x) => x.code === req.query.code);
      if (!m) return res.status(404).json({ error: `no measure ${req.query.code}` });
      const bbox = parseBbox(req.query.bbox);
      if (!bbox) return res.status(400).json({ error: "bbox must be west,south,east,north" });
      const z = Math.max(0, Math.min(20, Number(req.query.z) || 4));
      const raster = rasterByCode.get(m.code) || null;
      const per = req.query.per === "none" ? "none"
        : req.query.per === "km2" || m.is_count ? "km2" : "none";

      // Which levels are in play: an explicit one, or a family to choose from.
      const wanted = req.query.level && req.query.level !== "auto" ? req.query.level : null;
      if (wanted && !m.levels.some((l) => l.level === wanted)) {
        return res.status(400).json({ error: `${m.code} has no ${wanted} values` });
      }
      const family = req.query.family === "admin" || req.query.family === "grid"
        ? req.query.family : (raster ? "grid" : "admin");
      const candidates = m.levels.filter((l) => l.family === family);
      const pool_ = candidates.length ? candidates : m.levels;

      const counts = {};
      for (const l of pool_) counts[l.level] = await countInView(l.level, bbox, raster);
      let level = wanted;
      let reason;
      if (!level) {
        ({ level, reason } = chooseLevel(pool_, counts));
      } else {
        reason = "chosen";
        if (counts[level] === undefined) counts[level] = await countInView(level, bbox, raster);
      }
      const lv = m.levels.find((l) => l.level === level);
      const year = Number(req.query.year) || lv.max_year;

      const over = counts[level] > budgetFor(level);
      const finer = pool_.filter((l) => LEVELS[l.level].order < LEVELS[level].order);
      const meta = {
        code: m.code, label: m.label, units: m.units, dataset: m.dataset,
        source_url: m.source_url, level, level_label: LEVELS[level].label, year, per,
        is_count: m.is_count, reason,
        levels: m.levels.map((l) => ({ level: l.level, label: l.label, family: l.family,
          in_view: counts[l.level] ?? null, budget: budgetFor(l.level),
          years: [l.min_year, l.max_year], derived: Boolean(l.derived) })),
        finer_available: finer.map((l) => ({ level: l.level, label: l.label, in_view: counts[l.level] })),
      };

      if (over) {
        // Refuse to draw rather than draw a truncated, misleading subset.
        return res.json({ ...meta, too_many: true, in_view: counts[level],
          features: { type: "FeatureCollection", features: [] },
          bins: await binsFor(m, level, year, per, raster), ms: Date.now() - t0 });
      }

      const [w, s, e, n] = bbox;
      const prec = precisionFor(z);
      let rows;
      if (level === "pixel") {
        ({ rows } = await pool.query(`
          SELECT round((ST_XMin((pp).geom) - $5) / $7)::int AS col,
                 round((ST_YMax((pp).geom) - $6) / $8)::int AS row,
                 (pp).val AS value, ${pixelKm2Sql("(pp).geom", raster)} * 1e6 AS area_m2,
                 ST_AsGeoJSON((pp).geom, ${prec}) AS g
            FROM (SELECT ST_PixelAsPolygons(ST_Clip(rast, ST_MakeEnvelope($1,$2,$3,$4,4326)), 1, true) AS pp
                    FROM ${raster.table_name}
                   WHERE ST_Intersects(rast, ST_MakeEnvelope($1,$2,$3,$4,4326))) s
           WHERE (pp).val IS NOT NULL
           LIMIT ${BUDGET_CELL + 1}`,
          [w, s, e, n, raster.origin_x, raster.origin_y, raster.pixel_x, raster.pixel_y]));
        rows = rows.map((r) => ({ geoid: `${raster.id}:px:${r.row}:${r.col}`,
          name: `1 km pixel ${r.row}, ${r.col}`, value: r.value, aland: r.area_m2, g: r.g }));
      } else if (lv.derived) {
        ({ rows } = await pool.query(`
          SELECT u.geoid, u.name, NULL::float8 AS value, u.aland, ST_AsGeoJSON(${geomFor(z)}, ${prec}) AS g
            FROM geo_unit u
           WHERE u.level = $1 AND u.geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)
           LIMIT ${budgetFor(level) + 1}`, [level, w, s, e, n]));
      } else {
        const v = valuesSql(m.code, level, year, raster);
        const k = v.params.length;
        const grid = LEVELS[level].family === "grid";
        ({ rows } = await pool.query(`
          SELECT u.geoid, u.name, v.value, u.aland, ST_AsGeoJSON(${geomFor(z)}, ${prec}) AS g
            FROM geo_unit u
            ${grid ? "JOIN" : "LEFT JOIN"} (${v.sql}) v ON v.geoid = u.geoid
           WHERE u.level = $${k + 1}
             AND u.geom && ST_MakeEnvelope($${k + 2}, $${k + 3}, $${k + 4}, $${k + 5}, 4326)
             ${grid ? `AND u.geoid LIKE $${k + 6}` : ""}
           LIMIT ${budgetFor(level) + 1}`,
          grid ? [...v.params, level, w, s, e, n, `${raster.id}:%`]
               : [...v.params, level, w, s, e, n]));
      }

      const how = lv.derived || lv.fill || null;
      const est = how ? await derivedValues(m.code, level, how, year) : null;
      let estimated = 0;
      const features = rows.map((r) => {
        let value = r.value === null ? null : Number(r.value);
        let derived = null;
        if (value === null && est && est.has(r.geoid)) {
          const d = est.get(r.geoid);
          value = d.value;
          derived = { from: how.from, from_label: LEVELS[how.from].label, method: how.method,
                      weight: how.weight, parts: d.parts, coverage: d.coverage };
          estimated += 1;
        }
        const km2 = r.aland ? Number(r.aland) / 1e6 : null;
        const shown = value === null ? null
          : per === "km2" ? (km2 ? value / km2 : null) : value;
        return { type: "Feature", geometry: JSON.parse(r.g),
          properties: { id: r.geoid, name: r.name, value, shown, km2, derived } };
      });
      meta.estimated = how ? {
        count: estimated, whole_level: Boolean(lv.derived), from: how.from,
        from_label: LEVELS[how.from].label, method: how.method, weight: how.weight,
      } : null;
      res.json({ ...meta, too_many: false, in_view: features.length,
        features: { type: "FeatureCollection", features },
        bins: await binsFor(m, level, year, per, raster), ms: Date.now() - t0 });
    } catch (err) {
      console.error("geo layer:", err.message);
      res.status(500).json({ error: "layer failed", details: err.message });
    }
  });
}

module.exports = {
  register, parseBbox, LEVELS, geomFor, derivationsFor, chooseLevel, budgetFor,
  BUDGET_POLY, BUDGET_CELL,
};
