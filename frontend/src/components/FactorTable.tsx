import type { AnalysisResponse, ExplainFactor } from '../types';

/**
 * The answer to "what explains X": factors ranked by how strongly they track
 * the outcome once income, age and rurality are held fixed.
 *
 * Three groups, deliberately separate:
 *   drivers      ranked; the importance is the CI bound nearest zero, so an
 *                uncertain factor cannot outrank a well-measured one
 *   context      the literature mostly reports these as CONSEQUENCES of the
 *                outcome (diabetes -> heart disease); shown, not ranked
 *   not fitted   with the reason, so a missing factor is never silent
 */

const fmt = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : (v >= 0 ? '+' : '') + v.toFixed(d);

function fmtQ(q: number | null | undefined): string {
  if (q === null || q === undefined) return '–';
  return q < 0.001 ? '< 0.001' : q.toFixed(3);
}

const STATUS_TEXT: Record<string, string> = {
  same_measure_as_outcome: 'another version of the outcome itself',
  same_measure_as_control: 'the same measure as a control',
  too_few_counties: 'too few counties with data',
  controls_collinear: 'controls could not be separated',
};

function Evidence({ f }: { f: ExplainFactor }) {
  const lit = f.literature;
  if (f.source === 'question') return <span>named in the question</span>;
  if (f.source === 'default') return <span>standard covariate</span>;
  if (!lit) return <span>–</span>;
  const cause = lit.papers_as_cause ?? 0, effect = lit.papers_as_effect ?? 0;
  return (
    <span title={(lit.predicates ?? []).join(', ')}>
      {lit.direction === 'effect'
        ? <>follows from {lit.seed} in {effect.toLocaleString()} papers ({cause.toLocaleString()} the other way)</>
        : <>leads to {lit.seed} in {cause.toLocaleString()} papers ({effect.toLocaleString()} the other way)</>}
    </span>
  );
}

function Bar({ value }: { value: number }) {
  // Partial rho on a -1..1 axis, centred. Colour carries sign; width magnitude.
  const w = Math.min(1, Math.abs(value)) * 50;
  return (
    <div className="relative h-2 w-28 rounded bg-slate-100" aria-hidden>
      <div className="absolute top-0 h-2 w-px bg-slate-400" style={{ left: '50%' }} />
      <div className={`absolute top-0 h-2 rounded ${value >= 0 ? 'bg-rose-500' : 'bg-sky-600'}`}
           style={value >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
    </div>
  );
}

// "(covers 2,957 counties)" is on every PLACES name and the Counties column
// already says it; the full text stays in the tooltip.
const shortName = (d: string) => d.replace(/\s*\(covers [\d,]+ counties\)/i, '');

function Row({ f, onMap }: { f: ExplainFactor; onMap?: (f: ExplainFactor) => void }) {
  const significant = (f.importance ?? 0) > 0;
  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="py-2 pr-3 tabular-nums text-slate-500">{f.rank ?? ''}</td>
      <td className="py-2 pr-3 min-w-[11rem] text-slate-900" title={f.description ?? f.attr_id}>
        {shortName(f.description ?? f.attr_id)}
        {onMap && (
          <button type="button" onClick={() => onMap(f)}
                  className="block mt-0.5 text-xs text-brand-700 hover:underline">
            Map this factor
          </button>
        )}</td>
      <td className="py-2 pr-3 hidden md:table-cell"><Bar value={f.partial_rho ?? 0} /></td>
      <td className={`py-2 pr-3 tabular-nums ${significant ? 'text-slate-900 font-medium' : 'text-slate-400'}`}>
        {fmt(f.partial_rho)}
        <span className="block text-xs font-normal text-slate-500">
          [{fmt(f.ci_low)}, {fmt(f.ci_high)}]
        </span>
      </td>
      <td className="py-2 pr-3 tabular-nums text-slate-600">{fmt(f.rho)}</td>
      <td className="py-2 pr-3 tabular-nums text-slate-600">{fmtQ(f.q_value)}</td>
      <td className="py-2 pr-3 tabular-nums text-slate-600">
        {f.n?.toLocaleString()}
        <span className="block text-xs text-slate-400">eff. {f.n_effective?.toLocaleString()}</span>
      </td>
      <td className="py-2 text-xs text-slate-600"><Evidence f={f} /></td>
    </tr>
  );
}

/**
 * `onMap` puts a "Map this factor" link on each row. A ranked table says how
 * strongly a factor tracks the outcome; only a map says where.
 */
export default function FactorTable({ result, onMap }: {
  result: AnalysisResponse;
  onMap?: (f: ExplainFactor) => void;
}) {
  const ex = result.explain!;
  const outcome = shortName(result.provenance?.attribute_origins?.[0]?.description ?? 'the outcome');
  const fitted = ex.factors.filter(f => f.status === 'ok');
  const drivers = fitted.filter(f => !f.context);
  const context = fitted.filter(f => f.context);
  const unfitted = ex.factors.filter(f => f.status !== 'ok');
  const controls = ex.controls.map(c => c.description ?? c.attr_id).join(', ');

  const head = (
    <thead>
      <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
        <th className="py-2 pr-3 font-medium">#</th>
        <th className="py-2 pr-3 font-medium">Factor</th>
        <th className="py-2 pr-3 font-medium hidden md:table-cell" />
        <th className="py-2 pr-3 font-medium" title="Spearman correlation after holding the controls fixed, with 95% CI">
          Adjusted ρ</th>
        <th className="py-2 pr-3 font-medium" title="Spearman correlation with no controls">Raw ρ</th>
        <th className="py-2 pr-3 font-medium" title="Benjamini-Hochberg adjusted across the factors tested">q</th>
        <th className="py-2 pr-3 font-medium">Counties</th>
        <th className="py-2 font-medium">Why it is here</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        What tracks <strong>{outcome}</strong> across counties, holding{' '}
        <strong>{controls || 'nothing'}</strong> fixed. Ranked by the end of each 95% interval
        nearest zero, so a factor has to be both strong and well measured to rank high.
      </p>

      {drivers.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">{head}
            <tbody>{drivers.map(f => <Row key={f.attr_id} f={f} onMap={onMap} />)}</tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">No candidate driver was found for this outcome.</p>
      )}

      {context.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-slate-700">Context, not ranked</h4>
          <p className="text-xs text-slate-500 mb-1">
            The literature mostly reports these as consequences of {outcome.toLowerCase()}, so their
            association is shown but not offered as an explanation.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">{head}
              <tbody>{context.map(f => <Row key={f.attr_id} f={f} onMap={onMap} />)}</tbody>
            </table>
          </div>
        </div>
      )}

      {unfitted.length > 0 && (
        <p className="text-xs text-slate-500">
          Not tested: {unfitted.map(f => `${f.description ?? f.attr_id} (${STATUS_TEXT[f.status] ?? f.status})`).join('; ')}.
        </p>
      )}

      <ul className="space-y-1 text-xs text-slate-600 list-disc pl-4">
        <li>Association, not cause, even after controls: anything not controlled for can still confound.</li>
        <li>County averages describe places, not individual people (the ecological fallacy).</li>
        <li>Intervals use an effective sample discounted for neighbouring counties resembling
            each other, so they are wider than a naive test would give.</li>
        <li>CDC PLACES measures are model estimates that share census inputs, which can inflate
            their associations with each other.</li>
      </ul>
    </div>
  );
}
