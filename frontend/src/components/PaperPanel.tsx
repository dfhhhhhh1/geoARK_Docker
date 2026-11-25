import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BookOpenCheck, Check, ChevronDown, ChevronRight, FileText, FlaskConical, Loader2,
  MessageSquareText, Play, Quote, ShoppingCart, Upload, X,
} from 'lucide-react';
import {
  extractPaper, paperCartItems, PAPER_ACCEPT, PAPER_EXT, STATUS_TEXT,
  type ExtractResponse, type MethodPlan, type PaperVariable, type StudyCard,
} from '../lib/paper';
import type { CartItem } from '../lib/cart';

/**
 * Upload a paper -> its study card -> a cart of its data and/or a replication.
 *
 * Everything on the card is what the server could QUOTE from the paper; hover
 * a field for the sentence and page. Every match can be changed before
 * anything runs, because extraction will sometimes be wrong and the reader
 * knows the paper. Nothing runs on upload: replicating is several analyses,
 * started by one click once the card looks right.
 */

interface Props {
  /** A file chosen elsewhere (the Analysis paperclip); read on mount. */
  initialFile?: File | null;
  onAddToCart: (items: CartItem[], states: string[] | null) => void;
  onReplicate: (study: StudyCard, methodIds: string[], title: string) => void;
  /** A method that needs a choice: an editable question for Analysis. */
  onAsk?: (question: string) => void;
  /** A machine-learning method: add its data and pre-select its target. */
  onModel?: (targetAttrId: string) => void;
  onClose?: () => void;
  /** Where the cart lives, for the hint after adding. */
  cartHint?: string;
}

const ROLE_TITLE = { outcome: 'Outcome', exposure: 'Exposures', covariate: 'Covariates' } as const;

const STATUS_CLS: Record<MethodPlan['status'], string> = {
  reproduced: 'bg-emerald-100 text-emerald-800',
  approximated: 'bg-amber-100 text-amber-800',
  ask: 'bg-sky-100 text-sky-800',
  automl: 'bg-violet-100 text-violet-800',
  not_supported: 'bg-slate-200 text-slate-700',
  failed: 'bg-red-100 text-red-800',
};

const MATCH_CLS: Record<PaperVariable['status'], { text: string; cls: string }> = {
  matched: { text: 'matched', cls: 'bg-emerald-100 text-emerald-800' },
  proxy: { text: 'stand-in', cls: 'bg-amber-100 text-amber-800' },
  unchecked: { text: 'unchecked', cls: 'bg-slate-200 text-slate-700' },
  missing: { text: 'not in GeoARK', cls: 'bg-slate-200 text-slate-600' },
  out_of_area: { text: 'outside the US', cls: 'bg-slate-200 text-slate-600' },
  derived: { text: 'computed by GeoARK', cls: 'bg-sky-100 text-sky-800' },
};

const QuoteMark: React.FC<{ quote: string | null; page: number | null }> = ({ quote, page }) =>
  quote ? (
    <span className="inline-flex items-center gap-0.5 text-[11px] text-slate-400 cursor-help align-middle"
          title={`“${quote}”${page ? ` (p. ${page})` : ''}`}>
      <Quote className="w-3 h-3" />{page ? `p. ${page}` : ''}
    </span>
  ) : null;

const fmtYears = (p: StudyCard['period']) => !p ? 'not stated'
  : p.start_year && p.end_year && p.start_year !== p.end_year ? `${p.start_year}–${p.end_year}`
  : String(p.end_year ?? p.start_year ?? 'not stated');

const PaperPanel: React.FC<Props> = ({ initialFile, onAddToCart, onReplicate, onAsk, onModel, onClose, cartHint }) => {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ExtractResponse | null>(null);
  const [study, setStudy] = useState<StudyCard | null>(null);
  const [plans, setPlans] = useState<MethodPlan[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState(0);
  const [showReading, setShowReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - t0), 500);
    return () => window.clearInterval(id);
  }, [busy]);
  // Abort on a real unmount only: React's dev double mount runs this cleanup
  // between two mounts of the same panel, and aborting there would cancel
  // the read it then has to start again (two extractions on the server).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.setTimeout(() => { if (!mounted.current) abort.current?.abort(); }, 0);
    };
  }, []);

  const read = async (f: File) => {
    if (!PAPER_EXT.test(f.name)) { setError('A paper must be a PDF or a Word .docx file.'); return; }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setFile(f); setBusy(true); setError(null); setData(null); setStudy(null); setAdded(0); setElapsed(0);
    try {
      const res = await extractPaper(f, ctl.signal);
      setData(res);
      setStudy(res.study);
      setPlans(res.reproduction);
      setChosen(new Set(res.reproduction.filter(m => m.runs.length).map(m => m.method_id)));
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && abort.current === ctl) setError((e as Error).message);
    } finally {
      // A superseded read (a second file, or React's dev double mount) must
      // not clear the state of the read that replaced it.
      if (abort.current === ctl) setBusy(false);
    }
  };
  const readFor = useRef<File | null>(null);
  useEffect(() => {
    if (!initialFile || readFor.current === initialFile) return;
    readFor.current = initialFile;
    void read(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // After a match changes, ask the server what each method would now do. No
  // execution; the rules live in one place (backend/paper_templates.js).
  const refreshPlans = async (next: StudyCard) => {
    try {
      const res = await fetch('/api/paper/reproduce', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ study: next, dry_run: true }),
      });
      if (!res.ok) return;
      const body = await res.json() as { methods: MethodPlan[] };
      setPlans(body.methods);
      setChosen(prev => {
        const runnable = new Set(body.methods.filter(m => m.runs.length).map(m => m.method_id));
        const keep = new Set([...prev].filter(id => runnable.has(id)));
        for (const id of runnable) if (!plans.some(p => p.method_id === id && p.runs.length)) keep.add(id);
        return keep;
      });
    } catch { /* the old statuses stay; the run itself re-checks */ }
  };

  const select = (vid: string, attrId: string | null) => {
    if (!study) return;
    const next: StudyCard = {
      ...study,
      variables: study.variables.map(v => v.id !== vid ? v : {
        ...v, selected: attrId,
        status: attrId ? (v.status === 'missing' || v.status === 'unchecked' ? 'matched' : v.status) : 'missing',
      }),
    };
    setStudy(next);
    void refreshPlans(next);
  };

  // An index component's cut-off, as the reader corrects it: the paper's
  // wording of a direction ("a threshold of 3218 m") is often ambiguous.
  const setThreshold = (vid: string, t: PaperVariable['threshold'] | null) => {
    if (!study) return;
    const next: StudyCard = {
      ...study,
      variables: study.variables.map(v => {
        if (v.id !== vid) return v;
        const { threshold: _old, ...rest } = v;
        return t ? { ...rest, threshold: t } : rest;
      }),
    };
    setStudy(next);
    void refreshPlans(next);
  };

  const title = study?.title || file?.name.replace(PAPER_EXT, '') || 'the paper';
  const cartItems = useMemo(() => (study ? paperCartItems(study, title) : []), [study, title]);
  // An index's own score is computed from its parts, not brought.
  const missing = study?.variables.filter(v => !v.selected && v.status !== 'derived') ?? [];
  const runnable = plans.filter(m => m.runs.length && chosen.has(m.method_id));
  const outside = study?.area.scope === 'outside_us';

  const byRole = useMemo(() => {
    const m = new Map<PaperVariable['role'], PaperVariable[]>();
    for (const v of study?.variables ?? []) { if (!m.has(v.role)) m.set(v.role, []); m.get(v.role)!.push(v); }
    return (['outcome', 'exposure', 'covariate'] as const).filter(r => m.has(r)).map(r => [r, m.get(r)!] as const);
  }, [study]);

  // ------------------------------------------------------------------ upload
  if (!study) {
    return (
      <section aria-label="Read a paper" className="bg-white/85 rounded-xl border border-slate-300 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <BookOpenCheck className="w-4 h-4 text-brand-700" /> Start from a paper
            </h2>
            <p className="text-sm text-slate-600 mt-1 max-w-2xl">
              Upload a research paper (PDF or Word). GeoARK reads its study area, variables and methods,
              finds the matching data, and can rerun its spatial analysis. The file is read in memory and not kept.
            </p>
          </div>
          {onClose && (
            <button type="button" onClick={() => { abort.current?.abort(); onClose(); }} aria-label="Close"
                    className="text-slate-400 hover:text-slate-700"><X className="w-4 h-4" /></button>
          )}
        </div>
        {busy ? (
          <div className="mt-4 text-sm text-slate-700">
            <p className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Reading {file?.name}… {(elapsed / 1000).toFixed(0)} s
            </p>
            <p className="text-xs text-slate-500 mt-1">
              The paper is read section by section by the local model and every finding is checked against the text.
              A journal article takes a few minutes (about 1.5 to 5 measured), longer when the server is busy.
            </p>
            <button type="button" onClick={() => abort.current?.abort()}
                    className="mt-2 text-xs text-slate-600 underline hover:text-ink">Cancel</button>
          </div>
        ) : (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void read(f); }}
            className={`mt-3 rounded-lg border-2 border-dashed p-5 text-center text-sm transition-colors
                        ${dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white/60'}`}>
            <Upload className="w-5 h-5 mx-auto text-slate-500" />
            <p className="mt-1 text-slate-700">Drop a PDF or .docx here, or{' '}
              <button type="button" onClick={() => inputRef.current?.click()}
                      className="text-brand-700 font-medium underline">choose a file</button>
            </p>
            <input ref={inputRef} type="file" accept={PAPER_ACCEPT} className="hidden"
                   onChange={e => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} />
          </div>
        )}
        {error && (
          <p className="mt-3 text-sm text-red-700 flex items-center gap-2"><AlertTriangle className="w-4 h-4 shrink-0" /> {error}</p>
        )}
      </section>
    );
  }

  // -------------------------------------------------------------- the card
  const r = study.reading;
  const unread = r.skipped.filter(s => s.why === 'length');
  return (
    <section aria-label="Study card" className="bg-white/90 rounded-xl border border-slate-300 p-4 space-y-4 min-w-0">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 flex items-center gap-1">
            <FileText className="w-3 h-3" /> Study card · {data?.file.pages} pages · read in {((data?.ms ?? 0) / 1000).toFixed(0)} s
          </p>
          <h2 className="text-base font-semibold text-ink mt-0.5 break-words">{title}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {study.quotes.kept} of {study.quotes.checked} findings were found word for word in the paper
            {study.quotes.dropped > 0 && <>; {study.quotes.dropped} that were not are left out</>}.{' '}
            <button type="button" onClick={() => setShowReading(s => !s)} className="underline hover:text-ink">
              {showReading ? 'Hide' : 'What was read'}
            </button>
          </p>
          {showReading && (
            <div className="mt-2 text-xs text-slate-600 space-y-1 bg-slate-50 rounded p-2">
              <p><span className="font-medium">Read:</span> {r.read.join(' · ')}</p>
              {r.skipped.length > 0 && (
                <p><span className="font-medium">Not read:</span>{' '}
                  {r.skipped.map(s => `${s.heading} (${s.why === 'length' ? 'over the length limit' : s.why})`).join(' · ')}</p>
              )}
              {r.parts_failed > 0 && <p className="text-amber-700">{r.parts_failed} of {r.parts} parts returned nothing usable.</p>}
              {study.quotes.dropped_items.length > 0 && (
                <details>
                  <summary className="cursor-pointer">Findings left out ({study.quotes.dropped})</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {study.quotes.dropped_items.map((d, i) => (
                      <li key={i}>{d.what}: {d.item} <span className="text-slate-400">({d.why})</span></li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {unread.length > 0 && (
            <p className="mt-1 text-xs text-amber-700 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> The paper is long; {unread.map(s => s.heading).join(', ')} {unread.length === 1 ? 'was' : 'were'} not read.
            </p>
          )}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close study card"
                  className="text-slate-400 hover:text-slate-700 shrink-0"><X className="w-4 h-4" /></button>
        )}
      </header>

      {/* study design */}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Area</dt>
        <dd className="min-w-0">
          {study.area.description || study.area.places.join(', ') || 'not stated'} <QuoteMark quote={study.area.quote} page={study.area.page} />
          <div className={`text-xs ${outside || study.area.scope === 'unknown' ? 'text-amber-700' : 'text-slate-500'}`}>
            {study.area.scope === 'states' && `GeoARK filter: ${study.area.states!.join(', ')}`}
            {study.area.scope === 'national' && (study.area.note ? `GeoARK filter: ${study.area.note}` : 'All counties')}
            {(outside || study.area.scope === 'unknown') && study.area.note}
          </div>
        </dd>
        <dt className="text-slate-500">Unit</dt>
        <dd>{study.unit.value.replace('_', ' ').replace('not stated', 'not stated')} <QuoteMark quote={study.unit.quote} page={study.unit.page} /></dd>
        <dt className="text-slate-500">Period</dt>
        <dd>{fmtYears(study.period)} {study.period && <QuoteMark quote={study.period.quote} page={study.period.page} />}</dd>
      </dl>

      {/* variables */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Variables and the data GeoARK has for them</h3>
        {!study.variables.length && <p className="text-sm text-slate-500 mt-1">No variables could be quoted from the paper.</p>}
        {study.truncated_variables > 0 && (
          <p className="text-xs text-slate-500">{study.truncated_variables} more variables were found than are shown here; the card holds the first 45, outcomes first.</p>
        )}
        {byRole.map(([role, vs]) => (
          <div key={role} className="mt-2">
            <p className="text-[11px] uppercase tracking-wide text-slate-500">{ROLE_TITLE[role]}</p>
            <ul className="divide-y divide-slate-200">
              {vs.map(v => {
                const badge = MATCH_CLS[v.selected ? (v.status === 'missing' || v.status === 'derived' ? 'matched' : v.status)
                  : v.status === 'derived' ? 'derived' : (outside ? 'out_of_area' : 'missing')];
                return (
                  <li key={v.id} className="py-1.5 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-sm">
                    <div className="sm:w-2/5 min-w-0">
                      <span className="text-ink">{v.name}</span> <QuoteMark quote={v.quote} page={v.page} />
                      {(v.threshold || v.group) && (
                        <div className="text-xs text-slate-500">
                          {v.threshold && (
                            <span className="inline-flex items-center gap-1"
                                  title={v.threshold.quote ? `“${v.threshold.quote}”` : undefined}>
                              flagged when
                              <select value={v.threshold.operator} aria-label={`Threshold direction for ${v.name}`}
                                      onChange={e => setThreshold(v.id, { ...v.threshold!, operator: e.target.value })}
                                      className="text-xs bg-white border border-slate-300 rounded px-0.5">
                                {['>', '>=', '<', '<='].map(o => <option key={o} value={o}>{o}</option>)}
                              </select>
                              <input type="number" step="any" defaultValue={v.threshold.value}
                                     aria-label={`Threshold value for ${v.name}`}
                                     onBlur={e => {
                                       const n = Number(e.target.value);
                                       if (e.target.value !== '' && Number.isFinite(n) && n !== v.threshold!.value) setThreshold(v.id, { ...v.threshold!, value: n });
                                     }}
                                     className="w-20 text-xs bg-white border border-slate-300 rounded px-1" />
                              {v.threshold.units && <span>{v.threshold.units}</span>}
                              <button type="button" className="text-slate-400 hover:text-slate-600 underline"
                                      onClick={() => setThreshold(v.id, null)}>not counted</button>
                            </span>
                          )}
                          {v.threshold && v.group && ' · '}
                          {v.group && <span>group: {v.group}</span>}
                        </div>
                      )}
                      {(v.measure || v.source) && (
                        <div className="text-xs text-slate-500 truncate" title={[v.measure, v.source].filter(Boolean).join(' · ')}>
                          {[v.measure, v.source && `source: ${v.source}`].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${badge.cls}`}>{badge.text}</span>
                      {v.matches.length > 0 ? (
                        <select value={v.selected ?? ''} onChange={e => select(v.id, e.target.value || null)}
                                aria-label={`GeoARK data for ${v.name}`}
                                className="min-w-0 flex-1 text-sm bg-white border border-slate-300 rounded px-1.5 py-1">
                          <option value="">Not in GeoARK's data</option>
                          {v.matches.map(m => (
                            <option key={m.attr_id} value={m.attr_id} title={m.description ?? undefined}>
                              {m.label}{m.dataset ? ` (${m.dataset})` : ''}{m.kind === 'feature' ? ' [locations]' : m.kind === 'raster' ? ' [raster]' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-slate-500">no candidates</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {missing.length > 0 && !outside && (
          <p className="mt-2 text-xs text-slate-600">
            <span className="font-medium">To bring yourself:</span>{' '}
            {missing.map(v => v.source ? `${v.name} (${v.source})` : v.name).join('; ')}
          </p>
        )}
      </div>

      {/* methods */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Methods</h3>
        {!plans.length && <p className="text-sm text-slate-500 mt-1">No analysis methods could be quoted from the paper.</p>}
        <ul className="mt-1 space-y-2">
          {plans.map(m => (
            <li key={m.method_id} className="text-sm flex gap-2">
              <input type="checkbox" className="mt-1 accent-brand-700" aria-label={`Replicate ${m.technique}`}
                     disabled={!m.runs.length} checked={chosen.has(m.method_id)}
                     onChange={e => setChosen(s => { const n = new Set(s); if (e.target.checked) n.add(m.method_id); else n.delete(m.method_id); return n; })} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-ink">{m.technique}</span>
                  <QuoteMark quote={m.quote} page={m.page} />
                  <span className={`text-[11px] px-1.5 py-0.5 rounded ${STATUS_CLS[m.status]}`}>{STATUS_TEXT[m.status]}</span>
                </div>
                <p className="text-xs text-slate-600">{m.reason}</p>
                {m.status === 'ask' && m.question && onAsk && (
                  <button type="button" onClick={() => onAsk(m.question!)}
                          className="mt-1 inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
                    <MessageSquareText className="w-3 h-3" /> Ask in Analysis: “{m.question}”
                  </button>
                )}
                {m.status === 'automl' && m.automl && onModel && (
                  <button type="button"
                          onClick={() => { onAddToCart(cartItems, study.area.states); setAdded(cartItems.length); onModel(m.automl!.target); }}
                          className="mt-1 inline-flex items-center gap-1 text-xs text-violet-800 hover:underline">
                    <FlaskConical className="w-3 h-3" /> Add the data to the cart with this target, then build the table and run “Model this”
                  </button>
                )}
                {m.status === 'automl' && !onModel && (
                  <p className="mt-1 text-xs text-violet-800 flex items-center gap-1">
                    <FlaskConical className="w-3 h-3" /> Add the data to the cart, then use “Model this” on the Data cart page.
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-200">
        <button type="button" disabled={!cartItems.length}
                onClick={() => { onAddToCart(cartItems, study.area.states); setAdded(cartItems.length); }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white text-sm px-3 py-1.5
                           hover:bg-slate-50 disabled:opacity-50">
          {added ? <Check className="w-4 h-4 text-emerald-700" /> : <ShoppingCart className="w-4 h-4" />}
          {added ? `Added ${added} to the cart`
            : (cartItems.total ?? 0) > cartItems.length
              ? `Add the first ${cartItems.length} of ${cartItems.total} measures to the cart`
              : `Add ${cartItems.length} measures to the cart`}
        </button>
        <button type="button" disabled={!runnable.length || outside}
                onClick={() => onReplicate(study, runnable.map(m => m.method_id), title)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-ink text-white text-sm font-medium px-3 py-1.5
                           hover:bg-brand-700 disabled:bg-slate-400/60">
          <Play className="w-4 h-4" />
          Replicate {runnable.length} {runnable.length === 1 ? 'method' : 'methods'}
        </button>
        {added > 0 && cartHint && <span className="mt-3 text-xs text-slate-500">{cartHint}</span>}
        <button type="button" onClick={() => { setStudy(null); setData(null); setFile(null); }}
                className="mt-3 ml-auto text-xs text-slate-500 underline hover:text-ink inline-flex items-center gap-1">
          <ChevronRight className="w-3 h-3" />Another paper
        </button>
      </div>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer inline-flex items-center gap-1"><ChevronDown className="w-3 h-3" />How replication works</summary>
        <p className="mt-1">
          Each method runs as an ordinary GeoARK analysis built from a fixed template over the data chosen above (no
          free planning), checked by the same validator as any question. “Approximated” says what differs from the
          paper. Results open as answers in Analysis, where you can follow up on each.
        </p>
      </details>
    </section>
  );
};

export default PaperPanel;
