/**
 * Plan validation.
 *
 * The security and correctness boundary of the whole planner. The schema
 * (schemas.js PLAN_SCHEMA) guarantees a plan is well-FORMED; this guarantees it
 * is well-GROUNDED:
 *
 *   - every `attr_id` exists in attribute_source, so it resolves to a real
 *     physical column;
 *   - every `inputs` reference names an earlier step, so the graph is acyclic
 *     and topologically ordered;
 *   - each op has the arguments it actually needs;
 *   - there is exactly one terminal `output`.
 *
 * The rule this enforces is the one that makes small local models usable here:
 * **the model may only cite identifiers a tool actually returned to it.** It is
 * enforced in code, not asked for in a prompt, because a prompt is a request
 * and this is an invariant.
 *
 * Errors are returned as structured, human-readable strings rather than thrown,
 * because they are fed back to the model in the repair loop.
 */

const { toFipsPrefixes } = require("../states");

const OPS = {
  load: { needs: ["attr_id"], inputs: 0 },
  // Facility datasets are point/polygon features with no fips key. This op is
  // the bridge that turns them into the (fips, value) series everything else
  // composes over: count features per county.
  count_features: { needs: ["attr_id"], inputs: 0 },
  // Same bridge, with a proximity condition: count features of attr_id that lie
  // within `miles` of any feature of near_attr_id. Both must be feature tables.
  count_near: { needs: ["attr_id", "near_attr_id", "miles"], inputs: 0 },
  // Also a bridge, but produces a distance rather than a count.
  nearest_distance: { needs: ["attr_id"], inputs: 0 },
  // NOT a bridge: returns the features themselves. See the shape rule below.
  select_features: { needs: ["attr_id"], inputs: 0 },
  filter_attr: { needs: ["operator", "value"], inputs: 1 },
  filter_area: { needs: ["states"], inputs: 1 },
  filter_place: { needs: ["place_kind", "place_name"], inputs: 1 },
  per_area: { needs: [], inputs: 1 },
  normalize: { needs: [], inputs: 2 },
  aggregate: { needs: ["function"], inputs: 1 },
  rank: { needs: [], inputs: 1 },
  join: { needs: [], inputs: 2 },
  output: { needs: [], inputs: 1 },
};

/** Ops whose attr_id (and near_attr_id) must name a facility dataset. */
const FEATURE_OPS = ["count_features", "count_near", "nearest_distance", "select_features"];

/**
 * Ops that read a layer directly and can therefore narrow it by its own
 * attributes. count_near is excluded on purpose: it involves two layers, and
 * "which one does this filter apply to" has no obvious answer.
 */
const FILTER_OPS = ["select_features", "count_features"];

/**
 * @param plan        parsed plan object (already schema-valid)
 * @param resolve     async (attrIds) => Map<attr_id, sourceRow>
 * @returns {Promise<{ok: boolean, errors: string[], resolved: Map, order: string[]}>}
 */
async function validatePlan(plan, resolve) {
  const errors = [];
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];

  if (steps.length === 0) {
    return { ok: false, errors: ["plan has no steps"], resolved: new Map(), order: [] };
  }

  // --- unique ids -----------------------------------------------------------
  const seen = new Set();
  for (const st of steps) {
    if (seen.has(st.id)) errors.push(`duplicate step id "${st.id}"`);
    seen.add(st.id);
  }

  // --- ops and arity --------------------------------------------------------
  for (const st of steps) {
    const spec = OPS[st.op];
    if (!spec) {
      errors.push(`step "${st.id}": unknown op "${st.op}". Valid ops: ${Object.keys(OPS).join(", ")}`);
      continue;
    }
    for (const field of spec.needs) {
      if (st[field] === undefined || st[field] === null || st[field] === "") {
        errors.push(`step "${st.id}" (${st.op}): missing required field "${field}"`);
      }
    }
    const inputs = st.inputs || [];
    if (inputs.length !== spec.inputs) {
      errors.push(
        `step "${st.id}" (${st.op}): expects ${spec.inputs} input(s), got ${inputs.length}`);
    }
  }

  // --- references point backwards (so the graph is a DAG, already ordered) ---
  const before = new Set();
  for (const st of steps) {
    for (const ref of st.inputs || []) {
      if (!seen.has(ref)) {
        errors.push(`step "${st.id}": input "${ref}" is not a step in this plan`);
      } else if (!before.has(ref)) {
        errors.push(
          `step "${st.id}": input "${ref}" is defined later. Steps must be in execution order.`);
      }
    }
    before.add(st.id);
  }

  // --- exactly one terminal output -----------------------------------------
  const outputs = steps.filter(s => s.op === "output");
  if (outputs.length === 0) errors.push('plan must end with an "output" step');
  if (outputs.length > 1) errors.push(`plan has ${outputs.length} output steps; exactly one is allowed`);
  if (outputs.length === 1 && steps[steps.length - 1].op !== "output") {
    errors.push('the "output" step must be last');
  }

  // --- select_features returns a different SHAPE, so it may not compose -----
  //
  // Every other op yields (fips, value) and chains. Features carry their own
  // geometry and no county key, so normalize/rank/per_area have nothing to
  // operate on. Rather than let a plan chain them and fail confusingly at
  // compile time, the rule is stated here and the model is told it directly.
  const featureSteps = steps.filter(s => s.op === "select_features");
  if (featureSteps.length > 1) {
    errors.push("a plan may contain at most one select_features step");
  }
  if (featureSteps.length === 1) {
    const others = steps.filter(s => s.op !== "select_features" && s.op !== "output");
    if (others.length) {
      errors.push(
        `select_features returns individual locations, not per-county values, so ` +
        `it cannot be combined with ${[...new Set(others.map(s => s.op))].join(", ")}. ` +
        `Use select_features then output, and put any state or city restriction ` +
        `in the select_features step itself.`);
    }
    if (steps[0].op !== "select_features") {
      errors.push('select_features must be the first step');
    }
  }

  // --- filter_area names must be real places -------------------------------
  // Checked here as well as in the decoding enum, because the enum only
  // constrains generation -- a repaired plan or a non-constrained caller can
  // still carry a name that has no FIPS code.
  for (const st of steps) {
    // Required on filter_area, optional on select_features -- but validated
    // wherever it appears, so a bad place name never reaches the compiler.
    if (st.op !== "filter_area" && st.op !== "select_features") continue;
    if (st.op === "filter_area" && (!Array.isArray(st.states) || st.states.length === 0)) {
      errors.push(`step "${st.id}" (filter_area): "states" must list at least one state or region`);
      continue;
    }
    if (!Array.isArray(st.states) || st.states.length === 0) continue;
    const { unknown } = toFipsPrefixes(st.states);
    if (unknown.length) {
      errors.push(
        `step "${st.id}" (${st.op}): unknown state or region ${unknown.map(u => `"${u}"`).join(", ")}. ` +
        `Use full state names, or one of: Midwest, Northeast, South, West.`);
    }
  }

  // --- a place name must have the shape its kind implies -------------------
  //
  // place_name is free text for the same reason `city` is: 32,642 place names
  // cannot be an enum. So it gets the same backstop, with one difference --
  // a ZCTA's name is a ZIP code, all digits, which the place-name pattern
  // would reject.
  //
  // Its own loop, not the one below: that loop starts `if (!src) continue`, and
  // filter_place carries attr_id "" by schema convention, so every check placed
  // there is skipped for it. Two rejection tests caught this.
  for (const st of steps) {
    if (st.op !== "filter_place" || !st.place_name) continue;
    const value = String(st.place_name);
    const ok = st.place_kind === "zcta"
      ? /^\d{5}$/.test(value)
      : /^[A-Za-z0-9]([A-Za-z0-9 .'\-]*[A-Za-z0-9])?$/.test(value);
    if (!ok) {
      errors.push(
        `step "${st.id}": place_name ${JSON.stringify(value)} does not look like ` +
        (st.place_kind === "zcta"
          ? `a 5-digit ZIP code.`
          : `a place name. Give the name alone, e.g. "Springfield", and put ` +
            `any state in "states".`));
    }
  }

  // --- GROUNDING: every attr_id must resolve to a physical column -----------
  // near_attr_id is included: it names a real dataset the SQL will read from,
  // so it is exactly as much a grounding boundary as attr_id. Leaving it out
  // would let a proximity step cite a dataset that was never retrieved.
  const attrIds = [];
  for (const s of steps) {
    if ((s.op === "load" || FEATURE_OPS.includes(s.op)) && s.attr_id) attrIds.push(s.attr_id);
    if (s.op === "count_near" && s.near_attr_id) attrIds.push(s.near_attr_id);
  }
  const resolved = attrIds.length ? await resolve(attrIds) : new Map();
  for (const st of steps) {
    const cite = [];
    if ((st.op === "load" || FEATURE_OPS.includes(st.op)) && st.attr_id) {
      cite.push(["attr_id", st.attr_id]);
    }
    if (st.op === "count_near" && st.near_attr_id) {
      cite.push(["near_attr_id", st.near_attr_id]);
    }
    for (const [field, id] of cite) {
      if (!resolved.has(id)) {
        errors.push(
          `step "${st.id}": ${field} "${id}" is not a known attribute. ` +
          `Use only attr_id values returned by search_variables.`);
      }
    }
  }

  // An op must match the shape of its source. Loading a feature table as if it
  // were a value series would silently produce nothing.
  for (const st of steps) {
    const src = st.attr_id ? resolved.get(st.attr_id) : null;
    if (!src) continue;
    if (st.op === "load" && src.source_kind === "feature_table") {
      errors.push(
        `step "${st.id}": "${st.attr_id}" is a facility dataset (point/polygon ` +
        `features with no county key). Use op "count_features" to count them per ` +
        `county, not "load".`);
    }
    if (FEATURE_OPS.includes(st.op) && src.source_kind !== "feature_table") {
      errors.push(
        `step "${st.id}": "${st.attr_id}" is already a per-county value series. ` +
        `Use op "load", not "${st.op}".`);
    }
    // --- a city must look like a place name --------------------------------
    //
    // `city` is the one free-text field in a plan, and constrained decoding has
    // been observed leaking JSON structure into it -- "Springfield','states':
    // ['Missouri']" -- which compiles fine and matches nothing. generatePlan
    // salvages the leading name before validation; this is the backstop for
    // anything that reaches here unrepaired.
    if (st.city && !/^[A-Za-z]([A-Za-z .'\-]*[A-Za-z])?$/.test(st.city)) {
      errors.push(
        `step "${st.id}": city ${JSON.stringify(st.city)} is not a place name. ` +
        `Give the city on its own, e.g. "Springfield", and put the state in "states".`);
    }

    // --- attribute filters must name a value the layer actually holds -------
    //
    // A filter that misses returns zero rows while looking like a valid answer,
    // which is the worst failure shape this project has. So the value is
    // checked against the distinct values discovered for that column, matched
    // case-insensitively, and NORMALISED to the stored spelling -- "critical
    // access" becomes "CRITICAL ACCESS" rather than silently matching nothing.
    if (Array.isArray(st.attribute_filters) && st.attribute_filters.length) {
      if (!FILTER_OPS.includes(st.op)) {
        errors.push(
          `step "${st.id}": attribute_filters only apply to ${FILTER_OPS.join(" or ")}`);
      } else {
        const available = src.filter_values || {};
        for (const f of st.attribute_filters) {
          const values = available[f.column];
          if (!values || !values.length) {
            const usable = Object.keys(available);
            errors.push(
              `step "${st.id}": "${st.attr_id}" has no filterable "${f.column}" column. ` +
              (usable.length
                ? `Available filters for this dataset: ${usable.join(", ")}.`
                : `This dataset has no attribute filters; drop attribute_filters.`));
            continue;
          }
          const match = values.find(
            v => String(v).toLowerCase() === String(f.value).toLowerCase());
          if (!match) {
            errors.push(
              `step "${st.id}": "${f.value}" is not a value of "${f.column}" for this ` +
              `dataset. Valid values: ${values.slice(0, 12).map(v => `"${v}"`).join(", ")}` +
              `${values.length > 12 ? ", ..." : ""}.`);
            continue;
          }
          f.value = match;   // normalize to the stored spelling
        }
      }
    }

    // The proximity target is a geometry the query measures against, so it too
    // has to be a feature table -- an ACS column has nothing to be near.
    if (st.op === "count_near" && st.near_attr_id) {
      const nearSrc = resolved.get(st.near_attr_id);
      if (nearSrc && nearSrc.source_kind !== "feature_table") {
        errors.push(
          `step "${st.id}": near_attr_id "${st.near_attr_id}" is a per-county value ` +
          `series, not a mappable dataset. Proximity needs two datasets that have ` +
          `locations on the map.`);
      }
    }
  }

  return { ok: errors.length === 0, errors, resolved, order: steps.map(s => s.id) };
}

module.exports = { validatePlan, OPS };
