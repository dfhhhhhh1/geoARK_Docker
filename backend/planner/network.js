/**
 * Network distance: drive and walk, by time or by road length
 * (docs/GIS_OPS_PLAN.md H5).
 *
 * The model never chooses network over straight-line, a mode, a speed or a
 * unit. It plans what it already plans for a distance question (`within`,
 * select_features, summarize, rank); code reads the question's words ("a
 * 4-minute drive", "a 10-minute walk", "3 kilometers driving distance", "road
 * miles") and attaches `network` to the distance step, the same discipline as
 * levels.js reading the unit and features.js reading km / miles. So the
 * prompt and decoding schema are unchanged, and a question with no network
 * phrasing is untouched.
 *
 * `network` = { mode: "drive"|"walk", cost: "time"|"length",
 *               limit: seconds (time) or meters (length) | absent,
 *               walk_mps: metres per second (walk only), unit: "minutes"|"miles" }
 *
 * Questions about PEOPLE at a network distance ("how many people in Chicago
 * live more than a 10-minute walk from a SNAP retailer") are rebuilt by
 * applyNetworkPopulation into the internal op network_population, which the
 * model is never offered (ops/network_population.js).
 *
 * Free flow: the graph has no signals, turns or congestion
 * (etl/osm_network.yaml). A question that names peak hours or traffic is
 * answered free-flow and the note says so.
 */

// features.js requires this module for its gate; read it lazily.
const ABOUT_PEOPLE = { test: (q) => require("./features").ABOUT_PEOPLE.test(q) };

const DEFAULT_WALK_MPH = Number(process.env.WALK_MPH || 3.0);
const MPH_TO_MPS = 0.44704;

const NUM = String.raw`(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty|half(?:\s+an?)?)`;
const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60 };
const num = (s) => {
  const t = String(s).toLowerCase().trim();
  if (/^half/.test(t)) return 0.5;
  return t in WORDNUM ? WORDNUM[t] : Number(t);
};

const DRIVE = String.raw`(?:drive|driving|car|auto|motor|road)`;
const WALK = String.raw`(?:walk|walking|foot|pedestrian)`;
const TIME_UNIT = String.raw`(?:minutes?|mins?|hours?|hrs?)`;

// "a 4-minute drive", "10 minute walk", "15 minutes' walk", "1-hour drive",
// "20 minutes by car", "10 minutes on foot", "5 minutes of walking".
const TIME_THEN_MODE = new RegExp(
  String.raw`\b${NUM}\s*-?\s*(${TIME_UNIT})['’]?\s*(?:of\s+|by\s+|on\s+)?(${DRIVE}|${WALK})\b`, "gi");
// "drive time of 10 minutes", "walking time under 15 minutes", "driving within 5 minutes".
const MODE_THEN_TIME = new RegExp(
  String.raw`\b(${DRIVE}|${WALK})(?:ing)?\s+(?:time\s+)?(?:of\s+|under\s+|within\s+|less\s+than\s+|more\s+than\s+|over\s+)?${NUM}\s*-?\s*(${TIME_UNIT})\b`, "gi");
// "3 kilometers driving distance", "2 miles by road", "1 km walking distance",
// "5 road miles", "within 2 miles of walking".
const LEN = String.raw`(miles?|mi|kilomet(?:er|re)s?|km|meters?|metres?|m|feet|ft)`;
const LENGTH_THEN_MODE = new RegExp(
  String.raw`\b(\d+(?:\.\d+)?)\s*-?\s*${LEN}\s+(?:of\s+)?(?:by\s+|on\s+)?(${DRIVE}|${WALK})(?:ing)?(?:\s+distance|\s+route)?\b`, "gi");
const ROAD_UNIT = new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s+road\s+${LEN}\b`, "gi");
// No number: "driving distance", "walking distance", "road miles", "by road",
// "drive time", "travel time by car".
const MODE_ONLY = new RegExp(
  String.raw`\b(?:(${DRIVE}|${WALK})(?:ing)?\s+(distance|time|route)|road\s+(miles|distance|kilomet(?:er|re)s)|by\s+(road|car|foot)|(drive|walk)\s+times?|travel\s+time)\b`, "i");

const LEN_TO_M = [
  [/^(?:mi|miles?)$/i, 1609.344], [/^(?:km|kilomet(?:er|re)s?)$/i, 1000],
  [/^(?:m|meters?|metres?)$/i, 1], [/^(?:ft|feet)$/i, 0.3048],
];
const lenM = (v, u) => v * (LEN_TO_M.find(([re]) => re.test(u)) || [null, NaN])[1];
const modeOf = (w) => (new RegExp(`^${WALK}`, "i").test(w) ? "walk" : "drive");

// "at 2.5 mph", "at 4 km/h": a stated walking speed.
const SPEED = /\bat\s+(\d+(?:\.\d+)?)\s*(mph|miles\s+per\s+hour|km\/h|kph|kilomet(?:er|re)s\s+per\s+hour)\b/i;

// The words before a stated cost say which side of it is wanted (features.js).
const BEYOND = /(?:more\s+than|farther\s+than|further\s+than|longer\s+than|over|beyond|at\s+least|greater\s+than|outside(?:\s+of)?|not\s+within|no\s+closer\s+than)\s+(?:an?\s+)?$/i;
const NEARER = /(?:within|less\s+than|under|inside|no\s+more\s+than|no\s+farther\s+than|no\s+longer\s+than|up\s+to|closer\s+than)\s+(?:an?\s+)?$/i;

const PEAK = /\b(?:peak|rush\s+hour|traffic|congest(?:ed|ion))\b/i;

/**
 * The network the question asks about, or null.
 * {mode, cost, limit?, walk_mps?, unit, side: "beyond"|"within"|null, phrase}
 */
function networkOf(query) {
  const q = String(query || "");
  const speed = q.match(SPEED);
  const walkMps = speed
    ? (/mph|miles/i.test(speed[2]) ? Number(speed[1]) * MPH_TO_MPS : Number(speed[1]) / 3.6)
    : DEFAULT_WALK_MPH * MPH_TO_MPS;
  const side = (index) => {
    const before = q.slice(Math.max(0, index - 30), index);
    return BEYOND.test(before) ? "beyond" : NEARER.test(before) ? "within" : null;
  };
  const finish = (net, index, phrase) => {
    if (net.mode === "walk") net.walk_mps = Number(walkMps.toFixed(5));
    net.unit = net.cost === "time" ? "minutes" : "miles";
    net.side = index === null ? null : side(index);
    net.phrase = phrase.trim();
    return net;
  };
  for (const m of q.matchAll(TIME_THEN_MODE)) {
    const n = num(m[1]);
    if (!(n > 0)) continue;
    const sec = n * (/^h/i.test(m[2]) ? 3600 : 60);
    return finish({ mode: modeOf(m[3]), cost: "time", limit: sec }, m.index, m[0]);
  }
  for (const m of q.matchAll(MODE_THEN_TIME)) {
    const n = num(m[2]);
    if (!(n > 0)) continue;
    const sec = n * (/^h/i.test(m[3]) ? 3600 : 60);
    // "drive time" is the subject: the side is before the mode word.
    return finish({ mode: modeOf(m[1]), cost: "time", limit: sec }, m.index, m[0]);
  }
  for (const m of q.matchAll(LENGTH_THEN_MODE)) {
    const meters = lenM(Number(m[1]), m[2]);
    if (!(meters > 0)) continue;
    return finish({ mode: modeOf(m[3]), cost: "length", limit: meters }, m.index, m[0]);
  }
  for (const m of q.matchAll(ROAD_UNIT)) {
    const meters = lenM(Number(m[1]), m[2]);
    if (!(meters > 0)) continue;
    return finish({ mode: "drive", cost: "length", limit: meters }, m.index, m[0]);
  }
  const o = q.match(MODE_ONLY);
  if (o) {
    const word = o[1] || o[4] || o[5] || "";
    const mode = /foot|walk/i.test(word) ? "walk" : "drive";
    const time = /time/i.test(o[0]);
    return finish({ mode, cost: time ? "time" : "length" }, null, o[0]);
  }
  return null;
}

const asksNetwork = (query) => networkOf(query) !== null;

/** Human description of a network spec, for notes and provenance. */
function describe(net) {
  const how = net.mode === "walk"
    ? `walking along the street and path network at ${(net.walk_mps / MPH_TO_MPS).toFixed(1)} mph`
    : "driving the road network at free-flow speeds (posted limit, else the road class default; no signals or traffic)";
  const lim = net.limit === undefined ? ""
    : net.cost === "time" ? ` within ${+(net.limit / 60).toFixed(2)} minutes`
    : ` within ${+(net.limit / 1609.344).toFixed(3)} road miles`;
  return `${net.cost === "time" ? "travel time" : "route length"}${lim}, ${how}`;
}

/**
 * Attach the question's network to every `within` step, and set its side
 * (exclude) from the words before the stated cost. `miles` is dropped: a
 * network limit replaces it, and the number the model put there ("4" for a
 * 4-minute drive) is not a distance. Returns a description, or null.
 */
function applyNetwork(plan, query) {
  const net = networkOf(query);
  if (!net) return null;
  const fixes = [];
  for (const st of plan.steps || []) {
    if (st.op !== "within") continue;
    const { side, phrase, ...spec } = net;
    st.network = spec;
    delete st.miles;
    if (spec.limit === undefined) delete st.exclude;
    else if (side === "beyond") st.exclude = true;
    else if (side === "within") delete st.exclude;
    fixes.push(`step ${st.id} measures ${describe(spec)}${st.exclude ? " (keeping those beyond it)" : ""}`);
  }
  // A comparison filter on a limited network step's value restates the limit
  // in a unit the model cannot know (the value is minutes or road miles, set
  // here): "more than a 2.5-minute drive" came back EMPTY once in five runs
  // with within -> filter_attr (H5 dev r5, 2026-11-19), and correct with the
  // same shape when the number happened to match. The step already applies
  // the question's stated limit, so the filter is removed.
  const steps = plan.steps || [];
  for (const w of steps.filter(s => s.op === "within" && s.network?.limit !== undefined)) {
    for (const f of steps.filter(s => s.op === "filter_attr" && (s.inputs || [])[0] === w.id &&
                                      ["<", "<=", ">", ">="].includes(s.operator))) {
      for (const o of steps) o.inputs = (o.inputs || []).map(i => (i === f.id ? w.id : i));
      plan.steps = plan.steps.filter(x => x !== f);
      fixes.push(`step ${f.id} (${f.operator} ${f.value}) restated the network limit, which step ${w.id} applies`);
    }
  }
  if (fixes.length) {
    fixes.push("road networks are loaded for some areas only; features outside the loaded area that holds most of them are left out");
  }
  if (fixes.length && PEAK.test(String(query || ""))) {
    fixes.push("no traffic data is loaded, so times are free-flow, not peak-hour");
  }
  return fixes.length ? fixes.join("; ") : null;
}

// ------------------------------------------------------------ people

const SHARE = /\b(?:share|percent(?:age)?|proportion|fraction)\b|%/i;
const PER_ZONE = /\b(?:each|every|per|by)\b/i;

/**
 * "How many people in Chicago live more than a 10-minute walk from a SNAP
 * retailer?", "What share of each St. Louis ward's population lives within a
 * 5-minute drive of a hospital?" -- about people, at a network cost.
 *
 * Rebuilt in code, like catchment.js moves a distance plan to tracts: the
 * model's plan supplies the reference layer (the feature layer it measured
 * to) and the area (its filter_place, or the zone level levels.js set), and
 * the answer is network_population over WorldPop pixel centres. Anything
 * missing -> null, and the plan stands as the model wrote it.
 *
 * @param popAttr  attr_id of the population raster measure (WorldPop)
 * @param isFeature (attr_id) => whether it is a feature layer
 */
function applyNetworkPopulation(plan, query, { popAttr, isFeature, zone = null }) {
  const q = String(query || "");
  const net = networkOf(q);
  if (!net || net.limit === undefined || !ABOUT_PEOPLE.test(q) || !popAttr) return null;
  const steps = plan.steps || [];
  const ref = steps.find(s => s.attr_id && isFeature(s.attr_id) &&
    ["select_features", "nearest_distance", "count_near", "count_features"].includes(s.op));
  if (!ref) return null;
  // The area: the plan's filter_place, else a city on any step ("people in
  // Chicago" was planned as filter_place once and as a city on the feature
  // step another time). A zone set comes from the question (levels.levelOf),
  // since this runs before validation, ahead of applyLevel.
  const fp = steps.find(s => s.op === "filter_place" && s.place_name);
  const withCity = steps.find(s => s.city);
  const place = fp ? fp
    : withCity ? { place_kind: "place", place_name: withCity.city, states: withCity.states } : null;
  zone = zone && /^z_/.test(zone) ? zone : null;
  if (!place && !zone) return null;
  const { side, phrase, ...spec } = net;
  const perZone = !!zone && PER_ZONE.test(q);
  const pop = {
    id: "np", op: "network_population", attr_id: popAttr, inputs: ["nr"],
    network: spec, exclude: side === "beyond",
    stat: SHARE.test(q) ? "share" : "people",
    ...(zone ? { zones: zone } : {}),
    ...(place ? { place_kind: place.place_kind || "place", place_name: place.place_name,
                  ...(place.states?.length ? { states: place.states } : {}) } : {}),
    ...(perZone ? {} : { group_by: "none" }),
  };
  plan.steps = [
    { id: "nr", op: "select_features", attr_id: ref.attr_id, inputs: [],
      ...(ref.attribute_filters?.length ? { attribute_filters: ref.attribute_filters } : {}) },
    pop,
    { id: "out", op: "output", attr_id: "", inputs: ["np"] },
  ];
  if (perZone) plan.level = zone; else delete plan.level;
  const where = zone ? (perZone ? `each unit of ${zone}` : `all of ${zone}`) : `${place.place_name}`;
  return `people counted by WorldPop pixel centre in ${where}, ` +
         `${pop.stat === "share" ? "as a percentage of the people there, " : ""}` +
         `${pop.exclude ? "beyond" : "within"} ${describe(spec)} of the nearest feature of ${ref.attr_id}`;
}

/**
 * Errors for a plan that would answer a network question in straight lines.
 * Network costs exist between mapped FEATURES (within, network_population);
 * nearest_distance and count_near measure from each unit's point and are
 * straight-line only. "transit stops within a 10-minute walk" of a census
 * tract was planned as nearest_distance(transit) -> filter_attr with a number
 * the model chose (held-out Q7, 2026-11-19): valid, executable, and a
 * straight-line answer to a walking question. Refused, never substituted.
 */
function networkUnitErrors(plan, query) {
  const net = networkOf(query);
  if (!net) return [];
  const unitOps = (plan.steps || []).filter(s => s.op === "nearest_distance" || s.op === "count_near");
  if (!unitOps.length) return [];
  return [`The question asks for ${net.phrase ? `"${net.phrase}"` : "a network distance"}, which is measured ` +
    `along roads or paths. ${unitOps.map(s => `Step "${s.id}" (${s.op})`).join(", ")} measures straight-line ` +
    `distance from each unit, so it cannot answer that. Network distance is available between two mapped ` +
    `layers (select_features twice, then within); if the question needs it per unit, say it cannot be answered.`];
}

module.exports = { networkOf, asksNetwork, applyNetwork, applyNetworkPopulation, networkUnitErrors, describe, DEFAULT_WALK_MPH };
