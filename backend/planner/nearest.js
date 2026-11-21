/**
 * Nearest with identity, and k (docs/GIS_OPS_PLAN.md H6 tier 1, item 3).
 *
 * `nearest_distance` answered "how far" and nothing else: it never said WHICH
 * feature is nearest, and k was always 1. Two field variants, both set here in
 * code from the question's wording, never by the model (the prompt and the
 * decoding schema are untouched, so the 48-context snapshot is byte-identical):
 *
 *   identify: true   "which hospital is nearest to each county", "what is the
 *                    closest airport to each tract", "... and which one is it":
 *                    each unit also carries the nearest feature's name
 *                    (`nearest_name`, with city and state where the layer has
 *                    them, so two "Mercy Hospital"s can be told apart).
 *   k: N, k_stat     "the average distance to the 3 nearest hospitals" (mean),
 *                    "how far is the second-nearest hospital" (kth): the value
 *                    is the mean, or the k-th, of the k nearest geodesic
 *                    distances, and the k names travel, nearest first.
 *
 * k needs the question to be per unit ("each county", "census tracts",
 * "per ZIP code"): "the 5 closest hospitals to Kansas City" names a point, not
 * a unit, and a per-county mean of five distances would answer a different
 * question. That case is left alone and noted.
 */

const { levelOf } = require("./levels");

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const WORD_ORD = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const NUM = `(\\d{1,2}|${Object.keys(WORD_NUM).join("|")})`;
const ORD = `(\\d{1,2}(?:st|nd|rd|th)|${Object.keys(WORD_ORD).join("|")})`;
const NEAR = `(?:nearest|closest)`;

/** Largest k accepted. The names column lists all k, so it stays readable. */
const MAX_K = 25;

// Nouns that make the question about the UNITS, not the features: "the 10
// closest counties", "which tracts are nearest".
const UNIT_NOUN = /^(?:count(?:y|ies)|parish(?:es)?|boroughs?|states?|tracts?|block|groups?|zips?|zip-codes?|codes?|zctas?|areas?|places?|cities|towns?|cells?|wards?|districts?|neighbou?rhoods?|regions?|units?|ones?|people|residents?|households?|miles?|kilometers?|km|minutes?)$/i;

const K_MEAN = new RegExp(`\\b${NUM}\\s+${NEAR}\\s+([a-z][a-z-]*)`, "i");
const K_ORD = new RegExp(`\\b${ORD}[\\s-]+${NEAR}\\b(?:\\s+([a-z][a-z-]*))?`, "i");

const IDENT = [
  // "what is the nearest hospital", "what's the closest airport", "which are
  // the 3 nearest hospitals"
  new RegExp(`\\b(?:which|what)(?:'s|\\s+is|\\s+are|\\s+was|\\s+were)?\\s+(?:the\\s+)?(?:${NUM}\\s+|${ORD}[\\s-]+)?${NEAR}\\s+([a-z][a-z-]*)`, "i"),
  // "which hospital is nearest to each county", "which fire station is
  // nearest": up to three words of layer name, the last one judged.
  new RegExp(`\\b(?:which|what)\\s+(?:[a-z][a-z-]*\\s+){0,2}([a-z][a-z-]*)\\s+(?:is|are|was|lies|sits)\\s+(?:the\\s+)?${NEAR}\\b`, "i"),
  // "the name of the nearest hospital", "name its closest airport"
  new RegExp(`\\bnames?\\s+of\\s+(?:the|its|their|each(?:\\s+\\w+'s)?)\\s+(?:${NUM}\\s+)?${NEAR}\\b`, "i"),
  new RegExp(`\\b(?:name|identify)\\s+(?:the|its|their)\\s+(?:${NUM}\\s+)?${NEAR}\\b`, "i"),
  // "list the nearest hospital to each county"
  new RegExp(`\\b(?:show|list|map|find|give|get)\\s+(?:me\\s+)?(?:the\\s+)?(?:${NUM}\\s+)?${NEAR}\\s+[a-z][a-z-]*\\s+(?:to|for|from)\\s+(?:each|every)\\b`, "i"),
  // "..., and which one is it", "and its name"
  /\band\s+(?:which|what)\s+(?:one|ones|it\s+is|they\s+are)\b/i,
  /\b(?:its|their)\s+names?\b/i,
];

const PER_UNIT = /\b(?:each|every|per)\b|\bcount(?:y|ies)\b|\bparish(?:es)?\b/i;

const num = (s) => {
  const w = String(s || "").toLowerCase();
  return WORD_NUM[w] ?? WORD_ORD[w] ?? (Number.parseInt(w, 10) || null);
};

/** Does a capture name the features (true) or the units (false)? */
const aboutFeatures = (noun) => !noun || !UNIT_NOUN.test(noun);

/**
 * What the question asks of the nearest feature: { identify, k, k_stat } or
 * null when it asks only for a distance.
 */
function nearestAsk(query) {
  const q = String(query || "");
  let k = null, stat = null;
  const ord = q.match(K_ORD);
  if (ord && aboutFeatures(ord[2])) { k = num(ord[1]); stat = "kth"; }
  if (!k) {
    const m = q.match(K_MEAN);
    if (m && aboutFeatures(m[2])) { k = num(m[1]); stat = "mean"; }
  }
  if (k !== null && !(k >= 1 && k <= MAX_K)) k = null;
  if (k === 1) { k = null; stat = null; }
  const perUnit = PER_UNIT.test(q) || !!levelOf(q);
  const identify = IDENT.some(re => {
    const m = q.match(re);
    if (!m) return false;
    // The last capture is the noun after the pattern, where there is one.
    const noun = [...m].slice(1).reverse().find(x => x && !/^\d|^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i.test(x));
    return aboutFeatures(noun);
  });
  const out = {};
  if (identify || (k && perUnit)) out.identify = true;
  if (k && perUnit) { out.k = k; out.k_stat = stat; }
  if (k && !perUnit) out.unplaced_k = k;
  return Object.keys(out).length ? out : null;
}

const ORDINAL = (n) => ({ 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh",
  8: "eighth", 9: "ninth", 10: "tenth" }[n] || `${n}th`);

/** What a nearest_distance step's value means, for the layer's label. */
function nearestValueLabel(step) {
  const k = Number(step?.k) || 1;
  if (k > 1 && step.k_stat === "kth") return `miles to the ${ORDINAL(k)}-nearest feature`;
  if (k > 1) return `mean miles to the ${k} nearest features`;
  return "miles to the nearest feature";
}

/**
 * Set identify / k on the plan's nearest_distance steps. Returns
 * { fixes, notes }, or null when the question asks nothing of the kind.
 *
 * @param nameOf  (attr_id) => dataset name, for the log line
 * @param labelsOf (attr_id) => label columns the layer has
 */
function applyNearest(plan, query, { nameOf = (id) => id, labelsOf = () => null } = {}) {
  const ask = nearestAsk(query);
  if (!ask) return null;
  const fixes = [], notes = [];
  if (ask.identify) {
    const dropped = dropCountBesideNearest(plan);
    if (dropped) fixes.push(dropped);
  }
  const steps = (plan.steps || []).filter(s => s.op === "nearest_distance" && s.attr_id);
  // No per-unit distance: "the closest hospital to each school" is within's
  // (features to features), which this does not change.
  if (!steps.length) return { fixes, notes };
  if (ask.unplaced_k) {
    notes.push(`"${ask.unplaced_k} nearest" names no unit to measure from (no "each county" or unit), so the plan keeps the single nearest`);
  }
  for (const s of steps) {
    const labels = labelsOf(s.attr_id);
    const name = nameOf(s.attr_id);
    if (ask.k) { s.k = ask.k; s.k_stat = ask.k_stat; }
    if (ask.identify) {
      if (Array.isArray(labels) && !labels.some(c => c === "name" || c === "address")) {
        notes.push(`${name} has no name or address column, so the nearest feature cannot be named`);
      } else {
        s.identify = true;
      }
    }
    const what = s.k > 1
      ? (s.k_stat === "kth" ? `distance to the ${ORDINAL(s.k)}-nearest of ${name}` : `mean distance to the ${s.k} nearest of ${name}`)
      : `nearest of ${name}`;
    fixes.push(`${what}${s.identify ? ", named" : ""} (step ${s.id})`);
  }
  if (ask.k && ask.k_stat === "mean") {
    const dropped = dropMeanOverUnits(plan);
    if (dropped) fixes.push(dropped);
  }
  return { fixes, notes };
}

const ROW_SUBSET = new Set(["filter_area", "filter_place", "filter_attr", "rank"]);

/** Declaration order that respects inputs (stable for steps already in order). */
function topoSort(steps) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const out = [], seen = new Set();
  const visit = (s) => {
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    for (const i of s.inputs || []) visit(byId.get(i));
    out.push(s);
  };
  steps.forEach(visit);
  return out;
}

/**
 * "Which hospital is closest to the center of each Missouri county, and how
 * many miles away is it?" planned count_features(Hospitals) -> filter_area ->
 * join with nearest_distance(Hospitals), 3 of 3 (H6 item 3 dev, 2026-11-20):
 * the model reads "which hospital" as a count of them. The count answers
 * nothing asked, and the join drops the nearest feature's name (or, with the
 * inputs the other way round, makes the count the value). When the question
 * asks which feature is nearest and a join pairs a count of a layer with the
 * distance to that same layer, the count side goes and its place filters move
 * onto the distance. Returns a description, or null.
 */
function dropCountBesideNearest(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // A side of the join: the ROW_SUBSET chain down to its root step.
  const sideOf = (id) => {
    const chain = [];
    let st = byId.get(id);
    while (st && ROW_SUBSET.has(st.op)) { chain.unshift(st); st = byId.get((st.inputs || [])[0]); }
    return { root: st, chain };
  };
  for (const j of steps.filter(s => s.op === "join" && (s.inputs || []).length === 2)) {
    const [a, b] = j.inputs.map(sideOf);
    const near = [a, b].find(x => x.root?.op === "nearest_distance");
    const count = [a, b].find(x => x.root?.op === "count_features");
    if (!near || !count || near === count || near.root.attr_id !== count.root.attr_id) continue;
    // Only steps nothing else reads may go.
    const readers = (id) => steps.filter(s => (s.inputs || []).includes(id) && s.id !== j.id);
    if (readers(count.root.id).some(r => !count.chain.includes(r))) continue;
    if (count.chain.some(c => readers(c.id).some(r => !count.chain.includes(r)))) continue;
    const top = near.chain.length ? near.chain[near.chain.length - 1] : near.root;
    let tail = top;
    for (const f of count.chain) { f.inputs = [tail.id]; tail = f; }
    for (const s of steps) s.inputs = (s.inputs || []).map(i => (i === j.id ? tail.id : i));
    plan.steps = topoSort(steps.filter(s => s !== j && s !== count.root));
    return `dropped the count of the same layer (step ${count.root.id}) joined to the nearest distance (step ${near.root.id}); ` +
           `the question asks which one is nearest, not how many`;
  }
  return null;
}

/**
 * "What is the average distance in miles from each Texas county to its 3
 * nearest hospitals?" planned nearest_distance -> filter_area -> aggregate
 * (mean) -> output, 3 of 3 once the count repair above was in (H6 item 3
 * dev): one number for Texas. The average is over the k distances, which k
 * now computes, and "each county" asks for the counties. Only when k's mean
 * came from the question and the question is per unit; the aggregate goes and
 * its readers read its input. Returns a description, or null.
 */
function dropMeanOverUnits(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const ag of steps.filter(s => s.op === "aggregate" && (s.function === "mean" || s.function === "avg"))) {
    if (ag.group_by && ag.group_by !== "none") continue;
    let st = byId.get((ag.inputs || [])[0]);
    while (st && ROW_SUBSET.has(st.op)) st = byId.get((st.inputs || [])[0]);
    if (!(st && st.op === "nearest_distance" && Number(st.k) > 1 && st.k_stat === "mean")) continue;
    const input = ag.inputs[0];
    for (const s of steps) s.inputs = (s.inputs || []).map(i => (i === ag.id ? input : i));
    plan.steps = steps.filter(s => s !== ag);
    if (plan.output_type === "statistics") plan.output_type = "map";
    return `dropped the mean over all units (step ${ag.id}): the average asked for is over the ${st.k} nearest, per unit`;
  }
  return null;
}

/** Which fields are this module's, for the validator. */
function nearestFieldErrors(step) {
  const errs = [];
  const at = `step "${step.id}" (nearest_distance)`;
  if (step.identify !== undefined && typeof step.identify !== "boolean") {
    errs.push(`${at}: "identify" must be true or false`);
  }
  if (step.k !== undefined && step.k !== null) {
    const k = Number(step.k);
    if (!(Number.isInteger(k) && k >= 1 && k <= MAX_K)) errs.push(`${at}: "k" must be a whole number from 1 to ${MAX_K}, got ${JSON.stringify(step.k)}`);
  }
  if (step.k_stat !== undefined && step.k_stat !== null && !["mean", "kth"].includes(step.k_stat)) {
    errs.push(`${at}: "k_stat" must be "mean" or "kth", got ${JSON.stringify(step.k_stat)}`);
  }
  return errs;
}

module.exports = { nearestAsk, applyNearest, nearestValueLabel, nearestFieldErrors, dropCountBesideNearest, MAX_K };
