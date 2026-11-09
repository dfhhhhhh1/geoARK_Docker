/**
 * Prefer a series that covers the analysis area.
 *
 * Retrieval ranks by what an attribute SAYS, and two attributes can say the
 * same thing while covering very different parts of the country. Measured
 * 2026-10-15: every density plan chose S0102_C01_001E for "total population",
 * which ranks first and has values for 1,524 counties, over DP05_0001E (3,221).
 * "How densely populated are the counties in Texas" mapped 98 of 254 counties.
 * Nothing errors: the missing counties simply are not on the map.
 *
 * Two outcomes, both deterministic and both reported to the user:
 *
 *   1. SWAP when a verified equivalent covers >= COVERAGE_MIN of the area.
 *      "Equivalent" needs two things: the same measure class by description
 *      (today only whole-population counts, population.js), AND values that
 *      agree on the counties both cover. The second is not optional: the
 *      catalog row "Estimate|ANCESTRY|Total population" (DP02_0122E) matches
 *      the description and peaks at 108,101, so it is not total population.
 *      The server verifies agreement; this module only picks.
 *   2. NOTE when no equivalent exists: the plan runs as chosen and the reader
 *      is told how much of the area it covers.
 *
 * Runs on an ACCEPTED plan (after validation and the relevance check), so the
 * planner's prompt, the decoding schema and the relevance verdicts are
 * untouched. A swap is between series that measure the same thing, so the
 * relevance verdict on the original still holds for its replacement.
 */

const COVERAGE_MIN = 0.95;

/**
 * @param plan        accepted plan (attr_ids already dereferenced)
 * @param candidates  the retrieval candidates the planner saw, in order
 * @param deps.coverageOf   async (attrIds, plan) =>
 *                            Map<attr_id, {n, total, desc}> for value series;
 *                            n = counties with a value inside the plan's area
 * @param deps.equivalentsOf async (attrId, plan) =>
 *                            [{attr_id, attr_desc, n, total}] verified
 *                            equivalents, already coverage-counted for the area
 * @returns {{swaps: string[], notes: string[], added: object[]}} swaps and
 *          notes are human-readable, for adjustments; `added` holds swapped-in
 *          series the planner was never shown, so the caller can describe them
 */
async function preferCoverage(plan, candidates, { coverageOf, equivalentsOf }) {
  const swaps = [], notes = [], added = [];
  const loads = (plan.steps || []).filter(s => s.op === "load" && s.attr_id);
  if (!loads.length) return { swaps, notes, added };

  const cov = await coverageOf([...new Set(loads.map(s => s.attr_id))], plan);
  const order = new Map((candidates || []).map((c, i) => [c.attr_id, i]));

  for (const st of loads) {
    const c = cov.get(st.attr_id);
    if (!c || !c.total || c.n / c.total >= COVERAGE_MIN) continue;

    const alts = (await equivalentsOf(st.attr_id, plan))
      .filter(a => a.attr_id !== st.attr_id && a.total && a.n / a.total >= COVERAGE_MIN)
      // What the planner was shown first, in the order it was shown; then the
      // widest coverage; then the census code, so the choice never depends on
      // row order and a tie goes to the table's own first row (DP05_0001E,
      // "SEX AND AGE|Total population", over the RACE table's copy of it).
      .sort((a, b) =>
        (order.has(b.attr_id) - order.has(a.attr_id)) ||
        ((order.get(a.attr_id) ?? 0) - (order.get(b.attr_id) ?? 0)) ||
        (b.n - a.n) ||
        String(a.census_code ?? a.attr_id).localeCompare(String(b.census_code ?? b.attr_id)));

    const desc = c.desc || st.attr_id;
    if (alts.length) {
      const pick = alts[0];
      swaps.push(
        `"${short(desc)}" has values for only ${c.n} of ${c.total} counties in the ` +
        `area; used "${short(pick.attr_desc || pick.attr_id)}" instead, which ` +
        `covers ${pick.n} and agrees with it where both have values`);
      st.attr_id = pick.attr_id;
      if (!order.has(pick.attr_id)) added.push(pick);
    } else {
      notes.push(`"${short(desc)}" has values for ${c.n} of ${c.total} counties in the area`);
    }
  }
  return { swaps, notes, added };
}

const short = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 90 ? t.slice(0, 87) + "..." : t;
};

module.exports = { preferCoverage, COVERAGE_MIN };
