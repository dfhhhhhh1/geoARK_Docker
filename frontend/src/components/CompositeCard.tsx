import type { CompositeDiagnostics } from '../types';

/**
 * What a composite score is made of (backend planner/composite_diagnostics.js):
 * the score's correlation with each input's raw value, for all units and, when
 * a population is known at this level, rural and urban units separately; for
 * a count of thresholds, how many units each threshold flags.
 *
 * The map shows where the score is high; this says which inputs carry it.
 */

const fmt = (v: number | null | undefined) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(2);

// Coarse words beside the number, as the other statistic cards do.
function strength(r: number | null | undefined): string {
  if (r === null || r === undefined) return '';
  const a = Math.abs(r);
  return a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'little';
}

export default function CompositeCard({ diagnostics, unit = 'units' }:
  { diagnostics: CompositeDiagnostics; unit?: string }) {
  const d = diagnostics;
  if (!d || d.error || !d.components?.length) return null;
  const strata = d.strata ?? [{ name: 'all', label: 'all units', n: 0, mean_score: null }];
  const isCount = d.method === 'count';
  const top = [...d.components].filter(c => c.by.all?.pearson !== null && c.by.all?.pearson !== undefined)
    .sort((a, b) => Math.abs(b.by.all.pearson!) - Math.abs(a.by.all.pearson!))[0];

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {isCount ? 'Count of thresholds met: what drives the score' : 'Composite score: what drives it'}
      </p>
      <p className="mt-1 text-sm text-slate-700">
        Mean score {strata.map((s, i) => (
          <span key={s.name}>{i > 0 && ', '}{s.label} <strong className="tabular-nums">{fmt(s.mean_score)}</strong>
            <span className="text-slate-500"> ({s.n.toLocaleString()} {unit})</span></span>
        ))}.
        {top && <> Most closely tied to <strong>{top.name}</strong> (r {fmt(top.by.all.pearson)}).</>}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-3 font-medium">Component</th>
              {isCount && <th className="py-1 pr-3 font-medium">Threshold</th>}
              {isCount && <th className="py-1 pr-3 font-medium" title="units past the threshold">Flagged</th>}
              {strata.map(s => (
                <th key={s.name} className="py-1 pr-3 font-medium text-right"
                    title={`Pearson r of the score with the component's raw value, ${s.label} (Spearman ρ on hover)`}>
                  r, {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {d.components.map(c => (
              <tr key={c.step} className="align-top">
                <td className="py-1 pr-3 text-slate-800 max-w-[18rem]">{c.name}</td>
                {isCount && (
                  <td className="py-1 pr-3 tabular-nums whitespace-nowrap">
                    {c.threshold ? `${c.threshold.operator} ${c.threshold.value}` : '–'}
                  </td>
                )}
                {isCount && (
                  <td className="py-1 pr-3 tabular-nums whitespace-nowrap">
                    {strata.map(s => c.by[s.name]?.flagged ?? '–').join(' / ')}
                  </td>
                )}
                {strata.map(s => {
                  const b = c.by[s.name];
                  return (
                    <td key={s.name} className="py-1 pr-3 tabular-nums text-right whitespace-nowrap"
                        title={b ? `Spearman ρ ${fmt(b.spearman)}, n ${b.n} ${strength(b.pearson)}` : undefined}>
                      {fmt(b?.pearson)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Pearson r of the score with each component's own value{isCount ? '; "flagged" counts units past the threshold' : ''}
        {strata.length > 1 ? ` (${strata.map(s => s.name).join(' / ')})` : ''}.
        {d.rural_rule ? ` Rural: ${d.rural_rule}.` : ''} A component that is part of the score correlates
        with it by construction, so read these as which parts move together, not as independent findings.
      </p>
    </div>
  );
}
