/**
 * Which factors are most strongly associated with an outcome, once the obvious
 * confounders are held fixed -- ranked.
 *
 * "What explains diabetes rates across counties?" The literature expansion
 * already finds the candidates (obesity, physical inactivity, smoking); this is
 * the step that TESTS them against the county data and orders them.
 *
 * THE PLAN SHAPE IS DELIBERATELY SMALL: load(outcome) -> explain -> output.
 * The model never lists the factors. It is unreliable at enumerating several
 * attributes, and this project has watched it copy worked examples verbatim.
 * Factors are attached by code after validation (chooseFactors below):
 *   1. one attribute per literature-linked concept (backend/expansion.js)
 *   2. the best attribute of each OTHER concept the question named
 *      ("does income, obesity or smoking explain diabetes")
 *   3. if neither exists (a non-health outcome), a standard socioeconomic set
 *
 * WHAT IS COMPUTED, per factor (planner/stats.js):
 *   rho          Spearman correlation with the outcome, no controls
 *   partial_rho  Spearman correlation after holding the controls fixed: both
 *                ranked series are residualized on the ranked controls
 *   ci / p       on an effective n from the Moran's I of the two RESIDUALS
 *                (what remains after the controls is still spatially clustered)
 *   q_value      Benjamini-Hochberg across the factors tested
 *   importance   the CI bound nearest zero, or 0 when the CI spans zero, so an
 *                uncertain factor can never outrank a well-measured one
 *
 * Controls default to median household income, % 65 and older and % rural
 * (County Health Rankings, ~3,133 counties) -- income, age and rurality
 * confound most county health measures. A factor is never controlled for
 * itself, nor for a control it is effectively the same measure as.
 */

const { SAFE_DB_IDENT, CompileError } = require("./_sql");
const S = require("../stats");

const DEFAULT_CONTROLS = (process.env.EXPLAIN_CONTROLS ??
  "CHR_V063_RAWVALUE,CHR_V053_RAWVALUE,CHR_V058_RAWVALUE").split(",").map(s => s.trim()).filter(Boolean);
// Used only when the question yields no factors of its own.
const DEFAULT_FACTORS = (process.env.EXPLAIN_DEFAULT_FACTORS ??
  "CHR_V063_RAWVALUE,CHR_V053_RAWVALUE,CHR_V058_RAWVALUE,PERCENT_OF_ADULTS_WITH_LESS_THAN_A_HIGH_SCHO")
  .split(",").map(s => s.trim()).filter(Boolean);
const MAX_FACTORS = Number(process.env.EXPLAIN_MAX_FACTORS ?? 8);
const MIN_N = 30;
// Words that ask WHY rather than name a factor. A decomposer that turns "what
// drives obesity" into a sub-query "drivers" retrieves "Driving alone to work"
// -- observed, and it ranked #2 as a named factor. A named factor must have
// some content beyond these.
const WHY_WORDS = new Set(["what", "drive", "drives", "driver", "drivers", "driving",
  "explain", "explains", "explained", "explanation", "factor", "factors", "cause", "causes",
  "predict", "predicts", "predictor", "predictors", "determinant", "determinants", "risk",
  "risks", "contributing", "contribute", "contributes", "behind", "why", "influence",
  "influences", "county", "counties", "level", "rate", "rates", "across", "differences"]);
const hasContent = (text) =>
  String(text || "").toLowerCase().split(/[^a-z0-9]+/).some(w => w.length > 2 && !WHY_WORDS.has(w));
// |rho| at or above this with the outcome means the "factor" is another
// version of the outcome itself (crude vs age-adjusted diabetes), not a driver.
const SAME_MEASURE = 0.97;
// A factor this collinear with a control IS that control under another name
// (two income measures). It is reported, not fitted.
//
// It used to be the other way round: a control collinear with the factor was
// DROPPED. The synthetic test caught what that does -- a factor that only
// tracks income (r ~0.93) lost its income control and came out at
// partial rho -0.69 instead of ~0, presented as a strong driver. High
// collinearity with a confounder is exactly when controlling for it matters.
const SAME_AS_CONTROL = 0.97;

/**
 * Pick the factors for an explain step. Pure: everything it needs is passed in.
 *
 * @returns {Array<{attr_id, role: "factor"|"control", description, source, literature?}>}
 */
function chooseFactors({ outcomeAttrId, candidates = [], resultsByQuery = [],
                         expansion = null, isValueSeries = () => true }) {
  const byId = new Map(candidates.map(c => [c.attr_id, c]));
  const controls = DEFAULT_CONTROLS.filter(id => id !== outcomeAttrId);
  const taken = new Set([outcomeAttrId, ...controls]);
  const factors = [];
  const usable = (c) => c && !taken.has(c.attr_id) && !c.is_feature_table && isValueSeries(c.attr_id);
  // The first USABLE result of a concept, not the first result: "Smoking"
  // whose top hit is already a control must fall through to its next one
  // rather than silently losing the concept.
  const firstUsable = (results) =>
    (results || []).map(r => byId.get(r.attr_id)).find(usable);
  const add = (c, source, literature = null) => {
    if (!usable(c) || factors.length >= MAX_FACTORS) return;
    taken.add(c.attr_id);
    factors.push({ attr_id: c.attr_id, role: "factor", description: c.attr_desc || null,
                   source, ...(literature ? { literature } : {}) });
  };

  // 1. Literature: the first (best-ranked) attribute of each kept concept.
  const concepts = new Map((expansion?.concepts || []).filter(c => c.kept).map(c => [c.name, c]));
  for (const rq of resultsByQuery) {
    if (rq.purpose !== "expanded") continue;
    const rec = concepts.get(rq.query) || rq.expansion || null;
    const lit = rec ? {
      concept: rec.name, seed: rec.seed, papers: rec.support, predicates: rec.predicates,
      papers_as_cause: rec.papers_as_cause ?? null, papers_as_effect: rec.papers_as_effect ?? null,
      // Unknown when an older expansion record lacks the counts.
      direction: rec.direction ?? null,
    } : null;
    add(firstUsable(rq.results), "literature", lit);
  }

  // 2. Other concepts the question named: a primary sub-query that did not
  //    retrieve the outcome is about something else the user mentioned.
  for (const rq of resultsByQuery) {
    if (rq.purpose !== "primary") continue;
    if (!hasContent(rq.query)) continue;
    if ((rq.results || []).some(r => r.attr_id === outcomeAttrId)) continue;
    add(firstUsable(rq.results), "question");
  }

  // 3. Nothing from the question or the literature: the standard covariates,
  //    each tested against the outcome with the others as controls.
  if (!factors.length) {
    for (const id of DEFAULT_FACTORS) {
      if (id === outcomeAttrId || factors.some(f => f.attr_id === id)) continue;
      factors.push({ attr_id: id, role: "factor", description: null, source: "default" });
    }
  }

  return [
    ...factors,
    ...controls.map(id => ({ attr_id: id, role: "control", description: null, source: "control" })),
  ];
}

module.exports = {
  name: "explain",
  inputs: 1,
  needs: [],
  produces: "factors",
  kind: "compute",

  enumComment: "rank the factors associated with one outcome, controlling for income, age, rurality",
  promptLine: `  explain      1 input (the outcome)               -> ranked factors associated with it,
                 controlling for income, age and rurality. Factors are chosen for you`,
  choiceLine: `  "what explains X", "risk factors for X", "what drives X"  -> explain`,

  // Needs adjacency (effective n) and a question asking WHY something varies,
  // not whether two named things are related (that is correlate).
  offered: (ctx) => {
    if (ctx.hasNeighbors !== true) return false;
    const q = String(ctx.query || "");
    return /\bwhat\s+(explains?|drives?|causes?|predicts?|contributes?\s+to|is\s+behind|accounts?\s+for|influences?)\b/i.test(q)
      || /\b(risk\s+factors?|drivers?|predictors?|determinants?|contributing\s+factors?|explanatory)\b/i.test(q)
      || /\bfactors?\s+(behind|for|of|in|that|driving|associated|linked|related)\b/i.test(q)
      || /\bwhy\s+(do|does|are|is)\b[^?]*\b(higher|lower|more|less|worse|better|so)\b/i.test(q);
  },

  examples: [{ text:
`QUESTION: what explains differences in diabetes rates across counties
  (a2 = diagnosed diabetes among adults)
PLAN: {"intent":"Factors most associated with county diabetes rates, controlling for income, age and rurality",
 "output_type":"table","entity_type":"COUNTY",
 "steps":[{"id":"s1","op":"load","attr_id":"a2","inputs":[]},
          {"id":"s2","op":"explain","attr_id":"","inputs":["s1"]},
          {"id":"s3","op":"output","attr_id":"","inputs":["s2"]}]}` }],

  /**
   * A wide matrix: one row per county, the outcome as `y` and each factor or
   * control as v0..vN. Factors are LEFT JOINed, so a county missing one factor
   * still counts for the others; compute() drops missing rows per factor.
   */
  compileStandalone(step, ctx) {
    const factors = step.factors || [];
    if (!factors.length) throw new CompileError(`explain step "${step.id}" has no factors attached`);
    const load = require("./load");
    const ctes = factors.map((f, i) => {
      const src = ctx.resolved.get(f.attr_id);
      if (!src) throw new CompileError(`unresolved factor ${f.attr_id}`);
      if (src.source_kind === "table_column" &&
          (!SAFE_DB_IDENT.test(src.table_name) || !SAFE_DB_IDENT.test(src.value_column))) {
        throw new CompileError(`unsafe identifier for factor ${f.attr_id}`);
      }
      return load.compile({ attr_id: f.attr_id }, { name: `fx_${i}`, bind: ctx.bind, resolved: ctx.resolved });
    });
    const cols = factors.map((f, i) => `fx_${i}.value::float8 AS v${i}`).join(", ");
    const joins = factors.map((f, i) => `LEFT JOIN fx_${i} USING (fips)`).join(" ");
    const sql = `WITH ${[...ctx.declared, ...ctes].join(",\n     ")}\n` +
      `SELECT o.fips, o.value::float8 AS y, ${cols}\n` +
      `FROM ${ctx.input} o ${joins}\nWHERE o.value IS NOT NULL`;
    return { sql, columns: factors.map((f, i) => `v${i}`) };
  },

  /**
   * @param rows       [{fips, y, v0..vN}]
   * @param factors    the step's factors, in column order
   * @param neighbors  Map<fips, fips[]>
   */
  compute(rows, { factors, neighbors }) {
    const col = (i) => `v${i}`;
    const controlIdx = factors.map((f, i) => (f.role === "control" ? i : -1)).filter(i => i >= 0);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const out = [];

    factors.forEach((f, fi) => {
      if (f.role !== "factor") return;
      const ctrl = controlIdx.filter(ci => factors[ci].attr_id !== f.attr_id);
      const base = rows.filter(r => num(r.y) !== null && num(r[col(fi)]) !== null &&
                                     ctrl.every(ci => num(r[col(ci)]) !== null));
      const rec = { ...f, n: base.length, status: "ok" };
      if (base.length < MIN_N) { out.push({ ...rec, status: "too_few_counties" }); return; }

      const ry = S.rank(base.map(r => num(r.y)));
      const rx = S.rank(base.map(r => num(r[col(fi)])));
      rec.rho = S.pearson(rx, ry);
      if (Math.abs(rec.rho) >= SAME_MEASURE) {
        out.push({ ...rec, status: "same_measure_as_outcome" }); return;
      }

      const used = [];
      for (const ci of ctrl) {
        const rc = S.rank(base.map(r => num(r[col(ci)])));
        if (Math.abs(S.pearson(rx, rc)) >= SAME_AS_CONTROL) {
          rec.same_as = factors[ci].description || factors[ci].attr_id;
        }
        used.push(rc);
      }
      if (rec.same_as) { out.push({ ...rec, status: "same_measure_as_control" }); return; }
      const resY = S.residualize(ry, used);
      const resX = S.residualize(rx, used);
      if (!resY || !resX) { out.push({ ...rec, status: "controls_collinear" }); return; }
      rec.partial_rho = S.pearson(resX, resY);
      rec.controls_used = used.length;

      // Moran's I of the residuals, over neighbours present in this subset.
      const pos = new Map(base.map((r, i) => [r.fips, i]));
      const nb = base.map(r => (neighbors.get(r.fips) || []).map(f2 => pos.get(f2)).filter(i => i !== undefined));
      rec.moran_outcome = S.moranI(resY, nb);
      rec.moran_factor = S.moranI(resX, nb);
      rec.n_effective = Math.round(S.nEffective(base.length, rec.moran_outcome, rec.moran_factor));
      Object.assign(rec, S.inference(rec.partial_rho, rec.n_effective, used.length));
      rec.direction = rec.partial_rho >= 0 ? "positive" : "negative";
      // How much of the raw association the controls accounted for.
      rec.attenuation = rec.rho ? 1 - Math.abs(rec.partial_rho) / Math.abs(rec.rho) : null;
      out.push(rec);
    });

    // Literature says this mostly FOLLOWS from the outcome (diabetes ->
    // cardiovascular disease, 733 papers vs 153). At county level it
    // co-occurs, probably through shared causes, so it is shown as context, not
    // ranked as an explanation. Tested and adjusted like the rest.
    for (const r of out) {
      if (r.status === "ok" && r.literature?.direction === "effect") r.context = "consequence";
    }
    const fitted = out.filter(r => r.status === "ok");
    const q = S.bhAdjust(fitted.map(r => r.p_value));
    fitted.forEach((r, i) => {
      r.q_value = q[i];
      const spansZero = r.ci_low <= 0 && r.ci_high >= 0;
      r.importance = spansZero ? 0 : Math.min(Math.abs(r.ci_low), Math.abs(r.ci_high));
    });
    const order = (a, b) => b.importance - a.importance ||
                            Math.abs(b.partial_rho) - Math.abs(a.partial_rho);
    const drivers = fitted.filter(r => !r.context).sort(order);
    const context = fitted.filter(r => r.context).sort(order);
    drivers.forEach((r, i) => { r.rank = i + 1; });

    return {
      outcome_counties: rows.length,
      controls: factors.filter(f => f.role === "control")
        .map(f => ({ attr_id: f.attr_id, description: f.description })),
      factors: [...drivers, ...context, ...out.filter(r => r.status !== "ok")],
    };
  },

  chooseFactors,
  DEFAULT_CONTROLS,
};
