/**
 * What to offer when a question cannot be answered.
 *
 * THE RULE HERE IS THAT EVERY SUGGESTION MUST ALREADY BE GROUNDED. Each one is
 * built from an attribute that retrieval actually returned AND that resolves to
 * a physical table, so following a suggestion cannot fail the same way the
 * original question just did. Asking the LLM to invent alternatives would be
 * easier and would reproduce this project's oldest failure -- confident output
 * with nothing behind it.
 *
 * That constraint is also why the phrasings below mirror the op-choice table in
 * planner/index.js. A suggestion is only useful if the planner recognizes the
 * shape it is written in.
 */

const { POSTAL_TO_NAME, STATE_FIPS } = require("./states");

const FIPS_TO_NAME = Object.fromEntries(Object.entries(STATE_FIPS).map(([n, f]) => [f, n]));
const POSTAL_FOR_NAME = Object.fromEntries(Object.entries(POSTAL_TO_NAME).map(([p, n]) => [n, p]));

/**
 * Turn a catalog description into something a person would type.
 *
 * ACS descriptions are pipe- or bang-delimited paths like
 *   "Estimate!!INCOME AND BENEFITS!!Total households!!Median income (dollars)"
 * of which only the tail is the actual measure.
 */
function descParts(desc) {
  return String(desc || "")
    .split(/\s*(?:\|\||!!|\||›)\s*/)
    .map(s => s.trim())
    .filter(Boolean)
    // Qualifiers present on every ACS row, not the subject of any question.
    .filter(s => !/^(estimate|percent estimate|pct_est|pmoe|moe|total)$/i.test(s));
}

/**
 * The measure itself, for putting inside a question.
 *
 * Tail only. An earlier version joined the last two path segments with an
 * em-dash, which reads fine as a label and terrible as a query -- "show
 * population 16 years and over, in labor force by county" is not a sentence
 * anyone would type, and it is the suggestion text that gets re-submitted.
 */
function shortLabel(desc) {
  const parts = descParts(desc);
  return parts.length ? parts[parts.length - 1] : null;
}

/** The fuller path, for explaining WHICH measure a suggestion refers to. */
function contextLabel(desc) {
  const parts = descParts(desc);
  if (parts.length < 2) return null;
  return parts.slice(-2).join(" › ");
}

const dedupe = (items, keyFn) => {
  const seen = new Set();
  return items.filter(i => {
    const k = keyFn(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/**
 * Concrete questions this stack can answer, drawn from what retrieval found.
 *
 * @param executable  candidates that resolved to a physical source
 * @param limit       how many to return
 */
function buildSuggestions(executable, limit = 5) {
  const out = [];

  // ONE suggestion per feature dataset, alternating the two shapes across
  // datasets. Emitting both shapes for each meant the first two feature slots
  // were two phrasings of the same layer -- "how many Ferrous Metal Mines" and
  // "where are the Ferrous Metal Mines" -- which shows the range of PHRASINGS
  // when the useful thing to show is the range of DATA.
  let featureIndex = 0;
  for (const c of executable || []) {
    if (c.is_feature_table) {
      const name = c.dataset_clean || "these locations";
      const asCount = featureIndex++ % 2 === 0;
      out.push(asCount
        ? {
          query: `how many ${name} are in each county`,
          why: `${name} is loaded as mapped locations, so it can be counted per county.`,
          kind: "feature",
        }
        : {
          query: `where are the ${name}`,
          why: `${name} can be shown as individual locations on the map.`,
          kind: "feature",
        });
    } else {
      const label = shortLabel(c.attr_desc);
      if (!label) continue;
      const context = contextLabel(c.attr_desc);
      out.push({
        query: `show ${label.toLowerCase()} by county`,
        why: context
          ? `Loaded as a county value (${context}).`
          : `Loaded as a county value.`,
        kind: "value",
      });
    }
  }

  // Interleave the two kinds, so the offer spans both what can be measured and
  // what can be mapped rather than five variations of one.
  const features = dedupe(out.filter(s => s.kind === "feature"), s => s.query);
  const values = dedupe(out.filter(s => s.kind === "value"), s => s.query);
  const mixed = [];
  for (let i = 0; mixed.length < limit && (i < features.length || i < values.length); i++) {
    if (i < values.length) mixed.push(values[i]);
    if (mixed.length < limit && i < features.length) mixed.push(features[i]);
  }
  return mixed.slice(0, limit);
}

/**
 * Datasets retrieval matched that have no physical table.
 *
 * These are catalog entries whose source data was never loaded -- 22 of them,
 * everything alphabetically after "Oil_and_Natural_Gas_Wells" in a truncated
 * source archive (see docs/RUNBOOK.md section 4). Without naming them, a
 * question about schools or roads fails with a generic "no data", and the user
 * has no way to tell an unsupported question from a missing file.
 */
function unavailableDatasets(candidates, resolved, limit = 5) {
  const names = [];
  for (const c of candidates || []) {
    if (resolved.get(c.attr_id)) continue;
    const name = c.dataset_clean;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.slice(0, limit);
}

/**
 * A city name with no state is ambiguous, and the result silently spans the
 * country. Measured: "fire stations in Springfield" returns 97 stations across
 * 25 states. This reports the spread so the UI can offer to narrow it, rather
 * than presenting a national scatter as if it were one city.
 */
function cityAmbiguity(plan, features) {
  const step = (plan?.steps || []).find(s => s.op === "select_features");
  if (!step?.city) return null;
  if (Array.isArray(step.states) && step.states.length) return null;

  const counts = new Map();
  for (const f of features || []) {
    const st = f?.properties?.state;
    if (st) counts.set(st, (counts.get(st) || 0) + 1);
  }
  if (counts.size < 2) return null;

  return {
    city: step.city,
    state_count: counts.size,
    states: [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      // The full name travels with the code: the planner's `states` field takes
      // names, so a "narrow to MO" follow-up needs "Missouri" to be answerable.
      .map(([state, count]) => ({
        state,
        state_name: POSTAL_TO_NAME[state] || null,
        count,
      })),
  };
}

/**
 * A NAMED PLACE with no state ("counties around Springfield") that matches
 * boundaries in several states. filter_place keeps counties inside ALL of them
 * and nothing errors, so the answer silently covers 22 Springfields.
 *
 * Same idea as cityAmbiguity, for the boundary table rather than a feature
 * layer's city column. The match rule is filter_place's own (exact, or the name
 * followed by a separator), so the candidates listed are exactly the places the
 * filter used. Which one was meant is the user's to say; the UI offers each.
 *
 * `query` is `(sql, params) => Promise<{rows}>`, so this stays testable without
 * a database.
 */
const PLACE_CANDIDATE_LIMIT = 12;
const PLACE_KINDS_NAMED = new Set(["place", "cbsa", "urban"]);

async function placeAmbiguity(plan, query) {
  const step = (plan?.steps || []).find(s => s.op === "filter_place"
    && PLACE_KINDS_NAMED.has(String(s.place_kind || "")) && s.place_name);
  if (!step) return null;
  if (Array.isArray(step.states) && step.states.length) return null;

  const { rows } = await query(
    `SELECT geoid, name, state_fp, aland FROM place_geom
      WHERE kind = $1
        AND (lower(name) = lower($2)
             OR lower(name) LIKE lower($2) || '-%'
             OR lower(name) LIKE lower($2) || ', %')
      ORDER BY aland DESC NULLS LAST`,
    [step.place_kind, String(step.place_name)]);

  // One candidate per state: the follow-up narrows by state, so two same-named
  // places in one state cannot be told apart by it and are not offered as two.
  const byState = new Map();
  for (const r of rows) {
    const name = FIPS_TO_NAME[r.state_fp];
    if (!name || byState.has(r.state_fp)) continue;
    byState.set(r.state_fp, {
      state: POSTAL_FOR_NAME[name] || null,
      state_name: name,
      full_name: r.name,
      land_sq_mi: r.aland != null ? Math.round(Number(r.aland) / 2589988.11) : null,
    });
  }
  if (byState.size < 2) return null;

  return {
    kind: "place",
    place_kind: step.place_kind,
    city: String(step.place_name),
    state_count: byState.size,
    // Largest first: the likeliest meaning leads.
    candidates: [...byState.values()].slice(0, PLACE_CANDIDATE_LIMIT),
  };
}

module.exports = {
  buildSuggestions, unavailableDatasets, cityAmbiguity, placeAmbiguity,
  shortLabel, contextLabel,
};
