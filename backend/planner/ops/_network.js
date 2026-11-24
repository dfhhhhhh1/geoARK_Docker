/**
 * Network-distance SQL shared by `within` (network form) and
 * `network_population` (docs/GIS_OPS_PLAN.md H5). The graph is road_edge /
 * road_vertex, built by etl/load_osm_network.py; the cost is pgRouting's
 * pgr_drivingDistance, multi-source with equicost, so each vertex gets the
 * cost FROM its nearest source along the directed graph.
 *
 * Every point (a feature, a WorldPop pixel centre) is snapped to the nearest
 * vertex of the mode's LARGEST component, by geodesic distance: `<->` on
 * geography, served by a partial geography GIST index per mode. The access leg
 * from the point to its vertex is not costed (etl/osm_network.yaml).
 *
 * The region is the loaded one holding most of the points; points outside it
 * are left out (and planner/network.js says so). When no region holds any,
 * road_region_for() RAISES: a straight-line answer substituted for a network
 * one would be a confident wrong answer.
 */

const { CompileError, expandBox } = require("./_sql");

const MODES = new Set(["drive", "walk"]);
const COSTS = new Set(["time", "length"]);

function check(net) {
  if (!net || !MODES.has(net.mode) || !COSTS.has(net.cost)) {
    throw new CompileError(`network: mode drive|walk and cost time|length, got ${JSON.stringify(net)}`);
  }
  if (net.mode === "walk" && !(Number(net.walk_mps) > 0)) {
    throw new CompileError("network: a walk needs walk_mps");
  }
  if (net.limit !== undefined && !(Number(net.limit) > 0)) {
    throw new CompileError(`network: limit must be positive, got ${net.limit}`);
  }
}

/** pgRouting edges SQL for the mode and cost, with %L for the region (format()). */
function edgesText(net) {
  if (net.mode === "walk") {
    return "SELECT id, source, target, length_m AS cost, length_m AS reverse_cost " +
           "FROM road_edge WHERE region = %L AND walk";
  }
  const c = net.cost === "time" ? "drive_s" : "length_m";
  return `SELECT id, source, target, CASE WHEN drive_fwd THEN ${c} ELSE -1 END AS cost, ` +
         `CASE WHEN drive_bwd THEN ${c} ELSE -1 END AS reverse_cost ` +
         `FROM road_edge WHERE region = %L AND (drive_fwd OR drive_bwd) AND ${c} IS NOT NULL`;
}

/** The limit in the graph's cost units (seconds for drive time, metres otherwise). */
function limitInCost(net) {
  if (net.limit === undefined) return null;
  if (net.cost === "time" && net.mode === "walk") return Number(net.limit) * Number(net.walk_mps);
  return Number(net.limit);
}

/** Divide agg_cost by this to report minutes (time) or miles (length). */
function costPerUnit(net) {
  if (net.cost === "length") return 1609.344;
  return net.mode === "walk" ? Number(net.walk_mps) * 60 : 60;
}

/** Nearest vertex id of the mode's largest component. */
function snap(net, regionExpr, pointExpr) {
  const cc = net.mode === "walk" ? "walk_cc" : "drive_cc";
  return `(SELECT v.id FROM road_vertex v WHERE v.region = ${regionExpr} AND v.${cc} ` +
         `ORDER BY v.geom::geography <-> (${pointExpr})::geography LIMIT 1)`;
}

/**
 * CTE fragments (no leading WITH). `head` is `net_r(region)` and
 * `net_src(node)`; `cost(targetsSql)` is `net_cost(node, agg_cost)`: the cost
 * FROM the nearest source TO each target vertex, one Dijkstra in all.
 *
 * Why not pgr_drivingDistance: it returns (and does per-vertex work for) every
 * vertex it reaches, and that cost is superlinear. Measured on St. Louis
 * (2026-11-19): 5k vertices reached 0.9 s, 27k 5.5 s, 284k ~140 s, i.e. a
 * 4-minute drive from 243 fire stations took 64 s, and a virtual super-source
 * did not help. These questions only ever need the cost at the points asked
 * about (hundreds), so: a virtual vertex 0 with a zero-cost one-way edge to
 * every source vertex (OSM node ids are positive), and pgr_dijkstraCost from
 * 0 to the target vertices. Same question: 0.9 s. A target no source reaches
 * is absent, so it reads NULL (beyond any limit).
 *
 * Bounded edges (2026-11-24). pgRouting rebuilds the graph from every edge it
 * is handed, so a query costs the size of its REGION, not its trip: one drive
 * time took 11 s on Missouri (4.3M edges) and 51 s on Texas (10.5M), over
 * executePlan's 30 s. With a limit, every vertex on a path the limit admits is
 * within reachMeters of the target it ends at (cost so far <= limit, at no
 * more than MAX_DRIVE_MPS), so edges outside the targets' extent grown by that
 * distance cannot change any cost <= limit: the answer is the same, from a
 * fraction of the graph. Only a target's cost ABOVE the limit can change (to
 * NULL), so a caller that reports it (within with exclude) passes
 * `bounded: false`, and so does any question with no limit.
 */
const MAX_DRIVE_MPS = 36;  // 130 km/h; as service_area.reachMeters

/** Metres a cost of `lim` graph units can cover at most. */
function reachMetersForCost(net, lim) {
  return net.mode === "drive" && net.cost === "time" ? lim * MAX_DRIVE_MPS : lim;
}

function reachCtes(net, ctx, { pointsSql, sourcesSql, bounded = true, maxCost = null }) {
  check(net);
  // maxCost: a limit in graph units for a caller whose net carries none
  // (service_area's top band).
  const lim = maxCost !== null ? Number(maxCost) : limitInCost(net);
  const boxM = bounded && lim !== null ? reachMetersForCost(net, lim) : null;
  // Bound when cost() is called, not before: a caller that only wants the
  // region and the sources (ops/route.js) must not leave an unused parameter,
  // which Postgres refuses ("could not determine data type of parameter").
  const edgesParam = () => ctx.bind(edgesText(net) + (boxM === null ? "" : " AND geom && %L::geometry") +
    " UNION ALL SELECT -row_number() OVER (), 0, n, 0, -1 FROM unnest(%L::bigint[]) n");
  // The targets' extent grown by the reach, as EWKT for format()'s %L.
  const boxArg = (targetsSql) => boxM === null ? "" :
    `(SELECT ST_AsEWKT(${expandBox("ST_SetSRID(ST_Extent(v.geom), 4326)", `${ctx.bind(boxM)}::float8`)}) ` +
    `FROM road_vertex v WHERE v.region = net_r.region AND v.id IN (SELECT node FROM (${targetsSql}) t)), `;
  return {
    head: [
      // The loaded region holding MOST of the points; callers leave out points
      // outside it (a national layer summarized per Chicago community area is
      // the case: H5 dev r1). None holding any -> road_region_for raises.
      // Ties go to the SMALLEST box, as in road_region_for: with state regions
      // loaded, every St. Louis point is also in the Missouri box, and by name
      // "mo" would beat "stl" (a 4.3M-edge graph for a 674k-edge question).
      // The points once, MATERIALIZED: joined inline, Postgres looped the
      // regions and re-ran the layer's city filter for each, 15 of 18.5 s on
      // "schools in St. Louis" once 113 regions were loaded (2026-11-24).
      `net_pp AS MATERIALIZED (SELECT geom FROM (${pointsSql}) p)`,
      `net_r AS (SELECT coalesce((SELECT rr.region FROM road_region rr JOIN net_pp a ` +
        `ON a.geom && rr.bbox GROUP BY rr.region, rr.bbox ` +
        `ORDER BY count(*) DESC, ST_Area(rr.bbox), rr.region LIMIT 1), ` +
        `road_region_for((SELECT ST_SetSRID(ST_Extent(geom), 4326)::geometry FROM net_pp e))) AS region)`,
      `net_box AS (SELECT rr.bbox FROM road_region rr, net_r WHERE rr.region = net_r.region)`,
      // Bounded, only sources near the points are snapped: a source farther
      // than the reach from every point cannot reach one within the limit.
      // The 25 km is for a source just outside that snaps to a vertex inside.
      // Unbounded, Lubbock snapped all 4,905 Texas fire stations: 26 of 34 s.
      `net_src AS (SELECT DISTINCT ${snap(net, "net_r.region", "b.geom")} AS node ` +
        `FROM (${sourcesSql}) b, net_r, road_region rr ` +
        `WHERE rr.region = net_r.region AND b.geom && rr.bbox` +
        (boxM === null ? ")" : ` AND b.geom && (SELECT ${expandBox("ST_SetSRID(ST_Extent(geom), 4326)",
          `${ctx.bind(boxM + 25000)}::float8`)} FROM net_pp))`),
    ],
    cost: (targetsSql, edges = edgesParam()) =>
      `net_cost AS (SELECT d.end_vid AS node, d.agg_cost FROM net_r CROSS JOIN LATERAL pgr_dijkstraCost(` +
      `format(${edges}::text, net_r.region, ${boxArg(targetsSql)}` +
      `ARRAY(SELECT node FROM net_src WHERE node IS NOT NULL)::text), ` +
      `0::bigint, ARRAY(SELECT DISTINCT node FROM (${targetsSql}) t WHERE node IS NOT NULL), ` +
      `directed => true) d)`,
  };
}

module.exports = { check, edgesText, limitInCost, costPerUnit, snap, reachCtes };
