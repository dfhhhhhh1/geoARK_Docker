import React, { useState } from 'react';
import { Loader2, MapPin, MessagesSquare, Plus, Search, X, Database, GitBranch } from 'lucide-react';
import type { FollowUpMeasure } from '../types';
import { reviseAnalysis, searchMeasures } from '../lib/followup';
import { layersOf, type StackLayer } from '../lib/layers';

/**
 * Put another layer on the map.
 *
 * Two sources, neither of which costs a planner call:
 *   - this conversation: earlier answers, and the steps of a multi-step one,
 *     which are already computed;
 *   - the catalog: any measure or facility dataset with data loaded, mapped as
 *     is through the existing "map a measure" path (/api/analyze/revise,
 *     map_measure), which runs in well under a second.
 *
 * What a reader asks for in words ("show A and B on one map") is the planner's
 * job; this is for building the stack by hand afterwards.
 */

export interface LayerSource {
  key: string;
  title: string;
  /** "Earlier answer", "Step 1 of this analysis". */
  kind: 'answer' | 'step';
  subtitle: string;
  layers: StackLayer[];
}

interface Props {
  sources: LayerSource[];
  present: Set<string>;
  onAdd: (layers: StackLayer[]) => void;
  onClose: () => void;
}

const AddLayerMenu: React.FC<Props> = ({ sources, present, onAdd, onClose }) => {
  const [tab, setTab] = useState<'thread' | 'catalog'>(sources.length ? 'thread' : 'catalog');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<FollowUpMeasure[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setError(null);
    try { setFound(await searchMeasures(q.trim())); }
    catch (err) { setError((err as Error).message); }
    finally { setSearching(false); }
  };

  const addCatalog = async (m: FollowUpMeasure) => {
    setAdding(m.attr_id); setError(null);
    try {
      const result = await reviseAnalysis(null, { kind: 'map_measure', attr_id: m.attr_id }, []);
      const layers = layersOf(result, `cat:${m.attr_id}`, `Catalog${m.dataset ? ` · ${m.dataset}` : ''}`, true)
        .map(l => ({ ...l, label: m.label }));
      if (!layers.length) throw new Error('that dataset returned nothing to draw');
      onAdd(layers);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(null);
    }
  };

  return (
    <section className="pointer-events-auto glass glass-raised rounded-2xl w-full max-h-[min(60vh,30rem)] flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/80">
        <Plus className="w-4 h-4 text-slate-500" />
        <h3 className="text-sm font-semibold text-ink mr-auto">Add a layer</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 text-slate-400 hover:text-slate-700">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex gap-1 px-3 pt-2" role="tablist">
        {([['thread', 'This conversation', MessagesSquare], ['catalog', 'Catalog', Database]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-colors
                    ${tab === id ? 'bg-ink text-white' : 'text-slate-600 hover:bg-white/70'}`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="overflow-y-auto overscroll-contain min-h-0 p-3 space-y-2">
        {error && <p className="text-xs text-red-700">{error}</p>}

        {tab === 'thread' && (
          sources.length ? (
            <ul className="space-y-1.5">
              {sources.map(s => {
                const fresh = s.layers.filter(l => !present.has(l.key));
                return (
                  <li key={s.key} className="rounded-lg border border-slate-200 bg-white/80 px-3 py-2">
                    <div className="flex items-start gap-2">
                      {s.kind === 'step'
                        ? <GitBranch className="w-4 h-4 text-slate-400 rotate-90 mt-0.5 shrink-0" />
                        : <MessagesSquare className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-ink leading-snug line-clamp-2" title={s.title}>{s.title}</span>
                        <span className="block text-[11px] text-slate-500">
                          {s.subtitle} · {s.layers.length} layer{s.layers.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      <button type="button" disabled={!fresh.length} onClick={() => onAdd(fresh)}
                              className="shrink-0 text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white
                                         hover:border-brand-400 disabled:opacity-40">
                        {fresh.length ? 'Add' : 'On map'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">No other answers yet. Search the catalog instead.</p>
          )
        )}

        {tab === 'catalog' && (
          <>
            <form onSubmit={search} className="flex gap-2">
              <input value={q} onChange={e => setQ(e.target.value)} autoFocus
                     placeholder="e.g. hospitals, unemployment rate"
                     className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white
                                focus:outline-none focus:ring-2 focus:ring-brand-500" />
              <button type="submit" disabled={searching || !q.trim()}
                      className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50
                                 disabled:opacity-40 flex items-center gap-1.5">
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </button>
            </form>
            {found && (
              <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white/80">
                {found.slice(0, 14).map(m => {
                  const onMap = [...present].some(k => k.startsWith(`cat:${m.attr_id}:`));
                  return (
                    <li key={m.attr_id} className="flex items-center gap-2 px-3 py-2">
                      {m.kind === 'feature'
                        ? <MapPin className="w-4 h-4 text-slate-400 shrink-0" />
                        : <span className="w-4 h-3 rounded-sm bg-gradient-to-r from-brand-100 to-brand-600 shrink-0" />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-slate-800 truncate" title={m.description ?? m.label}>{m.label}</span>
                        <span className="block text-[11px] text-slate-500 truncate">
                          {m.dataset ?? ''}{m.kind === 'feature' ? ' · locations' : ' · county values'}
                        </span>
                      </span>
                      <button type="button" disabled={!!adding || onMap} onClick={() => void addCatalog(m)}
                              className="shrink-0 text-xs px-2.5 py-1 rounded-md bg-ink text-white hover:bg-brand-700
                                         disabled:bg-slate-300 disabled:text-slate-600 inline-flex items-center gap-1">
                        {adding === m.attr_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        {onMap ? 'On map' : 'Add'}
                      </button>
                    </li>
                  );
                })}
                {!found.length && <li className="px-3 py-3 text-sm text-slate-500">Nothing with loaded data matched.</li>}
              </ul>
            )}
            {!found && (
              <p className="text-xs text-slate-500">
                Any county measure or facility dataset with data loaded. It is mapped as is, for every county
                or location, and stacked on top.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
};

export default AddLayerMenu;
