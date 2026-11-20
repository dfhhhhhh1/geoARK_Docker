/**
 * Measures that exist ONLY below the county (tract, block group, ZCTA ...), and
 * how a question that names such a unit reaches them
 * (docs/DATA_LOADING_PLAN.md, "tract-only measures are not findable").
 *
 * `make ingest` writes a catalog row for a county measure and none below it, so
 * EJScreen's PM2.5 (83,776 tracts) could not be retrieved: the planner reaches
 * a measure through a catalog row, and the "second search within the unit's
 * measures" searched the catalog. "Which census tracts in Missouri have the
 * highest PM2.5?" answered `the loaded data does not include "PM2.5"`.
 *
 * This is the "separate index of non-county measures, searched only at a named
 * unit" option. It reads `geo_measure` itself, which every loader fills for
 * every level, so a dataset loaded tomorrow is findable with no tagging step,
 * no catalog row and no change to the embedded corpus. That last point is the
 * guard: the corpus, its cache key and every county ranking are untouched, so
 * known_item.yaml and queries.yaml cannot move by construction.
 *
 * Nothing here knows a dataset, a measure or a unit by name.
 */

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "which",
  "what", "where", "show", "give", "find", "tract", "tracts", "block", "group",
  "groups", "zip", "code", "codes", "county", "counties", "each", "every",
  "highest", "lowest", "most", "least", "top", "number", "per", "rate", "rates",
  "census", "area", "areas", "cell", "cells", "level", "state", "city", "bg",
]);

function tokens(text) {
  return String(text || "").toLowerCase().replace(/([a-z])([0-9])/g, "$1 $2")
    .split(/[^a-z0-9]+/).filter((t) => (t.length > 1 || /\d/.test(t)) && !STOP.has(t));
}

const UNIT_LABEL = { tract: "TRACT", bg: "BLOCK GROUP", zcta: "ZCTA" };

function create({ pool, ttlMs = 60_000 }) {
  const cache = new Map(); // level -> { at, docs, idf, avgdl }

  /** Measures at `level` that have no attribute_source row (county twin). */
  async function load(level) {
    const hit = cache.get(level);
    if (hit && Date.now() - hit.at < ttlMs) return hit;
    const { rows } = await pool.query(
      `SELECT m.code, m.label, m.description, m.units, m.min_year, m.max_year,
              m.n_units, m.dataset_id, d.name AS dataset_name
         FROM geo_measure m
         LEFT JOIN dataset_info d USING (dataset_id)
         LEFT JOIN attribute_source a ON a.attr_id = m.code
        WHERE m.level = $1 AND a.attr_id IS NULL`, [level]);
    const docs = rows.map((r) => {
      // Description counts double: it is the human name of the measure; the
      // label is often a DBF-style abbreviation and the code a prefixed copy.
      const toks = [...tokens(r.description), ...tokens(r.description),
        ...tokens(r.label), ...tokens(r.code), ...tokens(r.dataset_name)];
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { row: r, tf, len: toks.length };
    });
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const N = docs.length;
    const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (N - n + 0.5) / (n + 0.5))]));
    const avgdl = docs.reduce((a, d) => a + d.len, 0) / (N || 1);
    const built = { at: Date.now(), docs, idf, avgdl, df, N };
    cache.set(level, built);
    return built;
  }

  /** BM25 of one query over the level's measures, best first, score > 0 only. */
  async function search(level, query, limit = 3) {
    const { docs, idf, avgdl, df, N } = await load(level);
    const q = [...new Set(tokens(query))];
    if (!q.length || !docs.length) return [];
    // A one-word sub-query matches only a word that singles measures out:
    // "population" is in a tenth of a unit's measures and found veterans and
    // low-income counts for a question about a vehicle share.
    if (q.length === 1 && (df.get(q[0]) || 0) > Math.max(2, 0.1 * N)) return [];
    const scored = [];
    for (const d of docs) {
      let s = 0, hit = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) continue;
        hit++;
        s += (idf.get(t) || 0) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avgdl));
      }
      // Every query word must matter: one shared word out of four is how "mobile"
      // reached Mobile Home Parks. Require half of the query's content words.
      if (hit && hit >= Math.ceil(q.length / 2)) scored.push({ s, row: d.row });
    }
    scored.sort((a, b) => b.s - a.s);
    // Near the best match only: a one-word sub-query ("population") otherwise
    // fills the list with whatever mentions it.
    const floor = scored.length ? scored[0].s * 0.7 : 0;
    return scored.filter((x) => x.s >= floor).slice(0, limit).map((x) => x.row);
  }

  /** A catalog-shaped candidate row, so the prompt builder needs no special case. */
  function candidate(row, level) {
    const years = row.min_year ? (row.min_year === row.max_year ? `${row.min_year}` : `${row.min_year}-${row.max_year}`) : "";
    return {
      attr_id: row.code,
      dataset_id: row.dataset_id,
      dataset_clean: row.dataset_name || row.dataset_id,
      attr_label: row.code,
      attr_orig: row.label,
      attr_desc: (row.description || row.label || row.code) + (row.units ? ` (${row.units})` : ""),
      entity_type: UNIT_LABEL[level] || String(level).toUpperCase(),
      start_date: years, tags: [], search_purpose: "primary", level_only: true,
    };
  }

  /**
   * attribute_source-shaped rows for ids that have none, from geo_measure. The
   * values live in geo_values and the compiler reads them by (code, level)
   * exactly as it does for a county measure's tract twin.
   */
  async function sources(ids) {
    const out = new Map();
    if (!ids.length) return out;
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (m.code) m.code, m.level, m.label, m.description, m.dataset_id
         FROM geo_measure m WHERE m.code = ANY($1) AND m.level <> 'county'
        ORDER BY m.code, m.n_units DESC`, [ids]);
    for (const r of rows) {
      out.set(r.code, {
        attr_id: r.code, dataset_id: r.dataset_id, description: r.description || r.label || r.code,
        source_kind: "acs_long", table_name: "acs_county_values", value_column: null,
        census_code: r.code, entity_type: UNIT_LABEL[r.level] || r.level.toUpperCase(),
        geom_table: null, geom_column: null, srid: null, level_only: true,
      });
    }
    return out;
  }

  /**
   * Is the query already served by something offered at this unit? True when
   * one text (a candidate's description and dataset) holds at least half of the
   * query's content words. A tract-only measure is looked for only when nothing
   * the catalog found says what the question asks: with them side by side,
   * "households without a vehicle" took a tract-only COUNT over the SVI rate
   * that rolls up, and "poverty below 150%" a different poverty measure
   * (2026-11-20, both caught by the phase_e guard).
   */
  function covered(query, texts) {
    const q = [...new Set(tokens(query))];
    if (!q.length) return true;
    const need = Math.ceil(q.length / 2);
    return texts.some((t) => {
      const have = new Set(tokens(t));
      return q.filter((w) => have.has(w)).length >= need;
    });
  }

  const clear = () => cache.clear();
  return { search, candidate, sources, load, clear, covered };
}

module.exports = { create, tokens };
