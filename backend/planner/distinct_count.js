/**
 * A total of features is each feature once.
 *
 * count_features gives a per-county count, and a feature is counted in every
 * county it touches: a transmission line through three counties is three in a
 * per-county map, which is the right answer to "which counties have lines".
 * Summed to one number or to states it is wrong. "How many transmission lines
 * in Kansas carry 345 kV or more" planned count_features -> filter_area ->
 * aggregate(sum) and returned 157 for 68 (value_filters held out, 2026-11-21),
 * and tornado tracks read 58-77 for 32.
 *
 * The features path already counts once: select_features keeps whole features
 * that touch the state (an EXISTS, not a join) and summarize counts rows. So a
 * sum over a count_features of a LINE or POLYGON layer, through nothing but
 * one filter_area, is rebuilt as select_features -> summarize with the same
 * area and the same filters. Anything else is left as planned: a rank, a
 * filter_attr or a second consumer in the chain reads the per-county counts for
 * what they are, and a point layer double counts only on a county line.
 *
 * Decided from the plan and the layer's geometry, never the model's call.
 */

const { freshId } = require("./area");

const MULTI_COUNTY = /\b(?:LINE|POLYGON)\b/i;

/**
 * @param plan
 * @param repOf  attr_id -> the catalog's spatial_rep ("POINT" | "LINE" | "POLYGON")
 * @returns a description, or null
 */
function countFeaturesOnce(plan, repOf) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const readers = (id) => steps.filter(s => (s.inputs || []).includes(id));
  const done = [];

  for (const agg of steps.filter(s => s.op === "aggregate" && s.function === "sum")) {
    const chain = [];
    let cur = byId.get((agg.inputs || [])[0]);
    while (cur && cur.op === "filter_area") {
      chain.push(cur);
      cur = byId.get((cur.inputs || [])[0]);
    }
    if (!cur || cur.op !== "count_features" || chain.length > 1) continue;
    if (!MULTI_COUNTY.test(String(repOf(cur.attr_id) || ""))) continue;
    // Every step of the chain is read by this aggregate alone.
    const mine = [...chain, cur];
    if (mine.some(s => readers(s.id).some(r => r !== agg && !mine.includes(r)))) continue;
    if (mine.some(s => readers(s.id).length !== 1)) continue;

    const states = chain.length ? chain[0].states : undefined;
    const selId = freshId(steps, `${cur.id}_features`);
    const sel = { id: selId, op: "select_features", attr_id: cur.attr_id, inputs: [] };
    if (states && states.length) sel.states = [...states];
    if (cur.attribute_filters?.length) sel.attribute_filters = cur.attribute_filters;
    if (cur.value_filters?.length) sel.value_filters = cur.value_filters;
    const total = { id: agg.id, op: "summarize", attr_id: "", inputs: [selId],
                    group_by: agg.group_by === "state" ? "state" : "none" };

    const at = steps.indexOf(agg);
    steps.splice(at, 1, sel, total);
    for (const s of mine) steps.splice(steps.indexOf(s), 1);
    done.push(`${cur.id}`);
  }
  plan.steps = steps;
  return done.length
    ? `counted each feature once: a line or area that crosses several counties is one feature, not one per ` +
      `county (rebuilt as select_features and summarize, replacing the county counts of step ${done.join(", ")})`
    : null;
}

/**
 * What a per-county count of lines or areas means, said where the answer is
 * read: the feature is in every county it touches, so the counties' numbers
 * add up to more than the features there are. Null when nothing applies.
 */
function touchingNote(plan, repOf) {
  const layers = (plan.steps || []).filter(s => s.op === "count_features" && MULTI_COUNTY.test(String(repOf(s.attr_id) || "")));
  return layers.length
    ? "each county's count includes every line or area that touches it, so one that crosses " +
      "several counties is counted in each, and the counties do not sum to the number of features"
    : null;
}

module.exports = { countFeaturesOnce, touchingNote };
