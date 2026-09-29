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

const ops = require("./ops");

/**
 * Arity, required fields, grounding rules and shape rules all come from the op
 * registry (planner/ops/), so a new op brings them with it rather than needing
 * this file edited. What stays HERE is what is genuinely cross-cutting: id
 * uniqueness, the DAG ordering rule, the terminal-output rule, and the
 * shape-composition rule that spans several steps at once.
 */
const OPS = ops.arityTable();

/** Ops whose attr_id (and near_attr_id) must name a facility dataset. */
const FEATURE_OPS = ops.featureOps();

/**
 * Ops that read a layer directly and can therefore narrow it by its own
 * attributes. count_near is excluded on purpose: it involves two layers, and
 * "which one does this filter apply to" has no obvious answer.
 */
const FILTER_OPS = ops.filterOps();

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

  // --- terminal outputs ----------------------------------------------------
  //
  // A plan may carry SEVERAL outputs: each becomes its own returned layer, which
  // is how one question fans out into, say, a point layer and a choropleth. The
  // rules that remain are that there is at least one, that the plan ENDS on one
  // (so the last thing a reader sees is a result, not a dangling computation),
  // and that two of them do not name the same step -- that is a duplicated
  // layer, not a second answer.
  const outputs = steps.filter(s => ops.byName(s.op)?.terminal);
  if (outputs.length === 0) errors.push('plan must end with an "output" step');
  if (outputs.length > 0 && !ops.byName(steps[steps.length - 1].op)?.terminal) {
    errors.push('the "output" step must be last');
  }
  const outputSources = new Map();
  for (const out of outputs) {
    const src = (out.inputs || [])[0];
    if (!src) continue;
    if (outputSources.has(src)) {
      errors.push(
        `steps "${outputSources.get(src)}" and "${out.id}" both output step ` +
        `"${src}". Each output must name a different step.`);
    }
    outputSources.set(src, out.id);
  }

  // --- a features step yields a different SHAPE, so it may not compose ------
  //
  // Every series op yields (fips, value) and chains. Features carry their own
  // geometry and no county key, so normalize/rank/per_area have nothing to
  // operate on. The rule is therefore about CONSUMERS rather than about being
  // alone in the plan: a features step may only be read by an output, which
  // lets it sit alongside a value series that has its own output while still
  // refusing to be chained into one.
  for (const st of steps) {
    if (ops.byName(st.op)?.produces !== "features") continue;
    const consumers = steps.filter(s => (s.inputs || []).includes(st.id));
    const chained = consumers.filter(c => !ops.byName(c.op)?.terminal);
    if (chained.length) {
      errors.push(
        `${st.op} returns individual locations, not per-county values, so ` +
        `it cannot be combined with ${[...new Set(chained.map(s => s.op))].join(", ")}. ` +
        `Feed it straight into an "output" step, and put any state or city ` +
        `restriction in the ${st.op} step itself.`);
    }
    if (!consumers.length) {
      errors.push(`step "${st.id}" (${st.op}) is never used by an output step`);
    }
  }

  // --- a statistic is one row, so it may only be read by an output ---------
  //
  // correlate yields a single row with no county key. Ranking or normalizing
  // it would validate, compile and return a plausible-looking nothing.
  for (const st of steps) {
    const m = ops.byName(st.op);
    if (!m?.statColumns && m?.produces !== "factors") continue;
    const consumers = steps.filter(s => (s.inputs || []).includes(st.id));
    const chained = consumers.filter(c => !ops.byName(c.op)?.terminal);
    if (chained.length) {
      errors.push(
        `${st.op} returns one summary row, not per-county values, so it cannot ` +
        `feed ${[...new Set(chained.map(s => s.op))].join(", ")}. ` +
        `Feed it straight into an "output" step.`);
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

  // --- op-specific checks, from the registry -------------------------------
  //
  // Run unconditionally, and BEFORE resolution. The checks that live on an op
  // module are the ones that need only the step itself -- a place name's shape,
  // a city's shape, filter_area having any states at all. They used to sit in
  // the resolved-source loop below, which begins `if (!src) continue`, and
  // filter_place carries attr_id "" by schema convention, so every check placed
  // there was silently skipped for it. Two rejection tests caught that; running
  // them here means a new op cannot reintroduce it.
  for (const st of steps) {
    const mod = ops.byName(st.op);
    if (mod && typeof mod.validate === "function") {
      errors.push(...mod.validate(st));
    }
  }

  // --- GROUNDING: every cited attribute must resolve to a physical column ----
  //
  // Which fields cite an attribute is declared per op (`grounds`), so
  // near_attr_id is covered for the same reason attr_id is: it names a real
  // dataset the SQL will read from, and leaving it out would let a proximity
  // step cite something that was never retrieved.
  const cites = (st) => {
    const mod = ops.byName(st.op);
    return (mod?.grounds || [])
      .filter(g => st[g.field])
      .map(g => ({ ...g, id: st[g.field] }));
  };

  const attrIds = [];
  for (const st of steps) for (const c of cites(st)) attrIds.push(c.id);

  const resolved = attrIds.length ? await resolve(attrIds) : new Map();
  for (const st of steps) {
    for (const c of cites(st)) {
      if (!resolved.has(c.id)) {
        errors.push(
          `step "${st.id}": ${c.field} "${c.id}" is not a known attribute. ` +
          `Use only attr_id values returned by search_variables.`);
      }
    }
  }

  // --- an op must match the SHAPE of its source -----------------------------
  //
  // Loading a feature table as if it were a value series would silently produce
  // nothing, and counting an ACS column has nothing to count.
  for (const st of steps) {
    for (const c of cites(st)) {
      const src = resolved.get(c.id);
      if (!src) continue;
      const isFeature = src.source_kind === "feature_table";
      if (c.sourceKind === "value" && isFeature) {
        errors.push(
          `step "${st.id}": "${c.id}" is a facility dataset (point/polygon ` +
          `features with no county key). Use op "count_features" to count them per ` +
          `county, not "${st.op}".`);
      }
      if (c.sourceKind === "feature" && !isFeature) {
        errors.push(c.message
          ? `step "${st.id}": ${c.field} "${c.id}" ${c.message}`
          : `step "${st.id}": "${c.id}" is already a per-county value series. ` +
            `Use op "load", not "${st.op}".`);
      }
    }
  }

  // --- attribute filters must name a value the layer actually holds ---------
  //
  // A filter that misses returns zero rows while looking like a valid answer,
  // which is the worst failure shape this project has. So the value is checked
  // against the distinct values discovered for that column, matched
  // case-insensitively, and NORMALISED to the stored spelling -- "critical
  // access" becomes "CRITICAL ACCESS" rather than silently matching nothing.
  //
  // Which ops accept filters at all comes from the registry
  // (`acceptsAttributeFilters`), so an op that reads two layers cannot silently
  // acquire a filter whose target is ambiguous.
  for (const st of steps) {
    if (!Array.isArray(st.attribute_filters) || !st.attribute_filters.length) continue;
    if (!FILTER_OPS.includes(st.op)) {
      errors.push(
        `step "${st.id}": attribute_filters only apply to ${FILTER_OPS.join(" or ")}`);
      continue;
    }
    const src = st.attr_id ? resolved.get(st.attr_id) : null;
    if (!src) continue;
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

  return { ok: errors.length === 0, errors, resolved, order: steps.map(s => s.id) };
}

module.exports = { validatePlan, OPS };
