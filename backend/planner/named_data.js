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
  // how much of a computed quantity: "how many miles away", "average distance
  // in miles" refused n-mo-hospital-name / n-tx-hospitals-mean3 (H6 item 3,
  // 2026-11-20). A phrase with a noun as well ("average income") is still
  // checked on that noun.
  "many much average mean median " +
  // which of the nearest: "the second-closest fire station" refused
  // n-ks-fire-second once in three (same day); "second homes" is still
  // checked on "homes"
  "first second third fourth fifth sixth seventh eighth ninth tenth " +
  // a radius around something is geometry the ops derive, like a distance:
  // "using a 30-mile catchment" refused the 2SFCA question (2026-11-11)
  "catchment catchments radius radii buffer buffers " +
  // the vocabulary of analysis, which names no data under any plan: "Test
  // for spatial autocorrelation", "is X significantly clustered", "report
  // the coefficient" (method_words_dev, 2026-11-22). The NAME of a method
  // ("autocorrelation", "Spearman") is exempt only for a plan that runs it:
  // each op declares its own `methodTerms` (planner/ops/*.js).
  "test tests testing analysis analyses analyze analyse run compute calculate " +
  "quantify report estimate statistic statistics statistical statistically " +
  "significant significantly significance degree strength strong strongly method " +
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
function isExempt(phrase, query, extra = null) {
  const places = placeWords(query);
  // A loaded zone set's unit and place words (planner/levels.js): "each
  // Chicago ward" is a reporting unit, as "each Missouri county" is.
  const zones = zoneWords();
  const words = norm(phrase).split(" ").filter(Boolean);
  if (!words.length) return true;
  // A workflow step id ("the counties from q1") names an earlier result, which
  // is itself listed as an attribute; the id alone names no data.
  // How a network distance is measured (H5): "longest driving distance",
  // "road miles", "a 10-minute walk" refused n-stl-fire-hospital-top5-roadmiles
  // (2026-11-19). Only for a question network.js reads a network cost from,
  // and "road" only beside a distance word: "miles of road in each ward" names
  // a roads layer, which must still be covered.
  const net = require("./network").asksNetwork(query);
  const roadAsMeasure = words.some(w => ["mile", "miles", "distance", "distances", "kilometer", "kilometers", "kilometre", "kilometres", "km"].includes(w));
  const travel = (w) => net && (NETWORK_WORDS.has(w) || ((w === "road" || w === "roads") && roadAsMeasure));
  return words.every(w => EXEMPT.has(w) || places.has(w) || zones.has(w) || /^\d/.test(w)
    || /^q\d+$/.test(w) || REGION_WORDS.test(w) || travel(w) || (extra && extra.has(w)));
}

/**
 * Words of the question that name a METHOD the plan runs: each op's own
 * `methodTerms` (planner/ops/*.js), matched against the question, for the ops
 * in this plan only. "Test for spatial autocorrelation in median household
 * income" names one measure; "spatial autocorrelation" is what moran
 * computes. A plan without moran gets no exemption for it, so a question
 * asking for autocorrelation that the plan never tests is still refused.
 * Declared beside the op, not listed here: every list kept beside the
 * registry has missed an op (CLAUDE.md, derefPlan, LEVEL_OPS).
 */
function methodWords(plan, query) {
  const out = new Set();
  if (!plan) return out;
  const ops = require("./ops");
  for (const name of new Set((plan.steps || []).map(s => s.op))) {
    const re = ops.byName(name)?.methodTerms;
    if (!re) continue;
    for (const m of String(query || "").matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      for (const w of norm(m[0]).split(" ")) if (w) out.add(w);
    }
  }
  return out;
}

/**
 * A COMPARISON the model listed as data. "More than 30 miles from the nearest
 * hospital" refused research.yaml r-access-gap (2026-11-21); "fewer than 4
 * nursing homes" is the same shape. It is covered by a used attribute when
 * every word of it that is not a comparison word or otherwise exempt (number,
 * unit, distance, place) is a word of that attribute's own NAME, by stem: the
 * plan computes the comparison (a distance, a count), the thing compared is
 * the layer.
 *
 * Comparison words are NOT exempt on their own: "more than 50,000 acres" is a
 * threshold on a layer's column, and stays refused unless a value filter
 * carries it (checkNamedData), or the plan would pass a comparison it never
 * applies. A bare distance ("more than 15 miles") is covered only when the
 * plan computes a distance.
 *
 * Only for a phrase with a number in it: elsewhere a shared word must not
 * overrule the model, which is how "mobile" once covered "mobile inspection
 * locations" with Mobile Home Parks. Returns the covering item, `true` for a
 * bare distance the plan computes, or null.
 */
const HAS_NUMBER = /\d/;
const COMPARISON = new Set(("more less fewer greater larger smaller higher lower than under above " +
  "below exceed exceeds exceeding beyond no not least").split(" "));
const DISTANCE_UNIT = new Set("mile miles mi km kilometer kilometers kilometre kilometres meter meters metre metres m foot feet ft yard yards".split(" "));
const DISTANCE_OPS = new Set(["nearest_distance", "within", "count_near", "access"]);
function thresholdCoverage(phrase, query, items, extra, plan = null) {
  if (!HAS_NUMBER.test(phrase)) return null;
  const { sameWord } = require("./feature_filters");
  const words = norm(phrase).split(" ").filter(Boolean);
  if (!words.some(w => COMPARISON.has(w))) return null;
  const rest = words.filter(w => !COMPARISON.has(w) && !isExempt(w, query, extra));
  if (!rest.length) {
    const distance = words.some(w => DISTANCE_UNIT.has(w)) &&
      (plan?.steps || []).some(s => DISTANCE_OPS.has(s.op));
    return distance ? true : null;
  }
  const nameWords = (i) => norm(`${i.dataset || ""} ${String(i.desc || "").slice(0, 140)}`)
    .split(" ").filter(w => w.length >= 3);
  // "fewer than 2 fire stations per 10,000 residents": the people are the
  // used whole-population count (population.isPopulationCount, the rule the
  // relevance check uses), the rest is the layer. Refused on HEAD by the
  // probe (eval/gis_ops/checks/fix-named_probe.log, t-us-fire-per10k).
  const people = rest.filter(w => PEOPLE.has(w));
  const others = rest.filter(w => !PEOPLE.has(w));
  if (people.length) {
    const { isPopulationCount } = require("../population");
    if (!items.some(i => isPopulationCount(i.desc))) return null;
    if (!others.length) return items.find(i => isPopulationCount(i.desc));
  }
  return items.find(i => {
    const ws = nameWords(i);
    return others.every(r => ws.some(w => sameWord(w, r)));
  }) || null;
}
const PEOPLE = new Set("people persons residents resident inhabitants population".split(" "));

const NETWORK_WORDS = new Set((
  "drive drives driving driven walk walks walking walked travel traveling travelling " +
  "time times trip trips route routes routing car cars foot longest shortest long short " +
  "minute minutes free flow"
).split(" "));

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

async function namedCoverage({ query, items, callLLM, log = () => {}, plan = null }) {
  if (!items.length) return { named: [], uncovered: [] };
  const method = methodWords(plan, query);
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
    const exempt = isGrounded && isExempt(phrase, query, method);
    let threshold = null, computed = false;
    if (!covered && isGrounded && !exempt) {
      const hit = thresholdCoverage(phrase, query, items, method, plan);
      if (hit === true) computed = true;
      else if (hit) { covered = norm(hit.label); threshold = true; }
    }
    // The user's OWN data ("our transportation network", "my parcels") is
    // covered only by a layer they uploaded. With none, held-out Q6 answered
    // "road segments in our transportation network" with the national
    // primary roads, silently (H3, 2026-11-12). Decided in code.
    const own = !exempt && covered && OWN_DATA.test(phrase) &&
      !isUserLayer(byLabel.get(covered)?.attr_id);
    if (own) covered = null;
    // A bare distance the plan computes ("more than 15 miles") names no data,
    // like "within 10 miles".
    return { phrase, covered_by: covered, grounded: isGrounded, exempt: exempt || computed,
             ...(own ? { own_data: true } : {}), ...(threshold && covered ? { threshold: true } : {}) };
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
async function checkNamedData({ query, used, candidates, refs, callLLM, log = () => {}, plan = null }) {
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
  const r = await namedCoverage({ query, items, callLLM, log, plan });
  // A comparison on a layer's own column ("more than 100 beds") is covered by
  // the layer whose value filter was read from it (planner/feature_filters.js):
  // no ATTRIBUTE measures it, the step's column does. Matched on the filter's
  // own record of the question's words: the same number and a shared word.
  // "burned more than 100,000 acres" refused vf-fires-2020-acres 3 of 3
  // attempts with the filter in place (2026-11-20).
  if (plan && r.uncovered.length) {
    const { sameWord } = require("./feature_filters");
    const filters = [];
    for (const st of plan.steps || []) {
      for (const f of st.value_filters || []) if (f.said) filters.push({ f, st });
    }
    const numbers = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(x => Number(x.replace(/,/g, "")));
    const words = (s) => norm(s).split(" ").filter(w => w.length >= 3 && !/^\d/.test(w));
    for (const n of r.named) {
      if (n.covered_by || n.exempt || !n.grounded) continue;
      const hit = filters.find(({ f }) => numbers(n.phrase).some(x => numbers(f.said).includes(x)) &&
        words(n.phrase).some(w => words(f.said).some(v => sameWord(v, w)) || sameWord(f.column, w)));
      if (!hit) continue;
      n.covered_by = labelOf.get(hit.st.attr_id) || hit.st.attr_id;
      n.value_filter = hit.f.column;
      log(`   named "${n.phrase}" -> ${n.covered_by} (value filter on ${hit.f.column})`);
    }
    r.uncovered = r.uncovered.filter(p => !r.named.some(n => n.phrase === p && n.covered_by));
  }
  for (const n of r.named) {
    if (n.value_filter) continue;
    log(`   named "${n.phrase}" -> ${n.covered_by ? `${n.covered_by}${n.threshold ? " (a comparison on it)" : ""}` : (n.exempt ? "exempt" : !n.grounded ? "not in question, ignored" : n.own_data ? "NOT COVERED (their own data, not uploaded)" : "NOT COVERED")}`);
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
  checkNamedData, missingConcepts, namedCoverage, isExempt, methodWords, thresholdCoverage,
  NAMED_SCHEMA, NAMED_SYSTEM,
};
