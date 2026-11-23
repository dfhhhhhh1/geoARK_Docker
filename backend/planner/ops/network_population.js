const { CompileError, PLACE_KINDS } = require("./_sql");
const N = require("./_network");
const { toFipsPrefixes } = require("../../states");

/**
 * People within (or beyond) a network cost of the nearest feature of input 1
 * (docs/GIS_OPS_PLAN.md H5): "how many people in Chicago live more than a
 * 10-minute walk from a SNAP retailer", "what share of each St. Louis ward's
 * population lives within a 5-minute drive of a hospital".
 *
 * INTERNAL: never offered. planner/network.js applyNetworkPopulation builds it
 * from the model's plan (its reference layer and its area), the way
 * catchment.js moves a distance plan to tracts.
 *
 * People are WorldPop pixels, counted by pixel CENTRE: a pixel is in the area
 * (a named place, or each unit of a zone set) when its centre is, and it is
 * reached when the road vertex nearest its centre is. The only population
 * that exists at arbitrary shapes; 1 km pixels, so a zone's edge is a pixel
 * wide. stat "people" sums them, "share" is that sum over every pixel of the
 * same unit, as a percentage.
 */

// Population measures with a pixel raster: a closed list, so a plan sent back
// from the browser cannot name a table.
const POP_RASTERS = { WORLDPOP_POP: "raster_worldpop" };

module.exports = {
  name: "network_population",
  takesStates: true,
  inputs: 1,
  needs: [],
  accepts: [["features"]],
  produces: "series",
  resultType: (step) => (step.group_by === "none" ? "scalar" : "series"),
  kind: "sql",
  internal: true,
  // The population measure is cited like a load: resolved, and in provenance.
  grounds: [{ field: "attr_id", sourceKind: "value" }],

  offered: () => false,

  validate(step) {
    const errs = [];
    try { N.check(step.network); } catch (e) { errs.push(`step "${step.id}" (network_population): ${e.message}`); }
    if (step.network && step.network.limit === undefined) {
      errs.push(`step "${step.id}" (network_population): needs a network limit`);
    }
    if (!POP_RASTERS[step.attr_id]) errs.push(`step "${step.id}" (network_population): no pixel raster for ${step.attr_id}`);
    if (!step.zones && !step.place_name) errs.push(`step "${step.id}" (network_population): needs zones or a place`);
    if (!["people", "share"].includes(step.stat)) errs.push(`step "${step.id}" (network_population): stat people|share`);
    return errs;
  },

  compile(step, ctx) {
    const [ref] = ctx.ins;
    const net = step.network;
    N.check(net);
    const table = POP_RASTERS[step.attr_id];
    if (!table) throw new CompileError(`no pixel raster for ${step.attr_id}`);
    let area;
    if (step.zones) {
      area = `SELECT geoid AS fips, geom FROM geo_unit WHERE level = ${ctx.bind(String(step.zones))}`;
    } else {
      const kind = String(step.place_kind || "place");
      if (!PLACE_KINDS.includes(kind)) throw new CompileError(`unsupported place_kind ${kind}`);
      const name = ctx.bind(String(step.place_name));
      const conds = [`p.kind = ${ctx.bind(kind)}`,
        `(lower(p.name) = lower(${name}) OR lower(p.name) LIKE lower(${name}) || '-%' ` +
        `OR lower(p.name) LIKE lower(${name}) || ', %')`];
      if (Array.isArray(step.states) && step.states.length) {
        const { codes, unknown } = toFipsPrefixes(step.states);
        if (unknown.length) throw new CompileError(`unknown state or region: ${unknown.join(", ")}`);
        conds.push(`p.state_fp IN (${codes.map(c => ctx.bind(c)).join(", ")})`);
      }
      area = `SELECT NULL::text AS fips, ST_Union(p.geom) AS geom FROM place_geom p WHERE ${conds.join(" AND ")}`;
    }
    const lim = `${ctx.bind(N.limitInCost(net))}::float8`;
    const n = N.reachCtes(net, ctx, {
      pointsSql: `SELECT geom FROM net_px`,
      sourcesSql: `SELECT geom FROM ${ref}`,
    });
    const inside = step.exclude === true
      ? `(r.agg_cost IS NULL OR r.agg_cost > ${lim})` : `r.agg_cost <= ${lim}`;
    const value = step.stat === "share"
      ? `100.0 * COALESCE(SUM(x.pop) FILTER (WHERE ${inside}), 0) / NULLIF(SUM(x.pop), 0)`
      : `COALESCE(SUM(x.pop) FILTER (WHERE ${inside}), 0)`;
    const group = step.group_by === "none";
    return `${ctx.name} AS (WITH net_area AS (${area}), ` +
      `net_px AS (SELECT a.fips, c.geom, c.val AS pop FROM net_area a ` +
      `JOIN ${table} t ON ST_Intersects(t.rast, a.geom) ` +
      `CROSS JOIN LATERAL ST_PixelAsCentroids(t.rast) c ` +
      `WHERE c.val > 0 AND c.geom && a.geom AND ST_Intersects(a.geom, c.geom)), ` +
      `${n.head.join(", ")}, ` +
      `net_x AS (SELECT px.fips, px.pop, ${N.snap(net, "net_r.region", "px.geom")} AS node ` +
      `FROM net_px px, net_r, net_box WHERE px.geom && net_box.bbox), ` +
      `${n.cost("SELECT node FROM net_x")} ` +
      `SELECT ${group ? "NULL::char(5)" : "x.fips"} AS fips, (${value})::double precision AS value ` +
      `FROM net_x x LEFT JOIN net_cost r ON r.node = x.node` +
      `${group ? "" : " GROUP BY x.fips"})`;
  },

  valueLabel: "people",
};
