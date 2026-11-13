/**
 * Plans at a unit other than the county: census tracts, ZIP code areas, grid
 * cells (docs/RESEARCH_PLAN.md Phase E; DATA_LOADING_PLAN.md phases 6-7).
 *
 * THE MODEL NEVER CHOOSES THE LEVEL. A question that wants tracts says so
 * ("census tracts in St. Louis", "ZIP codes in Cook County", "4 km grid
 * cells"), so the unit is read from the question's words, after the model has
 * planned, and set on the plan here. The prompt and decoding schema are
 * therefore byte-identical (snapshot_prompt.js, 48 contexts), and no plan can
 * name a level that does not exist.
 *
 * A level is applied only when EVERY measure the plan loads has values at it
 * (geo_measure). Otherwise the plan goes back for repair with the candidates
 * that do have it named by label, the same move as a period a measure cannot
 * span (planner/vintages.js). Ops not yet ported to other levels are refused
 * with a sentence saying so, never compiled at the county level by accident.
 */

// Units a question can name, finest first within each family.
const LEVEL_LABEL = {
  tract: "census tract", zcta: "ZIP code area",
  grid4k: "4 km grid cell", grid16k: "16 km grid cell", grid64k: "64 km grid cell",
};
const LEVELS = new Set(Object.keys(LEVEL_LABEL));

// Ops whose SQL works at any level: they only read (fips, value), or have a
// level-aware form (load, filter_area, filter_place, per_area, nearest_distance,
// count_near, output).
const LEVEL_OPS = new Set([
  "load", "filter_area", "filter_place", "filter_attr", "rank", "normalize",
  "per_area", "join", "intersect", "combine", "output",
  // Distance ops measure from each unit's own geometry (2026-11-11).
  "nearest_distance", "count_near",
  // Counting features per unit, from the unit's geometry (H2, 2026-11-11):
  // "how many schools in each Chicago community area". Features steps have
  // no level of their own; summarize counts them into the plan's units.
  "count_features", "summarize", "select_features", "within",
  // H3: overlay is features in and out, summarized into the units like
  // within. H4: zonal clips the raster to each unit's own polygon.
  "overlay", "zonal",
]);

/*
 * ZONE SETS (docs/GIS_OPS_PLAN.md H2): a user's own units, wards, neighborhoods,
 * planning areas, loaded as geo_unit levels `z_<id>` by etl/load_zones.py and
 * listed in zone_set. The server registers them at startup and on
 * reload-corpus. Matching is in code like every other unit: the question must
 * name the unit word (plural, or singular after each / every / per / by /
 * which / what) AND one of the set's places, because two cities both have
 * wards and a unit word alone cannot say whose. A question naming wards in a
 * city that has none loaded matches nothing and plans as before.
 */
const ZONE_LEVEL = /^z_[a-z0-9_]{1,40}$/;
const ZONES = new Map();
const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

function registerZoneSets(rows) {
  for (const lv of ZONES.keys()) { LEVELS.delete(lv); delete LEVEL_LABEL[lv]; }
  ZONES.clear();
  for (const r of rows || []) {
    if (!ZONE_LEVEL.test(String(r.level || "")) || !r.unit || !(r.places || []).length) continue;
    const unit = String(r.unit).toLowerCase();
    const plural = String(r.plural || `${unit}s`).toLowerCase();
    const aliases = (r.aliases || []).map(a => String(a).toLowerCase());
    const singulars = [unit, ...aliases];
    const plurals = [plural, ...aliases.map(a => `${a}s`)];
    const z = {
      level: r.level, name: r.name, unit, plural, aliases,
      places: r.places.map(String),
      plural_re: new RegExp(`\\b(?:${plurals.map(esc).join("|")})\\b`, "i"),
      single_re: new RegExp(`\\b(?:each|every|per|by|which|what)\\s+(?:[\\w.'-]+\\s+){0,3}?` +
                            `(?:${singulars.map(esc).join("|")})\\b`, "i"),
      place_re: new RegExp(`(?:^|[^A-Za-z])(?:${r.places.map(esc).join("|")})(?![A-Za-z])`, "i"),
    };
    ZONES.set(r.level, z);
    LEVELS.add(r.level);
    LEVEL_LABEL[r.level] = unit;
  }
  return [...ZONES.keys()];
}

/** The zone set a question names, or null. */
function zoneOf(q) {
  const hits = [...ZONES.values()].filter(z =>
    (z.plural_re.test(q) || z.single_re.test(q)) && z.place_re.test(q));
  if (hits.length === 1) return hits[0].level;
  // Two sets in one place with the same word (none today): the longer unit
  // phrase wins ("community area" over "area"), else nothing is guessed.
  if (hits.length > 1) {
    const best = hits.sort((a, b) => b.unit.length - a.unit.length);
    return best[0].unit.length > best[1].unit.length ? best[0].level : null;
  }
  return null;
}

/**
 * Every word of every registered set's unit names and places ("ward",
 * "community", "area", "st", "louis", "chicago"). They name a reporting unit,
 * not data, which is how planner/named_data.js treats "tract" and "county":
 * "each Chicago ward" was refused as missing data on the first H2 run.
 */
function zoneWords() {
  const out = new Set();
  for (const z of ZONES.values()) {
    for (const t of [z.unit, z.plural, ...(z.aliases || []), ...z.places]) {
      for (const w of String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
        if (w) out.add(w);
      }
    }
  }
  return out;
}

const zoneSet = (level) => ZONES.get(level) || null;
const isZoneLevel = (level) => ZONES.has(level);

/**
 * The unit a question asks for, or null for counties.
 *
 * ZIP needs the PLURAL: "which counties does ZIP code 65721 fall in" is about
 * counties, and one named ZIP is filter_place's job, not a level.
 */
// Counties named as the ANSWER's unit: "each Michigan county", "in which
// Missouri counties", "per county". Not "ZIP codes in Cook County", where the
// county is a place. Such a question uses finer data to say something about
// counties (a roll-up, or a spread within each), and answering it with tract
// rows would be the wrong unit.
const COUNTY_ANSWER =
  /\b(?:each|every|which|per|by)\s+(?:[A-Z][a-z]+\s+){0,2}count(?:y|ies)\b/;

function levelOf(query) {
  const q = String(query || "");
  if (COUNTY_ANSWER.test(q)) return null;
  return zoneOf(q) || unitNamed(q);
}

/**
 * Does the question ask how far, or what is near? The only ops that read a
 * feature layer at another unit are nearest_distance and count_near, so a
 * feature layer stays on a named unit's candidate list only for these
 * questions. Offered unconditionally, the layers derailed two that planned
 * fine without them: "the most densely populated 4 km grid cells" loaded
 * Natural Gas Storage Facilities, and the Michigan tract roll-up returned no
 * steps (2026-11-11).
 */
const DISTANCE =
  /\b(?:near|nearest|nearby|close\s+to|closest|far|farther|farthest|furthest|distance|distances|away\s+from|within\s+(?:a\s+|an\s+)?\d*\.?\d*\s*-?\s*(?:miles?|mi|km|kilometers?|kilometres?|meters?|metres?|feet|minutes?))\b/i;
const asksDistance = (query) => DISTANCE.test(String(query || ""));

/** The finer unit a question names, whatever its answer unit is. */
function unitNamed(q) {
  if (/\b(?:census\s+)?tracts?\b/i.test(q)) return "tract";
  if (/\bzip\s*codes\b|\bzips\b|\bzctas\b|\bzip\s*code\s+areas\b/i.test(q)) return "zcta";
  // A singular ZIP after each / every / per / by still means all of them.
  // "How far is each ZIP code in Montana from the nearest hospital" read as a
  // county question and answered 56 counties (2026-11-11). A bare "ZIP code
  // 65721" stays a place, not a level.
  if (/\b(?:each|every|per|by)\s+zip(?:\s*code)?\b/i.test(q)) return "zcta";
  const g = q.match(/\b(\d+)\s*-?\s*(?:km|kilometer|kilometre)\b[^.?]*\bgrid|\bgrid\s+cells?\b/i);
  if (g) {
    const km = Number(g[1]);
    return km >= 32 ? "grid64k" : km >= 8 ? "grid16k" : "grid4k";
  }
  return null;
}

// "Vary the most from one tract to another": the spread within each county.
const SPREAD = /\bvar(?:y|ies|ied|iation)\b|\bspread\b|\binequal(?:ity)?\b|\bdispersion\b|\bfrom\s+one\s+(?:census\s+)?tract\s+to\s+another\b/i;
// Weights for a rate's roll-up, in order of preference: the same dataset's
// population first (SVI), else WorldPop's. Never total population for a
// percentile (see etl/schema_geo.sql), which applyRollup does not roll up.
const WEIGHTS = ["SVI_E_TOTPOP", "WORLDPOP_POP"];

/** Finer data, county answers: the unit to roll up from, or null. */
function rollupOf(query) {
  const q = String(query || "");
  if (!COUNTY_ANSWER.test(q)) return null;
  const from = unitNamed(q);
  return from === "tract" ? from : null;
}

/**
 * "Using census tract data, ... in each Michigan county": each load reads the
 * tract values and is rolled up to counties right away (ops/aggregate_to.js),
 * so the rest of the plan is a county plan. Rates are population-weighted,
 * counts summed, and spread phrasing takes the standard deviation of the
 * tracts in each county. A measure without tract values goes back for repair
 * with the ones that have them, like applyLevel.
 *
 * @param unitOf  (attribute_source row) => "rate" | "count" | null (planner/units.js)
 */
async function applyRollup(plan, query, resolved, levelsOf, unitOf, alternatives = null) {
  const from = rollupOf(query);
  if (!from) return { note: null, errors: [] };
  const unit = LEVEL_LABEL[from];
  const steps = plan.steps || [];
  const lacking = [];
  const loads = steps.filter(s => s.op === "load");
  const plans = [];
  for (const st of loads) {
    const src = resolved.get(st.attr_id);
    const have = src?.source_kind === "acs_long" ? await levelsOf(src.census_code) : new Set();
    if (!have.has(from)) { lacking.push(src?.description || st.attr_id); continue; }
    const spread = SPREAD.test(query);
    const kind = unitOf(src);
    if (!spread && kind !== "rate" && kind !== "count") { lacking.push(src.description || st.attr_id); continue; }
    let weight = null;
    if (!spread && kind === "rate") {
      for (const w of WEIGHTS) if ((await levelsOf(w)).has(from)) { weight = w; break; }
      if (!weight) { lacking.push(src.description || st.attr_id); continue; }
    }
    plans.push({ st, method: spread ? "stddev" : kind === "count" ? "sum" : "wmean", weight });
  }
  if (lacking.length) {
    let alts = [];
    if (alternatives) { try { alts = await alternatives(from); } catch { alts = []; } }
    const named = alts.slice(0, 4).map(a => `${a.label} "${String(a.description || "").slice(0, 70)}"`).join("; ");
    return { note: null, errors: [
      `The question uses ${unit} data, and ${lacking.map(d => `"${String(d).slice(0, 60)}"`).join(", ")} ` +
      `cannot be built up from ${unit}s. ` +
      (named ? `These on the list can: ${named}.` : `None of the attributes found has ${unit} values; say it cannot be answered.`)] };
  }
  const ids = new Set(steps.map(s => s.id));
  const methods = [];
  for (const { st, method, weight } of plans) {
    let id = `${st.id}_by_county`;
    while (ids.has(id)) id += "_";
    ids.add(id);
    for (const other of steps) {
      other.inputs = (other.inputs || []).map(i => (i === st.id ? id : i));
    }
    st.level = from;
    steps.splice(steps.indexOf(st) + 1, 0, {
      id, op: "aggregate_to", attr_id: "", inputs: [st.id], from_level: from, method,
      ...(weight ? { weight_code: weight } : {}),
    });
    methods.push(method === "stddev" ? `the spread (standard deviation) of its ${unit}s`
      : method === "sum" ? `the sum of its ${unit}s`
      : `the population-weighted mean of its ${unit}s (${weight})`);
  }
  if (!plans.length) return { note: null, errors: [] };
  return { note: `each county is ${[...new Set(methods)].join("; ")}`, errors: [] };
}

/**
 * Set `level` on the plan when the question names a unit.
 *
 * @param resolved  Map attr_id -> attribute_source row (from validatePlan)
 * @param levelsOf  async (census_code) => Set of levels with values
 * @param alternatives  async (level) => [{label, description}] candidates
 *                  that do have the level, for the repair message
 * @returns {level, note, errors}
 */
async function applyLevel(plan, query, resolved, levelsOf, alternatives = null) {
  const level = levelOf(query);
  if (!level) return { level: null, note: null, errors: [] };
  const unit = LEVEL_LABEL[level];
  const errors = [];
  const steps = plan.steps || [];

  const notPorted = [...new Set(steps.map(s => s.op).filter(op => !LEVEL_OPS.has(op)))];
  if (notPorted.length) {
    errors.push(`The question asks for ${unit}s, and ${notPorted.join(", ")} ` +
                `${notPorted.length > 1 ? "are" : "is"} not available by ${unit} yet. ` +
                `Use only load, filters, rank, normalize, per_area, join, intersect, combine, nearest_distance, count_near, count_features, summarize and output.`);
  }
  const lacking = [];
  for (const st of steps.filter(s => s.op === "load")) {
    const src = resolved.get(st.attr_id);
    if (!src || src.source_kind !== "acs_long") { lacking.push(src?.description || st.attr_id); continue; }
    const have = await levelsOf(src.census_code);
    if (!have.has(level)) lacking.push(src.description || src.census_code);
  }
  if (lacking.length) {
    let alts = [];
    if (alternatives) { try { alts = await alternatives(level); } catch { alts = []; } }
    const named = alts.slice(0, 4).map(a => `${a.label} "${String(a.description || "").slice(0, 70)}"`).join("; ");
    errors.push(`The question asks for ${unit}s, and ${lacking.map(d => `"${String(d).slice(0, 60)}"`).join(", ")} ` +
                `${lacking.length > 1 ? "have" : "has"} no values by ${unit}. ` +
                (named ? `These on the list do: ${named}.`
                       : `None of the attributes found has values by ${unit}; say it cannot be answered.`));
  }
  if (errors.length) return { level, note: null, errors };
  plan.level = level;
  return { level, note: `answered by ${unit} (the question asked for ${unit}s)`, errors: [] };
}

/** The level a plan compiles at; "county" unless applyLevel set one. */
const planLevel = (plan) => (LEVELS.has(plan?.level) ? plan.level : "county");

module.exports = {
  levelOf, rollupOf, asksDistance, applyLevel, applyRollup, planLevel,
  registerZoneSets, zoneSet, isZoneLevel, zoneWords, LEVELS, LEVEL_LABEL, LEVEL_OPS,
};
