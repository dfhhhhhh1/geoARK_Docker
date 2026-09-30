import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Search, MapPin } from 'lucide-react';
import type { AnalysisRow } from '../types';
import type { Series } from '../lib/series';
import { STATE_ABBR } from '../lib/places';

/**
 * The per-county numbers, as a tool rather than a wall.
 *
 * The old table was the first 50 rows at full height under the map: it pushed
 * the follow-ups off screen and did nothing a reader could use. This one is a
 * fixed-height scroll box over EVERY row, with a find box, sortable columns and
 * a rank column, and clicking a county zooms the map to it. It is still the
 * accessible counterpart to the choropleth: the same numbers, readable without
 * relying on colour.
 */
interface Props {
  rows: AnalysisRow[];
  series: Series[];
  /** Zoom the map to this county. Absent when there is no map to zoom. */
  onPick?: (fips: string) => void;
  selected?: string | null;
  /** Tailwind max-height class for the scroll box. */
  heightClass?: string;
}

type SortKey = 'value' | 'value_b' | 'name';

// Rendering thousands of rows is fine; tens of thousands is not. Counties top
// out at ~3,233, so this only bites on something that is not a county layer.
const MAX_RENDER = 4000;

const fmt = (v: number | null | undefined) =>
  v === null || v === undefined ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: 3 });

const CountyTable: React.FC<Props> = ({ rows, series, onPick, selected = null, heightClass = 'max-h-64' }) => {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'value', dir: 'desc' });

  // Rank is by the first measure, highest first, and does not change with the
  // sort or the filter: "#7" should mean the same county however you look.
  const rankOf = useMemo(() => {
    const m = new Map<string, number>();
    [...rows].filter(r => r.value !== null && r.value !== undefined)
      .sort((a, b) => (b.value as number) - (a.value as number))
      .forEach((r, i) => m.set(r.fips, i + 1));
    return m;
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter(r => {
          const st = STATE_ABBR[r.fips.slice(0, 2)] ?? '';
          return `${r.name ?? ''} ${st} ${r.fips}`.toLowerCase().includes(needle);
        })
      : rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'name') return dir * String(a.name ?? '').localeCompare(String(b.name ?? ''));
      const av = a[sort.key] as number | null | undefined;
      const bv = b[sort.key] as number | null | undefined;
      // Blanks sink to the bottom in both directions.
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return dir * (av - bv);
    }).slice(0, MAX_RENDER);
  }, [rows, q, sort]);

  const toggle = (key: SortKey) => setSort(s => (s.key === key
    ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const SortIcon = ({ k }: { k: SortKey }) => (sort.key !== k ? null
    : sort.dir === 'asc' ? <ArrowUp className="w-3 h-3 inline" /> : <ArrowDown className="w-3 h-3 inline" />);

  return (
    <div className="rounded-lg border border-slate-200">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50 rounded-t-lg">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Find a county or state…"
          aria-label="Filter counties"
          className="flex-1 min-w-0 bg-transparent text-sm focus:outline-none"
        />
        <span className="text-xs text-slate-500 shrink-0">
          {shown.length === rows.length ? `${rows.length.toLocaleString()} counties`
            : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}`}
        </span>
      </div>
      <div className={`${heightClass} overflow-y-auto`}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] z-[1]">
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1.5 pl-3 pr-2 font-medium w-10">#</th>
              <th className="py-1.5 pr-2 font-medium">
                <button type="button" onClick={() => toggle('name')} className="hover:text-slate-800">
                  County <SortIcon k="name" />
                </button>
              </th>
              {series.map(s => (
                <th key={s.key} className="py-1.5 pr-3 font-medium text-right" title={s.label}>
                  <button type="button" onClick={() => toggle(s.key)}
                          className="hover:text-slate-800 inline-flex items-center gap-1 max-w-[11rem]">
                    <span className="truncate">{series.length > 1 ? s.label : 'Value'}</span>
                    <SortIcon k={s.key} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const isSel = r.fips === selected;
              return (
                <tr
                  key={r.fips}
                  onClick={onPick ? () => onPick(r.fips) : undefined}
                  onKeyDown={onPick ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.fips); } } : undefined}
                  tabIndex={onPick ? 0 : undefined}
                  title={onPick ? 'Show on the map' : undefined}
                  className={`border-t border-slate-100 ${onPick ? 'cursor-pointer hover:bg-blue-50 focus:bg-blue-50 focus:outline-none' : ''}
                              ${isSel ? 'bg-amber-50' : ''}`}
                >
                  <td className="py-1 pl-3 pr-2 text-xs text-slate-400 tabular-nums">{rankOf.get(r.fips) ?? ''}</td>
                  <td className="py-1 pr-2 text-slate-800">
                    <span className="inline-flex items-center gap-1">
                      {isSel && <MapPin className="w-3 h-3 text-amber-600" />}
                      {r.name ?? r.fips}
                      <span className="text-xs text-slate-400">{STATE_ABBR[r.fips.slice(0, 2)] ?? ''}</span>
                    </span>
                  </td>
                  {series.map(s => (
                    <td key={s.key} className="py-1 pr-3 text-right text-slate-800 tabular-nums">
                      {fmt(r[s.key] as number | null | undefined)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={2 + series.length} className="px-3 py-3 text-sm text-slate-500">No county matches “{q}”.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default CountyTable;
