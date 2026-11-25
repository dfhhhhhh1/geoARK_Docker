/**
 * What a composite score is made of, per input, for every composite answer
 * (count or weighted, any level), from chat or from a paper reproduction.
 *
 * A composite is one number from several measures, and the reader's next
 * question is always which of them drive it. The literature answers it with a
 * correlation of the score with each component, often split into rural and
 * urban units (deprivation and inequity indices; e.g. Khairat et al. 2019,
 * JAMIA, Table 3). So each composite layer carries, per input:
 *
 *   pearson / spearman   of the score with the input's RAW value
 *   flagged              units past the input's threshold (count method only)
 *
 * for all units, and for rural and urban units when a population is known at
 * the plan's level. Rural is the common density rule, fewer than 100 people
 * per square mile of land: WorldPop population over geo_unit's land area, both
 * of which exist at every level GeoARK loads, so it works for counties,
 * tracts, ZIP code areas and grid cells alike. The rule is reported with the
 * numbers, never implied.
 *
 * Nothing here changes the score or the map. It reads the part layers the
 * compiler already returns for a composite's inputs (planner/compile.js
 * SHOW_PARTS), so it costs one small density query and arithmetic.
 */

const RURAL_DENSITY = 100;            // people per square mile of land
const SQ_M_PER_SQ_MI = 2589988.110336;
const MIN_N = 5;                      // fewer pairs than this: no coefficient

function pearson(xs, ys) {
  const n = xs.length;
  if (n < MIN_N) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  // A constant input (every unit flagged, or one value) has no correlation.
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Ranks with ties averaged (1-based). */
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
const spearman = (xs, ys) => (xs.length < MIN_N ? null : pearson(ranks(xs), ranks(ys)));
const round = (x, d = 3) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

const COMPARE = {
  ">": (a, b) => a > b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, "<=": (a, b) => a <= b,
};

/**
 * Pure. Everything is passed in, so it is tested without a database.
 *
 * @param score   Map<unit id, number>  the composite's value per unit
 * @param inputs  [{ step, name, values: Map<unit id, number>, threshold?, direction?, weight? }]
 * @param density Map<unit id, people per sq mi> | null
 * @param method  the composite's method
 */
function diagnose({ score, inputs, density = null, method = "sum" }) {
  const units = [...score.keys()].filter(u => Number.isFinite(score.get(u)));
  const strata = [{ name: "all", label: "all units", units }];
  if (density && density.size) {
    const known = units.filter(u => Number.isFinite(density.get(u)));
    const rural = known.filter(u => density.get(u) < RURAL_DENSITY);
    const urban = known.filter(u => density.get(u) >= RURAL_DENSITY);
    if (rural.length >= MIN_N && urban.length >= MIN_N) {
      strata.push({ name: "rural", label: `rural (under ${RURAL_DENSITY} people per sq mi)`, units: rural });
      strata.push({ name: "urban", label: `urban (${RURAL_DENSITY} or more people per sq mi)`, units: urban });
    }
  }
  const mean = (us) => (us.length ? us.reduce((a, u) => a + score.get(u), 0) / us.length : null);
  return {
    method,
    rural_rule: strata.length > 1
      ? `fewer than ${RURAL_DENSITY} people per square mile of land (WorldPop population / land area)` : null,
    strata: strata.map(s => ({ name: s.name, label: s.label, n: s.units.length, mean_score: round(mean(s.units), 2) })),
    components: inputs.map(inp => {
      const t = inp.threshold && COMPARE[inp.threshold.operator] ? inp.threshold : null;
      const by = {};
      for (const s of strata) {
        const us = s.units.filter(u => Number.isFinite(inp.values.get(u)));
        const xs = us.map(u => inp.values.get(u)), ys = us.map(u => score.get(u));
        by[s.name] = {
          n: us.length,
          pearson: round(pearson(xs, ys)),
          spearman: round(spearman(xs, ys)),
          ...(t ? { flagged: us.filter(u => COMPARE[t.operator](inp.values.get(u), Number(t.value))).length } : {}),
        };
      }
      return {
        step: inp.step, name: inp.name,
        ...(t ? { threshold: { operator: t.operator, value: Number(t.value) } } : {}),
        ...(inp.direction ? { direction: inp.direction } : {}),
        ...(Number.isFinite(inp.weight) ? { weight: inp.weight } : {}),
        by,
      };
    }),
  };
}

/** People per square mile per unit at `level`, or an empty Map. Read-only SQL. */
async function densityFor(client, level, unitIds) {
  if (!unitIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT DISTINCT ON (u.geoid) u.geoid, v.value / NULLIF(u.aland / ${SQ_M_PER_SQ_MI}, 0) AS d
       FROM geo_unit u
       JOIN geo_values_all v ON v.level = u.level AND v.geoid = u.geoid AND v.code = 'WORLDPOP_POP'
      WHERE u.level = $1 AND u.geoid = ANY($2)
      ORDER BY u.geoid, v.year DESC`, [level, unitIds]);
  return new Map(rows.filter(r => r.d !== null).map(r => [r.geoid, Number(r.d)]));
}

/**
 * Attach `components` to every composite layer of an executed plan, in place.
 * Failure is reported on the layer and never costs the answer.
 *
 * @param nameOf  (stepId) -> human name of that input
 */
async function attach({ client, plan, layers, level = "county", nameOf = (id) => id }) {
  const byId = new Map((plan.steps || []).map(s => [s.id, s]));
  for (const layer of layers) {
    if (!layer || layer.part || layer.diagnostic || layer.composite !== true || !Array.isArray(layer.rows)) continue;
    const comp = findComposite(byId, layer.step);
    if (!comp) continue;
    try {
      // Behind a rank or filter the layer holds only the kept units; the
      // compiler then returns the full score as a `diagnostic` layer.
      const full = layers.find(l => l.diagnostic && l.step === comp.id);
      const scoreRows = (full || layer).rows;
      const score = new Map(scoreRows.filter(r => r.value !== null).map(r => [String(r.fips), Number(r.value)]));
      const parts = new Map(layers.filter(l => l.part && !l.diagnostic).map(l => [l.step, l]));
      const inputs = (comp.inputs || []).map((id, i) => {
        const part = parts.get(id);
        if (!part) return null;
        return {
          step: id, name: nameOf(id),
          values: new Map(part.rows.filter(r => r.value !== null).map(r => [String(r.fips), Number(r.value)])),
          threshold: comp.method === "count" ? comp.thresholds?.[i] : null,
          direction: comp.directions?.[i],
          weight: comp.method === "count" ? undefined : comp.weights?.[i],
        };
      }).filter(Boolean);
      if (!inputs.length) continue;
      // Under a savepoint: a failed statement would otherwise abort the
      // answer's whole read-only transaction at COMMIT.
      let density = null;
      try {
        await client.query("SAVEPOINT composite_density");
        density = await densityFor(client, level, [...score.keys()]);
        await client.query("RELEASE SAVEPOINT composite_density");
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT composite_density").catch(() => {});
        density = null;
      }
      layer.components = diagnose({ score, inputs, density, method: comp.method || "sum" });
    } catch (err) {
      layer.components = { error: err.message };
    }
  }
}

/** The composite step an output layer shows, through pass-through ops (rank, filters). */
function findComposite(byId, stepId) {
  let st = byId.get(stepId);
  for (let hops = 0; st && hops < 8; hops++) {
    if (st.op === "composite") return st;
    if ((st.inputs || []).length !== 1) return null;
    st = byId.get(st.inputs[0]);
  }
  return null;
}

module.exports = { diagnose, attach, densityFor, findComposite, pearson, spearman, ranks, RURAL_DENSITY };
