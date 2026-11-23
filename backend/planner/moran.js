/**
 * Moran's I: global spatial autocorrelation as one number, and LISA
 * (local Moran's I) clusters as a per-unit class (docs/GIS_OPS_PLAN.md H6
 * tier 1, item 6).
 *
 * WHAT THE MODEL DECIDES: only that the answer is a `moran` step over one
 * series. Everything an analyst would call the method is code's, read from
 * the question here and echoed in the response:
 *   local         global I (one row) or LISA classes (one row per unit)
 *   alpha         significance level for a LISA class (0.05 unless stated)
 *   permutations  999 unless stated (GeoDa's and esda's convention)
 *   weights       queen contiguity, row-standardized. Rook, k-nearest,
 *                 distance bands and kernels are not built; a question (or a
 *                 paper) that names one is answered with queen and SAYS so.
 *
 * THE NUMBERS ARE esda's (PySAL), checked against esda 2.10.0 on the same
 * weights (eval/gis_ops/moran/): Moran(y, w, transformation="r") and
 * Moran_Local(y, w, transformation="r"), p_sim "directed" (the smaller tail,
 * which is what GeoDa reports). Exactly the same formulas, so I, E[I],
 * Var_rand, z and the local Is match to rounding; the permutation p-values
 * agree within Monte Carlo error (different random draws), not digit for digit.
 *
 * WHY NODE AND NOT SQL. The global statistic is a join and two aggregates
 * (correlate already computes it that way), but a pseudo p-value needs 999
 * permutations, and LISA's conditional permutation draws k_i random neighbours
 * for every unit, 999 times: ~19M draws for 3,233 counties. That is ~0.3 s in
 * a typed array and minutes as SQL. The plan's SQL fetches (fips, value); this
 * module turns those rows into the answer after execution, like `explain`.
 * The seed is fixed, so the same question gets the same p-values every time.
 *
 * Weights are built over the units IN THE INPUT: Moran's I for Texas uses
 * Texas counties and their Texas neighbours, which is what the question asked
 * (the same rule `neighbors` follows). A unit with no neighbour in the set is
 * an island: lag 0, no LISA class, and it still counts in n, as in esda.
 */

const { statesMentioned } = require("../states");

// --- phrasing -----------------------------------------------------------------

// Named outright: the statistic, the map, or its classes.
const EXPLICIT = /\bmoran'?s?\b|\blisa\b|\blocal\s+indicators?\s+of\s+spatial\s+association\b|\bspatial(?:ly)?\s+auto-?correlat\w*|\b(?:high|low)[-\s](?:high|low)\s+(?:cluster|outlier|area|count|region|spot)s?\b|\bspatial\s+outliers?\b/i;
// A yes/no question about clustering as a whole. "Where are the clusters" is
// hotspot's question and is deliberately not here.
const GLOBAL_CLUSTER = /\b(?:how|is|are|does|do)\b[^.?]*\b(?:spatially\s+clustered|clustered\s+or\s+(?:random\w*|dispersed|spread)|random(?:ly)?\s+distributed|spatial\s+(?:clustering|dependence))\b/i;

/** Whether the question asks for Moran's I or LISA. */
const asksMoran = (q) => EXPLICIT.test(String(q || "")) || GLOBAL_CLUSTER.test(String(q || ""));

const LOCAL = /\blisa\b|\blocal\s+(?:moran|indicators?|spatial|autocorrelation|cluster)|\b(?:high|low)[-\s](?:high|low)\b|\bspatial\s+outliers?\b|\bcluster\s+map\b|\b(?:where|which\s+(?:count(?:y|ies)|areas?|parts?|regions?|tracts?|places?))\b/i;
const GLOBAL = /\bglobal\b|\boverall\b|\bmoran'?s?\s+i\b/i;
const LOCAL_MORAN_ONLY = /\blocal\s+moran'?s?\s+i\b/i;

/**
 * "global" | "local" | "both". Both only when the question names each:
 * "global Moran's I and the LISA clusters" (a paper's usual pair).
 */
function readMode(query) {
  const q = String(query || "");
  const local = LOCAL.test(q);
  const global = GLOBAL.test(q.replace(LOCAL_MORAN_ONLY, " ")) || GLOBAL_CLUSTER.test(q);
  if (local && global && /\b(?:global|overall)\b/i.test(q)) return "both";
  if (local && global && /\bmoran'?s?\s+i\b/i.test(q.replace(LOCAL_MORAN_ONLY, " ")) &&
      /\blisa\b|\bcluster\s+map\b|\b(?:high|low)[-\s](?:high|low)\b/i.test(q)) return "both";
  return local ? "local" : "global";
}

/** A stated significance level, else 0.05. */
function readAlpha(query) {
  const q = String(query || "");
  let m = q.match(/\bp\s*(?:<|<=|≤|less\s+than|below)\s*(0?\.\d+)/i)
       || q.match(/\b(?:significance|alpha|α)\s*(?:level\s*)?(?:of|=|at)?\s*(0?\.\d+)/i)
       || q.match(/\bat\s+(?:the\s+)?(0?\.\d+)\s+level\b/i);
  if (m) {
    const a = Number(m[1]);
    if (a > 0 && a <= 0.5) return a;
  }
  m = q.match(/\b(90|95|99|99\.9)\s*%\s*(?:confidence|significance|level)/i);
  if (m) return Math.round((1 - Number(m[1]) / 100) * 1e4) / 1e4;
  return 0.05;
}

/** Stated permutations ("9999 permutations"), else 999. Capped at 9,999. */
function readPermutations(query) {
  const m = String(query || "").match(/\b(\d{2,5}|[\d,]{3,6})\s+(?:random\s+)?permutations?\b/i);
  if (!m) return 999;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isInteger(n) && n >= 99 ? Math.min(n, 9999) : 999;
}

// Weights the question (or a paper) may name. Only queen is built.
const OTHER_WEIGHTS = [
  [/\brook\b/i, "rook contiguity"],
  [/\bk[-\s]?nearest|\bknn\b|\b\d+\s+nearest\s+neighbou?rs?\b/i, "k-nearest-neighbour weights"],
  [/\bdistance[-\s]band|\bfixed\s+distance|\bthreshold\s+distance/i, "distance-band weights"],
  [/\binverse[-\s]distance\b/i, "inverse-distance weights"],
  [/\bkernel\b/i, "kernel weights"],
];
function unsupportedWeights(query) {
  return OTHER_WEIGHTS.filter(([re]) => re.test(String(query || ""))).map(([, name]) => name);
}

// Gi* named outright: hotspot was the right op.
const ASKS_GISTAR = /\bgi\*|\bgetis|\bhot\s?spots?\b|\bcold\s?spots?\b/i;

// --- plan repairs -----------------------------------------------------------------

const NATIONAL = /\bnational(?:ly)?\b|\bacross\s+the\s+(?:us|u\.s\.|country|nation)\b|\bthe\s+whole\s+country\b/i;

const freshId = (steps, base) => {
  const ids = new Set(steps.map(s => s.id));
  let id = base;
  for (let k = 2; ids.has(id); k++) id = `${base}${k}`;
  return id;
};

/**
 * Hotspot (or outlier) where the question named Moran's I / LISA: swap the op.
 * The model reads "clusters" and reaches for hotspot, which is a different
 * statistic (Gi*); a paper's "LISA" is not reproduced by it.
 */
function swapToMoran(plan, query) {
  const fixes = [];
  const q = String(query || "");
  for (const s of plan.steps || []) {
    if (s.op === "hotspot" && EXPLICIT.test(q) && !ASKS_GISTAR.test(q)) {
      s.op = "moran";
      fixes.push(`used Moran's I instead of Getis-Ord Gi*, which the question did not ask for`);
    } else if (s.op === "outlier" && /\bspatial\s+outliers?\b/i.test(q)) {
      s.op = "moran";
      fixes.push(`used LISA for "spatial outliers" (a unit unlike its neighbours), not a distribution outlier`);
    }
  }
  return fixes;
}

/**
 * The question asks for Moran's I and the plan maps the measure without it
 * (load -> output, or a place filter in between): insert the step before the
 * output. Only when exactly one output reads a series and nothing statistical
 * is in the plan, so a plan that answered some other way is left alone.
 */
const STAT_OPS = new Set(["moran", "hotspot", "outlier", "correlate", "explain", "compare_groups",
  "neighbors", "residual", "composite", "intersect"]);
function insertMoran(plan, query, stepTypes) {
  const steps = plan.steps || [];
  if (steps.some(s => STAT_OPS.has(s.op))) return null;
  const outs = steps.filter(s => s.op === "output");
  if (outs.length !== 1) return null;
  const src = (outs[0].inputs || [])[0];
  const types = stepTypes ? stepTypes(steps) : null;
  if (types && types.get(src) !== "series") return null;
  const id = freshId(steps, "s_moran");
  steps.splice(steps.indexOf(outs[0]), 0, { id, op: "moran", attr_id: "", inputs: [src] });
  outs[0].inputs = [id];
  return "added Moran's I, which the question asks for and the plan had left out";
}

/**
 * Filters and ranks after the moran step move before it: Moran's I "in Texas"
 * is computed over Texas counties. Mirrors composite's scoreWithinArea.
 */
function scoreWithinArea(plan, query) {
  if (NATIONAL.test(String(query || ""))) return [];
  const steps = plan.steps || [];
  const fixes = [];
  for (const m of steps.filter(s => s.op === "moran")) {
    for (;;) {
      const f = steps.find(s => ["filter_area", "filter_place"].includes(s.op) && (s.inputs || [])[0] === m.id);
      if (!f || !(m.inputs || []).length) break;
      const moved = { ...f, inputs: [m.inputs[0]] };
      for (const s of steps) s.inputs = (s.inputs || []).map(i => (i === f.id ? m.id : i));
      steps.splice(steps.indexOf(f), 1);
      steps.splice(steps.indexOf(m), 0, moved);
      m.inputs = [moved.id];
      const where = f.op === "filter_area" ? (f.states || []).join(", ") : f.place_name;
      fixes.push(`computed Moran's I over ${where} only, with neighbours inside it`);
    }
  }
  return fixes;
}

/** One named state and no place step at all: add it before the moran step. */
function restrictToNamedArea(plan, query) {
  return require("./area").restrictToNamedArea(plan, query, {
    op: "moran", national: NATIONAL, because: "restricted Moran's I to",
  });
}

/** "Both": a second moran step over the same input, with its own output. */
function addSecondMode(plan) {
  const steps = plan.steps || [];
  const m = steps.find(s => s.op === "moran");
  if (!m || steps.filter(s => s.op === "moran").length > 1) return null;
  const id = freshId(steps, `${m.id}_lisa`);
  const outId = freshId(steps, `${id}_out`);
  const lisa = { ...m, id, local: true };
  m.local = false;
  steps.push(lisa, { id: outId, op: "output", attr_id: "", inputs: [id] });
  return "added the LISA cluster map beside the global statistic, since the question asks for both";
}

/**
 * Set the method on every moran step from the question, and repair the plan
 * around it. Returns { fixes, notes } or null when there is nothing to do.
 * A field already set (a paper template, or a follow-up edit) is kept.
 */
function applyMoran(plan, query, { stepTypes } = {}) {
  const fixes = [...swapToMoran(plan, query)];
  const notes = [];
  if (!(plan.steps || []).some(s => s.op === "moran")) {
    if (!asksMoran(query)) return fixes.length ? { fixes, notes } : null;
    const ins = insertMoran(plan, query, stepTypes);
    if (!ins) return fixes.length ? { fixes, notes } : null;
    fixes.push(ins);
  }
  fixes.push(...scoreWithinArea(plan, query));
  const area = restrictToNamedArea(plan, query);
  if (area) fixes.push(area);
  const mode = readMode(query);
  const alpha = readAlpha(query), permutations = readPermutations(query);
  for (const m of plan.steps.filter(s => s.op === "moran")) {
    if (m.local === undefined) m.local = mode === "local";
    if (m.alpha === undefined) m.alpha = alpha;
    if (m.permutations === undefined) m.permutations = permutations;
    if (m.weights === undefined) m.weights = "queen";
  }
  if (mode === "both") {
    const b = addSecondMode(plan);
    if (b) fixes.push(b);
  }
  for (const m of plan.steps.filter(s => s.op === "moran")) fixes.push(describe(m));
  const other = unsupportedWeights(query);
  if (other.length) {
    notes.push(`${other.join(", ")} ${other.length > 1 ? "are" : "is"} not built; queen contiguity ` +
               `(counties sharing a border or a corner) was used instead, so the result approximates the one asked for`);
  }
  return { fixes, notes };
}

/** The echo: what was computed, readable enough to change. */
function describe(step) {
  const w = "queen contiguity, row-standardized";
  return step.local
    ? `LISA (local Moran's I), ${w}; a class needs pseudo p < ${step.alpha} over ` +
      `${step.permutations} conditional permutations`
    : `global Moran's I, ${w}; pseudo p over ${step.permutations} permutations, ` +
      `and the normal approximation under randomization`;
}

// --- the statistics ---------------------------------------------------------------

/** Deterministic PRNG (mulberry32): the same question gives the same p-values. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal upper tail, via erfc (Abramowitz & Stegun 7.1.26).
function normSf(z) {
  const u = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * u);
  const erfc = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
                0.254829592) * t * Math.exp(-u * u);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * Units, values and row-standardized neighbour lists, over the units present.
 * @param rows       [{fips, value}] (value null rows are dropped)
 * @param neighbors  Map<fips, fips[]> (both directions, as county_neighbors)
 */
function weightsFor(rows, neighbors) {
  const units = [], y = [];
  for (const r of rows) {
    const v = r.value === null || r.value === undefined ? NaN : Number(r.value);
    if (r.fips && Number.isFinite(v)) { units.push(String(r.fips)); y.push(v); }
  }
  const index = new Map(units.map((u, i) => [u, i]));
  const nb = units.map((u) => {
    const seen = new Set();
    for (const v of neighbors.get(u) || []) {
      const j = index.get(String(v));
      if (j !== undefined && j !== index.get(u)) seen.add(j);
    }
    return Int32Array.from(seen);
  });
  return { units, y: Float64Array.from(y), nb };
}

// Directed pseudo p (esda's default for LISA, and what GeoDa reports): the
// smaller tail, (M + 1) / (R + 1), with M = #(sim >= obs) or R minus that.
// Ties count on the high side only, exactly as esda: with one neighbour and
// values rounded to 0.1 (unemployment), a third of draws can tie, and counting
// them in both tails moved p by 0.03-0.06 on 8 counties (eval/gis_ops/moran).
function pseudoP(obs, sims) {
  let ge = 0;
  for (const s of sims) if (s >= obs) ge++;
  return (Math.min(ge, sims.length - ge) + 1) / (sims.length + 1);
}

/**
 * Global Moran's I, as esda.Moran(y, w, transformation="r").
 * Returns { I, expected, variance, z, p_value, p_sim, permutations, n, n_islands }.
 */
function globalMoran(rows, neighbors, { permutations = 999, seed = 12345 } = {}) {
  const { y, nb } = weightsFor(rows, neighbors);
  const n = y.length;
  if (n < 4) return null;
  let mean = 0;
  for (const v of y) mean += v;
  mean /= n;
  const z = Float64Array.from(y, v => v - mean);
  let z2 = 0, z4 = 0;
  for (const v of z) { z2 += v * v; z4 += v * v * v * v; }
  if (!(z2 > 0)) return null;

  // Row-standardized weights: w_ij = 1/k_i for each neighbour.
  let s0 = 0, s1 = 0, s2 = 0, islands = 0;
  const colSum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = nb[i].length;
    if (!k) { islands++; continue; }
    s0 += 1;
    for (const j of nb[i]) colSum[j] += 1 / k;
  }
  for (let i = 0; i < n; i++) {
    const ki = nb[i].length;
    for (const j of nb[i]) {
      const kj = nb[j].length;
      const wij = 1 / ki, wji = kj && nb[j].includes(i) ? 1 / kj : 0;
      s1 += (wij + wji) ** 2;
    }
    s2 += ((ki ? 1 : 0) + colSum[i]) ** 2;
  }
  s1 /= 2;

  const stat = (zz) => {
    let num = 0;
    for (let i = 0; i < n; i++) {
      const k = nb[i].length;
      if (!k) continue;
      let lag = 0;
      for (const j of nb[i]) lag += zz[j];
      num += zz[i] * lag / k;
    }
    return (n / s0) * num / z2;
  };
  const I = stat(z);
  const EI = -1 / (n - 1);
  const s02 = s0 * s0, n2 = n * n;
  const k = (z4 / n) / ((z2 / n) ** 2);
  const A = n * ((n2 - 3 * n + 3) * s1 - n * s2 + 3 * s02);
  const B = k * ((n2 - n) * s1 - 2 * n * s2 + 6 * s02);
  const VI = (A - B) / ((n - 1) * (n - 2) * (n - 3) * s02) - EI * EI;
  const zr = (I - EI) / Math.sqrt(VI);

  let p_sim = null;
  if (permutations > 0) {
    const r = rng(seed), perm = Float64Array.from(z), sims = new Float64Array(permutations);
    for (let p = 0; p < permutations; p++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
      }
      sims[p] = stat(perm);
    }
    p_sim = pseudoP(I, sims);
  }
  return {
    I, expected: EI, variance: VI, z: zr,
    // Two-sided under randomization, as esda's p_rand.
    p_value: 2 * normSf(Math.abs(zr)),
    p_sim, permutations, n, n_islands: islands,
  };
}

// esda's quadrant codes, and the signed value each class is drawn with:
// HH +2 (deep red), HL +1, not significant 0 (neutral), LH -1, LL -2 (deep
// blue). The standard LISA cluster map, as a diverging series.
const CLASS = {
  1: { label: "High-High", value: 2 },
  2: { label: "Low-High", value: -1 },
  3: { label: "Low-Low", value: -2 },
  4: { label: "High-Low", value: 1 },
};
const CLASSES = [
  { value: 2, label: "High-High (a high value among high neighbours)" },
  { value: 1, label: "High-Low (a high value among low neighbours)" },
  { value: 0, label: "Not significant" },
  { value: -1, label: "Low-High (a low value among high neighbours)" },
  { value: -2, label: "Low-Low (a low value among low neighbours)" },
];

/**
 * Local Moran's I, as esda.Moran_Local(y, w, transformation="r"): z is
 * standardized by the population sd, Is = (n - 1) z_i lag_i / sum(z^2),
 * conditional permutation (the unit's own value held, k_i others drawn
 * without replacement), directed pseudo p, class when p < alpha.
 *
 * Returns { rows: [{fips, value, lisa_class, local_i, lag, p_sim, quadrant}],
 *           summary: {n, n_islands, counts, alpha, permutations, expected_false} }.
 */
function localMoran(rows, neighbors, { permutations = 999, alpha = 0.05, seed = 12345 } = {}) {
  const { units, y, nb } = weightsFor(rows, neighbors);
  const n = y.length;
  if (n < 4) return null;
  let mean = 0;
  for (const v of y) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of y) ss += (v - mean) ** 2;
  const sd = Math.sqrt(ss / n);
  if (!(sd > 0)) return null;
  const z = Float64Array.from(y, v => (v - mean) / sd);
  let den = 0;
  for (const v of z) den += v * v;
  const scale = (n - 1) / den;

  const lagOf = (i) => {
    const k = nb[i].length;
    if (!k) return 0;
    let s = 0;
    for (const j of nb[i]) s += z[j];
    return s / k;
  };

  const r = rng(seed);
  // Indices of every unit; a partial Fisher-Yates over it draws a uniform
  // k-subset whatever order it was left in, so it is never reset.
  const pool = Int32Array.from({ length: n }, (_, i) => i);
  const out = [];
  const counts = { "High-High": 0, "Low-Low": 0, "High-Low": 0, "Low-High": 0, "Not significant": 0, "No neighbours": 0 };
  for (let i = 0; i < n; i++) {
    const k = nb[i].length;
    const lag = lagOf(i);
    const Ii = scale * z[i] * lag;
    const q = z[i] > 0 ? (lag > 0 ? 1 : 4) : (lag > 0 ? 2 : 3);
    if (!k) {
      out.push({ fips: units[i], value: 0, lisa_class: "No neighbours", local_i: 0, lag: 0, p_sim: null, quadrant: null });
      counts["No neighbours"]++;
      continue;
    }
    let p = null;
    if (permutations > 0) {
      // Move unit i to the end so draws come from the other n - 1.
      const at = pool.indexOf(i);
      pool[at] = pool[n - 1]; pool[n - 1] = i;
      let ge = 0;
      for (let t = 0; t < permutations; t++) {
        let s = 0;
        for (let d = 0; d < k; d++) {
          const j = d + Math.floor(r() * (n - 1 - d));
          const tmp = pool[d]; pool[d] = pool[j]; pool[j] = tmp;
          s += z[pool[d]];
        }
        const sim = scale * z[i] * (s / k);
        if (sim >= Ii) ge++;
      }
      p = (Math.min(ge, permutations - ge) + 1) / (permutations + 1);
    }
    const sig = p !== null && p < alpha;
    const label = sig ? CLASS[q].label : "Not significant";
    counts[label]++;
    out.push({ fips: units[i], value: sig ? CLASS[q].value : 0, lisa_class: label,
               local_i: Ii, lag, p_sim: p, quadrant: CLASS[q].label });
  }
  return {
    rows: out,
    summary: {
      n, n_islands: counts["No neighbours"], counts, alpha, permutations,
      // About alpha x n units clear the bar by chance alone; said, not hidden.
      expected_false: Math.round(alpha * (n - counts["No neighbours"])),
    },
  };
}

module.exports = {
  asksMoran, readMode, readAlpha, readPermutations, unsupportedWeights,
  applyMoran, swapToMoran, insertMoran, restrictToNamedArea, describe,
  globalMoran, localMoran, weightsFor, pseudoP, normSf, rng, CLASSES,
};
