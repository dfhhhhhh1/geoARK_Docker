/**
 * The planning agent.
 *
 * Pipeline:  search -> plan (constrained) -> validate -> repair? -> compile -> execute
 *
 * What makes this different from the Generation-1 pipeline it replaces
 * (backend/legacy/geospatial_server.js):
 *
 *   1. The model never emits SQL, table names, or column names. It emits a plan
 *      referencing attr_ids, and a deterministic compiler turns that into SQL.
 *   2. The plan is schema-constrained at the decoder, so it always parses.
 *   3. Every attr_id is checked against attribute_source before anything runs.
 *   4. Validation failures are fed BACK to the model as a repair prompt rather
 *      than 500ing the request.
 */

const { PLAN_SCHEMA, planSchemaFor } = require("../schemas");
const { queryMentionsArea, statesMentioned, REGIONS } = require("../states");
const { validatePlan } = require("./validate");
const { compilePlan, CompileError } = require("./compile");

const MAX_REPAIRS = Number(process.env.PLAN_MAX_REPAIRS ?? 2);

/**
 * Is the question asking WHERE things are, rather than how many per county?
 *
 * select_features returns a different shape of answer -- individual locations
 * instead of a per-county number -- and offering it indiscriminately invites
 * the wrong one for "how many hospitals in each county". It also costs an op
 * slot, which this project has measured is not free.
 *
 * Deliberately conservative: when this is wrong the model still has
 * count_features, which is the more common intent. The reverse mistake --
 * offering locations to a counting question -- is the worse one.
 */
const LOCATION_PHRASES = [
  /\bwhere (are|is|can i find)\b/i,
  /\blocations? of\b/i,
  /\b(show|list|map|find|give me)\b[^.?]*\b(locations?|sites?|places?|points?|facilities|addresses)\b/i,
  /\b(individual|each|specific|actual)\b[^.?]*\b(locations?|sites?|facilities)\b/i,
  /\bplot\b/i,
];

function queryWantsLocations(query) {
  if (!query) return false;
  return LOCATION_PHRASES.some(re => re.test(String(query)));
}

// --------------------------------------------------------------------------
// The system prompt.
//
// ASSEMBLED FROM PARTS RATHER THAN REGEX-EDITED. The previous version was one
// template string that generatePlan rewrote with three regexes to drop
// count_features when no facility dataset had been retrieved. That coupled the
// wording to the regexes -- reflowing a sentence would silently stop the op
// being removed, and nothing would fail loudly. Sections are now selected.
//
// WHY SIX WORKED EXAMPLES AND NOT ONE.
//
// There used to be a single example: poverty normalized by population. Its
// shape, load->load->normalize->output, is structurally valid for very nearly
// any input, so a model that copies it scores 100% on plan_validity while
// answering none of the questions. Measured 2026-08-31, PLAN_MODEL=qwen3:14b:
//
//   - 7 of 8 multi_concept queries returned exactly that op sequence
//   - "list the top 10 counties by median household income" produced
//     normalize and never rank
//   - the intent "Poverty count divided by population, by county" came back
//     verbatim for a question about income and educational attainment
//
// The instruction "intent must restate THE QUESTION YOU ARE GIVEN" was already
// in the prompt throughout and did not help. A demonstration outweighs an
// instruction, so the fix is more demonstrations, not firmer wording: one per
// op, each with a visibly different shape and subject, written as QUESTION ->
// PLAN pairs so what gets learned is the mapping rather than the output.
//
// eval/plan_probe.py exists to keep this honest -- op_diversity there is the
// direct measure of the failure this structure is meant to prevent.
// --------------------------------------------------------------------------

const PLAN_PREAMBLE = `You convert a geospatial question into an executable analysis plan.

You are given the user's question and a list of AVAILABLE ATTRIBUTES that were
retrieved for it. Each has a short reference label and a description.

Rules:
- For attr_id use ONLY a label from the AVAILABLE ATTRIBUTES list, exactly as
  written (for example "a1", "a7"). Never invent an id and never write out a
  description in the attr_id field.
- Step ids must be simple: s1, s2, s3 ... with no prefixes or punctuation.
- Every plan is a list of steps in execution order. A step may only reference
  steps defined before it.
- Start with "load" steps (one per attribute you need), then combine them.
- For a rate, percentage, or "per capita" figure, use "normalize" with a
  PRIMARY attribute as input 1 and a NORMALIZATION attribute as input 2, and
  scale 100 for a percentage. Never divide one PRIMARY attribute by another.
- End with exactly one "output" step.`;

const OP_LINES = {
  load:           `  load         needs attr_id                       -> values for one attribute`,
  count_features: `  count_features needs attr_id (a facility dataset) -> features per county.
                 Accepts attribute_filters to count only some of them.`,
  count_near:     `  count_near   needs attr_id, near_attr_id, miles  -> features of the first within
                 that many miles of the second, per county`,
  nearest_distance: `  nearest_distance needs attr_id                 -> miles from each county to
                 the nearest such feature`,
  select_features: `  select_features needs attr_id, optional states / city / attribute_filters / limit
                 -> the individual locations themselves, drawn on the map.
                 Use it ALONE: it returns places, not per-county numbers, so
                 nothing else can be chained onto it. Put any place restriction
                 in this step. City names repeat across the country, so when the
                 question names a city AND a state, always set both.`,
  filter_attr:    `  filter_attr  needs operator and value, 1 input   -> keep matching rows`,
  filter_area:    `  filter_area  needs states, 1 input               -> keep only those states.
                 "states" takes full state names. For a region, list its member
                 states: "New England" becomes Maine, New Hampshire, Vermont,
                 Massachusetts, Rhode Island, Connecticut. Midwest, Northeast,
                 South and West may be given by name instead. List each state
                 once.`,
  filter_place:   `  filter_place needs place_kind and place_name, 1 input
                 -> keep only counties inside a named city, ZIP code or metro.
                 place_kind is one of: place (city or town), zcta (ZIP code),
                 cbsa (metro area), urban (urbanized area). Place names repeat:
                 22 cities are called Springfield, so set "states" as well when
                 the question names one.`,
  per_area:       `  per_area     1 input                             -> value per square mile of land`,
  normalize:      `  normalize    2 inputs (numerator, denominator)   -> ratio, optional scale`,
  aggregate:      `  aggregate    needs function, 1 input             -> mean/sum/count/min/max`,
  rank:           `  rank         1 input, direction and limit        -> top or bottom n`,
  join:           `  join         2 inputs                            -> combine on the shared area`,
  output:         `  output       1 input                             -> terminal step`,
};

// These two sections name ops inline, so they are built rather than fixed:
// mentioning count_features when it is absent from the decoding schema invites
// a plan that cannot validate, costing a repair round. This is the leak the
// old `.replace(/ and count_features;/, ";")` was patching by hand.
//
// The literal field values are spelled out because the old prompt never did.
// The schema constrains them anyway, but a model that has to guess between
// ">" and "gt" spends a repair round discovering which.
const fieldRules = (hasFeatureTables) => {
  const loadOps = hasFeatureTables ? "load and count_features" : "load";
  return `Every step MUST include both "inputs" and "attr_id".
  inputs  : [] for ${loadOps}; one step id for filter_attr,
            aggregate, rank, output; two for normalize and join.
  attr_id : a label like "a3" for ${loadOps}; "" for every other op.

Field values, written exactly like this:
  operator     "<"  "<="  ">"  ">="  "="  "!="
  function     mean  sum  count  min  max
  direction    asc  desc
  output_type  map  table  chart  statistics
  entity_type  COUNTY  STATE`;
};

const opChoice = (ops) => {
  const has = (op) => ops.includes(op);
  const lines = [
    `  "rate", "per capita", "percentage of", "normalized by"   -> normalize`,
    `  "top N", "highest", "lowest", "bottom N"                 -> rank`,
    `  "compare A against B", "A versus B", "A alongside B"     -> join`,
    ...(has("count_features")
      ? [`  "how many X in each county", X being a facility dataset  -> count_features`] : []),
    ...(has("count_near")
      ? [`  "X within N miles of Y", "X near Y", "close to"          -> count_near`] : []),
    ...(has("nearest_distance")
      ? [`  "how far to the nearest X", "distance to X"              -> nearest_distance`] : []),
    ...(has("select_features")
      ? [`  "where are the X", "show me X locations", "list the X"   -> select_features`] : []),
    `  "average", "total across all", a single overall number   -> aggregate`,
    `  "where X is above / below N", "only counties that ..."   -> filter_attr`,
    ...(has("filter_area")
      ? [`  "in Missouri", "in New England", a state or region       -> filter_area`] : []),
    ...(has("filter_place")
      ? [`  "in Springfield", "in ZIP 63101", "in the Chicago metro" -> filter_place`] : []),
    ...(has("per_area")
      ? [`  "per square mile", "density of", "how concentrated"      -> per_area`] : []),
    `  "show X", "map X", plain retrieval of one attribute      -> load, then output`,
  ];
  // The composition note names no ops on purpose. Naming them made the sentence
  // leak operations the decoding schema had dropped, which costs a repair round
  // on a plan the model was never able to emit.
  return `CHOOSING THE OPERATION

Read the question and pick the shape it actually asks for. A question can need
several of these in sequence -- take them in the order the question states them,
and end with output:

${lines.join("\n")}`;
};

const FILTER_NOTE = `Some mapped datasets list their filterable columns underneath, like
    filter type: "GENERAL ACUTE CARE", "CRITICAL ACCESS", "PSYCHIATRIC"

When the question names a kind of thing rather than all of them -- "critical
access hospitals", "open shelters" -- add attribute_filters using a value from
that list, copied exactly. Only those values exist; anything else matches
nothing. If the question does not narrow by kind, leave attribute_filters out.`;

const facilityNote = (wantsLocations) =>
  `Facility datasets (refineries, shelters, tornado tracks, power plants) are
collections of map features with no county totals, so "load" never applies to
them -- it is only for attributes that are already per-county values.
${wantsLocations
  ? `Ask what the question wants FROM such a dataset: a per-county number
("count_features"), a per-county distance ("nearest_distance"), or the places
themselves ("select_features"). Only select_features returns individual
locations; the other two return one value per county.`
  : `Use "count_features" to get a per-county count of them.`}
The validator will tell you if you pick the wrong one.`;

const EXAMPLES_HEADER = `WORKED EXAMPLES

Each is a QUESTION and the correct PLAN for it. The op sequence and the intent
are different in every one, because both follow from the question. Carrying a
shape or an intent from an example over to a different question is the single
most common way to get this wrong.`;

const EXAMPLES = [
  { op: "normalize", text:
`QUESTION: poverty rate per capita by county
  (a3 = a poverty count, a8 = total population)
PLAN: {"intent":"Poverty count divided by total population, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s3","op":"normalize","attr_id":"","inputs":["s1","s2"],"scale":100},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` },

  { op: "rank", text:
`QUESTION: the 10 counties with the highest median household income
  (a2 = median household income)
PLAN: {"intent":"The ten counties ranked highest on median household income",
 "output_type":"table","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"rank","attr_id":"","inputs":["s1"],"direction":"desc","limit":10},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },

  { op: "join", text:
`QUESTION: compare unemployment against educational attainment
  (a1 = unemployment rate, a4 = share with a bachelor's degree)
PLAN: {"intent":"Unemployment rate set alongside educational attainment, by county",
 "output_type":"chart","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a1","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a4","inputs":[]},
          {"id":"s3","op":"join","attr_id":"","inputs":["s1","s2"]},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}` },

  { op: "count_features", text:
`QUESTION: how many hospitals are in each county
  (a5 = a hospitals facility dataset)
PLAN: {"intent":"Number of hospital features in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_features","attr_id":"a5","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  // The same op, narrowed by a value taken from the dataset's own filter list.
  // `usesFilters` holds it back when no dataset on offer has any.
  { op: "count_features", usesFilters: true, text:
`QUESTION: how many critical access hospitals are in each county
  (a5 = a hospitals facility dataset, listing filter type: "CRITICAL ACCESS")
PLAN: {"intent":"Number of critical access hospitals in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_features","attr_id":"a5","inputs":[],
           "attribute_filters":[{"column":"type","value":"CRITICAL ACCESS"}]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  { op: "aggregate", text:
`QUESTION: the average median household income across all counties
  (a2 = median household income)
PLAN: {"intent":"Average of median household income over all counties",
 "output_type":"statistics","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"aggregate","attr_id":"","inputs":["s1"],"function":"mean"},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },

  { op: "filter_attr", text:
`QUESTION: counties where median household income is above 75000
  (a2 = median household income)
PLAN: {"intent":"Counties whose median household income is greater than 75000",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_attr","attr_id":"","inputs":["s1"],"operator":">","value":75000},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },

  { op: "load", text:
`QUESTION: show total population by county
  (a8 = total population)
PLAN: {"intent":"Total population in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  { op: "filter_area", text:
`QUESTION: median household income for counties in Missouri
  (a2 = median household income)
PLAN: {"intent":"Median household income for Missouri counties",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Missouri"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },

  { op: "filter_place", text:
`QUESTION: median household income for counties in the Springfield, Missouri area
  (a2 = median household income)
PLAN: {"intent":"Median household income for counties around Springfield, Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"filter_place","attr_id":"","inputs":["s1"],
           "place_kind":"place","place_name":"Springfield","states":["Missouri"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },

  { op: "count_near", text:
`QUESTION: hospitals within 10 miles of transmission lines
  (a4 = a hospitals dataset, a6 = an electric transmission lines dataset)
PLAN: {"intent":"Hospitals within ten miles of a transmission line, per county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"count_near","attr_id":"a4","near_attr_id":"a6","miles":10,"inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  // Two examples, because the state form and the city form differ: `states`
  // is spatial (any layer), `city` matches the layer's own column and only
  // works where it has one.
  { op: "select_features", text:
`QUESTION: where are the hospitals in Missouri
  (a4 = a hospitals dataset)
PLAN: {"intent":"Locations of hospitals in Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a4","inputs":[],"states":["Missouri"]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  // Sets BOTH city and states. City names are not unique -- "Springfield" alone
  // returned 97 fire stations across 25 states, of which 21 were in Missouri --
  // and an example showing city on its own is what taught that mistake.
  { op: "select_features", text:
`QUESTION: show me the fire stations in Springfield, Missouri
  (a7 = a fire stations dataset)
PLAN: {"intent":"Locations of fire stations in Springfield, Missouri",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"select_features","attr_id":"a7","inputs":[],
           "city":"Springfield","states":["Missouri"]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  { op: "nearest_distance", text:
`QUESTION: how far is each county from the nearest hospital
  (a4 = a hospitals dataset)
PLAN: {"intent":"Distance in miles from each county to its nearest hospital",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"nearest_distance","attr_id":"a4","inputs":[]},
          {"id":"s2","op":"output","attr_id":"","inputs":["s1"]}]}` },

  // Deliberately does NOT chain filter_area: that op is only offered when the
  // question names a place, and an example may never demonstrate an op the
  // decoding schema has dropped.
  { op: "per_area", text:
`QUESTION: population density per square mile
  (a8 = total population)
PLAN: {"intent":"Population per square mile of land in each county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s2","op":"per_area","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` },
];

const INTENT_RULE = `"intent" must restate THE QUESTION YOU WERE GIVEN, in one sentence. Every
example above states a different intent because each one restates its own
question. If your intent names a subject that does not appear in the question
you were given, you have copied an example -- discard it and start from the
question.`;

/**
 * Build the system prompt for the ops actually on offer.
 *
 * Op-set size costs a small model accuracy even on ops it cannot use, which is
 * why count_features and its example are dropped rather than left in with a
 * caveat. Narrowing the op set per query is what recovered plan validity from
 * 12.5% to 25.0% when facility coverage was added -- see docs/RUNBOOK.md.
 */
function buildSystemPrompt({ hasFeatureTables = false, featureTableCount = 0,
                             mentionsArea = false, wantsLocations = false,
                             hasFilterableValues = false,
                             hasPlaceBoundaries = false } = {}) {
  // Must mirror planSchemaFor in schemas.js exactly. If the prompt offers an op
  // the decoding enum has dropped, the model spends a repair round on a plan it
  // was never able to emit.
  const ops = ["load"];
  if (hasFeatureTables) ops.push("count_features", "nearest_distance");
  if (hasFeatureTables && wantsLocations) ops.push("select_features");
  if (featureTableCount >= 2) ops.push("count_near");
  ops.push("filter_attr");
  if (mentionsArea) ops.push("filter_area");
  if (mentionsArea && hasPlaceBoundaries) ops.push("filter_place");
  ops.push("per_area", "normalize", "aggregate", "rank", "join", "output");

  const sections = [
    PLAN_PREAMBLE,
    "Operations:\n" + ops.map(o => OP_LINES[o]).join("\n"),
    fieldRules(hasFeatureTables),
    opChoice(ops),
  ];
  if (hasFeatureTables) {
    sections.push(facilityNote(ops.includes("select_features")));
    // Only explain filters when some dataset on offer actually has them.
    if (hasFilterableValues) sections.push(FILTER_NOTE);
  }
  sections.push(
    EXAMPLES_HEADER,
    // One example per available op, so no op is demonstrated that the model
    // cannot actually use, and none it CAN use is left undemonstrated. The
    // filtered example is held back for the same reason: demonstrating a field
    // that is absent from the decoding schema teaches a plan it cannot emit.
    EXAMPLES
      .filter(e => ops.includes(e.op))
      .filter(e => hasFilterableValues || !e.usesFilters)
      .map(e => e.text)
      .join("\n\n"),
    INTENT_RULE);

  return sections.join("\n\n");
}

// Kept as an export for callers that want the full surface; generatePlan builds
// the narrowed variant per request.
const PLAN_SYSTEM_PROMPT = buildSystemPrompt({ hasFeatureTables: true });

/**
 * Present candidates under SHORT reference labels (a1, a2, ...) instead of raw
 * attr_ids.
 *
 * Real attr_ids look like "04d18a18_08_01_352". Asking a 4B model to copy one
 * verbatim, several times, fails constantly -- in testing it gave up and
 * invented positional placeholders ("attr_14"), which grounding then correctly
 * rejected, so the request produced nothing. Short labels remove the
 * transcription burden entirely; code maps them back, which is also the only
 * place that mapping can be trusted.
 */
function buildRefs(results, limit = 25) {
  const refs = new Map();      // label -> real attr_id
  const labelled = results.slice(0, limit).map((r, i) => {
    const label = `a${i + 1}`;
    refs.set(label, r.attr_id);
    return { label, r };
  });

  // Group by the purpose the decomposer assigned. A flat list wastes that
  // signal: for "poverty normalized by population" the correct denominator
  // ("Estimate|Total|Total population") WAS in the candidate list, tagged
  // normalization, and the planner still divided one poverty measure by
  // another. Separate sections tell it which pile the denominator comes from.
  const ORDER = ["primary", "normalization", "filter", "related"];
  const HEADINGS = {
    primary: "PRIMARY - the main quantity asked for",
    normalization: "NORMALIZATION - denominators for rates and per-capita figures",
    filter: "FILTER - qualifiers",
    related: "RELATED",
  };
  const groups = new Map(ORDER.map(k => [k, []]));
  for (const item of labelled) {
    const purpose = ORDER.includes(item.r.search_purpose) ? item.r.search_purpose : "related";
    groups.get(purpose).push(item);
  }

  const sections = [];
  for (const purpose of ORDER) {
    const items = groups.get(purpose);
    if (!items.length) continue;
    sections.push(`## ${HEADINGS[purpose]}`);
    for (const { label, r } of items) {
      // Mark facility datasets explicitly: the op to use differs, and the
      // model should not have to infer it from the wording.
      // Was " (use count_features)", which hard-coded one op. Since
      // select_features and nearest_distance also read these layers, naming a
      // single op here told the model the wrong thing whenever the question was
      // asking where things are rather than how many. The op-choice table
      // decides; this only says what KIND of dataset it is.
      const kind = r.is_feature_table ? " (mapped locations)" : "";
      sections.push(
        `${label}: ${(r.attr_desc || "").replace(/\s+/g, " ").slice(0, 120)}` +
        `${kind} [${r.entity_type || "?"}${r.start_date ? " " + r.start_date : ""}]`);

      // The values each filterable column actually holds, listed under the
      // dataset. This is the same discipline attr_ids follow: the model may
      // only cite values a tool returned to it. Without the list it invents
      // spellings -- "Critical Access" for "CRITICAL ACCESS" -- and a filter
      // that misses returns zero rows while looking like a valid answer.
      if (r.is_feature_table) {
        const cols = Object.entries(r.filter_values || {})
          .filter(([, values]) => values?.length);
        for (const [col, values] of cols) {
          const shown = values.slice(0, 8).map(v => `"${v}"`).join(", ");
          sections.push(
            `    filter ${col}: ${shown}${values.length > 8 ? ", ..." : ""}`);
        }
        // Say so explicitly when a layer has none. Left implicit, the model
        // generalised from the datasets that DO list filters and applied one to
        // a layer that has no such column -- three failed attempts on a query
        // that had worked before filters existed.
        if (!cols.length) sections.push(`    (no attribute filters for this dataset)`);
      }
    }
  }
  return { refs, text: sections.join("\n") };
}

/**
 * Swap reference labels back to real attr_ids before validation, so grounding
 * still checks the identifier that will actually be compiled.
 */
function derefPlan(plan, refs) {
  const unknown = [];
  // Every op that carries a reference label; all others use attr_id: "" by
  // schema convention. Missing one here leaves its label untranslated and
  // grounding then rejects a perfectly valid "a1" as an unknown attribute --
  // which is exactly what happened when count_features was first added.
  const LABEL_OPS = ["load", "count_features", "count_near", "nearest_distance",
                     "select_features"];
  for (const st of plan.steps || []) {
    if (!LABEL_OPS.includes(st.op)) continue;
    // count_near carries two labels: what to count, and what to be near.
    const fields = st.op === "count_near" ? ["attr_id", "near_attr_id"] : ["attr_id"];
    for (const field of fields) {
      if (!st[field] || !String(st[field]).trim()) continue;
      const key = String(st[field]).trim();
      if (refs.has(key)) st[field] = refs.get(key);
      else unknown.push(key);
    }
  }
  return unknown;
}

/**
 * Normalize step ids before validating.
 *
 * Two observed model habits:
 *   - decorating ids ("+step_3")
 *   - putting "" in the inputs array, copying the attr_id="" convention that
 *     non-load steps use. An empty input is never meaningful, and leaving it
 *     in produces a confusing 'input "" is not a step in this plan'.
 */
/**
 * Add the state a question named to a city-filtered locations step.
 *
 * City names are not unique. "fire stations in Springfield, Missouri" planned
 * `city: "Springfield"` with no state and returned 97 stations across 25
 * states, only 21 of them in Missouri. Both the op description and a worked
 * example set city and states together, and qwen3:14b still dropped the state
 * every time -- so it is applied here instead, where it is deterministic.
 *
 * Deliberately narrow: only when the step already filters by city, sets no
 * states of its own, and the question named exactly ONE place. Anything more
 * ambiguous is left alone rather than guessed at.
 *
 * @returns a description of the correction, or null if none applied.
 */
/**
 * A five-digit place name is a ZIP code, whatever the plan says it is.
 *
 * Observed: "counties in ZIP code 63101" planned
 * `place_kind: "place", place_name: "63101"`, which searched 32,642 city names
 * for one called 63101, found none, and returned zero rows from a plan that
 * validated. No municipality in the country is named as five digits, so this is
 * decidable in code rather than by asking the model again.
 *
 * @returns a description of the correction, or null.
 */
function repairPlaceKind(plan) {
  for (const st of plan.steps || []) {
    if (st.op !== "filter_place" || !st.place_name) continue;
    const looksLikeZip = /^\d{5}$/.test(String(st.place_name).trim());
    if (looksLikeZip && st.place_kind !== "zcta") {
      const was = st.place_kind;
      st.place_kind = "zcta";
      return `place_kind ${JSON.stringify(was)} -> "zcta" (${st.place_name} is a ZIP code)`;
    }
  }
  return null;
}

function applyImpliedState(plan, query) {
  const named = statesMentioned(query);
  if (named.length !== 1) return null;
  for (const st of plan.steps || []) {
    // Both ops name a place and both drop the state. filter_place was added
    // after this repair existed and immediately reproduced the bug: "counties
    // in the Springfield, Missouri area" filtered on the name alone and
    // returned 24 counties spread over Virginia, Nebraska, Illinois and the
    // rest, because 22 places are called Springfield.
    const namesAPlace =
      (st.op === "select_features" && st.city) ||
      (st.op === "filter_place" && st.place_name);
    if (!namesAPlace) continue;
    if (Array.isArray(st.states) && st.states.length) continue;
    st.states = [named[0]];
    return `${named[0]} (question named it; step filtered only by place name)`;
  }
  return null;
}

/**
 * A place name, and nothing else.
 *
 * Covers "St. Louis", "Winston-Salem", "O'Fallon". Must END in a letter: the
 * apostrophe and hyphen are legal inside a name but never at the end, and
 * allowing a trailing one let the leaked quote of "Springfield','states'..."
 * survive salvage as "Springfield'", which matches no city.
 */
const PLACE_NAME = /^[A-Za-z]([A-Za-z .'\-]*[A-Za-z])?$/;

/**
 * Recover a city value the decoder mangled.
 *
 * `city` is free text -- there is no city boundary layer to enumerate from --
 * so nothing constrains it, and roughly half of runs on "fire stations in
 * Springfield, Missouri" emitted
 *
 *     "city": "Springfield','states':['Missouri']"
 *
 * That is valid JSON, so it validated, compiled, and matched no city at all:
 * 0 features returned from a plan that looked entirely healthy. The clean half
 * of runs returned 21.
 *
 * The corruption is always a real name followed by structural debris, so
 * truncating at the first character that cannot occur in a place name recovers
 * the intent exactly. Logged, because a silent rewrite of what was searched for
 * would be its own problem.
 *
 * @returns a description of the repair, or null if none was needed.
 */
function sanitizeCity(plan) {
  for (const st of plan.steps || []) {
    if (!st.city || PLACE_NAME.test(st.city)) continue;
    const salvaged = (st.city.match(/^[A-Za-z][A-Za-z .'\-]*/) || [""])[0]
      .replace(/[ .'\-]+$/, "")   // drop trailing joiners left by the debris
      .trim();
    const before = st.city;
    if (salvaged.length >= 2) {
      st.city = salvaged;
      return `city ${JSON.stringify(before)} -> ${JSON.stringify(salvaged)}`;
    }
    // Nothing recoverable: drop it rather than search for garbage. The state
    // restriction, if any, still applies.
    delete st.city;
    return `dropped unusable city ${JSON.stringify(before)}`;
  }
  return null;
}

/**
 * Remove attribute filters the question never asked for.
 *
 * Narrowing the SCHEMA is request-level: the field is offered when any
 * candidate has filterable values. But the model then attaches a filter to
 * whichever dataset it picked, which may be one that has none -- observed
 * repeatedly on "locations of fire stations in Springfield, Missouri", where it
 * added `status` or `type` filters to a layer with neither. The validator
 * rejects it correctly and, at temperature 0.1, the repair loop re-emits the
 * same plan until the attempts run out: 3 of 6 runs failed outright.
 *
 * The discriminator is the question itself. A filter whose value does not
 * appear in the question was invented, and dropping it yields the plan the user
 * actually asked for. A filter the question DOES name is left alone, so
 * "critical access hospitals" still filters, and if that dataset cannot support
 * it the validator still says so rather than quietly widening the answer.
 *
 * @returns a description of what was dropped, or null.
 */
/**
 * Drop filters the chosen dataset physically cannot support.
 *
 * The last line of defence, and the one that actually fixed the failure. The
 * schema is narrowed per REQUEST, but the model picks the dataset per STEP, so
 * it can attach a filter to a layer that has no such column. Observed on
 * "locations of fire stations in Springfield, Missouri", where it emitted
 * `type = "fire station"` -- a value taken from the dataset's own NAME, which
 * therefore appears in the question and survives dropUnaskedFilters. Only the
 * resolved source knows the column does not exist.
 *
 * Dropped rather than rejected because rejection does not recover: at
 * temperature 0.1 the repair loop re-emitted the identical plan and the query
 * failed outright in 2-3 runs out of 6. Dropping yields the answer the question
 * asked for, and the adjustment is returned so the UI can say the filter was
 * not applied instead of quietly widening the result.
 */
async function dropUnsupportedFilters(plan, resolve) {
  const ids = (plan.steps || [])
    .filter(s => Array.isArray(s.attribute_filters) && s.attribute_filters.length)
    .map(s => s.attr_id)
    .filter(Boolean);
  if (!ids.length) return null;

  const resolved = await resolve(ids);
  const dropped = [];
  for (const st of plan.steps || []) {
    if (!Array.isArray(st.attribute_filters) || !st.attribute_filters.length) continue;
    const values = resolved.get(st.attr_id)?.filter_values || {};
    const kept = st.attribute_filters.filter(f => {
      if (values[f.column]?.length) return true;
      dropped.push(`${f.column}=${f.value}`);
      return false;
    });
    if (kept.length) st.attribute_filters = kept;
    else delete st.attribute_filters;
  }
  return dropped.length ? dropped.join(", ") : null;
}

function dropUnaskedFilters(plan, query) {
  const text = String(query || "").toLowerCase();
  const dropped = [];
  for (const st of plan.steps || []) {
    if (!Array.isArray(st.attribute_filters) || !st.attribute_filters.length) continue;
    const kept = st.attribute_filters.filter(f => {
      const value = String(f?.value ?? "").toLowerCase().trim();
      if (!value) return false;
      if (text.includes(value)) return true;
      // Multi-word values may be phrased loosely ("critical-access"); require
      // every word to appear rather than the exact string.
      const words = value.split(/\s+/).filter(w => w.length > 2);
      if (words.length && words.every(w => text.includes(w))) return true;
      dropped.push(`${f.column}=${f.value}`);
      return false;
    });
    if (kept.length) st.attribute_filters = kept;
    else delete st.attribute_filters;
  }
  return dropped.length ? dropped.join(", ") : null;
}

/**
 * Correct a states list the model enumerated badly.
 *
 * Two separate repairs, both deterministic:
 *
 * 1. DUPLICATES. Observed on "counties in the South": 38 entries with New York,
 *    New Jersey, Pennsylvania, Maryland, Delaware and six New England states
 *    each listed twice. Harmless to the SQL, but it is a signal the enumeration
 *    ran away, and it makes the plan unreadable in the report.
 *
 * 2. A NAMED CENSUS REGION THE MODEL GOT WRONG. That same query returned a list
 *    spanning three regions: the census South plus the entire Northeast plus
 *    Arizona and New Mexico. 1,685 counties from Arizona to Maine, from a plan
 *    that validated. Every name was a real state, so grounding could not catch
 *    it; only the region definition can.
 *
 * The second repair applies ONLY when the question names exactly one census
 * region and no individual state, so "the South and California" is left alone
 * rather than guessed at. For any OTHER regional phrase, New England, the Rust
 * Belt, the Gulf Coast, the model's enumeration stands: it is the thing that
 * knows what those mean, and the enum guarantees each name is a real state.
 *
 * @returns a description of what was corrected, or null.
 */
function repairStates(plan, query) {
  const notes = [];
  const named = statesMentioned(query);
  const regions = named.filter(n => REGIONS[n]);
  const singleRegion = regions.length === 1 && named.length === 1 ? regions[0] : null;

  for (const st of plan.steps || []) {
    if (!Array.isArray(st.states) || !st.states.length) continue;

    const deduped = [...new Set(st.states)];
    if (deduped.length !== st.states.length) {
      notes.push(`removed ${st.states.length - deduped.length} duplicate state(s)`);
    }
    st.states = deduped;

    if (!singleRegion) continue;
    const expected = REGIONS[singleRegion];
    const extra = st.states.filter(s => s !== singleRegion && !expected.includes(s));
    // Tolerate the model naming the region itself, or listing its members.
    if (!extra.length) continue;
    st.states = [singleRegion];
    notes.push(
      `restricted to the ${singleRegion} (the plan listed ${extra.length} state(s) ` +
      `outside it, including ${extra.slice(0, 3).join(", ")})`);
  }
  return notes.length ? notes.join("; ") : null;
}

function normalizeIds(plan) {
  const fix = (v) => String(v).trim().replace(/^[^A-Za-z]+/, "");
  for (const st of plan.steps || []) {
    st.id = fix(st.id);
    if (Array.isArray(st.inputs)) {
      st.inputs = st.inputs.map(fix).filter(Boolean);
    }
  }
}

/**
 * Ask the model for a plan, then validate it. On failure, hand the errors back
 * and let it correct its own work -- this converts most hard failures into a
 * slightly slower success.
 */
async function generatePlan({
  query, candidates, callLLM, resolve,
  // Whether place_geom holds named boundaries. Passed in rather than probed
  // here so the planner stays free of database access.
  hasPlaceBoundaries = false,
  log = console.log,
  // Structured progress, separate from `log`. `log` writes prose for a human
  // reading container output; `emit` carries machine-readable stages so the
  // planned SSE stream (docs/AI-PIPELINE.md section 5, nginx already has
  // proxy_buffering off for it) can forward them without re-plumbing this
  // function. No-op by default, so nothing changes until a caller passes one.
  emit = () => {},
}) {
  const attempts = [];
  let repairContext = "";
  // Deterministic repairs applied to the model's plan, surfaced to the caller
  // so a silently-widened result is never presented as the question asked.
  const adjustments = [];

  const { refs, text: attrText } = buildRefs(candidates);

  // Narrow the op set to what this query can actually use. Both the decoding
  // schema and the prompt are built from the same three facts, so they cannot
  // disagree about which ops exist.
  //
  // count_near is gated on TWO distinct facility datasets rather than one: it
  // measures one against the other, so with a single dataset it is unusable by
  // construction and would only enlarge the decision space.
  const featureTables = new Set(
    candidates.filter(c => c.is_feature_table).map(c => c.attr_id));
  const hasFeatureTables = featureTables.size > 0;
  const featureTableCount = featureTables.size;
  const mentionsArea = queryMentionsArea(query);
  const wantsLocations = queryWantsLocations(query);
  // Any dataset on offer that actually has values to filter on. Without this,
  // the field was shown for layers that have none and the model used it anyway.
  const hasFilterableValues = candidates.some(
    c => c.is_feature_table &&
         Object.values(c.filter_values || {}).some(v => v?.length));

  const narrowing = {
    hasFeatureTables, featureTableCount, mentionsArea, wantsLocations,
    hasFilterableValues, hasPlaceBoundaries,
  };
  const schema = planSchemaFor(narrowing);
  const systemPrompt = buildSystemPrompt(narrowing);

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const userPrompt =
      `QUESTION: ${query}\n\n` +
      `AVAILABLE ATTRIBUTES (use these labels as attr_id):\n${attrText}\n` +
      repairContext;

    emit({ stage: "planning", attempt: attempt + 1, of: MAX_REPAIRS + 1 });
    const raw = await callLLM(systemPrompt, userPrompt, 0.1, schema);
    if (!raw) {
      attempts.push({ attempt, errors: ["LLM returned nothing"] });
      continue;
    }

    let plan;
    try {
      plan = JSON.parse(raw);
    } catch (err) {
      // Should be impossible under constrained decoding; recorded rather than
      // silently retried so it is visible if the assumption ever breaks.
      attempts.push({ attempt, errors: [`unparseable despite schema: ${err.message}`] });
      continue;
    }

    normalizeIds(plan);
    const unasked = dropUnaskedFilters(plan, query);
    if (unasked) {
      log(`   Dropped filter(s) the question did not ask for: ${unasked}`);
      emit({ stage: "plan_adjusted", detail: `dropped unasked filter ${unasked}` });
    }
    const kindFix = repairPlaceKind(plan);
    if (kindFix) {
      log(`   Repaired place kind: ${kindFix}`);
      emit({ stage: "plan_adjusted", detail: kindFix });
    }
    const statesFix = repairStates(plan, query);
    if (statesFix) {
      log(`   Repaired states list: ${statesFix}`);
      emit({ stage: "plan_adjusted", detail: statesFix });
      adjustments.push(`Area restriction corrected: ${statesFix}.`);
    }
    const cityFix = sanitizeCity(plan);
    if (cityFix) {
      log(`   Repaired malformed city value: ${cityFix}`);
      emit({ stage: "plan_adjusted", detail: cityFix });
    }
    const implied = applyImpliedState(plan, query);
    if (implied) {
      log(`   Added implied state restriction: ${implied}`);
      emit({ stage: "plan_adjusted", detail: `restricted to ${implied}` });
    }
    const unknownRefs = derefPlan(plan, refs);
    // After deref, attr_ids are real, so the dataset's own columns can be
    // consulted. Must run before validation, which would otherwise reject.
    if (!unknownRefs.length) {
      const unsupported = await dropUnsupportedFilters(plan, resolve);
      if (unsupported) {
        log(`   Dropped filter(s) this dataset cannot support: ${unsupported}`);
        emit({ stage: "plan_adjusted", detail: `dropped unsupported filter ${unsupported}` });
        adjustments.push(`Filter ${unsupported} was not applied: this dataset has no such attribute.`);
      }
    }
    if (unknownRefs.length) {
      const errors = unknownRefs.map(r =>
        `attr_id "${r}" is not one of the available labels. ` +
        `Use exactly one of: ${[...refs.keys()].join(", ")}`);
      log(`   Plan used ${unknownRefs.length} unknown label(s)`);
      attempts.push({ attempt, errors, plan });
      repairContext =
        `\nYour previous plan was rejected:\n` + errors.map(e => `- ${e}`).join("\n") +
        `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
      continue;
    }

    const check = await validatePlan(plan, resolve);
    if (check.ok) {
      log(`   Plan valid on attempt ${attempt + 1} (${plan.steps.length} steps)`);
      emit({
        stage: "plan_valid",
        attempt: attempt + 1,
        intent: plan.intent,
        ops: plan.steps.map(s => s.op),
      });
      return {
        ok: true, plan, resolved: check.resolved, attempts, repairs: attempt,
        // Deduped: the repair loop re-applies the same correction on every
        // attempt, and reporting it three times reads as three separate
        // problems rather than one.
        adjustments: [...new Set(adjustments)],
      };
    }

    log(`   Plan invalid (attempt ${attempt + 1}): ${check.errors.length} error(s)`);
    emit({ stage: "plan_invalid", attempt: attempt + 1, errors: check.errors });
    attempts.push({ attempt, errors: check.errors, plan });

    repairContext =
      `\nYour previous plan was rejected. Fix these problems and return a ` +
      `corrected plan:\n` +
      check.errors.map(e => `- ${e}`).join("\n") +
      `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
  }

  return {
    ok: false,
    errors: attempts.at(-1)?.errors ?? ["no plan produced"],
    attempts,
    repairs: MAX_REPAIRS,
  };
}

/**
 * Compile a validated plan and run it. Read-only by construction: the compiler
 * emits a single SELECT, and this runs inside a read-only transaction as a
 * second line of defence.
 */
async function executePlan(plan, resolved, pool, { timeoutMs = 30000 } = {}) {
  const compiled = compilePlan(plan, resolved);
  const { sql, params, mode } = compiled;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    const started = Date.now();
    const res = await client.query(sql, params);
    await client.query("COMMIT");

    // A select_features plan returns individual locations: each row is its own
    // geometry plus whatever label columns that layer happens to carry. There
    // is no fips and no single "value", so it is shaped as GeoJSON features
    // rather than forced into the (fips, value) row contract.
    if (mode === "features") {
      const labels = compiled.labels || [];
      return {
        sql, params, mode,
        row_count: res.rowCount,
        ms: Date.now() - started,
        rows: [],
        features: res.rows.map(r => ({
          type: "Feature",
          geometry: r.geometry ? JSON.parse(r.geometry) : null,
          properties: Object.fromEntries(labels.map(c => [c, r[c] ?? null])),
        })).filter(f => f.geometry),
      };
    }

    return {
      sql,
      params,
      mode,
      row_count: res.rowCount,
      ms: Date.now() - started,
      rows: res.rows.map(r => ({
        fips: r.fips,
        name: r.name,
        state_fp: r.state_fp,
        value: r.value === null ? null : Number(r.value),
      })),
      // GeoJSON kept separate: it dwarfs the tabular payload and most callers
      // (charts, tables) do not need it.
      geometry: res.rows
        .filter(r => r.geometry)
        .map(r => ({ fips: r.fips, geometry: JSON.parse(r.geometry) })),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  generatePlan, executePlan, buildSystemPrompt, queryWantsLocations,
  PLAN_SYSTEM_PROMPT, MAX_REPAIRS, CompileError,
};
