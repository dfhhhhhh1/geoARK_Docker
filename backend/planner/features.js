/**
 * The feature algebra's gates, and distance units in code
 * (docs/GIS_OPS_PLAN.md H1).
 *
 * WHEN THE FEATURE OPS ARE OFFERED. `within` and `summarize` let one layer be
 * selected by its distance to another and the result counted, ranked or
 * mapped. They are offered only when the question relates two kinds of thing
 * by distance AND asks about the things themselves rather than a number per
 * unit: "which hospitals are within 2 miles of a fire station", "how many
 * child care centers are more than 5 miles from a hospital". A per-unit
 * question ("in each county", "by census tract") is count_near's and
 * nearest_distance's, and is left exactly as it was. With fewer than two
 * mapped layers among the candidates there is nothing to relate, so the ops
 * cannot be on the menu, which is the same rule count_near has always had.
 *
 * Phrasing-gated like hotspot and correlate, so every prompt for a question
 * that is not asking this is byte-identical (snapshot_prompt.js).
 *
 * UNITS IN CODE. Plans carry `miles`; the question may say km, meters or feet.
 * The model is not asked to convert: `repairDistanceUnits` reads each distance
 * the question states, and when a step's miles equal a number the question
 * gave in another unit (and the question never gave that number in miles), it
 * converts and says so. Same discipline as levels.js reading the unit of
 * analysis: decided from the question's words, never by the model.
 */

const { asksDistance } = require("./levels");

// The answer is one number per unit: count_near / nearest_distance territory.
const PER_UNIT =
  /\b(?:each|every|per|by)\s+(?:[A-Z][a-z]+\s+){0,2}(?:count(?:y|ies)|states?|tracts?|zip(?:\s*codes?)?|census\s+tracts?)\b|\bcensus\s+tracts?\b|\bzip\s*codes\b|\bwhich\s+(?:[A-Z][a-z]+\s+){0,2}count(?:y|ies)\b/i;

// A question ABOUT the features: which / how many / list / the N farthest.
// Without one, "hospitals within 10 miles of transmission lines" stays the
// per-county count it has always been planned as (plan_correctness.yaml
// proximity-count).
const ABOUT_FEATURES =
  /\b(?:which|what|list|show|map|find|locate|identify|how\s+many|number\s+of|count|farthest|furthest|closest|nearest)\b|\bthe\s+\d+\b/i;

// Counties or states are the answer's subject, as in a workflow that ranks
// counties and then asks about distance. Singular "Cook County" is a place.
const ABOUT_UNITS = /\b(?:counties|states)\b/i;

// About people, not places: a catchment (planner/catchment.js), not features.
const ABOUT_PEOPLE =
  /\b(?:people|persons|residents|population|inhabitants|households|live|lives|living)\b/i;

// "more than 5 miles from", "2 km of": a stated distance FROM something, which
// levels.asksDistance (written for unit questions) does not cover.
const STATED_DISTANCE =
  /\b\d+(?:\.\d+)?\s*(?:miles?|mi|km|kilometers?|kilometres?|meters?|metres?|feet|ft|yards?)\s+(?:from|of|away)\b/i;

/** Whether within / summarize are on offer for this question. */
function featureAlgebra(ctx = {}) {
  const q = String(ctx.query || "");
  if (!q || !ctx.hasFeatureTables || !(ctx.featureTableCount >= 2)) return false;
  if (!(asksDistance(q) || STATED_DISTANCE.test(q)) || PER_UNIT.test(q) || ABOUT_PEOPLE.test(q)) return false;
  if (!ABOUT_FEATURES.test(q) || ABOUT_UNITS.test(q)) return false;
  return true;
}

// "how many", "number of", "count": the answer is a count of the features.
const COUNTING = /\b(?:how\s+many|number\s+of|count(?:s|ed)?\b|total\s+number)\b/i;
const asksCount = (query) => COUNTING.test(String(query || ""));

// Negation of a kind: "not critical access", "other than", "except", "excluding".
const NEGATION = /\b(?:not|non|other\s+than|except|excluding|aren't|isn't)\b/i;
const asksNegation = (query) => NEGATION.test(String(query || ""));

// ---------------------------------------------------------------- units

const UNIT_TO_MILES = [
  [/^(?:mi|miles?)$/i, 1],
  [/^(?:km|kms|kilometers?|kilometres?)$/i, 1 / 1.609344],
  [/^(?:m|meters?|metres?)$/i, 1 / 1609.344],
  [/^(?:ft|feet|foot)$/i, 1 / 5280],
  [/^(?:yards?|yds?)$/i, 1 / 1760],
];

const MENTION =
  /(\d+(?:,\d{3})*(?:\.\d+)?)\s*-?\s*(miles?|mi|kilometers?|kilometres?|kms?|meters?|metres?|m|feet|foot|ft|yards?|yds?)\b/gi;

/** Every distance the question states: [{value, unit, miles}]. */
function distanceMentions(query) {
  const out = [];
  for (const m of String(query || "").matchAll(MENTION)) {
    const value = Number(m[1].replace(/,/g, ""));
    const row = UNIT_TO_MILES.find(([re]) => re.test(m[2]));
    if (!row || !Number.isFinite(value)) continue;
    out.push({ value, unit: m[2].toLowerCase(), miles: value * row[1], index: m.index });
  }
  return out;
}

// Steps whose `value` is a distance in miles, so a filter on them is one too.
const DISTANCE_VALUED = new Set(["nearest_distance", "within"]);

/**
 * Convert distances the question gave in km / meters / feet to the miles a
 * plan carries. Returns a description of what changed, or null.
 *
 * Only an exact match converts: a step whose number is one the question stated
 * in another unit, and never stated in miles. Anything else is left alone,
 * because a number that matches nothing the question said is not a unit error
 * this can know how to fix.
 */
function repairDistanceUnits(plan, query) {
  const mentions = distanceMentions(query);
  const foreign = mentions.filter(m => m.miles !== m.value);
  if (!foreign.length) return null;
  const inMiles = new Set(mentions.filter(m => m.miles === m.value).map(m => m.value));
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const distanceInput = (st) => {
    // Through rank / filter_attr chains, down to the op that measured.
    let cur = byId.get((st.inputs || [])[0]);
    for (let i = 0; cur && i < steps.length; i++) {
      if (DISTANCE_VALUED.has(cur.op)) return true;
      if (cur.op !== "rank" && cur.op !== "filter_attr" && cur.op !== "filter_area") return false;
      cur = byId.get((cur.inputs || [])[0]);
    }
    return false;
  };
  const fixes = [];
  const convert = (st, field) => {
    const n = Number(st[field]);
    if (!Number.isFinite(n) || inMiles.has(n)) return;
    const m = foreign.find(f => f.value === n);
    if (!m) return;
    st[field] = Number(m.miles.toPrecision(6));
    fixes.push(`${m.value} ${m.unit} is ${st[field]} miles (step ${st.id})`);
  };
  for (const st of steps) {
    if ((st.op === "count_near" || st.op === "within") && st.miles !== undefined) convert(st, "miles");
    if (st.op === "filter_attr" && st.value !== undefined && distanceInput(st)) convert(st, "value");
  }
  return fixes.length ? fixes.join("; ") : null;
}

// The words right before a stated distance say which side of it is wanted.
// BEYOND is tested first: "not within" ends in "within".
const BEYOND = /(?:more\s+than|farther\s+than|further\s+than|over|beyond|at\s+least|greater\s+than|outside(?:\s+of)?|not\s+within|no\s+closer\s+than)\s+(?:an?\s+)?$/i;
const NEARER = /(?:within|less\s+than|under|inside|no\s+more\s+than|no\s+farther\s+than|up\s+to|closer\s+than)\s+(?:an?\s+)?$/i;

/**
 * Set `within`'s exclude from the question's words. "more than 5 km from the
 * nearest hospital" planned within(miles 3.107) with no exclude, so it counted
 * the centers NEAR a hospital: 1,672 for 568 (2026-11-11). Which side of the
 * distance is wanted is stated in the question, so it is read from there like
 * the unit, and only for a step whose miles match a distance the question
 * gave. Returns a description of what changed, or null.
 */
function repairWithinDirection(plan, query) {
  const q = String(query || "");
  const mentions = distanceMentions(q);
  const fixes = [];
  for (const st of plan.steps || []) {
    // "the 10 farthest from a hospital" with no distance stated: exclude has
    // nothing to be farther than. qwen3 set exclude with no miles, then miles
    // 0, on two repair attempts (2026-11-11). With no distance in the
    // question, the step keeps every feature with its distance, for rank.
    if (st.op === "within" && !mentions.length && (st.exclude === true || Number(st.miles) === 0)) {
      delete st.exclude;
      delete st.miles;
      fixes.push(`step ${st.id} keeps every feature with its distance: the question states no distance`);
      continue;
    }
    if (st.op !== "within" || st.miles === undefined || st.miles === null) continue;
    const n = Number(st.miles);
    const m = mentions.find(x => Math.abs(x.miles - n) <= 1e-3 * Math.max(1, n) || x.value === n);
    if (!m) continue;
    const before = q.slice(Math.max(0, m.index - 30), m.index);
    const want = BEYOND.test(before) ? true : NEARER.test(before) ? false : null;
    if (want === null || (st.exclude === true) === want) continue;
    if (want) st.exclude = true; else delete st.exclude;
    fixes.push(`step ${st.id} keeps features ${want ? "farther than" : "within"} ${m.value} ${m.unit}`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * "Which hospitals in Ohio are within 2 miles of a fire station?" is about
 * Ohio's hospitals and ANY fire station; qwen3 copied states: ["Ohio"] onto
 * the fire stations as well, 1 of 1 on the first run, which drops a station
 * just across the state line. When within's reference layer carries exactly
 * the restriction of the features it is measured from, that restriction is
 * the copy, and it is removed. A different restriction is the question's own
 * ("near a fire station in Kentucky") and is kept.
 */
function widenReferenceLayer(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const fixes = [];
  const key = (st) => JSON.stringify([...(st.states || [])].sort()) + "|" + (st.city || "");
  for (const st of steps) {
    if (st.op !== "within") continue;
    const [a, b] = (st.inputs || []).map(i => byId.get(i));
    if (a?.op !== "select_features" || b?.op !== "select_features") continue;
    if (!(b.states?.length || b.city) || key(a) !== key(b)) continue;
    // Only when nothing else reads the reference layer with that restriction.
    if (steps.some(o => o !== st && (o.inputs || []).includes(b.id))) continue;
    delete b.states;
    delete b.city;
    fixes.push(`step ${b.id} measures to every feature, not only those in the same area as step ${a.id}`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * The thing a distance is measured TO: "farthest from a hospital", "within 2
 * miles of a fire station", "have a hospital within 1 mile". Retrieval has to
 * find that layer, and the decomposer does not reliably ask for it: "List the
 * 10 nursing homes in Montana that are farthest from a hospital" decomposed
 * once into a "distance to hospital" sub-query (Hospitals retrieved) and once
 * without one (no Hospitals among the candidates, refused), same build
 * (2026-11-11). Returned only for a question the feature ops or the catchment
 * rule apply to, so no other question's retrieval changes.
 */
const REFERENCE = [
  // The LAST "from / of / to <thing>": "have to drive to a hospital" is the
  // hospital, not "drive to a hospital".
  /\b(?:from|of|to)\s+(?:the\s+)?(?:nearest\s+|closest\s+)?(?:an?\s+|any\s+|the\s+)?((?:(?!(?:from|of|to)\b)[a-z][a-z-]*)(?:\s+(?!(?:from|of|to)\b)[a-z][a-z-]*){0,3}?)(?=\s+(?:in|within|that|and|or|for|by|across|near)\b|[?.,;!]|$)/gi,
  /\bhave\s+(?:an?\s+|any\s+)([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}?)\s+within\b/gi,
];
const NOT_A_LAYER = /^(?:it|them|those|these|there|here|home|each|every|miles?|kilometers?|their|its)$/i;

// "access to hospitals once you account for ..." (ops/access.js): the supply
// layer. Same nondeterminism: one decomposition of the 2SFCA question
// retrieved Hospitals and the next none, wells and ethanol plants instead.
const ACCESS_TO =
  /\baccess(?:ibility)?\s+to\s+(?:the\s+)?([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,2}?)(?=\s+(?:once|when|if|in|for|after|given|accounting|account|that|and|or|by|within|using|across)\b|[?.,;!]|$)/i;

function referencePhrase(query, { featureTables = true } = {}) {
  const q = String(query || "");
  const acc = require("./ops/access").asksAccess(q) ? q.match(ACCESS_TO) : null;
  if (acc && !NOT_A_LAYER.test(acc[1])) return acc[1].trim().toLowerCase();
  const relevant = featureAlgebra({ query: q, hasFeatureTables: featureTables, featureTableCount: 2 }) ||
    (ABOUT_PEOPLE.test(q) && (asksDistance(q) || STATED_DISTANCE.test(q)));
  if (!relevant) return null;
  for (const re of REFERENCE) {
    const hits = [...q.matchAll(re)].map(m => m[1].trim()).filter(p => !NOT_A_LAYER.test(p));
    if (hits.length) return hits[hits.length - 1].toLowerCase();
  }
  return null;
}

/**
 * Per square kilometre or per square mile, from the question's words, set on
 * every per_area step (GIS_OPS_PLAN.md section 3, "units in code"). The model
 * never sees `area_unit`: the prompt and decoding schema are unchanged, and
 * per_area's default stays square miles, so every existing plan compiles as
 * before. "people per square kilometer" planned per square mile would be
 * wrong by 2.59x with nothing visibly wrong.
 */
const PER_KM2 = /\b(?:per|a|each|every)\s+(?:square\s+kilomet(?:er|re)s?|sq\.?\s*km|km\s*(?:\^?2|²)|km2)(?![A-Za-z])|\/\s*km(?:\s*\^?2|²)?(?![A-Za-z])|\bkm\s*(?:\^2|²)|\bkm2\b/i;
function applyAreaUnit(plan, query) {
  if (!PER_KM2.test(String(query || ""))) return null;
  const steps = (plan.steps || []).filter(s => s.op === "per_area" && s.area_unit !== "km2");
  for (const st of steps) st.area_unit = "km2";
  return steps.length ? "per square kilometre of land, as the question asks" : null;
}

// ---------------------------------------------------------------- overlay (H3)

/**
 * OVERLAY: one layer tested against where another layer IS, with no distance.
 * "fire stations inside a wildfire perimeter", "roads that cross wetlands",
 * "campuses that overlap a wetland". General on purpose: no layer, class or
 * hazard is named here; a flood zone is one more polygon layer, and which of
 * its polygons count is the layer's own `type` values (attribute_filters) or a
 * cited definition, never a word list in code.
 *
 * Offered only with two mapped layers and at least one polygon among them
 * (the thing tested against must have an inside), so a question with points
 * alone never sees it, and every existing prompt is unchanged.
 */
const OVERLAY =
  /\b(?:inside|intersect(?:s|ing|ed)?|cross(?:es|ing|ed)?|overlap(?:s|ping|ped)?|(?:pass(?:es)?|runs?|go(?:es)?|cuts?)\s+through|lies?\s+(?:in|within|inside)|located\s+(?:in|within|inside)|falls?\s+(?:in|within|inside)|sits?\s+(?:in|within|inside)|contained\s+in)\b|\bwithin\s+(?:an?|any|the)\s+(?![\d.])(?!(?:state|county|city|region|area|united)\b)[a-z]/i;

// An AMOUNT of a line or area layer: "how many acres", "miles of road",
// "total area". A number in front ("10 miles of") is a distance, not an amount.
// "per square mile" is a density (per_area), not an amount: an area unit after
// per / a / each is excluded (the eval scan caught all four H2 density
// questions reading as amounts, 2026-11-12).
const AMOUNT =
  /(?<!\b(?:per|a|an|each|every)\s+)\b(?:acres?|acreage|hectares?|square\s+(?:miles?|kilomet(?:er|re)s?|met(?:er|re)s?|feet)|sq\.?\s*(?:mi|km|m|ft)\b|km2|mi2)|\b(?:total\s+(?:area|length|extent)|(?:area|length|extent)\s+of|how\s+much\s+(?:land|area))\b|(?<![\d.]\s*)\b(?:miles?|kilomet(?:er|re)s?|km)\s+of\b/i;

const hasExtentLayer = (ctx) => ctx.hasPolygonLayer === true || ctx.hasLineLayer === true;

/** Whether `overlay` (and the select_features / summarize it needs) is on offer. */
function overlayAlgebra(ctx = {}) {
  const q = String(ctx.query || "");
  if (!q || !ctx.hasFeatureTables || !(ctx.featureTableCount >= 2) || ctx.hasPolygonLayer !== true) return false;
  // Counties or states as the answer ("which counties does ZIP 65721 fall
  // in") are units, not features: filter_place and the crosswalk's.
  if (ABOUT_PEOPLE.test(q) || asksDistanceOnly(q) || ABOUT_UNITS.test(q)) return false;
  return OVERLAY.test(q);
}

/** Whether summarize may total the length or area of a line / polygon layer. */
function measureAlgebra(ctx = {}) {
  const q = String(ctx.query || "");
  if (!q || !ctx.hasFeatureTables || !hasExtentLayer(ctx)) return false;
  if (ABOUT_PEOPLE.test(q)) return false;
  return AMOUNT.test(q);
}

// "within 2 miles of" is within's, not overlay's; overlay is the no-distance case.
const asksDistanceOnly = (q) => STATED_DISTANCE.test(q) || /\bwithin\s+[\d.]/i.test(q);

// Units of an amount, from the question's words. Factors convert square
// metres (ST_Area on geography) or metres (ST_Length) to the unit.
const AREA_UNITS = [
  [/\bacres?\b|\bacreage\b/i, "acres", 4046.8564224],
  [/\bhectares?\b/i, "hectares", 10000],
  [/\bsquare\s+kilomet(?:er|re)s?\b|\bsq\.?\s*km\b|\bkm2\b|\bkm\s*(?:\^2|²)/i, "square kilometers", 1e6],
  [/\bsquare\s+met(?:er|re)s?\b|\bsq\.?\s*m\b|\bm2\b/i, "square meters", 1],
  [/\bsquare\s+feet\b|\bsq\.?\s*ft\b/i, "square feet", 0.09290304],
  [/\bsquare\s+miles?\b|\bsq\.?\s*mi\b|\bmi2\b/i, "square miles", 2589988.110336],
];
const LENGTH_UNITS = [
  [/(?<![\d.]\s*)\b(?:kilomet(?:er|re)s?|km)\b/i, "kilometers", 1000],
  [/(?<![\d.]\s*)\b(?:feet|ft)\b/i, "feet", 0.3048],
  [/(?<![\d.]\s*)\bmiles?\b/i, "miles", 1609.344],
];
const DEFAULT_UNIT = { area: ["square miles", 2589988.110336], length: ["miles", 1609.344] };

/** {measure, unit, per_m} for a line or polygon layer, from the question. */
function measureFor(rep, query) {
  const kind = /POLYGON/i.test(rep || "") ? "area" : /LINE/i.test(rep || "") ? "length" : null;
  if (!kind) return null;
  const table = kind === "area" ? AREA_UNITS : LENGTH_UNITS;
  const hit = table.find(([re]) => re.test(String(query || "")));
  const [unit, per] = hit ? [hit[1], hit[2]] : DEFAULT_UNIT[kind];
  return { measure: kind, unit, per_m: per };
}

/**
 * Set summarize's measure and overlay's value unit from the question and the
 * layer's geometry, in code (GIS_OPS_PLAN.md section 3, "units in code"). The
 * model plans `summarize`; whether that is a count, a length or an area, and
 * in which unit, is not its call. "How many acres of wetland" counted
 * polygons would be a plausible, wrong number.
 *
 * `repOf(attr_id)` gives a layer's spatial_rep (POINT / LINE / POLYGON).
 * Returns a description of what was set, or null.
 */
function applyMeasures(plan, query, repOf) {
  const q = String(query || "");
  const fixes = [];
  // "How many acres of wetlands are in each St. Louis ward?" planned
  // count_features over the wetland polygons (H3 dev r2): the H2 habit for
  // "how many X in each ward", and a count of polygons is not an area. When
  // the question asks for an amount and the layer has a length or an area,
  // the count becomes select_features -> summarize, which is measured below.
  if (AMOUNT.test(q)) {
    const out = [];
    for (const st of plan.steps || []) {
      if (st.op === "count_features" && measureFor(repOf(st.attr_id), q)) {
        const src = { id: `${st.id}f`, op: "select_features", attr_id: st.attr_id, inputs: [] };
        if (st.attribute_filters?.length) src.attribute_filters = st.attribute_filters;
        out.push(src, { id: st.id, op: "summarize", attr_id: "", inputs: [src.id],
                        ...(st.group_by ? { group_by: st.group_by } : {}) });
        fixes.push(`step ${st.id} measures ${st.attr_id} instead of counting its features`);
      } else out.push(st);
    }
    plan.steps = out;
  }
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // Down input 1 to the select_features the features came from, noting overlays.
  const sourceOf = (st) => {
    const via = [];
    let cur = byId.get((st.inputs || [])[0]);
    for (let i = 0; cur && i < steps.length; i++) {
      if (cur.op === "select_features") return { src: cur, via };
      if (!["overlay", "within", "rank", "filter_attr"].includes(cur.op)) return null;
      if (cur.op === "overlay") via.push(cur);
      cur = byId.get((cur.inputs || [])[0]);
    }
    return null;
  };
  for (const st of steps) {
    if (st.op === "summarize") {
      const s = sourceOf(st);
      const m = s && AMOUNT.test(q) ? measureFor(repOf(s.src.attr_id), q) : null;
      if (!m) { delete st.measure; delete st.unit; continue; }
      st.measure = m.measure;
      st.unit = m.unit;
      // The amount INSIDE the other layer: the overlay must hand on the
      // clipped part, not the whole feature.
      for (const o of s.via) o.clip = true;
      fixes.push(`step ${st.id} totals ${m.measure} in ${m.unit}`);
    }
  }
  for (const st of steps) {
    if (st.op !== "overlay") continue;
    const src = byId.get((st.inputs || [])[0]);
    const rep = src?.op === "select_features" ? repOf(src.attr_id) : null;
    const m = measureFor(rep, q);
    if (m && st.unit !== m.unit) {
      st.unit = m.unit;
      fixes.push(`step ${st.id} measures the part inside in ${m.unit}`);
    }
  }
  markGeometryOnly(plan);
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * A select_features whose rows are only ever read as GEOMETRY may come from a
 * layer's subdivided parts (etl/ingest.py build_parts): the layer an overlay
 * tests against (only its union matters), and the features an amount is
 * totalled over (parts tile each polygon, so the sum is the same). Anything
 * that lists, counts or ranks the features reads the original rows. Set in
 * code, never by the model; a layer without parts ignores it.
 */
function markGeometryOnly(plan) {
  const steps = plan.steps || [];
  const readers = (id) => steps.filter(s => (s.inputs || []).includes(id));
  const measuredSum = (s) => s.op === "summarize" && (s.measure === "area" || s.measure === "length");
  for (const st of steps) {
    if (st.op !== "select_features") continue;
    const rs = readers(st.id);
    const ok = rs.length > 0 && rs.every(r =>
      (r.op === "overlay" && r.inputs[1] === st.id && r.inputs[0] !== st.id) ||
      measuredSum(r) ||
      (r.op === "overlay" && r.inputs[0] === st.id && r.clip === true &&
       readers(r.id).length > 0 && readers(r.id).every(measuredSum)));
    if (ok) st.geometry_only = true; else delete st.geometry_only;
  }
}

// ---------------------------------------------------------------- rasters (H4)

// "what percentage / share / proportion of": a share. A number before
// "percent" is a threshold ("slope under 5 percent"), not a share.
const SHARE = /\b(?:percentage|share|proportion|fraction)\b|(?<![\d.]\s*)\bpercent\b|%\s+of\b/i;

/**
 * What a zonal step reports, and in which unit, from the question (units in
 * code, as for summarize): an AMOUNT ("how many acres", "square kilometers")
 * is an area in that unit; a SHARE ("what percent of each county") is a
 * percent of the unit's pixels; otherwise classes or a threshold give an
 * area (square miles unless the question says), and a continuous raster its
 * mean (or sum, by the layer's own aggregate). Never the model's choice: it
 * plans zonal, code decides what the number is. Returns a description.
 */
function applyRasterMeasures(plan, query, srcOf) {
  const q = String(query || "");
  const fixes = [];
  for (const st of plan.steps || []) {
    if (st.op !== "zonal") continue;
    const src = srcOf(st.attr_id) || {};
    const selects = (st.attribute_filters?.length > 0) || st.operator !== undefined;
    let stat;
    if (selects && AMOUNT.test(q)) stat = "area";
    else if (selects && SHARE.test(q)) stat = "share";
    else if (selects) stat = "area";
    else stat = src.aggregate === "sum" ? "sum" : "mean";
    st.stat = stat;
    if (stat === "area") {
      const m = measureFor("POLYGON", q);
      st.unit = m.unit;
      st.unit_per_m2 = m.per_m;
    } else {
      delete st.unit; delete st.unit_per_m2;
    }
    fixes.push(`step ${st.id} reports ${stat === "area" ? `area in ${st.unit}` : stat === "share" ? "the percent of each unit" : `the ${stat}`}`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * A categorical zonal step the model left without classes gets the ones the
 * question names, matched against the raster's own legend (data, not a word
 * list). qwen3 (reasoning off) emitted zonal with no attribute_filters on
 * every attempt for "acres of cultivated cropland" and "developed land", with
 * the validator listing the classes each time (H4 dev, 2026-11-12).
 *
 * A group wins when all its words occur ("developed land" -> Developed,
 * "forest" -> Forest); otherwise every label all of whose words occur, by
 * stem ("cultivated cropland" -> Cultivated Crops). Nothing matched, nothing
 * added: the validator's refusal stands. Returns a description, or null.
 */
/**
 * A zonal "= Y" where Y is a year the raster has is that YEAR, not a pixel
 * threshold: with the year field withheld (no time phrase), qwen3 put the
 * DEM's year on the step as operator/value and on filter_attr steps (H4 dev).
 * A year step in front of zonal that names a loaded vintage is folded the
 * same way. Returns a description, or null.
 */
function yearAsVintage(plan, srcOf) {
  const steps = plan.steps || [];
  const fixes = [];
  for (const st of steps) {
    if (st.op !== "zonal") continue;
    const years = new Set(((srcOf(st.attr_id) || {}).layers || []).map(l => Number(l.year)));
    if (st.operator === "=" && years.has(Number(st.value))) {
      st.year = Number(st.value);
      delete st.operator; delete st.value;
      fixes.push(`step ${st.id} reads the ${st.year} raster (a year, not a pixel value)`);
    }
    // filter_attr(= a loaded year) reading this zonal step: a year, dropped.
    for (const f of steps.filter(o => o.op === "filter_attr" && (o.inputs || [])[0] === st.id &&
                                     o.operator === "=" && years.has(Number(o.value)))) {
      if (years.size > 1) st.year = Number(f.value);
      for (const o of steps) o.inputs = (o.inputs || []).map(i => (i === f.id ? st.id : i));
      plan.steps = plan.steps.filter(x => x !== f);
      fixes.push(`step ${f.id} was the raster's year ${f.value}, not a filter`);
    }
  }
  return fixes.length ? fixes.join("; ") : null;
}

function fillRasterClasses(plan, query, srcOf) {
  const words = new Set(String(query || "").toLowerCase().match(/[a-z]+/g) || []);
  const stem = (w) => w.replace(/(?:ies|es|s)$/, "");
  const has = (w) => words.has(w) || [...words].some(q => q.startsWith(stem(w)) && stem(w).length > 3);
  const allIn = (text) => {
    const ws = String(text).toLowerCase().match(/[a-z]+/g) || [];
    return ws.length > 0 && ws.every(has);
  };
  const fixes = [];
  for (const st of plan.steps || []) {
    if (st.op !== "zonal" || st.attribute_filters?.length || st.operator !== undefined) continue;
    const src = srcOf(st.attr_id);
    if (src?.raster_kind !== "categorical") continue;
    const groups = [...new Set((src.classes || []).map(c => c.grp).filter(Boolean))].filter(allIn);
    const picked = groups.length ? groups
      : (src.classes || []).map(c => c.label).filter(allIn);
    if (!picked.length) continue;
    st.attribute_filters = picked.map(v => ({ column: "type", value: v }));
    fixes.push(`step ${st.id} reads classes ${picked.map(v => `"${v}"`).join(", ")} named in the question`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

const UNIT_PER_M = Object.fromEntries([...AREA_UNITS, ...LENGTH_UNITS].map(([, u, f]) => [u, f]));

module.exports = {
  overlayAlgebra, measureAlgebra, applyMeasures, measureFor, UNIT_PER_M, AMOUNT, OVERLAY,
  applyRasterMeasures, SHARE, fillRasterClasses, yearAsVintage,
  applyAreaUnit, PER_KM2,
  referencePhrase,
  widenReferenceLayer, repairWithinDirection,
  featureAlgebra, asksCount, asksNegation, distanceMentions, repairDistanceUnits,
  PER_UNIT, ABOUT_PEOPLE,
};
