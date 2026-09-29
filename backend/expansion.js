// =============================================================================
// Literature-based query expansion (SemMedDB)
// =============================================================================
//
// Tags and embeddings find attributes DESCRIBED like the question. They cannot
// find attributes that are RELATED to it: "diabetes in the South" retrieves
// diabetes columns and never the obesity or physical-inactivity measures the
// literature links it to, although both are loaded.
//
// This links condition mentions in the question to UMLS concepts, looks up the
// concepts PubMed says cause, predispose to or are associated with them
// (semmed_relation, built once by etl/build_semmed_index.py), and searches the
// catalog for each. Results come back under their own purpose, "expanded", so
// they never displace what the decomposer asked for.
//
// Three rules keep it from adding noise:
//
//  1. It only fires on a CONDITION. Seeds are diseases, injuries and health
//     behaviors; "median income" or "poverty rate" link to nothing, so for
//     every question that is not about health nothing changes at all.
//  2. A related concept must be REACHABLE in the catalog. SemMedDB's top
//     neighbors of asthma include "Inflammation" and "Pathogenesis", which no
//     county dataset measures, and the hybrid search will still return its
//     least-bad 20 rows for them. A concept is kept only if its best catalog
//     match clears EXPAND_MIN_SIM and brings at least one attribute that was
//     not already retrieved.
//  3. It is per-request overridable ({"expand": false}), so it can be A/B'd
//     without recreating the container -- the stale-container trap in
//     CLAUDE.md has already faked one "no difference" result. On by default
//     since 2026-09-29 (EXPAND_ENABLED=1); without `make semmed` it is a no-op.
//
// The prototype this came from (searchImprovement/) also fetched PubMed
// abstracts over the network. That is deliberately not on the query path: it
// sends the question off the machine, and paper text is not something the
// retrieval step can use.

const CONFIG = {
  enabled: /^(1|true|yes)$/i.test(process.env.EXPAND_ENABLED ?? "1"),
  maxSeeds: Number(process.env.EXPAND_MAX_SEEDS ?? 2),
  // Neighbors fetched from SemMedDB; more than are kept, because the catalog
  // gate below rejects many.
  maxCandidates: Number(process.env.EXPAND_MAX_CANDIDATES ?? 15),
  maxTerms: Number(process.env.EXPAND_MAX_TERMS ?? 4),
  resultsPerTerm: Number(process.env.EXPAND_RESULTS_PER_TERM ?? 3),
  minSupport: Number(process.env.EXPAND_MIN_SUPPORT ?? 5),
  // Set from data (docs/EXPANSION.md). A SemMedDB concept name scores
  // 0.61-0.68 against catalog rows that measure it (Obesity 0.658, Smoking
  // 0.622) and 0.43-0.60 against rows that do not. The first guess, 0.72,
  // rejected everything. Applied to every row added, not only the best.
  minSim: Number(process.env.EXPAND_MIN_SIM ?? 0.61),
  // Semantic types that are legitimate seeds but never useful as a related
  // concept: "Inflammation"/"Pathogenesis" (patf) and "sex"/"Gender" (orga)
  // are among the top neighbors of every disease and match nothing but noise.
  excludeNeighborTypes: list(process.env.EXPAND_EXCLUDE_TYPES ?? "patf,orga"),
  // Seed rules, each from a false positive on eval/plan_correctness.yaml,
  // questions that have nothing to do with health:
  //
  //  - patf seeds are processes ("disease transmission", "Disability NOS").
  //    "hospitals within 10 miles of electric power transmission lines" linked
  //    "transmission" and pulled in COVID-19.
  //  - inbe (behavior) synonyms are broad: "educational attainment" is a real
  //    UMLS alias of "Academic achievement", which then pulled in Smoking. For
  //    these types only the concept's own name links ("smoking", "alcohol
  //    consumption"), never a UMLS synonym.
  //  - A linked concept must MEAN the mention. "hot spots" is a UMLS alias of
  //    Pyotraumatic dermatitis, a dog skin condition: embedding similarity
  //    0.479, against 0.738+ for every correct link measured
  //    (colorectal cancer -> Carcinoma of the Large Intestine 0.739).
  excludeSeedTypes: list(process.env.EXPAND_EXCLUDE_SEED_TYPES ?? "patf"),
  strictSeedTypes: list(process.env.EXPAND_STRICT_SEED_TYPES ?? "inbe"),
  minLinkSim: Number(process.env.EXPAND_MIN_LINK_SIM ?? 0.6),
};

function list(s) {
  return String(s).split(",").map(x => x.trim()).filter(Boolean);
}

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y || 1);
}

function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Every 1..maxWords-word span of a text, longest first. */
function spans(text, maxWords = 5) {
  const words = normalize(text).split(" ").filter(Boolean);
  const out = [];
  for (let n = Math.min(maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      out.push({ text: words.slice(i, i + n).join(" "), start: i, end: i + n });
    }
  }
  return out;
}

// Whether the tables exist and are populated. A positive answer is cached for
// a minute; a negative one for 10s, because the first A/B after `make semmed`
// silently ran unexpanded on a cached "not loaded" from before the build.
let loadedCache = { at: 0, value: false, meta: null };
async function indexLoaded(pool) {
  const ttl = loadedCache.value ? 60000 : 10000;
  if (Date.now() - loadedCache.at < ttl) return loadedCache;
  try {
    const { rows } = await pool.query(
      "SELECT key, value FROM semmed_meta WHERE EXISTS (SELECT 1 FROM semmed_alias LIMIT 1)");
    const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
    loadedCache = { at: Date.now(), value: rows.length > 0, meta: rows.length ? meta : null };
  } catch {
    loadedCache = { at: Date.now(), value: false, meta: null };   // tables absent
  }
  return loadedCache;
}

/**
 * Link condition mentions to seed concepts.
 *
 * Longest span first and non-overlapping, per text: "coronary heart disease"
 * links once, as itself, rather than also as "heart disease". An ambiguous
 * alias resolves to the sense with the most relations, which is almost always
 * the clinical one.
 */
async function linkSeeds(pool, texts, embed = null, rejected = []) {
  const perText = texts.map(t => spans(t));
  const all = [...new Set(perText.flat().map(s => s.text))].filter(s => s.length >= 4);
  if (!all.length) return [];

  const { rows } = await pool.query(`
    SELECT DISTINCT ON (a.alias_norm) a.alias_norm, a.source, c.cui, c.name, c.semtype, c.n_rel
    FROM semmed_alias a JOIN semmed_concept c USING (cui)
    WHERE a.alias_norm = ANY($1)
      AND c.semtype <> ALL($2)
      AND NOT (c.semtype = ANY($3) AND a.source <> 'semmed')
    ORDER BY a.alias_norm, c.n_rel DESC`,
    [all, CONFIG.excludeSeedTypes, CONFIG.strictSeedTypes]);
  const byAlias = new Map(rows.map(r => [r.alias_norm, r]));

  const seeds = new Map();
  for (const list of perText) {
    const used = new Set();
    for (const s of list) {
      const hit = byAlias.get(s.text);
      if (!hit) continue;
      let overlaps = false;
      for (let i = s.start; i < s.end; i++) if (used.has(i)) overlaps = true;
      if (overlaps) continue;
      for (let i = s.start; i < s.end; i++) used.add(i);
      if (!seeds.has(hit.cui)) seeds.set(hit.cui, { ...hit, mention: s.text });
    }
  }
  let linked = [...seeds.values()];

  // Does the concept mean what the question said? Only checked when the alias
  // differs from the concept's name; "asthma" -> Asthma needs no embedding.
  const toCheck = linked.filter(s => normalize(s.name) !== s.mention);
  if (embed && toCheck.length) {
    const vecs = await embed(toCheck.flatMap(s => [s.mention, s.name]));
    toCheck.forEach((s, i) => {
      s.link_similarity = Math.round(cosine(vecs[2 * i], vecs[2 * i + 1]) * 1000) / 1000;
    });
    linked = linked.filter(s => {
      if (s.link_similarity === undefined || s.link_similarity >= CONFIG.minLinkSim) return true;
      rejected.push({ mention: s.mention, name: s.name, cui: s.cui, link_similarity: s.link_similarity });
      return false;
    });
  }
  return linked.slice(0, CONFIG.maxSeeds);
}

/**
 * Concepts linked to any seed by a causal predicate, strongest evidence first.
 *
 * `causesFirst` orders by papers in which the concept LEADS TO the seed. For a
 * "what explains X" question, total support is the wrong order: for obesity it
 * is dominated by consequences (coronary heart disease 1,373 papers as an
 * effect vs 107 as a cause), which filled every slot and left the explain
 * table with no drivers at all.
 */
async function relatedConcepts(pool, seedCuis, causesFirst = false) {
  const { rows } = await pool.query(`
    WITH e AS (
      SELECT obj_cui AS cui, obj_name AS name, obj_type AS semtype, predicate,
             n_pmids, subj_cui AS seed, 'effect' AS role
      FROM semmed_relation WHERE subj_cui = ANY($1)
      UNION ALL
      SELECT subj_cui, subj_name, subj_type, predicate,
             n_pmids, obj_cui, 'cause'
      FROM semmed_relation WHERE obj_cui = ANY($1)
    )
    SELECT cui, min(name) AS name, min(semtype) AS semtype,
           sum(n_pmids)::int AS support,
           array_agg(DISTINCT predicate) AS predicates,
           array_agg(DISTINCT role) AS roles,
           -- Papers per DIRECTION. A set of roles hides the split that matters:
           -- obesity -> diabetes in 743 papers vs 227 the other way, but
           -- cardiovascular disease -> diabetes in only 153 vs 733. Both read
           -- roles=[cause, effect]; one is a driver, the other a consequence.
           (sum(n_pmids) FILTER (WHERE role = 'cause'))::int AS papers_as_cause,
           (sum(n_pmids) FILTER (WHERE role = 'effect'))::int AS papers_as_effect,
           min(seed) AS seed
    FROM e
    WHERE cui <> ALL($1) AND semtype <> ALL($2)
    GROUP BY cui
    HAVING sum(n_pmids) >= $3
    ORDER BY ${causesFirst ? "coalesce(sum(n_pmids) FILTER (WHERE role = 'cause'), 0) DESC," : ""}
             support DESC
    LIMIT $4`,
    [seedCuis, CONFIG.excludeNeighborTypes, CONFIG.minSupport, CONFIG.maxCandidates]);
  return rows;
}

/**
 * Expand a decomposed query.
 *
 * `search(term, k, purpose)` is performHybridSearch. `alreadyRetrieved` is the
 * set of attr_ids the decomposed search found, so a concept that only re-finds
 * those is not counted as an expansion.
 *
 * Never throws: expansion is an enhancement, and a missing index or a DB error
 * must degrade to the unexpanded search, not fail the request.
 */
async function expandQuery({ pool, query, decomposition, search, embed = null,
                             alreadyRetrieved = new Set(), log = () => {},
                             // True for "what explains X" questions: rank
                             // concepts by how often they are X's CAUSE.
                             causesFirst = false }) {
  const out = { enabled: true, seeds: [], rejected_seeds: [], concepts: [], results_by_query: [] };
  try {
    const status = await indexLoaded(pool);
    if (!status.value) {
      out.skipped = "semmed index not loaded (make semmed)";
      log(`   expansion skipped: ${out.skipped}`);
      return out;
    }
    out.source = status.meta?.source || null;

    const subQueries = (decomposition?.search_queries || []).map(q => q.query);
    const seeds = await linkSeeds(pool, [query, ...subQueries], embed, out.rejected_seeds);
    out.seeds = seeds.map(s => ({ cui: s.cui, name: s.name, semtype: s.semtype, mention: s.mention,
                                  link_similarity: s.link_similarity ?? 1 }));
    for (const r of out.rejected_seeds) {
      log(`   expansion reject seed "${r.mention}" -> ${r.name} ` +
          `(link similarity ${r.link_similarity} < ${CONFIG.minLinkSim})`);
    }
    if (!seeds.length) {
      log(`   expansion: no condition concept in the question`);
      return out;
    }
    log(`   expansion seeds: ${seeds.map(s => `"${s.mention}" -> ${s.name} (${s.cui})`).join(", ")}`);

    const seedName = new Map(seeds.map(s => [s.cui, s.name]));
    const searched = new Set([...subQueries, ...seeds.flatMap(s => [s.name, s.mention])]
      .map(normalize));
    const seen = new Set(alreadyRetrieved);

    out.causes_first = causesFirst;
    for (const c of await relatedConcepts(pool, seeds.map(s => s.cui), causesFirst)) {
      if (out.results_by_query.length >= CONFIG.maxTerms) break;
      const term = c.name;
      const record = {
        cui: c.cui, name: term, semtype: c.semtype, support: c.support,
        predicates: c.predicates, roles: c.roles, seed: seedName.get(c.seed) || c.seed,
        papers_as_cause: c.papers_as_cause || 0, papers_as_effect: c.papers_as_effect || 0,
        // Which way the literature mostly runs, relative to the question's
        // condition: "cause" = this concept leads to it.
        direction: (c.papers_as_cause || 0) >= (c.papers_as_effect || 0) ? "cause" : "effect",
      };
      out.concepts.push(record);

      // "Diabetes" is a top neighbor of "Diabetes Mellitus": the same thing
      // under another name. A concept whose words all appear in something
      // already searched adds nothing the decomposed search did not find.
      const words = normalize(term).split(" ");
      if ([...searched].some(p => words.every(w => p.split(" ").includes(w)))) {
        record.kept = false; record.reason = "same concept as the question";
        log(`   expansion skip "${term}" (same concept as the question)`);
        continue;
      }
      searched.add(normalize(term));

      const results = await search(term, CONFIG.resultsPerTerm * 3, "expanded");
      const top = results[0]?.semantic_score ?? 0;
      // The cutoff applies to EVERY row added, not just the best one. Gating
      // only on the top match let "Ischemic stroke" (top 0.632, a row already
      // retrieved) add "Vision disability" at 0.51, and COPD add bare column
      // names "Conthow" and "Rrtp" at 0.58 and 0.53.
      const fresh = results
        .filter(r => !seen.has(r.attr_id) && (r.semantic_score ?? 0) >= CONFIG.minSim)
        .slice(0, CONFIG.resultsPerTerm);
      record.top_similarity = top;

      if (top < CONFIG.minSim) { record.kept = false; record.reason = `best catalog match ${top} < ${CONFIG.minSim}`; }
      else if (!fresh.length) { record.kept = false; record.reason = "no new attribute above the cutoff"; }
      else {
        record.kept = true;
        const via = `${term} ${record.direction === "cause" ? "->" : "<-"} ${record.seed} ` +
                    `(${c.predicates.join("/").toLowerCase()}, ${c.support} papers)`;
        for (const r of fresh) { seen.add(r.attr_id); r.expanded_via = via; }
        out.results_by_query.push({ query: term, purpose: "expanded", expansion: record, results: fresh });
      }
      log(`   expansion ${record.kept ? "KEEP" : "skip"} "${term}" [${c.semtype}] ` +
          `support=${c.support} sim=${top}${record.reason ? " (" + record.reason + ")" : ""}`);
    }
  } catch (err) {
    out.error = err.message;
    log(`   expansion failed, continuing without it: ${err.message}`);
  }
  return out;
}

module.exports = { expandQuery, EXPANSION_CONFIG: CONFIG, indexLoaded, _test: { spans, normalize } };
