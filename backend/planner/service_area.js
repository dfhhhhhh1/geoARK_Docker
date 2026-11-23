/**
 * Service areas: "map the 5, 10 and 15-minute drive times around the fire
 * stations in St. Louis", "show the area within a 10-minute walk of each
 * library in Chicago", "drive-time isochrones for hospitals in St. Louis"
 * (docs/GIS_OPS_PLAN.md H5; ops/service_area.js says what a band is).
 *
 * The model never sees service_area. It plans what it plans for any question
 * that names a layer (select_features, within, count_features ...); code reads
 * the question's words, and when it asks for the AREA a network reaches, the
 * plan is rebuilt from its reference layer and restrictions:
 *
 *   select_features(ref) -> service_area -> output     (the bands)
 *                        \-> output                     (the facilities, on top)
 *
 * Mode, cost and bands come from the question (network.js reads the mode and
 * cost; bandsOf reads the list). Anything missing -> null, and the plan stands
 * as the model wrote it. The prompt and decoding schema are unchanged.
 */

const { networkOf, describe } = require("./network");

// The AREA is the thing asked for. Kept to phrasing that names an area, a
// band or an isochrone, so "which schools are within a 10-minute drive of a
// fire station" (features, `within`) and "how many people live within a
// 10-minute drive" (people, network_population) are untouched.
const AREA_WORDS = new RegExp([
  String.raw`\bservice\s+areas?\b`, String.raw`\bisochrones?\b`, String.raw`\bisolines?\b`,
  String.raw`\b(?:walk|travel|drive|commute)[- ]?sheds?\b`,
  String.raw`\b(?:drive|driving|walk|walking|travel|response)[- ]?times?\s+(?:areas?|zones?|bands?|rings?|maps?|polygons?|contours?|coverage|catchments?)\b`,
  String.raw`\b(?:catchment|coverage|response)\s+(?:areas?|zones?)\b`,
  // "the area within a 10-minute drive of", "zones reachable in 15 minutes",
  // "parts of the city within a 5-minute walk".
  String.raw`\b(?:areas?|zones?|regions?|territor(?:y|ies)|extent|parts?\s+of\s+(?:the\s+)?(?:city|county|metro|town|region))\s+(?:(?:that|which)\s+)?(?:(?:are|is|can\s+be|could\s+be)\s+)?(?:within|reach(?:ed|able)|accessible|covered|served)\b`,
  String.raw`\bhow\s+far\s+(?:can|could)\s+(?:you|one|i|we|someone|a\s+\w+)\s+(?:drive|walk|get|travel)\b`,
  // "map / show the 5, 10 and 15-minute drive times around fire stations".
  String.raw`\b(?:map|show|draw|display|visuali[sz]e|plot)\b[^.?!]{0,60}\b(?:drive|driving|walk|walking|travel)[- ]?times?\s+(?:around|from|of|for)\b`,
].join("|"), "i");

// "Which fire stations are within a 10-minute drive-time catchment of
// downtown" asks for FEATURES inside an area, not for the area: a question
// that opens by asking which things are meant is left to the feature ops.
const WHICH_THINGS = /^\s*(?:which|what)\s+(?!(?:areas?|parts?|zones?|regions?|neighbou?rhoods?|territor(?:y|ies)|places)\b)[a-z]+/i;

const asksServiceArea = (query) => {
  const q = String(query || "");
  return AREA_WORDS.test(q) && !WHICH_THINGS.test(q);
};

const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty-five": 45, sixty: 60, half: 0.5 };
const N = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|sixty)`;
const toNum = (s) => (String(s).toLowerCase() in WORD ? WORD[String(s).toLowerCase()] : Number(s));
const TIME_U = String.raw`(?:minutes?|mins?|hours?|hrs?)`;
const LEN_U = String.raw`(?:miles?|mi|kilomet(?:er|re)s?|km)`;

/**
 * The band limits the question states, in minutes (time) or miles (length),
 * ascending; null when it states none.
 *   "5, 10 and 15-minute drive", "10/20/30 minute walk", "10- and 20-minute",
 *   "within 5, 10, or 15 miles by road", "in 5-minute bands up to 20 minutes".
 */
function bandsOf(query, net) {
  const q = String(query || "");
  const unit = net.cost === "time" ? TIME_U : LEN_U;
  const scale = (u) => (/^h/i.test(u) ? 60 : /^(?:km|kilomet)/i.test(u) ? 1 / 1.609344 : 1);
  // Steps: "in 5-minute bands / increments / intervals up to 20 minutes".
  const step = q.match(new RegExp(String.raw`\b(${N})\s*-?\s*(${unit})\s+(?:bands?|increments?|intervals?|steps?|rings?)\b[^.?!]{0,30}?\b(?:up\s+to|to|out\s+to|through|until)\s+(${N})\s*-?\s*(${unit})`, "i"));
  if (step) {
    const s = toNum(step[1]) * scale(step[2]), top = toNum(step[3]) * scale(step[4]);
    if (s > 0 && top > s && top / s <= 6) {
      const out = [];
      for (let x = s; x <= top + 1e-9; x += s) out.push(+x.toFixed(3));
      return out;
    }
  }
  // A list ending in the unit: "5, 10 and 15-minute", "10/20/30 min", "10- and 20-minute".
  const list = new RegExp(String.raw`\b((?:${N})(?:\s*-?\s*(?:${unit})?\s*(?:,|/|&|\band\b|\bor\b|\bto\b)\s*(?:and\s+|or\s+)?(?:${N}))*)\s*-?\s*(${unit})\b`, "gi");
  const vals = [];
  for (const m of q.matchAll(list)) {
    // Each number takes the next unit after it: "30 minutes and 1 hour" is
    // 30 and 60, not 1,800 and 60.
    const toks = [...`${m[1]} ${m[2]}`.matchAll(new RegExp(String.raw`(${N})|(${unit})`, "gi"))];
    toks.forEach((t, i) => {
      if (!t[1]) return;
      const u = toks.slice(i + 1).find(x => x[2]);
      vals.push(toNum(t[1]) * scale(u ? u[2] : m[2]));
    });
  }
  const uniq = [...new Set(vals.filter(v => v > 0).map(v => +v.toFixed(3)))].sort((a, b) => a - b);
  return uniq.length ? uniq.slice(0, 6) : null;
}

/**
 * One stated limit, banded so the map shows travel time inside it: the
 * smallest round step giving 2-4 bands ("10 minutes" -> 5, 10; "15" -> 5, 10,
 * 15; "20" -> 5, 10, 15, 20). A limit no step divides stays one band.
 */
function splitLimit(top) {
  for (const s of [1, 2, 5, 10, 15, 30, 60]) {
    const k = top / s;
    if (Number.isInteger(+k.toFixed(9)) && k >= 2 && k <= 4) {
      return Array.from({ length: k }, (_, i) => +((i + 1) * s).toFixed(3));
    }
  }
  return [top];
}

const DEFAULT_BANDS = { "drive:time": [5, 10, 15], "walk:time": [5, 10, 15],
                        "drive:length": [1, 2, 5], "walk:length": [0.25, 0.5, 1] };

/** {network, bands} for a service-area question, or null. */
function serviceAreaOf(query) {
  const q = String(query || "");
  if (!asksServiceArea(q)) return null;
  // "isochrones for hospitals" names no mode: a drive, by time.
  const net = networkOf(q) || { mode: "drive", cost: "time", unit: "minutes", side: null, phrase: "" };
  if (net.side === "beyond") return null;
  let bands = bandsOf(q, net);
  if (bands && bands.length === 1) bands = splitLimit(bands[0]);
  if (!bands) {
    const lim = net.limit === undefined ? null
      : net.cost === "time" ? net.limit / 60 : net.limit / 1609.344;
    bands = lim ? splitLimit(+lim.toFixed(3)) : DEFAULT_BANDS[`${net.mode}:${net.cost}`];
  }
  const { side, phrase, limit, unit, ...spec } = net;
  return { network: spec, bands, phrase, stated: !!bandsOf(q, net) || limit !== undefined };
}

const FEATURE_OPS = ["select_features", "nearest_distance", "count_near", "count_features", "summarize"];

/**
 * Rebuild the plan as service areas around its reference layer.
 *
 * @param isFeature  (attr_id) => whether it is a feature layer
 * @param popAttr    "WORLDPOP_POP" when the population raster is loaded, for people per band
 * @returns a description, or null (plan untouched)
 */
function applyServiceArea(plan, query, { isFeature, popAttr = null }) {
  const sa = serviceAreaOf(query);
  if (!sa) return null;
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // The layer the areas are drawn around: within's second input (the layer
  // measured TO), else the first feature step.
  const w = steps.find(s => s.op === "within" && (s.inputs || []).length === 2);
  let ref = w ? byId.get(w.inputs[1]) : null;
  if (!ref || !ref.attr_id || !isFeature(ref.attr_id)) {
    ref = steps.find(s => s.attr_id && isFeature(s.attr_id) && FEATURE_OPS.includes(s.op));
  }
  if (!ref) return null;
  // Its restrictions, and the plan's place filter as a city on the layer.
  const fp = steps.find(s => s.op === "filter_place" && s.place_name && (s.place_kind || "place") === "place");
  const fa = steps.find(s => s.op === "filter_area" && s.states?.length);
  const src = {
    id: "sa_src", op: "select_features", attr_id: ref.attr_id, inputs: [],
    ...(ref.attribute_filters?.length ? { attribute_filters: ref.attribute_filters } : {}),
    ...(ref.value_filters?.length ? { value_filters: ref.value_filters } : {}),
  };
  const city = ref.city || fp?.place_name;
  const states = ref.states?.length ? ref.states : fp?.states?.length ? fp.states : fa?.states;
  if (city) src.city = city;
  if (states?.length) src.states = states;
  plan.steps = [
    src,
    { id: "sa", op: "service_area", attr_id: "", inputs: ["sa_src"], network: sa.network, bands: sa.bands,
      ...(popAttr ? { population: popAttr } : {}) },
    { id: "out", op: "output", attr_id: "", inputs: ["sa"] },
    { id: "out_src", op: "output", attr_id: "", inputs: ["sa_src"] },
  ];
  plan.output_type = "map";
  delete plan.level;
  const u = sa.network.cost === "time" ? "minutes" : "miles";
  const cell = require("./ops/service_area").cellMeters(sa.network, sa.bands[sa.bands.length - 1]);
  return `service areas of ${ref.attr_id}${city ? ` in ${city}` : ""} in bands of ${sa.bands.join(", ")} ${u}` +
    `${sa.stated ? "" : " (no band was stated, so these are the defaults)"}, by ${describe({ ...sa.network })}; ` +
    `a band is the land within one ${cell} m grid cell of a road reached in that time` +
    `${popAttr ? ", with WorldPop people (1 km cells, by centre) in each" : ""}`;
}

/** The phrase naming the layer the areas surround, for retrieval ("fire stations"). */
function serviceAreaPhrase(query) {
  const q = String(query || "");
  if (!asksServiceArea(q)) return null;
  const m = q.match(/\b(?:around|of|from|for|to|near)\s+(?:the\s+|each\s+|every\s+|all\s+|our\s+|any\s+|an?\s+)?(?:nearest\s+|closest\s+)?((?!(?:the|a|an|each|every)\b)[a-z][a-z-]*(?:\s+(?!(?:in|within|across|by|at|and|or|for|on)\b)[a-z][a-z-]*){0,3}?)(?=\s+(?:in|within|across|by|at|and|or|for|on|during)\b|[?.,;!]|$)/i);
  if (!m) return null;
  const p = m[1].trim().toLowerCase();
  return /^(?:it|them|those|these|there|here|home|minutes?|miles?|travel|drive|walk|driving|walking)$/.test(p) ? null : p;
}

module.exports = { asksServiceArea, serviceAreaOf, bandsOf, splitLimit, applyServiceArea, serviceAreaPhrase };
