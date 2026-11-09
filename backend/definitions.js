/**
 * Published definitions of qualitative terms, checked against the data.
 *
 * "Rural counties", "high-poverty counties": a planner asked to filter on these
 * has to pick a number, and the number it picks is a guess that looks like a
 * fact. CHR's "% Rural" is a FRACTION, so "% rural > 50" selects nothing; ERS
 * Urban Influence Codes mean different things in 2013 and 2024. So a cut on a
 * qualitative term comes from a CITED definition (etl/definitions.yaml, or a
 * dataset sidecar), loaded into concept_definition by `make definitions`.
 *
 * NONE OF THIS IS A WORD LIST. Three rules keep it that way as data grows:
 *
 *   1. A definition is attached to a MEASURE, and reaches the planner only on a
 *      candidate retrieval already returned (unified_search_server.js). Getting
 *      from "rural" to % Rural is retrieval's job, which known_item.yaml
 *      measures; there is no second matcher keyed on the terms.
 *   2. Every definition is re-tested against the vintage actually loaded, here,
 *      every time the corpus loads (fitToData). One that no longer fits is
 *      WITHHELD with a reason on /api/health, never applied.
 *   3. A qualifier with no definition falls back to a percentile of the
 *      measure's own distribution (filter_attr `percentile`), labelled as
 *      such. Adding data never requires adding an entry.
 */

/** A definition must select a real subset: not nothing, not everything. */
const MIN_SHARE = 0.005;
const MAX_SHARE = 0.995;

const SQL_OPS = { "<": "<", "<=": "<=", ">": ">", ">=": ">=", "=": "=", "!=": "<>" };

const holds = (op, x, v) => ({
  "<": x < v, "<=": x <= v, ">": x > v, ">=": x >= v, "=": x === v, "!=": x !== v,
}[op]);

/**
 * Whether one definition fits what is loaded for its measure.
 *
 * Pure, so the rules are testable without a database. `stats` describes the
 * measure at its LATEST vintage, which is the year a plan reads when it names
 * none: {year, n, lo, hi, distinct, integers, selected}. Returns null when it
 * fits, or the reason it is withheld, worded for whoever maintains the file.
 */
function fitToData(def, stats) {
  if (!stats || !stats.n) return `no values loaded for ${def.measure_code}`;
  const { year, n, lo, hi, distinct, integers, selected } = stats;
  if (year < def.vintage_from || year > def.vintage_to) {
    return `published for ${def.vintage_from}-${def.vintage_to}, but the loaded ` +
           `${def.measure_code} is ${year}; code schemes change between releases`;
  }
  switch (def.scale) {
    case "percent":
      if (lo < 0 || hi > 100 || hi <= 1) {
        return `declared percent (0-100), but values run ${lo} to ${hi}`;
      }
      break;
    case "fraction":
      if (lo < 0 || hi > 1) return `declared fraction (0-1), but values run ${lo} to ${hi}`;
      break;
    case "flag":
      if (lo < 0 || hi > 1 || !integers) {
        return `declared a 0/1 flag, but values run ${lo} to ${hi}`;
      }
      break;
    case "code":
      if (!integers) return `declared integer codes, but values are not integers`;
      break;
    case "count":
      if (lo < 0) return `declared a count, but values go down to ${lo}`;
      break;
    default:
      return `unknown scale ${JSON.stringify(def.scale)}`;
  }
  if (def.value < lo || def.value > hi) {
    return `rule ${def.op} ${def.value} lies outside the loaded values (${lo} to ${hi})`;
  }
  const share = selected / n;
  if (share < MIN_SHARE || share > MAX_SHARE) {
    return `rule ${def.op} ${def.value} selects ${selected} of ${n} counties ` +
           `(${(100 * share).toFixed(1)}%); a definition must select a real subset`;
  }
  return null;
}

/** "value >= 4" with the number as published. */
const ruleText = (d) => `value ${d.op} ${d.value}`;

function createDefinitions(pool, { log = () => {} } = {}) {
  let state = null;       // { active: Map<code, def[]>, withheld: [], loadedAt }
  let loading = null;

  async function load() {
    const active = new Map();
    const withheld = [];
    let rows = [];
    try {
      ({ rows } = await pool.query(
        `SELECT id, measure_code, term, op, value, scale, vintage_from, vintage_to,
                source, url, origin
           FROM concept_definition ORDER BY id, measure_code`));
    } catch (err) {
      // No table yet (`make definitions` never run): the percentile fallback
      // still works, so this is a warning, not a failure.
      log(`   definitions: none loaded (${err.message.split("\n")[0]})`);
      return { active, withheld, loadedAt: Date.now(), missing: true };
    }
    const codes = [...new Set(rows.map(r => r.measure_code))];
    const stats = new Map();
    if (codes.length) {
      const { rows: s } = await pool.query(
        `WITH latest AS (
           SELECT census_code, max(year)::int AS year FROM acs_county_values
            WHERE census_code = ANY($1) GROUP BY census_code)
         SELECT v.census_code, l.year, count(*)::int AS n,
                min(v.value) AS lo, max(v.value) AS hi,
                count(DISTINCT v.value)::int AS distinct,
                bool_and(v.value = trunc(v.value)) AS integers
           FROM acs_county_values v JOIN latest l
             ON v.census_code = l.census_code AND v.year = l.year
          WHERE v.value IS NOT NULL
          GROUP BY v.census_code, l.year`, [codes]);
      for (const r of s) {
        stats.set(r.census_code, { year: r.year, n: r.n, lo: Number(r.lo),
          hi: Number(r.hi), distinct: r.distinct, integers: r.integers });
      }
    }
    for (const r of rows) {
      const def = { ...r, value: Number(r.value) };
      const st = stats.get(def.measure_code);
      if (st && def.op in SQL_OPS) {
        // How many counties the rule selects at the loaded vintage.
        const { rows: [c] } = await pool.query(
          `SELECT count(*)::int AS k FROM acs_county_values
            WHERE census_code = $1 AND year = $2 AND value ${SQL_OPS[def.op]} $3`,
          [def.measure_code, st.year, def.value]);
        st.selected = c.k;
      }
      const why = def.op in SQL_OPS ? fitToData(def, st && { ...st }) : `unknown operator ${def.op}`;
      if (why) {
        withheld.push({ id: def.id, measure_code: def.measure_code, reason: why });
        log(`   definition WITHHELD ${def.id} (${def.measure_code}): ${why}`);
        continue;
      }
      def.selected = st.selected;
      def.n = st.n;
      def.year = st.year;
      if (!active.has(def.measure_code)) active.set(def.measure_code, []);
      active.get(def.measure_code).push(def);
    }
    log(`   definitions: ${rows.length - withheld.length} active, ${withheld.length} withheld`);
    return { active, withheld, loadedAt: Date.now() };
  }

  async function ensure() {
    if (state) return state;
    if (!loading) loading = load().then(s => { state = s; loading = null; return s; });
    return loading;
  }

  /** Active definitions for one measure code ([] for none). */
  async function forCode(code) {
    const s = await ensure();
    return (code && s.active.get(code)) || [];
  }

  /** For /api/health: which are applied, which are withheld and why. */
  async function status() {
    const s = await ensure();
    return {
      active: [...s.active.values()].flat().map(d => ({
        id: d.id, measure_code: d.measure_code, term: d.term, rule: ruleText(d),
        selects: `${d.selected} of ${d.n} counties (${d.year})`,
      })),
      withheld: s.withheld,
      ...(s.missing ? { note: "concept_definition not loaded; run make definitions" } : {}),
    };
  }

  /** For /api/reload-corpus: definitions and values may both have changed. */
  function clear() { state = null; }

  return { forCode, status, clear, ensure };
}

module.exports = { createDefinitions, fitToData, ruleText, holds, MIN_SHARE, MAX_SHARE };
