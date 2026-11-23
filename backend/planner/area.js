/**
 * One rule for "the question names an area": what counts as a restriction,
 * what to do with `states` on an op that cannot read it, and how a named state
 * is added in front of an op that must be computed inside it.
 *
 * It used to live in three places that disagreed. composite.js and moran.js
 * each had a `restrictToNamedArea` that stood down when ANY step carried a
 * `states` field, and index.js `addAskedState` did the same. Only four ops read
 * `states` (filter_area, filter_place, select_features, network_population),
 * so a `states` the model put on a composite step restricted nothing and
 * silenced all three rules: "score every Colorado county ..." scored all 3,132
 * (composite held-out, 2026-11-21). Which ops read `states` is now declared on
 * the op (`takesStates`), so a new one cannot be missed.
 *
 * Require the op registry lazily: ops/composite.js requires composite.js,
 * which requires this file.
 */

const { statesMentioned } = require("../states");

const registry = () => require("./ops");

/** Whether the op reads a `states` field. */
function takesStates(opName) {
  return !!registry().byName(opName)?.takesStates;
}

/**
 * A step that narrows the area: a place or area filter, a comparison of two
 * areas, or a step that READS its own `states` / `city`. A `states` field on
 * any other op is not a restriction (liftStrayStates moves it).
 */
function isRestriction(step) {
  if (["filter_area", "filter_place", "compare_groups"].includes(step.op)) return true;
  if (takesStates(step.op) && Array.isArray(step.states) && step.states.length) return true;
  return step.op === "select_features" && !!step.city;
}

const hasAreaRestriction = (plan) => (plan.steps || []).some(isRestriction);

function freshId(steps, base) {
  const ids = new Set(steps.map(s => s.id));
  let id = base;
  for (let k = 2; ids.has(id); k++) id = `${base}${k}`;
  return id;
}

/**
 * `states` on an op that does not read it: the model's restriction, written
 * where it does nothing. Series steps get the filter_area they meant: before
 * the step when it has inputs (every input, so the units it combines are the
 * area's), after it when it reads nothing. A step that works on features is
 * left, and validate.js refuses it with the way to say it: moving states onto
 * the right layer is not decidable here.
 *
 * Returns a list of descriptions.
 */
function liftStrayStates(plan) {
  const steps = plan.steps || [];
  const fixes = [];
  const stepTypes = registry().stepTypes;
  for (const st of [...steps]) {
    if (!Array.isArray(st.states) || !st.states.length || takesStates(st.op) || st.op === "output") continue;
    const types = stepTypes(steps);
    const own = types.get(st.id);
    const ins = st.inputs || [];
    const lifts = !ins.length
      ? own === "series"
      : ins.every(i => types.get(i) === "series");
    if (!lifts) continue;
    const states = [...st.states];
    delete st.states;
    if (ins.length) {
      st.inputs = ins.map(i => {
        const src = steps.find(s => s.id === i);
        if (src && src.op === "filter_area" && JSON.stringify(src.states) === JSON.stringify(states)) return i;
        const id = freshId(steps, `${i}_in_area`);
        steps.splice(steps.indexOf(st), 0, { id, op: "filter_area", attr_id: "", inputs: [i], states: [...states] });
        return id;
      });
    } else {
      const id = freshId(steps, `${st.id}_in_area`);
      for (const s of steps) s.inputs = (s.inputs || []).map(i => (i === st.id ? id : i));
      steps.splice(steps.indexOf(st) + 1, 0, { id, op: "filter_area", attr_id: "", inputs: [st.id], states: [...states] });
    }
    fixes.push(`${states.join(", ")} was set on ${st.op} step ${st.id}, which cannot read it; ` +
               `restricted its ${ins.length ? "inputs" : "result"} with a filter_area`);
  }
  return fixes;
}

/**
 * The question names exactly one state and the plan restricts nothing: put the
 * state in front of `op` (on its first input; inputs are inner-joined, so that
 * restricts them all), so the statistic is computed over that state's units.
 * Stands down when the question asks for national figures, or for two areas.
 *
 * @param {object} opt  op: the step to restrict before; national: a RegExp for
 *                      "asks for the nation"; because: the text for the log
 * @returns a description, or null
 */
function restrictToNamedArea(plan, query, { op, national = null, because }) {
  const steps = plan.steps || [];
  const target = steps.find(s => s.op === op);
  if (!target || !(target.inputs || []).length) return null;
  if (national && national.test(String(query || ""))) return null;
  if (hasAreaRestriction(plan)) return null;
  const named = statesMentioned(query);
  if (named.length !== 1) return null;
  const id = freshId(steps, `${target.id}_area`);
  steps.splice(steps.indexOf(target), 0,
    { id, op: "filter_area", attr_id: "", inputs: [target.inputs[0]], states: [named[0]] });
  target.inputs = [id, ...target.inputs.slice(1)];
  return `${because} ${named[0]}, which the question names and the plan had left out`;
}

module.exports = { takesStates, isRestriction, hasAreaRestriction, liftStrayStates, restrictToNamedArea, freshId };
