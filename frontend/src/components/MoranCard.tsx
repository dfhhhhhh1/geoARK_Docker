import type { AnalysisResponse, MoranStats } from '../types';

/**
 * Global Moran's I, read out loud: whether neighbouring units resemble each
 * other more than chance would produce, how strongly, and how sure.
 *
 * Unlike a correlation, the answer is about ONE measure, so its map stays
 * underneath: the reader can see the clustering the number summarises.
 */

// Coarse on purpose; the number is right beside the word.
function strength(i: number): string {
  if (i >= 0.5) return 'strongly clustered';
  if (i >= 0.3) return 'moderately clustered';
  if (i >= 0.1) return 'weakly clustered';
  if (i > -0.1) return 'close to spatially random';
  return 'dispersed (neighbours tend to differ)';
}

const fmt = (v: number | null | undefined, d = 3) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d);

function fmtP(p: number | null | undefined, permutations?: number | null): string {
  if (p === null || p === undefined) return '–';
  // A pseudo p cannot go below 1 / (R + 1); say so rather than print 0.001.
  if (permutations && p <= 1 / (permutations + 1) + 1e-12) return `≤ ${p.toFixed(3)}`;
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

export default function MoranCard({ result }: { result: AnalysisResponse }) {
  const s = result.stats as MoranStats;
  const measure = result.provenance?.attribute_origins?.[0]?.description ?? 'the measure';
  const i = s.value ?? 0;
  const significant = (s.p_sim ?? s.p_value ?? 1) < 0.05;
  const unit = result.level && result.level !== 'county' ? 'units' : 'counties';

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Global Moran's I
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-4xl font-semibold tabular-nums text-slate-900">I = {fmt(i)}</span>
        <span className="text-sm text-slate-600 tabular-nums">
          z {fmt(s.z, 2)}, pseudo p {fmtP(s.p_sim, s.permutations)}
          {s.permutations ? ` (${s.permutations} permutations)` : ''}
        </span>
      </div>

      <p className="mt-3 text-sm text-slate-800">
        <strong>{measure}</strong> is <strong>{strength(i)}</strong> across{' '}
        {(s.n ?? 0).toLocaleString()} {unit}
        {significant
          ? ': neighbouring units resemble each other far more than a random arrangement would.'
          : ': not distinguishable from a random arrangement at the 5% level.'}
      </p>

      <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs">
        <div><dt className="text-slate-500">Expected under randomness</dt>
             <dd className="tabular-nums text-slate-900">{fmt(s.expected, 4)}</dd></div>
        <div><dt className="text-slate-500">p, normal approximation</dt>
             <dd className="tabular-nums text-slate-900">{fmtP(s.p_value)}</dd></div>
        <div><dt className="text-slate-500">Units</dt>
             <dd className="tabular-nums text-slate-900">{(s.n ?? 0).toLocaleString()}</dd></div>
        <div><dt className="text-slate-500">Without a neighbour</dt>
             <dd className="tabular-nums text-slate-900">{s.n_islands ?? 0}</dd></div>
      </dl>

      <p className="mt-4 text-xs text-slate-500">
        {result.moran?.method ?? "Queen contiguity, row-standardized."} Neighbours are the{' '}
        {unit} inside the area asked about. Ask for the LISA cluster map to see where the clusters are.
      </p>
    </div>
  );
}
