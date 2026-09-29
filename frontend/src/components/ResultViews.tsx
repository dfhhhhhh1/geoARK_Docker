import React, { useMemo } from 'react';
import { Map as MapIcon, Table as TableIcon, BarChart3, Sigma } from 'lucide-react';
import type { AnalysisResponse, AnalysisRow } from '../types';
import type { Series } from '../lib/series';

/**
 * The four result shapes the planner can ask for.
 *
 * `output_type` has been in the decoding schema from the start -- map, table,
 * chart, statistics -- and the frontend rendered a map no matter what it said.
 * An option the model can emit and nothing honors is a small version of the
 * same "valid but wrong" problem the rest of this project keeps finding: the
 * plan claimed one thing and the screen showed another.
 *
 * The view is a SUGGESTION, not a constraint. The planner's choice picks the
 * default tab; every view stays available, because the model calling something
 * a chart is not a reason to withhold the map.
 */

export type ViewKind = 'map' | 'table' | 'chart' | 'statistics';

const TABS: Array<{ id: ViewKind; label: string; icon: typeof MapIcon }> = [
  { id: 'map', label: 'Map', icon: MapIcon },
  { id: 'table', label: 'Table', icon: TableIcon },
  { id: 'chart', label: 'Chart', icon: BarChart3 },
  { id: 'statistics', label: 'Summary', icon: Sigma },
];

export const ViewTabs: React.FC<{
  active: ViewKind;
  suggested: ViewKind;
  onChange: (v: ViewKind) => void;
}> = ({ active, suggested, onChange }) => (
  <div className="flex rounded-lg border border-slate-300 overflow-hidden w-fit">
    {TABS.map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        type="button"
        onClick={() => onChange(id)}
        aria-pressed={active === id}
        title={id === suggested ? `${label} — what the plan asked for` : label}
        className={`px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors
                    border-r border-slate-300 last:border-r-0 ${
          active === id ? 'bg-blue-600 text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-50'
        }`}
      >
        <Icon className="w-3.5 h-3.5" />
        {label}
        {/* Marks the planner's own choice, so a user can tell what the
            analysis intended from what they are currently looking at. */}
        {id === suggested && active !== id && (
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" aria-hidden />
        )}
      </button>
    ))}
  </div>
);

const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (Number.isInteger(n) && abs < 1_000) return String(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(3);
};

/**
 * Distribution summary for one measure.
 *
 * Median and quartiles rather than mean and standard deviation, for the reason
 * the choropleth already uses quantile bins and `outlier` uses a Tukey fence:
 * these distributions are heavily skewed, and a mean reported alone invites the
 * reader to picture a typical county that does not exist.
 */
function summarize(rows: AnalysisRow[], key: 'value' | 'value_b') {
  const v = rows.map(r => r[key])
    .filter((x): x is number => x !== null && x !== undefined && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (q: number) => v[Math.min(Math.floor(q * v.length), v.length - 1)];
  return {
    n: v.length,
    min: v[0],
    q1: at(0.25),
    median: at(0.5),
    q3: at(0.75),
    max: v[v.length - 1],
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

export const StatisticsView: React.FC<{
  rows: AnalysisRow[];
  series: Series[];
}> = ({ rows, series }) => (
  <div className="space-y-5">
    {series.map(s => {
      const st = summarize(rows, s.key);
      if (!st) return (
        <p key={s.key} className="text-sm text-slate-500">
          {s.label}: no numeric values.
        </p>
      );
      return (
        <div key={s.key}>
          <p className="text-sm font-medium text-slate-700 mb-2">{s.label}</p>
          <dl className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {([
              ['Counties', st.n.toLocaleString()],
              ['Minimum', fmt(st.min)],
              ['25th pct', fmt(st.q1)],
              ['Median', fmt(st.median)],
              ['75th pct', fmt(st.q3)],
              ['Maximum', fmt(st.max)],
            ] as const).map(([k, val]) => (
              <div key={k} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                <dt className="text-xs text-slate-500">{k}</dt>
                <dd className="text-lg font-semibold text-slate-800 tabular-nums">{val}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-slate-500 mt-2">
            Mean {fmt(st.mean)}. The median and quartiles are shown because county
            measures are heavily skewed, and a mean on its own describes a county
            that may not exist.
          </p>
        </div>
      );
    })}
  </div>
);

/**
 * Top and bottom counties as a horizontal bar chart.
 *
 * Inline SVG rather than a chart library: this is one chart type with a fixed
 * shape, and the bundle already warns at 790 kB. Horizontal because county
 * names are long and would otherwise be rotated or truncated.
 *
 * Shows both ends of the distribution, never just the top. A chart of only the
 * highest counties answers "which are highest" while looking like it describes
 * the data.
 */
export const ChartView: React.FC<{
  rows: AnalysisRow[];
  series: Series[];
  valueLabel?: string | null;
}> = ({ rows, series, valueLabel }) => {
  const key = series[0]?.key ?? 'value';
  const { top, bottom, span } = useMemo(() => {
    const v = rows.filter(r => r[key] !== null && r[key] !== undefined
                            && Number.isFinite(r[key] as number));
    const sorted = [...v].sort((a, b) => (b[key] as number) - (a[key] as number));
    const t = sorted.slice(0, 12);
    const b = sorted.length > 24 ? sorted.slice(-12).reverse() : [];
    const all = [...t, ...b].map(r => r[key] as number);
    return {
      top: t, bottom: b,
      span: { lo: Math.min(0, ...all), hi: Math.max(0, ...all) },
    };
  }, [rows, key]);

  if (!top.length) {
    return <p className="text-sm text-slate-500">No numeric values to chart.</p>;
  }

  const width = 100;                       // percentage-based, so it is responsive
  const scale = (n: number) =>
    span.hi === span.lo ? 0 : ((n - span.lo) / (span.hi - span.lo)) * width;
  const zero = scale(0);

  const Bars: React.FC<{ title: string; data: AnalysisRow[] }> = ({ title, data }) => (
    <div>
      <p className="text-xs font-medium text-slate-600 mb-1.5">{title}</p>
      <div className="space-y-1">
        {data.map(r => {
          const n = r[key] as number;
          const x = scale(n);
          const left = Math.min(x, zero);
          const w = Math.abs(x - zero);
          return (
            <div key={r.fips} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate text-slate-600" title={r.name ?? r.fips}>
                {r.name ?? r.fips}
              </span>
              <span className="flex-1 relative h-4 bg-slate-100 rounded-sm overflow-hidden">
                <span
                  className={`absolute top-0 bottom-0 rounded-sm ${
                    n < 0 ? 'bg-rose-500' : 'bg-blue-600'}`}
                  style={{ left: `${left}%`, width: `${Math.max(w, 0.6)}%` }}
                />
              </span>
              <span className="w-16 shrink-0 text-right tabular-nums text-slate-700">
                {fmt(n)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <Bars title={`Highest${valueLabel ? ` · ${valueLabel}` : ''}`} data={top} />
      {bottom.length > 0 && <Bars title="Lowest" data={bottom} />}
      <p className="text-xs text-slate-500">
        {rows.length.toLocaleString()} counties in the result; the extremes of the
        distribution are shown.
      </p>
    </div>
  );
};

/** Which view the plan asked for, defaulting to the map. */
export function suggestedView(result: AnalysisResponse | null): ViewKind {
  const t = result?.plan?.output_type;
  return t === 'table' || t === 'chart' || t === 'statistics' ? t : 'map';
}
