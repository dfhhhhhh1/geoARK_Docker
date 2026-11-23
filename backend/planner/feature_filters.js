/**
 * Numeric and date filters on a feature layer's own columns
 * (docs/GIS_OPS_PLAN.md H6 tier 1, item 2): "hospitals with more than 100
 * beds", "power plants over 500 MW", "tornadoes since 2010", "wildfires in the
 * last 12 months", "tunnels built before 1950".
 *
 * DECIDED IN CODE, NOT BY THE MODEL. The comparison is read from the
 * question's words and the column is grounded against the columns the layer
 * actually has (discovered per table, `featureValueColumns` in
 * unified_search_server.js). Nothing is added to the prompt or the decoding
 * schema, so every prompt stays byte-identical, and the plan carries the
 * result as `value_filters` on the step that reads the layer. Same discipline
 * as distance units and raster classes (planner/features.js).
 *
 * WHAT IT REFUSES TO GUESS.
 *   - A comparison whose words name no column of the layer is left alone: it
 *     may be a filter on the units ("counties with more than 100,000 people"),
 *     which is filter_attr's.
 *   - A comparison that sits on the units ("counties with more than 1,000
 *     hospital beds") is a SUM per unit, not a per-feature filter: skipped when
 *     a unit word is nearer the comparison than the layer's own name.
 *   - Two columns that match equally ("intensity" is a tag on three tornado
 *     columns) are reported, not chosen between.
 *   - A date with several candidate event dates and nothing naming one is
 *     reported, not chosen.
 *
 * MISSING VALUES. HSIP writes "not available" as a single negative value in
 * an otherwise non-negative column: -999 for 307 hospitals' beds, 1,891
 * colleges' enrollment, 4,674 nursing homes' beds; -999999 for 15,127
 * transmission lines' voltage. A "fewer than 50 beds" filter would count every
 * unknown as a small hospital. Discovery records that value as the column's
 * `sentinel` and the compiled predicate excludes it.
 */

// ------------------------------------------------------------- parsing

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|thousand|million)\b)?`;
const PREFIX = [
  [">=", String.raw`at\s+least|no\s+(?:fewer|less)\s+than|a\s+minimum\s+of|>=|≥`],
  ["<=", String.raw`at\s+most|no\s+more\s+than|a\s+maximum\s+of|up\s+to|<=|≤`],
  [">", String.raw`more\s+than|greater\s+than|larger\s+than|bigger\s+than|higher\s+than|in\s+excess\s+of|exceeding|over|above|>`],
  ["<", String.raw`fewer\s+than|less\s+than|smaller\s+than|lower\s+than|under|below|<`],
];
const SUFFIX_GE = String.raw`(?:or|and)\s+(?:more|greater|higher|above|larger|bigger|over|up)\b|\+`;
const SUFFIX_LE = String.raw`(?:or|and)\s+(?:fewer|less|lower|below|under|smaller)\b`;

const WORD = String.raw`[A-Za-z][A-Za-z\-]*`;
// Words that never name a column: grammar, and the words of comparison.
const STOP = new Set(("a an the of with that which who whose have has had having are is was were be been " +
  "and or than more less fewer over under above below at least most no up to in on for by from " +
  "any all each every their its there where whose them they it this those these some only " +
  "greater larger bigger higher lower smaller exceeding excess minimum maximum per total").split(" "));

const toNumber = (digits, scale) => {
  const n = Number(String(digits).replace(/,/g, ""));
  const k = { k: 1e3, thousand: 1e3, million: 1e6 }[String(scale || "").toLowerCase()] || 1;
  return n * k;
};

// A distance belongs to within / count_near; a percentage to a unit's rate.
const DISTANCE_UNIT = /^(?:miles?|mi|km|kms|kilometers?|kilometres?|meters?|metres?|m|feet|foot|ft|yards?|yds?)$/i;
const PERCENT_AFTER = /^\s*(?:%|percent\b|pct\b|per\s*cent\b)/i;

function wordsAfter(text, at, n = 3) {
  const m = text.slice(at).match(new RegExp(String.raw`^\s*((?:${WORD}\s*){0,${n}})`));
  return (m ? m[1] : "").trim().split(/\s+/).filter(Boolean);
}
function wordsBefore(text, at, n = 2) {
  const words = text.slice(0, at).trim().split(/\s+/).filter(w => /^[A-Za-z][A-Za-z\-]*$/.test(w));
  return words.slice(-n);
}
/** Content words, stopped at the first word that starts a new clause. */
function nounWords(words, after = false) {
  const out = [];
  for (const raw of words) {
    const w = raw.toLowerCase();
    // After a number, a preposition ends the noun even before it starts:
    // "between 2019 and 2021 in Illinois counties" compares nothing named.
    if (/^(?:in|within|near|from|of|that|which|where|and|or|across|around|per)$/.test(w) && (out.length || after)) break;
    if (!STOP.has(w)) out.push(w);
  }
  return out;
}

/**
 * Every numeric comparison the question states:
 * [{operator, value, words, index, end}] ("between" gives two). `words` are
 * the content words that say WHAT is compared, after the number ("100 beds")
 * or, failing that, before the comparison ("magnitude of at least 4").
 */
function numericMentions(query) {
  const q = String(query || "");
  const out = [];
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const push = (m, operator, value, after, before, index, end) => {
    if (!Number.isFinite(value)) return;
    const tail = q.slice(end);
    if (PERCENT_AFTER.test(tail)) return;
    const post = nounWords(after, true);
    if (post.length && DISTANCE_UNIT.test(post[0])) return;
    const pre = nounWords(before);
    out.push({ operator, value, words: post.length ? post : pre, index, end, text: m });
    taken.push([index, end]);
  };

  // between N and M
  for (const m of q.matchAll(new RegExp(String.raw`\bbetween\s+${NUM}\s+(?:and|to)\s+${NUM}`, "gi"))) {
    const a = toNumber(m[1], m[2]), b = toNumber(m[3], m[4]);
    const end = m.index + m[0].length;
    const after = wordsAfter(q, end), before = wordsBefore(q, m.index);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (isYearPair(lo, hi, after)) continue;
    push(m[0], ">=", lo, after, before, m.index, end);
    out.length && (out[out.length - 1].pair = true);
    push(m[0], "<=", hi, after, before, m.index, end);
  }
  // prefix comparator
  for (const [operator, words] of PREFIX) {
    const re = new RegExp(String.raw`(?:^|[^A-Za-z])(${words})\s*${NUM}`, "gi");
    for (const m of q.matchAll(re)) {
      const index = m.index + m[0].indexOf(m[1]);
      const end = m.index + m[0].length;
      if (!free(index, end)) continue;
      // "under 1950" / "over 2010" are not how a date is said; "before" is.
      push(m[0], operator, toNumber(m[2], m[3]), wordsAfter(q, end), wordsBefore(q, index), index, end);
    }
  }
  // N or more / N or fewer / N+
  for (const [operator, suffix] of [[">=", SUFFIX_GE], ["<=", SUFFIX_LE]]) {
    const re = new RegExp(String.raw`(?:^|[^\d,.])${NUM}\s*(?:(${WORD}(?:\s+${WORD})?)\s+)?(?:${suffix})`, "gi");
    for (const m of q.matchAll(re)) {
      const index = m.index + (/^\d/.test(m[0]) ? 0 : 1);
      const end = m.index + m[0].length;
      if (!free(index, end)) continue;
      const between = m[3] ? m[3].split(/\s+/) : [];
      // "magnitude 4 or greater": the noun is before; "100 beds or more": between.
      // Never the words after the suffix: in "magnitude 3 or greater have
      // crossed Oklahoma" they start a new clause (H6 dev r2 compared nothing,
      // and counted every tornado since 2005).
      push(m[0], operator, toNumber(m[1], m[2]), between, wordsBefore(q, index), index, end);
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const isYear = (n) => Number.isInteger(n) && n >= 1800 && n <= 2100;
function isYearPair(a, b, after) {
  return isYear(a) && isYear(b) && !nounWords(after, true).length;
}

/**
 * Every date restriction the question states:
 * [{from?: {year|date}, to?: ..., words, index, label}] where `from` is
 * inclusive and `to` exclusive, both as ISO dates ("YYYY-MM-DD").
 * `today` is injectable so tests are not tied to the calendar.
 */
function dateMentions(query, today = new Date()) {
  const q = String(query || "");
  const out = [];
  const iso = (y, m = 1, d = 1) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const verb = (at) => nounWords(wordsBefore(q, at, 2)).filter(w => !/^(?:tornadoes|tornados)$/.test(w));
  const Y = String.raw`(1[89]\d\d|20\d\d|2100)`;
  const covered = [];
  const add = (m, from, to, label) => {
    const index = m.index;
    if (covered.some(([a, b]) => index < b && index + m[0].length > a)) return;
    covered.push([index, index + m[0].length]);
    out.push({ from, to, words: verb(index), index, end: index + m[0].length, label });
  };

  for (const m of q.matchAll(new RegExp(String.raw`\b(?:between|from)\s+${Y}\s+(?:and|to|through|until|-)\s+${Y}\b`, "gi"))) {
    const a = Number(m[1]), b = Number(m[2]);
    add(m, iso(Math.min(a, b)), iso(Math.max(a, b) + 1), `${Math.min(a, b)}-${Math.max(a, b)}`);
  }
  // "from 2020" alone is the year 2020 ("the perimeters from 2020"); it is
  // open-ended only as "from 2020 on / onward" (live dev r1 read it as
  // "since 2020", 2026-11-20).
  for (const m of q.matchAll(new RegExp(String.raw`\b(since|after|starting\s+in|beginning\s+in|from(?=\s+\d{4}\s+(?:on|onwards?|forward)\b))\s+${Y}\b(?!\s*(?:%|percent))`, "gi"))) {
    const y = Number(m[2]);
    const after = /^after$/i.test(m[1]);
    add(m, iso(after ? y + 1 : y), null, after ? `after ${y}` : `since ${y}`);
  }
  for (const m of q.matchAll(new RegExp(String.raw`\b(before|prior\s+to|earlier\s+than|until)\s+${Y}\b`, "gi"))) {
    const y = Number(m[2]);
    add(m, null, iso(/^until$/i.test(m[1]) ? y + 1 : y), `before ${/^until$/i.test(m[1]) ? y + 1 : y}`);
  }
  for (const m of q.matchAll(new RegExp(String.raw`\b(?:in|during|from)\s+(?:the\s+year\s+)?${Y}\b(?!\s*(?:-|to|through|and)\s*\d)`, "gi"))) {
    const y = Number(m[1]);
    add(m, iso(y), iso(y + 1), `in ${y}`);
  }
  for (const m of q.matchAll(new RegExp(String.raw`\b(?:in|over|during|within)\s+the\s+(?:last|past|previous|preceding)\s+(?:(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(years?|months?|weeks?|days?|decades?)\b`, "gi"))) {
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
    const n = m[1] ? (Number(m[1]) || words[m[1].toLowerCase()]) : 1;
    const unit = m[2].toLowerCase().replace(/s$/, "");
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (unit === "year") d.setUTCFullYear(d.getUTCFullYear() - n);
    else if (unit === "decade") d.setUTCFullYear(d.getUTCFullYear() - 10 * n);
    else if (unit === "month") d.setUTCMonth(d.getUTCMonth() - n);
    else if (unit === "week") d.setUTCDate(d.getUTCDate() - 7 * n);
    else d.setUTCDate(d.getUTCDate() - n);
    const from = d.toISOString().slice(0, 10);
    add(m, from, null, `since ${from} (the last ${n} ${unit}${n === 1 ? "" : "s"})`);
  }
  return out.sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------ grounding

const stem = (w) => String(w).toLowerCase().replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
const splitName = (s) => String(s || "").toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 2);

// A unit word the question used for a measure that the column stores under a
// different word. Units, not synonyms: the same standing as km -> miles.
const UNIT_WORDS = {
  kv: ["volt", "voltage"], kilovolt: ["volt", "voltage"], kilovolts: ["volt", "voltage"], volts: ["volt"],
  mw: ["mw", "capacity"], megawatt: ["mw", "capacity"], megawatts: ["mw", "capacity"],
  acre: ["acre", "acres"], acres: ["acre", "acres"],
};

/** Whether two words are the same word: equal stems, or one a prefix (>= 3) of the other. */
function sameWord(a, b) {
  const x = stem(a), y = stem(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 3 && l.startsWith(s);
}

/**
 * The column of `columns` the words name: by its NAME (3 points a word), its
 * catalog label or description (2), its tags (1). Words that name the layer
 * itself ("hospital", "tornado") are not evidence for any column. Returns
 * {column} or {ambiguous: [names]} or null.
 */
function groundColumn(words, columns, layerWords = [], kinds = ["number"]) {
  const ws = [];
  for (const w of words) {
    if (layerWords.some(l => sameWord(l, w))) continue;
    ws.push(...(UNIT_WORDS[w.toLowerCase()] || [w]));
  }
  if (!ws.length) return null;
  const scored = [];
  for (const c of columns || []) {
    if (!kinds.includes(c.kind)) continue;
    const name = splitName(c.column);
    const text = [...splitName(c.label), ...splitName(c.description)];
    const tags = (c.tags || []).flatMap(splitName);
    let score = 0;
    for (const w of new Set(ws)) {
      // A column name is an abbreviation of the asked word ("mag" of
      // "magnitude", "enroll" of "enrollment"), never the other way: "site"
      // is not the start of a column called "sitecloseo".
      // Or the asked word ends a concatenated name: "acres" in "gisacres".
      if (name.some(n => stem(n) === stem(w) || (n.length >= 3 && stem(w).startsWith(n)) ||
                         (w.length >= 4 && n.endsWith(w.toLowerCase())))) score += 3;
      else if (text.some(n => sameWord(n, w))) score += 2;
      else if (tags.some(n => sameWord(n, w))) score += 1;
    }
    if (score) scored.push({ c, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  // A tag alone is weak evidence (tags are generated, and "tornado intensity"
  // is a tag on mag, inj AND fat), so it decides only when it is the one
  // column any word reaches: "students" -> tot_enroll, tagged "student
  // population". Equal tag-only matches are ambiguous.
  if (scored[0].score < 2) {
    return scored.length === 1 ? { column: scored[0].c } : { ambiguous: scored.map(s => s.c.column) };
  }
  const top = scored.filter(s => s.score === scored[0].score);
  if (top.length > 1) {
    // Equal scores: the column whose name is entirely the asked word wins
    // ("beds" over "excess_bed"), else it is not ours to pick.
    const exact = top.filter(s => splitName(s.c.column).every(n => ws.some(w => sameWord(n, w))));
    if (exact.length === 1) return { column: exact[0].c };
    return { ambiguous: top.map(s => s.c.column) };
  }
  return { column: scored[0].c };
}

/**
 * The event-date column for a date restriction: one named by the words
 * before it ("built", "installed", "completed"), else the layer's only date
 * that is not the publisher's record keeping. A year column (`yr`, `year`,
 * `year_built`) counts as a date.
 */
function groundDate(words, columns, layerWords = []) {
  const dated = (columns || []).filter(c => c.kind === "date" || c.kind === "year");
  if (!dated.length) return null;
  const named = groundColumn(words, dated, layerWords, ["date", "year"]);
  if (named?.column) return named;
  const events = dated.filter(c => !c.record);
  if (events.length === 1) return { column: events[0] };
  if (events.length > 1) return { ambiguous: events.map(c => c.column) };
  return null;
}

// ------------------------------------------------------- applying to a plan

// Words that make a comparison about the UNITS a feature sits in.
const UNIT_NOUN = /^(?:count(?:y|ies)|tracts?|states?|zips?|zip\s*codes?|zctas?|neighbou?rhoods?|cities|city|towns?|places|areas?|regions?|blocks?|wards?|districts?|cells?)$/i;
// About people: a catchment or a unit's population, never a feature column.
const PEOPLE = /^(?:people|persons|residents|population|inhabitants|households)$/i;

// Ops that read one feature layer and take its filters (the registry's
// `acceptsAttributeFilters`, minus zonal, whose layer is a raster).
const FEATURE_FILTER_OPS = new Set(["select_features", "count_features"]);

/** Whether the nearest subject before `index` is the layer, not a unit. */
function aboutLayer(query, index, layerWords) {
  const words = String(query).slice(0, index).split(/[^A-Za-z]+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0 && i >= words.length - 12; i--) {
    const w = words[i];
    if (layerWords.some(l => sameWord(l, w))) return true;
    if (UNIT_NOUN.test(w)) return false;
  }
  return true;
}

const layerWordsOf = (name) => splitName(name).filter(w => w.length >= 3 && !STOP.has(w) &&
  !/^(?:mapped|locations?|facilities|facility|sites?|points?|data|public|national|historical|hist)$/.test(w));

/**
 * Attach `value_filters` to the steps that read a feature layer, from the
 * comparisons and dates the question states. `info(attr_id)` returns
 * {columns, name} for a feature layer (columns from featureValueColumns,
 * name the dataset's display name), or null. A filter_attr the model chained
 * onto a select_features to say the same thing is folded in: it compares the
 * step's `value`, which a selection does not have, and returns nothing.
 *
 * Returns {fixes: [...], notes: [...]} or null.
 */
function applyValueFilters(plan, query, info, today = new Date()) {
  const steps = plan.steps || [];
  const targets = steps.filter(s => FEATURE_FILTER_OPS.has(s.op) && s.attr_id && info(s.attr_id)?.columns?.length);
  if (!targets.length) return null;
  const numeric = numericMentions(query);
  const dates = dateMentions(query, today);
  if (!numeric.length && !dates.length) return null;

  const fixes = [], notes = [];
  const layerPos = (st) => {
    const words = layerWordsOf(info(st.attr_id).name);
    const re = /[A-Za-z]+/g; let m, at = -1;
    const pos = [];
    while ((m = re.exec(query))) if (words.some(w => sameWord(w, m[0]))) pos.push(m.index);
    return { words, pos, at };
  };
  const layers = targets.map(st => ({ st, ...layerPos(st) }));
  // The step a mention at `index` is about: the layer named last before it,
  // else the first feature step (the plan's subject).
  const ownerOf = (index) => {
    let best = null, bestAt = -1;
    for (const l of layers) {
      const before = l.pos.filter(p => p < index);
      const at = before.length ? before[before.length - 1] : -1;
      if (at > bestAt) { best = l; bestAt = at; }
    }
    return best || layers[0];
  };
  const add = (st, f) => {
    st.value_filters = st.value_filters || [];
    if (!st.value_filters.some(x => x.column === f.column && x.operator === f.operator && x.value === f.value)) {
      st.value_filters.push(f);
    }
  };

  // The question's own words for a comparison, recorded on the filter
  // (`said`): the named-data check reads it, so "more than 100 beds" counts
  // as covered by the layer the filter narrows (planner/named_data.js).
  const phraseOf = (q, m) => `${q.slice(m.index, m.end).trim()}${m.words.length ? " " + m.words.join(" ") : ""}`;
  const usedNumbers = [];
  for (const m of numeric) {
    if (m.words.some(w => PEOPLE.test(w)) || m.words.some(w => UNIT_NOUN.test(w))) continue;
    // Try the layer named before it first, then any other feature step.
    const owner = ownerOf(m.index);
    const order = [owner, ...layers.filter(l => l !== owner)];
    for (const l of order) {
      if (!aboutLayer(query, m.index, l.words)) continue;
      const g = groundColumn(m.words, info(l.st.attr_id).columns, l.words);
      if (!g) continue;
      if (g.ambiguous) {
        notes.push(`"${m.text.trim()}" could mean ${g.ambiguous.join(" or ")} of ${info(l.st.attr_id).name}; not applied`);
        break;
      }
      const c = g.column;
      add(l.st, { column: c.column, operator: m.operator, value: m.value, kind: c.kind === "year" ? "year" : "number",
        said: phraseOf(query, m) });
      usedNumbers.push(m.value);
      fixes.push(`${info(l.st.attr_id).name}: ${c.column} ${m.operator} ${m.value}` +
        (c.sentinel !== undefined && c.sentinel !== null ? ` (the ${c.sentinel} "not available" value excluded)` : ""));
      if (Number.isFinite(c.max) && ((m.operator[0] === ">" && m.value >= c.max) ||
                                     (m.operator[0] === "<" && Number.isFinite(c.min) && m.value <= c.min))) {
        notes.push(`${c.column} ranges ${c.min} to ${c.max} in ${info(l.st.attr_id).name}, so nothing passes ${m.operator} ${m.value}`);
      }
      break;
    }
  }

  for (const d of dates) {
    const owner = ownerOf(d.index);
    const order = [owner, ...layers.filter(l => l !== owner)];
    for (const l of order) {
      const g = groundDate(d.words, info(l.st.attr_id).columns, l.words);
      if (!g) continue;
      if (g.ambiguous) {
        notes.push(`"${d.label}" could be any of ${g.ambiguous.join(", ")} in ${info(l.st.attr_id).name}; not applied`);
        break;
      }
      const c = g.column;
      const year = (s) => Number(String(s).slice(0, 4));
      if (c.kind === "year") {
        // A year column holds whole years: a date bound rounds to its year
        // (from inclusive: the year it falls in; to exclusive: the same).
        if (d.from) add(l.st, { column: c.column, operator: ">=", value: year(d.from), kind: "year", said: d.label });
        if (d.to) add(l.st, { column: c.column, operator: "<", value: year(d.to), kind: "year", said: d.label });
      } else {
        if (d.from) add(l.st, { column: c.column, operator: ">=", value: d.from, kind: "date", said: d.label });
        if (d.to) add(l.st, { column: c.column, operator: "<", value: d.to, kind: "date", said: d.label });
      }
      fixes.push(`${info(l.st.attr_id).name}: ${c.column} ${d.label}`);
      if (c.max && d.from && String(c.max) < String(c.kind === "year" ? year(d.from) : d.from)) {
        notes.push(`${info(l.st.attr_id).name} records ${c.column} only through ${c.max}`);
      }
      for (const y of [d.from, d.to].filter(Boolean)) usedNumbers.push(year(y), year(y) - 1);
      break;
    }
  }

  // The model's own attempt at the same comparison: a filter_attr directly on
  // the step the value filter now narrows, with the number it carries. On a
  // selection it compares `value`, which a selection does not have (nothing
  // passes); on a count it compares the COUNT to the bed threshold
  // ("hospitals in Missouri with more than 100 beds" planned count_features
  // -> filter_attr > 100, H6 dev r1). Either way it restates the filter.
  const byId = new Map(steps.map(s => [s.id, s]));
  for (const st of [...steps]) {
    if (st.op !== "filter_attr" || st.percentile !== undefined || st.definition) continue;
    // The comparison may sit after an area filter ("Missouri tornadoes with
    // over 50 injuries": count_features -> filter_area -> filter_attr > 50,
    // 2026-11-22): the same restatement, read through the area steps that
    // only narrow which units are reported.
    let src = byId.get((st.inputs || [])[0]);
    while (src && ["filter_area", "filter_place"].includes(src.op) &&
           steps.filter(o => (o.inputs || []).includes(src.id)).length === 1) {
      src = byId.get((src.inputs || [])[0]);
    }
    if (!src || !FEATURE_FILTER_OPS.has(src.op) || !src.value_filters?.length) continue;
    const carried = src.value_filters.flatMap(f => f.kind === "date" ? [] : [Number(f.value)]);
    const ok = src.op === "select_features" ? usedNumbers.includes(Number(st.value)) : carried.includes(Number(st.value));
    if (!ok) continue;
    const through = (st.inputs || [])[0];
    for (const o of plan.steps) o.inputs = (o.inputs || []).map(i => (i === st.id ? through : i));
    plan.steps = plan.steps.filter(s => s !== st);
    fixes.push(`step ${st.id} (filter_attr ${st.operator} ${st.value} on ${src.op === "select_features" ? "the selection" : "the count"}) folded into ${src.id}`);
    // The model's plan counted UNITS that passed its filter ("counties with
    // fewer than 50 hospitals") with aggregate count. With the comparison now
    // on the features, that count would be the number of counties: Arizona's
    // 15 for 40 hospitals (H6 dev r4c). The total of features is the sum.
    if (src.op === "count_features") {
      const live = new Map(plan.steps.map(s => [s.id, s]));
      let cur = src;
      for (let i = 0; i < plan.steps.length; i++) {
        const next = plan.steps.find(s => (s.inputs || []).length === 1 && s.inputs[0] === cur.id);
        if (!next) break;
        if (next.op === "aggregate" && next.function === "count") {
          next.function = "sum";
          fixes.push(`step ${next.id} sums the counts instead of counting units`);
          break;
        }
        if (!["filter_area", "filter_place"].includes(next.op)) break;
        cur = live.get(next.id);
      }
    }
  }

  return fixes.length || notes.length ? { fixes, notes } : null;
}

/**
 * A `load` of one of a feature layer's COLUMNS, when the question states a
 * comparison on that very column, is the model saying "the features whose
 * <column> passes": "How many tornadoes of magnitude 3 or greater ..." loaded
 * the tornado layer's Mag row as a county series and filtered it >= 3, and
 * re-emitted that on all three attempts though the validator said to use
 * count_features (H6 dev r3, 2026-11-20). It becomes count_features on that
 * layer, and applyValueFilters then attaches the comparison and folds the
 * model's own filter_attr. A load of a feature column the question compares
 * nothing on is left to the validator: turning it into a count could make a
 * refusal into a confident wrong answer.
 *
 * `srcOf(attr_id)` returns the resolved row (source_kind, value_column,
 * value_columns). Returns a description, or null.
 */
function loadedColumnAsCount(plan, query, srcOf, layerName = () => "") {
  const mentions = numericMentions(query);
  if (!mentions.length) return null;
  const fixed = [];
  for (const st of plan.steps || []) {
    if (st.op !== "load" || !st.attr_id || (st.inputs || []).length) continue;
    const src = srcOf(st.attr_id);
    if (src?.source_kind !== "feature_table" || !src.value_column) continue;
    const col = (src.value_columns || []).find(c => c.column === String(src.value_column).toLowerCase());
    if (!col) continue;
    const words = layerWordsOf(layerName(st.attr_id));
    const asked = mentions.some(m => groundColumn(m.words, [col], words)?.column);
    if (!asked) continue;
    st.op = "count_features";
    for (const k of ["year", "period"]) delete st[k];
    fixed.push(`step ${st.id} counts ${layerName(st.attr_id) || st.attr_id} instead of loading its ${col.column} column`);
  }
  return fixed.length ? fixed.join("; ") : null;
}

module.exports = {
  loadedColumnAsCount,
  numericMentions, dateMentions, groundColumn, groundDate, applyValueFilters, sameWord,
  FEATURE_FILTER_OPS,
};
