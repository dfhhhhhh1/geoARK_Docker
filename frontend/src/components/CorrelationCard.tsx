import type { AnalysisResponse, CorrelationStats } from '../types';

/**
 * The answer to "is A related to B": one statistic, read out loud.
 *
 * A correlate result is a single row with no county, so the choropleth has
 * nothing to draw. What a reader needs instead is the number, how sure it is,
 * and the three ways a county-level correlation is most often misread.
 */

// Conventional labels for |rho|. Coarse on purpose: a reader who needs more
// precision has the number and its interval right next to the word.
function strength(rho: number): string {
  const a = Math.abs(rho);
  if (a < 0.1) return 'essentially no';
  if (a < 0.3) return 'a weak';
  if (a < 0.5) return 'a moderate';
  if (a < 0.7) return 'a strong';
  return 'a very strong';
}

const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d);

function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined) return '–';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

export default function CorrelationCard({ result }: { result: AnalysisResponse }) {
  const s = result.stats as CorrelationStats;
  const origins = result.provenance?.attribute_origins ?? [];
  const a = origins[0]?.description ?? 'the first measure';
  const b = origins[1]?.description ?? 'the second measure';
  const rho = s.value ?? 0;
  const significant = s.p_value !== null && s.p_value < 0.05;
  // Both CDC PLACES: small-area model estimates that share census covariates,
  // so part of any correlation between them is built into the model.
  const bothModelled = origins.length >= 2 && origins.slice(0, 2).every(
    o => /^PLACES_/.test(o.census_code ?? '') || /PLACES/i.test(o.dataset ?? ''));

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Rank correlation across counties
      </p>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-4xl font-semibold tabular-nums text-slate-900">
          ρ = {fmt(rho)}
        </span>
        <span className="text-sm text-slate-600 tabular-nums">
          95% CI {fmt(s.ci_low)} to {fmt(s.ci_high)} · p {fmtP(s.p_value)}
        </span>
      </div>

      <p className="mt-3 text-sm text-slate-800">
        Counties with more <strong>{a}</strong> tend to have{' '}
        <strong>{rho >= 0 ? 'more' : 'less'}</strong> <strong>{b}</strong>:{' '}
        {strength(rho)} {rho >= 0 ? 'positive' : 'negative'} association
        {significant ? '' : ', not distinguishable from none at this sample size'}.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-slate-500">Counties</dt>
             <dd className="tabular-nums text-slate-900">{s.n?.toLocaleString() ?? '–'}</dd></div>
        <div><dt className="text-slate-500" title="Discounted for neighbouring counties resembling each other">
               Effective n</dt>
             <dd className="tabular-nums text-slate-900">{s.n_effective?.toLocaleString() ?? '–'}</dd></div>
        <div><dt className="text-slate-500">Pearson r</dt>
             <dd className="tabular-nums text-slate-900">{fmt(s.pearson_r)}</dd></div>
        <div><dt className="text-slate-500">Moran's I (A / B)</dt>
             <dd className="tabular-nums text-slate-900">{fmt(s.moran_a)} / {fmt(s.moran_b)}</dd></div>
      </dl>
      <p className="mt-2 text-xs text-slate-500 tabular-nums">
        Least-squares line: B ≈ {fmt(s.intercept, 3)} + {fmt(s.slope, 4)} × A
      </p>

      <ul className="mt-4 space-y-1.5 text-xs text-slate-600 list-disc pl-4">
        <li>Association, not cause. Both may follow a third factor, such as income or age.</li>
        <li>These are county averages. They describe places, not individual people
            (the ecological fallacy).</li>
        <li>Neighbouring counties resemble each other, so the p-value and interval use an
            effective sample of {s.n_effective?.toLocaleString() ?? '?'} rather than all{' '}
            {s.n?.toLocaleString() ?? '?'} counties.</li>
        {bothModelled && (
          <li className="text-amber-700">Both measures are CDC PLACES model estimates built partly
            from the same census covariates, which likely inflates their correlation.</li>
        )}
        {s.pearson_r !== null && Math.abs((s.pearson_r ?? 0) - rho) > 0.15 && (
          <li className="text-amber-700">Pearson and Spearman differ by more than 0.15, so a few
            extreme counties are shaping the linear fit.</li>
        )}
      </ul>
    </div>
  );
}
