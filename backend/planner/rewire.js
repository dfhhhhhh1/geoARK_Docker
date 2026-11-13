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
/**
 * A bridge with no attr_id whose one input LOADS a feature layer: the model
 * loaded the layer and fed it in, instead of naming it. "What share of
 * Colorado's population lives within 5 miles of a hospital" planned
 * load(Hospitals) -> nearest_distance(attr_id "") on every attempt, which
 * bridgeInputsToIntersect then turned into an intersect with a bridge that
 * cites nothing (2026-11-11). The layer moves onto the bridge, and the load is
 * dropped if nothing else reads it. Runs before bridgeInputsToIntersect.
 *
 * @param featureIds  attr_ids (dereferenced) of the feature layers on offer
 */
function bridgeFromLoadedLayer(plan, featureIds) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const fixed = [];
  for (const st of steps) {
    if (!BRIDGES.has(st.op) || st.attr_id || (st.inputs || []).length !== 1) continue;
    const src = byId.get(st.inputs[0]);
    if (src?.op !== "load" || !featureIds.has(src.attr_id)) continue;
    st.attr_id = src.attr_id;
    st.inputs = [];
    fixed.push(`${st.op} (${st.id})`);
    if (!steps.some(o => (o.inputs || []).includes(src.id))) {
      plan.steps = plan.steps.filter(o => o !== src);
    }
  }
  return fixed.length ? `${fixed.join(", ")} reads the layer its input loaded` : null;
}

/**
 * A total divided by a per-unit series: the denominator is meant as a total
 * too. "What share of Colorado's population lives within 5 miles of a
 * hospital" planned normalize(sum(near), population-by-county), one number
 * over each county, which validates (a scalar against every row) and maps 64
 * meaningless values (2026-11-11). The only consistent reading is the share
 * of the area's total, so the denominator is aggregated with the numerator's
 * own function. A series over a total (each county's share of the whole) is
 * left alone.
 *
 * @param stepTypes  (steps) => Map id -> type (ops/index.js)
 */
function totalTheDenominator(plan, stepTypes) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const types = stepTypes(steps);
  const ids = new Set(steps.map(s => s.id));
  const fixed = [];
  for (const st of [...steps]) {
    const isRatio = st.op === "normalize" || (st.op === "combine" && st.operation === "ratio");
    if (!isRatio || (st.inputs || []).length !== 2) continue;
    const [num, den] = st.inputs;
    const numStep = byId.get(num);
    if (types.get(num) !== "scalar" || types.get(den) !== "series" || numStep?.op !== "aggregate") continue;
    const id = freshId(ids, `${den}_total`);
    steps.splice(steps.indexOf(st), 0,
      { id, op: "aggregate", attr_id: "", inputs: [den], function: numStep.function });
    st.inputs = [num, id];
    fixed.push(`${st.op} (${st.id}) divides by the ${numStep.function} of ${den}`);
  }
  return fixed.length ? fixed.join("; ") : null;
}

/**
 * An area restriction applied to access's demand BEFORE the op. Catchments
 * cross state lines: a hospital in Texarkana serves Arkansas too, and
 * restricting the population to Texas first undercounts that hospital's
 * demand, so every Texas county near the border reads better access than it
 * has. The restriction is about which counties to REPORT, so it moves to
 * after the op. Only when nothing else reads the restricted series.
 */
function areaAfterAccess(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const fixed = [];
  for (const st of [...steps]) {
    if (st.op !== "access") continue;
    const fa = byId.get((st.inputs || [])[0]);
    if (!fa || (fa.op !== "filter_area" && fa.op !== "filter_place")) continue;
    if (steps.some(o => o !== st && (o.inputs || []).includes(fa.id))) continue;
    st.inputs = [...(fa.inputs || [])];
    const readers = steps.filter(o => (o.inputs || []).includes(st.id));
    for (const r of readers) r.inputs = r.inputs.map(i => (i === st.id ? fa.id : i));
    fa.inputs = [st.id];
    plan.steps = steps.filter(o => o !== fa);
    plan.steps.splice(plan.steps.indexOf(st) + 1, 0, fa);
    fixed.push(`${fa.op} (${fa.id}) now restricts access's result, not the people it counts`);
  }
  return fixed.length ? fixed.join("; ") : null;
}

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

/**
 * A change over time reads LATER minus EARLIER. When a combine's two inputs
 * trace back (through filters) to the same measure at two stated years, its
 * inputs are ordered the way the operation reads: difference is input 1 -
 * input 2 (later first), percent_change takes input 1 as the baseline
 * (earlier first). "How many acres of cultivated cropland did each Missouri
 * county gain or lose between 2001 and 2021?" planned zonal(2001) -
 * zonal(2021): every county right in size, wrong in sign (H4 dev, 2026-11-12).
 * repairPeriods in index.js does this for load steps it re-years itself; this
 * covers any year-carrying source (load, zonal) the model dated.
 */
function orderChangeByYear(plan) {
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));
  const PASS = new Set(["filter_area", "filter_place", "filter_attr", "aggregate_to"]);
  const root = (id) => {
    let st = byId.get(id);
    for (let i = 0; st && PASS.has(st.op) && i < steps.length; i++) st = byId.get((st.inputs || [])[0]);
    return st;
  };
  const fixes = [];
  for (const st of steps) {
    if (st.op !== "combine" || !["difference", "percent_change"].includes(st.operation)) continue;
    const [a, b] = (st.inputs || []).map(root);
    if (!a || !b || a.attr_id !== b.attr_id || a.year == null || b.year == null || a.year === b.year) continue;
    const laterFirst = st.operation === "difference";
    const wrong = laterFirst ? Number(a.year) < Number(b.year) : Number(a.year) > Number(b.year);
    if (!wrong) continue;
    st.inputs = [st.inputs[1], st.inputs[0]];
    fixes.push(`step ${st.id} reads ${Math.max(a.year, b.year)} against ${Math.min(a.year, b.year)} (later minus earlier)`);
  }
  return fixes.length ? fixes.join("; ") : null;
}

/**
 * A plan with steps and no output, whose steps end in exactly one step
 * nothing reads: that step is the answer, and the output is added. "What is
 * the average elevation of each St. Louis ward?" planned a lone zonal step,
 * three attempts running, refused as "plan must end with an output step"
 * (H4 dev, 2026-11-12). With two or more unread steps which one is the answer
 * is not decidable, and nothing is added.
 */
function addMissingOutput(plan) {
  const steps = plan.steps || [];
  if (!steps.length || steps.some(s => s.op === "output")) return null;
  const read = new Set(steps.flatMap(s => s.inputs || []));
  const sinks = steps.filter(s => !read.has(s.id));
  if (sinks.length !== 1) return null;
  let id = "out";
  while (steps.some(s => s.id === id)) id += "_";
  steps.push({ id, op: "output", attr_id: "", inputs: [sinks[0].id] });
  return `added the output of step ${sinks[0].id}, the plan's only result`;
}

module.exports = { addMissingOutput, orderChangeByYear, areaAfterAccess, totalTheDenominator, bridgeFromLoadedLayer, loadLabelInputs, splitOutputs, dropRateOverCount, earlierResultSecond,
                   bridgeInputsToIntersect, restrictToEarlier, uninvertChains };
