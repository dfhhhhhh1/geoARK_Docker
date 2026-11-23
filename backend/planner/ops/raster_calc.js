const { CompileError, SAFE_DB_IDENT, OPERATORS, PLACE_KINDS } = require("./_sql");
const { toFipsPrefixes } = require("../../states");

/**
 * Raster calculator (docs/GIS_OPS_PLAN.md H4 remainder): WHERE a condition on
 * one or two rasters holds inside an area, mapped as polygons with its exact
 * area. "Map where forest became developed land in St. Louis County between
 * 2001 and 2021", "show the land in St. Louis with a slope over 15 percent",
 * "areas of St. Louis County above 180 m elevation with slope under 5 percent".
 *
 * INTERNAL: never offered. planner/raster_calc.js builds it from the zonal
 * steps the model already plans for such questions (their raster, year,
 * classes or threshold, all set or checked by code: fillRasterClasses,
 * applyRasterMeasures) and the plan's place, when the question asks WHERE
 * rather than how much per unit. So the conditions come from the same path
 * that answers "what share of each county ..." and is measured there.
 *
 * HOW. Each tile of the first raster (joined tile for tile to the second,
 * which must share its grid: NLCD 2001 / 2021, 3DEP DEM / slope) becomes a
 * 0/1 mask by ST_MapAlgebra, nodata wherever either input is nodata; the mask
 * is clipped to the area (ST_Clip: a pixel is in when its centre is, as
 * zonal). Then:
 *   area   qualifying pixels x pixel area (the rasters are equal-area), exact
 *          at full resolution;
 *   share  of the area's valid pixels;
 *   map    the mask resampled to a display cell (`Max`: a display cell is
 *          drawn when ANY pixel in it qualifies, so small patches stay
 *          visible) and polygonized. The drawing is a picture of the answer;
 *          the numbers come from the full-resolution count.
 *
 * Bounded: an area over MAX_PIXELS valid pixels is refused (a state of 30 m
 * NLCD is ~200M pixels); per-county shares answer that question instead.
 */

const MAX_PIXELS = Number(process.env.RASTER_CALC_MAX_PIXELS ?? 40e6);
const SQMI = 2589988.110336;

/** The loaded raster of a resolved attribute for a year (latest when none). */
function layerOf(src, year, id) {
  if (!src || src.source_kind !== "raster") throw new CompileError(`${id} is not a raster`);
  const layers = src.layers || [];
  const want = year !== undefined && year !== null ? Number(year) : null;
  const layer = want === null ? layers[layers.length - 1] : layers.find(l => l.year === want);
  if (!layer) throw new CompileError(`${id} has no ${want ?? ""} raster; years loaded: ${layers.map(l => l.year).join(", ")}`);
  if (!SAFE_DB_IDENT.test(layer.table_name || "") || !Number.isInteger(Number(layer.srid))) {
    throw new CompileError(`unsafe raster registry entry for ${id}`);
  }
  return layer;
}

/** A term's condition on a map-algebra pixel reference, numbers inlined (checked finite). */
function condOf(term, ref, src) {
  if (Array.isArray(term.classes) && term.classes.length) {
    const codes = term.classes.map(Number);
    if (!codes.every(Number.isInteger)) throw new CompileError("raster_calc: class codes must be integers");
    const known = new Set((src.classes || []).map(c => Number(c.value)));
    if (known.size && !codes.every(c => known.has(c))) throw new CompileError("raster_calc: unknown class code");
    return `${ref} IN (${codes.join(",")})`;
  }
  if (term.operator !== undefined) {
    const op = OPERATORS[term.operator];
    const v = Number(term.value);
    if (!op || !Number.isFinite(v)) throw new CompileError("raster_calc: a threshold needs an operator and a number");
    return `${ref} ${op} ${v}`;
  }
  throw new CompileError("raster_calc: each condition needs classes or a threshold");
}

/** The area as SQL yielding one geometry in 4326 (and its name). */
function areaSql(step, ctx) {
  const a = step.area || {};
  const statesCond = (col) => {
    if (!Array.isArray(a.states) || !a.states.length) return "";
    const { codes, unknown } = toFipsPrefixes(a.states);
    if (unknown.length) throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
    return ` AND ${col} IN (${codes.map(c => ctx.bind(c)).join(", ")})`;
  };
  if (a.kind === "county") {
    // county_geom names an independent city like its county: 29189 St. Louis
    // County and 29510 St. Louis city are both "St. Louis" (also Baltimore,
    // Richmond VA, Fairfax ...). Their county codes are 500+. So "X city"
    // is the city, and a bare name is the county when one exists (the union
    // of both read 589.6 sq mi for St. Louis County's 523, 2026-11-23).
    const raw = String(a.name || "").trim();
    const city = /\s+city$/i.test(raw);
    const n = ctx.bind(city ? raw.replace(/\s+city$/i, "") : raw);
    const st = statesCond("k.state_fp");
    const pick = city
      ? `substring(k.fips, 3, 3) >= '500'`
      : `(substring(k.fips, 3, 3) < '500' OR NOT EXISTS (SELECT 1 FROM county_geom k2 WHERE lower(k2.name) = lower(${n}) ` +
        `AND k2.state_fp = k.state_fp AND substring(k2.fips, 3, 3) < '500'))`;
    return `SELECT ST_Union(k.geom) AS g FROM county_geom k WHERE lower(k.name) = lower(${n}) AND ${pick}${st}`;
  }
  if (a.kind === "zones") {
    if (!/^z_[a-z0-9_]+$/.test(String(a.level || ""))) throw new CompileError("raster_calc: bad zone level");
    return `SELECT ST_Union(geom) AS g FROM geo_unit WHERE level = ${ctx.bind(a.level)}`;
  }
  const kind = String(a.place_kind || "place");
  if (!PLACE_KINDS.includes(kind)) throw new CompileError(`raster_calc: unsupported place_kind ${kind}`);
  const name = ctx.bind(String(a.name || ""));
  return `SELECT ST_Union(p.geom) AS g FROM place_geom p WHERE p.kind = ${ctx.bind(kind)} AND ` +
    `(lower(p.name) = lower(${name}) OR lower(p.name) LIKE lower(${name}) || '-%' OR lower(p.name) LIKE lower(${name}) || ', %')` +
    statesCond("p.state_fp");
}

module.exports = {
  name: "raster_calc",
  inputs: 0,
  needs: ["attr_id"],
  produces: "features",
  kind: "sql",
  internal: true,
  grounds: [{ field: "attr_id", sourceKind: "raster" }, { field: "attr_id_b", sourceKind: "raster" }],

  offered: () => false,

  methodTerms: /\bmap\s+algebra\b|\braster\s+calculat\w*|\bwhere\b|\bareas?\b|\bland\b|\bparts?\b|\bplaces?\b|\bpixels?\b|\bbecame\b|\bturned\s+into\b|\bconverted\b|\bchanged?\b/gi,

  validate(step) {
    const errs = [];
    const terms = [{ classes: step.classes, operator: step.operator, value: step.value }];
    if (step.attr_id_b) terms.push({ classes: step.classes_b, operator: step.operator_b, value: step.value_b });
    terms.forEach((t, i) => {
      const hasC = Array.isArray(t.classes) && t.classes.length;
      const hasT = t.operator !== undefined;
      if (hasC === hasT) errs.push(`step "${step.id}" (raster_calc): condition ${i + 1} needs classes OR a threshold`);
      if (hasT && (!OPERATORS[t.operator] || !Number.isFinite(Number(t.value)))) {
        errs.push(`step "${step.id}" (raster_calc): condition ${i + 1} threshold is not valid`);
      }
    });
    const a = step.area || {};
    if (!["county", "place", "zones"].includes(a.kind)) errs.push(`step "${step.id}" (raster_calc): area kind county|place|zones`);
    if (a.kind !== "zones" && !a.name) errs.push(`step "${step.id}" (raster_calc): the area needs a name`);
    return errs;
  },

  compile(step, ctx) {
    const srcA = ctx.resolved.get(step.attr_id);
    const A = layerOf(srcA, step.year, step.attr_id);
    const two = !!step.attr_id_b;
    const srcB = two ? ctx.resolved.get(step.attr_id_b) : null;
    const B = two ? layerOf(srcB, step.year_b, step.attr_id_b) : null;
    if (two) {
      const same = ["srid", "origin_x", "origin_y", "pixel_x", "pixel_y", "tile_size", "width", "height"]
        .every(k => Number(A[k]) === Number(B[k]));
      if (!same) throw new CompileError(`raster_calc: ${step.attr_id} and ${step.attr_id_b} are not on one grid`);
    }
    const srid = Number(A.srid);
    const pixelM2 = Math.abs(Number(A.pixel_x) * Number(A.pixel_y));
    if (!(pixelM2 > 0) || !(srcA.pixel_area_m2 > 0)) {
      throw new CompileError(`raster_calc needs an equal-area raster; ${step.attr_id} is not one`);
    }
    const native = Math.abs(Number(A.pixel_x));
    // Display cell: a county of 10 m pixels drawn at 50 m was 1.3 MB of
    // GeoJSON; at 90 m it is a few hundred kB and still shows small patches
    // (Max resampling).
    const cell = Math.max(native * 3, 90);
    const cA = condOf({ classes: step.classes, operator: step.operator, value: step.value }, two ? "[rast1.val]" : "[rast]", srcA);
    const expr = two
      ? `CASE WHEN ${cA} AND ${condOf({ classes: step.classes_b, operator: step.operator_b, value: step.value_b }, "[rast2.val]", srcB)} THEN 1 ELSE 0 END`
      : `CASE WHEN ${cA} THEN 1 ELSE 0 END`;
    const E = ctx.bind(expr);
    const mask = two
      ? `ST_MapAlgebra(r1.rast, 1, r2.rast, 1, ${E}::text, '8BUI'::text, 'INTERSECTION'::text, NULL::text, NULL::text, 255::double precision)`
      : `ST_MapAlgebra(r1.rast, 1, '8BUI'::text, ${E}::text, 255::double precision)`;
    // 255 is the mask's nodata, set explicitly: without it ST_Clip filled the
    // outside with 0 and ST_Count counted it, and a 0 could read as nodata
    // (a share of 100% where 9.3% was right, 2026-11-23). ST_SetBandNoDataValue
    // makes it stick on the single-raster form too.
    const join = two
      ? ` JOIN ${B.table_name} r2 ON ST_UpperLeftX(r2.rast) = ST_UpperLeftX(r1.rast) AND ST_UpperLeftY(r2.rast) = ST_UpperLeftY(r1.rast)`
      : "";
    const maxPx = ctx.bind(MAX_PIXELS);
    return `${ctx.name} AS (WITH rc_a AS MATERIALIZED (SELECT ST_Transform(x.g, ${srid}) AS g, x.g AS g4326 FROM (${areaSql(step, ctx)}) x WHERE x.g IS NOT NULL), ` +
      // Refuse before reading a single tile when the area is too large.
      `rc_guard AS (SELECT CASE WHEN ST_Area(g) / ${ctx.bind(pixelM2)}::float8 > ${maxPx}::float8 ` +
        `THEN raster_calc_too_large(ST_Area(g) / ${ctx.bind(SQMI)}::float8) ELSE 1 END AS ok FROM rc_a), ` +
      `rc_t AS MATERIALIZED (SELECT ST_Clip(ST_SetBandNoDataValue(${mask}, 1, 255), 1, rc_a.g, 255, true) AS m FROM ${A.table_name} r1${join}, rc_a, rc_guard ` +
        `WHERE rc_guard.ok = 1 AND ST_ConvexHull(r1.rast) && rc_a.g AND ST_Intersects(r1.rast, rc_a.g)), ` +
      `rc_s AS (SELECT coalesce(sum(ST_ValueCount(m, 1, true, 1)), 0) AS q, coalesce(sum(ST_Count(m, 1, true)), 0) AS n FROM rc_t), ` +
      `rc_p AS (SELECT ST_Collect(ST_SimplifyPreserveTopology(d.geom, ${ctx.bind(cell * 0.4)}::float8)) AS geom ` +
        `FROM (SELECT (ST_DumpAsPolygons(ST_Rescale(m, ${ctx.bind(cell)}::float8, -${ctx.bind(cell)}::float8, 'Max'))).* FROM rc_t) d ` +
        `WHERE d.val = 1) ` +
      `SELECT ST_Transform(coalesce(p.geom, ST_GeomFromText('MULTIPOLYGON EMPTY', ${srid})), 4326) AS geom, ` +
        `s.q * ${ctx.bind(pixelM2)}::float8 / ${ctx.bind(SQMI)}::float8 AS value, ` +
        `100.0 * s.q / NULLIF(s.n, 0) AS share, s.q AS pixels, s.n * ${ctx.bind(pixelM2)}::float8 / ${ctx.bind(SQMI)}::float8 AS area_total ` +
      `FROM rc_s s CROSS JOIN rc_p p)`;
  },

  featureOutput(step) {
    return {
      select: (r) => [
        `${ctxLabel(step)} AS condition`,
        `round(${r}.value::numeric, 3)::float8 AS area_sq_mi`,
        `round(${r}.share::numeric, 2)::float8 AS percent_of_area`,
        `round(${r}.area_total::numeric, 2)::float8 AS area_checked_sq_mi`,
      ],
      labels: ["condition", "area_sq_mi", "percent_of_area", "area_checked_sq_mi"],
      order: "value DESC",
      valueLabel: "square miles meeting the condition (full-resolution pixel count)",
      style: { kind: "mask" },
    };
  },

  MAX_PIXELS,
};

/** The condition as a quoted SQL literal for the output (letters, digits and punctuation only). */
function ctxLabel(step) {
  const s = String(step.label || "meets the condition").replace(/[^A-Za-z0-9 ,.%()<>=+\-/']/g, "").slice(0, 160);
  return `'${s.replace(/'/g, "''")}'::text`;
}
