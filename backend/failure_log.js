/**
 * A log of every query that did not produce an answer, with enough of the run
 * around it to fix the cause.
 *
 * One JSON object per line in <dir>/failures.jsonl, so it can be grepped,
 * tailed, loaded into pandas, or read by `eval/failures.py`. It sits on a bind
 * mount (deploy/docker-compose.yml, ../logs) so it survives `--force-recreate`
 * and can be read from the host without `docker exec`.
 *
 * "Failed" covers four different things, kept apart in `kind` because they have
 * different remedies (the same split backend/suggestions.js makes for users):
 *
 *   failure   the system broke or the planner gave up: fix code, prompt or model
 *   refusal   it said the data cannot answer this: fix coverage, or it is correct
 *   empty     it ran and returned no rows: usually a filter or a coverage gap
 *   workflow  a multi-step question stopped part-way
 *
 * Recording is fire-and-forget and can never fail a request: a full disk must
 * not turn a refusal into a 500.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE = "failures.jsonl";

// kind -> class. Anything unlisted is a "failure": unknown is the one to look at.
const CLASS = {
  internal_error: "failure",
  execution_error: "failure",
  planner_failed: "failure",
  no_plan: "refusal",
  not_measured: "refusal",
  period_not_covered: "refusal",
  data_not_loaded: "refusal",
  empty_result: "empty",
  workflow_stopped: "workflow",
};

/**
 * Decide whether a finished run counts as a failure, and what kind.
 * Returns null for a run that answered. `status` is the HTTP status the caller
 * will send; `body` is the response payload (or the AnalyzeError payload).
 */
function classify({ status = 200, body = {} }) {
  // Bad input is the caller's mistake, not the system's.
  if (status === 400) return null;
  // Overload is about the server, not the query; /api/health shows the queue.
  if (status === 503) return null;
  if (body.execution_error) return "execution_error";
  if (status >= 500) return "internal_error";
  const err = String(body.error || "");
  if (/could not produce a valid plan/.test(err)) return "planner_failed";
  if (/no analysis could be built/.test(err)) return "no_plan";
  if (/does not measure/.test(err)) return "not_measured";
  if (/does not cover the period/.test(err)) return "period_not_covered";
  if (/no candidate factors/.test(err)) return "no_plan";
  if (body.unavailable_datasets?.length && status === 422) return "data_not_loaded";
  if (/^workflow stopped/.test(err)) return "workflow_stopped";
  if (status >= 400) return "planner_failed";
  // A success that returned nothing. A statistic or feature layer is not empty.
  const nothing = !body.row_count && !body.features?.length && !body.stats && !body.comparison
    && !(body.layers || []).some(l => l.row_count);
  if (body.plan && Object.hasOwn(body, "row_count") && nothing) return "empty_result";
  return null;
}

const clip = (s, n = 300) => {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Collects what the pipeline already announces through `emit`, so the log can
 * show where a run got to and what each planner attempt was told, without any
 * change to the planner. Wrap the caller's emit with `trace.tap(emit)`.
 */
function createTrace() {
  const t = {
    stages: [], decomposition: null, retrieved: null,
    attempts: [], adjustments: [], planning_attempts: 0,
  };
  return {
    data: t,
    tap(emit = () => {}) {
      return (ev) => {
        try {
          if (ev && ev.stage) {
            if (t.stages.at(-1) !== ev.stage) t.stages.push(ev.stage);
            if (ev.stage === "decomposed") { t.decomposition = ev.decomposition ?? null; t.retrieved = ev.retrieved ?? null; }
            if (ev.stage === "planning") t.planning_attempts = Math.max(t.planning_attempts, ev.attempt || 0);
            if ((ev.stage === "plan_invalid" || ev.stage === "plan_irrelevant") && t.attempts.length < 6) {
              t.attempts.push({ attempt: ev.attempt, stage: ev.stage,
                errors: (ev.errors || []).slice(0, 8).map(e => clip(e)) });
            }
            if (ev.stage === "plan_adjusted" && t.adjustments.length < 20) t.adjustments.push(clip(ev.detail, 200));
          }
        } catch { /* a trace must never break the run */ }
        return emit(ev);
      };
    },
  };
}

/** Ollama's view of what is resident, to catch the CPU-fallback and VRAM-stall traps. */
async function ollamaState(ollamaUrl, timeoutMs = 1500) {
  try {
    const r = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const { models = [] } = await r.json();
    return models.map(m => ({
      name: m.name,
      size_gb: +(m.size / 1e9).toFixed(2),
      // 100 means fully on the GPU. Anything lower, or 0, is the trap.
      gpu_pct: m.size ? Math.round(100 * (m.size_vram || 0) / m.size) : null,
      context: m.context_length ?? null,
    }));
  } catch (err) {
    return { error: err.message };
  }
}

function createFailureLog({ dir, maxBytes = 20 * 1024 * 1024, warn = console.warn } = {}) {
  const file = dir ? path.join(dir, FILE) : null;
  let ready = null;

  async function init() {
    if (!file) return false;
    ready ??= fs.promises.mkdir(dir, { recursive: true }).then(() => true).catch(err => {
      warn(`failure log disabled: cannot create ${dir}: ${err.message}`);
      return false;
    });
    return ready;
  }

  async function rotate() {
    try {
      const { size } = await fs.promises.stat(file);
      if (size >= maxBytes) await fs.promises.rename(file, `${file}.1`);
    } catch { /* no file yet */ }
  }

  /** Append one entry. Resolves either way; never rejects. */
  async function record(entry) {
    try {
      if (!(await init())) return false;
      await rotate();
      await fs.promises.appendFile(file, JSON.stringify(entry) + "\n");
      return true;
    } catch (err) {
      warn(`failure log write failed: ${err.message}`);
      return false;
    }
  }

  /** Newest first. `kind` and `cls` filter; `q` is a case-insensitive substring. */
  async function read({ limit = 50, kind, cls, q } = {}) {
    if (!file) return [];
    let text;
    try { text = await fs.promises.readFile(file, "utf8"); } catch { return []; }
    const out = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (kind && e.kind !== kind) continue;
      if (cls && e.class !== cls) continue;
      if (q && !String(e.query).toLowerCase().includes(String(q).toLowerCase())) continue;
      out.push(e);
    }
    return out;
  }

  return { record, read, file };
}

/** Build the entry. Pure, so it is testable without a server. */
function buildEntry({ query, kind, status, body = {}, trace, flags = {}, env = {}, ollama, ms, via, workflow }) {
  const planErrors = body.validation_errors || trace?.attempts?.at(-1)?.errors || [];
  return {
    id: crypto.randomBytes(5).toString("hex"),
    ts: new Date().toISOString(),
    query,
    kind,
    class: CLASS[kind] || "failure",
    status,
    // The headline, in the words the user saw.
    error: clip(body.error, 400),
    detail: clip(body.detail || body.details || body.execution_error, 600),
    ms,
    via: via || null,
    // How far it got: the stages reached, in order. The last one is where it stopped.
    stage_reached: trace?.stages?.at(-1) ?? null,
    stages: trace?.stages ?? [],
    decomposition: trace?.decomposition ?? body.decomposition ?? null,
    retrieved: trace?.retrieved ?? null,
    planning_attempts: trace?.planning_attempts || body.attempts || 0,
    // What the validator / relevance check said on each attempt.
    attempts: trace?.attempts ?? [],
    validation_errors: planErrors.slice(0, 8).map(e => clip(e)),
    adjustments: trace?.adjustments ?? [],
    // Verdicts for attributes the relevance check refused.
    rejected_attributes: (body.rejected_attributes || []).slice(0, 5)
      .map(v => ({ attr_id: v.attr_id, description: clip(v.description, 120), verdict: v.verdict })),
    unavailable_datasets: body.unavailable_datasets || [],
    // Top candidates the planner was shown, to tell a retrieval miss from a planning miss.
    candidates: (body.candidates || body.retrieved || []).slice(0, 8)
      .map(c => ({ attr_id: c.attr_id, desc: clip(c.attr_desc || c.description, 100), dataset: c.dataset_clean ?? null })),
    plan: body.plan ?? null,
    sql: body.execution_error ? clip(body.sql, 4000) : undefined,
    stack: body.stack ? clip(body.stack, 2000) : undefined,
    workflow: workflow ?? undefined,
    flags,
    env,
    ollama,
  };
}

module.exports = { createFailureLog, createTrace, classify, buildEntry, ollamaState, CLASS, FILE };
