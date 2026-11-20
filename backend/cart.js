/**
 * The data cart (docs/DATA_CART_PLAN.md, slice 1: Phases 1, 3 and 4).
 *
 * Two jobs, both pure so they can be tested without a database:
 *
 *   buildShelf    a unified search -> the candidate pool, one row per measure or
 *                 layer, grouped by role, each row saying WHY it is there
 *                 (named in the question, linked in the literature, a PubMed
 *                 keyword). No LLM: the curator is Phase 2 and has to beat
 *                 this list's own top rows before it becomes the default.
 *   cartPlan      cart items -> one plan with an independent branch per item,
 *                 so the checkout runs through validatePlan and the ordinary
 *                 compiler in one READ ONLY transaction. No second SQL path.
 *   wideTable     the executed layers -> one row per county, one column per
 *                 item, LEFT-joined onto the full county list.
 *
 * WHY A LEFT JOIN: an inner join of items deletes every county one item lacks.
 * S0102 covers 1,524 counties; a cart holding it would silently lose half the
 * country, the same failure the ON-vs-WHERE fix in count_features prevents.
 * Missing stays empty and is counted per column.
 *
 * The old cart was removed because its checkout called an endpoint that never
 * existed (Header.tsx). The checkout here is the endpoint, with tests.
 */

const MAX_ITEMS = 20;
const SHELF_SIZE = 40;

// Roles, by the sub-query purpose a row came from. "related" sub-queries are
// paraphrases of the question ("coronary heart disease prevalence"), so they
// describe the subject; "expanded" ones are the literature and PubMed links.
const ROLE_OF = {
  primary: "subject", related: "subject", normalization: "denominator",
  filter: "context", expanded: "linked",
};
const ROLE_ORDER = ["subject", "linked", "denominator", "context"];

// A layer matched only through a column that records WHERE a feature is, or an
// identifier, is noise: PubMed's keywords pulled in "state", "county",
// "latitude" and "x" on 2026-11-20. The analyze path's LOCATION_COLUMN covers
// the location names; this adds the bare identifiers it does not.
const IDENTIFIER = /^(?:x|y|lat|lon|lng|objectid|object\s*id|fid|id|gid|geoid|globalid|shape(?:_\w+)?|name|state_?id|statefp|countyfp)$/i;

// The catalog's "(covers 2,957 counties)" note: coverage is its own field.
const COVERS_NOTE = /\s*\(covers [\d,]+ \w+\)/gi;

/** The label shown: the catalog note removed. */
function displayLabel(label) {
  return String(label || "").replace(COVERS_NOTE, "").replace(/\s+/g, " ").trim();
}

/** The grouping key: the display label without its variant in parentheses. */
function baseLabel(label) {
  return displayLabel(label).replace(/\s*\((?:crude|age-adjusted)[^)]*\)\s*$/i, "").toLowerCase();
}

/**
 * Why a row is on the shelf, from the sub-query that produced it.
 * `record` is results_by_query[i]: {query, purpose, expansion?, research?}.
 */
function whyOf(record) {
  if (record.expansion) {
    const e = record.expansion;
    const papers = e.support ? `, ${e.support} papers` : "";
    return { kind: "literature", text: `${e.seed ? `${e.seed} → ` : ""}${e.name}${papers} (SemMedDB)` };
  }
  if (record.research) {
    const r = record.research;
    return { kind: r.source === "web" ? "web" : "pubmed",
             text: `keyword "${r.keyword}" read from ${r.source === "web" ? "web pages" : "PubMed abstracts"}` };
  }
  return { kind: "question", text: `matched "${record.query}"` };
}

/**
 * The candidate pool.
 *
 * @param search   unifiedSearch()'s return
 * @param resolved Map<attr_id, attribute_source row> (only resolvable rows)
 * @param opts.label(row) display label for a catalog row
 * @param opts.isLocationColumn(desc) the analyze path's LOCATION_COLUMN test
 */
function buildShelf(search, resolved, { label, isLocationColumn = () => false } = {}) {
  // Every sub-query that returned a row, in the order retrieval ranked them.
  const reasons = new Map();       // attr_id -> [why]
  const purposeOf = new Map();     // attr_id -> best (earliest) purpose
  for (const rq of search.results_by_query || []) {
    for (const r of rq.results || []) {
      if (!reasons.has(r.attr_id)) reasons.set(r.attr_id, []);
      const w = whyOf(rq);
      if (!reasons.get(r.attr_id).some(x => x.text === w.text)) reasons.get(r.attr_id).push(w);
      if (!purposeOf.has(r.attr_id)) purposeOf.set(r.attr_id, rq.purpose);
    }
  }

  const items = [];
  const seenLayer = new Set();
  const dropped = { no_data: 0, location_or_id: 0, duplicate_layer_column: 0 };
  for (const r of search.all_results || []) {
    const src = resolved.get(r.attr_id);
    if (!src) { dropped.no_data++; continue; }
    const kind = src.source_kind === "feature_table" ? "feature"
      : src.source_kind === "raster" ? "raster" : "value";
    const column = String(r.attr_orig || r.attr_desc || "").trim();
    if (kind === "feature") {
      // A layer is one item, whichever of its columns matched.
      if (isLocationColumn(column) || IDENTIFIER.test(column)) { dropped.location_or_id++; continue; }
      if (seenLayer.has(src.table_name)) { dropped.duplicate_layer_column++; continue; }
      seenLayer.add(src.table_name);
    } else if (IDENTIFIER.test(column) || isLocationColumn(column)) {
      dropped.location_or_id++; continue;
    }
    const purpose = r.search_purpose || purposeOf.get(r.attr_id) || "related";
    items.push({
      id: r.attr_id,
      label: kind === "feature" ? (r.dataset_clean || src.table_name) : displayLabel(label(r)),
      description: r.attr_desc || src.description || null,
      dataset: r.dataset_clean || null,
      kind,
      role: ROLE_OF[purpose] || "context",
      why: reasons.get(r.attr_id) || [],
      score: Number(r.hybrid_score ?? r.semantic_score ?? 0),
      // Counties with a value in the measure's latest year (series_stats,
      // attached by resolveAttributes); null for layers.
      coverage: src.value_range?.n ?? null,
      period: r.end_date || r.start_date || null,
      // Rasters are summarised per unit by `zonal`, which needs a choice of
      // statistic; slice 1 does not offer that at checkout.
      checkout: kind === "raster" ? "map only (raster)" : null,
    });
    if (items.length >= SHELF_SIZE) break;
  }

  // Variants of one measure (crude vs age-adjusted, the same label from two
  // sources) are grouped under the best-ranked one, not hidden: which variant
  // is right depends on the analysis.
  const byBase = new Map();
  const shelf = [];
  for (const it of items) {
    const key = it.kind === "value" ? baseLabel(it.label) : `layer:${it.id}`;
    const head = byBase.get(key);
    if (head) { head.variants.push(it); continue; }
    const row = { ...it, variants: [] };
    byBase.set(key, row);
    shelf.push(row);
  }
  shelf.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  return { items: shelf, dropped };
}

/**
 * The default cart with no LLM: the best subject row, then the best row of
 * each linked concept, then the best denominator. Phase 2's curator has to
 * beat exactly this.
 */
function defaultCart(shelf, { max = 8 } = {}) {
  const pick = [];
  const seenWhy = new Set();
  const usable = shelf.filter(it => !it.checkout);
  const subject = usable.find(it => it.role === "subject");
  if (subject) pick.push(subject.id);
  for (const it of usable.filter(x => x.role === "linked")) {
    const key = it.why.map(w => w.text).join("|");
    if (seenWhy.has(key)) continue;
    seenWhy.add(key);
    pick.push(it.id);
    if (pick.length >= max - 1) break;
  }
  // A denominator is a value series (a population): a layer that retrieval
  // matched to "population" (Child Care Centers did, 2026-11-20) is not one.
  const denom = usable.find(it => it.role === "denominator" && it.kind === "value");
  if (denom && pick.length < max) pick.push(denom.id);
  return pick;
}

class CartError extends Error {}

/**
 * Items -> one plan, one independent branch per item.
 * @param items [{id, kind: "value"|"feature"}]
 * @param states optional state names (filter_area)
 */
function cartPlan(items, { states = null } = {}) {
  if (!Array.isArray(items) || !items.length) throw new CartError("the cart is empty");
  if (items.length > MAX_ITEMS) throw new CartError(`a cart holds at most ${MAX_ITEMS} items`);
  const steps = [];
  const outputs = [];          // output step id -> item id, in item order
  let n = 0;
  const id = (p) => `${p}${++n}`;
  for (const it of items) {
    if (it.kind === "raster") throw new CartError(`"${it.id}" is a raster; map it in Explore instead`);
    let last;
    if (it.kind === "feature") {
      last = id("c");
      steps.push({ id: last, op: "count_features", attr_id: it.id, inputs: [] });
    } else {
      last = id("l");
      steps.push({ id: last, op: "load", attr_id: it.id, inputs: [] });
    }
    if (states?.length) {
      const f = id("a");
      steps.push({ id: f, op: "filter_area", attr_id: "", inputs: [last], states: [...states] });
      last = f;
    }
    const o = id("o");
    steps.push({ id: o, op: "output", attr_id: "", inputs: [last] });
    outputs.push({ step: o, item: it.id });
  }
  return {
    plan: { intent: "Data cart", output_type: "table", entity_type: "COUNTY", steps },
    outputs,
  };
}

/**
 * Executed layers -> one row per county.
 * @param counties [{fips, name}] every county, the LEFT side
 * @param columns  [{item, step, header}] in cart order
 * @param layers   executePlan().layers ({step, rows:[{fips, value}]})
 */
function wideTable(counties, columns, layers, { states = null, stateNames = new Map() } = {}) {
  const byStep = new Map(layers.map(l => [l.id, l]));   // id = the output step
  const values = columns.map(c => {
    const l = byStep.get(c.step);
    return new Map((l?.rows || []).map(r => [String(r.fips), r.value]));
  });
  const keep = states?.length ? new Set(states.map(s => String(s).toLowerCase())) : null;
  const rows = [];
  for (const c of counties) {
    const fips = String(c.fips);
    const st = stateNames.get(fips.slice(0, 2)) || null;
    if (keep && !(st && keep.has(st.toLowerCase()))) continue;
    rows.push({ fips, name: c.name, state: st, values: values.map(m => (m.has(fips) ? m.get(fips) : null)) });
  }
  const missing = columns.map((_, i) => rows.filter(r => r.values[i] === null || r.values[i] === undefined).length);
  return { rows, missing };
}

/**
 * The interpretable companion to a cart model: each feature's partial Spearman
 * with the target, the other features held fixed, through the explain op's own
 * compute(). Features that are the same measure as an earlier one (|rho| >=
 * 0.97 on shared counties, e.g. two sources of one PM2.5 estimate) are set
 * aside first and reported as such: left in, they make the controls singular
 * and no feature gets a number at all (measured on the first live run).
 *
 * @param rows     [{fips, y, x: [feature values]}]
 * @param names    feature display names, x order
 * @param neighbors Map<fips, fips[]>
 */
function partialCompanion(rows, names, neighbors) {
  const S = require("./planner/stats");
  const explainOp = require("./planner/ops/explain");
  const SAME = 0.97;
  const sameAs = new Array(names.length).fill(null);
  for (let j = 0; j < names.length; j++) {
    for (let i = 0; i < j && sameAs[j] === null; i++) {
      if (sameAs[i] !== null) continue;
      const both = rows.filter(r => r.x[i] !== null && r.x[j] !== null);
      if (both.length < 10) continue;
      const rho = S.pearson(S.rank(both.map(r => r.x[i])), S.rank(both.map(r => r.x[j])));
      if (Math.abs(rho) >= SAME) sameAs[j] = i;
    }
  }
  const kept = names.map((n, i) => i).filter(i => sameAs[i] === null);
  const wide = rows.map(r => {
    const o = { fips: r.fips, y: r.y };
    kept.forEach((i, k) => { o[`v${k}`] = r.x[i]; });
    return o;
  });
  return names.map((name, i) => {
    if (sameAs[i] !== null) {
      return { feature: name, status: "same_measure_as_another_column", same_as: names[sameAs[i]],
               rho: null, partial_rho: null, ci_low: null, ci_high: null, n: null, n_effective: null };
    }
    const k = kept.indexOf(i);
    const factors = kept.map((ci, j) => ({ attr_id: `f${ci}`, description: names[ci],
                                            role: j === k ? "factor" : "control" }));
    const rec = explainOp.compute(wide, { factors, neighbors }).factors.find(f => f.attr_id === `f${i}`) || {};
    return {
      feature: name, status: rec.status ?? "not_fitted", same_as: rec.same_as ?? null,
      rho: rec.rho ?? null, partial_rho: rec.partial_rho ?? null,
      ci_low: rec.ci_low ?? null, ci_high: rec.ci_high ?? null,
      n: rec.n ?? null, n_effective: rec.n_effective ?? null,
    };
  });
}

module.exports = { buildShelf, defaultCart, cartPlan, wideTable, partialCompanion, baseLabel, displayLabel,
                   whyOf, CartError, MAX_ITEMS, IDENTIFIER };
