/**
 * Follow-ups: what happens after the first answer.
 *
 * A result is rarely the end of a question. "And in Texas?", "just the top ten",
 * "use the other poverty measure", "put my own numbers next to it". Before this,
 * every one of those was a fresh 20-second plan from a question the user had to
 * retype in full, and nothing guaranteed the second plan read the same measure
 * as the first.
 *
 * Two paths, deliberately kept apart:
 *
 *   1. EDITS. A structural change to the plan that just ran: restrict the area,
 *      rank, swap one measure for another candidate, add a second measure, add
 *      a spatial statistic, add the user's own data. Applied in code, then sent
 *      through the SAME validator and compiler as a planned query. No model is
 *      involved, so it is fast (milliseconds, not the planner's ~20s), it
 *      cannot drift to a different measure, and the planner prompt is untouched:
 *      `snapshot_prompt.js` stays byte-identical and every planner number in
 *      CLAUDE.md still describes the planner.
 *
 *   2. QUESTIONS. Anything else is free text, and the small model rewrites it
 *      into one standalone question using the conversation so far, which then
 *      runs through the normal pipeline. The rewrite is SHOWN to the user,
 *      because a rewrite nobody can see is a silent reinterpretation, the same
 *      failure as a city filter quietly spanning 25 states.
 *
 * `parseQuickEdit` sits in front of the model and catches the follow-ups that
 * are unambiguously edits ("what about Texas", "top 10"), so the commonest ones
 * never pay for an LLM call. It is strict: anything it cannot account for
 * word by word goes to the model.
 *
 * USER DATA never touches the database. A series arrives with the request as
 * two arrays, is bound as parameters into an `unnest` (planner/ops/load.js), and
 * is gone when the request ends. The transaction stays READ ONLY, and there is
 * no upload table to clean up, size, or secure.
 */

const { STATE_FIPS, REGIONS, POSTAL_TO_NAME, toFipsPrefixes, statesMentioned } = require("./states");
const ops = require("./planner/ops");
const { SAFE_ID } = require("./planner/ops/_sql");
const { shortLabel, contextLabel } = require("./suggestions");

/**
 * What to call an attribute on a button. ACS descriptions are paths, and the
 * last segment alone is often ambiguous ("Under 18 years" of WHAT), so the last
 * two are used when there are two.
 */
const measureLabel = (desc) => (desc ? (contextLabel(desc) || shortLabel(desc)) : null);

class FollowUpError extends Error {}

// ---------------------------------------------------------------------------
// User-supplied series
// ---------------------------------------------------------------------------

const USER_PREFIX = "user:";
// Two is what any single edit can reference (correlate one upload with
// another), and it keeps the request well inside the 256 kB JSON limit.
const MAX_USER_SERIES = 2;
// Above the 3,233 counties with room for territories; a file larger than that
// is not a county file.
const MAX_USER_ROWS = 5000;
const FIPS_RE = /^\d{5}$/;
const USER_ID_RE = /^[A-Za-z0-9]{1,16}$/;

const isUserAttr = (id) => typeof id === "string" && id.startsWith(USER_PREFIX);

/**
 * Check user series and turn them into resolved-source rows.
 *
 * Everything here arrives from the browser, so nothing is trusted: FIPS must be
 * five digits, values must be finite numbers or null, and sizes are capped. The
 * values are only ever BOUND, never interpolated, so this is about returning a
 * clear message rather than about injection.
 *
 * @returns {{ sources: Map<string, object>, errors: string[] }}
 */
function validateUserSeries(list) {
  const sources = new Map();
  const errors = [];
  if (list === undefined || list === null) return { sources, errors };
  if (!Array.isArray(list)) return { sources, errors: ["user_series must be an array"] };
  if (list.length > MAX_USER_SERIES) {
    errors.push(`at most ${MAX_USER_SERIES} uploaded series can be used at once`);
    return { sources, errors };
  }
  for (const s of list) {
    const id = String(s?.id ?? "");
    if (!USER_ID_RE.test(id)) { errors.push(`uploaded series id ${JSON.stringify(id)} is not valid`); continue; }
    // Control characters stripped: the name reaches the report, the CSV
    // header comment and the map legend.
    const name = String(s?.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
    if (!name) { errors.push(`uploaded series ${id} has no name`); continue; }
    const fips = s?.fips, values = s?.values;
    if (!Array.isArray(fips) || !Array.isArray(values) || fips.length !== values.length) {
      errors.push(`uploaded series "${name}": fips and values must be arrays of equal length`);
      continue;
    }
    if (!fips.length) { errors.push(`uploaded series "${name}" has no rows`); continue; }
    if (fips.length > MAX_USER_ROWS) {
      errors.push(`uploaded series "${name}" has ${fips.length} rows; the limit is ${MAX_USER_ROWS}`);
      continue;
    }
    const seen = new Set();
    let bad = null;
    const cleanValues = new Array(values.length);
    for (let i = 0; i < fips.length; i++) {
      const f = String(fips[i]);
      if (!FIPS_RE.test(f)) { bad = `row ${i + 1}: FIPS ${JSON.stringify(fips[i])} is not five digits`; break; }
      // A duplicate county would silently double-count in a join, so it is an
      // error here rather than something the SQL quietly resolves.
      if (seen.has(f)) { bad = `county ${f} appears more than once`; break; }
      seen.add(f);
      const v = values[i];
      if (v === null || v === undefined || v === "") { cleanValues[i] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) { bad = `row ${i + 1}: value ${JSON.stringify(v)} is not a number`; break; }
      cleanValues[i] = n;
    }
    if (bad) { errors.push(`uploaded series "${name}": ${bad}`); continue; }
    const file = s?.file ? String(s.file).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200) : null;
    sources.set(USER_PREFIX + id, {
      attr_id: USER_PREFIX + id,
      source_kind: "inline",
      description: name,
      dataset: "Your uploaded data",
      file,
      fips: fips.map(String),
      values: cleanValues,
      row_count: fips.length,
    });
  }
  return { sources, errors };
}

/**
 * A resolver that answers `user:` ids from this request's uploads and passes
 * everything else to the database resolver. A plan can therefore only cite user
 * data that was actually sent with it, which is the same grounding rule every
 * catalog attribute already obeys.
 */
function withUserSeries(resolve, userSources) {
  return async (ids) => {
    const user = ids.filter(isUserAttr);
    const rest = ids.filter(id => !isUserAttr(id));
    const out = rest.length ? await resolve(rest) : new Map();
    for (const id of user) if (userSources.has(id)) out.set(id, userSources.get(id));
    return out;
  };
}

/** A candidate-shaped row for a user series, so the UI can name it. */
function userCandidate(src) {
  return {
    attr_id: src.attr_id,
    attr_desc: src.description,
    dataset_clean: src.dataset,
    attr_orig: src.file || "",
    entity_type: "COUNTY",
    search_purpose: "user",
    is_user_series: true,
  };
}

// ---------------------------------------------------------------------------
// Plan edits
// ---------------------------------------------------------------------------

const clone = (plan) => JSON.parse(JSON.stringify(plan));
const mod = (st) => ops.byName(st?.op);
const stepById = (plan, id) => plan.steps.find(s => s.id === id);

function freshId(plan, prefix) {
  const used = new Set(plan.steps.map(s => s.id));
  for (let i = 1; i < 1000; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
  throw new FollowUpError("plan has too many steps to edit");
}

/** Point every consumer of `fromId` at `toId`, except `toId` itself. */
function rewire(plan, fromId, toId) {
  for (const st of plan.steps) {
    if (st.id === toId) continue;
    st.inputs = (st.inputs || []).map(i => (i === fromId ? toId : i));
  }
}

/** Insert `step` directly after `afterId`, reading from it, and move its consumers onto it. */
function insertAfter(plan, afterId, step) {
  const idx = plan.steps.findIndex(s => s.id === afterId);
  if (idx < 0) throw new FollowUpError(`step "${afterId}" is not in the plan`);
  step.inputs = [afterId];
  rewire(plan, afterId, step.id);
  plan.steps.splice(idx + 1, 0, step);
}

/** Remove a one-input step, handing its consumers its input. */
function removeStep(plan, id) {
  const st = stepById(plan, id);
  if (!st) throw new FollowUpError(`step "${id}" is not in the plan`);
  if ((st.inputs || []).length !== 1) throw new FollowUpError(`step "${id}" cannot be removed`);
  rewire(plan, id, st.inputs[0]);
  plan.steps = plan.steps.filter(s => s.id !== id);
}

const outputSteps = (plan) => plan.steps.filter(s => mod(s)?.terminal);

/** The step the first output reads. Every edit that changes "the answer" acts here. */
function primarySource(plan) {
  const out = outputSteps(plan)[0];
  if (!out) throw new FollowUpError("plan has no output");
  const src = stepById(plan, (out.inputs || [])[0]);
  if (!src) throw new FollowUpError("plan output reads nothing");
  return { out, src };
}

/**
 * Does this step yield ONE per-county number? Only those can be ranked, have a
 * statistic applied, or gain a second measure. A join already carries two, and
 * rank selects (fips, value) and would silently drop the second; a correlate is
 * one summary row; features and factors have no county key at all.
 */
function isSingleSeries(st) {
  const m = mod(st);
  return !!m && m.produces === "series" && !m.secondValue && !m.statColumns;
}

/**
 * Intent is what the result is titled by, on screen and in every export
 * filename. Edits are recorded as labelled revisions on top of the planner's
 * own intent, and a later edit of the same kind REPLACES the earlier one, so
 * "Texas" then "Ohio" reads "... · in Ohio", not "... · in Texas · in Ohio".
 */
function relabel(plan, kind, label) {
  plan.base_intent = plan.base_intent || plan.intent || "Analysis";
  plan.revisions = (plan.revisions || []).filter(r => r.kind !== kind);
  if (label) plan.revisions.push({ kind, label });
  plan.intent = [plan.base_intent, ...plan.revisions.map(r => r.label)].join(" · ");
}

/**
 * Rewrite the place named in the planner's own title.
 *
 * Appending is not enough: "Median household income for Missouri counties"
 * restricted to Texas read "... for Missouri counties · in Texas", a title
 * that names the wrong state first. When the old place is in the title it is
 * replaced; clearing turns the common phrasings into their national form.
 * Returns false when the title names none of the old places, and the caller
 * appends instead.
 */
function retitlePlace(plan, oldNames, replacement) {
  const names = [...new Set(oldNames.filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  if (!names.length) return false;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const one = `(?:${names.map(esc).join("|")})`;
  const list = `${one}(?:(?:\\s*,\\s*and\\s+|\\s*,\\s*|\\s+and\\s+)${one})*`;
  const base = plan.base_intent || plan.intent || "";
  if (!new RegExp(`\\b${one}\\b`, "i").test(base)) return false;
  let next;
  if (replacement) {
    // "the" belongs to a region ("the Midwest"), so it is consumed with the old
    // name and put back only when the new place is a region too.
    next = base.replace(new RegExp(`\\b(?:the\\s+)?${list}\\b`, "i"), replacement);
  } else {
    next = base
      .replace(new RegExp(`\\b(for|in|across|within)\\s+(?:the\\s+)?count(?:y|ies)\\s+(?:in|of)\\s+(?:the\\s+)?${list}\\b`, "i"), "$1 all counties")
      .replace(new RegExp(`\\b${list}(?:'s)?\\s+counties\\b`, "i"), "all US counties")
      .replace(new RegExp(`\\s*\\b(?:in|for|across|within)\\s+(?:the\\s+)?${list}\\b`, "i"), " nationally");
    if (new RegExp(`\\b${one}\\b`, "i").test(next)) return false;
  }
  plan.base_intent = next.replace(/\s{2,}/g, " ").trim();
  return true;
}

/** Every place name a plan currently restricts to, for retitlePlace. */
const placesIn = (plan) => plan.steps.flatMap(s =>
  s.op === "filter_area" || s.op === "select_features" ? (s.states || [])
    : s.op === "filter_place" ? [s.place_name] : []);

/**
 * A place list as words, for titles and notes.
 *
 * This used to shorten long lists to "Alabama, Arkansas and 14 more". That
 * text reached the follow-up rewrite through the title, the model copied it
 * into "... across Alabama, Arkansas and 14 more", and the planner guessed
 * the 14: a South-restricted analysis came back with the wrong states.
 * So: a list that IS a census region is named as one, and any other long list
 * is a count, which nothing downstream can mistake for a place. The exact list
 * reaches the rewrite separately (areaOf), never through this text.
 */
function describeAreas(states) {
  const set = new Set(states);
  if (states.length === 1 && REGIONS[states[0]]) return `the ${states[0]}`;
  for (const [region, members] of Object.entries(REGIONS)) {
    if (members.length === set.size && members.every(m => set.has(m))) return `the ${region}`;
  }
  return states.length <= 3 ? states.join(", ") : `${states.length} states`;
}

/** The exact states a plan is restricted to, or null. For the rewrite prompt. */
function areaOf(plan) {
  const states = [...new Set((plan?.steps || [])
    .filter(s => s.op === "filter_area" || s.op === "select_features")
    .flatMap(s => s.states || []))];
  return states.length ? states : null;
}

const EDITS = {
  /** "what about Texas", "only the Midwest". Replaces any earlier place restriction. */
  restrict_area(plan, edit) {
    const states = [...new Set((edit.states || []).map(s => String(s).trim()).filter(Boolean))];
    if (!states.length) throw new FollowUpError("name at least one state or region");
    const { unknown } = toFipsPrefixes(states);
    if (unknown.length) {
      throw new FollowUpError(`not a state or census region: ${unknown.join(", ")}`);
    }
    const notes = [];
    const before = placesIn(plan);
    plan.base_intent = plan.base_intent || plan.intent || "Analysis";
    // A new area supersedes a named boundary: "Springfield, Missouri" then
    // "what about Texas" does not mean Springfield-inside-Texas.
    for (const st of plan.steps.filter(s => s.op === "filter_place")) {
      removeStep(plan, st.id);
      notes.push(`dropped the ${st.place_name} boundary`);
    }
    let touched = false;
    for (const st of plan.steps) {
      if (st.op === "select_features") {
        st.states = states;
        // Kept only when the caller is narrowing an ambiguous city ("which
        // Springfield"); otherwise the city belongs to the previous state.
        if (st.city && !edit.keep_city) { notes.push(`dropped the city ${st.city}`); delete st.city; }
        touched = true;
      }
      if (st.op === "filter_area") { st.states = states; touched = true; }
    }
    if (!touched) {
      // Filter at every LEAF series, so everything downstream -- a ratio, a
      // join, a correlation, hot spots -- is computed within the area rather
      // than nationally and then clipped.
      const leaves = plan.steps.filter(s => mod(s)?.produces === "series" && !(s.inputs || []).length);
      if (!leaves.length) throw new FollowUpError("this result has no county series to restrict");
      for (const leaf of leaves) {
        insertAfter(plan, leaf.id, {
          id: freshId(plan, "a"), op: "filter_area", attr_id: "", inputs: [], states,
        });
      }
    }
    const titled = describeAreas(states);
    relabel(plan, "area", retitlePlace(plan, before, titled) ? null : `in ${describeAreas(states)}`);
    return `Restricted to ${describeAreas(states)}${notes.length ? ` (${notes.join("; ")})` : ""}.`;
  },

  /** "the whole country". Removes every area restriction. */
  clear_area(plan) {
    const before = placesIn(plan);
    plan.base_intent = plan.base_intent || plan.intent || "Analysis";
    let n = 0;
    for (const st of plan.steps.filter(s => s.op === "filter_area" || s.op === "filter_place")) {
      removeStep(plan, st.id); n++;
    }
    for (const st of plan.steps.filter(s => s.op === "select_features")) {
      if (st.states?.length || st.city) { delete st.states; delete st.city; n++; }
    }
    if (!n) throw new FollowUpError("this result is not restricted to an area");
    relabel(plan, "area", retitlePlace(plan, before, null) ? null : "all counties");
    return "Removed the area restriction; showing every county.";
  },

  /** "top 10", "bottom 5". Updates an existing rank rather than stacking a second. */
  rank(plan, edit) {
    const direction = edit.direction === "asc" ? "asc" : "desc";
    const limit = Math.max(1, Math.min(1000, Number.parseInt(edit.limit, 10) || 10));
    const { src } = primarySource(plan);
    if (src.op === "rank") {
      src.direction = direction; src.limit = limit;
    } else {
      if (!isSingleSeries(src)) {
        throw new FollowUpError(mod(src)?.secondValue
          ? "ranking a two-measure result would drop the second measure"
          : "this result is not a per-county series, so it cannot be ranked");
      }
      insertAfter(plan, src.id, {
        id: freshId(plan, "r"), op: "rank", attr_id: "", inputs: [], direction, limit,
      });
    }
    plan.output_type = "table";
    const label = `${direction === "desc" ? "top" : "bottom"} ${limit}`;
    relabel(plan, "rank", label);
    return `Showing the ${label} counties.`;
  },

  /** Undo one filter or rank, by step id. */
  remove_step(plan, edit) {
    const st = stepById(plan, edit.step_id);
    if (!st) throw new FollowUpError(`step "${edit.step_id}" is not in the plan`);
    if (!REMOVABLE.has(st.op)) throw new FollowUpError(`a ${st.op} step cannot be removed`);
    removeStep(plan, st.id);
    if (st.op === "rank") {
      relabel(plan, "rank", null);
      if (plan.output_type === "table") plan.output_type = "map";
      return "Removed the ranking; showing every county.";
    }
    if (st.op === "filter_area" || st.op === "filter_place") {
      plan.base_intent = plan.base_intent || plan.intent || "Analysis";
      const left = plan.steps.some(s => s.op === "filter_area" || s.op === "filter_place");
      const gone = st.op === "filter_place" ? [st.place_name] : (st.states || []);
      relabel(plan, "area", left || retitlePlace(plan, gone, null) ? null : "all counties");
      return `Removed the ${st.op === "filter_place" ? st.place_name : describeAreas(st.states || [])} restriction.`;
    }
    relabel(plan, "filter", "without the value filter");
    return "Removed the value filter.";
  },

  /** "use the other measure": the same analysis over a different attribute. */
  swap_measure(plan, edit, ctx) {
    const { from, to } = edit;
    if (!from || !to || from === to) throw new FollowUpError("swap needs two different attributes");
    let n = 0;
    for (const st of plan.steps) {
      for (const g of mod(st)?.grounds || []) {
        if (st[g.field] === from) { st[g.field] = to; n++; }
      }
      // A filter names values of the OLD layer and would not validate against
      // the new one; dropping it is announced rather than left to fail.
      if (n && st.attribute_filters && (st.attr_id === to)) delete st.attribute_filters;
    }
    if (!n) throw new FollowUpError(`"${from}" is not used by this result`);
    relabel(plan, "measure", `using ${ctx.label(to)}`);
    return `Swapped ${ctx.label(from)} for ${ctx.label(to)}.`;
  },

  /**
   * "Add unemployment alongside", "is it related to my data". A second measure
   * joined to the current answer, or correlated with it.
   */
  add_measure(plan, edit, ctx) {
    const mode = edit.mode === "correlate" ? "correlate" : "compare";
    if (!edit.attr_id) throw new FollowUpError("name the attribute to add");
    if (ctx.kindOf(edit.attr_id) === "feature") {
      throw new FollowUpError(
        `${ctx.label(edit.attr_id)} is a layer of locations, not a per-county value; ` +
        "map it on its own instead");
    }
    if (mode === "correlate" && ctx.hasNeighbors === false) {
      throw new FollowUpError("correlation needs county adjacency (make neighbors)");
    }
    const { out } = primarySource(plan);
    let { src } = primarySource(plan);
    // A correlation over the top ten counties is a statistic about a selection,
    // not about the relationship; it runs over the series BEFORE ranking.
    if (mode === "correlate") {
      while (src.op === "rank") src = stepById(plan, src.inputs[0]);
    }
    if (!isSingleSeries(src)) {
      throw new FollowUpError("this result is not a single per-county series, so a measure cannot be added to it");
    }
    const at = plan.steps.findIndex(s => s.id === out.id);
    const load = { id: freshId(plan, "m"), op: "load", attr_id: edit.attr_id, inputs: [] };
    plan.steps.splice(at, 0, load);
    // No area copy is needed on the new load: join and correlate are inner
    // joins on fips, so the second measure only reaches the counties the first
    // one already kept.
    const joined = { id: freshId(plan, mode === "correlate" ? "c" : "j"), op: mode === "correlate" ? "correlate" : "join",
                     attr_id: "", inputs: [src.id, load.id] };
    plan.steps.splice(plan.steps.findIndex(s => s.id === out.id), 0, joined);
    out.inputs = [joined.id];
    if (mode === "correlate") {
      plan.output_type = "statistics";
      relabel(plan, "rank", null);
    }
    relabel(plan, "measure2", `${mode === "correlate" ? "correlated with" : "with"} ${ctx.label(edit.attr_id)}`);
    return mode === "correlate"
      ? `Testing how strongly it goes together with ${ctx.label(edit.attr_id)}.`
      : `Added ${ctx.label(edit.attr_id)} alongside.`;
  },

  /** "where are the hot spots of this", "which counties are outliers". */
  add_stat(plan, edit, ctx) {
    const op = edit.op === "outlier" ? "outlier" : "hotspot";
    if (op === "hotspot" && ctx.hasNeighbors === false) {
      throw new FollowUpError("hot spots need county adjacency (make neighbors)");
    }
    const { src } = primarySource(plan);
    if (src.op === "hotspot" || src.op === "outlier") {
      if (src.op === op) throw new FollowUpError(`this result is already ${op === "hotspot" ? "hot spots" : "outliers"}`);
      src.op = op;
    } else {
      if (src.op === "rank") {
        throw new FollowUpError("hot spots and outliers need every county; remove the ranking first");
      }
      if (!isSingleSeries(src)) throw new FollowUpError("this result is not a single per-county series");
      insertAfter(plan, src.id, { id: freshId(plan, "h"), op, attr_id: "", inputs: [] });
    }
    plan.output_type = "map";
    relabel(plan, "stat", op === "hotspot" ? "hot and cold spots" : "outliers");
    return op === "hotspot"
      ? "Looking for clusters of high and low values (Getis-Ord Gi*)."
      : "Keeping only counties far outside the typical range (1.5 IQR rule).";
  },

  /** A different attribute, mapped on its own. Keeps the current area restriction. */
  map_measure(plan, edit, ctx) {
    if (!edit.attr_id) throw new FollowUpError("name the attribute to map");
    const area = plan.steps.find(s => s.op === "filter_area")?.states;
    const isFeature = ctx.kindOf(edit.attr_id) === "feature";
    const steps = [];
    if (isFeature) {
      steps.push({ id: "s1", op: "select_features", attr_id: edit.attr_id, inputs: [],
                   ...(area ? { states: [...area] } : {}) });
    } else {
      steps.push({ id: "s1", op: "load", attr_id: edit.attr_id, inputs: [] });
      if (area) steps.push({ id: "s2", op: "filter_area", attr_id: "", inputs: ["s1"], states: [...area] });
    }
    steps.push({ id: `s${steps.length + 1}`, op: "output", attr_id: "", inputs: [steps[steps.length - 1].id] });
    const label = ctx.label(edit.attr_id);
    const fresh = {
      intent: isFeature ? `Locations of ${label}` : `${label} by county`,
      output_type: "map",
      entity_type: plan.entity_type || "COUNTY",
      steps,
    };
    for (const k of Object.keys(plan)) delete plan[k];
    Object.assign(plan, fresh);
    if (area) relabel(plan, "area", `in ${describeAreas(area)}`);
    return `Mapping ${label}${area ? ` in ${describeAreas(area)}` : ""}.`;
  },

  /** Put another attribute, e.g. the user's own, into an `explain` factor table. */
  add_factor(plan, edit, ctx) {
    const st = plan.steps.find(s => s.op === "explain");
    if (!st) throw new FollowUpError("only a ranked-factors result takes extra factors");
    if (!edit.attr_id) throw new FollowUpError("name the attribute to add");
    if (ctx.kindOf(edit.attr_id) === "feature") throw new FollowUpError("a layer of locations cannot be a factor");
    st.factors = st.factors || [];
    if (st.factors.some(f => f.attr_id === edit.attr_id)) {
      throw new FollowUpError(`${ctx.label(edit.attr_id)} is already a factor`);
    }
    if (st.factors.length >= 24) throw new FollowUpError("this table already has the maximum number of factors");
    // Controls stay last, where chooseFactors put them.
    const firstControl = st.factors.findIndex(f => f.role === "control");
    const factor = { attr_id: edit.attr_id, role: "factor", description: ctx.label(edit.attr_id),
                     source: isUserAttr(edit.attr_id) ? "user" : "added" };
    if (firstControl < 0) st.factors.push(factor); else st.factors.splice(firstControl, 0, factor);
    return `Added ${ctx.label(edit.attr_id)} as a candidate factor.`;
  },
};

const REMOVABLE = new Set(["filter_area", "filter_place", "filter_attr", "rank"]);

/**
 * Apply one edit to a copy of the plan.
 *
 * Returns the edited plan and a one-line note for the user. The result is NOT
 * validated here: the caller runs it through validatePlan exactly as it would a
 * planned query, so grounding and shape rules apply with no second copy.
 *
 * @param ctx { label(attrId) -> string, kindOf(attrId) -> "value"|"feature"|null,
 *              hasNeighbors }
 */
function applyEdit(plan, edit, ctx = {}) {
  // map_measure replaces the plan outright, so it is the one edit that needs
  // nothing before it: "map my data" works before any question has been asked.
  if (edit?.kind === "map_measure" && (!plan || !Array.isArray(plan.steps) || !plan.steps.length)) {
    plan = { intent: "", output_type: "map", entity_type: "COUNTY", steps: [] };
  } else if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
    throw new FollowUpError("there is no previous plan to change");
  }
  const fn = EDITS[edit?.kind];
  if (!fn) throw new FollowUpError(`unknown follow-up "${edit?.kind}"`);
  const full = {
    label: (id) => (isUserAttr(id) ? "your data" : id),
    kindOf: () => null,
    hasNeighbors: true,
    ...ctx,
  };
  const next = clone(plan);
  for (const st of next.steps) {
    if (!SAFE_ID.test(String(st.id))) throw new FollowUpError(`step id ${JSON.stringify(st.id)} is not valid`);
  }
  const note = fn(next, edit, full);
  return { plan: next, note };
}

// ---------------------------------------------------------------------------
// What can be done next
// ---------------------------------------------------------------------------

/**
 * The follow-ups that apply to this plan, for the UI to offer.
 *
 * Applicability is decided by TRYING each edit on a copy rather than by a
 * parallel set of rules, so a button is shown exactly when the edit it sends
 * would apply. A second copy of the rules would drift from EDITS the way the
 * prompt and the decoding enum once drifted apart.
 */
function availableFollowups(plan, { candidates = [], hasNeighbors = true } = {}) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  const tries = (edit) => {
    try { applyEdit(plan, edit, { hasNeighbors, kindOf: () => "value" }); return true; }
    catch { return false; }
  };
  const byId = new Map(candidates.map(c => [c.attr_id, c]));
  const label = (id) => {
    const c = byId.get(id);
    return c ? (measureLabel(c.attr_desc) || c.dataset_clean || id) : id;
  };
  const kind = (c) => (c?.is_feature_table ? "feature" : "value");

  const inUse = [];
  for (const st of plan.steps) {
    for (const g of mod(st)?.grounds || []) {
      const id = st[g.field];
      if (!id || inUse.some(u => u.attr_id === id)) continue;
      inUse.push({ attr_id: id, step_id: st.id, op: st.op, label: label(id),
                   kind: g.sourceKind === "feature" ? "feature" : "value",
                   purpose: byId.get(id)?.search_purpose || null });
    }
  }
  const used = new Set(inUse.map(u => u.attr_id));
  const alternatives = candidates
    .filter(c => !used.has(c.attr_id) && !c.is_user_series)
    .slice(0, 24)
    .map(c => ({ attr_id: c.attr_id, label: label(c.attr_id), kind: kind(c),
                 dataset: c.dataset_clean || null, purpose: c.search_purpose || null,
                 // Near-duplicates share a label ("Civilian labor force 18 to 64
                 // years › Unemployment rate" twice); the full path tells them apart.
                 description: c.attr_desc || null }));

  const removable = plan.steps
    .filter(s => REMOVABLE.has(s.op))
    .map(s => ({
      step_id: s.id, op: s.op,
      label: s.op === "rank" ? `${s.direction === "asc" ? "bottom" : "top"} ${s.limit ?? 20}`
        : s.op === "filter_area" ? describeAreas(s.states || [])
        : s.op === "filter_place" ? String(s.place_name || "place")
        : "value filter",
    }));

  const probe = "__probe__";
  return {
    can: {
      restrict_area: tries({ kind: "restrict_area", states: ["Missouri"] }),
      clear_area: tries({ kind: "clear_area" }),
      rank: tries({ kind: "rank", direction: "desc", limit: 10 }),
      hotspot: tries({ kind: "add_stat", op: "hotspot" }),
      outlier: tries({ kind: "add_stat", op: "outlier" }),
      compare: tries({ kind: "add_measure", attr_id: probe, mode: "compare" }),
      correlate: tries({ kind: "add_measure", attr_id: probe, mode: "correlate" }),
      add_factor: tries({ kind: "add_factor", attr_id: probe }),
      swap: inUse.length > 0,
    },
    in_use: inUse,
    alternatives,
    removable,
  };
}

// ---------------------------------------------------------------------------
// Recognising an edit in free text
// ---------------------------------------------------------------------------

// Words that carry no content in a place-only follow-up. Anything NOT on this
// list, and not a place name, sends the message to the model instead: this is a
// fast path for the unambiguous cases, not a parser.
const FILLER = new Set(`
  what about how and or only just now in for the show me counties
  instead restrict it to limit narrow this that same but zoom focus on of then
  do lets let's try same please can you could see look at within inside state
  states region look do again same thing with as well too also data map
`.split(/\s+/).filter(Boolean));

const WHOLE_COUNTRY = /^(?:(?:show|use|go\s+back\s+to|back\s+to|what\s+about|across|for|over|in)\s+)*(?:the\s+)?(?:whole|entire|all\s+of\s+the|all\s+the|all)\s+(?:country|us|u\.s\.|united\s+states|nation|counties|states)(?:\s+again)?$|^(?:nationally|nationwide|everywhere|national|all\s+counties)(?:\s+again)?$|^remove\s+the\s+(?:state|area|region)\s+(?:filter|restriction)$/;

/**
 * Recognise a follow-up that is purely an edit.
 *
 * Returns an edit object, or null to hand the text to the model. Strict on
 * purpose: "what about Texas" is an area change, "Texas hospitals" is not, and
 * "compare with Texas" is not either. The test is that EVERY word is accounted
 * for, by a place name, a rank phrase or a filler word.
 */
function parseQuickEdit(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!raw || raw.length > 120) return null;
  const t = raw.toLowerCase().replace(/[?!.,;:]+/g, " ").replace(/\s+/g, " ").trim();

  // --- rank -----------------------------------------------------------------
  const rank = t.match(
    /^(?:(?:show|give|list|just|only|now|what\s+are|and)\s+)*(?:me\s+)?(?:the\s+)?(top|highest|bottom|lowest)\s+(\d{1,4})(?:\s+(?:counties|ones|places|results|rows))?(?:\s+instead)?$/);
  if (rank) {
    const limit = Number(rank[2]);
    if (limit < 1 || limit > 1000) return null;
    return { kind: "rank", direction: /top|highest/.test(rank[1]) ? "desc" : "asc", limit };
  }

  // --- the whole country ------------------------------------------------------
  if (WHOLE_COUNTRY.test(t)) return { kind: "clear_area" };

  // --- a place --------------------------------------------------------------
  const names = statesMentioned(raw);
  // Postal codes only when written in capitals ("TX"), since "in", "or", "me"
  // and "ok" are all state codes and all ordinary words.
  const postal = (raw.match(/\b[A-Z]{2}\b/g) || []).filter(c => POSTAL_TO_NAME[c]);
  const places = [...names, ...postal.map(c => POSTAL_TO_NAME[c])];
  if (!places.length) return null;
  // "OK" on its own is an acknowledgement, not Oklahoma. A message that names
  // places ONLY by postal code must also say it is asking about a place.
  if (!names.length && !/\b(about|in|for|only|just|to|instead|try|now)\b/.test(t)) return null;

  let rest = ` ${t} `;
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(`\\b${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), " ");
  }
  for (const c of postal) rest = rest.replace(new RegExp(`\\b${c.toLowerCase()}\\b`, "g"), " ");
  const leftover = rest.split(/\s+/).filter(Boolean).filter(w => !FILLER.has(w));
  if (leftover.length) return null;

  const states = [...new Set(places)].filter(p => STATE_FIPS[p] || REGIONS[p]);
  return states.length ? { kind: "restrict_area", states } : null;
}

// ---------------------------------------------------------------------------
// Rewriting a follow-up into a standalone question
// ---------------------------------------------------------------------------

const REWRITE_SCHEMA = {
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
};

/**
 * Does this follow-up lean on the conversation, or stand on its own?
 *
 * Measured on eval/followup.yaml: asked to rewrite a complete, unrelated
 * question ("how far is each county from the nearest airport") after an Ohio
 * question, gemma3:4b added Ohio to it, 3 runs of 3. A model told "keep the
 * place" cannot also be trusted to know when not to. So the decision is made
 * here, from the SHAPE of the message: a continuation cue, a word that points
 * back, or too few words to be a question alone. A complete question skips the
 * model entirely and runs as typed, which cannot leak anything into it.
 */
const CONTINUATION_START = /^(and|but|or|also|plus|then|now|same|instead|what\s+about|how\s+about|what\s+if|ok(ay)?\s+(and|now|what)|so)\b/i;
const POINTS_BACK = /\b(it|its|that|those|these|this|them|they|their|there|same|instead|also|too|either|both|ones?|else|other|another|again|previous|above|earlier)\b/i;
function isContinuation(text) {
  const t = String(text || "").trim();
  if (CONTINUATION_START.test(t) || POINTS_BACK.test(t)) return true;
  return t.split(/\s+/).filter(Boolean).length < 5;
}

// Words that carry no content of their own in a follow-up, so a rewrite may
// drop or rephrase them. Everything else the user typed must survive.
const FUNCTION_WORDS = new Set(`
  a an the and or but also plus then now so same instead what whats about how
  if is are was were be do does did it its that those these this them they
  their there here with for from of in on at to by as vs versus than rather
  me my show give tell list please just only too again else other another one
  ones any some can could would should will may might which who where when why
  across per each every all counties county data map rate rates number numbers
  compare compared comparing related relate relationship between okay ok
`.split(/\s+/).filter(Boolean));

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, fifty: 50, hundred: 100 };
const normWords = (s) => String(s).toLowerCase()
  .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|fifty|hundred)\b/g,
           (w) => String(NUMBER_WORDS[w]))
  .replace(/[^a-z0-9%$.\s-]/g, " ")
  .replace(/(^|\s)[.-]+|[.-]+(\s|$)/g, " ");

/**
 * Content words of the follow-up that the rewrite dropped.
 *
 * Measured: "Texas hospitals" after a poverty question was rewritten to "What
 * is the poverty rate by Texas county?", 3 of 3 -- the one word naming what the
 * user wanted was gone, and the answer would have been confident and about
 * something else. Plural and singular count as the same word, and number words
 * as their digits ("five miles" keeps "5").
 */
/** Crude, but enough to see "normalized" as "normalize" and "stations" as "station". */
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "").replace(/e$/, "");

function droppedWords(followUp, rewrite) {
  const have = new Set(normWords(rewrite).split(/\s+/).filter(Boolean).map(stem));
  return [...new Set(normWords(followUp).split(/\s+/).filter(Boolean))]
    .filter(w => (w.length >= 3 || /\d/.test(w)) && !FUNCTION_WORDS.has(w))
    .filter(w => !have.has(stem(w)));
}

/**
 * Words that say what to DO with a measure rather than name one. A follow-up
 * made only of these ("normalize by population", "per square mile", "top 10
 * over time") is about the measure already on screen.
 */
const OPERATION_WORDS = new Set(`
  normalize normalise normalized normalised population pop per capita person
  people resident residents rate percent percentage share density square mile
  miles rank ranked ranking top bottom highest lowest map mapped hot spot spots
  cluster clusters outlier outliers trend trends change changes over time year
  years adjust adjusted divide divided total totals average mean instead
  land area size
`.split(/\s+/).filter(Boolean));

/** Does the follow-up name something new to measure, or only an operation? */
function namesNewMeasure(followUp) {
  const places = new Set(statesMentioned(followUp).flatMap(n => n.toLowerCase().split(/\s+/)));
  return normWords(followUp).split(/\s+/).filter(Boolean)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w))
    .filter(w => !FUNCTION_WORDS.has(w) && !OPERATION_WORDS.has(w) && !places.has(w))
    .length > 0;
}

/** The attribute the plan's first output is ABOUT, walking back to a load. */
function primaryAttr(plan) {
  const steps = plan?.steps || [];
  const out = steps.find(st => mod(st)?.terminal);
  let st = out && steps.find(x => x.id === (out.inputs || [])[0]);
  const seen = new Set();
  while (st && !seen.has(st.id)) {
    seen.add(st.id);
    if (st.attr_id) return st.attr_id;
    st = steps.find(x => x.id === (st.inputs || [])[0]);
  }
  return null;
}

/** Significant words of a measure name, for checking a rewrite still names it. */
const measureWords = (label) => normWords(label).split(/\s+/)
  .filter(w => w.length >= 4 && !FUNCTION_WORDS.has(w) && !OPERATION_WORDS.has(w))
  .map(stem);

function rewritePrompt(history, text, area = null, measure = null) {
  const lines = history.slice(-3).map((h, i) => {
    const measures = (h.measures || []).filter(Boolean).slice(0, 4);
    return `${i + 1}. Question: "${String(h.query || "").slice(0, 300)}"\n` +
      (h.intent ? `   Answered with: ${String(h.intent).slice(0, 300)}\n` : "") +
      (measures.length ? `   Measures used: ${measures.map(m => String(m).slice(0, 100)).join("; ")}\n` : "");
  });
  // The examples deliberately use measures and places that appear nowhere in
  // eval/followup.yaml, so the suite is not scoring recall of its own answers.
  return `You rewrite a follow-up message into ONE standalone question about US county data.

Earlier in this conversation:
${lines.join("")}
${area ? `The answer on screen is restricted to: ${describeAreas(area).startsWith("the ") ? describeAreas(area).slice(4) : area.join(", ")}
` : ""}${measure ? `The measure on screen is: ${measure}\n` : ""}Follow-up message: "${String(text).slice(0, 500)}"

Rules:
- Replace words like "it", "that", "those", "same", "instead", "also", "this" with what they refer to in the conversation.
- If the follow-up does not name a new thing to measure, your question MUST name the measure on screen.
- Keep the place from the earlier question (state, city, region) unless the follow-up names a different place. A city stays together with its state.
- If a restriction is given above, keep it EXACTLY: write the region name, or list every state. Never shorten a list (no "and N more").
- When the follow-up gives a new number, year, distance or place, it REPLACES the earlier one. Never keep both.
- When the follow-up names a new thing to measure or count, it replaces the earlier one, unless the follow-up says "also", "as well", "too", "both" or "compare".
- Every word the user typed in the follow-up must still be in your question. Do not drop any of them.
- Do not add measures, places or conditions nobody asked for. Do not answer the question.
- Write one plain sentence.

Examples (different topics, same idea):
- Earlier: "libraries in Portland, Oregon". Follow-up: "and museums?" -> "museums in Portland, Oregon"
- Earlier: "median rent by county in 2018". Follow-up: "what about 2021?" -> "median rent by county in 2021"
- Earlier: "schools within 3 miles of a highway". Follow-up: "and within 1 mile?" -> "schools within 1 mile of a highway"
- Earlier: "smoking rates in Kentucky". Follow-up: "is that linked to lung cancer?" -> "is the smoking rate related to lung cancer in Kentucky counties?"
- Earlier: "median rent in Georgia". Follow-up: "Florida airports" -> "airports in Florida"

Return JSON: {"question": "..."}`;
}

/**
 * @param callLLM async (system, user, temperature, schema) -> string|null
 * @returns {Promise<{question: string, rewritten: boolean, standalone?: boolean, note?: string}>}
 */
async function rewriteFollowUp({ text, history, callLLM, area = null, measure = null }) {
  const original = String(text || "").trim();
  if (!Array.isArray(history) || !history.length) return { question: original, rewritten: false };
  // A complete question runs as typed; see isContinuation.
  if (!isContinuation(original)) return { question: original, rewritten: false, standalone: true };

  // What to run when the model's rewrite cannot be used. Running the bare text
  // is right when the follow-up names its own measure ("Texas hospitals"), and
  // wrong when it is only an operation: "normalize by population" as typed has
  // no measure and no area, which is the context the rewrite existed to carry.
  // Measured: the dropped-word guard discarded a rewrite that said "per capita"
  // for "normalize", and the fallback planned population by census tract.
  // So an operation-only follow-up falls back to the measure and area on
  // screen, composed in code.
  const where = area ? (describeAreas(area).startsWith("the ") ? describeAreas(area) : area.join(", ")) : null;
  const composed = measure && !namesNewMeasure(original)
    ? `${measure}: ${original}${where ? ` in ${where}` : ""}` : null;
  const fallback = (why, discarded = null) => (composed
    ? { question: composed, rewritten: true, discarded, note: `${why}; kept the measure and area on screen instead` }
    : { question: original, rewritten: false, discarded, note: `${why}; running it as typed` });

  let content = null;
  try {
    content = await callLLM(rewritePrompt(history, original, area, measure), null, 0, REWRITE_SCHEMA);
  } catch { content = null; }
  let question = null;
  try { question = content ? String(JSON.parse(content).question || "").trim() : null; } catch { question = null; }
  // A rewrite that is empty, or so long it has started answering, is worse
  // than none.
  if (!question || question.length > 400) return fallback("could not rewrite the follow-up");
  question = question.replace(/^["'\s]+|["'\s]+$/g, "");
  // "... and 14 more" hands the planner a list to guess. Measured once, on a
  // South-restricted follow-up: the guess was the wrong states.
  if (/\band\s+\d+\s+(more|others)\b/i.test(question)) {
    return fallback("the rewrite abbreviated the list of places", question);
  }
  // Losing a word the user typed is how a rewrite answers a different
  // question. That rewrite is discarded, and the thread says why.
  const dropped = droppedWords(original, question);
  if (dropped.length) return fallback(`the rewrite left out "${dropped.join('", "')}"`, question);
  // "normalize by population" on a South cancer result was rewritten to
  // "normalize Alabama, ... by population", which planned population alone.
  // When the follow-up names no new measure, the one on screen must survive.
  if (composed) {
    const want = measureWords(measure);
    const have = new Set(normWords(question).split(/\s+/).map(stem));
    if (want.length && !want.some(w => have.has(w))) {
      return fallback("the rewrite dropped the measure on screen", question);
    }
  }
  return { question, rewritten: question.toLowerCase() !== original.toLowerCase() };
}

module.exports = {
  FollowUpError, USER_PREFIX, MAX_USER_SERIES, MAX_USER_ROWS,
  isUserAttr, validateUserSeries, measureLabel, withUserSeries, userCandidate,
  applyEdit, availableFollowups, parseQuickEdit,
  rewriteFollowUp, rewritePrompt, REWRITE_SCHEMA, isContinuation, droppedWords,
  describeAreas, areaOf, primaryAttr, namesNewMeasure,
};
