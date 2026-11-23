/**
 * Raster conditions mapped as polygons (ops/raster_calc.js): "map where
 * forest became developed land in St. Louis County between 2001 and 2021",
 * "show the areas of St. Louis with slope over 15 percent", "where in St.
 * Louis County is the land above 180 meters with slope under 5 percent".
 *
 * The model never sees raster_calc. It plans zonal steps for these questions,
 * as it does for "how much land per county is steep"; code has already set
 * their year, classes and threshold (fillRasterClasses, applyRasterMeasures,
 * yearAsVintage). When the question asks WHERE inside one named county, city
 * or zone set, rather than how much per unit, those conditions are rebuilt
 * into one raster_calc step. A question that names units ("each county", "by
 * ward"), a state, or no place keeps its zonal plan: per-unit shares are the
 * right answer there, and a state is too many pixels to draw.
 */

const WHERE = /\b(?:map|show|draw|where|locate|identify|highlight|outline|find)\b/i;
const AREA_NOUN = /\b(?:areas?|land|places?|parts?|patch(?:es)?|pixels?|spots?|locations?|footprint|extent)\b/i;
const WHERE_Q = /\bwhere\s+(?:did|does|do|was|were|is|are|has|have|in)\b/i;
const PER_UNIT = /\b(?:each|every|per|by)\s+(?:county|counties|tract|tracts|ward|wards|neighbou?rhoods?|zip|zips|community|communities|unit|units|state|states|city|cities|campus|campuses|site|sites|block\s+groups?)\b/i;
const HOW_MUCH = /\b(?:how\s+much|how\s+many|what\s+(?:share|percent(?:age)?|proportion|fraction)|total\s+(?:area|acres))\b/i;

function asksRasterWhere(query) {
  const q = String(query || "");
  if (PER_UNIT.test(q) || HOW_MUCH.test(q)) return false;
  return WHERE_Q.test(q) || (WHERE.test(q) && AREA_NOUN.test(q));
}

// "from forest to developed", "forest became / turned into / converted to developed".
const TRANSITION = [
  /\bfrom\s+([a-z][a-z ,/-]*?)\s+(?:land\s+|cover\s+)?(?:to|into)\s+([a-z][a-z ,/-]*?)(?=\s+(?:land|cover|between|from|in|since|during|by)\b|[?.,;!]|$)/i,
  /\b([a-z][a-z/-]*(?:\s+[a-z][a-z/-]*)?)\s+(?:land\s+)?(?:became|become|becomes|turned\s+into|turn\s+into|was\s+converted\s+to|converted\s+to|changed\s+to|was\s+replaced\s+by|lost\s+to)\s+([a-z][a-z ,/-]*?)(?=\s+(?:land|cover|between|from|in|since|during|by)\b|[?.,;!]|$)/i,
];

/** Class codes of a categorical raster that a phrase names (group first, then label). */
function classesNamed(phrase, src) {
  const words = new Set(String(phrase || "").toLowerCase().match(/[a-z]+/g) || []);
  const stem = (w) => w.replace(/(?:ies|es|s)$/, "");
  const has = (w) => words.has(w) || [...words].some(x => stem(x) === stem(w) || (x.startsWith(stem(w)) && stem(w).length > 3));
  const allIn = (t) => { const ws = String(t || "").toLowerCase().match(/[a-z]+/g) || []; return ws.length > 0 && ws.every(has); };
  const cls = src.classes || [];
  const byGroup = cls.filter(c => c.grp && allIn(c.grp));
  const hit = byGroup.length ? byGroup : cls.filter(c => allIn(c.label));
  return { codes: [...new Set(hit.map(c => Number(c.value)))], names: [...new Set(hit.map(c => c.grp && byGroup.length ? c.grp : c.label))] };
}

/** One zonal step's condition: {classes, names} or {operator, value}, or null. */
function conditionOf(st, src) {
  if (st.attribute_filters?.length) {
    if (st.attribute_filters.some(f => f.negate === true)) return null;
    const codes = new Set(), names = [];
    for (const f of st.attribute_filters) {
      const v = String(f.value || "").toLowerCase();
      const hit = (src.classes || []).filter(c => String(c.label).toLowerCase() === v || String(c.grp || "").toLowerCase() === v);
      if (!hit.length) return null;
      hit.forEach(c => codes.add(Number(c.value)));
      names.push(f.value);
    }
    return { classes: [...codes], names };
  }
  if (st.operator !== undefined && st.value !== undefined && Number.isFinite(Number(st.value))) {
    return { operator: st.operator, value: Number(st.value) };
  }
  return null;
}

const nameOf = (src) => String(src.label || src.description || "raster")
  .split(/[.(,;]|\s+(?:of|from|in|or|derived)\s+/)[0].trim().slice(0, 40);

function describeTerm(src, cond, year) {
  const yr = year ? ` (${year})` : "";
  if (cond.classes) return `${cond.names.join(" or ")}${yr}`;
  return `${nameOf(src).toLowerCase()} ${cond.operator} ${cond.value}${src.units ? ` ${src.units}` : ""}${yr}`;
}

/**
 * @param srcOf (attr_id) => resolved raster row (classes, layers, units)
 * @returns a description, or null (plan untouched)
 */
function applyRasterCalc(plan, query, srcOf) {
  const q = String(query || "");
  if (!asksRasterWhere(q)) return null;
  const steps = plan.steps || [];
  const zonal = steps.filter(s => s.op === "zonal" && !(s.inputs || []).length);
  if (!zonal.length || zonal.length > 2) return null;
  if (steps.some(s => s.op === "zonal" && (s.inputs || []).length)) return null;
  // The area: one named county or place, or the plan's zone set.
  const fp = steps.find(s => s.op === "filter_place" && s.place_name);
  let area = null;
  if (fp) {
    area = (fp.place_kind || "place") === "county"
      ? { kind: "county", name: fp.place_name, ...(fp.states?.length ? { states: fp.states } : {}) }
      : { kind: "place", place_kind: fp.place_kind || "place", name: fp.place_name, ...(fp.states?.length ? { states: fp.states } : {}) };
  } else if (/^z_/.test(String(plan.level || ""))) {
    area = { kind: "zones", level: plan.level };
  }
  if (!area) return null;

  const srcs = zonal.map(z => srcOf(z.attr_id));
  if (srcs.some(s => !s || !(s.pixel_area_m2 > 0))) return null;
  let conds = zonal.map((z, i) => conditionOf(z, srcs[i]));
  // A change of class: the earlier year reads the FROM classes, the later
  // the TO classes. fillRasterClasses gave both steps every class the
  // question names, which for a transition is both ends at once.
  const tr = TRANSITION.map(re => q.match(re)).find(Boolean);
  if (zonal.length === 2 && zonal[0].attr_id === zonal[1].attr_id && srcs[0].raster_kind === "categorical") {
    if (!tr) return null;
    const order = [0, 1].sort((a, b) => Number(zonal[a].year || 0) - Number(zonal[b].year || 0));
    const from = classesNamed(tr[1], srcs[0]), to = classesNamed(tr[2], srcs[0]);
    if (!from.codes.length || !to.codes.length || Number(zonal[order[0]].year) === Number(zonal[order[1]].year)) return null;
    conds = [];
    conds[order[0]] = { classes: from.codes, names: from.names };
    conds[order[1]] = { classes: to.codes, names: to.names };
    zonal.splice(0, 2, zonal[order[0]], zonal[order[1]]);
    conds = [conds[order[0]], conds[order[1]]];
    srcs.splice(0, 2, srcs[order[0]], srcs[order[1]]);
  }
  if (conds.some(c => !c)) return null;

  const [a, b] = zonal;
  const term = (c, sfx) => (c.classes ? { [`classes${sfx}`]: c.classes } : { [`operator${sfx}`]: c.operator, [`value${sfx}`]: c.value });
  const label = zonal.map((z, i) => describeTerm(srcs[i], conds[i], z.year)).join(tr && zonal.length === 2 ? " to " : " and ");
  plan.steps = [
    { id: "rc", op: "raster_calc", attr_id: a.attr_id, inputs: [], ...(a.year ? { year: a.year } : {}), ...term(conds[0], ""),
      ...(b ? { attr_id_b: b.attr_id, ...(b.year ? { year_b: b.year } : {}), ...term(conds[1], "_b") } : {}),
      area, label },
    { id: "out", op: "output", attr_id: "", inputs: ["rc"] },
  ];
  plan.output_type = "map";
  delete plan.level;
  const where = area.kind === "zones" ? `all of ${area.level}` : `${area.name}${area.states?.length ? `, ${area.states.join(", ")}` : ""}`;
  return `mapped where ${label} in ${where}: each pixel tested at full resolution, area counted from the pixels, ` +
    `drawn at a coarser display cell`;
}

module.exports = { asksRasterWhere, applyRasterCalc, classesNamed };
