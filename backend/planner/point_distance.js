/**
 * Distances over the fine sample points (ops/point_distance.js), set in code.
 *
 * `nearest_distance` measures from one point per unit, its centroid. For a
 * question about how distance is DISTRIBUTED over a unit ("what share of each
 * county is more than 20 miles from a hospital", "the 90th percentile
 * distance to a hospital in each tract", "the farthest point in each county
 * from a hospital") one point cannot answer it. Where the fine points are
 * loaded, every block centroid and hexagon point in the unit can: each
 * carries a precomputed distance to the nearest facility of 30 kinds.
 *
 * Nothing is shown to the model. After a plan is accepted, a nearest_distance
 * step is swapped for point_distance when ALL of these hold:
 *   - the question asks for a distribution (share / percentile / median /
 *     farthest point / average over the area / "fine points"), and does not
 *     ask about a centre ("the center of each county" is the centroid);
 *   - the layer it measures to has a precomputed column (LAYER_COLUMNS: the
 *     gdb's own layers, matched by the catalog dataset name);
 *   - the plan restricts to states, and every one has points loaded;
 *   - it is a plain distance (not identify / k) and is not read by a
 *     threshold filter or a catchment count, whose meaning a share would change.
 * Otherwise it is left alone, with a note saying why when the question asked.
 *
 * The distances are STRAIGHT-LINE (ArcGIS Near or Euclidean-distance rasters,
 * corrected to ground miles), computed against the facility layers of the
 * L48 GeoARK geodatabase, which may be another vintage than the layer loaded
 * here. Hospitals were checked against the loaded layer: median ratio 1.000
 * to geodesic (docs/POINTS_INTEGRATION_PLAN.md).
 */

const { STATE_FIPS, toFipsPrefixes } = require("../states");

const STATS = new Set(["mean", "pct", "max", "share"]);

// Catalog dataset name -> fine_pt column. Only layers whose precomputed
// distance is to the same kind of facility. Not mapped: parks (which park
// layer was used is not recorded), public transit (D_PubTrans reads 134 mi
// in Columbia MO, which has a bus system), EMS (no EMS layer is loaded).
const LAYER_COLUMNS = [
  [/^hospitals$/i, "hosp_mi"],
  [/^veterans health administration/i, "vha_mi"],
  [/^public health departments$/i, "public_health_mi"],
  [/^child care centers$/i, "child_care_mi"],
  [/^public schools?( locations)?$/i, "public_school_mi"],
  [/^college university campuses$/i, "college_mi"],
  [/^places of worship$/i, "worship_mi"],
  [/^transmission lines$/i, "power_line_mi"],
  [/^substations$/i, "substation_mi"],
  [/^power plants$/i, "power_plant_mi"],
  [/^oil refineries$/i, "oil_refinery_mi"],
  [/^biodiesel plants$/i, "biodiesel_mi"],
  [/toxic release inventory/i, "tri_facility_mi"],
  [/\btsca\b/i, "tsca_facility_mi"],
  [/^solid waste landfill/i, "landfill_mi"],
  [/^hist(orical)? tornado tracks$/i, "tornado_track_mi"],
  [/^construction minerals operations$/i, "construction_minerals_mi"],
  [/^agricultural minerals operations$/i, "agricultural_minerals_mi"],
  [/^refract abrasive other ind min ops$/i, "abrasive_minerals_mi"],
  [/^miscellaneous ind min ops$/i, "misc_industrial_minerals_mi"],
  [/^ferrous metal mines$/i, "ferrous_mine_mi"],
  [/^ferrous metal process plants$/i, "ferrous_processing_mi"],
  [/^nonferrous metal mines$/i, "nonferrous_mine_mi"],
  [/^nonferrous metal process plants$/i, "nonferrous_processing_mi"],
  [/^uranium vanadium deposits$/i, "uranium_vanadium_mi"],
];
const COLUMNS = new Set([...LAYER_COLUMNS.map(([, c]) => c), "ems_mi", "parks_mi", "public_transit_mi",
  "oil_refinery_site_mi", "mine_mineral_site_mi"]);

/** Which states have points: set by backend/fine_points.js as it reads the partitions. */
let loaded = new Set();
function setLoadedStates(fips) { loaded = new Set(fips); }
function loadedStates() { return loaded; }

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const UNIT = String.raw`(miles?|mi|kilometers?|kilometres?|km)\b`;
const FAR = String.raw`more than|farther than|further than|over|beyond|at least|outside(?: of)?`;
const NEAR_ = String.raw`within|less than|under|inside|closer than|no more than|at most`;
const SHARE = new RegExp(String.raw`(?:\b(?:share|percent(?:age)?|proportion|fraction|how much|what part)\s+of\b|%\s+of\b)` +
  // A share of PEOPLE is a catchment count (planner/catchment.js), not area.
  String.raw`(?:(?!\b(?:population|people|residents?|households?|homes?|persons?|children|adults|seniors|patients|veterans)\b)[^?.;]){0,90}?` +
  String.raw`\b(${FAR}|${NEAR_})\s+(?:a\s+|an\s+)?${NUM}\s*${UNIT}`, "i");
const PCT = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+percentile\s+(?:of\s+(?:the\s+)?)?(?:straight[- ]line\s+)?distances?\b|\bdistances?\b[^?.;]{0,30}\b(\d{1,2})(?:st|nd|rd|th)[\s-]+percentile\b/i;
// "median distance", not "median household income and distance".
const MEDIAN = /\bmedian\s+(?:of\s+(?:the\s+)?)?(?:straight[- ]line\s+)?(?:distances?|mileage)\b/i;
const MAX = /\b(?:farthest|furthest|most remote|worst[- ]case|maximum|max)\s+(?:point|location|place|spot|block|corner|part|distance)s?\b/i;
const MEAN = new RegExp(String.raw`\b(?:average|mean|typical)\s+distance\b[^?.;]{0,80}?\b(?:across|throughout|everywhere in|over the (?:whole|entire)|` +
  String.raw`from (?:every|all|each) (?:point|location|place|spot|block)s?)\b`, "i");
const EXPLICIT = /\b(?:fine|sample|hexagon(?:al)?)\s+points?\b|\bblock[- ]centroids?\b|\bblock[- ]level\b|\bthiessen\b|\bvoronoi\b/i;
const CENTRE = /\b(?:cent(?:er|re)s?|centroids?)\s+of\b/i;

/** What the question asks of the distribution, or null. */
function pointStatOf(query) {
  const q = String(query || "");
  if (CENTRE.test(q)) return null;
  let m = q.match(SHARE);
  if (m) {
    let t = Number(m[2]);
    if (/^k/i.test(m[3])) t /= 1.609344;
    const cmp = new RegExp(`^(?:${FAR})$`, "i").test(m[1]) ? ">" : "<=";
    return { stat: "share", threshold: Math.round(t * 1000) / 1000, cmp,
      why: `percent of the area ${cmp === ">" ? "farther than" : "within"} ${m[2]} ${m[3]}` };
  }
  if ((m = q.match(PCT))) {
    const p = Number(m[1] || m[2]);
    return { stat: "pct", q: p, why: `${p}th percentile over the area` };
  }
  if (MEDIAN.test(q)) return { stat: "pct", q: 50, why: "median over the area" };
  if (MAX.test(q)) return { stat: "max", why: "the farthest point" };
  if (MEAN.test(q) || EXPLICIT.test(q)) return { stat: "mean", why: "mean over every point in the area" };
  return null;
}

function columnFor(name) {
  const n = String(name || "").trim();
  for (const [re, col] of LAYER_COLUMNS) if (re.test(n)) return col;
  return null;
}

/** State FIPS the plan is restricted to (filter_area / filter_place), or null if national. */
function planStates(plan) {
  const names = [];
  for (const st of plan.steps || []) {
    if ((st.op === "filter_area" || st.op === "filter_place") && Array.isArray(st.states)) names.push(...st.states);
  }
  if (!names.length) return null;
  const { codes, unknown } = toFipsPrefixes(names);
  return unknown.length ? null : codes;
}

const FIPS_NAME = Object.fromEntries(Object.entries(STATE_FIPS).map(([n, f]) => [f, n]));

/**
 * Swap nearest_distance for point_distance where the question and the data
 * allow it. Returns { fixes, notes } (empty when the question asks nothing of
 * a distribution: the common case, untouched).
 */
function applyPointDistance(plan, query, { nameOf } = {}) {
  const out = { fixes: [], notes: [] };
  const want = pointStatOf(query);
  if (!want || !Array.isArray(plan?.steps)) return out;
  const nd = plan.steps.filter(s => s.op === "nearest_distance");
  // The Step 1 summaries (HSIP_PROXIMITY_DIST_*) are the same precomputed
  // distances as a county / tract / block-group MEAN of block means; a
  // median, percentile or share of one is read from the points instead.
  const sums = plan.steps.filter(s => s.op === "load" && summaryColumn(s.attr_id));
  if (!nd.length && !sums.length) return out;
  const have = loadedStates();
  const loadedNames = [...have].map(f => FIPS_NAME[f] || f).join(", ") || "none";
  const states = planStates(plan);
  if (!states) {
    out.notes.push(`the question asks for a ${want.why}, which needs the fine points, loaded only for ${loadedNames}; ` +
      "the plan covers more than that, so distance is measured from each unit's centre");
    return out;
  }
  const missing = states.filter(s => !have.has(s));
  if (missing.length) {
    out.notes.push(`fine points are not loaded for ${missing.map(f => FIPS_NAME[f] || f).join(", ")} ` +
      `(loaded: ${loadedNames}); distance is measured from each unit's centre`);
    return out;
  }
  const readers = (id) => plan.steps.filter(s => (s.inputs || []).includes(id));
  let catchment = false;
  try { catchment = require("./catchment").asksPeopleAtDistance(query); } catch { /* optional */ }
  for (const st of nd) {
    if (st.identify === true || Number(st.k) > 1) continue;
    const layer = nameOf ? nameOf(st.attr_id) : st.attr_id;
    const column = columnFor(layer);
    if (!column) {
      out.notes.push(`"${layer}" has no precomputed point distance; measured from each unit's centre`);
      continue;
    }
    // "What share of each county is more than 20 miles from X": the model
    // writes the 20 miles as a filter on the distance. The share already holds
    // it, so a filter with the share's own threshold and direction is dropped
    // (its readers read the distance step); any other filter keeps the centre.
    if (!catchment && want.stat === "share") {
      for (const r of readers(st.id)) {
        if (r.op !== "filter_attr" || Number(r.value) !== Number(want.threshold)) continue;
        const dir = /^>=?$/.test(r.operator) ? ">" : /^<=?$/.test(r.operator) ? "<=" : null;
        if (dir !== want.cmp) continue;
        for (const s of plan.steps) s.inputs = (s.inputs || []).map(i => (i === r.id ? st.id : i));
        plan.steps.splice(plan.steps.indexOf(r), 1);
        out.fixes.push(`step ${r.id}: the filter "distance ${r.operator} ${r.value}" is the share's own threshold; dropped`);
      }
    }
    if (catchment || readers(st.id).some(r => r.op === "filter_attr")) {
      out.notes.push(`distance to "${layer}" is thresholded by the plan, so it stays a centre distance`);
      continue;
    }
    const before = { ...st };
    for (const k of Object.keys(st)) if (!["id", "attr_id", "inputs"].includes(k)) delete st[k];
    Object.assign(st, { op: "point_distance", column, stat: want.stat, state_fips: states,
      ...(want.stat === "pct" ? { q: want.q } : {}),
      ...(want.stat === "share" ? { threshold: want.threshold, cmp: want.cmp } : {}) });
    st.inputs = [];
    out.fixes.push(`step ${st.id}: distance to "${layer}" as the ${want.why}, from the fine sample points ` +
      `(${column}, straight-line), instead of from each unit's centre`);
    out.before = out.before || [];
    out.before.push(before);
  }
  for (const st of sums) {
    if (want.stat === "mean" && !EXPLICIT.test(String(query))) continue;   // the summary IS a mean
    const column = summaryColumn(st.attr_id);
    const code = st.attr_id;
    for (const k of Object.keys(st)) if (!["id", "inputs"].includes(k)) delete st[k];
    Object.assign(st, { op: "point_distance", measure_id: code, column, stat: want.stat, state_fips: states,
      ...(want.stat === "pct" ? { q: want.q } : {}),
      ...(want.stat === "share" ? { threshold: want.threshold, cmp: want.cmp } : {}) });
    st.inputs = [];
    out.fixes.push(`step ${st.id}: ${code} is a mean of block means; the ${want.why} is read from the fine ` +
      `sample points (${column}) instead`);
  }
  return out;
}

/** HSIP_PROXIMITY_DIST_PUBLIC_SCHOOL -> public_school_mi, when that column exists. */
function summaryColumn(id) {
  const m = /^HSIP_PROXIMITY_DIST_([A-Z_]+)$/.exec(String(id || ""));
  const col = m ? `${m[1].toLowerCase()}_mi` : null;
  return col && COLUMNS.has(col) ? col : null;
}

module.exports = { applyPointDistance, pointStatOf, columnFor, summaryColumn, setLoadedStates, loadedStates, STATS, COLUMNS, LAYER_COLUMNS };
