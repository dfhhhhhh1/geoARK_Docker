/**
 * How a choropleth's values are cut into colour classes.
 *
 *   jenks     Natural breaks (Jenks / Fisher). Classes are chosen to minimise
 *             the spread WITHIN each class, so breaks fall in the gaps the
 *             data actually has. The default: it reads as "these counties are
 *             alike" rather than "these counties are the same count".
 *   quantile  Equal numbers of counties per class. Best for very skewed
 *             measures (a few huge counties), where natural breaks can put
 *             nearly everything in the bottom class.
 *   equal     Equal-width value ranges. Honest about magnitudes, but a skewed
 *             measure shows as one colour.
 *
 * A diverging measure (hotspot, outlier) is not classified here: its bins are
 * symmetric about zero (ChoroplethMap's divergingBreaks), whatever the method.
 *
 * Breaks are the UPPER edges of every class but the last, and a class is
 * (lo, hi]: the same contract the existing quantile function had, so legends
 * and colouring are unchanged.
 */

export type Classification = 'jenks' | 'quantile' | 'equal';

export const CLASSIFICATIONS: Array<{ id: Classification; label: string; hint: string }> = [
  { id: 'jenks', label: 'Natural breaks', hint: 'Breaks at the gaps in the data (Jenks)' },
  { id: 'quantile', label: 'Quantile', hint: 'The same number of counties in each class' },
  { id: 'equal', label: 'Equal interval', hint: 'Classes of equal width' },
];

/**
 * Above this many values, natural breaks runs on an evenly spaced sample of
 * the sorted values. Jenks is O(k n^2): 3,233 counties at 6 classes is ~60M
 * steps, a visible stall on every restyle; 1,200 is ~9M and imperceptible.
 * Sampling the SORTED values keeps every part of the distribution represented,
 * which is what desktop GIS does for the same reason.
 */
const JENKS_MAX = 1200;

export function quantileBreaks(values: number[], bins: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks: number[] = [];
  for (let i = 1; i < bins; i++) {
    const idx = Math.floor((i / bins) * sorted.length);
    breaks.push(sorted[Math.min(idx, sorted.length - 1)]);
  }
  return [...new Set(breaks)];
}

export function equalBreaks(values: number[], bins: number): number[] {
  if (!values.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi === lo) return [];
  const w = (hi - lo) / bins;
  return Array.from({ length: bins - 1 }, (_, i) => lo + w * (i + 1));
}

/**
 * Fisher-Jenks natural breaks: the partition of the sorted values into `bins`
 * contiguous classes with the least total within-class squared deviation.
 * Dynamic programming over prefix sums, so each class's variance is O(1).
 */
export function jenksBreaks(values: number[], bins: number): number[] {
  const all = [...values].sort((a, b) => a - b);
  let data = all;
  if (all.length > JENKS_MAX) {
    data = Array.from({ length: JENKS_MAX },
      (_, i) => all[Math.round((i / (JENKS_MAX - 1)) * (all.length - 1))]);
  }
  const n = data.length;
  const k = Math.min(bins, new Set(data).size);
  if (n === 0 || k < 2) return [];

  // Prefix sums of x and x^2: the squared deviation of data[i..j] is
  // S2 - S1^2 / count, in constant time.
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i] + data[i];
    s2[i + 1] = s2[i] + data[i] * data[i];
  }
  const ssd = (i: number, j: number) => {           // data[i..j], inclusive
    const c = j - i + 1;
    const a = s1[j + 1] - s1[i];
    return s2[j + 1] - s2[i] - (a * a) / c;
  };

  // cost[c][j]: best total for data[0..j] in c+1 classes; from[c][j]: where
  // the last class starts.
  const cost: Float64Array[] = [];
  const from: Int32Array[] = [];
  cost.push(new Float64Array(n));
  from.push(new Int32Array(n));
  for (let j = 0; j < n; j++) cost[0][j] = ssd(0, j);
  for (let c = 1; c < k; c++) {
    const row = new Float64Array(n).fill(Infinity);
    const arg = new Int32Array(n);
    for (let j = c; j < n; j++) {
      let best = Infinity, bestI = c;
      for (let i = c; i <= j; i++) {
        const v = cost[c - 1][i - 1] + ssd(i, j);
        if (v < best) { best = v; bestI = i; }
      }
      row[j] = best;
      arg[j] = bestI;
    }
    cost.push(row);
    from.push(arg);
  }

  // Walk back: each class's first index; the break is the value before it.
  const breaks: number[] = [];
  let j = n - 1;
  for (let c = k - 1; c > 0; c--) {
    const i = from[c][j];
    breaks.unshift(data[i - 1]);
    j = i - 1;
  }
  return [...new Set(breaks)];
}

export function classBreaks(values: number[], bins: number, method: Classification): number[] {
  if (method === 'quantile') return quantileBreaks(values, bins);
  if (method === 'equal') return equalBreaks(values, bins);
  return jenksBreaks(values, bins);
}

const KEY = 'geoark.classification';

/** The method new maps open with: the reader's last choice, else natural breaks. */
export function loadClassification(): Classification {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'jenks' || v === 'quantile' || v === 'equal') return v;
  } catch { /* storage unavailable: the default is fine */ }
  return 'jenks';
}

export function saveClassification(m: Classification): void {
  try { window.localStorage.setItem(KEY, m); } catch { /* a preference, not data */ }
}
