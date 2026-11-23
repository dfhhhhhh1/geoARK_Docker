const { CompileError, expandBox } = require("./_sql");
const N = require("./_network");

/**
 * Service areas (isochrones) as polygons, one per travel band
 * (docs/GIS_OPS_PLAN.md H5): "map 5, 10 and 15-minute drive times around the
 * fire stations in St. Louis", "the area within a 10-minute walk of a library".
 *
 * INTERNAL: never offered. planner/service_area.js builds it from the model's
 * plan (the reference layer and its restrictions) and the question's words
 * (mode, cost, bands), the way network.js builds network_population.
 *
 * WHAT A BAND IS, exactly: the land within one grid cell of a point on the
 * road network that the nearest source reaches within the band's limit.
 *   1. One Dijkstra from every source at once (_network.reachCtes: a virtual
 *      vertex 0 with zero-cost edges to each source vertex), to every vertex
 *      of the mode's largest component inside a box that a band could reach.
 *      pgr_dijkstraCost from 0 to ~370k vertices: 2.7 s on St. Louis;
 *      pgr_drivingDistance with equicost over the same graph: 179 s
 *      (measured 2026-11-23).
 *   2. Points along each edge between its junctions, every cell length, with
 *      the cost of the cheaper end plus the share of the edge travelled (one
 *      way where the road is one way). Without them a highway between two
 *      interchanges 3 km apart reads as unreached.
 *   3. Each grid cell (EPSG:5070, equal area, cell size from the reach) takes
 *      the minimum cost of its points, then each cell's 8 neighbours take it
 *      too (a one-cell dilation, which is the "within one cell of a road").
 *   4. The cells are written into a raster of band numbers and polygonized
 *      (ST_DumpAsPolygons), so a band is exactly its cells: no union of tens
 *      of thousands of squares (3.2 s) and no smoothing buffer (12 s).
 * Rings are disjoint by construction (a cell is in the band of its cost).
 * Area is counted from cells, not measured from the drawn geometry, which is
 * simplified for display. People, when WorldPop is loaded, are its 1 km
 * pixels whose centre falls in a band's cell.
 *
 * Free flow and the region rules of _network.js apply: sources outside the
 * loaded region holding most of them are left out, none -> refused.
 */

const MAX_BANDS = 6;
const POP_RASTERS = { WORLDPOP_POP: "raster_worldpop" };

const unitOf = (net) => (net.cost === "time" ? "minutes" : "miles");

/** A band limit (minutes or miles) in the graph's cost units. */
function bandCost(net, v) {
  const n = Number(v);
  if (net.cost === "length") return n * 1609.344;
  return net.mode === "walk" ? n * 60 * Number(net.walk_mps) : n * 60;
}

/** Metres a band could reach at most (the box), and typically (the cell size). */
function reachMeters(net, v) {
  const c = bandCost(net, v);
  if (net.cost === "time" && net.mode === "drive") return { max: c * 36, typical: c * 13.4 };
  return { max: c, typical: c };
}

function cellMeters(net, top) {
  const t = reachMeters(net, top).typical / 80;
  return Math.max(30, Math.min(250, Math.round(t / 10) * 10));
}

function bandLabel(net, lo, hi) {
  const fmt = (x) => String(+Number(x).toFixed(2));
  const what = net.cost === "time"
    ? `${net.mode === "walk" ? "walk" : "drive"}` : `${net.mode === "walk" ? "walking" : "road"} miles`;
  return net.cost === "time"
    ? `${fmt(lo)}-${fmt(hi)} minute ${what}`
    : `${fmt(lo)}-${fmt(hi)} ${what}`;
}

module.exports = {
  name: "service_area",
  inputs: 1,
  needs: [],
  accepts: [["features"]],
  produces: "features",
  kind: "sql",
  internal: true,

  offered: () => false,

  // What the named-data check must not read as data (planner/named_data.js).
  methodTerms: /\bservice\s+areas?\b|\bisochrones?\b|\bisolines?\b|\b(?:walk|travel|drive|commute)[- ]?sheds?\b|\b(?:drive|driving|walk|walking|travel|response)[- ]?times?\b|\bbands?\b|\bzones?\b|\brings?\b|\bcoverage\b|\bcatchments?\b|\breach(?:ed|able)?\b|\bareas?\b|\bincrements?\b|\bintervals?\b|\bparts?\b|\bterritor(?:y|ies)\b/gi,

  validate(step) {
    const errs = [];
    try { N.check({ ...step.network, limit: undefined }); } catch (e) {
      errs.push(`step "${step.id}" (service_area): ${e.message}`);
    }
    const b = step.bands;
    if (!Array.isArray(b) || !b.length || b.length > MAX_BANDS ||
        !b.every((x, i) => Number(x) > 0 && (i === 0 || Number(x) > Number(b[i - 1])))) {
      errs.push(`step "${step.id}" (service_area): bands must be 1-${MAX_BANDS} increasing positive numbers`);
    }
    return errs;
  },

  compile(step, ctx) {
    const net = step.network;
    N.check({ ...net, limit: undefined });
    const bands = (step.bands || []).map(Number);
    if (!bands.length || bands.some(x => !(x > 0))) throw new CompileError("service_area needs bands");
    const [src] = ctx.ins;
    const top = bands[bands.length - 1];
    const cell = cellMeters(net, top);
    const C = ctx.bind(cell);
    const costs = `${ctx.bind(bands.map(b => bandCost(net, b)))}::float8[]`;
    const his = `${ctx.bind(bands)}::float8[]`;
    const maxCost = `${ctx.bind(bandCost(net, top))}::float8`;
    const boxM = ctx.bind(reachMeters(net, top).max);
    const cc = net.mode === "walk" ? "walk_cc" : "drive_cc";
    // The cost of an edge in graph units, and whether each direction can be
    // travelled (_network.edgesText: walk is both ways, at length).
    const ec = net.mode === "walk" || net.cost === "length" ? "e.length_m" : "e.drive_s";
    const fwd = net.mode === "walk" ? "e.walk" : "e.drive_fwd";
    const bwd = net.mode === "walk" ? "e.walk" : "e.drive_bwd";
    const usable = net.mode === "walk" ? "e.walk"
      : `(e.drive_fwd OR e.drive_bwd) AND ${ec} IS NOT NULL`;
    const n = N.reachCtes(net, ctx, {
      pointsSql: `SELECT geom FROM ${src}`,
      sourcesSql: `SELECT geom FROM ${src}`,
    });
    // People per band from the population raster, when code attached it
    // (planner/service_area.js checks it is loaded). A closed list, so a plan
    // sent back from the browser cannot name a table.
    const pop = POP_RASTERS[step.population] || null;
    const band = `width_bucket(d.cost, array_prepend(-1::float8, ${costs}))`;
    return `${ctx.name} AS (WITH ${n.head.join(", ")}, ` +
      `sa_box AS (SELECT ${expandBox("e.box", `${boxM}::float8`)} AS box ` +
        `FROM (SELECT ST_SetSRID(ST_Extent(geom), 4326)::geometry AS box FROM ${src}) e), ` +
      `sa_v AS MATERIALIZED (SELECT v.id AS node, v.geom FROM road_vertex v, net_r, sa_box ` +
        `WHERE v.region = net_r.region AND v.${cc} AND v.geom && sa_box.box), ` +
      `${n.cost("SELECT node FROM sa_v")}, ` +
      `sa_c AS MATERIALIZED (SELECT node, agg_cost FROM net_cost), ` +
      // 2. junctions, and points along each edge one cell apart.
      `sa_pt AS (SELECT ST_Transform(v.geom, 5070) AS p, c.agg_cost AS cost ` +
        `FROM sa_v v JOIN sa_c c ON c.node = v.node WHERE c.agg_cost <= ${maxCost} ` +
      `UNION ALL SELECT ST_Transform(ST_LineInterpolatePoint(e.geom, i::float8 / k.n), 5070), ` +
        `least(CASE WHEN ${fwd} THEN cs.agg_cost + ${ec} * i / k.n END, ` +
              `CASE WHEN ${bwd} THEN ct.agg_cost + ${ec} * (k.n - i) / k.n END) ` +
        `FROM road_edge e CROSS JOIN net_r CROSS JOIN sa_box ` +
        `LEFT JOIN sa_c cs ON cs.node = e.source LEFT JOIN sa_c ct ON ct.node = e.target ` +
        `CROSS JOIN LATERAL (SELECT ceil(e.length_m / ${C})::int AS n) k ` +
        `CROSS JOIN LATERAL generate_series(1, k.n - 1) i ` +
        `WHERE e.region = net_r.region AND e.geom && sa_box.box AND ${usable} AND e.length_m > ${C} ` +
        `AND (cs.agg_cost < ${maxCost} OR ct.agg_cost < ${maxCost})), ` +
      // 3. cells, then the one-cell dilation.
      `sa_cell AS (SELECT floor(ST_X(p) / ${C})::int AS gx, floor(ST_Y(p) / ${C})::int AS gy, min(cost) AS cost ` +
        `FROM sa_pt WHERE cost <= ${maxCost} GROUP BY 1, 2), ` +
      `sa_d AS MATERIALIZED (SELECT c.gx + dx AS gx, c.gy + dy AS gy, min(c.cost) AS cost ` +
        `FROM sa_cell c, generate_series(-1, 1) dx, generate_series(-1, 1) dy GROUP BY 1, 2), ` +
      // 4. a raster of band numbers (1 = first band), polygonized.
      `sa_r AS (SELECT ST_SetValues(ST_AddBand(ST_MakeEmptyRaster(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, ` +
          `b.x0 * ${C}::float8, (b.y1 + 1) * ${C}::float8, ${C}::float8, -${C}::float8, 0, 0, 5070), ` +
          `'8BUI'::text, 0, 0), 1, ARRAY(SELECT ROW(ST_SetSRID(ST_MakePoint((d.gx + 0.5) * ${C}::float8, ` +
          `(d.gy + 0.5) * ${C}::float8), 5070), ${band})::geomval FROM sa_d d)) AS rast ` +
        `FROM (SELECT min(gx) x0, max(gx) x1, min(gy) y0, max(gy) y1 FROM sa_d) b WHERE b.x0 IS NOT NULL), ` +
      `sa_area AS (SELECT ${band} AS k, count(*) * (${C}::float8 * ${C}::float8) / 2589988.110336 AS sq_mi ` +
        `FROM sa_d d GROUP BY 1), ` +
      (pop
        ? `sa_pop AS (SELECT ST_Value(r.rast, 1, ST_Transform(px.geom, 5070)) AS k, sum(px.val) AS people ` +
            `FROM sa_r r, sa_box, ${pop} t CROSS JOIN LATERAL ST_PixelAsCentroids(t.rast) px ` +
            `WHERE ST_Intersects(t.rast, sa_box.box) AND px.val > 0 AND px.geom && sa_box.box ` +
            `AND ST_Transform(px.geom, 5070) && ST_Envelope(r.rast) GROUP BY 1), `
        : `sa_pop AS (SELECT NULL::int AS k, NULL::float8 AS people WHERE false), `) +
      `sa_poly AS (SELECT (g).val::int AS k, ST_Collect(ST_SimplifyPreserveTopology((g).geom, ${C}::float8 * 0.3)) AS geom ` +
        `FROM (SELECT ST_DumpAsPolygons(rast) AS g FROM sa_r) x WHERE (g).val > 0 GROUP BY 1) ` +
      `SELECT ST_Transform(p.geom, 4326) AS geom, (${his})[p.k] AS value, ` +
        `coalesce((${his})[p.k - 1], 0) AS band_from, (${his})[p.k] AS band_to, ` +
        `round(a.sq_mi::numeric, 2)::float8 AS area_sq_mi, ` +
        `round(sum(a.sq_mi) OVER (ORDER BY p.k)::numeric, 2)::float8 AS cumulative_sq_mi, ` +
        `round(sp.people::numeric)::float8 AS people ` +
      `FROM sa_poly p JOIN sa_area a ON a.k = p.k LEFT JOIN sa_pop sp ON sp.k = p.k)`;
  },

  /**
   * The output's columns (compile.js, features made by an op rather than
   * selected): each ring with its band, area and people. `name` is the band,
   * so the hover readout and the table lead with it.
   */
  featureOutput(step) {
    const net = step.network || {};
    const u = unitOf(net);
    return {
      select: (r) => [
        `${r}.band_from || '-' || ${r}.band_to AS band`,
        `${r}.band_to AS ${u}_to`, `${r}.area_sq_mi`, `${r}.cumulative_sq_mi`, `${r}.people`,
      ],
      labels: ["band", `${u}_to`, "area_sq_mi", "cumulative_sq_mi", "people"],
      order: "value ASC",
      valueLabel: `${net.cost === "time" ? (net.mode === "walk" ? "walking" : "driving") + " minutes" :
        (net.mode === "walk" ? "walking" : "road") + " miles"} from the nearest feature`,
      style: { kind: "bands", by: `${u}_to`, unit: u, stops: (step.bands || []).map(Number),
               labels: (step.bands || []).map((b, i) => bandLabel(net, i ? step.bands[i - 1] : 0, b)) },
    };
  },

  bandLabel, cellMeters, bandCost, MAX_BANDS,
};
