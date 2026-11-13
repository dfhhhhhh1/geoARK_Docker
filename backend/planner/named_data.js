/**
 * Does the plan use data for EVERYTHING the question names?
 *
 * WHY THIS EXISTS. The relevance check (planner/relevance.js) judges each
 * attribute a plan USES. It cannot see a concept the plan silently dropped.
 * Measured 2026-11-11 on 16 analyst questions (eval/gis_ops/baseline-r1.json),
 * five came back as confident answers about something else:
 *
 *   "FEMA flood zones x tax parcels, value at risk"  -> county owner-occupied home value
 *   "solar radiation over building footprints"       -> % of homes heated by solar
 *   "food stores per km2 per neighborhood unit"      -> electric retail service territories
 *   "311 potholes per council district / road miles" -> an unnamed layer / workers per car
 *   "cluster our mobile inspection locations"        -> Mobile Home Parks
 *
 * In every one, the question named data (flood zones, parcels, footprints,
 * districts, road mileage) that no step of the plan reads. Each attribute that
 * WAS used was judged on its own, and three of them survived because a single
 * shared word overruled the model's "none".
 *
 * SO THIS ASKS THE OTHER DIRECTION. List what the question needs data about,
 * copied from the question, and which used attribute covers each. A phrase no
 * attribute covers goes back through the repair loop, exactly like
 * NOT_RELEVANT: the planner either finds data that covers it or returns no
 * steps, which is the honest "not loaded" answer.
 *
 * WHAT CODE DECIDES, NOT THE MODEL. Three things, each because the model got
 * it wrong when it was left to it (prototype, qwen3:14b, 21 questions):
 *   - covered_by must be a label that was listed. It wrote "layer",
 *     "a layer the analysis must read" and "count_near".
 *   - the phrase must occur in the question (relevance.grounded).
 *   - places, units, periods and the reporting unit are exempt. Told not to
 *     list them, it listed "the Midwest", "Missouri", "each county", "within
 *     10 miles" and "between 2019 and 2020" anyway, which would refuse four
 *     answerable questions.
 *
 * REASONING OFF. With reasoning on, one prototype call (the food-store
 * question) reasoned for 16,000 tokens without answering and timed out at
 * 5 minutes. Off, every call took 0.5-2.3 s and the decisions were the same
 * on the cases both finished.
 */

const { grounded } = require("./relevance");
const { statesMentioned, LOCATIVE_PHRASE, REGION_WORDS } = require("../states");
const { zoneWords } = require("./levels");

const NAMED_SCHEMA = {
  type: "object",
  properties: {
    named: {
      type: "array",
      items: {
        type: "object",
        properties: {
          phrase: { type: "string" },
          covered_by: { type: "string" },
        },
        required: ["phrase", "covered_by"],
      },
    },
  },
  required: ["named"],
};

const NAMED_SYSTEM = `You check whether the data an analysis uses covers everything a question asks about.

List in "named" each distinct thing the question needs DATA about:
  - a measure (poverty rate, median income, obesity)
  - a kind of mapped feature (hospitals, fire stations, parcels, schools)
  - a layer the analysis must read (flood zones, council districts, a road
    network, a raster, building footprints)
For each, return:
  phrase      the words of the QUESTION that name it, copied exactly
  covered_by  the label of the attribute below that measures it, or stands in
              for it the way a careful analyst would accept ("a3"); "" if no
              attribute below does

Do NOT list:
  - places: states, cities, counties, regions, "the South", "downtown"
  - dates, periods and units (miles, square kilometers, acres, minutes)
  - what the question wants to do: rank, compare, count, map, normalize, explain
  - the unit results are reported for: counties, census tracts, ZIP codes`;

const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Words that carry no data on their own: function words, and the vocabulary of
// places, units, periods and reporting units. A phrase made only of these (plus
// numbers, state names and capitalised place names) names no data.
const EXEMPT = new Set((
  "the a an of in on at by for to from within across around near inside outside " +
  "each every all per and or with between over during since last past next this " +
  "that these those our my their its any most least top bottom " +
  // reporting units and administrative geography
  "county counties state states tract tracts census block blocks group groups zip " +
  "zips code codes zcta zctas area areas region regions city cities town towns " +
  "metro metros metropolitan nation national nationwide country countries america " +
  "american us usa united place places level " +
  "north south east west northern southern eastern western central " +
  // the remainder of a place: "compared with the rest of the country" refused
  // r-obesity-top50-income (research.yaml, 2026-11-11)
  "rest remainder elsewhere other others " +
  // geometry the ops derive from the boundaries themselves: "miles from the
  // center of each Missouri county" refused r-hospital-distance-mo
  "center centre centers centres centroid centroids middle boundary boundaries " +
  "border borders edge edges " +
  // question words and distance: the ops compute distance, no layer holds it.
  // "How far, in miles" refused r-hospital-distance-mo (2026-11-11)
  "how what which where when why far farther farthest further furthest " +
  "near nearer nearest nearby close closer closest distance distances away " +
  // a radius around something is geometry the ops derive, like a distance:
  // "using a 30-mile catchment" refused the 2SFCA question (2026-11-11)
  "catchment catchments radius radii buffer buffers " +
  // units
  "mile miles mi km kilometer kilometers kilometre kilometres meter meters metre " +
  "metres m foot feet ft yard yards acre acres hectare hectares square sq " +
  "minute minutes hour hours day days week weeks month months year years decade decades"
).split(" "));

/** Words of the question that are part of a capitalised place after "in", "around"... */
function placeWords(query) {
  const words = new Set();
  const re = new RegExp(LOCATIVE_PHRASE.source, "g");
  for (const m of String(query || "").matchAll(re)) {
    for (const w of norm(m[1]).split(" ")) if (w) words.add(w);
  }
  for (const s of statesMentioned(query)) for (const w of norm(s).split(" ")) words.add(w);
  return words;
}

/**
 * A phrase is exempt when nothing in it could name data: every word is a
 * function word, a place, a unit, a period, a reporting unit, a number, or a
 * regional word ("Midwest", "Rust Belt").
 */
function isExempt(phrase, query) {
  const places = placeWords(query);
  // A loaded zone set's unit and place words (planner/levels.js): "each
  // Chicago ward" is a reporting unit, as "each Missouri county" is.
  const zones = zoneWords();
  const words = norm(phrase).split(" ").filter(Boolean);
  if (!words.length) return true;
  // A workflow step id ("the counties from q1") names an earlier result, which
  // is itself listed as an attribute; the id alone names no data.
  return words.every(w => EXEMPT.has(w) || places.has(w) || zones.has(w) || /^\d/.test(w)
    || /^q\d+$/.test(w) || REGION_WORDS.test(w));
}

/**
 * The attribute lines the model sees, in the relevance check's format.
 * `items`: [{ label, attr_id, desc, dataset, role }]
 */
function attributeLines(items) {
  return items.map(i => {
    const desc = String(i.desc || i.attr_id).replace(/\s+/g, " ").slice(0, 140);
    const ds = i.dataset ? ` [dataset: ${i.dataset}]` : "";
    return `${i.label}: ${desc}${ds}${i.role ? ` (${i.role})` : ""}`;
  });
}

/**
 * Ask which named things the listed attributes cover.
 * @returns {{ named: Array, uncovered: string[], skipped?: string }}
 * Never throws: a check that did not run says so and blocks nothing.
 */
const OWN_DATA = /\b(?:our|my)\b/i;
const isUserLayer = (id) => String(id || "").startsWith("layer:");

async function namedCoverage({ query, items, callLLM, log = () => {} }) {
  if (!items.length) return { named: [], uncovered: [] };
  let parsed;
  try {
    const raw = await callLLM(NAMED_SYSTEM,
      `QUESTION: ${query}\nATTRIBUTES:\n${attributeLines(items).join("\n")}`,
      0, NAMED_SCHEMA,
      // Reasoning off, and no budget: a budget would re-enable streaming
      // reasoning through budgetedChat. See the header.
      { role: "named_data", think: false, thinkBudget: 0 });
    if (!raw) throw new Error("the model returned nothing");
    parsed = JSON.parse(raw);
  } catch (err) {
    log(`   named-data check did not run: ${err.message}`);
    return { named: [], uncovered: [], skipped: err.message };
  }
  const labels = new Set(items.map(i => norm(i.label)));
  const byLabel = new Map(items.map(i => [norm(i.label), i]));
  const named = (Array.isArray(parsed.named) ? parsed.named : []).map(n => {
    const phrase = String(n?.phrase || "").trim();
    // "a3", "a3: Hospitals", "A3" all name a3; "layer" names nothing.
    const cov = norm(n?.covered_by).match(/^a\d+/)?.[0] || norm(n?.covered_by);
    let covered = labels.has(cov) ? cov : null;
    const isGrounded = grounded(phrase, query);
    const exempt = isGrounded && isExempt(phrase, query);
    // The user's OWN data ("our transportation network", "my parcels") is
    // covered only by a layer they uploaded. With none, held-out Q6 answered
    // "road segments in our transportation network" with the national
    // primary roads, silently (H3, 2026-11-12). Decided in code.
    const own = !exempt && covered && OWN_DATA.test(phrase) &&
      !isUserLayer(byLabel.get(covered)?.attr_id);
    if (own) covered = null;
    return { phrase, covered_by: covered, grounded: isGrounded, exempt, ...(own ? { own_data: true } : {}) };
  });
  // Seen once per phrase: the model sometimes lists a phrase twice.
  const uncovered = [...new Set(named
    .filter(n => n.grounded && !n.exempt && !n.covered_by)
    .map(n => n.phrase))];
  return { named, uncovered };
}

/**
 * Plan-time check: every phrase the question names data about is covered by
 * an attribute the plan uses. `used` comes from relevance.usedAttributes.
 * @returns {{ errors: string[], named: Array, uncovered: string[], skipped?: string }}
 */
async function checkNamedData({ query, used, candidates, refs, callLLM, log = () => {} }) {
  // An earlier workflow step's result (backend/workflow.js, `result:q1`) is
  // listed like any other attribute, under its own description: "Counties from
  // q1: <intent> (N counties, values ...)". It covers "those counties" and q1's
  // own measure, and nothing else. It used to exempt the whole plan, and a step
  // that read ONLY q1's asthma counties answered "the average annual rainfall
  // in the counties from q1" by averaging asthma (eval/gis_ops/h2/
  // final-advanced.json, d-asthma-then-rainfall, 2026-11-12): no attribute
  // measured rainfall and nothing asked.
  const labelOf = new Map([...refs.entries()].map(([label, id]) => [id, label]));
  const byId = new Map(candidates.map(c => [c.attr_id, c]));
  const items = used.map(u => {
    const c = byId.get(u.attr_id) || {};
    const role = `used by ${u.op}${u.feeds?.length ? `, feeding ${u.feeds.join(" and ")}` : ""}`;
    return { label: labelOf.get(u.attr_id) || u.attr_id, attr_id: u.attr_id,
             desc: c.attr_desc, dataset: c.dataset_clean, role };
  });
  const r = await namedCoverage({ query, items, callLLM, log });
  for (const n of r.named) {
    log(`   named "${n.phrase}" -> ${n.covered_by || (n.exempt ? "exempt" : !n.grounded ? "not in question, ignored" : n.own_data ? "NOT COVERED (their own data, not uploaded)" : "NOT COVERED")}`);
  }
  const own = new Set(r.named.filter(n => n.own_data).map(n => n.phrase));
  const errors = r.uncovered.map(p => own.has(p)
    ? `NOT_COVERED: "${p}" is the user's OWN data, and they have not uploaded it. ` +
      `A catalog layer of the same kind is not theirs. Return an empty "steps" ` +
      `array: the answer needs their upload.`
    : `NOT_COVERED: the question asks about "${p}", and no attribute the plan uses ` +
    `measures it. Use an attribute that does. If none of the AVAILABLE ATTRIBUTES ` +
    `measures it, return an empty "steps" array: the data is not loaded, and ` +
    `saying so is the correct answer.`);
  return { ...r, errors };
}

/**
 * Refusal-time: which named things do none of the retrieved candidates cover?
 * Lets a refusal say "nothing loaded covers parcels or flood zones" instead of
 * "could not produce a valid plan", which reads as a crash and does not tell
 * the user that rephrasing will not help.
 */
async function missingConcepts({ query, candidates, callLLM, log = () => {}, limit = 15 }) {
  const items = candidates.slice(0, limit).map((c, i) => ({
    label: `a${i + 1}`, attr_id: c.attr_id, desc: c.attr_desc, dataset: c.dataset_clean,
  }));
  const r = await namedCoverage({ query, items, callLLM, log });
  if (r.uncovered.length) log(`   not covered by any candidate: ${r.uncovered.join("; ")}`);
  return r;
}

module.exports = {
  checkNamedData, missingConcepts, namedCoverage, isExempt,
  NAMED_SCHEMA, NAMED_SYSTEM,
};
