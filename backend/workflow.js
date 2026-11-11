/**
 * Research workflows: a question that needs the RESULT of one analysis as the
 * input to another. Phase D of docs/RESEARCH_PLAN.md; design in
 * docs/WORKFLOWS.md.
 *
 *   "Take the 50 counties with the highest adult obesity rates. How does their
 *    median household income compare with the rest of the country?"
 *
 * One plan cannot say that today, and a bigger single plan is the wrong fix:
 * op-set size is what costs this planner accuracy. So a workflow is a short
 * list of ordinary questions, each answered by the ordinary pipeline
 * (retrieve -> plan -> validate -> execute), where a later question can use the
 * counties an earlier one produced.
 *
 * WHAT KEEPS IT HONEST, in the same spirit as the planner:
 *
 *   1. An earlier result reaches a later step as a GROUNDED source, `result:q1`,
 *      an inline series built from the executed rows -- never as text the model
 *      could paraphrase. The validator's rule ("cite only what a tool
 *      returned") therefore covers workflow references with no new code.
 *   2. A step is offered ONLY the results it declared it uses, and must cite
 *      each of them. A step that says it works on q1's counties and then plans
 *      over the whole country has answered a different question; the workflow
 *      stops there and says so, rather than reporting a plausible answer.
 *   3. A one-step decomposition runs the user's ORIGINAL text, never the
 *      model's restatement: a rewrite that drops a word changes the question
 *      (the follow-up rewriter's lesson, docs/FOLLOWUPS.md).
 *   4. A failure or refusal at any step stops the workflow with a partial
 *      report naming the step. Later steps never run on a missing input.
 *
 * The decomposer and the analysis are injected, so this file holds no
 * database or model access and is tested with scripts (test_workflow.js).
 */

const MAX_STEPS = Number(process.env.WORKFLOW_MAX_STEPS ?? 4);
const RESULT_PREFIX = "result:";
const ID_RE = /^q[1-9]\d?$/;

const DECOMPOSE_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STEPS,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "q1, q2, ... in order" },
          question: { type: "string" },
          uses: { type: "array", items: { type: "string" },
                  description: "ids of EARLIER steps whose counties this step works on" },
        },
        required: ["id", "question", "uses"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
};

// The worked example is deliberately NOT a question in eval/research.yaml: an
// example the suite also asks would measure recitation, the failure this
// project already paid for once (the planner copying its examples' labels).
const DECOMPOSE_PROMPT = `You split a geographic research question into the analyses needed to answer it.

Most questions need ONE analysis. Split only when a later part needs the RESULT
of an earlier part: a set of counties chosen by one measure, then examined with
another measure. A question with several conditions ("rural counties with high
poverty and no hospital") is still ONE analysis.

Rules:
- Each step is one question that a single map or table answers.
- Write a later step's reference to an earlier result exactly as
  "the counties from q1" (or q2 ...), and list that id in "uses".
- "uses" may only name EARLIER steps.
- Never add a step the question did not ask for. At most ${MAX_STEPS} steps.

EXAMPLE
QUESTION: Find the 20 counties with the lowest broadband access. Is their unemployment rate higher than in other counties?
{"steps":[
 {"id":"q1","question":"Which 20 counties have the lowest broadband access?","uses":[]},
 {"id":"q2","question":"Is the unemployment rate higher in the counties from q1 than in all other counties?","uses":["q1"]}]}

EXAMPLE
QUESTION: Which mostly rural counties have an uninsured rate above 15 percent?
{"steps":[{"id":"q1","question":"Which mostly rural counties have an uninsured rate above 15 percent?","uses":[]}]}`;

/**
 * Whether a question can need a workflow at all: a later part REFERS BACK to
 * an earlier one ("their", "those", "among them"), or it is several sentences.
 *
 * Measured 2026-11-09, before this gate: the decomposer split 4 of 15
 * one-plan questions in research.yaml ("Which counties' unemployment rate rose
 * the most over the last decade?" became "compute the change" then "rank it"),
 * and two of those splits cost the answer. None of the four refers back; the
 * one real workflow question does ("How does THEIR median household income").
 * English anaphora, not a term list. The error is in the safe direction: a
 * missed workflow runs as one plan, which is exactly the behaviour before
 * Phase D. Over 121 eval questions it fires on 1, the workflow question.
 * "St. Louis" is not a sentence break: a stop needs a word of 3+ letters.
 */
const REFERS_BACK =
  /\b(their|they|them|those|these|such\s+counties|that\s+group|each\s+of\s+them|among\s+them|of\s+them)\b/i;
const SEVERAL_SENTENCES = /[A-Za-z]{3,}[.?!]\s+[A-Z]/;
// Where a later part can start inside one sentence: "...; then ...",
// "... and map their ...", "...: of those, ...".
const CLAUSE_BREAK = /[;:]\s*|,?\s+(?:and\s+)?then\s+|\s+and\s+|,\s*(?=(?:of|among|for)\s+(?:those|them|these)\b)/i;

/**
 * A back-reference counts only when it points ACROSS a break. Within one
 * clause it refers to the counties being asked about: "which counties have a
 * higher unemployment rate than the average of THEIR neighboring counties" is
 * one plan (a spatial lag), and the gate split it, the first step returned a
 * summary, and the workflow stopped (research_advanced.yaml, 2026-11-11).
 */
function needsWorkflow(question) {
  const q = String(question || "");
  if (SEVERAL_SENTENCES.test(q)) return true;
  const m = CLAUSE_BREAK.exec(q);
  return !!m && REFERS_BACK.test(q.slice(m.index + m[0].length));
}

/**
 * Check a decomposition and normalise it. Returns {steps, errors}; with any
 * error the caller falls back to running the question as one step.
 */
function validateDecomposition(dec, question) {
  const errors = [];
  const raw = Array.isArray(dec?.steps) ? dec.steps : [];
  if (!raw.length) return { steps: null, errors: ["no steps"] };
  if (raw.length > MAX_STEPS) errors.push(`${raw.length} steps; the limit is ${MAX_STEPS}`);
  const seen = [];
  const steps = raw.map((s, i) => {
    const id = String(s?.id || "").trim();
    const text = String(s?.question || "").replace(/\s+/g, " ").trim();
    if (!ID_RE.test(id)) errors.push(`step ${i + 1}: id ${JSON.stringify(id)} is not q1, q2 ...`);
    if (seen.includes(id)) errors.push(`step ${i + 1}: duplicate id ${id}`);
    if (text.length < 8) errors.push(`step ${id || i + 1}: empty question`);
    // A reference written in the text counts as a use even if the model forgot
    // to list it; a listed use must name an earlier step.
    const mentioned = [...text.matchAll(/\bq([1-9]\d?)\b/gi)].map(m => `q${m[1]}`);
    const uses = [...new Set([...(s?.uses || []).map(String), ...mentioned])].filter(u => u !== id);
    for (const u of uses) {
      if (!seen.includes(u)) errors.push(`step ${id}: uses ${u}, which is not an earlier step`);
    }
    seen.push(id);
    return { id, question: text, uses };
  });
  if (errors.length) return { steps: null, errors };
  // One step: the user's own words, not the model's restatement of them.
  if (steps.length === 1) steps[0] = { id: "q1", question, uses: [] };
  // Every step but the last must feed something, or it is a step the question
  // did not need (and a cost the user pays for nothing).
  const fed = new Set(steps.flatMap(s => s.uses));
  const idle = steps.slice(0, -1).filter(s => !fed.has(s.id)).map(s => s.id);
  if (idle.length) {
    return { steps: null, errors: [`step(s) ${idle.join(", ")} feed no later step`] };
  }
  return { steps, errors: [] };
}

/** The layer a step's answer lives in: the first per-county values layer. */
function answerLayer(res) {
  const layers = Array.isArray(res?.layers) && res.layers.length ? res.layers : [res];
  return layers.find(l => l && l.mode !== "features" && !l.part &&
    Array.isArray(l.rows) && l.rows.some(r => r.fips)) || null;
}

/**
 * A compact, model-safe summary of a step's result: what the next step is told,
 * and what the report shows. Never raw rows.
 */
function summarize(res) {
  const layer = answerLayer(res);
  if (!layer) return null;
  const rows = layer.rows.filter(r => r.fips);
  const vals = rows.map(r => r.value).filter(v => v !== null && v !== undefined && Number.isFinite(v));
  const top = [...rows].filter(r => r.value !== null)
    .sort((a, b) => b.value - a.value).slice(0, 3)
    .map(r => r.name ? `${r.name} (${r.fips})` : r.fips);
  return {
    counties: rows.length,
    min: vals.length ? Math.min(...vals) : null,
    max: vals.length ? Math.max(...vals) : null,
    examples: top,
  };
}

const fmt = (v) => v === null || v === undefined ? "?"
  : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : Number(v.toPrecision(3)).toString();

/**
 * An executed step's counties as a grounded source for later steps.
 *
 * source_kind "inline" is the user-upload path (load binds the arrays into
 * unnest(...) inside the READ ONLY transaction), so nothing is written and the
 * compiler needs no change. `workflow_step` marks it for provenance.
 */
function resultSource(step, res) {
  const layer = answerLayer(res);
  if (!layer) return null;
  const rows = layer.rows.filter(r => r.fips);
  const s = summarize(res);
  const what = String(res?.plan?.intent || step.question).replace(/\s+/g, " ").slice(0, 120);
  return {
    attr_id: RESULT_PREFIX + step.id,
    source_kind: "inline",
    workflow_step: step.id,
    description: `Counties from ${step.id}: ${what} (${s.counties} counties, ` +
                 `values ${fmt(s.min)} to ${fmt(s.max)})`,
    dataset: `Result of step ${step.id}`,
    fips: rows.map(r => String(r.fips)),
    values: rows.map(r => (r.value === null || r.value === undefined ? null : Number(r.value))),
    row_count: rows.length,
  };
}

/** The candidate row the planner sees for an earlier result. */
function resultCandidate(src) {
  return {
    attr_id: src.attr_id,
    attr_desc: src.description,
    dataset_clean: src.dataset,
    entity_type: "COUNTY",
    search_purpose: "earlier",
    is_workflow_result: true,
  };
}

/** The result ids a step's plan cites. */
const citedResults = (plan) => new Set((plan?.steps || [])
  .map(s => s.attr_id).filter(id => typeof id === "string" && id.startsWith(RESULT_PREFIX)));

/**
 * Run a research question as a workflow.
 *
 * @param decompose  async (systemPrompt, userPrompt, schema) => raw JSON string
 * @param analyze    async ({ query, extraSources: Map }) => /api/analyze body
 * @returns the report: { status, steps, stopped_at?, reason?, final, methods }
 */
async function runWorkflow({ question, decompose, analyze, log = () => {}, emit = () => {} }) {
  const started = Date.now();
  let steps = null;
  let decomposition = { errors: [] };
  if (!needsWorkflow(question)) {
    // No part refers back to another: one plan, and no decomposition call.
    log(`   workflow: one step (no reference between parts of the question)`);
    decomposition = { errors: [], gated: true };
    steps = [{ id: "q1", question, uses: [] }];
  } else try {
    const raw = await decompose(DECOMPOSE_PROMPT, `QUESTION: ${question}`, DECOMPOSE_SCHEMA);
    decomposition = validateDecomposition(JSON.parse(raw), question);
    steps = decomposition.steps;
  } catch (err) {
    decomposition = { errors: [`decomposition failed: ${err.message}`] };
  }
  if (!steps) {
    // Never worse than a plain analysis: an unusable split runs the question
    // as asked, and the report says why.
    log(`   workflow: running as one step (${decomposition.errors.join("; ")})`);
    steps = [{ id: "q1", question, uses: [] }];
  }
  log(`   workflow: ${steps.length} step(s): ${steps.map(s => `${s.id}${s.uses.length ? `<-${s.uses.join(",")}` : ""}`).join(" ")}`);
  emit({ stage: "workflow_planned", steps });

  const sources = new Map();
  const done = [];
  const report = (extra) => ({
    question, steps: done,
    decomposition: { steps: steps.map(s => ({ ...s })),
                     gated: decomposition.gated === true,
                     fallback: decomposition.errors.length ? decomposition.errors : null },
    ms: Date.now() - started,
    ...extra,
  });

  for (const step of steps) {
    const extraSources = new Map(step.uses.map(u => [RESULT_PREFIX + u, sources.get(RESULT_PREFIX + u)]));
    emit({ stage: "workflow_step", id: step.id, question: step.question });
    const t0 = Date.now();
    let res;
    try {
      res = await analyze({ query: step.question, extraSources });
    } catch (err) {
      res = { error: err.message };
    }
    const entry = {
      id: step.id, question: step.question, uses: step.uses, ms: Date.now() - t0,
      intent: res?.plan?.intent || null,
      ops: (res?.plan?.steps || []).map(s => s.op),
      summary: summarize(res),
      error: res?.error || res?.execution_error || null,
      response: res,
    };
    done.push(entry);

    if (entry.error || !res?.plan) {
      return report({ status: "stopped", stopped_at: step.id,
        reason: `${step.id} could not be answered: ${entry.error || "no plan"}`, final: res });
    }
    // Rule 2: a step that declared it works on an earlier result must use it.
    const cited = citedResults(res.plan);
    const missing = step.uses.filter(u => !cited.has(RESULT_PREFIX + u));
    if (missing.length) {
      return report({ status: "stopped", stopped_at: step.id, final: res,
        reason: `${step.id} was meant to work on the counties from ${missing.join(", ")}, ` +
                `but its plan did not use them, so it answered a different question.` });
    }
    const src = resultSource(step, res);
    if (src) sources.set(src.attr_id, src);
    else if (steps.some(s => s.uses.includes(step.id))) {
      return report({ status: "stopped", stopped_at: step.id, final: res,
        reason: `${step.id} produced a summary rather than a set of counties, ` +
                `which the next step needs.` });
    }
  }

  const final = done.at(-1).response;
  return report({ status: "complete", final, methods: methods(question, done) });
}

/**
 * Re-run a workflow whose steps already have plans, applying one edit to one
 * step: "swap the data" from the pipeline UI.
 *
 * No planner and no decomposer: every step re-executes the plan it already
 * has, in order, so the steps BEFORE the edited one reproduce their results
 * and the ones after it see the edited step's new counties. Upstream steps are
 * re-executed rather than trusting rows a browser sent back, because their
 * counties become grounded sources for the next step. That is a few hundred
 * milliseconds of SQL per step.
 *
 * The same rules as runWorkflow: a step that no longer cites a result it uses
 * stops the workflow, and so does a failure. The plans come from the client
 * and are untrusted; `execute` validates each one exactly like a model plan.
 *
 * @param steps    [{ id, question, uses, plan, candidate_ids? }] in order
 * @param edit     { step: "q2", ...a follow-up edit } or null to re-run as is
 * @param execute  async ({ step, plan, extraSources, edit }) => analyze body
 */
async function rerunWorkflow({ question, steps, edit, execute, log = () => {} }) {
  const started = Date.now();
  const errs = [];
  if (!Array.isArray(steps) || !steps.length) errs.push("no steps");
  else if (steps.length > MAX_STEPS) errs.push(`more than ${MAX_STEPS} steps`);
  const seen = [];
  for (const s of steps || []) {
    if (!ID_RE.test(String(s?.id || ""))) errs.push(`bad step id ${JSON.stringify(s?.id)}`);
    if (!s?.plan || !Array.isArray(s.plan.steps)) errs.push(`step ${s?.id}: no plan`);
    for (const u of s?.uses || []) if (!seen.includes(u)) errs.push(`step ${s.id}: uses ${u}, not an earlier step`);
    seen.push(s?.id);
  }
  if (edit && !seen.includes(edit.step)) errs.push(`edit names step ${JSON.stringify(edit.step)}, which is not in the workflow`);
  if (errs.length) return { status: "invalid", errors: errs };

  const sources = new Map();
  const done = [];
  const report = (extra) => ({
    question, steps: done, ms: Date.now() - started,
    decomposition: { steps: steps.map(s => ({ id: s.id, question: s.question, uses: s.uses || [] })),
                     gated: false, fallback: null },
    edited_step: edit?.step || null,
    ...extra,
  });
  for (const raw of steps) {
    const step = { id: raw.id, question: String(raw.question || ""), uses: raw.uses || [] };
    const extraSources = new Map(step.uses.map(u => [RESULT_PREFIX + u, sources.get(RESULT_PREFIX + u)]));
    const t0 = Date.now();
    let res;
    try {
      res = await execute({ step, plan: raw.plan, candidateIds: raw.candidate_ids || [],
                            extraSources, edit: edit && edit.step === step.id ? edit : null });
    } catch (err) {
      res = { error: err.message };
    }
    const entry = {
      id: step.id, question: step.question, uses: step.uses, ms: Date.now() - t0,
      intent: res?.plan?.intent || null, ops: (res?.plan?.steps || []).map(s => s.op),
      summary: summarize(res), error: res?.error || res?.execution_error || null,
      edited: !!(edit && edit.step === step.id), response: res,
    };
    done.push(entry);
    if (entry.error || !res?.plan) {
      return report({ status: "stopped", stopped_at: step.id, final: res,
        reason: `${step.id} could not be re-run: ${entry.error || "no plan"}${res?.detail ? ` (${res.detail})` : ""}` });
    }
    const cited = citedResults(res.plan);
    const missing = step.uses.filter(u => !cited.has(RESULT_PREFIX + u));
    if (missing.length) {
      return report({ status: "stopped", stopped_at: step.id, final: res,
        reason: `${step.id} no longer uses the counties from ${missing.join(", ")}.` });
    }
    const src = resultSource(step, res);
    if (src) sources.set(src.attr_id, src);
    else if (steps.some(s => (s.uses || []).includes(step.id))) {
      return report({ status: "stopped", stopped_at: step.id, final: res,
        reason: `${step.id} now produces a summary rather than a set of counties, which the next step needs.` });
    }
    log(`   rerun ${step.id}${entry.edited ? " (edited)" : ""}: ${entry.summary?.counties ?? 0} counties`);
  }
  return report({ status: "complete", final: done.at(-1).response, methods: methods(question, done) });
}

/** A methods paragraph, built from what each step actually did. */
function methods(question, done) {
  const lines = [`Question: ${question}`];
  for (const s of done) {
    const r = s.response || {};
    const data = ((r.provenance || {}).attribute_origins || [])
      .filter(o => !String(o.attr_id || "").startsWith(RESULT_PREFIX))
      .map(o => `${o.description || o.census_code || o.table_name}` +
                `${o.dataset ? ` (${o.dataset}${o.start_date ? `, ${o.start_date}` : ""})` : ""}`);
    const defs = ((r.provenance || {}).definitions || [])
      .map(d => `"${d.term}" = ${d.rule} (${d.source})`);
    lines.push(
      `${s.id}. ${s.question}` +
      `${s.uses.length ? ` [uses ${s.uses.join(", ")}]` : ""}\n` +
      `   Plan: ${s.intent || ""} (${s.ops.join(" -> ")}).` +
      (data.length ? `\n   Data: ${data.join("; ")}.` : "") +
      (defs.length ? `\n   Definitions: ${defs.join("; ")}.` : "") +
      ((r.adjustments || []).length ? `\n   Adjusted: ${r.adjustments.join(" ")}` : "") +
      (s.summary ? `\n   Result: ${s.summary.counties} counties, ${fmt(s.summary.min)} to ${fmt(s.summary.max)}.` : ""));
  }
  return lines.join("\n");
}

/** Resolver that answers `result:` ids from this workflow step's sources only. */
function withResultSources(resolve, extraSources) {
  if (!extraSources || !extraSources.size) return resolve;
  return async (ids) => {
    const mine = ids.filter(id => extraSources.has(id));
    const rest = ids.filter(id => !extraSources.has(id));
    const out = rest.length ? await resolve(rest) : new Map();
    for (const id of mine) out.set(id, extraSources.get(id));
    return out;
  };
}

module.exports = {
  runWorkflow, rerunWorkflow, validateDecomposition, needsWorkflow, resultSource, resultCandidate, summarize,
  withResultSources, methods, citedResults,
  DECOMPOSE_PROMPT, DECOMPOSE_SCHEMA, MAX_STEPS, RESULT_PREFIX,
};
