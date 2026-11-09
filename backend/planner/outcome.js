/**
 * The measure a plan answers about must be one the question asked for.
 *
 * Expansion (backend/expansion.js, backend/research.js) adds candidates the
 * question never named -- conditions linked from the literature, keywords read
 * from abstracts -- under purpose "expanded", so they can serve as FACTORS.
 * They must never become the SUBJECT. Measured 2026-10-29: no kidney measure is
 * loaded, and "what drives chronic kidney disease rates" was honestly refused
 * with literature expansion alone; with PubMed or web research on, the planner
 * explained **Diabetes prevalence** (an expanded candidate) as the outcome, and
 * the relevance check passed it (docs/EXPANSION.md). Same family as "average
 * rainfall" -> reading scores.
 *
 * Deterministic, because the candidate's purpose already says it: a candidate
 * is "expanded" only when no decomposed sub-query found it (the merge keeps the
 * first occurrence, and expanded results are appended last).
 *
 * Two rules, both refusals sent back through the repair loop:
 *   1. the input to `explain` may not be (or derive only from) expanded series;
 *   2. a plan may not be built from expanded series alone.
 */

const ops = require("./ops");

function unaskedSubjectErrors(plan, candidates) {
  const byAttr = new Map((candidates || []).map(c => [c.attr_id, c]));
  const expanded = (id) => byAttr.get(id)?.search_purpose === "expanded";
  const label = (id) => byAttr.get(id)?.attr_desc || id;
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // Every step that cites a dataset (load, count_features, select_features ...).
  const cites = (st) => (ops.byName(st.op)?.grounds || []).some(g => st[g.field]);

  /** The citing steps a step's value comes from. */
  const sourcesOf = (id, seen = new Set()) => {
    const st = byId.get(id);
    if (!st || seen.has(id)) return [];
    seen.add(id);
    return [
      ...(cites(st) ? [st] : []),
      ...(st.inputs || []).flatMap(i => sourcesOf(i, seen)),
    ];
  };

  const refuse =
    `If no attribute listed under PRIMARY, NORMALIZATION or FILTER measures what ` +
    `the question asks about, return a plan with no steps: the data is not loaded.`;
  const errors = [];

  for (const st of steps) {
    if (st.op !== "explain") continue;
    const srcs = sourcesOf((st.inputs || [])[0]);
    if (!srcs.length || !srcs.every(s => expanded(s.attr_id))) continue;
    errors.push(
      `step "${st.id}" (explain) explains "${label(srcs[0].attr_id)}", which the ` +
      `question does not ask about: it was linked from the medical literature as ` +
      `a related condition. The outcome must be the condition the question names. ` +
      refuse);
  }

  const cited = steps.filter(cites);
  if (!errors.length && cited.length && cited.every(s => expanded(s.attr_id))) {
    errors.push(
      `every attribute this plan uses (${[...new Set(cited.map(s => `"${label(s.attr_id)}"`))].join(", ")}) ` +
      `is a related condition linked from the medical literature, not something ` +
      `the question names. ` + refuse);
  }
  return errors;
}

module.exports = { unaskedSubjectErrors };
