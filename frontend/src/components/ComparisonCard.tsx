import type { AnalysisResponse, GroupComparison } from '../types';
import { fmtP, fmtValue, isResultAttr } from '../lib/workflow';

/**
 * The answer to "is it higher in A than in B": compare_groups, read out loud.
 *
 * The map shows both groups' counties; what it cannot show is the verdict.
 * This card gives the two medians on one scale, the size of the difference in
 * a unit-free form, how sure it is, and the ways a county-group comparison is
 * most often misread. Same voice as CorrelationCard.
 */

// Conventional reading of |rank-biserial|. Coarse on purpose; the number is
// beside it.
function magnitude(r: number): string {
  const a = Math.abs(r);
  if (a < 0.1) return 'negligible';
  if (a < 0.3) return 'small';
  if (a < 0.5) return 'moderate';
  return 'large';
}

/** The measure being compared: the last dataset the plan loads itself. */
function measureName(result: AnalysisResponse): string {
  const own = (result.provenance?.attribute_origins ?? []).filter(o => !isResultAttr(o.attr_id));
  const o = own[own.length - 1];
  return (o?.description ?? 'the measure').replace(/[|!]{1,2}/g, ' › ').replace(/\s*\(covers [^)]*\)/, '');
}

export default function ComparisonCard({ result, comparison, compact = false }: {
  result: AnalysisResponse;
  comparison: GroupComparison;
  compact?: boolean;
}) {
  const c = comparison;
  const la = c.labels?.a ?? 'Group A';
  const lb = c.labels?.b ?? 'Group B';
  const ma = c.median_a ?? 0;
  const mb = c.median_b ?? 0;
  const significant = c.p_value !== null && c.p_value < 0.05;
  const higher = (c.diff ?? 0) === 0 ? null : (c.diff ?? 0) > 0 ? la : lb;
  const name = measureName(result);
  // A shared scale for the two medians, from zero when both are positive so a
  // 10% difference does not read as a doubling.
  const hi = Math.max(ma, mb, 0) || 1;
  const lo = Math.min(0, ma, mb);
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;

  return (
    <div className={`rounded-lg border border-slate-200 bg-slate-50 ${compact ? 'p-4' : 'p-5'}`}>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        Comparison of two groups of counties
      </p>
      <p className="mt-1 text-sm text-slate-700 truncate" title={name}>{name}</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        {([['a', la, c.median_a, c.n_a], ['b', lb, c.median_b, c.n_b]] as const).map(([k, label, med, n]) => (
          <div key={k} className={`rounded-lg border bg-white px-3 py-2.5
                                   ${higher === label ? 'border-ink' : 'border-slate-200'}`}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500 truncate" title={label}>
              {k === 'a' ? 'A' : 'B'} · {label}
            </p>
            <p className={`${compact ? 'text-2xl' : 'text-3xl'} font-semibold tabular-nums text-slate-900 mt-0.5`}>
              {fmtValue(med)}
            </p>
            <p className="text-xs text-slate-500 tabular-nums">median · {n?.toLocaleString() ?? '–'} counties</p>
          </div>
        ))}
      </div>

      {/* Both medians on one axis. */}
      <div className="mt-3 relative h-7" aria-hidden>
        <div className="absolute inset-x-0 top-3 h-px bg-slate-300" />
        <div className="absolute top-3 h-px bg-ink"
             style={{ left: pos(Math.min(ma, mb)), width: `calc(${pos(Math.max(ma, mb))} - ${pos(Math.min(ma, mb))})` }} />
        {([['A', ma], ['B', mb]] as const).map(([k, v]) => (
          <div key={k} className="absolute -translate-x-1/2 flex flex-col items-center" style={{ left: pos(v) }}>
            <span className={`w-3 h-3 rounded-full border-2 border-white shadow mt-[0.4rem]
                              ${k === 'A' ? 'bg-ink' : 'bg-brand-500'}`} />
            <span className="text-[10px] font-semibold text-slate-600 mt-0.5">{k}</span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-sm text-slate-800">
        {higher === null ? (
          <>The medians are equal.</>
        ) : (
          <>
            Higher in <strong>{higher}</strong> by <strong className="tabular-nums">
            {fmtValue(Math.abs(c.diff ?? 0))}</strong>: a {magnitude(c.rank_biserial ?? 0)} difference
            {significant ? '' : ', not distinguishable from none at this sample size'}.
          </>
        )}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div><dt className="text-slate-500" title="P(a county in A is higher than one in B) minus the reverse">
               Rank-biserial</dt>
             <dd className="tabular-nums text-slate-900">{c.rank_biserial?.toFixed(2) ?? '–'}</dd></div>
        <div><dt className="text-slate-500">p</dt>
             <dd className="tabular-nums text-slate-900">{fmtP(c.p_value)}</dd></div>
        <div><dt className="text-slate-500" title="Discounted for neighbouring counties resembling each other">
               Effective n</dt>
             <dd className="tabular-nums text-slate-900">{c.n_eff_a ?? '–'} / {c.n_eff_b ?? '–'}</dd></div>
        <div><dt className="text-slate-500">Moran's I</dt>
             <dd className="tabular-nums text-slate-900">{c.moran_i?.toFixed(2) ?? '–'}</dd></div>
      </dl>

      {!compact && (
        <ul className="mt-4 space-y-1.5 text-xs text-slate-600 list-disc pl-4">
          <li>Medians, because county distributions are skewed. Means: {fmtValue(c.mean_a)} vs {fmtValue(c.mean_b)}.</li>
          <li>Neighbouring counties resemble each other, so the test uses an effective sample of{' '}
              {c.n_eff_a ?? '?'} and {c.n_eff_b ?? '?'} rather than {c.n_a ?? '?'} and {c.n_b ?? '?'} counties.</li>
          <li>A difference between places, not a cause. Both groups may differ in income, age or rurality too.</li>
          {(c.overlap ?? 0) > 0 && (
            <li className="text-amber-700">{c.overlap} counties were in both groups and were left out of both.</li>
          )}
          {Math.min(c.n_a ?? 0, c.n_b ?? 0) < 30 && (
            <li className="text-amber-700">One group has fewer than 30 counties with data, so the result is fragile.</li>
          )}
        </ul>
      )}
    </div>
  );
}
