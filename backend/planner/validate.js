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

const OPS = {
  load: { needs: ["attr_id"], inputs: 0 },
  filter_attr: { needs: ["operator", "value"], inputs: 1 },
  normalize: { needs: [], inputs: 2 },
  aggregate: { needs: ["function"], inputs: 1 },
  rank: { needs: [], inputs: 1 },
  join: { needs: [], inputs: 2 },
  output: { needs: [], inputs: 1 },
};

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

  // --- GROUNDING: every attr_id must resolve to a physical column -----------
  const attrIds = steps.filter(s => s.op === "load" && s.attr_id).map(s => s.attr_id);
  const resolved = attrIds.length ? await resolve(attrIds) : new Map();
  for (const st of steps) {
    if (st.op !== "load" || !st.attr_id) continue;
    if (!resolved.has(st.attr_id)) {
      errors.push(
        `step "${st.id}": attr_id "${st.attr_id}" is not a known attribute. ` +
        `Use only attr_id values returned by search_variables.`);
    }
  }

  return { ok: errors.length === 0, errors, resolved, order: steps.map(s => s.id) };
}

module.exports = { validatePlan, OPS };
