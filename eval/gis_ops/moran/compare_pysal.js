/**
 * The `moran` op's statistics (backend/planner/moran.js) against PySAL.
 *
 *   node compare_pysal.js <data_dir> <pysal.json> [out.json]
 *
 * Deterministic quantities (global I, E[I], Var_rand, z, p_rand; every local
 * Is and quadrant) must match esda to floating-point rounding. Pseudo p-values
 * come from different random draws, so they are compared statistically: the
 * difference of two independent estimates over R permutations has sd
 * sqrt(2 p (1-p) / R), and more than a handful beyond 4 sd would be a defect.
 */
const fs = require("fs");
const path = require("path");
const M = require(path.resolve(__dirname, "../../../backend/planner/moran.js"));

const [dataDir, goldPath, outPath] = process.argv.slice(2);
const gold = JSON.parse(fs.readFileSync(goldPath, "utf8"));
const R = gold.permutations;

const csv = (f) => fs.readFileSync(path.join(dataDir, f), "utf8").trim().split(/\r?\n/).slice(1)
  .map(l => l.split(","));
const neighbors = new Map();
for (const [a, b] of csv("neighbors.csv")) {
  if (!neighbors.has(a)) neighbors.set(a, []);
  neighbors.get(a).push(b);
}

const report = { esda: gold.esda, permutations: R, cases: {} };
let bad = 0;
for (const [name, c] of Object.entries(gold.cases)) {
  const rows = csv(c.file).filter(([f]) => !c.state || f.startsWith(c.state)).map(([fips, v]) => ({ fips, value: Number(v) }));
  const t0 = Date.now();
  const g = M.globalMoran(rows, neighbors, { permutations: R, seed: 7 });
  const tg = Date.now() - t0;
  const t1 = Date.now();
  const l = M.localMoran(rows, neighbors, { permutations: R, alpha: 0.05, seed: 7 });
  const tl = Date.now() - t1;

  const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  const globalDiff = {
    I: rel(g.I, c.global.I), EI: rel(g.expected, c.global.EI), VI_rand: rel(g.variance, c.global.VI_rand),
    z_rand: rel(g.z, c.global.z_rand), p_rand: Math.abs(g.p_value - c.global.p_rand),
    p_sim: Math.abs(g.p_sim - c.global.p_sim),
  };
  const byVal = new Map(rows.map(r => [r.fips, r.value]));
  let tieExplained = 0;
  let maxIs = 0, quadMismatch = 0, beyond4 = 0, maxP = 0, sumP = 0, classAgree = 0, classDisagreeNear = 0;
  const disagreements = [];
  for (const r of l.rows) {
    const e = c.local[r.fips];
    maxIs = Math.max(maxIs, Math.abs(r.local_i - e.Is));
    const q = { "High-High": 1, "Low-High": 2, "Low-Low": 3, "High-Low": 4 }[r.quadrant] ?? null;
    if (r.quadrant !== null && q !== e.q) quadMismatch++;
    if (r.p_sim === null) continue;
    const d = Math.abs(r.p_sim - e.p_sim);
    maxP = Math.max(maxP, d); sumP += d;
    const sd = Math.sqrt(2 * e.p_sim * (1 - e.p_sim) / R) || 1 / R;
    // One neighbour, and its value recurs: a draw ties the observed statistic
    // exactly. Ours counts a tie as at least as extreme (the definition of
    // M); esda's floating-point order drops it, so ours is higher by about
    // P(tie). Those are reported apart, not hidden.
    const nbv = (neighbors.get(r.fips) || []).filter(f => byVal.has(f)).map(f => byVal.get(f));
    const pTie = nbv.length === 1 ? rows.filter(x => x.fips !== r.fips && x.value === nbv[0]).length / (rows.length - 1) : 0;
    if (d > 4 * sd + 2 / (R + 1)) {
      if (pTie > 0 && r.p_sim > e.p_sim && d <= pTie + 4 * sd + 2 / (R + 1)) tieExplained++;
      else beyond4++;
    }
    const label = r.lisa_class === "Not significant" ? "Insignificant" : r.lisa_class;
    if (label === c.labels[r.fips]) classAgree++;
    else {
      // A disagreement is only acceptable where one side sits near alpha.
      const near = Math.abs(e.p_sim - 0.05) < 4 * Math.sqrt(2 * 0.05 * 0.95 / R) + 2 / (R + 1);
      if (near) classDisagreeNear++;
      disagreements.push({ fips: r.fips, ours: label, pysal: c.labels[r.fips], p_ours: r.p_sim, p_pysal: e.p_sim, near });
    }
  }
  const scored = l.rows.filter(r => r.p_sim !== null).length;
  const caseBad = globalDiff.I > 1e-9 || globalDiff.EI > 1e-12 || globalDiff.VI_rand > 1e-6 ||
    globalDiff.z_rand > 1e-6 || globalDiff.p_rand > 1e-6 || maxIs > 1e-9 || quadMismatch > 0 ||
    disagreements.some(d => !d.near) || beyond4 > Math.max(3, scored * 0.001);
  if (caseBad) bad++;
  report.cases[name] = {
    n: c.n, islands: c.islands, ok: !caseBad,
    global: { ours: g, pysal: c.global, diff: globalDiff },
    local: { max_abs_Is_diff: maxIs, quadrant_mismatches: quadMismatch, units_with_p: scored,
             mean_abs_p_diff: sumP / scored, max_abs_p_diff: maxP, p_beyond_4sd: beyond4, p_tie_explained: tieExplained,
             class_agreement: classAgree / scored, class_disagreements: disagreements.length,
             disagreements_all_near_alpha: disagreements.every(d => d.near), counts: l.summary.counts },
    ms: { global: tg, local: tl },
  };
  console.log(`${caseBad ? "FAIL" : "ok  "} ${name}: n ${c.n}, I ${g.I.toFixed(6)} (pysal ${c.global.I.toFixed(6)}), ` +
    `z ${g.z.toFixed(3)}/${c.global.z_rand.toFixed(3)}, max|dIs| ${maxIs.toExponential(1)}, ` +
    `classes agree ${(100 * classAgree / scored).toFixed(2)}% (${disagreements.length} differ, ` +
    `all near alpha: ${disagreements.every(d => d.near)}), p beyond 4sd ${beyond4} (+${tieExplained} ties), ${tg}+${tl} ms`);
}
if (outPath) fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
process.exit(bad ? 1 : 0);
