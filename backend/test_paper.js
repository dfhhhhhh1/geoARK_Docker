/**
 * backend/paper.js and backend/paper_templates.js: sections, chunking, quote
 * checks, the merge, the study area, variable matching, and every template's
 * plan through the real validator and compiler. No database, no model;
 * `node test_paper.js`.
 *
 * The fixtures are made up and deliberately unlike any paper used while
 * building this (CLAUDE.md: general, not test-specific).
 */
const assert = require("assert");
const p = require("./paper");
const t = require("./paper_templates");
const { validatePlan } = require("./planner/validate");
const { compilePlan } = require("./planner/compile");

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); console.log(`  ok   ${name}`); pass++; }
    catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); fail++; }
  });
}

const PAPER = [
  "Rural water insecurity and kidney outcomes",
  "A. Author, B. Author",
  "Abstract",
  "We studied end-stage renal disease incidence in counties of New Mexico and Arizona from 2012 to",
  "2019 using spatial statistics.",
  "1. Introduction",
  "Water access varies widely across the region.",
  "2. Materials and Methods",
  "2.1 Data sources",
  "County-level incidence of end-stage renal dis-",
  "ease was obtained from the national registry. The share of households without complete plumbing",
  "came from the American Community Survey.",
  "2.2 Statistical analysis",
  "Global spatial autocorrelation was tested with Moran’s I using queen contiguity weights and 999 permutations.",
  "Local clusters were identified with LISA at a significance level of 0.05.",
  "3. Results",
  "Clusters were found along the border.",
  "Acknowledgements",
  "We thank the registry.",
  "References",
  "1. Smith J. Methods in spatial epidemiology. 2010.",
  "2. Doe A. Water and health. 2015.",
].join("\n");

// ---------------------------------------------------------------------------
console.log("sections and chunks");

test("numbered and named headings are found; references and boilerplate set aside", () => {
  const s = p.splitSections(PAPER);
  const kinds = Object.fromEntries(s.map(x => [x.heading, x.kind]));
  assert.strictEqual(kinds["Abstract"], "abstract");
  assert.strictEqual(kinds["Materials and Methods"], "methods");
  assert.strictEqual(kinds["Statistical analysis"], "methods");
  assert.strictEqual(kinds["Results"], "results");
  assert.strictEqual(kinds["References"], "references");
  assert.strictEqual(kinds["Acknowledgements"], "boilerplate");
  const c = p.planChunks(PAPER, s);
  const all = c.chunks.map(x => x.text).join("\n");
  assert.ok(all.includes("Moran"), "methods are read");
  assert.ok(!all.includes("Smith J."), "references are not sent");
  assert.ok(c.skipped.some(x => x.kind === "references"));
});

test("a sentence that starts with a section word is not a heading", () => {
  assert.strictEqual(p.headingOf("Data were obtained from the state registry for all years."), null);
  assert.strictEqual(p.headingOf("methods"), null);       // lower case, unnumbered
  assert.ok(p.headingOf("3.2 Spatial weights"));
  assert.ok(p.headingOf("STUDY AREA"));
});

test("nothing is silently truncated: over the chunk cap, the unread sections are named", () => {
  const long = ["Methods", ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i} `.repeat(60))].join("\n\n");
  const c = p.planChunks(long, p.splitSections(long), { chunkChars: 2000, maxChunks: 3 });
  assert.strictEqual(c.chunks.length, 3);
  const unread = c.skipped.filter(x => x.why === "length");
  assert.ok(unread.length && unread[0].chars > 0, "the unread part is reported");
  const read = c.chunks.reduce((n, x) => n + x.text.length, 0);
  assert.ok(read + unread.reduce((n, x) => n + x.chars, 0) >= long.length - 50, "read + skipped covers the text");
});

// ---------------------------------------------------------------------------
console.log("quotes");

const index = p.quoteIndex(PAPER, [{ page: 1, start: 0, end: 600 }, { page: 2, start: 600, end: PAPER.length }]);

test("a quote matches across line breaks, hyphenation and curly quotes", () => {
  assert.ok(p.checkQuote(index, "County-level incidence of end-stage renal disease was obtained from the national registry").ok);
  assert.ok(p.checkQuote(index, "tested with Moran's I using queen contiguity weights").ok);
});

test("a paraphrase is refused, and so is a quote too short to mean anything", () => {
  assert.strictEqual(p.checkQuote(index, "The authors explicitly applied Moran's I to assess clustering").ok, false);
  assert.strictEqual(p.checkQuote(index, "Moran").ok, false);
  assert.strictEqual(p.checkQuote(index, "").ok, false);
});

test("an ellipsis quote needs every fragment, in order", () => {
  assert.ok(p.checkQuote(index, "Global spatial autocorrelation was tested ... 999 permutations").ok);
  assert.strictEqual(p.checkQuote(index, "999 permutations ... Global spatial autocorrelation was tested").ok, false);
});

test("the page of a quote is reported", () => {
  const r = p.checkQuote(index, "Clusters were found along the border");
  assert.ok(r.ok);
  assert.strictEqual(r.page, 2);
});

// ---------------------------------------------------------------------------
console.log("merge");

const ANSWER_A = {
  title: "Rural water insecurity and kidney outcomes",
  country: { name: "United States", quote: "" },
  study_area: { description: "counties of New Mexico and Arizona", places: ["New Mexico", "Arizona"],
                quote: "We studied end-stage renal disease incidence in counties of New Mexico and Arizona" },
  unit: { value: "county", quote: "County-level incidence of end-stage renal disease" },
  period: { start_year: 2012, end_year: 2019, quote: "from 2012 to 2019 using spatial statistics" },
  variables: [
    { name: "ESRD incidence", role: "covariate", measure: "", source: "", quote: "We studied end-stage renal disease incidence" },
    { name: "Households without plumbing", role: "exposure", measure: "percent", source: "American Community Survey",
      quote: "The share of households without complete plumbing came from the American Community Survey" },
    { name: "Made-up variable", role: "exposure", measure: "", source: "", quote: "a sentence the paper never wrote at all" },
  ],
  methods: [
    { technique: "Moran's I", family: "moran_global", applied_to: "ESRD incidence", alpha: null, permutations: 999,
      weights: "queen contiguity", quote: "Global spatial autocorrelation was tested with Moran's I using queen contiguity weights" },
  ],
};
const ANSWER_B = {
  title: "", country: { name: "", quote: "" },
  study_area: { description: "", places: [], quote: "" }, unit: { value: "not_stated", quote: "" },
  period: { start_year: null, end_year: null, quote: "" },
  variables: [{ name: "ESRD  incidence", role: "outcome", measure: "per million", source: "national registry",
                quote: "County-level incidence of end-stage renal disease was obtained from the national registry" }],
  methods: [
    { technique: "LISA", family: "moran_local", applied_to: "ESRD incidence", alpha: 0.05, permutations: null,
      weights: "", quote: "Local clusters were identified with LISA at a significance level of 0.05" },
    { technique: "Invented test", family: "not-a-family", applied_to: "", alpha: null, permutations: null,
      weights: "", quote: "Clusters were found along the border" },
  ],
};

test("unquoted items are dropped and counted; the same variable merges to its most specific role", () => {
  const s = p.mergeExtractions([ANSWER_A, ANSWER_B], index);
  assert.deepStrictEqual(s.variables.map(v => [v.name, v.role]),
    [["ESRD incidence", "outcome"], ["Households without plumbing", "exposure"]]);
  assert.strictEqual(s.variables[0].source, "national registry");
  assert.ok(s.quotes.dropped >= 1);
  assert.ok(s.quotes.dropped_items.some(d => d.item === "Made-up variable"));
  assert.deepStrictEqual(s.methods.map(m => m.family), ["moran_global", "moran_local", "other"]);
  assert.strictEqual(s.methods[0].permutations, 999);
  assert.strictEqual(s.methods[1].alpha, 0.05);
  assert.deepStrictEqual(s.area.states.sort(), ["Arizona", "New Mexico"]);
  assert.strictEqual(s.area.scope, "states");
  assert.strictEqual(s.period.end_year, 2019);
  assert.strictEqual(s.title, "Rural water insecurity and kidney outcomes");
});

// ---------------------------------------------------------------------------
console.log("study area");

test("a study outside the United States is refused by name", () => {
  const a = p.resolveArea({ description: "all 21 regions", places: ["nationwide"] }, { name: "Ruritania" });
  assert.strictEqual(a.scope, "outside_us");
  assert.ok(a.note.includes("Ruritania"));
});

test("'us' and 'national' are words, not the United States", () => {
  assert.strictEqual(p.isUnitedStates("let us consider a national sample"), false);
  assert.strictEqual(p.isUnitedStates("the U.S."), true);
  assert.strictEqual(p.isUnitedStates("USA"), true);
});

test("contiguous United States -> 48 states; West Virginia alone is not Virginia", () => {
  const a = p.resolveArea({ description: "the contiguous United States", places: [] }, { name: "United States" });
  assert.strictEqual(a.scope, "national");
  assert.ok(a.states.length === 49 && !a.states.includes("Alaska") && a.states.includes("District of Columbia"));
  assert.deepStrictEqual(p.statesIn("rural West Virginia"), ["West Virginia"]);
  assert.deepStrictEqual(p.statesIn("Virginia and West Virginia").sort(), ["Virginia", "West Virginia"]);
});

// ---------------------------------------------------------------------------
console.log("matching");

const CATALOG = {
  "esrd": [{ attr_id: "KID", label: "Chronic kidney disease among adults", kind: "value" },
           { attr_id: "DIAB", label: "Diagnosed diabetes", kind: "value" }],
  "households": [{ attr_id: "PLUMB", label: "Lacking complete plumbing", kind: "value" }],
  "rainfall": [],
};
const search = async (phrase) => {
  for (const [k, v] of Object.entries(CATALOG)) if (phrase.toLowerCase().includes(k)) return v;
  return [];
};
const VARS = [
  { id: "v1", name: "ESRD incidence", role: "outcome" },
  { id: "v2", name: "Households without plumbing", role: "exposure" },
  { id: "v3", name: "Annual rainfall", role: "covariate" },
];

test("the model's choice selects; 'none' and no candidates are listed as missing", async () => {
  const llm = async () => JSON.stringify({ matches: [
    { variable: "v1", candidate: "v1c1", fit: "proxy" },
    { variable: "v2", candidate: "v2c1", fit: "same" },
  ] });
  const r = await p.matchVariables(VARS, { search, callLLM: llm });
  const by = Object.fromEntries(r.variables.map(v => [v.id, v]));
  assert.strictEqual(by.v1.status, "proxy");
  assert.strictEqual(by.v1.selected, "KID");
  assert.strictEqual(by.v2.status, "matched");
  assert.strictEqual(by.v3.status, "missing");
  assert.strictEqual(by.v3.selected, null);
});

test("a candidate from another variable's list is not accepted", async () => {
  const llm = async () => JSON.stringify({ matches: [{ variable: "v1", candidate: "v2c1", fit: "same" }] });
  const r = await p.matchVariables(VARS.slice(0, 2), { search, callLLM: llm });
  assert.strictEqual(r.variables[0].status, "missing");
});

test("no model: retrieval's top row is offered, marked unchecked", async () => {
  const r = await p.matchVariables(VARS.slice(0, 1), { search, callLLM: null });
  assert.strictEqual(r.variables[0].status, "unchecked");
  assert.strictEqual(r.variables[0].selected, "KID");
});

test("background and discussion are set aside when the paper has its own methods", () => {
  const text = ["Introduction", "Prior studies used GWR. ".repeat(30), "Methods", "We fit a model. ".repeat(40),
                "Discussion", "Others used SaTScan. ".repeat(30)].join("\n");
  const c = p.planChunks(text, p.splitSections(text));
  const all = c.chunks.map(x => x.text).join("\n");
  assert.ok(all.includes("We fit a model") && !all.includes("GWR") && !all.includes("SaTScan"));
  assert.ok(c.skipped.some(s => s.why === "background or discussion"));
});

test("a table cell counts as a variable's quote only as a whole phrase", () => {
  const idx = p.quoteIndex("Category\nPoverty (%) Percentage living in poverty\nSeparate rates", []);
  assert.ok(p.checkQuote(idx, "Poverty (%)", { short: true }).ok);
  assert.strictEqual(p.checkQuote(idx, "arate rat", { short: true }).ok, false, "inside other words");
  assert.strictEqual(p.checkQuote(idx, "Poverty (%)").ok, false, "methods still need a full quote");
});

test("one variable named three ways is one variable", () => {
  const idx = p.quoteIndex("Sodium intake rates were high. Sodium intake rate by county. Mean sodium intake.", []);
  const s = p.mergeExtractions([{ variables: [
    { name: "Sodium intake rate", role: "covariate", measure: "", source: "", quote: "Sodium intake rate by county" },
    { name: "sodium intake rates", role: "outcome", measure: "", source: "", quote: "Sodium intake rates were high" },
    { name: "Sodium intake (%)", role: "exposure", measure: "", source: "", quote: "Mean sodium intake" },
  ], methods: [] }], idx);
  assert.deepStrictEqual(s.variables.map(v => [v.name, v.role]), [["Sodium intake rate", "outcome"]]);
});

test("a standard technique name settles the family, whatever the model chose", () => {
  assert.strictEqual(p.familyFromName("Global Moran’s I"), "moran_global");
  assert.strictEqual(p.familyFromName("Anselin Local Moran's I"), "moran_local");
  assert.strictEqual(p.familyFromName("Getis–Ord Gi*"), "hotspot");
  assert.strictEqual(p.familyFromName("Min–Max scaling"), "preprocessing");
  assert.strictEqual(p.familyFromName("multiscale GWR"), "spatial_regression");
  assert.strictEqual(p.familyFromName("kernel density estimation"), null, "unknown keeps the model's family");
  const idx = p.quoteIndex("Global spatial autocorrelation was assessed using Moran's I statistic.", []);
  const s = p.mergeExtractions([{ variables: [], methods: [{ technique: "Moran's I", family: "spatial_lag",
    applied_to: "", alpha: null, permutations: null, weights: "",
    quote: "Global spatial autocorrelation was assessed using Moran's I statistic" }] }], idx);
  assert.strictEqual(s.methods[0].family, "moran_global");
});

test("two variables that matched the same row are one; an exposure matched to the outcome folds in", async () => {
  const same = async () => [{ attr_id: "HD", label: "Heart disease deaths", kind: "value" }];
  const llm = async () => JSON.stringify({ matches: [
    { variable: "v1", candidate: "v1c1", fit: "proxy" }, { variable: "v2", candidate: "v2c1", fit: "same" }] });
  const r = await p.matchVariables([{ id: "v1", name: "CVD deaths", role: "outcome" },
                                    { id: "v2", name: "county CVD predictors", role: "exposure" }],
                                   { search: same, callLLM: llm });
  assert.strictEqual(r.variables.length, 1);
  assert.deepStrictEqual(r.variables[0].aliases, ["county CVD predictors"]);
});

// ---------------------------------------------------------------------------
console.log("templates");

const VALUE = (id) => ({ attr_id: id, source_kind: "acs_long", census_code: `C_${id}`, description: id });
const FEATURE = (id) => ({ attr_id: id, source_kind: "feature_table", table_name: `t_${id}`,
                           geom_column: "geom", label_columns: ["name"], filter_values: {} });
const resolve = async (ids) => new Map(ids.map(id => [id, id.startsWith("L_") ? FEATURE(id) : VALUE(id)]));
const sel = (id, name, role, kind = "value") => ({ id, name, role, selected: id === "none" ? null : name.replace(/\W/g, "_"),
  matches: [{ attr_id: name.replace(/\W/g, "_"), kind, label: name }] });

const STUDY = {
  area: { scope: "states", states: ["Arizona", "New Mexico"] },
  unit: { value: "tract" },
  period: { start_year: 2012, end_year: 2019 },
  variables: [sel("v1", "Outcome rate", "outcome"), sel("v2", "Exposure one", "exposure"),
              sel("v3", "Exposure two", "exposure"), sel("v4", "Control one", "covariate"),
              { ...sel("v5", "L_clinics", "exposure", "feature") }],
  methods: [
    { id: "m1", technique: "Moran's I", family: "moran_global", applied_to: "outcome rate", permutations: 999, weights: "queen contiguity" },
    { id: "m2", technique: "LISA", family: "moran_local", applied_to: "Outcome rate", alpha: 0.01, weights: "k = 6 nearest neighbours" },
    { id: "m3", technique: "Getis-Ord Gi*", family: "hotspot", applied_to: "" },
    { id: "m4", technique: "Pearson correlation", family: "correlation", applied_to: "" },
    { id: "m5", technique: "negative binomial regression", family: "regression", applied_to: "" },
    { id: "m6", technique: "GWR", family: "spatial_regression", applied_to: "" },
    { id: "m7", technique: "spatially lagged outcome", family: "spatial_lag", applied_to: "" },
    { id: "m8", technique: "nearest clinic distance", family: "access", applied_to: "" },
    { id: "m9", technique: "random forest", family: "machine_learning", applied_to: "" },
    { id: "m10", technique: "ARIMA", family: "time_series", applied_to: "" },
    { id: "m11", technique: "Kruskal-Wallis test", family: "group_comparison", applied_to: "urban and rural counties" },
    { id: "m12", technique: "Bayesian kriging", family: "other", applied_to: "" },
  ],
};

async function mustRun(plan) {
  const copy = JSON.parse(JSON.stringify(plan));
  const v = await validatePlan(copy, resolve);
  // explain's factors are resolved beside the plan, as executeGivenPlan does.
  const ex = copy.steps.find(s => s.op === "explain");
  if (ex) for (const [k, val] of await resolve(ex.factors.map(f => f.attr_id))) v.resolved.set(k, val);
  assert.ok(v.ok, `template plan did not validate: ${v.errors.join(" | ")}\n${JSON.stringify(plan)}`);
  const compiled = compilePlan(copy, v.resolved);
  for (const out of compiled.outputs || []) {
    const used = new Set((String(out.sql || "").match(/\$\d+/g) || []));
    assert.strictEqual(used.size, (out.params || []).length, `output ${out.id}: parameter count`);
  }
}

test("every template plan validates and compiles", async () => {
  const rep = t.reproductionPlan(STUDY);
  const runs = rep.flatMap(m => m.runs);
  assert.ok(runs.length >= 9, `expected runs for most methods, got ${runs.length}`);
  for (const r of runs) await mustRun(r.plan);
});

test("statuses: reproduced only when nothing differs, and every difference is said", () => {
  const rep = Object.fromEntries(t.reproductionPlan(STUDY).map(m => [m.method_id, m]));
  // The study is at tract level and 2012-2019: every run is approximated.
  assert.strictEqual(rep.m1.status, "approximated");
  assert.ok(/tracts/.test(rep.m1.reason) && /2012-2019/.test(rep.m1.reason));
  assert.ok(/k = 6 nearest/.test(rep.m2.reason), "non-queen weights are named");
  assert.strictEqual(rep.m9.status, "automl");
  assert.strictEqual(rep.m9.automl.target, "Outcome_rate");
  assert.strictEqual(rep.m10.status, "not_supported");
  assert.strictEqual(rep.m11.status, "ask");
  assert.ok(rep.m11.question.includes("urban and rural"));
  assert.strictEqual(rep.m12.status, "not_supported");
  assert.ok(rep.m0 && rep.m0.family === "map", "the outcome map is added");
});

test("the paper's Moran settings reach the step; an out-of-range one is not passed", () => {
  const rep = Object.fromEntries(t.reproductionPlan(STUDY).map(m => [m.method_id, m]));
  const m1 = rep.m1.runs[0].plan.steps.find(s => s.op === "moran");
  assert.strictEqual(m1.permutations, 999);
  assert.strictEqual(m1.local, false);
  const m2 = rep.m2.runs[0].plan.steps.find(s => s.op === "moran");
  assert.strictEqual(m2.local, true);
  assert.strictEqual(m2.alpha, 0.01);
  const bad = t.templateFor({ family: "moran_global", applied_to: "", permutations: 1e6, alpha: 3 }, STUDY);
  const mb = bad.runs[0].plan.steps.find(s => s.op === "moran");
  assert.ok(mb.permutations === undefined && mb.alpha === undefined);
});

test("regression: exposures are factors, covariates are controls, the area filters the outcome", () => {
  const rep = Object.fromEntries(t.reproductionPlan(STUDY).map(m => [m.method_id, m]));
  const ex = rep.m5.runs[0].plan.steps.find(s => s.op === "explain");
  assert.deepStrictEqual(ex.factors.map(f => [f.attr_id, f.role]),
    [["Exposure_one", "factor"], ["Exposure_two", "factor"], ["Control_one", "control"]]);
  const fa = rep.m5.runs[0].plan.steps.find(s => s.op === "filter_area");
  assert.deepStrictEqual(fa.states, ["Arizona", "New Mexico"]);
  assert.ok(/partial Spearman/.test(rep.m5.reason));
  assert.strictEqual(rep.m6.runs.length, 2, "spatial regression adds the residual LISA");
});

test("several machine-learning models are one AutoML entry; preprocessing is said to be preparation", () => {
  const study = { ...STUDY, methods: [
    { id: "m1", technique: "random forest", family: "machine_learning", applied_to: "" },
    { id: "m2", technique: "XGBoost", family: "machine_learning", applied_to: "" },
    { id: "m3", technique: "VIF screening", family: "preprocessing", applied_to: "" }] };
  const rep = t.reproductionPlan(study).filter(m => m.method_id !== "m0");
  assert.deepStrictEqual(rep.map(m => m.status), ["automl", "not_supported"]);
  assert.deepStrictEqual(rep[0].merged_ids, ["m1", "m2"]);
  assert.ok(/random forest, XGBoost/.test(rep[0].technique));
  assert.ok(/data preparation/.test(rep[1].reason));
});

test("a study outside the US runs nothing", () => {
  const rep = t.reproductionPlan({ ...STUDY, area: { scope: "outside_us", note: "elsewhere" } });
  assert.ok(rep.every(m => m.status === "not_supported" && !m.runs.length));
});

test("no matched outcome: a method that needs one says so", () => {
  const study = { ...STUDY, variables: STUDY.variables.filter(v => v.role !== "outcome") };
  const r = t.templateFor({ family: "hotspot", applied_to: "something else" }, study);
  assert.strictEqual(r.status, "not_supported");
  assert.ok(/outcome/.test(r.reason));
});

(async () => {
  for (const fn of pending) await fn();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
