/**
 * Anchor a plan's years to the years its measures actually have.
 *
 * resolveRelativeYears (planner/index.js) turns "over the last decade" into
 * two loads of one measure, but it can only count back from the CALENDAR: in
 * 2026 that is 2016-2026, while ERS unemployment ends in 2023 and PLACES
 * changes vintage on its own schedule. "The last decade" of a measure is the
 * ten years ending at its latest release, which only the data knows. Same for
 * a named year the measure does not have ("since 2010" on a series that starts
 * in 2013): the load would return nothing, from a plan that validated.
 *
 * So, after validation, with real attribute ids:
 *   - a period counted back ("last 10 years") is re-counted from the measure's
 *     latest year, and its later end is set to that year explicitly;
 *   - a year the measure lacks is moved to the nearest year it has, and said.
 *
 * Returns { notes, errors }. Every change is a note for `adjustments`, because a period the
 * user did not literally ask for must be visible in the answer.
 *
 * @param yearsOf  async (census_code) => number[] of years with values
 * @param alternatives  optional async (back, excludeIds) =>
 *                  [{label, description, from, to}]: the OTHER candidates that
 *                  do span `back` years. Named in a period error so the repair
 *                  has somewhere to go: told only "use an attribute that has
 *                  values across the period", qwen3 re-picked the same
 *                  two-vintage series on every attempt and the question was
 *                  refused, while ERS unemployment, 2000-2023, was on its list
 *                  (r-unemp-decade, 2026-11-09).
 */
async function anchorYears(plan, resolved, yearsOf, { alternatives = null } = {}) {
  const notes = [];
  // A period the measure cannot span: it has one year, so "the last decade"
  // would read that year against itself and report zero change everywhere.
  // Observed: an ACS table with only 2018 planned as "2018-2018". Returned to
  // the repair loop, which can pick a measure that has the years.
  const errors = [];
  const loads = (plan.steps || []).filter(s => s.op === "load");
  for (const st of loads) {
    const back = st._back;
    delete st._back;
    const src = resolved.get(st.attr_id);
    if (!src || src.source_kind !== "acs_long") continue;
    const years = [...new Set(await yearsOf(src.census_code))].sort((a, b) => a - b);
    if (!years.length) continue;
    const latest = years[years.length - 1];
    const label = src.description || src.census_code;

    if (back !== undefined) {
      const want = latest - back;
      const got = nearest(years, want);
      // Much less than the asked span is a different question: "the last
      // decade" read as 2020-2025 on a measure with two vintages (CHR,
      // 2026-11-09). At least 70% of the period is required (a decade may be
      // read as 7+ years); reported for repair, with the years it does have.
      if (latest - got < back * 0.7) {
        let alts = [];
        if (alternatives) {
          try {
            alts = await alternatives(back, new Set(loads.map(l => l.attr_id)));
          } catch { alts = []; }
        }
        const named = alts.map(a =>
          `${a.label} "${String(a.description || "").slice(0, 80)}" (${a.from}-${a.to})`).join("; ");
        errors.push(
          `"${label}" has values for ${years.length === 1 ? `only ${latest}` : `${years.join(", ")}`}, ` +
          `so it cannot show a change over the last ${back} years. Use an attribute ` +
          (named
            ? `that has values across the period. These on the list do: ${named}.`
            : `that has values across the period, or say the change cannot be measured.`));
        continue;
      }
      const partner = loads.find(o => o !== st && o.attr_id === st.attr_id);
      st.year = got;
      if (partner && (partner.year === undefined || partner.year === null || partner._later)) {
        partner.year = latest;
      }
      notes.push(`"${label}" runs to ${latest}, so the last ${back} years were read as ` +
                 `${got}-${latest}${got !== want ? ` (${want} is not available)` : ""}`);
      continue;
    }
    if (Number.isInteger(st.year) && !years.includes(st.year)) {
      const got = nearest(years, st.year);
      st._asked = st.year;
      notes.push(`"${label}" has no ${st.year} figures; used ${got} ` +
                 `(available ${years[0]}-${latest})`);
      st.year = got;
    }
  }
  // Two DIFFERENT years asked of one measure, moved onto the SAME year: the
  // change between them reads as zero everywhere, from a plan that validated.
  // "Change in unemployment between 2019 and 2020" on SVI (2022 only) would
  // have done exactly that (2026-11-11). Refused, with the candidates that
  // have both years, like a period the measure cannot span.
  const byAttr = new Map();
  for (const st of loads) {
    if (!byAttr.has(st.attr_id)) byAttr.set(st.attr_id, []);
    byAttr.get(st.attr_id).push(st);
  }
  for (const [attrId, group] of byAttr) {
    const asked = [...new Set(group.map(st => st._asked ?? st.year).filter(Number.isInteger))];
    const used = new Set(group.map(st => st.year));
    if (asked.length < 2 || used.size > 1) continue;
    const src = resolved.get(attrId);
    const label = src?.description || src?.census_code || attrId;
    let alts = [];
    if (alternatives) {
      try { alts = await alternatives(null, new Set([attrId]), asked); } catch { alts = []; }
    }
    const named = alts.map(a =>
      `${a.label} "${String(a.description || "").slice(0, 80)}" (${a.from}-${a.to})`).join("; ");
    errors.push(
      `"${label}" has values for ${[...used][0]} only, so it cannot show a change between ` +
      `${asked.sort((a, b) => a - b).join(" and ")}. Use an attribute ` +
      (named ? `that has values in both years. These on the list do: ${named}.`
             : `that has values in both years, or say the change cannot be measured.`));
  }
  for (const st of loads) { delete st._later; delete st._asked; }
  return { notes, errors };
}

/** The available year closest to `want`; the earlier one on a tie. */
function nearest(years, want) {
  let best = years[0];
  for (const y of years) {
    if (Math.abs(y - want) < Math.abs(best - want)) best = y;
  }
  return best;
}

/**
 * Which `back`-year periods a measure can show: true when its own last
 * `back` years are at least 70% covered, the rule anchorYears applies.
 */
function spans(years, back) {
  if (years.length < 2) return null;
  const latest = years[years.length - 1];
  const got = nearest(years, latest - back);
  return latest - got >= back * 0.7 ? { from: got, to: latest } : null;
}

module.exports = { anchorYears, nearest, spans };
