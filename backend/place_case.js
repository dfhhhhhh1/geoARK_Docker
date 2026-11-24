/**
 * "elderly population in columbus" -> "elderly population in Columbus".
 *
 * Place detection is by SHAPE: a capitalised phrase after in / around / near
 * (states.js LOCATIVE_PHRASE). Typed in lowercase, a city is invisible to it, so
 * filter_place is never offered and the named-data check reads "columbus" as a
 * dataset nobody loaded: `the loaded data does not include "columbus"`, for a
 * question as simple as they come (2026-11-23, both "columbus" and
 * "springfield").
 *
 * Loosening the regex would make "in poverty" a place. So the lowercase phrase
 * is checked against place_geom itself, by the same name rule filter_place uses,
 * and only a phrase that IS a named boundary is capitalised. Everything
 * downstream then sees the question it already handles, and nothing about the
 * planner prompt changes.
 *
 * Cost of a wrong guess, e.g. "in poverty" matching a tiny town of that name: the
 * word is capitalised, one extra op is offered, and the planner still decides
 * whether to use it.
 */

const { STATE_FIPS } = require("./states");

const LEAD = /\b(in|across|within|throughout|around|near|for)\s+(?:the\s+)?/g;
const WORD = "[a-z][a-z.'-]*";
const NOT_PLACE_START = new Set(["each", "every", "all", "most", "least", "a", "an", "any", "both", "which"]);
const STATES_LOWER = new Map(Object.keys(STATE_FIPS).map(n => [n.toLowerCase(), n]));

const title = (s) => s.replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Lowercase phrases after a locative word: [{start, end, words}] (longest first). */
function lowercaseCandidates(text) {
  const out = [];
  for (const m of text.matchAll(LEAD)) {
    const start = m.index + m[0].length;
    const run = new RegExp(`^${WORD}(?:\\s+${WORD}){0,3}`).exec(text.slice(start));
    if (!run) continue;
    const words = run[0].split(/\s+/);
    if (NOT_PLACE_START.has(words[0])) continue;
    out.push({ start, words });
  }
  return out;
}

/**
 * @param query  the question as typed
 * @param sql    (text, params) => Promise<{rows}>
 * @returns {Promise<{query: string, changed: string[]}>}
 */
async function capitalizePlaces(query, sql) {
  const text = String(query || "");
  const cands = lowercaseCandidates(text);
  if (!cands.length) return { query: text, changed: [] };

  // Every prefix of every phrase, so "columbus ohio" can match "Columbus" and
  // "salt lake city" matches whole.
  const names = new Set();
  for (const c of cands) {
    for (let n = 1; n <= c.words.length; n++) names.add(c.words.slice(0, n).join(" "));
  }
  const { rows } = await sql(
    `SELECT DISTINCT lower(name) AS n FROM place_geom
      WHERE kind IN ('place','cbsa','urban') AND lower(name) = ANY($1)`,
    [[...names]]);
  const hits = new Set(rows.map(r => r.n));
  // A metro is stored compound ("Chicago-Naperville-Elgin, IL-IN"): match the
  // leading name as filter_place does.
  const { rows: compound } = await sql(
    `SELECT DISTINCT lower(split_part(split_part(name, ',', 1), '-', 1)) AS n FROM place_geom
      WHERE kind IN ('cbsa','urban') AND lower(split_part(split_part(name, ',', 1), '-', 1)) = ANY($1)`,
    [[...names]]);
  for (const r of compound) hits.add(r.n);

  // Rewrite right to left so earlier offsets stay valid.
  let result = text;
  const changed = [];
  for (const c of [...cands].sort((a, b) => b.start - a.start)) {
    let take = 0;
    for (let n = c.words.length; n >= 1; n--) {
      if (hits.has(c.words.slice(0, n).join(" "))) { take = n; break; }
    }
    if (!take) continue;
    const phrase = c.words.slice(0, take).join(" ");
    let end = c.start + phrase.length;
    let replacement = title(phrase);
    // "columbus, ohio": the state after it is a place too.
    const after = /^(\s*,?\s*)([a-z]+(?: [a-z]+)?)\b/.exec(result.slice(end));
    if (after) {
      const st = [after[2], after[2].split(" ")[0]].find(s => STATES_LOWER.has(s));
      if (st) {
        replacement += after[1] + STATES_LOWER.get(st);
        end += after[1].length + st.length;
      }
    }
    result = result.slice(0, c.start) + replacement + result.slice(end);
    changed.push(replacement);
  }
  return { query: result, changed: changed.reverse() };
}

module.exports = { capitalizePlaces, lowercaseCandidates };
