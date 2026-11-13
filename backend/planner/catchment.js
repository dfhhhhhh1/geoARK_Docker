/**
 * Catchments: people within, or beyond, a distance of something
 * (docs/RESEARCH_PLAN.md Phase F; GIS_OPS_PLAN.md H1).
 *
 * "How many people in Missouri live more than 20 miles from the nearest
 * hospital?" is a question about PEOPLE, and a county is the wrong unit to
 * count them in. Planned at the county, as qwen3 plans it every time, the
 * distance is measured from the county's centroid and the whole county's
 * population is in or out together: a county whose centroid is 21 miles from
 * a hospital contributes every resident, including the town next door to it.
 *
 * So, as with levels.js, the model plans and code chooses the unit. When the
 * question asks about people at a distance and the plan measures a distance
 * from a population, the population load and the distance step move to census
 * tracts: each tract is in or out by the distance from its own point
 * (geo_unit.pt, always inside the tract), and its own population counts. If
 * the answer is per county, the tract result is summed back to counties
 * (ops/aggregate_to.js); a total needs nothing more. Nothing about the plan's
 * shape changes, only the unit its distance and population are measured in.
 *
 * Runs on an ACCEPTED plan, after the relevance and named-data checks: the
 * swap is between equivalent whole-population counts, so their verdicts hold.
 * The prompt and the decoding schema are untouched.
 *
 * The tract population is an ACS count (SVI_E_TOTPOP, the same dataset levels
 * weights by), else WorldPop. Where neither has tract values the plan runs at
 * the county as before, and says nothing.
 */

const { levelOf, asksDistance } = require("./levels");
const { ABOUT_PEOPLE } = require("./features");
const { isPopulationCount } = require("../population");

// "more than 20 miles from", "within 5 miles of": a stated distance from
// something, which asksDistance's within-N form does not cover on its own.
const STATED_FROM =
  /\b\d+(?:\.\d+)?\s*(?:miles?|mi|km|kilometers?|kilometres?|meters?|metres?)\s+(?:from|of|away)\b/i;

const asksPeopleAtDistance = (query) => {
  const q = String(query || "");
  return ABOUT_PEOPLE.test(q) && (asksDistance(q) || STATED_FROM.test(q)) && !levelOf(q);
};

// "what share / percent of Colorado's population" (backend/population.js
// countsPeople carries the same phrase for the relevance check).
const SHARE_OF_POPULATION =
  /\b(?:share|percent(?:age)?|proportion|fraction)\s+of\s+(?:the\s+)?(?:[A-Z][\w.]*(?:'s)?\s+){0,3}population\b/;

const TRACT_POPULATION = ["SVI_E_TOTPOP", "WORLDPOP_POP"];
const DISTANCE_OPS = new Set(["nearest_distance", "count_near"]);
// Ops whose SQL is correct on tract rows read through (fips, value) alone, or
// that have a tract form. filter_place and per_area read the PLAN's level, and
// the plan stays at the county, so a plan carrying them is left alone.
const TRACT_SAFE = new Set([
  "load", "nearest_distance", "count_near", "filter_attr", "filter_area",
  "intersect", "rank", "aggregate", "combine", "normalize", "join", "output",
]);

/**
 * @param resolve   async (attrIds) => Map attr_id -> attribute_source row
 * @param levelsOf  async (code) => Set of levels with values
 * @returns {{note: string|null}} the plan is edited in place when it applies
 */
async function applyCatchment(plan, query, resolved, { resolve, levelsOf, stepTypes }) {
  const none = { note: null, population: null };
  if (!asksPeopleAtDistance(query) || plan.level) return none;
  const steps = plan.steps || [];
  if (!steps.some(s => DISTANCE_OPS.has(s.op))) return none;
  if (!steps.every(s => TRACT_SAFE.has(s.op))) return none;
  if (steps.some(s => s.op === "aggregate" && s.group_by === "state")) return none;

  const loads = steps.filter(s => s.op === "load");
  const popLoads = loads.filter(s => isPopulationCount(resolved.get(s.attr_id)?.description));
  if (!popLoads.length || popLoads.length !== loads.length) return none;

  let pop = null;
  for (const code of TRACT_POPULATION) {
    if (!(await levelsOf(code)).has("tract")) continue;
    const row = (await resolve([code])).get(code);
    if (row?.census_code === code) { pop = row; break; }
  }
  if (!pop) return none;

  // Every output must report PEOPLE: the population itself, through steps
  // that keep its value (filters, intersect, rank), or a sum of it, or a
  // ratio of such sums (a share). A tract distance summed to a county, or an
  // unweighted mean of tract distances, is not an answer about people, so a
  // plan with one is left at the county exactly as planned.
  const byId = new Map(steps.map(s => [s.id, s]));
  const keepsValue = new Set(["filter_attr", "filter_area", "intersect", "rank"]);
  const people = (id) => {
    for (let st = byId.get(id), i = 0; st && i <= steps.length; i++) {
      if (st.op === "load") return true;
      if (!keepsValue.has(st.op)) return false;
      st = byId.get((st.inputs || [])[0]);
    }
    return false;
  };
  const total = (id) => {
    const st = byId.get(id);
    if (st?.op === "aggregate") return st.function === "sum" && people(st.inputs?.[0]);
    if (st?.op === "combine" || st?.op === "normalize") return (st.inputs || []).every(total);
    return false;
  };
  // "What SHARE of Colorado's population lives within 5 miles": the plan the
  // worked example teaches counts the people; the share is that count over
  // the people the distance was applied to, which code can add exactly. The
  // denominator is the population chain the plan intersected, so it carries
  // the same area restriction as the numerator.
  let shared = false;
  const original = JSON.stringify(steps);
  if (SHARE_OF_POPULATION.test(String(query || ""))) {
    const out = steps.filter(s => s.op === "output");
    const agg = out.length === 1 ? byId.get((out[0].inputs || [])[0]) : null;
    const inter = agg?.op === "aggregate" && agg.function === "sum" ? byId.get((agg.inputs || [])[0]) : null;
    const whole = inter?.op === "intersect" && !inter.exclude ? (inter.inputs || [])[0] : null;
    if (whole && people(whole)) {
      const fresh = (base) => { let id = base; while (byId.has(id)) id += "_"; return id; };
      const denom = { id: fresh(`${agg.id}_all`), op: "aggregate", attr_id: "", inputs: [whole], function: "sum" };
      byId.set(denom.id, denom);
      const ratio = { id: fresh(`${agg.id}_share`), op: "combine", attr_id: "", inputs: [agg.id, denom.id],
                      operation: "ratio", scale: 100 };
      byId.set(ratio.id, ratio);
      steps.splice(steps.indexOf(out[0]), 0, denom, ratio);
      out[0].inputs = [ratio.id];
      shared = true;
    }
  }

  const types = stepTypes(steps);
  const outs = steps.filter(s => s.op === "output");
  if (!outs.every(o => {
    const src = (o.inputs || [])[0];
    return types.get(src) === "series" ? people(src) : total(src);
  })) {
    plan.steps = JSON.parse(original);
    return none;
  }

  // Outputs that read a per-unit series need it summed back to counties; a
  // total (an ungrouped aggregate, or a combine of totals) needs nothing.
  const ids = new Set(steps.map(s => s.id));
  for (const st of steps) {
    if (st.op === "load") st.attr_id = pop.attr_id;
    if (st.op === "load" || DISTANCE_OPS.has(st.op)) st.level = "tract";
  }
  let rolled = false;
  for (const out of steps.filter(s => s.op === "output")) {
    const src = (out.inputs || [])[0];
    if (types.get(src) !== "series") continue;
    let id = `${src}_by_county`;
    while (ids.has(id)) id += "_";
    ids.add(id);
    steps.splice(steps.indexOf(out), 0,
      { id, op: "aggregate_to", attr_id: "", inputs: [src], from_level: "tract", method: "sum" });
    out.inputs = [id];
    rolled = true;
  }
  return {
    population: pop,
    note: `people counted by census tract: each tract's population ("${pop.description}") ` +
          `is in or out by the distance from the tract itself, not from the county's centre` +
          (rolled ? `, then summed to counties` : "") +
          (shared ? `; the share is those people over everyone in the area, as a percentage` : ""),
  };
}

module.exports = { applyCatchment, asksPeopleAtDistance };
