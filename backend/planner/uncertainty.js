/**
 * Questions about how PRECISE an estimate is (docs/RESEARCH_PLAN.md Phase F,
 * "margins of error").
 *
 * "Which 10 Missouri counties have the least precise poverty rate estimates?"
 * is answered by the width of the published 90% confidence interval, upper
 * bound minus lower bound, and the bounds are in the catalog (USDA ERS
 * CI90UBALLP / CI90LBALLP, described from etl/ers_variables.yaml). Two things
 * stood in the way, both fixed here without touching any other question:
 *
 *   1. Retrieval. "precise" shares nothing with "confidence interval", so the
 *      bounds were never candidates and the plan ranked the poverty rate
 *      itself. A sub-query for the bounds of the measure asked about is added
 *      in code (unified_search_server.js), as "total population" is for
 *      densities.
 *   2. The op. Interval width is combine(difference), and combine is offered
 *      only on difference / change phrasing; precision phrasing now offers it,
 *      with one worked example of upper minus lower.
 */

const PRECISION =
  /\b(?:precise|precision|imprecise|uncertain(?:ty)?|margins?\s+of\s+error|confidence\s+intervals?|(?:un)?reliab(?:le|ility))\b/i;

const asksPrecision = (query) => PRECISION.test(String(query || ""));

// Words of the question that are about precision or ranking, not the measure.
const NOT_MEASURE = /\b(?:which|what|the|least|most|top|bottom|\d+|counties|county|have|has|estimates?|precise|precision|imprecise|uncertain(?:ty)?|reliable|unreliable|reliability|margins?|of|error|confidence|intervals?|in|are|is|with|for|[A-Z][a-z]+)\b/g;

/**
 * The sub-queries that retrieve the bounds of the measure the question names,
 * one per bound. One combined query ("90% confidence interval upper and lower
 * bound for poverty rate") ranked the bounds 10th-12th behind the poverty
 * rates its last words matched, and they never reached the candidates
 * (2026-11-11); "upper bound of the 90% confidence interval ... poverty rate"
 * ranks CI90UBALLP first.
 */
function boundsQueries(query, decomposition = {}) {
  if (!asksPrecision(query)) return [];
  const concept = (decomposition.primary_concepts || [])
    .map(c => String(c).replace(PRECISION, "").replace(/\bestimates?\b/i, "").trim())
    .find(c => c.length > 2);
  const measure = concept || String(query).replace(NOT_MEASURE, " ").replace(/[?.,]/g, " ").replace(/\s+/g, " ").trim();
  return measure ? ["upper", "lower"].map(b =>
    `${b} bound of the 90% confidence interval margin of error ${measure}`) : [];
}

// Which end of the precision ranking is asked for. A WIDER interval is a less
// precise estimate.
const LESS_PRECISE =
  /\b(?:least|less)\s+(?:precise|reliable|certain)\b|\b(?:most|more)\s+(?:uncertain|imprecise|unreliable)\b|\b(?:widest|largest|biggest|greatest)\s+(?:margins?|intervals?|uncertainty)\b/i;
const MORE_PRECISE =
  /\b(?:most|more)\s+(?:precise|reliable|certain)\b|\b(?:least|less)\s+(?:uncertain|imprecise|unreliable)\b|\bnarrowest\b|\bsmallest\s+(?:margins?|intervals?)\b/i;
const BOUND = (desc, which) => new RegExp(`^${which} bound of the`, "i").test(String(desc || ""));

/**
 * Interval width is upper minus lower, and "least precise" is the WIDEST:
 * "Which 10 Missouri counties have the least precise poverty rate
 * estimates?" planned upper - lower, then rank asc ("least"), and returned
 * the ten most precise (overlap 0.0, 2026-11-11). Both the subtraction order
 * and the ranking end are stated by the question and the bounds' own
 * descriptions, so code sets them. Returns a description or null.
 *
 * @param resolved  Map attr_id -> attribute_source row
 */
function repairPrecision(plan, query, resolved) {
  if (!asksPrecision(query)) return null;
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const desc = (id) => resolved.get(byId.get(id)?.attr_id)?.description;
  const fixes = [];
  const widths = new Set();
  for (const st of steps) {
    if (st.op !== "combine" || st.operation !== "difference" || (st.inputs || []).length !== 2) continue;
    const [a, b] = st.inputs;
    if (BOUND(desc(a), "lower") && BOUND(desc(b), "upper")) {
      st.inputs = [b, a];
      fixes.push(`step ${st.id} is upper bound minus lower bound`);
    }
    if (BOUND(desc(st.inputs[0]), "upper") && BOUND(desc(st.inputs[1]), "lower")) widths.add(st.id);
  }
  const want = LESS_PRECISE.test(query) ? "desc" : MORE_PRECISE.test(query) ? "asc" : null;
  for (const st of steps) {
    if (st.op !== "rank" || !want) continue;
    let cur = byId.get(st.inputs?.[0]);
    while (cur && (cur.op === "filter_area" || cur.op === "filter_place" || cur.op === "filter_attr")) {
      cur = byId.get(cur.inputs?.[0]);
    }
    if (!cur || !widths.has(cur.id) || st.direction === want) continue;
    st.direction = want;
    fixes.push(`step ${st.id} ranks the ${want === "desc" ? "widest" : "narrowest"} intervals first: ` +
               `a wider interval is a ${want === "desc" ? "less" : "more"} precise estimate`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

module.exports = { asksPrecision, boundsQueries, repairPrecision, PRECISION };
