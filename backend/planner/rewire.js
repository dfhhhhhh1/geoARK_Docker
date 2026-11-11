/**
 * Structural repairs: plans that are wired wrong in a way code can see and
 * fix exactly, where the repair loop has been measured NOT to recover.
 *
 * Each was observed live on 2026-11-09, three attempts out of three, at the
 * planner's temperature: the model re-emits the same wiring however the
 * validator words its message. Each repair is logged and returned, so the
 * answer says what was changed, like every other repair in planner/index.js.
 */

const { stepUnit } = require("./units");

/**
 * An attribute LABEL used as a step input: inputs ["s1", "a1"].
 *
 * Seen on every workflow step that compares an earlier result's counties: the
 * model wired the result's label straight into intersect instead of loading it
 * ('input "a1" is not a step in this plan', 3 of 3). What it meant is
 * unambiguous: a load of that label. So the load is added, once per label, at
 * the top of the plan where it is defined before any use.
 *
 * Runs before derefPlan, while inputs still hold model labels.
 * @returns a description, or null
 */
function loadLabelInputs(plan, refs) {
  const steps = plan.steps || [];
  const ids = new Set(steps.map(s => s.id));
  const added = new Map();               // label -> new step id
  for (const st of steps) {
    st.inputs = (st.inputs || []).map(inp => {
      if (ids.has(inp) || !refs.has(inp)) return inp;
      if (!added.has(inp)) {
        let id = `load_${inp}`.replace(/[^A-Za-z0-9_]/g, "_");
        while (ids.has(id)) id += "_";
        ids.add(id);
        added.set(inp, id);
      }
      return added.get(inp);
    });
  }
  if (!added.size) return null;
  plan.steps = [
    ...[...added].map(([label, id]) => ({ id, op: "load", attr_id: label, inputs: [] })),
    ...steps,
  ];
  return `loaded ${[...added.keys()].join(", ")}, which the plan used as a step input`;
}

/**
 * An output step with several inputs is several outputs.
 *
 * "step s8 (output): expects 1 input(s), got 2". A plan may carry several
 * outputs (compile.js), so splitting it keeps every layer the model asked for.
 */
function splitOutputs(plan) {
  const out = [];
  let changed = false;
  const ids = new Set((plan.steps || []).map(s => s.id));
  for (const st of plan.steps || []) {
    if (st.op !== "output" || (st.inputs || []).length < 2) { out.push(st); continue; }
    changed = true;
    st.inputs.forEach((inp, i) => {
      let id = i === 0 ? st.id : `${st.id}_${i + 1}`;
      while (i > 0 && ids.has(id)) id += "_";
      ids.add(id);
      out.push({ ...st, id, inputs: [inp] });
    });
  }
  if (!changed) return null;
  plan.steps = out;
  return "split an output with several inputs into one output each";
}

/**
 * A rate divided by a count: drop the division and keep the rate.
 *
 * The validator refuses this (Phase B, the "Detroit" shape), and its message
 * says exactly what to do, "load it and output it without normalize". On
 * "Which 100 counties have the highest uninsured rates?" the model re-emitted
 * the division 3 of 3 times anyway, so the question got no answer at all.
 * The rate IS what was asked, so consumers of the normalize are rewired to its
 * numerator, and the denominator's load goes if nothing else reads it.
 *
 * Only for a positively identified rate over a positively identified count,
 * the same test the validator applies (planner/units.js).
 * @returns a description, or null
 */
function dropRateOverCount(plan, resolved) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const notes = [];
  for (const st of [...steps]) {
    if (st.op !== "normalize") continue;
    const [num, den] = st.inputs || [];
    if (stepUnit(num, byId, resolved) !== "rate" || stepUnit(den, byId, resolved) !== "count") continue;
    for (const other of steps) {
      other.inputs = (other.inputs || []).map(i => (i === st.id ? num : i));
    }
    plan.steps = plan.steps.filter(s => s !== st);
    const denStep = byId.get(den);
    if (denStep && !plan.steps.some(s => (s.inputs || []).includes(den))) {
      plan.steps = plan.steps.filter(s => s !== denStep);
    }
    notes.push(`kept the rate itself rather than dividing it by a count (step ${st.id})`);
  }
  return notes.length ? notes.join("; ") : null;
}

/**
 * An earlier workflow result as intersect's FIRST input, a measure second.
 *
 * intersect keeps input 1's values. An earlier result is a set of counties
 * (with the earlier step's values), so a step that also loads a measure asks
 * about that measure, restricted to the set. Planner reasoning off, "how does
 * their median household income compare with the rest of the country" wired
 * intersect(q1, income) and intersect(q1, income, exclude): q1's own values,
 * and q1's counties with no income figure -- none. compare_groups over an
 * empty group, 0 rows, 3 of 3 (2026-11-10). Swapped, it is income in q1's
 * counties against income everywhere else.
 *
 * Runs after derefPlan, when an earlier result's attr_id is "result:qN".
 * @returns a description, or null
 */
function earlierResultSecond(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  // The load a step's values come from, following first inputs.
  const rootLoad = (id, seen = new Set()) => {
    const st = byId.get(id);
    if (!st || seen.has(id)) return null;
    seen.add(id);
    if (st.op === "load") return st;
    return st.inputs?.length ? rootLoad(st.inputs[0], seen) : null;
  };
  const isResult = (ld) => /^result:/.test(String(ld?.attr_id || ""));
  const swapped = [];
  for (const st of steps) {
    if (st.op !== "intersect" || (st.inputs || []).length !== 2) continue;
    const [a, b] = st.inputs.map(i => rootLoad(i));
    if (isResult(a) && b && !isResult(b)) {
      st.inputs = [st.inputs[1], st.inputs[0]];
      swapped.push(st.id);
    }
  }
  return swapped.length
    ? `put the measure first in ${swapped.join(", ")} (intersect keeps its first input's ` +
      `values; the earlier result is the set of counties)`
    : null;
}

// Ops that start a chain from a feature dataset, with no input of their own.
const BRIDGES = new Set(["nearest_distance", "count_features", "count_near"]);

const freshId = (ids, base) => {
  let id = base.replace(/[^A-Za-z0-9_]/g, "_");
  while (ids.has(id)) id += "_";
  ids.add(id);
  return id;
};

/**
 * A bridge op given an input: nearest_distance(s1).
 *
 * "How far is each of the counties from q1 from the nearest hospital" wired
 * q1's result into nearest_distance, which takes none, 3 of 3 attempts
 * ('expects 0 input(s), got 1'; once the model dropped the input, the load was
 * left unread). The meaning is unambiguous: the distance, for those counties.
 * So the bridge runs on its own and is intersected with what it was given.
 * Consumers keep the step's id, which now names the intersect.
 * @returns a description, or null
 */
function bridgeInputsToIntersect(plan) {
  const steps = plan.steps || [];
  const ids = new Set(steps.map(s => s.id));
  const out = [];
  const fixed = [];
  for (const st of steps) {
    if (!BRIDGES.has(st.op) || (st.inputs || []).length !== 1) { out.push(st); continue; }
    const bridgeId = freshId(ids, `${st.id}_${st.op}`);
    out.push({ ...st, id: bridgeId, inputs: [] });
    out.push({ id: st.id, op: "intersect", attr_id: "", inputs: [bridgeId, st.inputs[0]] });
    fixed.push(`${st.op} (${st.id})`);
  }
  if (!fixed.length) return null;
  plan.steps = out;
  return `ran ${fixed.join(", ")} on its own and kept only the counties it was given`;
}

/**
 * A workflow step that never uses the one earlier result it was handed.
 *
 * "Within those counties, how strongly is adult smoking related to COPD"
 * planned load(smoking), load(copd), correlate: national, and the workflow
 * then stopped because the step ignored its input. "Within those counties" is
 * a restriction, so each chain start (a load, or a bridge from a feature
 * dataset) is intersected with the earlier result, and everything downstream
 * reads the restricted series. Only with exactly ONE earlier result on offer:
 * with two, which one was meant is not code's to guess.
 *
 * Runs after derefPlan. @param earlier  attr_ids of the earlier results offered
 * @returns a description, or null
 */
function restrictToEarlier(plan, earlier) {
  if (!Array.isArray(earlier) || earlier.length !== 1) return null;
  const [rid] = earlier;
  const steps = plan.steps || [];
  if (!steps.length || steps.some(s => s.op === "load" && s.attr_id === rid)) return null;
  const ids = new Set(steps.map(s => s.id));
  const starts = steps.filter(s => (s.inputs || []).length === 0 &&
    (s.op === "load" || BRIDGES.has(s.op)));
  if (!starts.length) return null;
  const loadId = freshId(ids, "earlier");
  const renamed = new Map();
  const out = [{ id: loadId, op: "load", attr_id: rid, inputs: [] }];
  for (const st of steps) {
    out.push(st);
    if (!starts.includes(st)) continue;
    const cut = freshId(ids, `${st.id}_in_earlier`);
    renamed.set(st.id, cut);
    out.push({ id: cut, op: "intersect", attr_id: "", inputs: [st.id, loadId] });
  }
  for (const st of out) {
    if (st.op === "intersect" && st.inputs[1] === loadId) continue;
    st.inputs = (st.inputs || []).map(i => renamed.get(i) || i);
  }
  plan.steps = out;
  return `restricted ${starts.map(s => s.id).join(", ")} to the counties from ` +
         `${rid.replace(/^result:/, "")}, which the plan did not use`;
}

// Ops that take exactly one series and narrow it, keeping its values.
const FILTERS = new Set(["filter_area", "filter_place", "filter_attr", "rank"]);

/**
 * A chain written upside down: filter_place (no input) -> load (input: the
 * filter). "What are the poverty rates around Detroit?", planner reasoning
 * off: 'filter_place expects 1 input, got 0 | load expects 0 inputs, got 1',
 * and the retries lost the output step; NO_ANSWER in 4 of 5 runs
 * (2026-11-10/11). The meaning is unambiguous: load, then filter. The load
 * loses its input, the filter reads the load, and whatever read the load now
 * reads the filter.
 * @returns a description, or null
 */
function uninvertChains(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const fixed = [];
  for (const ld of steps) {
    if (ld.op !== "load" || (ld.inputs || []).length !== 1) continue;
    const f = byId.get(ld.inputs[0]);
    if (!f || !FILTERS.has(f.op) || (f.inputs || []).length !== 0) continue;
    for (const st of steps) {
      if (st !== f) st.inputs = (st.inputs || []).map(i => (i === ld.id ? f.id : i));
    }
    ld.inputs = [];
    f.inputs = [ld.id];
    fixed.push(`${f.op} (${f.id})`);
  }
  if (!fixed.length) return null;
  // Order is a validation rule (a step may only read earlier steps): put each
  // load before everything, keeping the rest in their order.
  plan.steps = [...steps.filter(s => s.op === "load" && !(s.inputs || []).length),
                ...steps.filter(s => !(s.op === "load" && !(s.inputs || []).length))];
  return `put ${fixed.join(", ")} after the data it filters (the plan had them the other way round)`;
}

module.exports = { loadLabelInputs, splitOutputs, dropRateOverCount, earlierResultSecond,
                   bridgeInputsToIntersect, restrictToEarlier, uninvertChains };
