const { CompileError } = require("./_sql");
const N = require("./_network");

/**
 * Routes along the road network as lines (docs/GIS_OPS_PLAN.md H5):
 * "the fastest driving route from each fire station in St. Louis to the
 * nearest hospital", "directions from Barnes-Jewish Hospital to every fire
 * station in St. Louis".
 *
 * INTERNAL: never offered. planner/route.js builds it from the model's plan
 * (the two layers it selected) and the question's words (which side is the
 * origin, nearest vs every, mode and cost).
 *
 * Input 1 = origins, input 2 = destinations. Two shapes:
 *   to: "nearest"  each origin to its nearest destination. ONE Dijkstra over
 *                  the REVERSED graph from a virtual vertex 0 with zero-cost
 *                  arcs to every destination vertex: the path 0 -> d -> ... ->
 *                  o read backwards is o's cheapest route to any destination,
 *                  and its first real vertex says which one.
 *   to: "each"     one origin to every destination: one Dijkstra from it.
 * Each route is a line (its edges merged in order) with its minutes, road
 * miles, and the names at both ends; the cost the question asked for (time
 * or length) is the one minimised. The access legs from the points to their
 * vertices are not costed or drawn (_network.js snap). Free flow.
 */

const MAX_ROUTES = Number(process.env.ROUTE_MAX ?? 500);

module.exports = {
  name: "route",
  inputs: 2,
  needs: [],
  accepts: [["features"], ["features"]],
  produces: "features",
  kind: "sql",
  internal: true,

  offered: () => false,

  // What the named-data check must not read as data (planner/named_data.js).
  methodTerms: /\broutes?\b|\brouting\b|\bdirections\b|\bshortest\b|\bfastest\b|\bquickest\b|\bpaths?\b|\bway\b|\bdriv(?:e|es|ing)\b|\bwalk(?:s|ing)?\b|\btrips?\b|\bnavigat\w*/gi,

  validate(step) {
    const errs = [];
    try { N.check({ ...step.network, limit: undefined }); } catch (e) {
      errs.push(`step "${step.id}" (route): ${e.message}`);
    }
    if (!["nearest", "each"].includes(step.to)) errs.push(`step "${step.id}" (route): to must be nearest|each`);
    return errs;
  },

  compile(step, ctx) {
    const net = { ...step.network, limit: undefined };
    N.check(net);
    const [orig, dest] = ctx.ins;
    const n = N.reachCtes(net, ctx, {
      // The region holding most of the ORIGINS. Not of both: the
      // destinations are usually a national layer, and Chicago holds more
      // hospitals than St. Louis, so "each St. Louis fire station to the
      // nearest hospital" routed in Chicago and found no origin (2026-11-23).
      pointsSql: `SELECT geom FROM ${orig}`,
      sourcesSql: `SELECT geom FROM ${dest}`,
    });
    const cap = ctx.bind(MAX_ROUTES);
    // Forward edges, or reversed (source and target swapped, each direction
    // keeping its own cost), and the virtual arcs 0 -> each destination.
    const edges = N.edgesText(net);
    const reversed = edges.replace(/^SELECT id, source, target,/, "SELECT id, target AS source, source AS target,");
    if (reversed === edges) throw new CompileError("route: unexpected edge SQL");
    const virt = " UNION ALL SELECT -row_number() OVER (), 0, n, 0, -1 FROM unnest(%L::bigint[]) n";
    const minutes = net.mode === "walk"
      ? `sum(r.length_m) / ${ctx.bind(Number(net.walk_mps))}::float8 / 60` : `sum(r.drive_s) / 60`;
    const snapO = N.snap(net, "net_r.region", "o.geom");
    const head = [
      ...n.head,
      `rt_o AS MATERIALIZED (SELECT row_number() OVER () AS oid, o.geom, o.name, ${snapO} AS node ` +
        `FROM (SELECT * FROM ${orig} LIMIT ${cap}::int) o, net_r, net_box WHERE o.geom && net_box.bbox)`,
      // Destinations: their vertex, and one name per vertex.
      `rt_d AS MATERIALIZED (SELECT DISTINCT ON (node) node, geom, name FROM (SELECT d.geom, d.name, ` +
        `${N.snap(net, "net_r.region", "d.geom")} AS node FROM ${dest} d, net_r, net_box ` +
        `WHERE d.geom && net_box.bbox) x WHERE node IS NOT NULL ORDER BY node, name)`,
    ];
    // rt_p: (onode, dnode, path_seq, edge) for every route, one shape for both.
    let path;
    if (step.to === "nearest") {
      path = `rt_raw AS (SELECT p.end_vid AS onode, p.seq, p.node, p.edge FROM net_r CROSS JOIN LATERAL pgr_dijkstra(` +
        `format(${ctx.bind(reversed + virt)}::text, net_r.region, ARRAY(SELECT node FROM rt_d)::text), 0::bigint, ` +
        `ARRAY(SELECT DISTINCT node FROM rt_o WHERE node IS NOT NULL), directed => true) p), ` +
        // The destination is the first vertex after the virtual one, by seq:
        // pgRouting 3.8 numbers path_seq 1 twice on these paths (the virtual
        // vertex 0 and the first real one), so path_seq = 2 was the vertex
        // AFTER the destination and matched nothing (2026-11-23).
        `rt_p AS (SELECT r.onode, e.dnode, r.seq, r.edge FROM rt_raw r ` +
        `JOIN (SELECT DISTINCT ON (onode) onode, node AS dnode FROM rt_raw WHERE node <> 0 ORDER BY onode, seq) e ` +
        `ON e.onode = r.onode)`;
    } else {
      path = `rt_p AS (SELECT p.start_vid AS onode, p.end_vid AS dnode, p.seq, p.edge FROM net_r CROSS JOIN LATERAL pgr_dijkstra(` +
        `format(${ctx.bind(edges)}::text, net_r.region), (SELECT node FROM rt_o WHERE node IS NOT NULL ORDER BY oid LIMIT 1), ` +
        `ARRAY(SELECT node FROM rt_d), directed => true) p)`;
    }
    const dir = step.to === "nearest" ? "DESC" : "ASC";
    const line = `SELECT p.onode, p.dnode, ST_LineMerge(ST_Collect(r.geom ORDER BY p.seq ${dir})) AS geom, ` +
      `${minutes} AS minutes, sum(r.length_m) / 1609.344 AS miles ` +
      `FROM rt_p p JOIN road_edge r ON r.id = p.edge AND p.edge > 0 ` +
      `JOIN net_r ON r.region = net_r.region GROUP BY p.onode, p.dnode`;
    const value = net.cost === "time" ? "l.minutes" : "l.miles";
    return `${ctx.name} AS (WITH ${head.join(", ")}, ${path}, rt_l AS (${line}) ` +
      `SELECT l.geom, ${value} AS value, o.name AS from_name, d.name AS to_name, ` +
      `round(l.minutes::numeric, 2)::float8 AS minutes, round(l.miles::numeric, 3)::float8 AS miles, ` +
      `o.geom AS from_geom, d.geom AS to_geom ` +
      `FROM rt_l l JOIN rt_o o ON o.node = l.onode JOIN rt_d d ON d.node = l.dnode)`;
  },

  featureOutput(step) {
    const net = step.network || {};
    const how = net.mode === "walk" ? "walking" : "driving";
    return {
      select: (r) => [`${r}.from_name AS "from"`, `${r}.to_name AS "to"`, `${r}.minutes`, `${r}.miles`,
                      `ST_AsGeoJSON(${r}.from_geom, 9) AS from_point`, `ST_AsGeoJSON(${r}.to_geom, 9) AS to_point`],
      labels: ["from", "to", "minutes", "miles"],
      // The two ends, read off the same rows (planner/index.js shapeLayer):
      // as their own statements they re-ran the whole Dijkstra per layer.
      endpoints: true,
      order: "value ASC",
      valueLabel: net.cost === "time" ? `${how} minutes along the route` : `${net.mode === "walk" ? "walking" : "road"} miles along the route`,
      style: { kind: "ramp", by: net.cost === "time" ? "minutes" : "miles", unit: net.cost === "time" ? "minutes" : "miles" },
    };
  },

  MAX_ROUTES,
};
