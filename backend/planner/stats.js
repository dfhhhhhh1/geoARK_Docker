/**
 * Small, dependency-free statistics for the `explain` op.
 *
 * Why not SQL, like correlate and hotspot? Partial correlation with several
 * controls needs a least-squares fit on a small matrix per factor, and Postgres
 * has no matrix solve. The data are small (~3,100 counties x ~12 columns), so
 * this runs in milliseconds in Node. Every function here is checked against a
 * closed form or an independent computation in test_stats.js.
 */

/** Average ranks (1-based), ties sharing the mean of the positions they span. */
function rank(values) {
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

function mean(a) { let s = 0; for (const v of a) s += v; return s / a.length; }

function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    c += da * db; va += da * da; vb += db * db;
  }
  return va && vb ? c / Math.sqrt(va * vb) : NaN;
}

/**
 * Solve A x = b by Gaussian elimination with partial pivoting. A is small
 * (controls + 1 square). Returns null for a singular system, which happens when
 * two controls are collinear; the caller then reports the factor as unfitted
 * rather than inventing a number.
 */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Residuals of y after ordinary least squares on the columns of X (+ intercept). */
function residualize(y, X) {
  if (!X.length) { const m = mean(y); return y.map(v => v - m); }
  const k = X.length + 1;
  const row = (i) => [1, ...X.map(col => col[i])];
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < y.length; i++) {
    const r = row(i);
    for (let a = 0; a < k; a++) {
      Xty[a] += r[a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += r[a] * r[b];
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return null;
  return y.map((v, i) => v - row(i).reduce((s, x, j) => s + x * beta[j], 0));
}

/**
 * Global Moran's I with binary contiguity. `neighbors` maps an index to the
 * indices of its neighbours among the same observations; pairs are symmetric,
 * which county_neighbors guarantees.
 */
function moranI(values, neighbors) {
  const n = values.length;
  const m = mean(values);
  const z = values.map(v => v - m);
  let num = 0, W = 0, den = 0;
  for (let i = 0; i < n; i++) {
    den += z[i] * z[i];
    for (const j of neighbors[i] || []) { num += z[i] * z[j]; W++; }
  }
  return W && den ? (n / W) * (num / den) : 0;
}

/**
 * Effective sample size for correlating two spatially autocorrelated series,
 * n (1 - Ia Ib) / (1 + Ia Ib) (Bretherton et al. 1999), the same approximation
 * correlate uses, bounded to [4, n].
 */
function nEffective(n, ia, ib) {
  const p = (ia || 0) * (ib || 0);
  return Math.max(4, Math.min(n, n * (1 - p) / (1 + p)));
}

/** erfc, Abramowitz & Stegun 7.1.26. */
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = (0.254829592 * t - 0.284496736 * t ** 2 + 1.421413741 * t ** 3
            - 1.453152027 * t ** 4 + 1.061405429 * t ** 5) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}

/**
 * Two-sided p and 95% CI for a (partial) correlation on an effective n, with
 * `k` controls consumed from the degrees of freedom.
 */
function inference(r, nEff, k = 0) {
  const rc = Math.max(-0.999999, Math.min(0.999999, r));
  const df = nEff - 2 - k;
  const t = Math.abs(rc) * Math.sqrt(df / (1 - rc * rc));
  const se = 1 / Math.sqrt(Math.max(1, nEff - 3 - k));
  const z = Math.atanh(rc);
  return {
    p_value: df > 0 ? erfc(t / Math.SQRT2) : 1,
    ci_low: Math.tanh(z - 1.96 * se),
    ci_high: Math.tanh(z + 1.96 * se),
  };
}

/** Benjamini-Hochberg adjusted p-values (false discovery rate), same order as input. */
function bhAdjust(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b]);
  const q = new Array(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const i = order[k];
    prev = Math.min(prev, (ps[i] * m) / (k + 1));
    q[i] = prev;
  }
  return q;
}

module.exports = {
  rank, mean, pearson, solve, residualize, moranI, nEffective, erfc, inference, bhAdjust,
};
