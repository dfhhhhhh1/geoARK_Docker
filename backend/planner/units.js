/**
 * Is a series a COUNT or a RATE?
 *
 * Exists for one validator rule (validate.js, `normalize`): a rate divided by a
 * count is meaningless, and it validates, compiles, executes and maps. Measured
 * 2026-10-16 with planner reasoning off: "What are the poverty rates around
 * Detroit?" planned **poverty percent / total population** in both runs, and the
 * relevance check passed Population as a "denominator" (CLAUDE.md, "Reasoning
 * off, or capped").
 *
 * The classification is deliberately one-sided. "rate" means the series is
 * already a proportion, a median, a mean, a ratio or a prevalence; "count"
 * means it is a number of things that sums across counties; null means this
 * code cannot tell, and null never triggers a rejection. A false "rate" turns a
 * valid plan into a refusal, so every rule below was checked against the live
 * catalog (test_units.js pins the cases that decided them).
 */

// ---------------------------------------------------------------- ACS tables
//
// ACS descriptions are segmented: "Estimate|Total|INCOME ...|Median income".
// Where the RATE marker lives differs by table family, and looking in the
// wrong segment is how a count gets called a rate:
//
//   DP tables  segment 0 is the column kind: "Estimate" / "Percent Estimate".
//              Segment 1 is a SECTION title, and DP04's section "SELECTED
//              MONTHLY OWNER COSTS AS A PERCENTAGE OF HOUSEHOLD INCOME" heads
//              COUNTS of housing units, so it must not be read.
//   S tables   segment 1 is the column header: "Total", "Percent",
//              "Percent below poverty level", "Median income (dollars)".
//
// The LEAF is read in both, but only for a marker at its start or a rate noun:
// "Less than 30 percent" and "35.0 percent or more" are category labels on
// counts.
//
// The labels are not the whole truth, in either direction, measured over all
// 3,557 catalog series:
//   - 181 S-table columns labelled "Estimate|Total" hold PERCENTAGES (all of
//     S0801, and S0102's sex/age rows: "Estimate|Total|...|Male" peaks at 61.2).
//   - 62 "Percent Estimate" rows hold COUNTS: a DP table's universe row
//     (DP03_0001PE, "Population 16 years and over") reports the count itself,
//     up to 8,112,148.
// So where the national value range is known it decides between percentage
// and count -- a percentage cannot exceed 100, and every "Estimate" series that
// stays inside [0, 100] is one of those 181. Medians, means and ratios are
// rates whatever their range.
const ACS_CODE = /^(?:DP|S|B|C)\d{2}/;
const SEGMENTS = /\s*(?:\|+|!!)\s*/;

const RATE_HEADER =
  /\b(?:percent|percentage|pct|rate|ratio|median|mean|average|per capita)\b|%|^PCT_EST$/i;
const RATE_LEAF =
  /^(?:percent|median|mean|average|per capita)\b|\b(?:rate|ratio)\b|^%/i;
const INTENSIVE = /\b(?:median|mean|average|per capita|rate|ratio)\b/i;
const MOE = /margin of error|\bMOE\b|^PMOE$/i;

function acsUnit(desc, code, range) {
  const segs = String(desc || "").split(SEGMENTS).filter(Boolean);
  if (!segs.length) return null;
  const kind = segs[0];
  // A margin of error is neither: dividing one by anything is its own mistake,
  // and not the one this rule is about.
  if (MOE.test(kind) || (segs[1] && MOE.test(segs[1]))) return null;
  const isPercentKind = /^(?:percent|pct)/i.test(kind) || (/^DP/.test(code) && /PE$/.test(code));
  if (!isPercentKind && !/^estimate$/i.test(kind)) return null;

  const leaf = segs[segs.length - 1];
  const header = /^S\d/.test(code) ? (segs[1] || "") : "";
  if (INTENSIVE.test(leaf) && RATE_LEAF.test(leaf)) return "rate";
  if (/\b(?:median|mean|average|per capita)\b/i.test(header)) return "rate";

  if (range && Number.isFinite(range.lo) && Number.isFinite(range.hi)) {
    return range.lo >= 0 && range.hi <= 100 ? "rate" : "count";
  }
  if (isPercentKind || RATE_LEAF.test(leaf) || RATE_HEADER.test(header)) return "rate";
  return "count";
}

// ----------------------------------------------- everything else (ERS, PLACES,
// CHR, SVI, WorldPop): one free-text description plus a code.
const RATE_TEXT =
  /\b(?:percent|percentage|pct|rate|ratio|prevalence|percentile|median|mean|average|per capita|index|density|mortality|life expectancy)\b|%/i;
const RATE_CODE = /^(?:PCT|R_|MED|SVI_EP_|SVI_RPL_|PLACES_)|_rate$|Prv$/i;
// ERS population and poverty estimates whose names say nothing to a reader.
const COUNT_CODE =
  /^(?:POP_ESTIMATE|CENSUS_POP|ESTIMATES_BASE|GQ_ESTIMATES(?:_BASE)?|POVALL|POV017|POV517|BIRTHS|DEATHS|NATURAL_CHG|NET_MIG|DOMESTIC_MIG|INTERNATIONAL_MIG|N_POP_CHG|CIVILIAN_LABOR_FORCE|EMPLOYED|UNEMPLOYED|SVI_E_TOTPOP|WORLDPOP_POP|CHR_V051_RAWVALUE)$/i;

/**
 * Whether a catalog series is a rate, a count, or unknown.
 *
 * @param src  a resolved attribute_source row: {description, census_code,
 *             source_kind, value_range?: {lo, hi}}. `value_range` is the
 *             national min/max of the latest vintage, attached by the server.
 */
function seriesUnit(src) {
  if (!src) return null;
  if (src.source_kind === "feature_table") return "count";
  if (src.source_kind === "inline") return null;    // a user's upload: unknowable
  const code = src.census_code || "";
  const desc = src.description || src.attr_desc || "";

  if (ACS_CODE.test(code)) return acsUnit(desc, code, src.value_range);
  if (COUNT_CODE.test(code)) return "count";
  if (RATE_CODE.test(code) || RATE_TEXT.test(desc)) return "rate";

  // County Health Rankings stores most measures as fractions ("Adult obesity"
  // 0.177-0.530) under names that say nothing about units. A series that never
  // leaves [0, 100] anywhere in the country is a proportion or a small rate:
  // no county COUNT of anything in this catalog stays that small. Applied only
  // here, never to ACS rows, whose descriptions are authoritative.
  const r = src.value_range;
  if (r && Number.isFinite(r.lo) && Number.isFinite(r.hi) && r.lo >= 0 && r.hi <= 100) {
    return "rate";
  }
  return null;
}

/**
 * What one step of a plan yields, traced back through the ops that keep their
 * input's unit (filters, rank, join's first side). Ops that compute a new
 * quantity say what it is; anything not listed is unknown.
 */
const KEEPS_UNIT = new Set(["filter_area", "filter_place", "filter_attr", "rank", "join", "output"]);
const YIELDS_RATE = new Set([
  "normalize", "per_area", "nearest_distance", "hotspot", "outlier", "correlate",
]);
const YIELDS_COUNT = new Set(["count_features", "count_near"]);

function stepUnit(stepId, byId, resolved, seen = new Set()) {
  const st = byId.get(stepId);
  if (!st || seen.has(stepId)) return null;
  seen.add(stepId);
  if (st.op === "load") return seriesUnit(resolved.get(st.attr_id));
  if (YIELDS_COUNT.has(st.op)) return "count";
  if (YIELDS_RATE.has(st.op)) return "rate";
  if (st.op === "combine") {
    if (st.operation === "ratio" || st.operation === "percent_change") return "rate";
    return stepUnit((st.inputs || [])[0], byId, resolved, seen);
  }
  if (st.op === "aggregate") {
    if (st.function === "count") return "count";
    if (st.function === "sum") return stepUnit((st.inputs || [])[0], byId, resolved, seen);
    return null;
  }
  if (KEEPS_UNIT.has(st.op)) return stepUnit((st.inputs || [])[0], byId, resolved, seen);
  return null;
}

module.exports = { seriesUnit, stepUnit };
