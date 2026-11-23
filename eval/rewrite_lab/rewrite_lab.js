#!/usr/bin/env node
/**
 * Follow-up rewrite lab.
 *
 * Question it answers: for follow-ups that need the previous result's context
 * ("how many people live in this 5 minute band?"), which combination of
 *     model x reasoning (think) x output-token cap x prompt variant
 * turns them into a standalone question that works, most of the time?
 *
 * It calls Ollama directly, so it can set things the API does not expose
 * (think on/off, num_predict, a different prompt, a different schema). Every
 * rewrite still goes through the REAL production code in backend/followup.js
 * (isContinuation, the dropped-word guard, the added-word guard, the
 * measure-on-screen guard), so "final" below is what the app would actually
 * run, and "raw" is what the model said before those guards touched it.
 *
 * -----------------------------------------------------------------------------
 * HOW TO RUN
 * -----------------------------------------------------------------------------
 * Needs Node 18+ (global fetch) and this repo checked out (it requires
 * ../../backend/followup.js). No npm install: only built-in modules.
 *
 * A. On the server, from the repo root, talking to a local Ollama:
 *
 *      node eval/rewrite_lab/rewrite_lab.js --ollama http://localhost:11434 \
 *           --model gemma3:4b,qwen3:14b,gemma3:27b
 *
 * B. Server with no Node installed: use the API container (Node 20, has the
 *    code; Ollama is reachable as http://ollama:11434 on the compose network):
 *
 *      docker cp eval/rewrite_lab/rewrite_lab.js geoark-api-1:/tmp/rewrite_lab.js
 *      docker exec geoark-api-1 sh -c 'cd /app && node /tmp/rewrite_lab.js \
 *           --ollama http://ollama:11434 --model qwen3:14b --root /app'
 *
 *    (--root tells it where followup.js lives when the script is not inside
 *    the repo. In the container that is /app.)
 *
 * Pull the models first (`ollama pull gemma3:27b`). A 27b model will not fit
 * beside the planner on a small card: Ollama swaps models, so the first call
 * for each model is slow (loading). The latency column is the mean over all
 * calls; look at --verbose for the per-call number.
 *
 * Typical experiments:
 *
 *   # 1. Is reasoning worth it?  (same model, think off vs on, room to think)
 *   node eval/rewrite_lab/rewrite_lab.js --model qwen3:14b \
 *        --think off,on --max-tokens 512,4096
 *
 *   # 2. Does the prompt matter?  (all four prompt variants, one model)
 *   node eval/rewrite_lab/rewrite_lab.js --model gemma3:27b \
 *        --variants baseline,header,explicit,cot
 *
 *   # 3. The full grid, repeated (reasoning is sampled, so repeat it)
 *   node eval/rewrite_lab/rewrite_lab.js --model qwen3:14b,gemma3:27b \
 *        --think off,on --max-tokens 1024,4096 --variants baseline,explicit,cot \
 *        --repeat 3 --temperature 0.3 --out grid.json
 *
 *   # 4. Does the rewrite actually PLAN?  Sends each passing rewrite to the
 *   #    running API (slow: one planner run each, so narrow the grid first).
 *   node eval/rewrite_lab/rewrite_lab.js --model gemma3:27b --variants explicit \
 *        --e2e http://localhost:8080
 *
 * Flags (comma lists make a grid):
 *   --ollama URL        Ollama base URL (default $OLLAMA_URL or http://localhost:11434)
 *   --model a,b         models
 *   --think off,on      reasoning. "on" = think:true; also passes any other
 *                       value through (gpt-oss takes low|medium|high)
 *   --max-tokens 512    num_predict. With think on, reasoning tokens COUNT
 *                       against this, so a small cap cuts the answer off
 *   --variants a,b      baseline | header | explicit | cot  (add your own below)
 *   --cases id,id       only these case ids (default all)
 *   --repeat N          repeats per cell (default 1)
 *   --temperature T     default 0. Use 0.3-0.6 with think on, and --repeat
 *   --num-ctx N         default 8192
 *   --e2e URL           also run each text-passing rewrite through POST
 *                       URL/api/analyze and require a plan (no "does not
 *                       include", no error)
 *   --root DIR          where backend/followup.js is (default: two levels up
 *                       from this file; in the container use /app)
 *   --out FILE          save every call as JSON
 *   --verbose           print each call's raw and final question
 *
 * -----------------------------------------------------------------------------
 * HOW TO READ THE RESULT
 * -----------------------------------------------------------------------------
 * pass%     share of calls whose FINAL question satisfies the case's checks:
 *           every `must` group has at least one alternative present, no
 *           `must_not` string present. This is a text check, the same style as
 *           eval/followup.yaml. It can't tell a fluent wrong answer from a
 *           right one, which is why --e2e exists.
 * raw%      same check on the model's rewrite BEFORE the production guards. If
 *           raw% is well above pass%, the guards are throwing away good
 *           rewrites (the lab found this: "within" and a measure-name check
 *           both rejected correct answers). That is a guard problem, not a
 *           model or prompt problem.
 * skipped   cases the app would not send to the model at all (isContinuation
 *           says it is already a complete question). Counted as "final = typed".
 * guarded   calls where a production guard threw the model's rewrite away and
 *           fell back. A high number means the model is fighting the guards,
 *           not that the guards are wrong.
 * tok/s     mean output tokens (with think on this includes the reasoning)
 * cut       calls that hit the max-tokens cap before finishing
 *
 * Reasoning is sampled and the cases are few: do not believe a difference of
 * one or two cases. Repeat (--repeat 3) before drawing a conclusion. The cases
 * mix kinds of result (service areas, routes, mapped features, choropleths,
 * rasters) on purpose: a prompt that only helps the band case is the wrong fix.
 * Add your own to CASES below. Do not tune the prompt on a case and then count
 * that case as evidence; keep some of them unseen until the end (mark `heldout`).
 */

"use strict";
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- arguments
function parseArgs(argv) {
  const a = { ollama: process.env.OLLAMA_URL || "http://localhost:11434", model: ["gemma3:4b"],
    think: ["off"], maxTokens: [512], variants: ["baseline"], cases: null, repeat: 1,
    temperature: 0, numCtx: 8192, e2e: null, root: null, out: null, verbose: false };
  const list = (v) => String(v).split(",").map(s => s.trim()).filter(Boolean);
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--ollama") a.ollama = v().replace(/\/$/, "");
    else if (k === "--model") a.model = list(v());
    else if (k === "--think") a.think = list(v());
    else if (k === "--max-tokens") a.maxTokens = list(v()).map(Number);
    else if (k === "--variants") a.variants = list(v());
    else if (k === "--cases") a.cases = list(v());
    else if (k === "--repeat") a.repeat = Number(v());
    else if (k === "--temperature") a.temperature = Number(v());
    else if (k === "--num-ctx") a.numCtx = Number(v());
    else if (k === "--e2e") a.e2e = v().replace(/\/$/, "");
    else if (k === "--root") a.root = v();
    else if (k === "--out") a.out = v();
    else if (k === "--verbose") a.verbose = true;
    else if (k === "-h" || k === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
    else { console.error(`unknown flag ${k}`); process.exit(2); }
  }
  return a;
}
const args = parseArgs(process.argv);

const root = args.root || path.resolve(__dirname, "..", "..", "backend");
const followup = require(path.join(root.endsWith("backend") || fs.existsSync(path.join(root, "followup.js"))
  ? root : path.join(root, "backend"), "followup.js"));

// -------------------------------------------------------------------- cases
// history: earlier turns as the app sends them ({query, intent, measures}).
// measure / area: what the app derives from the plan on screen. A result with
// no measure (service areas, routes, mapped points) has measure: null, which is
// exactly where the rewrite has the least to hold on to.
// must: groups, each satisfied by ANY alternative (case-insensitive substring).
const WALK = { query: "Map the 5, 10 and 15-minute walking times around the fire stations in St. Louis.",
  intent: "Walking-time service areas around fire stations in St. Louis", measures: [] };
const CASES = [
  // --- results with no measure on screen (the failing family) -----------------
  { id: "band-this", history: [WALK], measure: null, area: null,
    text: "how many people live in this 5 minute band?",
    must: [["people", "population"], ["5"], ["walk"], ["fire station"], ["St. Louis"]], must_not: ["State"] },
  { id: "band-other", history: [WALK], measure: null, area: null,
    text: "what about the 10 minute band?",
    must: [["10"], ["walk"], ["fire station"], ["St. Louis"]] },
  { id: "band-mode", history: [WALK], measure: null, area: null,
    text: "same but driving",
    must: [["driv"], ["fire station"], ["St. Louis"], ["5"]], must_not: ["walk"] },
  { id: "band-area", history: [WALK], measure: null, area: null,
    text: "how big is the outer ring?",
    must: [["15"], ["walk"], ["fire station"], ["St. Louis"]] },
  { id: "points-count", heldout: true,
    history: [{ query: "where are the fire stations in Springfield, Missouri", intent: "Fire stations in Springfield, Missouri", measures: [] }],
    measure: null, area: ["Missouri"], text: "how many are there?",
    must: [["fire station"], ["Springfield"], ["Missouri"]] },
  { id: "points-swap-layer", heldout: true,
    history: [{ query: "where are the hospitals in Ohio", intent: "Hospitals in Ohio", measures: [] }],
    measure: null, area: ["Ohio"], text: "and the nursing homes?",
    must: [["nursing home"], ["Ohio"]], must_not: ["hospital"] },
  { id: "route-time", heldout: true,
    history: [{ query: "Show the fastest driving route from each fire station in Columbia, Missouri to the nearest hospital",
      intent: "Driving routes from fire stations to the nearest hospital in Columbia, Missouri", measures: [] }],
    measure: null, area: null, text: "which one takes the longest?",
    must: [["route", "drive", "driving"], ["fire station"], ["hospital"], ["Columbia"]] },
  { id: "route-mode", heldout: true,
    history: [{ query: "Show the fastest driving route from each fire station in Columbia, Missouri to the nearest hospital",
      intent: "Driving routes from fire stations to the nearest hospital in Columbia, Missouri", measures: [] }],
    measure: null, area: null, text: "now walking",
    must: [["walk"], ["fire station"], ["hospital"], ["Columbia"]], must_not: ["driv"] },
  // --- results with a measure on screen ---------------------------------------
  { id: "measure-swap-place", history: [{ query: "poverty rate for Ohio counties", intent: "Poverty rate for Ohio counties", measures: ["Poverty rate"] }],
    measure: "Poverty rate", area: ["Ohio"], text: "and for Indiana?",
    must: [["poverty"], ["Indiana"]], must_not: ["Ohio"] },
  { id: "measure-operation", history: [{ query: "total population by county in the Midwest", intent: "Total population by county in the Midwest", measures: ["Total population"] }],
    measure: "Total population", area: ["Midwest"], text: "make it per square mile",
    must: [["population"], ["square mile"], ["Midwest"]] },
  { id: "measure-hotspot", history: [{ query: "uninsured rate by county in Texas", intent: "Uninsured rate by county in Texas", measures: ["Uninsured rate"] }],
    measure: "Uninsured rate", area: ["Texas"], text: "where are the hot spots?",
    must: [["uninsured"], ["Texas"], ["hot spot", "hotspot", "cluster"]] },
  { id: "measure-relate", heldout: true,
    history: [{ query: "adult obesity rate by county in Georgia", intent: "Adult obesity rate by county in Georgia", measures: ["Adult obesity"] }],
    measure: "Adult obesity", area: ["Georgia"], text: "is that linked to diabetes?",
    must: [["obesity"], ["diabetes"], ["Georgia"]] },
  { id: "measure-year", history: [{ query: "unemployment rate by county in 2018", intent: "Unemployment rate by county in 2018", measures: ["Unemployment rate"] }],
    measure: "Unemployment rate", area: null, text: "what about 2021?",
    must: [["unemployment"], ["2021"]], must_not: ["2018"] },
  { id: "raster-year", heldout: true,
    history: [{ query: "share of each county in Missouri that is forest in 2021", intent: "Forest share by Missouri county, 2021", measures: ["NLCD land cover"] }],
    measure: "NLCD land cover", area: ["Missouri"], text: "same for 2016",
    must: [["forest"], ["Missouri"], ["2016"]], must_not: ["2021"] },
  { id: "distance-layer", heldout: true,
    history: [{ query: "how far is each county from the nearest hospital", intent: "Distance to the nearest hospital", measures: [] }],
    measure: null, area: null, text: "what about airports instead?",
    must: [["airport"], ["nearest", "far", "distance"]], must_not: ["hospital"] },
  { id: "two-turns", heldout: true,
    history: [{ query: "median household income in Missouri counties", intent: "Median household income, Missouri", measures: ["Median household income"] },
              { query: "what about Kansas?", intent: "Median household income, Kansas", measures: ["Median household income"] }],
    measure: "Median household income", area: ["Kansas"], text: "and the poverty rate there?",
    must: [["poverty"], ["Kansas"]] },
];

// ------------------------------------------------------------------ variants
// A variant turns (the production prompt, the case) into {system, schema}.
// Add your own here. Keep `schema` including `question`: production reads it.
const HEADER = "Earlier in this conversation (the user is looking at the answer to the LAST question, and the follow-up is about that answer, so carry its layer, place and travel mode into your question):";
const COT_SCHEMA = {
  type: "object",
  properties: { refers_to: { type: "string" }, left_implicit: { type: "string" }, question: { type: "string" } },
  required: ["refers_to", "left_implicit", "question"],
};

const VARIANTS = {
  // The prompt as it ships.
  baseline: ({ base }) => ({ system: base, schema: followup.REWRITE_SCHEMA }),

  // One sentence of framing: the user is looking at the last answer.
  header: ({ base }) => ({ system: base.replace("Earlier in this conversation:", HEADER), schema: followup.REWRITE_SCHEMA }),

  // A different rule set: states the goal (a stranger could answer it), names
  // what usually goes missing, and says how to refer to a PART of a result.
  explicit: ({ history, text, area, measure }) => ({
    schema: followup.REWRITE_SCHEMA,
    system: `You turn a follow-up message into ONE standalone question for a US geospatial analysis tool.
The user is looking at the answer to their LAST question below, and the follow-up is about that answer.

${history.slice(-3).map((h, i) => `Question ${i + 1}: "${String(h.query || "").slice(0, 300)}"`
  + (h.intent ? `\n  Answered with: ${String(h.intent).slice(0, 200)}` : "")
  + ((h.measures || []).length ? `\n  Measures: ${h.measures.slice(0, 4).join("; ")}` : "")).join("\n")}
${area ? `The answer is restricted to: ${followup.describeAreas(area)}\n` : ""}${measure ? `The measure on screen: ${measure}\n` : ""}
Follow-up: "${String(text).slice(0, 500)}"

The new question must make sense to someone who has seen NONE of the conversation. So:
1. Work out what the follow-up leaves implicit. Usually: the layer or measure, the place, the travel mode, the year or distance.
2. Put exactly those back, using the earlier question's own words. Do not invent any word that is in neither the follow-up nor the earlier questions.
3. If the follow-up gives something new (a place, year, number, measure, mode), it REPLACES the earlier one. Never keep both.
4. If the follow-up points at a part of the earlier result ("this band", "the outer ring", "that cluster", "the longest one"), say what that part is in plain words, in terms of the earlier question, instead of repeating the pointer.
5. Keep every content word the user typed. Do not answer the question. One plain sentence.

Examples (other topics):
- Earlier: "libraries in Portland, Oregon". Follow-up: "and museums?" -> "museums in Portland, Oregon"
- Earlier: "schools within 3 miles of a highway". Follow-up: "and within 1 mile?" -> "schools within 1 mile of a highway"
- Earlier: "map the 10 and 20 minute drives around clinics in Tulsa". Follow-up: "who lives in the inner zone?" -> "how many people live within a 10 minute drive of the clinics in Tulsa?"
- Earlier: "smoking rates in Kentucky". Follow-up: "is that linked to lung cancer?" -> "is the smoking rate related to lung cancer in Kentucky counties?"

Return JSON: {"question": "..."}`,
  }),

  // Same rules as baseline, but the model writes down what the follow-up
  // refers to and what it left implicit BEFORE the question. Costs a few
  // dozen tokens, no reasoning mode needed.
  cot: ({ base }) => ({
    schema: COT_SCHEMA,
    system: base.replace(/Return JSON:[\s\S]*$/, "").replace("Earlier in this conversation:", HEADER) +
      `Return JSON with three fields, in this order:
{"refers_to": "what part of the earlier answer the follow-up is about, in plain words",
 "left_implicit": "the layer, place, travel mode, year or distance the follow-up does not say",
 "question": "the standalone question"}`,
  }),
};

// --------------------------------------------------------------------- calls
function thinkValue(t) {
  if (t === "off") return false;
  if (t === "on") return true;
  return t; // low | medium | high for models that take levels
}

async function chat({ model, system, schema, think, maxTokens }) {
  const body = {
    model, stream: false, think: thinkValue(think), format: schema,
    options: { temperature: args.temperature, num_ctx: args.numCtx, num_predict: maxTokens },
    messages: [{ role: "system", content: system }],
  };
  const t0 = Date.now();
  const r = await fetch(`${args.ollama}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { content: j.message?.content || "", thinking: j.message?.thinking || "",
    tokens: j.eval_count ?? null, cut: j.done_reason === "length", secs: (Date.now() - t0) / 1000 };
}

function check(c, question) {
  const q = ` ${String(question).toLowerCase()} `;
  const problems = [];
  for (const g of c.must || []) if (!g.some(alt => q.includes(String(alt).toLowerCase()))) problems.push(`missing any of ${JSON.stringify(g)}`);
  for (const bad of c.must_not || []) if (q.includes(String(bad).toLowerCase())) problems.push(`contains ${JSON.stringify(bad)}`);
  return problems;
}

async function planWorks(question) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${args.e2e}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: question }), signal: AbortSignal.timeout(400000) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 3000)); continue; }
    const j = await r.json().catch(() => ({}));
    if (j.error) return { ok: false, why: String(j.error).slice(0, 120) };
    const steps = j.plan?.steps || [];
    return steps.length ? { ok: true, rows: j.row_count ?? null } : { ok: false, why: "no plan" };
  }
  return { ok: false, why: "rate limited" };
}

// ---------------------------------------------------------------------- main
async function runOne({ c, model, think, maxTokens, variantName }) {
  const variant = VARIANTS[variantName];
  let called = null;
  const callLLM = async (baseSystem) => {
    const built = variant({ base: baseSystem, history: c.history, text: c.text, area: c.area, measure: c.measure });
    called = await chat({ model, system: built.system, schema: built.schema, think, maxTokens });
    return called.content;
  };
  let out;
  try {
    out = await followup.rewriteFollowUp({ text: c.text, history: c.history, area: c.area, measure: c.measure, callLLM });
  } catch (e) { return { id: c.id, error: e.message }; }
  let raw = null;
  try { raw = called ? JSON.parse(called.content).question : null; } catch { raw = called ? `(unparsable) ${called.content.slice(0, 80)}` : null; }
  const problems = check(c, out.question);
  const rawProblems = called ? check(c, raw) : problems;
  const rec = { id: c.id, heldout: !!c.heldout, model, think, maxTokens, variant: variantName,
    skipped: !called, raw, final: out.question, guarded: !!out.discarded, note: out.note || null,
    tokens: called?.tokens ?? null, cut: !!called?.cut, secs: called?.secs ?? 0,
    thinkingChars: called?.thinking?.length ?? 0, ok: problems.length === 0, rawOk: rawProblems.length === 0, problems };
  if (args.e2e && rec.ok) rec.e2e = await planWorks(out.question);
  return rec;
}

(async () => {
  const cases = args.cases ? CASES.filter(c => args.cases.includes(c.id)) : CASES;
  for (const v of args.variants) if (!VARIANTS[v]) { console.error(`unknown variant ${v}; have ${Object.keys(VARIANTS)}`); process.exit(2); }
  const cells = [];
  for (const model of args.model) for (const think of args.think) for (const maxTokens of args.maxTokens)
    for (const variantName of args.variants) cells.push({ model, think, maxTokens, variantName });
  console.log(`${cases.length} cases x ${cells.length} setting(s) x ${args.repeat} repeat(s) against ${args.ollama}` +
    `${args.e2e ? `, end-to-end via ${args.e2e}` : ""}\n`);

  const all = [];
  const rows = [];
  for (const cell of cells) {
    const recs = [];
    for (const c of cases) for (let r = 0; r < args.repeat; r++) {
      const rec = await runOne({ c, ...cell });
      if (rec.error) { console.error(`  ${cell.model} ${c.id}: ${rec.error}`); continue; }
      recs.push(rec); all.push(rec);
      if (args.verbose) {
        console.log(`  ${rec.ok ? "ok  " : "FAIL"} ${cell.model} think=${cell.think} max=${cell.maxTokens} ${cell.variantName} ${c.id}` +
          `\n         typed: ${c.text}\n         raw:   ${rec.raw ?? "(model not called)"}\n         final: ${rec.final}` +
          `${rec.guarded ? `\n         guard: ${rec.note}` : ""}${rec.ok ? "" : `\n         ${rec.problems.join("; ")}`}` +
          `${rec.e2e ? `\n         plans: ${rec.e2e.ok ? `yes (${rec.e2e.rows} rows)` : `NO - ${rec.e2e.why}`}` : ""}` +
          `  [${rec.tokens ?? "-"} tok, ${rec.secs.toFixed(1)}s${rec.cut ? ", CUT" : ""}]`);
      }
    }
    if (!recs.length) continue;
    const n = recs.length, called = recs.filter(r => !r.skipped);
    const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const e2eRecs = recs.filter(r => r.e2e);
    rows.push({
      model: cell.model, think: cell.think, max: cell.maxTokens, variant: cell.variantName,
      pass: Math.round(100 * recs.filter(r => r.ok).length / n),
      raw: Math.round(100 * recs.filter(r => r.rawOk).length / n),
      heldout: (() => { const h = recs.filter(r => r.heldout); return h.length ? Math.round(100 * h.filter(r => r.ok).length / h.length) : null; })(),
      e2e: e2eRecs.length ? Math.round(100 * e2eRecs.filter(r => r.e2e.ok).length / recs.filter(r => r.ok).length) : null,
      skipped: recs.filter(r => r.skipped).length, guarded: recs.filter(r => r.guarded).length,
      tokens: Math.round(mean(called.filter(r => r.tokens != null).map(r => r.tokens))),
      cut: called.filter(r => r.cut).length, secs: +mean(called.map(r => r.secs)).toFixed(1), n,
    });
  }

  const pad = (s, w) => String(s).padEnd(w);
  console.log(`\n${pad("model", 14)}${pad("think", 7)}${pad("max", 6)}${pad("variant", 10)}${pad("pass%", 7)}${pad("raw%", 6)}${pad("held%", 7)}` +
    `${args.e2e ? pad("plans%", 8) : ""}${pad("skipped", 9)}${pad("guarded", 9)}${pad("tok", 6)}${pad("cut", 5)}${pad("secs", 6)}n`);
  for (const r of rows.sort((a, b) => b.pass - a.pass)) {
    console.log(`${pad(r.model, 14)}${pad(r.think, 7)}${pad(r.max, 6)}${pad(r.variant, 10)}${pad(r.pass, 7)}${pad(r.raw, 6)}${pad(r.heldout ?? "-", 7)}` +
      `${args.e2e ? pad(r.e2e ?? "-", 8) : ""}${pad(r.skipped, 9)}${pad(r.guarded, 9)}${pad(r.tokens, 6)}${pad(r.cut, 5)}${pad(r.secs, 6)}${r.n}`);
  }
  // Which cases fail most across the grid: the ones no setting solves are the
  // ones to read first.
  const byCase = {};
  for (const r of all) { (byCase[r.id] ||= { n: 0, ok: 0 }).n++; if (r.ok) byCase[r.id].ok++; }
  console.log("\nper case, across every setting:");
  for (const [id, v] of Object.entries(byCase).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n))
    console.log(`  ${pad(id, 20)}${Math.round(100 * v.ok / v.n)}%  (${v.ok}/${v.n})`);
  if (args.out) { fs.writeFileSync(args.out, JSON.stringify({ args, rows, calls: all }, null, 2)); console.log(`\nsaved ${args.out}`); }
})();
