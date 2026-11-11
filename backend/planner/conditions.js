/**
 * Conditions: "rural", "high poverty", "few hospitals", "above 20%".
 *
 * A filter_attr threshold can come from three places, in this order of trust:
 *
 *   definition   a published, cited cut on that exact measure ("d1"), checked
 *                against the loaded data (backend/definitions.js)
 *   value        a number the QUESTION states ("above 20%")
 *   percentile   a qualifier with no number ("high", "few"): a percentile of
 *                the input's own values, so it needs no knowledge of the
 *                measure's units and works for data loaded tomorrow
 *
 * What this module adds is code-side, after the model, like the other repairs:
 *   - definition labels -> the rule they stand for, stamped onto the step so
 *     the plan shown to the user carries the actual operator and number;
 *   - a threshold that cannot be on the measure's scale (50 against a 0-1
 *     fraction) is converted when unambiguous, refused otherwise.
 *
 * The phrasing gates below are English GRAMMAR (comparatives and quantifiers),
 * a closed set that does not grow with the data, unlike a list of terms.
 */

/** A qualitative level with no number: "high poverty", "few hospitals". */
const RELATIVE_PHRASES = new RegExp(
  "\\b(" + [
    // "how many" counts; it qualifies nothing (count-hospitals, r-dogs).
    "high", "low", "(?<!how\\s)many", "few", "fewer", "lots\\s+of", "large", "small",
    "(above|below)[- ](the\\s+)?((national|state|us|u\\.s\\.)\\s+)?(average|median|norm)",
    "(top|bottom|upper|lower)\\s+(quarter|quartile|third|half|tenth|decile|fifth|quintile)",
    // "the poorest quarter of counties" (research_advanced.yaml): a share of
    // the distribution named by its direction, not by top/bottom.
    "(poorest|richest|wealthiest|highest|lowest|most|least)\\s+(quarter|quartile|third|half|tenth|decile|fifth|quintile)",
  ].join("|") + ")\\b", "i");

/**
 * A stated comparison or an absence: "above 20%", "no hospital". "over" and
 * "under" only before a number: "over the last decade" is a period.
 */
const COMPARISON_PHRASES =
  /\b(above|below|more\s+than|less\s+than|fewer\s+than|at\s+least|at\s+most|greater\s+than|exceed\w*|no|without|zero|lack\w*)\b|\b(over|under)\s+\$?\d/i;

/**
 * The question has a time dimension (gates the `year` field).
 *
 * The second alternative is a COUNTED period ("over the last decade", "past 5
 * years"): "which counties' unemployment rate rose the most over the last
 * decade" matched nothing, so neither the year field nor combine was on offer
 * and a change over time could not be planned at all (r-unemp-decade).
 */
const TIME_PHRASES =
  /\b(19\d{2}|20\d{2}|trends?|over time|since|growth|grew|shrank|declin\w*|increas\w*|decreas\w*|change\s+(from|in|since|between)|year[- ]over[- ]year|historical)\b|\b(last|past|previous)\s+(decade|\d{1,2}\s+years?|few\s+years)\b/i;

/**
 * A change in a measure: the verbs, not the period. combine is offered when a
 * question has a change AND a time dimension, because "rose the most over the
 * last decade" is a difference between two years of one measure.
 */
const CHANGE_PHRASES =
  /\b(increas\w*|decreas\w*|rose|risen|rising|fell|fallen|falling|grew|grown|growth|declin\w*|dropped|climbed|worsened|improved|shrank|gain\w*|lost)\b/i;

/**
 * The complement of a group: "the rest of the country", "all other counties".
 * Gates intersect's `exclude` field.
 */
const COMPLEMENT_PHRASES =
  /\b(the\s+rest\s+of|all\s+(the\s+)?other|every\s+other|everywhere\s+else|elsewhere|outside\s+(of\s+)?(the|those|these|them)|exclud\w*|except|other\s+counties|remaining\s+counties)\b/i;

/**
 * Several things on ONE map: "show poverty and hospitals on the same map",
 * "overlay fire stations on unemployment", "as layers". Gates the multi-output
 * rule. Explicit phrasing only: "poverty and unemployment" alone is a join or a
 * comparison, and a user who wants more layers can add them in the map's
 * layer panel without a planner call.
 */
const LAYER_PHRASES =
  /\b(on\s+(the\s+same|one|a\s+single)\s+map|same\s+map|overlay\w*|overlaid|layers?|layered|stack(ed)?\s+on|on\s+top(\s+of)?)\b/i;

/** Whether the question states a condition of any kind. */
function statesCondition(ctx = {}) {
  const q = String(ctx.query || "");
  return ctx.hasDefinitions === true || RELATIVE_PHRASES.test(q) || COMPARISON_PHRASES.test(q);
}

/**
 * Two groups set against each other: "higher in the South than in the
 * Northeast", "rural counties compared with urban ones".
 *
 * At least one word between the comparative and "than", and no number or
 * "average" after it: "more than 100,000 residents" is a threshold, and
 * "higher than average" is a percentile. "The difference between A and B" is
 * combine's arithmetic on two MEASURES, not two groups, so it is not here.
 */
const GROUP_COMPARISON =
  /\b(higher|lower|more|less|greater|fewer|worse|better|bigger|smaller|larger|poorer|richer|healthier|sicker)\s+(?!than\b)[^.?]*?\bthan\s+(?![\d$]|(the\s+)?((national|state|us)\s+)?(average|median|mean)\b)|\bcompared?\s+(to|with)\b|\b(versus|vs\.?)\s|\bdiffer(ent|s)?\s+(from|than)\b/i;

/**
 * Steps that pass input 1's values through unchanged, so a threshold on them is
 * a threshold on the measure that was loaded.
 */
const PASS_THROUGH = new Set(["filter_attr", "filter_area", "filter_place", "intersect", "rank"]);

/** The load step whose values reach `stepId`, or null if they were transformed. */
function sourceLoad(stepId, byId) {
  let st = byId.get(stepId);
  for (let guard = 0; st && guard < 64; guard++) {
    if (st.op === "load") return st;
    if (!PASS_THROUGH.has(st.op)) return null;
    st = byId.get((st.inputs || [])[0]);
  }
  return null;
}

/**
 * Replace definition labels ("d1") with the rule they stand for.
 *
 * Runs before validation, like derefPlan for attribute labels: the model may
 * only cite a definition the prompt listed, and code supplies the numbers.
 * An unknown label is returned for the repair loop, never guessed at.
 *
 * @param defRefs  Map<label, def> built when the prompt was
 * @returns {{unknown: string[], used: object[]}}
 */
function derefDefinitions(plan, defRefs) {
  const unknown = [];
  const used = [];
  for (const st of plan.steps || []) {
    if (st.op !== "filter_attr" || st.definition === undefined) continue;
    const key = String(st.definition || "").trim();
    if (!key) { delete st.definition; continue; }
    const def = defRefs.get(key);
    if (!def) { unknown.push(key); continue; }
    st.definition = def.id;
    // Carried for labelling (a compare_groups group reads "mostly rural").
    // Display only: the numbers are re-checked against the definition.
    st.definition_term = def.term;
    st.operator = def.op;
    st.value = def.value;
    // A definition fixes the threshold; a percentile alongside it would be a
    // second, contradictory one.
    delete st.percentile;
    used.push({ step: st.id, ...def });
  }
  return { unknown, used };
}

/**
 * Check every filter_attr threshold against the measure it filters.
 *
 * @param resolved   Map<attr_id, source row>, rows carry value_range {lo, hi}
 * @param defsById   Map<definition id, def[]> (one per measure it binds)
 * @returns {{errors: string[], repairs: string[]}}
 */
function checkThresholds(plan, resolved, defsById = new Map()) {
  const errors = [];
  const repairs = [];
  const steps = plan.steps || [];
  const byId = new Map(steps.map(s => [s.id, s]));

  for (const st of steps) {
    if (st.op !== "filter_attr") continue;
    const load = sourceLoad((st.inputs || [])[0], byId);
    const src = load ? resolved.get(load.attr_id) : null;

    if (st.definition) {
      const bound = defsById.get(st.definition) || [];
      if (!bound.length) {
        errors.push(`step "${st.id}" (filter_attr): definition "${st.definition}" is not available.`);
        continue;
      }
      const def = src ? bound.find(d => d.measure_code === src.census_code) : null;
      if (!def) {
        errors.push(
          `step "${st.id}" (filter_attr): definition "${bound[0].term}" applies to ` +
          `${bound.map(d => d.measure_code).join(", ")}, but this step filters ` +
          `${src ? src.census_code || load.attr_id : "a computed series"}. Apply a ` +
          `definition directly to a load of the attribute it is listed under.`);
        continue;
      }
      if (load.year && (load.year < def.vintage_from || load.year > def.vintage_to)) {
        errors.push(
          `step "${st.id}" (filter_attr): definition "${def.term}" was published for ` +
          `${def.vintage_from}-${def.vintage_to}, and this load reads ${load.year}.`);
      }
      if (st.operator !== def.op || Number(st.value) !== def.value) {
        // A client-supplied plan (follow-ups) that edited the numbers but kept
        // the citation would otherwise be shown as the published definition.
        errors.push(
          `step "${st.id}" (filter_attr): definition "${def.term}" is ${def.op} ${def.value}, ` +
          `but the step says ${st.operator} ${st.value}.`);
      }
      continue;
    }

    if (st.percentile !== undefined && st.percentile !== null) {
      const p = Number(st.percentile);
      if (!Number.isInteger(p) || p < 1 || p > 99) {
        errors.push(`step "${st.id}" (filter_attr): percentile ${JSON.stringify(st.percentile)} ` +
                    `must be a whole number from 1 to 99.`);
      }
      continue;
    }

    // A stated number. Only checkable when the input is a loaded measure whose
    // national range is known.
    const range = src?.value_range;
    const v = Number(st.value);
    if (!range || !Number.isFinite(v)) continue;
    const { lo, hi } = range;
    if (v >= lo && v <= hi) continue;
    // "% rural above 50" against a 0-1 fraction. Unambiguous: no value of a
    // fraction exceeds 1, and the question's number is a percentage. Converted
    // rather than refused, because the repair loop re-emits the same plan.
    if (lo >= 0 && hi <= 1 && v > 1 && v <= 100) {
      const before = st.value;
      st.value = v / 100;
      repairs.push(
        `${src.description || src.census_code} is stored as a fraction from 0 to 1, ` +
        `so the threshold ${before} was read as ${st.value}`);
      continue;
    }
    // Equal to an end of the range is fine; beyond it, ">" selects nothing or
    // "<" selects everything, and either looks like an answer.
    errors.push(
      `step "${st.id}" (filter_attr): ${st.operator} ${st.value} is outside the values ` +
      `this measure takes (${lo} to ${hi}), so it would keep ` +
      `${(st.operator || "").startsWith(">") === v > hi ? "nothing" : "every county"}. ` +
      `Check the units, or use percentile for "high" or "low".`);
  }
  return { errors, repairs };
}

/**
 * How a filtered input should be named in a comparison: "South", "Northeast",
 * "nonmetropolitan (rural)". Derived from the plan, never from model text.
 */
function describeGroup(stepId, byId, defsById = new Map()) {
  const parts = [];
  let st = byId.get(stepId);
  for (let guard = 0; st && guard < 64; guard++) {
    if (st.op === "filter_area" && st.states?.length) {
      parts.push(st.states.length > 3
        ? `${st.states.slice(0, 3).join(", ")} and ${st.states.length - 3} more`
        : st.states.join(", "));
    } else if (st.op === "filter_place" && st.place_name) {
      parts.push(st.place_name);
    } else if (st.op === "intersect") {
      // The condition sits on the SECOND input; the walk continues down the
      // first, which carries the values.
      const other = describeGroup((st.inputs || [])[1], byId, defsById);
      if (other) parts.push(st.exclude === true ? `all counties except ${other}` : other);
      else if (st.exclude === true) parts.push("all others");
    } else if (st.op === "filter_attr") {
      const def = st.definition ? (defsById.get(st.definition) || [])[0] : null;
      const term = def ? def.term : st.definition_term;
      parts.push(term ? term
        : st.percentile ? `${st.operator} ${ordinal(st.percentile)} percentile`
        : `${st.operator} ${st.value}`);
    } else if (st.op === "load" && String(st.attr_id || "").startsWith("result:")) {
      // An earlier workflow step's counties (backend/workflow.js).
      // "q2" is an id; a person reads "step 2". Workflow ids are q1..qN in order.
      const id = st.attr_id.slice("result:".length);
      parts.push(`counties from ${/^q\d+$/.test(id) ? `step ${id.slice(1)}` : id}`);
      break;
    } else if (!PASS_THROUGH.has(st.op)) {
      break;
    }
    st = byId.get((st.inputs || [])[0]);
  }
  return parts.reverse().join("; ") || null;
}

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

module.exports = {
  RELATIVE_PHRASES, COMPARISON_PHRASES, GROUP_COMPARISON, TIME_PHRASES, CHANGE_PHRASES,
  COMPLEMENT_PHRASES, LAYER_PHRASES,
  statesCondition, sourceLoad, derefDefinitions, checkThresholds, describeGroup,
  ordinal,
};
