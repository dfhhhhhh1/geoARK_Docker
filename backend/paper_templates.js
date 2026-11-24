/**
 * Paper -> reproduction (docs/PAPER_AND_CART_INTEGRATION.md P4, DATA_CART_PLAN
 * U4). A study card's methods become ordinary GeoARK plans built from
 * templates over the variables' chosen catalog ids.
 *
 * WHY TEMPLATES AND NOT THE PLANNER: the method is already known, quoted from
 * the paper. Asking the free planner to rediscover it from a sentence would
 * add a 20-60 s call per method and a chance of a different method. A template
 * sets the method exactly (Moran's alpha and permutations from the paper's
 * own quote), and the plan still goes through validatePlan and the ordinary
 * compiler, so nothing here writes SQL or bypasses a check.
 *
 * Each method gets a status, and the reason is always said:
 *   reproduced     the same technique on the paper's variables
 *   approximated   a GeoARK stand-in, with what differs (weights, unit,
 *                  period, a partial correlation in place of a fitted model)
 *   ask            needs a choice the paper's text does not settle (which
 *                  groups to compare); offered as an editable question
 *   automl         a machine-learning method: the AutoML panel, pre-filled
 *   not_supported  GeoARK has nothing comparable
 *
 * Pure: everything it needs is passed in, so it is tested without a database.
 */

const MAX_PAIRS = 3;        // correlations per method: the first exposures
const MAX_FACTORS = 8;      // explain's own cap (planner/ops/explain.js)

const QUEEN = /\b(queen|contigu|adjacen|shared (border|boundar)|first[- ]order)\b/i;

function stepIds() {
  let n = 0;
  return () => `s${++n}`;
}

/** A variable's chosen catalog row, with its kind. */
function chosen(v) {
  if (!v || !v.selected) return null;
  const m = (v.matches || []).find(x => x.attr_id === v.selected);
  return { attr_id: v.selected, kind: m?.kind || v.kind || "value", label: m?.label || v.name };
}

/** The variable a method was applied to, by name overlap; else the first outcome. */
function targetOf(method, variables) {
  const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const applied = words(method.applied_to);
  let best = null, bestScore = 0;
  for (const v of variables) {
    if (!chosen(v)) continue;
    const w = words(v.name);
    let hit = 0;
    for (const x of w) if (applied.has(x)) hit++;
    const score = w.size ? hit / w.size : 0;
    if (score > bestScore) { best = v; bestScore = score; }
  }
  if (best && bestScore >= 0.5) return best;
  return variables.find(v => v.role === "outcome" && chosen(v)) || null;
}

/** A series step for a variable: a value series loads, a layer is counted. */
function seriesStep(v, id) {
  const c = chosen(v);
  if (c.kind === "feature") return { id, op: "count_features", attr_id: c.attr_id, inputs: [] };
  if (c.kind === "raster") return null;
  return { id, op: "load", attr_id: c.attr_id, inputs: [] };
}

function areaStep(area, input, id) {
  const states = Array.isArray(area?.states) && area.states.length ? area.states : null;
  return states ? { id, op: "filter_area", attr_id: "", inputs: [input], states } : null;
}

function plan(intent, outputType, steps) {
  return { intent, output_type: outputType, entity_type: "COUNTY", steps };
}

/** load(v) [-> filter_area] ; returns {steps, last} */
function loadIn(v, area, next) {
  const s1 = seriesStep(v, next());
  if (!s1) return null;
  const steps = [s1];
  const f = areaStep(area, s1.id, next());
  if (f) steps.push(f);
  return { steps, last: steps[steps.length - 1].id };
}

/** The study-level differences every reproduction carries. */
function commonNotes(study) {
  const notes = [];
  const unit = study.unit?.value;
  if (unit && !["county", "not_stated"].includes(unit)) {
    notes.push(`by county, where the paper used ${unit.replace("_", " ")}s`);
  }
  const p = study.period;
  if (p && (p.start_year || p.end_year)) {
    const yrs = p.start_year && p.end_year && p.start_year !== p.end_year
      ? `${p.start_year}-${p.end_year}` : String(p.end_year || p.start_year);
    notes.push(`with the latest year each GeoARK measure has, where the paper used ${yrs}`);
  }
  return notes;
}

// Catalog labels run to 150 characters ("Heart disease death rate among adults
// 35 and older, age-adjusted, per 100,000 (3-year average ...)"); a reason
// repeats them, so they are cut at the first parenthesis past 40 characters.
function shortLabel(s) {
  const t = String(s || "");
  if (t.length <= 70) return t;
  const cut = t.indexOf(" (", 40);
  return cut > 0 && cut <= 90 ? t.slice(0, cut) : `${t.slice(0, 70).replace(/\s+\S*$/, "")}…`;
}
const label = (v) => shortLabel(chosen(v)?.label || v?.name);
const named = (v) => v?.name || label(v);

/**
 * One method -> { status, reason, runs: [{title, plan}], question?, automl? }.
 */
function templateFor(method, study) {
  const variables = study.variables || [];
  const area = study.area || {};
  const target = targetOf(method, variables);
  const others = variables.filter(v => v !== target && chosen(v) && v.role !== "outcome");
  const exposures = others.filter(v => v.role === "exposure");
  const covariates = others.filter(v => v.role === "covariate");
  const notes = commonNotes(study);
  // The model writes "not_stated", "none" or "N/A" for weights it did not find.
  const weightsStated = /^(|not[_ ]stated|none|n\/?a|unknown|not specified|null)$/i.test(String(method.weights || "").trim())
    ? "" : String(method.weights).trim();
  const nonQueen = weightsStated && !QUEEN.test(weightsStated);

  const needTarget = () => ({
    status: "not_supported",
    reason: target ? `"${named(target)}" is a raster; summarise it in Analysis first`
      : "none of the paper's outcome variables matched a GeoARK measure",
    runs: [],
  });
  const withNotes = (status, reason, extra = []) => {
    const all = [...extra, ...notes];
    return { status: all.length && status === "reproduced" ? "approximated" : status,
             reason: [reason, ...all].filter(Boolean).join("; ") };
  };

  switch (method.family) {
    case "map": {
      if (!target) return needTarget();
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base) return needTarget();
      return {
        ...withNotes("reproduced", `map of ${label(target)}`),
        runs: [{ title: `Map of ${label(target)}`,
                 plan: plan(`${label(target)} by county`, "map",
                            [...base.steps, { id: next(), op: "output", attr_id: "", inputs: [base.last] }]) }],
      };
    }
    case "hotspot":
    case "scan_statistic": {
      if (!target) return needTarget();
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base) return needTarget();
      const hs = { id: next(), op: "hotspot", attr_id: "", inputs: [base.last] };
      const extra = [];
      if (method.family === "scan_statistic") extra.push("Getis-Ord Gi* hot spots in place of a spatial scan statistic");
      if (nonQueen) extra.push(`contiguity weights in place of the paper's ${weightsStated}`);
      return {
        ...withNotes(extra.length ? "approximated" : "reproduced",
          `Getis-Ord Gi* of ${label(target)} over county contiguity`, extra),
        runs: [{ title: `Hot spots of ${label(target)}`,
                 plan: plan(`Hot and cold spots of ${label(target)}, by county`, "map",
                            [...base.steps, hs, { id: next(), op: "output", attr_id: "", inputs: [hs.id] }]) }],
      };
    }
    case "moran_global":
    case "moran_local": {
      if (!target) return needTarget();
      const local = method.family === "moran_local";
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base) return needTarget();
      const m = { id: next(), op: "moran", attr_id: "", inputs: [base.last], local };
      if (Number.isFinite(method.alpha) && method.alpha > 0 && method.alpha <= 0.5) m.alpha = method.alpha;
      if (Number.isInteger(method.permutations) && method.permutations >= 0 && method.permutations <= 9999) {
        m.permutations = method.permutations;
      }
      const extra = nonQueen ? [`queen contiguity in place of the paper's ${weightsStated}`] : [];
      const what = local ? "Local Moran's I (LISA)" : "Global Moran's I";
      return {
        ...withNotes(extra.length ? "approximated" : "reproduced",
          `${what} of ${label(target)}${m.alpha ? `, alpha ${m.alpha}` : ""}${m.permutations ? `, ${m.permutations} permutations` : ""}`, extra),
        runs: [{ title: `${what}: ${label(target)}`,
                 plan: plan(`${what} of ${label(target)} across counties`, local ? "map" : "statistics",
                            [...base.steps, m, { id: next(), op: "output", attr_id: "", inputs: [m.id] }]) }],
      };
    }
    case "correlation": {
      if (!target) return needTarget();
      const partners = (exposures.length ? exposures : covariates)
        .filter(v => chosen(v).kind !== "raster").slice(0, MAX_PAIRS);
      if (!partners.length) {
        return { status: "not_supported", reason: "no second variable of the paper matched a GeoARK measure", runs: [] };
      }
      const runs = partners.map(p => {
        const next = stepIds();
        const base = loadIn(target, area, next);
        const s2 = seriesStep(p, next());
        const c = { id: next(), op: "correlate", attr_id: "", inputs: [base.last, s2.id] };
        return { title: `${label(target)} vs ${label(p)}`,
                 plan: plan(`How strongly ${label(target)} and ${label(p)} go together across counties`, "statistics",
                            [...base.steps, s2, c, { id: next(), op: "output", attr_id: "", inputs: [c.id] }]) };
      });
      const extra = (exposures.length || covariates.length) > MAX_PAIRS
        ? [`the first ${MAX_PAIRS} of ${exposures.length || covariates.length} variables`] : [];
      return { ...withNotes("reproduced", "Spearman and Pearson correlation", extra), runs };
    }
    case "regression":
    case "spatial_regression": {
      if (!target) return needTarget();
      const valueOnly = (vs) => vs.filter(v => chosen(v).kind === "value");
      let factors = valueOnly(exposures);
      let controls = valueOnly(covariates);
      if (!factors.length) { factors = controls; controls = []; }
      if (!factors.length) {
        return { status: "not_supported", reason: "none of the paper's predictors matched a GeoARK measure", runs: [] };
      }
      const keep = factors.slice(0, MAX_FACTORS);
      const ctl = controls.slice(0, Math.max(0, MAX_FACTORS - keep.length));
      const dropped = factors.length + controls.length - keep.length - ctl.length;
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base || chosen(target).kind !== "value") return needTarget();
      const ex = {
        id: next(), op: "explain", attr_id: "", inputs: [base.last],
        factors: [
          ...keep.map(v => ({ attr_id: chosen(v).attr_id, role: "factor", description: label(v), source: "paper" })),
          ...ctl.map(v => ({ attr_id: chosen(v).attr_id, role: "control", description: label(v), source: "paper" })),
        ],
      };
      const runs = [{ title: `Factors associated with ${label(target)}`,
        plan: plan(`Each paper predictor's partial association with ${label(target)}` +
                   (ctl.length ? `, controlling for the paper's covariates` : ""), "table",
                   [...base.steps, ex, { id: next(), op: "output", attr_id: "", inputs: [ex.id] }]) }];
      const extra = [
        `partial Spearman correlation of each predictor${ctl.length ? " holding the covariates fixed" : ""}, not the paper's fitted ${method.technique}`,
        ...(dropped > 0 ? [`${dropped} predictors over the cap of ${MAX_FACTORS} left out`] : []),
      ];
      if (method.family === "spatial_regression" && keep.length) {
        // The spatial part of a spatial model is the structure left in the
        // residuals: the residual on the first predictor and its Moran's I.
        const n2 = stepIds();
        const y = seriesStep(target, n2());
        const yIn = areaStep(area, y.id, n2());
        const x = seriesStep(keep[0], n2());
        const r = { id: n2(), op: "residual", attr_id: "", inputs: [(yIn || y).id, x.id] };
        const mo = { id: n2(), op: "moran", attr_id: "", inputs: [r.id], local: true };
        runs.push({ title: `Spatial pattern left after ${label(keep[0])}`,
          plan: plan(`Clusters in ${label(target)} that ${label(keep[0])} does not explain`, "map",
                     [y, ...(yIn ? [yIn] : []), x, r, mo, { id: n2(), op: "output", attr_id: "", inputs: [mo.id] }]) });
        extra.push(`no spatial lag/error/GWR model; LISA of the OLS residual on ${label(keep[0])} shows where one is needed`);
      }
      return { ...withNotes("approximated", "", extra), runs };
    }
    case "spatial_lag": {
      if (!target) return needTarget();
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base) return needTarget();
      const nb = { id: next(), op: "neighbors", attr_id: "", inputs: [base.last] };
      return {
        ...withNotes("approximated", `each county minus the mean of its contiguous neighbours`,
          nonQueen ? [`contiguity in place of ${weightsStated}`] : []),
        runs: [{ title: `${label(target)} against neighbouring counties`,
                 plan: plan(`${label(target)} minus the average of neighbouring counties`, "map",
                            [...base.steps, nb, { id: next(), op: "output", attr_id: "", inputs: [nb.id] }]) }],
      };
    }
    case "outlier": {
      if (!target) return needTarget();
      const next = stepIds();
      const base = loadIn(target, area, next);
      if (!base) return needTarget();
      const o = { id: next(), op: "outlier", attr_id: "", inputs: [base.last] };
      return {
        ...withNotes("approximated", "Tukey fences on the IQR"),
        runs: [{ title: `Outlying counties for ${label(target)}`,
                 plan: plan(`Counties whose ${label(target)} is unusual`, "map",
                            [...base.steps, o, { id: next(), op: "output", attr_id: "", inputs: [o.id] }]) }],
      };
    }
    case "access": {
      const layer = variables.find(v => chosen(v)?.kind === "feature");
      if (!layer) {
        return { status: "ask", reason: "the facilities the paper measured access to did not match a GeoARK layer",
                 runs: [], question: target ? `How far is each county from the nearest facility relevant to ${named(target)}?` : null };
      }
      const next = stepIds();
      const nd = { id: next(), op: "nearest_distance", attr_id: chosen(layer).attr_id, inputs: [] };
      const steps = [nd];
      const f = areaStep(area, nd.id, next());
      if (f) steps.push(f);
      return {
        ...withNotes("approximated", `straight-line distance from each county's centre to the nearest ${label(layer)}`,
          [`not the paper's ${method.technique}`]),
        runs: [{ title: `Distance to the nearest ${label(layer)}`,
                 plan: plan(`Miles from each county to the nearest ${label(layer)}`, "map",
                            [...steps, { id: next(), op: "output", attr_id: "", inputs: [steps[steps.length - 1].id] }]) }],
      };
    }
    case "group_comparison":
      return {
        status: "ask", runs: [],
        reason: "which groups to compare is a choice; check the question and run it in Analysis",
        question: target ? `Compare ${named(target)} between ${method.applied_to || "the groups the paper compared"}` : null,
      };
    case "machine_learning": {
      if (!target || chosen(target).kind !== "value") return needTarget();
      const feats = others.filter(v => chosen(v).kind === "value").map(v => chosen(v).attr_id);
      if (!feats.length) {
        return { status: "not_supported", reason: "none of the paper's predictors matched a GeoARK measure", runs: [] };
      }
      return {
        status: "automl", runs: [],
        reason: `AutoML on the cart with ${label(target)} as the target, scored on held-out states; ` +
                `AutoGluon chooses its own models in place of the paper's ${method.technique}, and the split is spatial`,
        automl: { target: chosen(target).attr_id, features: feats },
      };
    }
    case "preprocessing":
      return { status: "not_supported", runs: [],
               reason: "data preparation, not an analysis; GeoARK uses each measure as published" };
    case "time_series":
      return { status: "not_supported", runs: [],
               reason: "GeoARK holds one value per county and year, not a time-series model" };
    default:
      return { status: "not_supported", runs: [], reason: `GeoARK has no counterpart to ${method.technique}` };
  }
}

/**
 * The whole study -> one entry per method, plus the study-level refusal when
 * the paper is about somewhere GeoARK has no data.
 */
function reproductionPlan(study, { methodIds = null } = {}) {
  const wanted = methodIds ? new Set(methodIds) : null;
  const methods = (study.methods || []).filter(m => !wanted || wanted.has(m.id));
  if (study.area?.scope === "outside_us") {
    return methods.map(m => ({ method_id: m.id, technique: m.technique, family: m.family, quote: m.quote, page: m.page,
                               status: "not_supported", reason: study.area.note, runs: [] }));
  }
  // Several machine-learning models compared in one paper are one AutoML
  // run here: AutoGluon fits its own set of models either way.
  const ml = methods.filter(m => m.family === "machine_learning");
  const merged = ml.length > 1
    ? [...methods.filter(m => m.family !== "machine_learning" || m === ml[0])].map(m => (m === ml[0]
      ? { ...m, technique: ml.map(x => x.technique).join(", "), merged_ids: ml.map(x => x.id) } : m))
    : methods;
  const out = merged.map(m => ({
    method_id: m.id, technique: m.technique, family: m.family, quote: m.quote, page: m.page,
    ...(m.merged_ids ? { merged_ids: m.merged_ids } : {}),
    ...templateFor(m, study),
  }));
  // A paper that maps its outcome rarely names it as a method; the map is
  // the first thing a reader of a reproduction wants to see.
  if (!out.some(o => o.family === "map") && (!wanted || wanted.has("m0"))) {
    const outcome = (study.variables || []).find(v => v.role === "outcome" && chosen(v));
    if (outcome) {
      const t = templateFor({ id: "m0", family: "map", technique: "map", applied_to: outcome.name }, study);
      if (t.runs.length) {
        out.unshift({ method_id: "m0", technique: "Map of the outcome", family: "map", quote: null, page: null,
                      ...t, reason: `${t.reason} (added by GeoARK)` });
      }
    }
  }
  return out;
}

module.exports = { templateFor, reproductionPlan, targetOf, chosen };
