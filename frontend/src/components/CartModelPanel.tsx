import React, { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, BrainCircuit, Info } from 'lucide-react';
import { trainModel, type CartTable, type ModelResult } from '../lib/cart';

/**
 * AutoML on the cart table (docs/DATA_CART_PLAN.md Phase 6, option B).
 *
 * What makes it honest, and what this panel has to show for that to matter:
 *   - every county is scored by a model that never saw its state (or, inside a
 *     few states, its block of neighbours), so the score is out-of-place skill;
 *   - Moran's I of the out-of-fold errors says whether the model left spatial
 *     structure behind;
 *   - importance is association in this data, shown beside the partial Spearman
 *     the explain op computes, which is the interpretable check on it;
 *   - a random split is available only as a comparison, labelled as inflated.
 */

const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d);

const CartModelPanel: React.FC<{ table: CartTable; items: string[]; states: string[] | null }> =
  ({ table, items, states }) => {
    const targets = table.columns.filter(c => c.source_kind !== 'feature_table');
    const [target, setTarget] = useState(targets[0]?.item ?? '');
    const [result, setResult] = useState<ModelResult | null>(null);
    const [random, setRandom] = useState<ModelResult | null>(null);
    const [busy, setBusy] = useState<null | 'spatial' | 'random'>(null);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => { setResult(null); setRandom(null); setError(null); }, [table]);
    useEffect(() => {
      if (!busy) return;
      const t0 = Date.now();
      const id = window.setInterval(() => setElapsed(Date.now() - t0), 500);
      return () => window.clearInterval(id);
    }, [busy]);

    const run = async (split: 'spatial' | 'random') => {
      if (busy || !target) return;
      setBusy(split); setError(null); setElapsed(0);
      if (split === 'spatial') setRandom(null);
      try {
        const r = await trainModel(items, states, target, split);
        if (split === 'spatial') setResult(r); else setRandom(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    };

    if (table.columns.length < 2 || !targets.length) return null;
    const companion = new Map(result?.companion.map(c => [c.feature, c]) ?? []);
    const maxImp = Math.max(1e-9, ...(result?.importance.map(i => Math.abs(i.importance ?? 0)) ?? [0]));

    return (
      <section aria-label="Model the cart" className="mt-6 bg-white/85 rounded-2xl border border-slate-200 p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <BrainCircuit className="w-4 h-4 text-ink" />
          <h2 className="font-semibold text-ink mr-auto">Predict one column from the others</h2>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Target
            <select value={target} onChange={e => { setTarget(e.target.value); setResult(null); setRandom(null); }}
                    disabled={!!busy}
                    className="max-w-[18rem] bg-white border border-slate-300 rounded px-1.5 py-1 text-xs">
              {targets.map(c => <option key={c.item} value={c.item}>{c.header}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void run('spatial')} disabled={!!busy}
                  className="rounded-lg bg-ink text-white text-sm font-medium px-3 py-1.5 hover:bg-brand-700
                             disabled:bg-slate-400/60 flex items-center gap-2">
            {busy === 'spatial' ? <Loader2 className="w-4 h-4 animate-spin" /> : <BrainCircuit className="w-4 h-4" />}
            {result ? 'Train again' : 'Train (about 2-3 min)'}
          </button>
        </div>
        <p className="text-xs text-slate-500 max-w-3xl">
          AutoGluon, scored out of fold: each county is predicted by a model trained without its state
          (or, for one or a few states, without its block of nearby counties). FIPS, names and states are
          never inputs. Neighbouring counties are alike, so a random split would count copying a neighbour
          as skill.
        </p>

        {busy && (
          <p className="text-sm text-slate-600 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Training 5 folds{busy === 'random' ? ' (random split, for comparison)' : ''}…
            {' '}{Math.round(elapsed / 1000)} s
          </p>
        )}
        {error && <p className="text-sm text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> {error}</p>}

        {result && (
          <>
            {result.warnings.map(w => (
              <p key={w} className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}
              </p>
            ))}
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Out-of-place R²" value={fmt(result.cv.r2)}
                    note={`${result.cv.scored.toLocaleString()} counties, ${result.cv.folds} folds by ${
                      result.cv.grouping === 'states' ? `state (${result.cv.groups})` : `block (${result.cv.groups})`}; per-fold mean ${fmt(result.cv.r2_fold_mean)}`} />
              <Stat label="Error (RMSE)" value={fmt(result.cv.rmse)}
                    note={`guessing the average: ${fmt(result.cv.baseline_rmse)}`} />
              <Stat label="Spatial pattern left in errors" value={`I = ${fmt(result.spatial.residual_moran)}`}
                    note={`target itself: I = ${fmt(result.spatial.target_moran)}. ${
                      (result.spatial.residual_moran ?? 0) > 0.3
                        ? 'High: neighbours share errors, so something regional is missing.'
                        : 'Low: little regional structure left unexplained.'}`} />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="py-1.5 pr-3 font-medium">Column</th>
                    <th className="py-1.5 pr-3 font-medium">Model importance</th>
                    <th className="py-1.5 pr-3 font-medium" title="Spearman with the target, the other columns held fixed (the explain op's computation)">
                      Partial ρ, others held fixed
                    </th>
                    <th className="py-1.5 font-medium">Raw ρ</th>
                  </tr>
                </thead>
                <tbody>
                  {result.importance.map(imp => {
                    const c = companion.get(imp.feature);
                    const w = Math.max(0, (imp.importance ?? 0) / maxImp) * 100;
                    return (
                      <tr key={imp.feature} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-3 text-ink">{imp.feature}</td>
                        <td className="py-1.5 pr-3 min-w-[9rem]">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 bg-slate-100 rounded">
                              <div className="h-2 bg-brand-500 rounded" style={{ width: `${w}%` }} />
                            </div>
                            <span className="tabular-nums text-slate-600 w-12 text-right">{fmt(imp.importance, 3)}</span>
                          </div>
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {c?.status === 'ok'
                            ? <>{fmt(c.partial_rho)} <span className="text-slate-400">[{fmt(c.ci_low)}, {fmt(c.ci_high)}]</span></>
                            : <span className="text-slate-400">
                                {c?.same_as ? `same measure as ${c.same_as}` : c?.status?.replace(/_/g, ' ') ?? '–'}
                              </span>}
                        </td>
                        <td className="py-1.5 tabular-nums text-slate-600">{fmt(c?.rho)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500 flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              Importance is how much the out-of-fold R² drops when a column is shuffled: association in
              this data, not a cause. The partial ρ beside it is the explain op's check, with a 95% interval
              on an effective n discounted for spatial autocorrelation. Where the two disagree, trust neither alone.
              Best models: {Object.entries(result.models).map(([m, n]) => `${m}${n > 1 ? ` ×${n}` : ''}`).join(', ')}.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1 border-t border-slate-200">
              {!random && (
                <button type="button" onClick={() => void run('random')} disabled={!!busy}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  Compare with a random split
                </button>
              )}
              {random && (
                <p className="text-xs text-slate-600">
                  A random split reports R² <b>{fmt(random.cv.r2)}</b> against <b>{fmt(result.cv.r2)}</b> held out by
                  place{(random.cv.r2 ?? 0) > (result.cv.r2 ?? 0)
                    ? `: ${fmt((random.cv.r2 ?? 0) - (result.cv.r2 ?? 0))} of its score comes from neighbours on both sides of the split.`
                    : '. Here the two agree, so neighbour copying is not inflating the score.'}
                </p>
              )}
            </div>
          </>
        )}
      </section>
    );
  };

const Stat: React.FC<{ label: string; value: string; note: string }> = ({ label, value, note }) => (
  <div className="rounded-xl border border-slate-200 bg-white/80 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="text-xl font-semibold text-ink tabular-nums">{value}</div>
    <div className="text-[11px] text-slate-500 mt-0.5">{note}</div>
  </div>
);

export default CartModelPanel;
