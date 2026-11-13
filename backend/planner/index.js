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
const { queryMentionsArea, statesMentioned, REGIONS, STATE_FIPS } = require("../states");
const { validatePlan } = require("./validate");
const { checkRelevance, usedAttributes } = require("./relevance");
const { checkNamedData } = require("./named_data");
const { preferCoverage } = require("./coverage");
const { unaskedSubjectErrors } = require("./outcome");
const { derefDefinitions, checkThresholds, LAYER_PHRASES, GROUP_COMPARISON,
        COMPLEMENT_PHRASES } = require("./conditions");
const { anchorYears, spans } = require("./vintages");
const { applyLevel, applyRollup } = require("./levels");
const { repairDistanceUnits, repairWithinDirection, widenReferenceLayer, applyAreaUnit, applyMeasures, applyRasterMeasures, fillRasterClasses, yearAsVintage } = require("./features");
const { preferUserLayer } = require("../user_layers");
const { applyCatchment } = require("./catchment");
const { repairPrecision } = require("./uncertainty");
const { seriesUnit } = require("./units");
const { loadLabelInputs, splitOutputs, dropRateOverCount, earlierResultSecond,
        areaAfterAccess, totalTheDenominator, bridgeFromLoadedLayer, bridgeInputsToIntersect, restrictToEarlier, uninvertChains, orderChangeByYear, addMissingOutput } = require("./rewire");
const { compilePlan, CompileError } = require("./compile");
const opsRegistry = require("./ops");

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
  // "with fire stations on top", "overlay hospitals": a layer of facilities
  // is their locations, so the locations op must be on the menu.
  if (LAYER_PHRASES.test(String(query))) return true;
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
  scale 100 for a percentage. Never divide one PRIMARY attribute by another.`;

/**
 * The closing rule. "Exactly one output" for every question except one that
 * asks to see several things on ONE map (LAYER_PHRASES), which gets one output
 * per layer. Built from parts so the ungated text is byte-identical.
 */
const outputRule = (ctx) => (wantsLayers(ctx)
  ? `- End with one "output" step for EACH layer the question asks to see on the map.`
  : `- End with exactly one "output" step.`);

const wantsLayers = (ctx) => LAYER_PHRASES.test(String(ctx.query || ""));

/**
 * Shown only for an "on one map" question. The compiler and executor have run
 * several outputs, each its own layer, since the plan became a DAG; the
 * planner was never told, so a request to overlay two things got one.
 */
const LAYERS_NOTE = `SEVERAL LAYERS ON ONE MAP

  This question asks to see more than one thing on the same map. Build each
  one as its own branch and give EACH branch its own "output" step; each output
  becomes a separate map layer the reader can stack, recolour and reorder.

  QUESTION: map the unemployment rate in Ohio with fire stations on top
    (a2 = unemployment rate, a6 = Fire Stations (mapped locations))
  PLAN: {"intent":"Unemployment rate by Ohio county, with fire station locations as a second layer",
   "output_type":"map","entity_type":"COUNTY",
   "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
            {"id":"s2","op":"filter_area","attr_id":"","inputs":["s1"],"states":["Ohio"]},
            {"id":"s3","op":"output","attr_id":"","inputs":["s2"]},
            {"id":"s4","op":"select_features","attr_id":"a6","inputs":[],"states":["Ohio"]},
            {"id":"s5","op":"output","attr_id":"","inputs":["s4"]}]}
  NOTE: two outputs, one per layer. Do not join, normalize or correlate the
  layers unless the question asks for that too.`;

// The prompt is assembled from the op registry. Each op owns its own line, its
// phrasing hint and its worked examples, so an op cannot be described here
// without also bringing its validation and its compilation -- which is the leak
// the old `.replace(/ and count_features;/, ";")` was patching by hand.
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
  const lines = opsRegistry.inChoiceOrder(ops)
    .map(n => opsRegistry.byName(n).choiceLine);
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

/**
 * Shown only when the question has a time dimension, like FILTER_NOTE. Most
 * questions want the current figure and should never see a year field to get
 * wrong -- and a model told about years on a question with no time in it is a
 * model given one more way to answer something that was not asked.
 */
const YEAR_NOTE = `This question mentions time, so "load" accepts a "year".

  Leave year out for the most recent figure. That is the default, and it is the
  right choice whenever the question is about how things are now.

  To compare two points in time, load the SAME attribute twice with different
  years and combine them:

    {"id":"s1","op":"load","attr_id":"a2","inputs":[],"year":2013}
    {"id":"s2","op":"load","attr_id":"a2","inputs":[],"year":2023}
    {"id":"s3","op":"combine","attr_id":"","inputs":["s1","s2"],"operation":"percent_change"}

  percent_change reads as change FROM input 1 TO input 2, so put the earlier
  year first. Not every attribute has every year; if one is missing the result
  is empty rather than wrong.`;

/**
 * Shown only when filter_attr has a threshold source beyond a stated number:
 * a qualifier with no number in the question ("high", "few"), or a definition
 * listed under a retrieved attribute. Gated on exactly what gates the fields,
 * so the prompt never explains a field the schema has dropped.
 */
const conditionsNote = (ctx) => {
  const pct = opsRegistry.fieldOffered("percentile", ctx);
  const def = opsRegistry.fieldOffered("definition", ctx);
  const lines = [`CONDITIONS

  A condition on a measure is a filter_attr step on THAT measure. Take the
  threshold from, in this order:`];
  if (def) {
    lines.push(`
  - a DEFINITION listed under the attribute (d1, d2 ...), when the question
    uses that term ("rural", "high poverty"):
      {"id":"s4","op":"filter_attr","attr_id":"","inputs":["s3"],"definition":"d1"}
    It is a published cut on that exact measure; never retype its number.`);
  }
  lines.push(`
  - a NUMBER the question states ("above 20 percent"): operator and value.`);
  if (pct) {
    lines.push(`
  - otherwise, for "high", "low", "many", "few", "above average" with no number,
    a PERCENTILE of the measure's own values instead of a guessed number:
      high / many / top quarter    "operator":">=","percentile":75
      low / few / bottom quarter   "operator":"<=","percentile":25
      above / below the median     "operator":">" or "<","percentile":50`);
  }
  if (opsRegistry.offeredFor(ctx).includes("intersect")) {
    lines.push(`
  Several conditions on DIFFERENT measures: filter each one separately, then
  combine them with intersect. Never filter one measure for another's condition.`);
  }
  return lines.join("\n");
};

/**
 * Shown only inside a research workflow, when earlier results are on offer.
 * Teaches the two shapes a later step needs: restrict a measure to an earlier
 * step's counties, and to every other county.
 */
const EARLIER_NOTE = `EARLIER RESULTS

  Labels under EARLIER RESULTS are sets of counties produced by earlier steps
  of this analysis. Load one like any attribute. To look at a measure ONLY in
  those counties, intersect the measure with it:
    {"id":"s1","op":"load","attr_id":"a4","inputs":[]}
    {"id":"s2","op":"load","attr_id":"a1","inputs":[]}
    {"id":"s3","op":"intersect","attr_id":"","inputs":["s1","s2"]}
  For every OTHER county ("the rest of the country"), the same intersect with
  "exclude": true. To set the two against each other, compare_groups(s3, s4).
  When the question refers to an earlier result, the plan must use it.`;

const EXAMPLES_HEADER = `WORKED EXAMPLES

Each is a QUESTION and the correct PLAN for it. The op sequence and the intent
are different in every one, because both follow from the question. Carrying a
shape or an intent from an example over to a different question is the single
most common way to get this wrong.`;

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
 *
 * The offered set comes from the registry, which is the SAME call planSchemaFor
 * makes. Those two used to be separate hand-maintained lists that had to agree,
 * and an op named here but absent from the decoding enum costs a repair round
 * on a plan the model was never able to emit.
 */
function buildSystemPrompt(ctx = {}) {
  const {
    hasFeatureTables = false, wantsLocations = false, hasFilterableValues = false,
  } = ctx;
  const ops = opsRegistry.offeredFor(ctx);

  const sections = [
    `${PLAN_PREAMBLE}\n${outputRule(ctx)}`,
    "Operations:\n" + opsRegistry.inPromptOrder(ops)
      .map(n => {
        // A gated variant of an op's line (select_features, when the feature
        // ops are on offer), else the line every other prompt has always had.
        const mod = opsRegistry.byName(n);
        return (mod.promptLineFor && mod.promptLineFor(ctx)) || mod.promptLine;
      }).join("\n"),
    fieldRules(hasFeatureTables),
    opChoice(ops),
  ];
  if (hasFeatureTables) {
    sections.push(facilityNote(ops.includes("select_features")));
    // Only explain filters when some dataset on offer actually has them.
    if (hasFilterableValues) sections.push(FILTER_NOTE);
  }
  // Explaining a field the decoding schema has dropped teaches a plan the model
  // cannot emit, so this is gated on exactly the same predicate the schema uses.
  if (opsRegistry.fieldOffered("year", ctx)) sections.push(YEAR_NOTE);
  if (wantsLayers(ctx)) sections.push(LAYERS_NOTE);
  if (ctx.hasEarlierResults === true) sections.push(EARLIER_NOTE);
  if (opsRegistry.fieldOffered("percentile", ctx) || opsRegistry.fieldOffered("definition", ctx)) {
    sections.push(conditionsNote(ctx));
  }
  sections.push(
    EXAMPLES_HEADER,
    opsRegistry.examplesFor(ops, ctx).join("\n\n"),
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
  // Definition labels (d1, d2 ...) -> the definition, for derefDefinitions.
  // Numbered across the whole list, so a label is never ambiguous.
  const defRefs = new Map();
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
  // "expanded" is literature expansion (backend/expansion.js): attributes the
  // question never named. Last, and labelled as such, so the planner reaches
  // for them only when the question asks about causes or related factors. No
  // candidate carries it unless expansion ran, so every existing prompt is
  // byte-identical.
  // "earlier" is a result an earlier step of a research workflow produced
  // (backend/workflow.js). First, because a step that says "those counties"
  // is about exactly that set. No candidate carries it outside a workflow.
  const ORDER = ["earlier", "primary", "normalization", "filter", "related", "expanded"];
  const HEADINGS = {
    earlier: "EARLIER RESULTS - counties an earlier step of this analysis produced, with that step's value",
    primary: "PRIMARY - the main quantity asked for",
    normalization: "NORMALIZATION - denominators for rates and per-capita figures",
    filter: "FILTER - qualifiers",
    related: "RELATED",
    expanded: "LINKED IN MEDICAL LITERATURE - not named in the question; use only if it asks about causes, risk factors or related conditions",
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
      const kind = r.is_feature_table ? " (mapped locations)"
        : r.is_raster ? ` (raster${r.raster_kind === "categorical" ? " of land classes" : ""}` +
          // Years only when there is a choice: "years 2026" on a one-vintage
          // DEM read as a value to filter on, and the planner chained
          // filter_attr(= 2026) without end (H4 dev, 2026-11-12).
          `${r.years?.length > 1 ? `, years ${r.years.join(", ")}` : ""}; use zonal)` : "";
      sections.push(
        `${label}: ${(r.attr_desc || "").replace(/\s+/g, " ").slice(0, 120)}` +
        `${kind} [${r.entity_type || "?"}${r.start_date ? " " + r.start_date : ""}]`);

      // The values each filterable column actually holds, listed under the
      // dataset. This is the same discipline attr_ids follow: the model may
      // only cite values a tool returned to it. Without the list it invents
      // spellings -- "Critical Access" for "CRITICAL ACCESS" -- and a filter
      // that misses returns zero rows while looking like a valid answer.
      if (r.is_feature_table || r.is_raster) {
        const cols = Object.entries(r.filter_values || {})
          .filter(([, values]) => values?.length);
        for (const [col, values] of cols) {
          // A raster's whole legend (groups first, then classes): cut at 8,
          // NLCD showed its groups and hid "Cultivated Crops".
          const cap = r.is_raster ? 40 : 8;
          const shown = values.slice(0, cap).map(v => `"${v}"`).join(", ");
          sections.push(
            `    ${r.is_raster ? "classes" : "filter"} ${col}: ${shown}${values.length > cap ? ", ..." : ""}`);
        }
        // Say so explicitly when a layer has none. Left implicit, the model
        // generalised from the datasets that DO list filters and applied one to
        // a layer that has no such column -- three failed attempts on a query
        // that had worked before filters existed.
        if (!cols.length) sections.push(`    (no attribute filters for this dataset)`);
      }

      // Published definitions of a term ON THIS MEASURE, already checked
      // against the loaded data (backend/definitions.js). Listed under the
      // attribute so the model sees which measure a definition belongs to;
      // the numbers are shown for the reader, and code applies them.
      // Absent unless retrieval returned a defined measure, so every prompt
      // without one is byte-identical.
      for (const d of r.definitions || []) {
        const dl = `d${defRefs.size + 1}`;
        defRefs.set(dl, d);
        sections.push(
          `    ${dl} = "${d.term}": value ${d.op} ${d.value} (${d.selected} of ${d.n} counties)`);
      }
    }
  }
  return { refs, defRefs, text: sections.join("\n") };
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
  //
  // Which fields carry a label now comes from the registry (each op's
  // `grounds`), not a list kept here: that list missed `access` the day it
  // was added, and the 2SFCA question was refused three attempts running for
  // citing "a8", a label that was on its list (2026-11-11).
  for (const st of plan.steps || []) {
    // count_near carries two labels: what to count, and what to be near.
    const fields = (opsRegistry.byName(st.op)?.grounds || []).map(g => g.field);
    if (!fields.length) continue;
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
/**
 * "Cook County" as a place_name is a county, not a city or a ZIP: planned as
 * filter_place(zcta, "Cook County") it failed the ZIP-shape check, and the
 * retries lost the output step (2026-11-11). Sets the internal kind "county"
 * (ops/filter_place.js compileCounty) and the bare name county_geom stores.
 */
function repairCountyKind(plan) {
  for (const st of plan.steps || []) {
    if (st.op !== "filter_place" || st.place_kind === "county") continue;
    const m = String(st.place_name || "").match(/^(.+?)\s+(?:County|Parish|Borough)$/i);
    if (!m) continue;
    const was = st.place_kind;
    st.place_kind = "county";
    st.place_name = m[1].trim();
    return `"${m[0]}" read as a county (planned as place_kind ${JSON.stringify(was)})`;
  }
  return null;
}

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

/**
 * "Around Detroit", "the Chicago area", "greater Boston": a metro, not a city.
 *
 * With no state, place_kind "place" matches every town of that name: "What are
 * the poverty rates around Detroit?" kept counties in Texas, Alabama,
 * Illinois, Oregon and Kansas besides Wayne, MI, in every run once the poverty
 * measure was right (2026-11-10, research.yaml r-poverty-detroit). Metro names
 * are compound ("Detroit-Warren-Dearborn, MI") and match "Detroit" without
 * matching "Detroit Lakes, MN", so the metro reading is both what an area
 * phrase means and far less ambiguous. A step that carries a state is left
 * alone: "the Springfield, Missouri area" is the city, as before.
 */
const METRO_PHRASE = /\b(?:around|surrounding|near|metro|metropolitan|greater)\b|\barea\b/i;

function repairMetroKind(plan, query) {
  if (!METRO_PHRASE.test(String(query || ""))) return null;
  for (const st of plan.steps || []) {
    if (st.op !== "filter_place" || st.place_kind !== "place" || !st.place_name) continue;
    if (Array.isArray(st.states) && st.states.length) continue;
    st.place_kind = "cbsa";
    return `"${st.place_name}" read as its metro area (the question asks about an area, ` +
           `and names no state)`;
  }
  return null;
}

/**
 * The question names one state and the plan restricts to nothing.
 *
 * "the most densely populated 4 km grid cells in Colorado" planned load ->
 * per_area -> rank over all 613,889 US cells (190 s, 993 of 1,000 rows outside
 * Colorado), 2 of 2; "fire stations in each county of Colorado" has lost its
 * state the same way since Phase A. With exactly one state named, no second
 * area, no comparison and no restriction anywhere in the plan, the only
 * reading is that the restriction was dropped. Added in front of each output
 * that reads a per-unit series; a features step takes it in its own `states`.
 */
function addAskedState(plan, query) {
  const named = statesMentioned(query);
  if (named.length !== 1 || !STATE_FIPS[named[0]]) return null;
  if (GROUP_COMPARISON.test(query) || COMPLEMENT_PHRASES.test(query)) return null;
  const steps = plan.steps || [];
  const restricted = steps.some(st =>
    ["filter_area", "filter_place", "compare_groups"].includes(st.op) ||
    (Array.isArray(st.states) && st.states.length) || st.city);
  if (restricted || !steps.length) return null;
  const byId = new Map(steps.map(st => [st.id, st]));
  const ids = new Set(steps.map(st => st.id));
  const added = [];
  for (const out of steps.filter(st => st.op === "output")) {
    const src = byId.get((out.inputs || [])[0]);
    const mod = src && opsRegistry.byName(src.op);
    if (!mod) continue;
    if (mod.produces === "features") { src.states = [named[0]]; added.push(src.id); continue; }
    if (mod.produces !== "series" || mod.statColumns) continue;
    let id = `${src.id}_in_state`;
    while (ids.has(id)) id += "_";
    ids.add(id);
    steps.splice(steps.indexOf(out), 0,
      { id, op: "filter_area", attr_id: "", inputs: [src.id], states: [named[0]] });
    out.inputs = [id];
    added.push(id);
  }
  return added.length ? `${named[0]} (the question names it; the plan restricted to nothing)` : null;
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

/**
 * An attribute filter whose value is not a value of that layer but IS the
 * name of another retrieved layer means that layer. "List the 10 nursing homes
 * in Montana that are farthest from a hospital" planned the reference step as
 * Nursing Homes filtered to type "HOSPITAL", and re-emitted it on all three
 * repair attempts although the error listed the valid values and Hospitals was
 * on the list (2026-11-11). The step is pointed at the named layer and the
 * filter dropped; a value the layer does hold is never touched.
 */
async function filterValueAsLayer(plan, resolve, candidates) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ")
    .trim().replace(/s$/, "");
  const layers = new Map();
  for (const c of candidates || []) {
    if (!c.is_feature_table) continue;
    const key = norm(c.dataset_clean || String(c.attr_desc || "").replace(/\s*\(mapped locations\)\s*$/i, ""));
    if (key && !layers.has(key)) layers.set(key, c);
  }
  const steps = (plan.steps || []).filter(s => Array.isArray(s.attribute_filters) && s.attribute_filters.length && s.attr_id);
  if (!steps.length || !layers.size) return null;
  const resolved = await resolve(steps.map(s => s.attr_id));
  const fixes = [];
  for (const st of steps) {
    const values = resolved.get(st.attr_id)?.filter_values || {};
    for (const f of [...st.attribute_filters]) {
      const held = (values[f.column] || []).some(v => String(v).toLowerCase() === String(f.value).toLowerCase());
      const other = layers.get(norm(f.value));
      if (held || !other) continue;
      if (other.attr_id === st.attr_id) {
        // The value is the step's OWN layer's name: it restates the layer,
        // it does not narrow it. "SNAP-authorized food retailers per square
        // kilometer" filtered SNAP Authorized Food Retailers to type "SNAP
        // Authorized Food Retailers", 3 of 3 attempts (H2 r2, 2026-11-11).
        fixes.push(`step ${st.id}: dropped ${f.column}="${f.value}", the layer's own name`);
        st.attribute_filters = st.attribute_filters.filter(x => x !== f);
        if (!st.attribute_filters.length) delete st.attribute_filters;
        continue;
      }
      fixes.push(`step ${st.id} reads ${other.dataset_clean || other.attr_id}, which the filter ${f.column}="${f.value}" named`);
      st.attr_id = other.attr_id;
      st.attribute_filters = st.attribute_filters.filter(x => x !== f);
      if (!st.attribute_filters.length) delete st.attribute_filters;
      break;
    }
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * A filter_attr "= N" where the question never states N. "What is the average
 * elevation of each St. Louis ward?" planned zonal -> filter_attr(= 1) ->
 * output (H4 dev, 2026-11-12): valid, executable, and empty. An equality on a
 * measured value nobody asked for can only delete the answer. The step is
 * removed and its readers read its input. Inequalities are left alone: "big
 * counties" legitimately becomes a threshold the question does not state.
 */
/** A copy of a plan schema whose op enum leaves out `ops`. */
function withoutOps(schema, ops) {
  const copy = JSON.parse(JSON.stringify(schema));
  const op = copy?.properties?.steps?.items?.properties?.op;
  if (op?.enum) op.enum = op.enum.filter(o => !ops.has(o));
  return copy;
}

function dropUnaskedEquality(plan, query) {
  const stated = new Set((String(query || "").match(/\d+(?:\.\d+)?/g) || []).map(Number));
  const steps = plan.steps || [];
  const fixes = [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // Only on a raster-derived value (a zonal result), where the habit was seen.
  // On counts it is a real question: "rural counties ... and no hospital"
  // filters count_features "= 0", which the first version of this repair
  // dropped, returning 363 counties for 93 (H4 guards, research.yaml).
  const fromZonal = (id) => {
    let cur = byId.get(id);
    for (let i = 0; cur && i < steps.length; i++) {
      if (cur.op === "zonal") return true;
      if (!["filter_attr", "filter_area", "filter_place", "rank"].includes(cur.op)) return false;
      cur = byId.get((cur.inputs || [])[0]);
    }
    return false;
  };
  for (const st of [...steps]) {
    if (st.op !== "filter_attr" || st.operator !== "=" || st.value === undefined ||
        st.definition || st.percentile !== undefined || stated.has(Number(st.value))) continue;
    const src = (st.inputs || [])[0];
    if (!src || !fromZonal(src)) continue;
    for (const o of steps) o.inputs = (o.inputs || []).map(i => (i === st.id ? src : i));
    plan.steps = plan.steps.filter(s => s !== st);
    fixes.push(`step ${st.id} (value = ${st.value}, which the question does not state)`);
  }
  return fixes.length ? fixes.join("; ") : null;
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
      // A word counts by its stem: "Cultivated Crops" for "cultivated
      // cropland" (H4 dev: the class filter was dropped, and the zonal step
      // averaged class CODES). Trailing s / es / ies only.
      const stem = (w) => w.replace(/(?:ies|es|s)$/, "");
      const words = value.split(/[\s,/]+/).filter(w => w.length > 2);
      if (words.length && words.every(w => text.includes(w) || (stem(w).length > 3 && text.includes(stem(w))))) return true;
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

/**
 * Resolve a question's TIME reference into concrete years on the load steps.
 *
 * Measured on held-out queries: "has unemployment gotten better or worse since
 * 2010" planned `load -> load -> normalize` over TWO DIFFERENT attributes and
 * divided one by the other, and its own intent said so -- "compare unemployment
 * rates from 2000 and 2018". "Which counties saw the biggest increase in
 * poverty over the last decade" did the same. The year field was on offer in
 * both cases and went unused.
 *
 * The prompt already carries a worked example for the explicit form ("percent
 * change from 2007 to 2023") and it holds for that phrasing only. Relative time
 * -- "since 2010", "over the last decade", "in 2009" -- has no anchor in the
 * text, and asking the model to resolve it is asking it to guess at something
 * the database already knows. So it is resolved here, deterministically, the
 * same way applyImpliedState resolves a dropped state.
 *
 * Two shapes are repaired:
 *   - a single load, and the question names one year   -> stamp that year
 *   - two loads feeding a combine/normalize, and the question spans a period
 *     -> make BOTH read the same attribute at the two ends of that period
 *
 * The second is the aggressive one, and it is deliberate: two different
 * attributes divided by each other is not a trend under any reading, so the
 * plan was already wrong. Leaving the later year unset means "the most recent
 * this measure has", which the compiler resolves per measure.
 *
 * Returns a description of what changed, or null.
 */
const YEAR_IN_QUERY = /(?<!\d)(19[5-9]\d|20[0-4]\d)(?!\d)/g;

function resolveRelativeYears(plan, query) {
  const q = String(query || "");
  // The same test the `year` field is gated on, stated locally rather than
  // reached for through the registry: this repair must behave identically
  // whether or not the field happened to be offered.
  const TEMPORAL =
    /\b(19\d{2}|20\d{2}|trends?|over time|since|growth|grew|shrank|declin\w*|increas\w*|decreas\w*|change\s+(from|in|since|between)|year[- ]over[- ]year|historical|last\s+decade|past\s+decade)\b/i;
  if (!TEMPORAL.test(q)) return null;

  const named = [...new Set((q.match(YEAR_IN_QUERY) || []).map(Number))].sort();
  const now = new Date().getFullYear();
  let span = null;                       // [earlier, later|null]
  // How many years back, when the period is counted rather than named. The
  // calendar count below is provisional: anchorYears (planner/vintages.js)
  // re-counts it from the measure's own latest year once ids are real.
  let back;

  const lastN = q.match(/\b(?:last|past|previous)\s+(\d{1,2})\s+years?\b/i);
  const decade = /\b(?:last|past|previous)\s+decade\b/i.test(q);

  if (named.length >= 2)      span = [named[0], named[named.length - 1]];
  else if (/\bsince\b/i.test(q) && named.length === 1) span = [named[0], null];
  else if (lastN)             { back = Number(lastN[1]); span = [now - back, null]; }
  else if (decade)            { back = 10; span = [now - 10, null]; }

  const loads = plan.steps.filter(s => s.op === "load");
  const notes = [];

  // A single year, a single measure: just stamp it.
  if (!span && named.length === 1 && loads.length === 1 && !loads[0].year) {
    loads[0].year = named[0];
    return `read ${named[0]} rather than the latest year`;
  }
  if (!span) return null;

  const combiner = plan.steps.find(
    s => (s.op === "combine" || s.op === "normalize") && (s.inputs || []).length === 2);
  if (!combiner) return null;

  const [a, b] = combiner.inputs.map(id => plan.steps.find(s => s.id === id));
  if (!a || !b || a.op !== "load" || b.op !== "load") return null;
  // The model's own years stand only when they ARE the question's period, on
  // one measure. It used to back off whenever any year was set, and "rose the
  // most over the last decade" then ran as ERS unemployment 2000 against
  // County Health Rankings unemployment 2020: the wrong period, and two
  // measures on different scales (r-unemp-decade, 2026-11-09).
  //
  // So the model's years are overridden when the period is COUNTED ("last
  // decade": decidable from the measure's own years, see anchorYears) or when
  // it compared two different measures (never a trend). A model year on one
  // measure against a NAMED period ("since 2010" -> 2015) is still left alone,
  // as test_dag pins: that was a deliberate choice, and changing it is a
  // separate decision.
  const modelYears = [a.year, b.year];
  if ((a.year || b.year) && back === undefined && a.attr_id === b.attr_id) return null;

  // One measure at two points in time, not two measures divided by each other.
  if (a.attr_id !== b.attr_id) {
    notes.push(`compared "${a.attr_id}" against itself rather than against "${b.attr_id}"`);
    b.attr_id = a.attr_id;
  }
  if (modelYears[0] || modelYears[1]) {
    notes.push(`replaced the planner's years (${modelYears.map(y => y ?? "latest").join(" to ")}) ` +
               `with the question's period`);
  }
  a.year = span[0];
  if (span[1]) b.year = span[1];
  else delete b.year;                    // "to the latest", resolved per measure
  if (back !== undefined) a._back = back;
  // A ratio of a measure to its own earlier value is not what "increase" means.
  if (combiner.op === "normalize") {
    combiner.op = "combine";
    combiner.operation = "percent_change";
    delete combiner.scale;
    notes.push("changed the ratio to a percent change");
  } else if (!combiner.operation || combiner.operation === "ratio") {
    combiner.operation = "percent_change";
  } else if (combiner.operation === "difference" && combiner.inputs[0] === a.id) {
    // difference is input 1 - input 2, and input 1 was just made the EARLIER
    // year, so it read earlier - later: ranking "rose the most" descending
    // then listed the biggest FALLS (r-unemp-decade, 2026-11-09, overlap 0).
    // A change over time reads later - earlier, the way percent_change does.
    combiner.inputs = [b.id, a.id];
    notes.push("ordered the difference as later minus earlier");
  }
  notes.push(`set the period to ${span[0]}${span[1] ? `-${span[1]}` : " to the latest year"}`);
  return notes.join("; ");
}

function repairStates(plan, query) {
  const notes = [];
  const named = statesMentioned(query);
  const regions = named.filter(n => REGIONS[n]);
  // A plan that restricts to two DIFFERENT areas is comparing them
  // (compare_groups: "more unemployment in the south than the north"). The
  // question names one census region because the other side is not one, and
  // overriding every step to it made both groups the South: every county in
  // both, dropped as overlap, an empty answer 3 runs of 3 (2026-11-09).
  // Duplicates are still removed; only the region override is skipped.
  const areaSets = new Set((plan.steps || [])
    .filter(s => Array.isArray(s.states) && s.states.length)
    .map(s => [...new Set(s.states)].sort().join("|")));
  const singleRegion = regions.length === 1 && named.length === 1 && areaSets.size < 2
    ? regions[0] : null;

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
    // Worded as what was DONE, not what went wrong: shown in the UI, the old
    // "the plan listed 2 state(s) outside it" read like a failure when it is a
    // correction that worked (the model had put the Dakotas in "the South").
    notes.push(
      `used the Census Bureau's ${singleRegion} region; left out ` +
      `${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ` and ${extra.length - 3} more` : ""}, ` +
      `which the planner had included but are not part of it`);
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
  // Whether county_neighbors is populated. Same reason: hotspot cannot run
  // without adjacency, and an op that can only fail should not be offered.
  hasNeighbors = false,
  log = console.log,
  // Structured progress, separate from `log`. `log` writes prose for a human
  // reading container output; `emit` carries machine-readable stages so the
  // planned SSE stream (docs/AI-PIPELINE.md section 5, nginx already has
  // proxy_buffering off for it) can forward them without re-plumbing this
  // function. No-op by default, so nothing changes until a caller passes one.
  emit = () => {},
  // Post-validation check that each attribute the plan uses measures what the
  // question asks (planner/relevance.js). Off by default here so callers that
  // script the LLM (the tests) are unaffected; runAnalysis turns it on.
  relevanceCheck = false,
  // Every phrase the question names data about is covered by an attribute
  // the plan uses (planner/named_data.js). Off here for the same reason.
  namedDataCheck = false,
  // { coverageOf, equivalentsOf } (planner/coverage.js). Null skips the check,
  // so the scripted-LLM tests and any caller without a database are unaffected.
  coverage = null,
  // async (census_code) => years with values (planner/vintages.js). Null keeps
  // the calendar-based period, so scripted tests are unaffected.
  yearsOf = null,
  // async (census_code) => Set of levels with values (planner/levels.js).
  // Null keeps every plan at the county, so scripted tests are unaffected.
  levelsOf = null,
  // Layers uploaded this session (backend/user_layers.js), Map id -> source.
  userLayers = null,
}) {
  const attempts = [];
  let repairContext = "";
  // Deterministic repairs applied to the model's plan, surfaced to the caller
  // so a silently-widened result is never presented as the question asked.
  const adjustments = [];

  const { refs, defRefs, text: attrText } = buildRefs(candidates);
  // Every definition on offer, by id, for checkThresholds (a definition can
  // bind several measures, so each id maps to a list).
  const defsById = new Map();
  for (const d of defRefs.values()) {
    if (!defsById.has(d.id)) defsById.set(d.id, []);
    defsById.get(d.id).push(d);
  }
  let definitionsUsed = [];

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
    c => (c.is_feature_table || c.is_raster) &&
         Object.values(c.filter_values || {}).some(v => v?.length));

  // Which geometry kinds are on offer: overlay needs an area layer to test
  // against, an amount needs a line or area layer (planner/features.js). Not
  // set at all when false, so every existing narrowing context is unchanged.
  const reps = new Set(candidates.filter(c => c.is_feature_table)
    .map(c => /POLYGON/i.test(c.spatial_rep || "") ? "polygon" : /LINE/i.test(c.spatial_rep || "") ? "line" : "point"));
  const narrowing = {
    hasFeatureTables, featureTableCount, mentionsArea, wantsLocations,
    ...(reps.has("polygon") ? { hasPolygonLayer: true } : {}),
    ...(reps.has("line") ? { hasLineLayer: true } : {}),
    // A raster to summarise over units (H4, ops/zonal.js). Absent otherwise.
    ...(candidates.some(c => c.is_raster) ? { hasRaster: true } : {}),
    hasFilterableValues, hasPlaceBoundaries, hasNeighbors,
    // A retrieved attribute carries a checked, published definition. Data,
    // not phrasing: the definition field exists only when one is on offer.
    hasDefinitions: defRefs.size > 0,
    // A research workflow handed this step the results of earlier steps.
    hasEarlierResults: candidates.some(c => c.search_purpose === "earlier"),
    // The statistics ops gate on PHRASING as well as on loaded data -- nobody
    // gets offered "hotspot" for a question that is not about clustering -- so
    // the query itself is part of the narrowing context.
    query,
  };
  const schema = planSchemaFor(narrowing);
  const withheldOps = new Set();
  const systemPrompt = buildSystemPrompt(narrowing);

  // Which ops this query was actually offered. Logged because "the model did
  // not use op X" and "op X was never on the menu" look identical from the
  // outside and need entirely different fixes -- one is a prompt problem, the
  // other a gate or a missing table.
  log(`   ops offered: ${schema.properties.steps.items.properties.op.enum.join(", ")}`);

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const userPrompt =
      `QUESTION: ${query}\n\n` +
      `AVAILABLE ATTRIBUTES (use these labels as attr_id):\n${attrText}\n` +
      repairContext;

    emit({ stage: "planning", attempt: attempt + 1, of: MAX_REPAIRS + 1 });
    // After a runaway, the op it repeated is withheld from the NEXT attempt's
    // decoding enum (never the first attempt's, so the snapshot is unchanged):
    // at temperature 0.1 the same prompt decoded the same endless
    // filter_attr(= 1) chain on all three attempts, whatever the repair text
    // said (H4 dev, 2026-11-12). The model can then only plan without it.
    const attemptSchema = withheldOps.size ? withoutOps(schema, withheldOps) : schema;
    const raw = await callLLM(systemPrompt, userPrompt, 0.1, attemptSchema);
    if (!raw) {
      attempts.push({ attempt, errors: ["LLM returned nothing"] });
      continue;
    }

    let plan;
    try {
      plan = JSON.parse(raw);
    } catch (err) {
      // Should be impossible under constrained decoding; recorded rather than
      // silently retried so it is visible if the assumption ever breaks. It
      // does break when the output-token cap cuts a runaway (H4, 2026-11-12);
      // the tail shows what was repeating.
      log(`   Plan JSON unparseable (${String(raw).length} chars), tail: ${String(raw).slice(-300).replace(/\s+/g, " ")}`);
      attempts.push({ attempt, errors: [`unparseable despite schema: ${err.message}`] });
      // Without this the next attempt saw the identical prompt and decoded
      // the identical runaway: "developed land in each Chicago community
      // area" chained filter_attr(= 1) to step s61, three times (H4 dev).
      // The repeating text is NOT quoted back: with it in the prompt, attempts
      // 2 and 3 reproduced the same runaway exactly (filter_attr "= 2021"
      // to step s58, H4 dev). What repeated is described instead, and a
      // repeated YEAR is named as one, because that was the habit: a year
      // the question states, written as a filter instead of a step's year.
      const ids = [...String(raw).matchAll(/"id"\s*:\s*"([^"]+)"/g)].length;
      const ops = [...String(raw).matchAll(/"op"\s*:\s*"([a-z_]+)"/g)].map(m => m[1]);
      const repeated = ops.length ? ops[ops.length - 1] : "a step";
      // Withheld only if it is not the plan's terminal or source op.
      if (ops.length > 8 && !["output", "load", "select_features", "zonal"].includes(repeated)) {
        withheldOps.add(repeated);
        log(`   Withholding "${repeated}" from the next attempt: it repeated without end`);
      }
      const yearRepeat = (String(raw).slice(-400).match(/"value"\s*:\s*((?:19|20)\d\d)\b/) || [])[1];
      repairContext =
        `\nYour previous plan was cut off: it repeated ${repeated} steps without end ` +
        `(${ids} steps) and never finished. Write a COMPLETE plan with only the steps ` +
        `the question needs, usually 2 to 6. Do not add a filter the question does not state.` +
        (yearRepeat
          ? ` ${yearRepeat} is a YEAR: put it in the "year" field of the step that reads ` +
            `the data, never in a filter_attr.`
          : "") + `\n`;
      continue;
    }

    normalizeIds(plan);
    // Wiring the model gets wrong the same way on every repair attempt
    // (planner/rewire.js), fixed exactly in code.
    for (const fix of [loadLabelInputs(plan, refs), splitOutputs(plan), uninvertChains(plan)]) {
      if (!fix) continue;
      log(`   Rewired plan: ${fix}`);
      emit({ stage: "plan_adjusted", detail: fix });
    }
    const equality = dropUnaskedEquality(plan, query);
    if (equality) {
      log(`   Dropped an equality filter the question did not ask for: ${equality}`);
      emit({ stage: "plan_adjusted", detail: `dropped unasked filter ${equality}` });
      adjustments.push(`Dropped a filter the question did not ask for: ${equality}.`);
    }
    const unasked = dropUnaskedFilters(plan, query);
    if (unasked) {
      log(`   Dropped filter(s) the question did not ask for: ${unasked}`);
      emit({ stage: "plan_adjusted", detail: `dropped unasked filter ${unasked}` });
    }
    const countyFix = repairCountyKind(plan);
    if (countyFix) {
      log(`   Repaired place kind: ${countyFix}`);
      emit({ stage: "plan_adjusted", detail: countyFix });
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
    const yearsFix = resolveRelativeYears(plan, query);
    if (yearsFix) {
      log(`   Resolved the time reference: ${yearsFix}`);
      emit({ stage: "plan_adjusted", detail: `Time reference: ${yearsFix}.` });
      adjustments.push(`Time reference resolved: ${yearsFix}.`);
    }

    // Distances the question gave in km / meters / feet, as the miles a plan
    // carries (planner/features.js). Decided from the question, never asked
    // of the model.
    const unitsFix = repairDistanceUnits(plan, query);
    if (unitsFix) {
      log(`   Converted distance units: ${unitsFix}`);
      emit({ stage: "plan_adjusted", detail: `Units: ${unitsFix}.` });
      adjustments.push(`Distance: ${unitsFix}.`);
    }
    const areaFix = applyAreaUnit(plan, query);
    if (areaFix) {
      log(`   Area unit: ${areaFix}`);
      emit({ stage: "plan_adjusted", detail: `Area: ${areaFix}.` });
      adjustments.push(`Area: ${areaFix}.`);
    }
    // Which side of the distance, from the question's words; and a reference
    // layer the model restricted to the same area as the features it serves.
    for (const fix of [repairWithinDirection(plan, query), widenReferenceLayer(plan)]) {
      if (!fix) continue;
      log(`   Repaired proximity step: ${fix}`);
      emit({ stage: "plan_adjusted", detail: fix });
      adjustments.push(`Proximity: ${fix}.`);
    }

    const implied = applyImpliedState(plan, query);
    if (implied) {
      log(`   Added implied state restriction: ${implied}`);
      emit({ stage: "plan_adjusted", detail: `restricted to ${implied}` });
    }
    const asked = addAskedState(plan, query);
    if (asked) {
      log(`   Added the state the question named: ${asked}`);
      emit({ stage: "plan_adjusted", detail: `restricted to ${asked}` });
      adjustments.push(`Area: restricted to ${asked}.`);
    }
    // After applyImpliedState: a state the question names keeps the city.
    const metro = repairMetroKind(plan, query);
    if (metro) {
      log(`   Repaired place kind: ${metro}`);
      emit({ stage: "plan_adjusted", detail: metro });
      adjustments.push(`Place: ${metro}.`);
    }
    // A plan of nothing but empty `output` steps is the model saying "none of
    // these attributes answer this" in the only shape the schema let it
    // produce. Measured on "shark attack incidents along the Australian coast":
    // [{op: "output", inputs: []}], which validation reported as an arity
    // error and the user saw as "could not produce a valid plan". It is the
    // no-steps answer, and is treated as one.
    if (Array.isArray(plan.steps) && plan.steps.length &&
        plan.steps.every(s => s.op === "output" && !(s.inputs || []).length)) {
      log(`   Plan had only empty output steps; treating it as no steps`);
      plan.steps = [];
    }
    const unknownRefs = derefPlan(plan, refs);
    // Workflow-step wiring (planner/rewire.js), in this order: a bridge given
    // an input becomes an intersect, an ignored earlier result becomes a
    // restriction, and an earlier result is never intersect's value side.
    const earlierIds = candidates.filter(c => c.search_purpose === "earlier").map(c => c.attr_id);
    for (const fix of [bridgeFromLoadedLayer(plan, featureTables),
                       bridgeInputsToIntersect(plan), restrictToEarlier(plan, earlierIds),
                       earlierResultSecond(plan), totalTheDenominator(plan, opsRegistry.stepTypes),
                       areaAfterAccess(plan), orderChangeByYear(plan), addMissingOutput(plan)]) {
      if (!fix) continue;
      log(`   Rewired plan: ${fix}`);
      emit({ stage: "plan_adjusted", detail: fix });
      adjustments.push(`Plan corrected: ${fix}.`);
    }
    // Definition labels are dereferenced the same way, and an unknown one is
    // a repair, never a guess (planner/conditions.js).
    const defs = derefDefinitions(plan, defRefs);
    definitionsUsed = defs.used;
    // After deref, attr_ids are real, so the dataset's own columns can be
    // consulted. Must run before validation, which would otherwise reject.
    if (!unknownRefs.length) {
      // "Our clinics": the user's uploaded layer, not a catalog one
      // (backend/user_layers.js). Inert without an upload.
      const ours = preferUserLayer(plan, query, userLayers, candidates);
      if (ours) {
        log(`   Rewired plan: ${ours}`);
        emit({ stage: "plan_adjusted", detail: ours });
        adjustments.push(`Plan corrected: ${ours}.`);
      }
      const asLayer = await filterValueAsLayer(plan, resolve, candidates);
      if (asLayer) {
        log(`   Rewired plan: ${asLayer}`);
        emit({ stage: "plan_adjusted", detail: asLayer });
        adjustments.push(`Plan corrected: ${asLayer}.`);
      }
      // Count, length or area, and the unit, for summarize and overlay (H3):
      // from the question and the layer's geometry, never the model's call.
      const repOf = (id) => candidates.find(c => c.attr_id === id)?.spatial_rep || "";
      const measures = applyMeasures(plan, query, repOf);
      if (measures) {
        log(`   Measures: ${measures}`);
        emit({ stage: "plan_adjusted", detail: `Measures: ${measures}.` });
        adjustments.push(`Measure: ${measures}.`);
      }
      const unsupported = await dropUnsupportedFilters(plan, resolve);
      if (unsupported) {
        log(`   Dropped filter(s) this dataset cannot support: ${unsupported}`);
        emit({ stage: "plan_adjusted", detail: `dropped unsupported filter ${unsupported}` });
        adjustments.push(`Filter ${unsupported} was not applied: this dataset has no such attribute.`);
      }
      // After the drop: a filter removed here must not leave its stat behind.
      // What a zonal step reports (share, area in a unit, mean), H4: code.
      if ((plan.steps || []).some(s => s.op === "zonal")) {
        const zr = await resolve((plan.steps || []).filter(s => s.op === "zonal").map(s => s.attr_id));
        const yr = yearAsVintage(plan, (id) => zr.get(id));
        if (yr) {
          log(`   Rewired plan: ${yr}`);
          emit({ stage: "plan_adjusted", detail: yr });
          adjustments.push(`Plan corrected: ${yr}.`);
        }
        const cls = fillRasterClasses(plan, query, (id) => zr.get(id));
        if (cls) {
          log(`   Rewired plan: ${cls}`);
          emit({ stage: "plan_adjusted", detail: cls });
          adjustments.push(`Plan corrected: ${cls}.`);
        }
        const rm = applyRasterMeasures(plan, query, (id) => zr.get(id));
        if (rm) {
          log(`   Raster measure: ${rm}`);
          emit({ stage: "plan_adjusted", detail: `Raster: ${rm}.` });
          adjustments.push(`Raster: ${rm}.`);
        }
      }
    }
    if (unknownRefs.length || defs.unknown.length) {
      const errors = [
        ...unknownRefs.map(r =>
          `attr_id "${r}" is not one of the available labels. ` +
          `Use exactly one of: ${[...refs.keys()].join(", ")}`),
        ...defs.unknown.map(r => defRefs.size
          ? `definition "${r}" is not listed. Use one of: ${[...defRefs.keys()].join(", ")}, ` +
            `or give operator and value instead.`
          : `definition "${r}" is not listed; give operator and value instead.`),
      ];
      log(`   Plan used ${errors.length} unknown label(s)`);
      attempts.push({ attempt, errors, plan });
      repairContext =
        `\nYour previous plan was rejected:\n` + errors.map(e => `- ${e}`).join("\n") +
        `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
      continue;
    }

    let check = await validatePlan(plan, resolve);
    // A rate divided by a count: the validator refuses it, and the model then
    // re-emits it 3 of 3 times. Keep the rate (the thing asked for) instead.
    if (!check.ok && check.errors.some(e => /is already a rate or percentage/.test(e))) {
      const fix = dropRateOverCount(plan, check.resolved);
      if (fix) {
        log(`   Rewired plan: ${fix}`);
        emit({ stage: "plan_adjusted", detail: fix });
        adjustments.push(`Plan corrected: ${fix}.`);
        check = await validatePlan(plan, resolve);
      }
    }

    // A precision question: interval width is upper minus lower, and "least
    // precise" is the widest (planner/uncertainty.js).
    if (check.ok) {
      const prec = repairPrecision(plan, query, check.resolved);
      if (prec) {
        log(`   Repaired precision step: ${prec}`);
        emit({ stage: "plan_adjusted", detail: prec });
        adjustments.push(`Precision: ${prec}.`);
      }
    }

    // Periods and years against the years each measure actually has.
    if (check.ok && yearsOf) {
      try {
        const anchored = await anchorYears(plan, check.resolved, yearsOf, {
          // Other measures on the list that DO span the period, by label, so a
          // repair can switch to one instead of re-picking the same series.
          // `back` years to span, or (back null) every year in `want`.
          alternatives: async (back, exclude, want = null) => {
            const pairs = [...refs].filter(([, id]) => !exclude.has(id) && !featureTables.has(id));
            const src = await resolve(pairs.map(([, id]) => id));
            const out = [];
            for (const [label, id] of pairs) {
              const s = src.get(id);
              if (!s || s.source_kind !== "acs_long") continue;
              const ys = [...new Set(await yearsOf(s.census_code))].sort((a, b) => a - b);
              const span = want
                ? (want.every(y => ys.includes(y)) ? { from: ys[0], to: ys[ys.length - 1] } : null)
                : spans(ys, back);
              if (span) out.push({ label, description: s.description || id, ...span });
              if (out.length === 3) break;
            }
            return out;
          },
        });
        if (anchored.errors.length) {
          check.ok = false;
          check.errors.push(...anchored.errors);
        }
        for (const n of anchored.notes) {
          log(`   Years: ${n}`);
          emit({ stage: "plan_adjusted", detail: `Years: ${n}.` });
          adjustments.push(`Time period: ${n}.`);
        }
      } catch (err) {
        log(`   Year anchoring skipped: ${err.message}`);
      }
    }
    for (const st of plan.steps || []) delete st._back;

    // The unit the question names (census tracts, ZIP codes, grid cells),
    // set in code after the model has planned (planner/levels.js).
    if (check.ok && levelsOf) {
      try {
        const lv = await applyLevel(plan, query, check.resolved, levelsOf, async (level) => {
          const pairs = [...refs].filter(([, id]) => !featureTables.has(id));
          const src = await resolve(pairs.map(([, id]) => id));
          const out = [];
          for (const [label, id] of pairs) {
            const s = src.get(id);
            if (s?.source_kind === "acs_long" && (await levelsOf(s.census_code)).has(level)) {
              out.push({ label, description: s.description || id });
            }
          }
          return out;
        });
        if (lv.errors.length) {
          check.ok = false;
          check.errors.push(...lv.errors);
        } else if (lv.note) {
          log(`   Level: ${lv.note}`);
          emit({ stage: "plan_adjusted", detail: `Unit: ${lv.note}.` });
          adjustments.push(`Unit: ${lv.note}.`);
        }
        // Finer data, county answers: roll each load up (ops/aggregate_to.js).
        const ru = await applyRollup(plan, query, check.resolved, levelsOf, seriesUnit, async (level) => {
          const pairs = [...refs].filter(([, id]) => !featureTables.has(id));
          const src = await resolve(pairs.map(([, id]) => id));
          const out = [];
          for (const [label, id] of pairs) {
            const s = src.get(id);
            if (s?.source_kind === "acs_long" && (await levelsOf(s.census_code)).has(level)) {
              out.push({ label, description: s.description || id });
            }
          }
          return out;
        });
        if (ru.errors.length) {
          check.ok = false;
          check.errors.push(...ru.errors);
        } else if (ru.note) {
          log(`   Roll-up: ${ru.note}`);
          emit({ stage: "plan_adjusted", detail: `Built from finer data: ${ru.note}.` });
          adjustments.push(`Built from finer data: ${ru.note}.`);
          const again = await validatePlan(plan, resolve);
          if (!again.ok) { check.ok = false; check.errors.push(...again.errors); }
        }
      } catch (err) {
        log(`   Level check skipped: ${err.message}`);
      }
    }

    // Thresholds against the measure they filter: a definition on the measure
    // it belongs to, a percentile in range, a stated number on the measure's
    // own scale ("% rural > 50" on a 0-1 fraction is converted, not refused).
    if (check.ok) {
      const th = checkThresholds(plan, check.resolved, defsById);
      for (const r of th.repairs) {
        log(`   Threshold: ${r}`);
        emit({ stage: "plan_adjusted", detail: `Threshold: ${r}.` });
        adjustments.push(`Threshold: ${r}.`);
      }
      if (th.errors.length) {
        check.ok = false;
        check.errors.push(...th.errors);
      }
    }

    // An expanded candidate may be a factor, never the subject
    // (planner/outcome.js). Checked before the relevance check, which passed
    // "Diabetes prevalence" as the outcome of "what drives chronic kidney
    // disease", and which costs an LLM call this rule does not need.
    if (check.ok) {
      const unasked = unaskedSubjectErrors(plan, candidates);
      if (unasked.length) {
        log(`   Plan answers about a concept the question did not name (attempt ${attempt + 1})`);
        emit({ stage: "plan_invalid", attempt: attempt + 1, errors: unasked });
        attempts.push({ attempt, errors: unasked, plan });
        repairContext =
          `\nYour previous plan was rejected. Fix these problems and return a ` +
          `corrected plan:\n` + unasked.map(e => `- ${e}`).join("\n") +
          `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
        continue;
      }
    }

    // Valid is not the same as answering the question: "average rainfall"
    // planned a mean of reading scores. Unrelated attributes go back through
    // the same repair loop as any other error.
    let relevance = null;
    if (check.ok && relevanceCheck) {
      relevance = await checkRelevance({ query, plan, candidates, refs, callLLM, log });
      if (relevance.errors.length) {
        log(`   Plan uses data that does not measure the question (attempt ${attempt + 1})`);
        emit({ stage: "plan_irrelevant", attempt: attempt + 1, errors: relevance.errors });
        attempts.push({ attempt, errors: relevance.errors, plan, relevance: relevance.verdicts });
        repairContext =
          `\nYour previous plan was rejected. Fix these problems and return a ` +
          `corrected plan:\n` + relevance.errors.map(e => `- ${e}`).join("\n") +
          `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
        continue;
      }
    }

    // The relevance check judges what the plan USES; this catches what it
    // DROPPED. "FEMA flood zones x tax parcels, value at risk" planned county
    // home value, and every attribute it used was judged on its own
    // (planner/named_data.js). Same repair loop as NOT_RELEVANT.
    let named = null;
    if (check.ok && namedDataCheck) {
      named = await checkNamedData({ query, used: usedAttributes(plan), candidates, refs, callLLM, log });
      if (named.errors.length) {
        log(`   Plan leaves data the question names uncovered (attempt ${attempt + 1})`);
        emit({ stage: "plan_irrelevant", attempt: attempt + 1, errors: named.errors });
        attempts.push({ attempt, errors: named.errors, plan, uncovered: named.uncovered });
        repairContext =
          `\nYour previous plan was rejected. Fix these problems and return a ` +
          `corrected plan:\n` + named.errors.map(e => `- ${e}`).join("\n") +
          `\n\nPrevious plan:\n${JSON.stringify(plan)}\n`;
        continue;
      }
    }

    // Coverage (planner/coverage.js): on an ACCEPTED plan, swap a series that
    // covers too little of the area for a verified equivalent, or say how
    // little it covers. After the relevance check on purpose: a swap is
    // between series that measure the same thing, so its verdict still holds.
    let resolvedFinal = check.resolved;
    // Coverage is measured over counties; a plan at another unit is not.
    if (check.ok && coverage && !plan.level) {
      try {
        const before = plan.steps.map(s => s.attr_id);
        const { swaps, notes, added } = await preferCoverage(plan, candidates, coverage);
        if (swaps.length) {
          const recheck = await validatePlan(plan, resolve);
          if (recheck.ok) {
            resolvedFinal = recheck.resolved;
            for (const row of added) candidates.push(row);
            for (const s of swaps) {
              log(`   Coverage: ${s}`);
              emit({ stage: "plan_adjusted", detail: `Coverage: ${s}.` });
              adjustments.push(`Coverage: ${s}.`);
            }
          } else {
            plan.steps.forEach((s, i) => { s.attr_id = before[i]; });
            log(`   Coverage swap reverted, it did not validate: ${recheck.errors.join("; ")}`);
          }
        }
        for (const n of notes) {
          log(`   Coverage: ${n}`);
          emit({ stage: "plan_adjusted", detail: `Coverage: ${n}.` });
          adjustments.push(`Coverage: ${n}.`);
        }
      } catch (err) {
        // Coverage is advice about the answer, not part of it: a failure here
        // must never cost the user a plan that already passed every check.
        log(`   Coverage check skipped: ${err.message}`);
      }
    }

    // Catchments (planner/catchment.js): people at a distance are counted by
    // census tract, not by county centroid. On the accepted plan, like
    // coverage, and for the same reason: the swap is between equivalent
    // population counts, so the relevance verdicts still hold.
    if (check.ok && levelsOf) {
      try {
        const before = JSON.stringify(plan.steps);
        const c = await applyCatchment(plan, query, resolvedFinal, {
          resolve, levelsOf, stepTypes: opsRegistry.stepTypes });
        if (c.note) {
          const recheck = await validatePlan(plan, resolve);
          if (recheck.ok) {
            resolvedFinal = recheck.resolved;
            if (!candidates.some(x => x.attr_id === c.population.attr_id)) {
              candidates.push({ attr_id: c.population.attr_id, attr_desc: c.population.description,
                                dataset_id: c.population.dataset_id, search_purpose: "catchment" });
            }
            log(`   Catchment: ${c.note}`);
            emit({ stage: "plan_adjusted", detail: `Catchment: ${c.note}.` });
            adjustments.push(`Catchment: ${c.note}.`);
          } else {
            plan.steps = JSON.parse(before);
            log(`   Catchment reverted, it did not validate: ${recheck.errors.join("; ")}`);
          }
        }
      } catch (err) {
        log(`   Catchment skipped: ${err.message}`);
      }
    }

    if (check.ok) {
      log(`   Plan valid on attempt ${attempt + 1} (${plan.steps.length} steps)`);
      emit({
        stage: "plan_valid",
        attempt: attempt + 1,
        intent: plan.intent,
        ops: plan.steps.map(s => s.op),
      });
      return {
        ok: true, plan, resolved: resolvedFinal, attempts, repairs: attempt,
        // Deduped: the repair loop re-applies the same correction on every
        // attempt, and reporting it three times reads as three separate
        // problems rather than one.
        adjustments: [...new Set(adjustments)],
        // Per-attribute verdicts: which are direct measures, which are proxies
        // the reader should be told about. null when the check did not run.
        relevance: relevance ? relevance.verdicts : null,
        // What the question names and which attribute covers each
        // (planner/named_data.js). null when the check did not run.
        named_data: named ? named.named : null,
        // Published definitions the plan applied, with their citations, for
        // provenance. Empty when none was used.
        definitions: definitionsUsed.map(d => ({
          step: d.step, id: d.id, term: d.term, measure_code: d.measure_code,
          rule: `value ${d.op} ${d.value}`, source: d.source, url: d.url || null,
          vintages: [d.vintage_from, d.vintage_to],
        })),
      };
    }

    // The errors themselves, not just a count: which rule rejected a plan is
    // what tells a validator catch from a model that cannot follow the prompt,
    // and the POST response does not carry rejected attempts.
    log(`   Plan invalid (attempt ${attempt + 1}): ${check.errors.length} error(s): ` +
        check.errors.map(e => e.slice(0, 160)).join(" | "));
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
 * Shape one output's result set.
 *
 * Kept separate from executePlan because a plan can produce SEVERAL, and each
 * is shaped by its own mode: a features layer is GeoJSON with whatever label
 * columns that layer happens to carry, a values layer is the (fips, value)
 * row contract. Forcing one into the other is what the two shapes exist to
 * avoid.
 */
function shapeLayer(out, res, ms) {
  if (out.mode === "features") {
    const labels = out.labels || [];
    return {
      id: out.id, step: out.step, mode: "features",
      sql: out.sql, params: out.params,
      // What a feature's `value` property is, when an op put one there
      // (within: miles to the nearest feature of the second layer).
      valueLabel: out.valueLabel ?? null,
      row_count: res.rowCount,
      ms,
      rows: [],
      features: res.rows.map(r => ({
        type: "Feature",
        geometry: r.geometry ? JSON.parse(r.geometry) : null,
        properties: Object.fromEntries(labels.map(c => [c, r[c] ?? null])),
      })).filter(f => f.geometry),
    };
  }

  const twoSeries = out.series === 2;
  const statCols = out.statColumns || [];
  const rowCols = out.rowColumns || [];
  const sumCols = out.summaryColumns || [];
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: out.id, step: out.step, mode: "values",
    sql: out.sql, params: out.params,
    op: out.op,
    part: out.part === true,
    diverging: out.diverging,
    valueLabel: out.valueLabel,
    // How many measures each row carries. A `join` that reaches the output
    // keeps both, so "population and poverty rate" is one layer with two
    // series rather than two separate analyses.
    series: twoSeries ? 2 : 1,
    // A one-row statistic (correlate) carries its figures here, named, so a
    // client does not have to know which op produced the layer to read them.
    // null for every per-county layer.
    stats: statCols.length && res.rows[0]
      ? { value: num(res.rows[0].value),
          ...Object.fromEntries(statCols.map(c => [c, num(res.rows[0][c])])) }
      : null,
    // A group comparison (compare_groups): which group is which, and the
    // verdict. Named `comparison`, not `stats`, because the UI reads `stats`
    // as a one-row correlation and would hide the map these rows draw.
    comparison: sumCols.length && res.rows[0]
      ? { labels: out.groupLabels,
          ...Object.fromEntries(sumCols.map(c => [c, num(res.rows[0][c])])) }
      : null,
    row_count: res.rowCount,
    ms,
    // The unit each row is (planner/levels.js): "county" unless the question
    // named tracts, ZIP areas or grid cells.
    level: out.level || "county",
    rows: res.rows.map(r => ({
      fips: r.fips,
      name: r.name,
      state_fp: r.state_fp,
      value: r.value === null ? null : Number(r.value),
      ...Object.fromEntries(rowCols.map(c => [c, r[c] ?? null])),
      ...(twoSeries
        ? { value_b: r.value_b === null || r.value_b === undefined ? null : Number(r.value_b) }
        : {}),
    })),
    // GeoJSON kept separate: it dwarfs the tabular payload and most callers
    // (charts, tables) do not need it.
    geometry: res.rows
      .filter(r => r.geometry)
      .map(r => ({ fips: r.fips, geometry: JSON.parse(r.geometry) })),
  };
}

/**
 * Compile a validated plan and run it.
 *
 * Read-only by construction: the compiler emits SELECTs and nothing else, and
 * this runs inside a read-only transaction as a second line of defence.
 *
 * A plan may have several outputs. They run in ONE transaction, so every layer
 * sees the same snapshot -- two layers of the same result read at different
 * instants would be a subtle way to publish an inconsistent map.
 *
 * The return keeps the flat single-layer shape every existing caller reads, and
 * adds `layers` alongside it. A one-output plan therefore looks exactly as it
 * did, and nothing that ignores `layers` silently loses the first one.
 */
// County adjacency as Map<fips, fips[]>, for compute ops. 18,608 pairs, read
// once: the table only changes when `make neighbors` is re-run.
let neighborsCache = null;
async function countyNeighbors(client) {
  if (neighborsCache) return neighborsCache;
  const { rows } = await client.query("SELECT fips, neighbor_fips FROM county_neighbors");
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.fips)) m.set(r.fips, []);
    m.get(r.fips).push(r.neighbor_fips);
  }
  neighborsCache = m;
  return m;
}

async function executePlan(plan, resolved, pool, { timeoutMs = 30000 } = {}) {
  const compiled = compilePlan(plan, resolved);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);

    const started = Date.now();
    const layers = [];
    for (const out of compiled.outputs) {
      const t0 = Date.now();
      const res = await client.query(out.sql, out.params);
      if (out.mode === "factors") {
        const neighbors = await countyNeighbors(client);
        const computed = opsRegistry.byName(out.op).compute(res.rows, { factors: out.factors, neighbors });
        // The OUTCOME per county, which the query already fetched to rank
        // factors against. It used to be discarded, so "what causes cancer in
        // the South" answered with a table and no way to see where the cancer
        // rates actually are. Returned as ordinary (fips, name, value) rows so
        // the same choropleth draws it.
        const fipsList = res.rows.map(r => r.fips);
        const names = fipsList.length
          ? new Map((await client.query(
              "SELECT fips, name FROM county_geom WHERE fips = ANY($1)", [fipsList]))
              .rows.map(r => [r.fips, r.name]))
          : new Map();
        const outcomeRows = res.rows
          .map(r => ({ fips: r.fips, name: names.get(r.fips) ?? null, state_fp: String(r.fips).slice(0, 2),
                       value: r.y === null ? null : Number(r.y) }))
          .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
        layers.push({
          id: out.id, step: out.step, mode: "factors", op: out.op,
          sql: out.sql, params: out.params,
          row_count: computed.factors.length, ms: Date.now() - t0,
          rows: outcomeRows, ...computed,
        });
        continue;
      }
      layers.push(shapeLayer(out, res, Date.now() - t0));
    }
    await client.query("COMMIT");

    const first = layers[0];
    return {
      ...first,
      ms: Date.now() - started,
      layers,
      layer_count: layers.length,
    };
  } finally {
    client.release();
  }
}

module.exports = {
  generatePlan, executePlan, buildSystemPrompt, queryWantsLocations,
  // Exported for its tests: it is the repair that turns a relative period
  // ("since 2010", "the last decade") into concrete years on the load steps.
  resolveRelativeYears,
  // Exported for planner/test_zones.js.
  filterValueAsLayer, dropUnaskedEquality, dropUnaskedFilters, withoutOps,
  PLAN_SYSTEM_PROMPT, MAX_REPAIRS, CompileError,
};
