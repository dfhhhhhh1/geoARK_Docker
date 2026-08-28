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
const { validatePlan } = require("./validate");
const { compilePlan, CompileError } = require("./compile");

const MAX_REPAIRS = Number(process.env.PLAN_MAX_REPAIRS ?? 2);

const PLAN_SYSTEM_PROMPT = `You convert a geospatial question into an executable analysis plan.

"intent" must restate THE QUESTION YOU ARE GIVEN in one sentence. Do not
describe any other analysis.

You are given the user's question and a list of AVAILABLE ATTRIBUTES that were
retrieved for it. Each has an attr_id and a description.

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
- End with exactly one "output" step.

Operations:
  load         needs attr_id                       -> values for one attribute
  count_features needs attr_id (a facility dataset) -> features per county
  filter_attr  needs operator and value, 1 input   -> keep matching rows
  normalize    2 inputs (numerator, denominator)   -> ratio, optional scale
  aggregate    needs function, 1 input             -> mean/sum/count/min/max
  rank         1 input, direction and limit        -> top or bottom n
  join         2 inputs                            -> combine on the shared area
  output       1 input                             -> terminal step

Every step MUST include both "inputs" and "attr_id".
  inputs  : [] for load; one step id for filter_attr, aggregate, rank, output;
            two for normalize and join.
  attr_id : a label like "a3" for load and count_features; "" for every other op.

Facility datasets (refineries, shelters, tornado tracks, power plants) are
collections of map features with no county totals. Use "count_features" to get
a per-county count of them. Use "load" only for attributes that are already
per-county values. The validator will tell you if you pick the wrong one.

Worked example for "poverty rate per capita by county", where a3 is a poverty
count and a8 is total population:

{"intent":"Poverty count divided by population, by county",
 "output_type":"map","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a3","inputs":[]},
          {"id":"s2","op":"load","attr_id":"a8","inputs":[]},
          {"id":"s3","op":"normalize","attr_id":"","inputs":["s1","s2"],"scale":100},
          {"id":"s4","op":"output","attr_id":"","inputs":["s3"]}]}`;

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
      const kind = r.is_feature_table ? " (use count_features)" : "";
      sections.push(
        `${label}: ${(r.attr_desc || "").replace(/\s+/g, " ").slice(0, 120)}` +
        `${kind} [${r.entity_type || "?"}${r.start_date ? " " + r.start_date : ""}]`);
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
  for (const st of plan.steps || []) {
    // Both load and count_features carry a reference label; every other op
    // carries attr_id: "" by schema convention. Missing count_features here
    // left its label untranslated, so grounding rejected a perfectly valid
    // "a1" as an unknown attribute.
    if (!["load", "count_features"].includes(st.op)) continue;
    if (!st.attr_id || !String(st.attr_id).trim()) continue;
    const key = String(st.attr_id).trim();
    if (refs.has(key)) st.attr_id = refs.get(key);
    else unknown.push(key);
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
async function generatePlan({ query, candidates, callLLM, resolve, log = console.log }) {
  const attempts = [];
  let repairContext = "";

  const { refs, text: attrText } = buildRefs(candidates);

  // Only offer count_features when a facility dataset is actually on the table.
  // Op-set size costs a small model accuracy even on ops it cannot use.
  const hasFeatureTables = candidates.some(c => c.is_feature_table);
  const schema = planSchemaFor({ hasFeatureTables });
  const systemPrompt = hasFeatureTables
    ? PLAN_SYSTEM_PROMPT
    : PLAN_SYSTEM_PROMPT
        .replace(/\n  count_features needs attr_id \(a facility dataset\) -> features per county/, "")
        .replace(/\nFacility datasets \(refineries[\s\S]*?wrong one\.\n/, "\n")
        .replace(/ and count_features;/, ";");

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    const userPrompt =
      `QUESTION: ${query}\n\n` +
      `AVAILABLE ATTRIBUTES (use these labels as attr_id):\n${attrText}\n` +
      repairContext;

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
    const unknownRefs = derefPlan(plan, refs);
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
      return { ok: true, plan, resolved: check.resolved, attempts, repairs: attempt };
    }

    log(`   Plan invalid (attempt ${attempt + 1}): ${check.errors.length} error(s)`);
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
  const { sql, params } = compilePlan(plan, resolved);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    const started = Date.now();
    const res = await client.query(sql, params);
    await client.query("COMMIT");
    return {
      sql,
      params,
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

module.exports = { generatePlan, executePlan, PLAN_SYSTEM_PROMPT, MAX_REPAIRS, CompileError };
