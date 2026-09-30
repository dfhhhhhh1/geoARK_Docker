import React, { useState } from 'react';
import {
  ArrowDownWideNarrow, ArrowUpWideNarrow, Flame, Globe2, MapPin, Plus, Replace,
  Search, Sigma, Sparkles, Upload, X, Loader2, FileSpreadsheet, Map as MapIcon,
  GitCompareArrows, Trash2, HelpCircle,
} from 'lucide-react';
import type { AnalysisResponse, FollowUpEdit, FollowUpMeasure, UserSeries } from '../types';
import { searchMeasures, USER_PREFIX } from '../lib/followup';
import { REGIONS, STATES } from '../lib/places';

/**
 * What the user can do next with a result.
 *
 * Every button here sends an EDIT: a structural change the server applies to
 * the plan that just ran and re-validates, with no model call. That is why
 * they are instant, and why "swap the measure" is guaranteed to keep
 * everything else about the analysis the same. Which buttons appear comes from
 * `result.followups`, which the server computed by trying each edit -- so a
 * button is never offered for a change the server would refuse.
 *
 * Suggested QUESTIONS are different: they go into the composer for the user to
 * read and send, because they are phrased by us and planned by the model.
 */
interface Props {
  result: AnalysisResponse | null;
  uploads: UserSeries[];
  disabled: boolean;
  onEdit: (edit: FollowUpEdit, userText?: string) => void;
  onPrefill: (text: string) => void;
  onUpload: () => void;
  onRemoveUpload: (id: string) => void;
}

type Panel = null | 'area' | 'swap' | 'add' | 'map';

const Chip: React.FC<{
  onClick: () => void; disabled?: boolean; active?: boolean; title?: string;
  tone?: 'default' | 'remove'; children: React.ReactNode;
}> = ({ onClick, disabled, active, title, tone = 'default', children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-full border transition-colors
      disabled:opacity-40 disabled:cursor-not-allowed
      ${active ? 'bg-brand-600 border-brand-600 text-white'
        : tone === 'remove' ? 'bg-slate-50 border-slate-300 text-slate-700 hover:border-red-300 hover:text-red-700'
        : 'bg-white border-slate-200 text-slate-700 hover:border-brand-400 hover:text-brand-700'}`}
  >
    {children}
  </button>
);

const Group: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-wrap items-center gap-2">
    <span className="text-xs font-medium uppercase tracking-wide text-slate-400 w-20 shrink-0">{label}</span>
    {children}
  </div>
);

const FollowUpBar: React.FC<Props> = ({
  result, uploads, disabled, onEdit, onPrefill, onUpload, onRemoveUpload,
}) => {
  const [panel, setPanel] = useState<Panel>(null);
  const f = result?.followups ?? null;
  const can = f?.can;
  const toggle = (p: Panel) => setPanel(cur => (cur === p ? null : p));
  const send = (edit: FollowUpEdit, text?: string) => { setPanel(null); onEdit(edit, text); };

  // The single measure a result is ABOUT, for phrasing suggested questions.
  const subject = f?.in_use.length === 1 && f.in_use[0].kind === 'value' ? f.in_use[0] : null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 space-y-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-600" /> Keep going
        </h3>
        <span className="text-xs text-slate-500">
          {result
            ? 'These change this result directly and run in about a second; nothing is re-planned.'
            : 'Ask a question below, or start from your own data.'}
        </span>
      </div>

      {can && (
        <>
          {(can.rank || can.restrict_area || (f?.removable.length ?? 0) > 0) && (
            <Group label="Refine">
              {can.rank && (
                <>
                  <Chip disabled={disabled} onClick={() => send({ kind: 'rank', direction: 'desc', limit: 10 })}>
                    <ArrowDownWideNarrow className="w-4 h-4" /> Top 10
                  </Chip>
                  <Chip disabled={disabled} onClick={() => send({ kind: 'rank', direction: 'asc', limit: 10 })}>
                    <ArrowUpWideNarrow className="w-4 h-4" /> Bottom 10
                  </Chip>
                </>
              )}
              {can.restrict_area && (
                <Chip disabled={disabled} active={panel === 'area'} onClick={() => toggle('area')}>
                  <MapPin className="w-4 h-4" /> Only a state or region…
                </Chip>
              )}
              {f!.removable.map(r => (
                <Chip key={r.step_id} tone="remove" disabled={disabled}
                      title="Remove this restriction"
                      onClick={() => send({ kind: 'remove_step', step_id: r.step_id }, `Remove “${r.label}”`)}>
                  <X className="w-3.5 h-3.5" /> {r.label}
                </Chip>
              ))}
              {can.clear_area && !f!.removable.some(r => r.op === 'filter_area' || r.op === 'filter_place') && (
                <Chip disabled={disabled} onClick={() => send({ kind: 'clear_area' })}>
                  <Globe2 className="w-4 h-4" /> Whole country
                </Chip>
              )}
            </Group>
          )}

          {panel === 'area' && (
            <AreaPicker onPick={states => send({ kind: 'restrict_area', states })}
                        onClose={() => setPanel(null)} />
          )}

          {(can.hotspot || can.outlier || subject) && (
            <Group label="Analyze">
              {can.hotspot && (
                <Chip disabled={disabled} onClick={() => send({ kind: 'add_stat', op: 'hotspot' })}
                      title="Getis-Ord Gi*: where high or low values cluster with their neighbours">
                  <Flame className="w-4 h-4" /> Hot and cold spots
                </Chip>
              )}
              {can.outlier && (
                <Chip disabled={disabled} onClick={() => send({ kind: 'add_stat', op: 'outlier' })}
                      title="Counties beyond 1.5 interquartile ranges from the middle half">
                  <Sigma className="w-4 h-4" /> Outliers
                </Chip>
              )}
              {subject && (
                <Chip disabled={disabled} title="Puts a question in the box below for you to check and send"
                      onClick={() => onPrefill(`what explains ${subject.label.toLowerCase()} across counties`)}>
                  <HelpCircle className="w-4 h-4" /> What explains it?
                </Chip>
              )}
            </Group>
          )}

          <Group label="Measures">
            {can.swap && (
              <Chip disabled={disabled} active={panel === 'swap'} onClick={() => toggle('swap')}>
                <Replace className="w-4 h-4" /> Wrong measure? Swap it
              </Chip>
            )}
            {(can.compare || can.correlate || can.add_factor) && (
              <Chip disabled={disabled} active={panel === 'add'} onClick={() => toggle('add')}>
                <Plus className="w-4 h-4" /> Add a measure
              </Chip>
            )}
            <Chip disabled={disabled} active={panel === 'map'} onClick={() => toggle('map')}>
              <MapIcon className="w-4 h-4" /> Map something else
            </Chip>
          </Group>
        </>
      )}

      {(panel === 'swap' || panel === 'add' || panel === 'map') && (
        <MeasurePanel
          mode={panel}
          result={result}
          uploads={uploads}
          disabled={disabled}
          onSend={send}
          onClose={() => setPanel(null)}
        />
      )}

      <Group label="Your data">
        <Chip disabled={disabled} onClick={onUpload}>
          <Upload className="w-4 h-4" /> Upload a county CSV
        </Chip>
        {!can && (
          <Chip disabled={disabled} active={panel === 'map'} onClick={() => toggle('map')}>
            <Search className="w-4 h-4" /> Find a measure to map
          </Chip>
        )}
      </Group>
      {uploads.length > 0 && (
        <ul className="space-y-2 pl-0 sm:pl-[5.5rem]">
          {uploads.map(u => {
            const attr = USER_PREFIX + u.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200
                                        bg-emerald-50/60 px-3 py-2">
                <FileSpreadsheet className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="text-sm text-slate-800 font-medium min-w-0 truncate max-w-[16rem]" title={u.name}>
                  {u.name}
                </span>
                <span className="text-xs text-slate-500">{u.matched.toLocaleString()} counties</span>
                <span className="flex flex-wrap gap-1.5 ml-auto">
                  <MiniButton disabled={disabled} onClick={() => send({ kind: 'map_measure', attr_id: attr })}>
                    Map it
                  </MiniButton>
                  {can?.compare && (
                    <MiniButton disabled={disabled}
                                onClick={() => send({ kind: 'add_measure', attr_id: attr, mode: 'compare' })}>
                      Side by side
                    </MiniButton>
                  )}
                  {can?.correlate && (
                    <MiniButton disabled={disabled}
                                onClick={() => send({ kind: 'add_measure', attr_id: attr, mode: 'correlate' })}>
                      Test relationship
                    </MiniButton>
                  )}
                  {can?.add_factor && (
                    <MiniButton disabled={disabled} onClick={() => send({ kind: 'add_factor', attr_id: attr })}>
                      Add as factor
                    </MiniButton>
                  )}
                  <button type="button" onClick={() => onRemoveUpload(u.id)} title="Forget this upload"
                          className="p-1 text-slate-400 hover:text-red-600">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

const MiniButton: React.FC<{ onClick: () => void; disabled?: boolean; children: React.ReactNode }> =
  ({ onClick, disabled, children }) => (
    <button type="button" onClick={onClick} disabled={disabled}
            className="text-xs px-2.5 py-1 rounded-md border border-slate-300 bg-white text-slate-700
                       hover:border-brand-400 hover:text-brand-700 disabled:opacity-40">
      {children}
    </button>
  );

const AreaPicker: React.FC<{ onPick: (states: string[]) => void; onClose: () => void }> = ({ onPick, onClose }) => {
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-slate-500">Census regions:</span>
        {REGIONS.map(r => (
          <MiniButton key={r} onClick={() => onPick([r])}>{r}</MiniButton>
        ))}
        <button type="button" onClick={onClose} className="ml-auto p-1 text-slate-400 hover:text-slate-700"
                aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="text-xs text-slate-500" htmlFor="area-states">States:</label>
        <select
          id="area-states"
          multiple
          value={chosen}
          onChange={e => setChosen([...e.target.selectedOptions].map(o => o.value))}
          className="min-w-[14rem] h-28 text-sm rounded-md border border-slate-300 bg-white"
        >
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-slate-500">Ctrl/⌘-click for several.</span>
          <button type="button" disabled={!chosen.length} onClick={() => onPick(chosen)}
                  className="text-sm px-3 py-1.5 rounded-lg bg-brand-600 text-white disabled:bg-slate-300">
            Restrict to {chosen.length ? `${chosen.length} state${chosen.length > 1 ? 's' : ''}` : '…'}
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Pick a measure: from what retrieval already found for this question, or from
 * a catalog search. The search is limited server-side to attributes that hold
 * data, so everything listed can be loaded.
 */
const MeasurePanel: React.FC<{
  mode: 'swap' | 'add' | 'map';
  result: AnalysisResponse | null;
  uploads: UserSeries[];
  disabled: boolean;
  onSend: (edit: FollowUpEdit, text?: string) => void;
  onClose: () => void;
}> = ({ mode, result, uploads, disabled, onSend, onClose }) => {
  const f = result?.followups;
  const inUse = f?.in_use ?? [];
  const [target, setTarget] = useState<string>(inUse[0]?.attr_id ?? '');
  const targetKind = inUse.find(m => m.attr_id === target)?.kind ?? 'value';
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<FollowUpMeasure[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setSearchError(null);
    try { setFound(await searchMeasures(q.trim())); }
    catch (err) { setSearchError((err as Error).message); }
    finally { setSearching(false); }
  };

  const usedIds = new Set(inUse.map(m => m.attr_id));
  const fits = (m: FollowUpMeasure) =>
    !usedIds.has(m.attr_id) &&
    (mode === 'map' || (mode === 'swap' ? m.kind === targetKind : m.kind === 'value'));
  const list = (found ?? f?.alternatives ?? []).filter(fits).slice(0, 12);
  // Near-duplicate measures are common (42 unemployment-ish attributes across
  // three sources) and several share a two-segment label. When one does, its
  // full description is shown so the rows can be told apart.
  const labelCount = new Map<string, number>();
  for (const m of list) labelCount.set(m.label, (labelCount.get(m.label) ?? 0) + 1);
  const detail = (m: FollowUpMeasure) =>
    (labelCount.get(m.label) ?? 0) > 1 && m.description
      ? m.description.replace(/^(Percents+)?Estimate!!/i, '').replace(/!!/g, ' › ')
      : null;

  const title = mode === 'swap' ? 'Use a different measure'
    : mode === 'add' ? 'Add a second measure to this result'
    : 'Map a different measure';
  const hint = mode === 'swap'
    ? 'Everything else about the analysis stays the same: the area, the ranking, the statistics.'
    : mode === 'add'
      ? '"Side by side" shows both numbers for each county. "Test relationship" gives a rank correlation with a significance test that accounts for neighbouring counties resembling each other.'
      : result
        ? 'Starts a fresh map. A state or region restriction on the current result is kept.'
        : 'Maps it for every county that has a value. Refine it afterwards.';

  const actions = (m: { attr_id: string; label: string }) => {
    if (mode === 'swap') {
      return <MiniButton disabled={disabled || !target}
                         onClick={() => onSend({ kind: 'swap_measure', from: target, to: m.attr_id },
                                               `Use ${m.label} instead`)}>Use this</MiniButton>;
    }
    if (mode === 'map') {
      return <MiniButton disabled={disabled}
                         onClick={() => onSend({ kind: 'map_measure', attr_id: m.attr_id }, `Map ${m.label}`)}>
        Map it</MiniButton>;
    }
    return (
      <>
        {f?.can.compare && (
          <MiniButton disabled={disabled}
                      onClick={() => onSend({ kind: 'add_measure', attr_id: m.attr_id, mode: 'compare' },
                                            `Add ${m.label} alongside`)}>
            <GitCompareArrows className="w-3.5 h-3.5 inline mr-1" />Side by side</MiniButton>
        )}
        {f?.can.correlate && (
          <MiniButton disabled={disabled}
                      onClick={() => onSend({ kind: 'add_measure', attr_id: m.attr_id, mode: 'correlate' },
                                            `Is it related to ${m.label}?`)}>
            Test relationship</MiniButton>
        )}
        {f?.can.add_factor && (
          <MiniButton disabled={disabled}
                      onClick={() => onSend({ kind: 'add_factor', attr_id: m.attr_id }, `Add ${m.label} as a factor`)}>
            Add as factor</MiniButton>
        )}
      </>
    );
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-800">{title}</p>
          <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button type="button" onClick={onClose} className="ml-auto p-1 text-slate-400 hover:text-slate-700"
                aria-label="Close"><X className="w-4 h-4" /></button>
      </div>

      {mode === 'swap' && inUse.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">Replace:</span>
          {inUse.map(m => (
            <label key={m.attr_id} className="text-sm flex items-center gap-1.5">
              <input type="radio" name="swap-target" checked={target === m.attr_id}
                     onChange={() => setTarget(m.attr_id)} />
              {m.label}
            </label>
          ))}
        </div>
      )}
      {mode === 'swap' && inUse.length === 1 && (
        <p className="text-xs text-slate-600">Currently: <strong>{inUse[0].label}</strong></p>
      )}

      <form onSubmit={runSearch} className="flex gap-2">
        <input value={q} onChange={e => setQ(e.target.value)}
               placeholder="Search the catalog, e.g. unemployment rate"
               className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-lg border border-slate-300
                          focus:outline-none focus:ring-2 focus:ring-brand-500" />
        <button type="submit" disabled={searching || !q.trim()}
                className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 bg-white
                           hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5">
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Search
        </button>
        {found && (
          <button type="button" onClick={() => { setFound(null); setQ(''); }}
                  className="text-xs text-slate-500 hover:text-slate-800">Back to suggestions</button>
        )}
      </form>
      {searchError && <p className="text-xs text-red-700">{searchError}</p>}

      <p className="text-xs text-slate-500">
        {found ? `Catalog matches for “${q}” that have data loaded:`
               : 'Found for this question:'}
      </p>
      <ul className="max-h-64 overflow-y-auto divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {mode !== 'swap' && !found && uploads.map(u => (
          <li key={u.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <span className="text-sm text-slate-800">{u.name}</span>
            <span className="text-xs text-emerald-700">your data</span>
            <span className="ml-auto flex gap-1.5">{actions({ attr_id: USER_PREFIX + u.id, label: u.name })}</span>
          </li>
        ))}
        {list.map(m => (
          <li key={m.attr_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-slate-800 truncate" title={m.description ?? m.label}>{m.label}</span>
              <span className="block text-xs text-slate-500 truncate" title={detail(m) ?? undefined}>
                {m.dataset ?? ''}{m.kind === 'feature' ? ' · locations' : ''}
                {detail(m) && <> · <span className="text-slate-600">{detail(m)}</span></>}
              </span>
            </span>
            <span className="flex gap-1.5">{actions(m)}</span>
          </li>
        ))}
        {!list.length && !(mode !== 'swap' && !found && uploads.length) && (
          <li className="px-3 py-3 text-sm text-slate-500">
            {found ? 'Nothing with loaded data matched. Try other words.' : 'No other candidates; search the catalog above.'}
          </li>
        )}
      </ul>
    </div>
  );
};

export default FollowUpBar;
