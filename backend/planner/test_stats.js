// Checks planner/stats.js against closed forms and independent computations.
//   node planner/test_stats.js
const assert = require("node:assert");
const S = require("./stats");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
}
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} vs ${b}`);

// Deterministic pseudo-random data (LCG), so a failure is reproducible.
function rng(seed) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }

test("average ranks share ties", () => {
  assert.deepStrictEqual(S.rank([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
});

test("partial correlation by residualizing equals the closed form, one control", () => {
  const r = rng(7), n = 500;
  const z = Array.from({ length: n }, () => gauss(r));
  const x = z.map(v => 0.6 * v + gauss(r));
  const y = z.map((v, i) => 0.5 * v + 0.3 * x[i] + gauss(r));
  const rxy = S.pearson(x, y), rxz = S.pearson(x, z), ryz = S.pearson(y, z);
  const closed = (rxy - rxz * ryz) / Math.sqrt((1 - rxz ** 2) * (1 - ryz ** 2));
  const viaResid = S.pearson(S.residualize(x, [z]), S.residualize(y, [z]));
  close(viaResid, closed, 1e-10);
});

test("a confounded association vanishes once the confounder is controlled", () => {
  // x and y are both driven by z and nothing else.
  const r = rng(11), n = 2000;
  const z = Array.from({ length: n }, () => gauss(r));
  const x = z.map(v => v + 0.5 * gauss(r));
  const y = z.map(v => v + 0.5 * gauss(r));
  assert.ok(S.pearson(x, y) > 0.7, "raw correlation should be strong");
  const partial = S.pearson(S.residualize(x, [z]), S.residualize(y, [z]));
  assert.ok(Math.abs(partial) < 0.06, `partial should be ~0, got ${partial}`);
});

test("solve handles a known system and reports a singular one", () => {
  const x = S.solve([[2, 1], [1, 3]], [3, 5]);
  close(x[0], 0.8, 1e-12); close(x[1], 1.4, 1e-12);
  assert.strictEqual(S.solve([[1, 2], [2, 4]], [1, 2]), null);
});

test("Moran's I: +1-ish on a smooth line, ~0 on noise, negative on alternation", () => {
  const n = 400;
  const line = Array.from({ length: n }, (_, i) => [i - 1, i + 1].filter(j => j >= 0 && j < n));
  const smooth = Array.from({ length: n }, (_, i) => i);
  assert.ok(S.moranI(smooth, line) > 0.95);
  const alt = Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1));
  close(S.moranI(alt, line), -1, 0.01);
  const r = rng(3);
  const noise = Array.from({ length: n }, () => gauss(r));
  assert.ok(Math.abs(S.moranI(noise, line)) < 0.15);
});

test("effective n: unchanged without autocorrelation, halved near the measured I", () => {
  assert.strictEqual(S.nEffective(3000, 0, 0.6), 3000);
  // 2945 (1 - .59*.63) / (1 + .59*.63). correlate reported 1,354 for smoking ~
  // COPD from UNROUNDED Moran values; these are the two-decimal ones it printed.
  close(S.nEffective(2945, 0.59, 0.63), 2945 * (1 - 0.3717) / 1.3717, 1e-9);
  assert.strictEqual(S.nEffective(10, 0.99, 0.99), 4, "floored at 4");
});

test("erfc matches known values", () => {
  close(S.erfc(0), 1, 1e-7);
  close(S.erfc(1), 0.157299207, 2e-7);
  close(S.erfc(2), 0.004677735, 2e-7);
});

test("inference: 95% CI brackets r, and p falls as n grows", () => {
  const a = S.inference(0.3, 100), b = S.inference(0.3, 1000);
  assert.ok(a.ci_low < 0.3 && a.ci_high > 0.3);
  assert.ok(b.p_value < a.p_value);
  // The same interval correlate reports for income ~ diabetes (rho -0.691, n_eff 1339).
  const c = S.inference(-0.691, 1339);
  close(c.ci_low, -0.718, 0.002); close(c.ci_high, -0.662, 0.002);
});

test("Benjamini-Hochberg matches a worked example", () => {
  // Hand-computed: sorted p 0.01,0.02,0.03,0.04,0.2 with m=5 -> 0.05,0.05,0.05,0.05,0.2
  const q = S.bhAdjust([0.04, 0.01, 0.2, 0.03, 0.02]);
  [0.05, 0.05, 0.2, 0.05, 0.05].forEach((v, i) => close(q[i], v, 1e-12));
});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
