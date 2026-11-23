/**
 * Routes: "the fastest driving route from each fire station in St. Louis to
 * the nearest hospital", "directions from Barnes-Jewish Hospital to every
 * fire station in St. Louis", "shortest walking route between the Central
 * Library and the nearest school" (docs/GIS_OPS_PLAN.md H5; ops/route.js).
 *
 * The model never sees route. It plans the layers (select_features twice,
 * within, nearest_distance ...); code reads which side of "from X to Y" is
 * which, and rebuilds:
 *
 *   select_features(origins) --\
 *                               route -> output   (the lines, both ends on
 *   select_features(dests) ----/                   each row: `endpoints`)
 *
 * A side is a LAYER ("each fire station", "the nearest hospital") or a NAMED
 * feature of one ("Barnes-Jewish Hospital"): the layer is the plan's feature
 * step whose name shares a word with the phrase, and a name is matched
 * against that layer's own `name` column (select_features `name_like`, set
 * here, never by the model). "nearest" on the destination side -> each origin
 * to its nearest destination; a named origin and an unqualified layer ->
 * from it to every one. Anything unreadable -> null, plan untouched.
 */

const { networkOf, describe } = require("./network");

const ROUTE_WORDS = /\b(?:routes?|routing|directions|shortest\s+(?:path|way|drive|trip)|fastest\s+(?:way|path|drive|trip)|quickest\s+(?:way|path|route|drive)|best\s+way\s+to\s+(?:get|drive|walk)|how\s+(?:do|would|can|could|should)\s+(?:i|you|we|one)\s+(?:get|drive|walk))\b/i;
// Route words that name a LAYER, not a path: "bus routes in Chicago".
const ROUTE_LAYER = /\b(?:bus|transit|rail|train|bike|bicycle|trail|truck|evacuation|school\s+bus|snow|ferry|shipping|flight)\s+routes?\b/i;

const END = String.raw`(?=\s+(?:in|within|across|by|using|avoiding|during|for|on|at|via|under|and\s+(?:show|map|list|give|tell))\b|[?.,;!]|$)`;
const FROM_TO = new RegExp(String.raw`\bfrom\s+(.+?)\s+to\s+(.+?)${END}`, "i");
const TO_FROM = new RegExp(String.raw`\bto\s+(.+?)\s+from\s+(.+?)${END}`, "i");
const BETWEEN = new RegExp(String.raw`\bbetween\s+(.+?)\s+and\s+(.+?)${END}`, "i");

const NEAREST = /^(?:the\s+|its\s+|their\s+)?(?:nearest|closest)\s+/i;
const EVERY = /^(?:each|every|all(?:\s+the|\s+of\s+the)?|any)\s+/i;
const ARTICLE = /^(?:the|a|an|our|my)\s+/i;
const STOP = new Set("the a an of in at on to from for and or nearest closest each every all any its their our my".split(" "));

const stem = (w) => w.toLowerCase().replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
const words = (s) => String(s || "").toLowerCase().match(/[a-z][a-z'-]+|\d+/g) || [];
const content = (s) => words(s).filter(w => !STOP.has(w));

function asksRoute(query) {
  const q = String(query || "");
  if (!ROUTE_WORDS.test(q) || ROUTE_LAYER.test(q)) return false;
  return FROM_TO.test(q) || TO_FROM.test(q) || BETWEEN.test(q);
}

/**
 * The place the question names, as a city and a state: "in St. Louis,
 * Missouri" -> {city: "St. Louis", states: ["Missouri"]}, "in Chicago" ->
 * {city: "Chicago"}. Only a capitalised name after "in", ended by a comma,
 * the state, or the end of the clause; a state alone is a state. The plan's
 * own restrictions win; this is the fallback for a plan whose ops never
 * carried one (select_features was not on offer, 2026-11-23).
 */
const IN_PLACE = /\bin\s+((?:[A-Z][A-Za-z.'-]*\s?){1,4}?)(?:,\s*([A-Z][A-Za-z ]+?))?(?=\s*(?:[?.!;]|$|\s+(?:and|to|from|by|using|with|during|for)\b))/;
function placeIn(query) {
  const m = String(query || "").match(IN_PLACE);
  if (!m) return null;
  const { toFipsPrefixes } = require("../states");
  const name = m[1].trim(), st = (m[2] || "").trim();
  const isState = (x) => x && toFipsPrefixes([x]).unknown.length === 0;
  if (!st && isState(name)) return { states: [name] };
  return { city: name, ...(isState(st) ? { states: [st] } : {}) };
}

/** {origin, destination} phrases, raw, or null. A place after a side ("each
 * fire station in St. Louis") is the plan's restriction, not the side. */
const PLACE_TAIL = /\s+(?:in|within|across|around|near|inside)\s+.*$/i;
function sidesOf(query) {
  const q = String(query || "");
  const pair = (o, d) => ({ origin: o.replace(PLACE_TAIL, ""), destination: d.replace(PLACE_TAIL, ""),
                            place: placeIn(q) });
  let m = q.match(FROM_TO);
  if (m) return pair(m[1], m[2]);
  m = q.match(TO_FROM);
  if (m) return pair(m[2], m[1]);
  m = q.match(BETWEEN);
  if (m) return pair(m[1], m[2]);
  return null;
}

/**
 * What a side phrase is: nearest / every / a name.
 * A NAME is a phrase with a capitalised word that is not its first word of a
 * sentence and not a layer word ("Barnes-Jewish Hospital", "Engine House 4"),
 * or one with a number ("Station 4"). "fire stations in St. Louis" is cut at
 * "in" by END, so the place never reads as a name.
 */
function readSide(raw) {
  let s = String(raw || "").trim().replace(/^["'“]|["'”]$/g, "");
  const nearest = NEAREST.test(s);
  s = s.replace(NEAREST, "");
  const every = EVERY.test(s);
  s = s.replace(EVERY, "").replace(ARTICLE, "").trim();
  const caps = (s.match(/\b[A-Z][A-Za-z'-]*/g) || []).length;
  const named = !nearest && !every && (/\d/.test(s) || caps >= 1);
  return { phrase: s, nearest, every, named };
}

// Words a layer name ends with that say nothing about what it holds:
// "Public School Locations" is schools.
const GENERIC = new Set(["location", "site", "facility", "point", "data", "dataset", "layer", "feature",
  "place", "us", "usa", "nce", "hsip", "inventory", "list", "map", "boundary", "area"]);

/**
 * The plan's feature step (or candidate) a side phrase names. The phrase's
 * HEAD noun (its last word) must be a word of the layer's name, and must not
 * be a modifier there: the word after it in the name, unless generic, must be
 * in the phrase too. "reported structural fires" is not "Fire Stations"
 * (fire modifies station), which a shared word alone would have matched and
 * answered with routes to fire stations (2026-11-23, eval reach scan).
 */
function layerFor(phrase, layers) {
  const pw = content(phrase).filter(w => /^[a-z]/.test(w)).map(stem);
  const head = pw[pw.length - 1];
  if (!head) return null;
  const want = new Set(pw);
  let best = null, score = 0;
  for (const l of layers) {
    const lw = content(l.label).filter(w => /^[a-z]/.test(w)).map(stem);
    const at = lw.lastIndexOf(head);
    if (at < 0) continue;
    const next = lw.slice(at + 1).find(w => !GENERIC.has(w));
    if (next && !want.has(next)) continue;
    const s = lw.filter(w => want.has(w)).length;
    if (s > score) { best = l; score = s; }
  }
  return best;
}

/**
 * Rebuild the plan as routes. `layers` are the feature layers the planner
 * was shown: [{attr_id, label}], label = dataset name + description.
 */
function applyRoute(plan, query, { isFeature, layers }) {
  const q = String(query || "");
  if (!asksRoute(q)) return null;
  const sides = sidesOf(q);
  if (!sides) return null;
  const o = readSide(sides.origin), d = readSide(sides.destination);
  const steps = plan.steps || [];
  // The plan's feature steps first (the layers the model chose), then the
  // other feature candidates it was shown.
  const own = steps.filter(s => s.attr_id && isFeature(s.attr_id))
    .map(s => ({ ...(layers.find(l => l.attr_id === s.attr_id) || { attr_id: s.attr_id, label: s.attr_id }), step: s }));
  const pool = [...own, ...layers.filter(l => isFeature(l.attr_id) && !own.some(x => x.attr_id === l.attr_id))];
  const lo = layerFor(o.phrase, pool), ld = layerFor(d.phrase, pool);
  if (!lo || !ld) return null;
  if (o.named && d.named && lo.attr_id === ld.attr_id && o.phrase === d.phrase) return null;

  const net0 = networkOf(q) || { mode: "drive", cost: "time" };
  // "shortest" with no time word is still asked by time: that is what a
  // routing engine means by it, and a drive is timed. "shortest distance"
  // or "road miles" read as length (network.js).
  const { side, phrase, limit, unit, ...net } = net0;
  if (!/\b(?:distance|miles?|km|kilomet|length)\b/i.test(q) && net.mode === "drive") net.cost = "time";

  const restrict = (side, layer) => {
    const st = {
      op: "select_features", attr_id: layer.attr_id, inputs: [],
      ...(layer.step?.attribute_filters?.length ? { attribute_filters: layer.step.attribute_filters } : {}),
    };
    if (side.named) {
      // Matched by its own name; the layer noun in the phrase is not part of
      // it ("Barnes-Jewish Hospital" -> names containing "Barnes-Jewish
      // Hospital", case-insensitive, or failing that every word of it).
      st.name_like = side.phrase;
      st.pick_one = true;
    }
    return st;
  };
  const src = { id: "rt_o", ...restrict(o, lo) };
  const dst = { id: "rt_d", ...restrict(d, ld) };
  // The place restriction belongs to the origins ("each fire station in St.
  // Louis"); destinations stay as wide as the loaded region, so the nearest
  // hospital across the city line still counts (features.widenReferenceLayer).
  // With a NAMED origin the place restricts the layer side instead: "from
  // Barnes-Jewish Hospital to every fire station in St. Louis" (243 stations
  // in the region without it, 2026-11-23).
  const fp = steps.find(s => s.op === "filter_place" && s.place_name && (s.place_kind || "place") === "place");
  const layerSide = !o.named ? { st: src, l: lo } : !d.named ? { st: dst, l: ld } : null;
  const city = layerSide && (layerSide.l.step?.city || fp?.place_name || lo.step?.city || ld.step?.city ||
    sides.place?.city);
  const states = layerSide && ([layerSide.l.step?.states, fp?.states, lo.step?.states, ld.step?.states,
    sides.place?.states].find(x => x?.length));
  if (layerSide) {
    if (city) layerSide.st.city = city;
    if (states?.length) layerSide.st.states = states;
    if (layerSide.l.step?.value_filters?.length) layerSide.st.value_filters = layerSide.l.step.value_filters;
  }
  // A named feature keeps the state the plan gave its layer, so "Engine
  // House 4" in a Missouri question is not one in Illinois.
  for (const [side, st, l] of [[o, src, lo], [d, dst, ld]]) {
    if (side.named && l.step?.states?.length && !st.states) st.states = l.step.states;
  }

  // Which routes: one named origin and an unqualified layer -> to every one
  // of it ("from Station 4 to all hospitals", "... to the fire stations");
  // otherwise each origin to its nearest destination.
  const to = o.named && !d.named && !d.nearest ? "each" : "nearest";
  plan.steps = [
    src, dst,
    { id: "rt", op: "route", attr_id: "", inputs: ["rt_o", "rt_d"], network: net, to },
    { id: "out", op: "output", attr_id: "", inputs: ["rt"] },
  ];
  plan.output_type = "map";
  delete plan.level;
  const who = (s, l) => (s.named ? `"${s.phrase}" (${l.attr_id}, matched by name)` : `${l.attr_id}`);
  return `routes from ${who(o, lo)}${!o.named && city ? ` in ${city}` : ""} to ` +
    `${to === "each" ? "every feature of " : "the nearest feature of "}${who(d, ld)}` +
    `${o.named && !d.named && city ? ` in ${city}` : ""}, ` +
    `minimising ${describe({ ...net })}; the short legs from each point to its nearest road vertex are not included`;
}

/** The phrases naming the two layers, for retrieval. */
function routePhrases(query) {
  if (!asksRoute(query)) return [];
  const s = sidesOf(query);
  if (!s) return [];
  return [readSide(s.origin), readSide(s.destination)]
    .map(x => x.phrase.toLowerCase()).filter(p => p && content(p).length);
}

module.exports = { asksRoute, sidesOf, readSide, applyRoute, routePhrases, layerFor };
