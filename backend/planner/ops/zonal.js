const { CompileError, SAFE_DB_IDENT, OPERATORS } = require("./_sql");

/**
 * Zonal statistics of a raster over the plan's units (docs/GIS_OPS_PLAN.md H4):
 * one value per county, tract, ZIP or zone set unit. Series out, so it ranks,
 * filters, maps and combines like any measure; two zonal steps on two years
 * into `combine` is a change over time.
 *
 * GENERAL ON PURPOSE. Nothing here names a class or a dataset. Which pixels
 * count is either a categorical raster's own classes (its legend labels and
 * the publisher's groups, cited through attribute_filters exactly as a
 * feature layer's `type` values are) or a threshold on a continuous raster
 * (operator / value: "slope under 5 percent"). What is reported, and in what
 * unit, is set in code from the question (features.applyRasterMeasures):
 *
 *   share   percent of the unit's valid pixels that qualify
 *   area    area of qualifying pixels, in the unit asked (default sq mi)
 *   mean    mean of a continuous raster (or `sum`, per its aggregate)
 *
 * HOW. The unit polygon is transformed to the raster's own CRS (an
 * equal-area projection: every pixel is pixel_area_m2), the tiles whose
 * hull meets it are clipped to it (ST_Clip: a pixel is in when its CENTRE
 * is, the right rule at 10-30 m pixels against units of hectares or more),
 * and the clipped values are counted. Units outside the raster's extent get
 * no row, not a 0: there is no data there, which is not the same as none.
 */
module.exports = {
  name: "zonal",
  inputs: 0,
  needs: ["attr_id"],
  produces: "series",
  kind: "sql",

  grounds: [{ field: "attr_id", sourceKind: "raster",
              message: "is not a raster. Use load for a per-county value, count_features for mapped locations." }],
  acceptsAttributeFilters: true,

  enumComment: "a raster summarised over each county / unit (land cover share or area, mean elevation, slope)",
  promptLine: `  zonal        needs attr_id (a raster), optional attribute_filters (its classes),
                 operator + value (a threshold on its pixels), year
                 -> one value per county, or per unit the question names: the
                 share or area of the classes chosen (or of pixels passing the
                 threshold), or the raster's average. Restrict the place with
                 filter_area / filter_place after it. For a change over time,
                 two zonal steps with different years, then combine.`,
  choiceLine: `  "share / acres of cropland, forest, developed land",
  "average elevation / slope of each X", "land with slope under N" -> zonal`,

  offered: (ctx) => ctx.hasRaster === true,

  examples: [
    { text:
`QUESTION: what percent of each Kansas county was grassland in 2016
  (a2 = a land cover raster, classes include "Grassland/Herbaceous")
PLAN: {"intent":"Share of each Kansas county in grassland, 2016",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"zonal","attr_id":"a2","inputs":[],"year":2016,
           "attribute_filters":[{"column":"type","value":"Grassland/Herbaceous"}]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Kansas"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}`, usesFilters: true },
    { text:
`QUESTION: how much land in each Utah county has a slope steeper than 30 percent
  (a5 = a terrain slope raster in percent)
PLAN: {"intent":"Area of each Utah county with slope over 30 percent",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"zonal","attr_id":"a5","inputs":[],"operator":">","value":30},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Utah"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },
  ],

  validate(step) {
    const errs = [];
    if ((step.operator === undefined) !== (step.value === undefined)) {
      errs.push(`step "${step.id}" (zonal): a pixel threshold needs both "operator" and "value"`);
    }
    if (step.operator !== undefined && !OPERATORS[step.operator]) {
      errs.push(`step "${step.id}" (zonal): unknown operator ${JSON.stringify(step.operator)}`);
    }
    if (step.attribute_filters?.length && step.operator !== undefined) {
      errs.push(`step "${step.id}" (zonal): use classes OR a threshold, not both`);
    }
    return errs;
  },

  compile(step, ctx) {
    const src = ctx.resolved.get(step.attr_id);
    if (!src || src.source_kind !== "raster") throw new CompileError(`${step.attr_id} is not a raster`);
    const layers = src.layers || [];
    if (!layers.length) throw new CompileError(`${step.attr_id} has no raster loaded`);
    const want = step.year !== undefined && step.year !== null ? Number(step.year) : null;
    const layer = want === null ? layers[layers.length - 1] : layers.find(l => l.year === want);
    if (!layer) {
      throw new CompileError(
        `${step.attr_id} has no ${want} raster; years loaded: ${layers.map(l => l.year).join(", ")}`);
    }
    if (!SAFE_DB_IDENT.test(layer.table_name || "") || !Number.isInteger(Number(layer.srid))) {
      throw new CompileError(`unsafe raster registry entry for ${step.attr_id}`);
    }
    const srid = Number(layer.srid);

    // Which pixels qualify.
    let pred = null;
    if (step.attribute_filters?.length) {
      const codes = new Set();
      for (const f of step.attribute_filters) {
        const v = String(f.value || "").toLowerCase();
        const hit = (src.classes || []).filter(c =>
          String(c.label).toLowerCase() === v || String(c.grp || "").toLowerCase() === v);
        if (!hit.length) throw new CompileError(`"${f.value}" is not a class of ${step.attr_id}`);
        for (const c of hit) codes.add(Number(c.value));
      }
      const neg = step.attribute_filters.every(f => f.negate === true);
      pred = `${neg ? "NOT " : ""}(v = ANY(${ctx.bind([...codes])}::float8[]))`;
    } else if (step.operator !== undefined) {
      pred = `v ${OPERATORS[step.operator]} ${ctx.bind(Number(step.value))}::float8`;
    }

    const stat = step.stat || (pred ? "area" : (src.aggregate === "sum" ? "sum" : "mean"));
    if (!["share", "area", "mean", "sum"].includes(stat)) throw new CompileError(`zonal: unknown stat ${stat}`);
    if ((stat === "share" || stat === "area") && !pred && src.raster_kind === "categorical") {
      throw new CompileError(`zonal: say which classes of ${step.attr_id} (attribute_filters)`);
    }
    const k = pred ? `count(v) FILTER (WHERE ${pred})` : `count(v)`;
    // Bound only when used: a parameter the SQL does not reference is a
    // runtime error on a plan that validated (the combine defect, CLAUDE.md).
    // A function, not a value: bound only on the path that uses it. Built
    // eagerly, the cache path below left the live path's pixel factor bound
    // and unreferenced: "could not determine data type of parameter $2" on
    // the Missouri cropland change (H4 dev f1).
    const liveValue = () =>
      stat === "share" ? `100.0 * ${k} / NULLIF(count(v), 0)`
      : stat === "area" ? `${k} * ${ctx.bind((src.pixel_area_m2 || 0) / (step.unit_per_m2 || 2589988.110336))}::float8`
      : stat === "mean" ? `avg(v)` : `sum(v)`;

    const level = ctx.level && ctx.level !== "county" ? ctx.level : null;
    // Counties of a categorical raster: its class histograms, cached at load
    // with this same clip (etl/load_raster.py cache_county_counts), so the
    // number is identical and a two-year change over a state fits the budget.
    if (!level && src.raster_kind === "categorical" && (layer.cached_levels || []).includes("county") &&
        (stat === "share" || stat === "area") && SAFE_DB_IDENT.test(layer.id || "")) {
      const cpred = pred.replace(/\bv\b/g, "c.value");
      const kc = `sum(c.pixels) FILTER (WHERE ${cpred})`;
      const cval = stat === "share"
        ? `100.0 * COALESCE(${kc}, 0) / NULLIF(sum(c.pixels), 0)`
        : `COALESCE(${kc}, 0) * ${ctx.bind((src.pixel_area_m2 || 0) / (step.unit_per_m2 || 2589988.110336))}::float8`;
      return `${ctx.name} AS (SELECT c.geoid::char(5) AS fips, ${cval} AS value FROM raster_unit_count c ` +
             `WHERE c.raster_id = ${ctx.bind(layer.id)} AND c.level = 'county' GROUP BY c.geoid)`;
    }
    const units = level
      ? `(SELECT geoid AS fips, geom FROM geo_unit WHERE level = ${ctx.bind(level)})`
      : `county_geom`;
    // The raster's extent, in 4326, so units it does not cover are skipped
    // before any clipping (and get no row rather than a false 0).
    const [x0, y0, x1, y1] = layer.extent.map(Number);
    const value = liveValue();
    const ext = `ST_Transform(ST_MakeEnvelope(${ctx.bind(x0)}, ${ctx.bind(y0)}, ${ctx.bind(x1)}, ${ctx.bind(y1)}, ${srid}), 4326)`;
    return `${ctx.name} AS (SELECT u.fips, z.value FROM ${units} u ` +
           `CROSS JOIN LATERAL (SELECT ST_Transform(u.geom, ${srid}) AS g) gg ` +
           `CROSS JOIN LATERAL (SELECT ${value} AS value, count(v) AS n FROM ${layer.table_name} r ` +
           `CROSS JOIN LATERAL unnest(ST_DumpValues(ST_Clip(r.rast, 1, gg.g, true), 1)) AS v ` +
           `WHERE ST_ConvexHull(r.rast) && gg.g AND ST_Intersects(r.rast, gg.g)) z ` +
           `WHERE u.geom && ${ext} AND z.n > 0)`;
  },

  valueLabel: "raster summarised over each unit (share in percent, area, or mean)",
};
