import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Eye, FileText, GitBranch, Minimize2, Maximize2,
  Layers, Loader2, PencilLine, Replace, X, XCircle, MapPinned, Info,
} from 'lucide-react';
import type { AnalysisResponse, FollowUpEdit, PlanOp, WorkflowStep } from '../types';
import { OP_LABEL } from '../lib/ops';
import { fmtValue, isResultAttr, stepDataLabel } from '../lib/workflow';
import ComparisonCard from './ComparisonCard';
import AnalysisReport from './AnalysisReport';
import ErrorBoundary from './ErrorBoundary';
import { MeasurePanel } from './FollowUpBar';

/**
 * A multi-step analysis as a pipeline, docked along the bottom of the map.
 *
 * Research workflows (backend/workflow.js) are a short chain of ordinary
 * analyses where a later one works on the counties an earlier one produced.
 * The chain IS the method, so it is drawn as one: numbered steps left to
 * right, with the hand-off between them labelled ("30 counties ->"). Each step
 * can be put on the map, inspected, and have the data it uses changed, which
 * re-runs that step and everything after it with the same plans in seconds.
 *
 * Lives over the map rather than in the conversation panel because a step is
 * a MAP: selecting one replaces what the stage draws, and the strip stays in
 * view while the panel is collapsed.
 */

interface Props {
  result: AnalysisResponse;
  /** The step drawn on the map; null means the final answer. */
  selected: string | null;
  onSelect: (stepId: string | null) => void;
  onEditStep: (stepId: string, edit: FollowUpEdit, text: string) => void;
  busy: boolean;
  /** Left edge on desktop, clear of the conversation panel. */
  left: number;
  isDesktop: boolean;
  /** Reports the strip's height so the map and its legend can sit above it. */
  onHeight?: (px: number) => void;
}

/** "Load › Rank › Output" without the bookkeeping steps. */
function opsLine(ops: PlanOp[]): string {
  return ops.filter(o => o !== 'output').map(o => OP_LABEL[o] ?? o).join(' › ');
}

/** One line for what a step produced. */
function resultLine(s: WorkflowStep): string {
  const c = s.result?.comparison;
  if (c) return `${fmtValue(c.median_a)} vs ${fmtValue(c.median_b)} (median)`;
  if (s.result?.stats) return `ρ = ${s.result.stats.value?.toFixed(2) ?? '–'}`;
  if (!s.summary) return s.error ? 'no result' : '–';
  const { counties, min, max } = s.summary;
  return `${counties.toLocaleString()} ${counties === 1 ? 'county' : 'counties'} · ${fmtValue(min)}–${fmtValue(max)}`;
}

const WorkflowPipeline: React.FC<Props> = ({
  result, selected, onSelect, onEditStep, busy, left, isDesktop, onHeight,
}) => {
  const w = result.workflow!;
  const [inspected, setInspected] = useState<string | null>(null);
  const [showMethods, setShowMethods] = useState(false);
  // Collapsed to a pill in the corner, so the whole map is visible. Remembered:
  // a reader who works with the strip out of the way wants it that way next time.
  const [collapsed, setCollapsedState] = useState<boolean>(() => {
    try { return window.localStorage.getItem('geoark.pipeline.collapsed') === '1'; } catch { return false; }
  });
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    if (v) { setInspected(null); setShowMethods(false); }
    try { window.localStorage.setItem('geoark.pipeline.collapsed', v ? '1' : '0'); } catch { /* preference only */ }
  };
  // The STRIP's height only, not the inspector's: the inspector opens over the
  // map on demand, and counting it pushed the map's fit into a sliver above it,
  // which then stayed after the inspector closed.
  const stripRef = useRef<HTMLElement>(null);

  // Steps that were planned but never ran (the workflow stopped first) are
  // still drawn, greyed, so the chain reads as what was attempted.
  const planned = w.decomposition?.steps ?? [];
  const ranIds = new Set(w.steps.map(s => s.id));
  const pending = planned.filter(p => !ranIds.has(p.id));
  const finalId = w.steps[w.steps.length - 1]?.id ?? null;
  const total = w.steps.length + pending.length;

  // A new result (a re-run, or another answer) closes the inspector unless the
  // inspected step still exists.
  useEffect(() => {
    if (inspected && !w.steps.some(s => s.id === inspected)) setInspected(null);
  }, [w, inspected]);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight, collapsed]);
  useEffect(() => () => onHeight?.(0), [onHeight]);

  const status = w.status === 'complete'
    ? { icon: <CheckCircle2 className="w-3.5 h-3.5" />, text: 'Complete', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' }
    : { icon: <XCircle className="w-3.5 h-3.5" />, text: `Stopped at step ${planned.findIndex(p => p.id === w.stopped_at) + 1}`,
        cls: 'text-red-700 bg-red-50 border-red-200' };
  const editedIdx = w.edited_step ? w.steps.findIndex(s => s.id === w.edited_step) + 1 : 0;
  const inspectedStep = w.steps.find(s => s.id === inspected) ?? null;

  const style: React.CSSProperties = isDesktop
    ? { left, right: 12, bottom: 12 }
    : { left: 12, right: 12, top: 'calc(var(--header-offset) + 3.25rem)' };

  if (collapsed) {
    return (
      <div className="fixed z-[1050] pointer-events-none"
           style={isDesktop ? { left, bottom: 12 } : { left: 12, top: 'calc(var(--header-offset) + 3.25rem)' }}>
        <button
          ref={stripRef as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={() => setCollapsed(false)}
          title="Show the steps of this analysis"
          className="pointer-events-auto glass glass-raisable glass-floor rounded-xl pl-3 pr-2.5 py-2
                     flex items-center gap-2.5 text-sm text-ink"
        >
          <GitBranch className="w-4 h-4 text-slate-500 rotate-90" />
          <span className="font-medium">Multi-step analysis</span>
          {/* The chain in miniature: numbered steps, the one on the map dark. */}
          <span className="flex items-center gap-1" aria-hidden>
            {w.steps.map((st, i) => (
              <React.Fragment key={st.id}>
                {i > 0 && <ArrowRight className="w-3 h-3 text-slate-400" />}
                <span className={`w-5 h-5 rounded-full text-[11px] font-semibold tabular-nums flex items-center justify-center
                  ${w.stopped_at === st.id ? 'bg-red-600 text-white'
                    : (selected ?? finalId) === st.id ? 'bg-ink text-white' : 'bg-slate-200 text-slate-700'}`}>
                  {i + 1}
                </span>
              </React.Fragment>
            ))}
          </span>
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded-full border ${status.cls}`}>
            {status.icon}<span className="hidden sm:inline">{status.text}</span>
          </span>
          <Maximize2 className="w-4 h-4 text-slate-500" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed z-[1050] flex flex-col gap-2 pointer-events-none" style={style}
         aria-label="Multi-step analysis">
      {/* Inspector and methods open ABOVE the strip on desktop, below it on a
          phone (where the strip sits at the top). */}
      {isDesktop && (inspectedStep || showMethods) && (
        <Drawer>
          {showMethods ? (
            <Methods text={w.methods} onClose={() => setShowMethods(false)} />
          ) : inspectedStep && (
            <Inspector step={inspectedStep} index={w.steps.indexOf(inspectedStep) + 1} total={total}
                       steps={w.steps} busy={busy} isFinal={inspectedStep.id === finalId}
                       onClose={() => setInspected(null)}
                       onShow={() => onSelect(inspectedStep.id === finalId ? null : inspectedStep.id)}
                       shown={(selected ?? finalId) === inspectedStep.id}
                       onEdit={(edit, text) => onEditStep(inspectedStep.id, edit, text)} />
          )}
        </Drawer>
      )}

      <section ref={stripRef} className="pointer-events-auto glass glass-raisable glass-floor rounded-2xl">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pt-3 pb-2">
          <GitBranch className="w-4 h-4 text-slate-500 rotate-90" />
          <div className="min-w-0 mr-auto">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Multi-step analysis · {total} steps
            </p>
            <p className="text-sm font-medium text-ink truncate max-w-[38rem]" title={w.question}>{w.question}</p>
          </div>
          <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${status.cls}`}>
            {status.icon}{status.text}
          </span>
          {editedIdx > 0 && (
            <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border
                             text-amber-800 bg-amber-50 border-amber-200">
              <PencilLine className="w-3.5 h-3.5" /> Step {editedIdx} data changed
            </span>
          )}
          <span className="text-xs text-slate-500 tabular-nums">{(w.ms / 1000).toFixed(0)} s</span>
          <div className="flex items-center gap-1">
            {w.methods && (
              <HeaderButton active={showMethods} onClick={() => { setShowMethods(m => !m); setInspected(null); }}
                            title="The method, step by step">
                <FileText className="w-4 h-4" /><span className="hidden lg:inline">Methods</span>
              </HeaderButton>
            )}
            <HeaderButton active={selected === null} onClick={() => onSelect(null)}
                          title="Show the final answer on the map">
              <MapPinned className="w-4 h-4" /><span className="hidden lg:inline">Answer</span>
            </HeaderButton>
            <HeaderButton onClick={() => setCollapsed(true)} title="Collapse the steps to a small bar">
              <Minimize2 className="w-4 h-4" />
            </HeaderButton>
          </div>
        </div>

        {w.status !== 'complete' && w.reason && (
          <p className="mx-4 mb-2 text-xs text-red-800 bg-red-50/80 border border-red-200 rounded-lg px-3 py-1.5">
            {w.reason}
          </p>
        )}

        {/* The chain */}
        {(
          <ol className="flex items-stretch gap-0 overflow-x-auto px-4 pb-3.5 pt-0.5 [scrollbar-width:thin]">
            {w.steps.map((s, i) => {
              const next = w.steps[i + 1] ?? pending[0];
              const feedsNext = !!next && (next.uses ?? []).includes(s.id);
              return (
                <React.Fragment key={s.id}>
                  <StepNode
                    step={s} index={i + 1} isFinal={s.id === finalId && w.status === 'complete'}
                    failed={w.stopped_at === s.id}
                    onMap={(selected ?? finalId) === s.id}
                    inspected={inspected === s.id}
                    onShow={() => onSelect(s.id === finalId ? null : s.id)}
                    onInspect={() => { setInspected(x => (x === s.id ? null : s.id)); setShowMethods(false); }}
                  />
                  {next && <Connector feeds={feedsNext} label={feedsNext && s.summary
                    ? `${s.summary.counties.toLocaleString()} counties` : null} />}
                </React.Fragment>
              );
            })}
            {pending.map((p, j) => (
              <React.Fragment key={p.id}>
                <PendingNode index={w.steps.length + j + 1} question={p.question} />
                {j < pending.length - 1 && <Connector feeds={false} label={null} />}
              </React.Fragment>
            ))}
          </ol>
        )}
      </section>

      {!isDesktop && (inspectedStep || showMethods) && (
        <Drawer>
          {showMethods ? (
            <Methods text={w.methods} onClose={() => setShowMethods(false)} />
          ) : inspectedStep && (
            <Inspector step={inspectedStep} index={w.steps.indexOf(inspectedStep) + 1} total={total}
                       steps={w.steps} busy={busy} isFinal={inspectedStep.id === finalId}
                       onClose={() => setInspected(null)}
                       onShow={() => onSelect(inspectedStep.id === finalId ? null : inspectedStep.id)}
                       shown={(selected ?? finalId) === inspectedStep.id}
                       onEdit={(edit, text) => onEditStep(inspectedStep.id, edit, text)} />
          )}
        </Drawer>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const HeaderButton: React.FC<{
  onClick: () => void; title: string; active?: boolean; children: React.ReactNode;
}> = ({ onClick, title, active = false, children }) => (
  <button type="button" onClick={onClick} title={title} aria-pressed={active}
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded-lg transition-colors
            ${active ? 'bg-ink text-white' : 'text-slate-600 hover:text-ink hover:bg-white/70'}`}>
    {children}
  </button>
);

const StepNode: React.FC<{
  step: WorkflowStep;
  index: number;
  isFinal: boolean;
  failed: boolean;
  onMap: boolean;
  inspected: boolean;
  onShow: () => void;
  onInspect: () => void;
}> = ({ step: s, index, isFinal, failed, onMap, inspected, onShow, onInspect }) => {
  const data = stepDataLabel(s);
  return (
    <li className={`relative shrink-0 w-[17.5rem] rounded-xl border bg-white/85 transition-all
                    ${inspected ? 'ring-2 ring-brand-400 border-transparent' : onMap ? 'border-ink' : 'border-slate-200'}
                    ${failed ? 'border-red-300 bg-red-50/70' : ''}`}>
      <button type="button" onClick={onInspect} className="w-full text-left px-3.5 pt-3 pb-2 block"
              aria-expanded={inspected} title="Inspect this step">
        <div className="flex items-center gap-2">
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold tabular-nums
                            ${failed ? 'bg-red-600 text-white' : onMap ? 'bg-ink text-white' : 'bg-slate-200 text-slate-700'}`}>
            {index}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {isFinal ? 'Answer' : `Step ${index}`}
          </span>
          {s.uses.length > 0 && (
            <span className="text-[11px] text-slate-500">· uses {s.uses.map(u => u.replace('q', '')).join(', ')}</span>
          )}
          <span className="ml-auto flex items-center gap-1">
            {s.edited && <PencilLine className="w-3.5 h-3.5 text-amber-600" aria-label="Data changed" />}
            {failed ? <XCircle className="w-4 h-4 text-red-600" /> : s.error ? null
              : <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-ink leading-snug line-clamp-2 min-h-[2.5rem]" title={s.question}>
          {s.question.replace(/\bthe counties from q(\d)\b/gi, 'the counties from step $1')}
        </p>
        <p className="mt-1.5 text-[11px] text-slate-500 truncate" title={opsLine(s.ops)}>{opsLine(s.ops) || '–'}</p>
        <p className="mt-1 text-xs text-slate-700 truncate flex items-center gap-1" title={data ?? undefined}>
          <Layers className="w-3.5 h-3.5 shrink-0 text-slate-400" />
          <span className="truncate">{data ?? 'no data'}</span>
        </p>
      </button>
      <div className="flex items-center gap-2 border-t border-slate-200/80 px-3.5 py-1.5">
        <span className={`text-xs tabular-nums truncate ${failed ? 'text-red-700' : 'text-slate-700 font-medium'}`}>
          {failed ? (s.error ?? 'stopped') : resultLine(s)}
        </span>
        {!failed && s.result && (
          <button type="button" onClick={onShow} aria-pressed={onMap}
                  className={`ml-auto shrink-0 inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md transition-colors
                    ${onMap ? 'bg-ink text-white' : 'text-brand-700 hover:bg-slate-100'}`}>
            <Eye className="w-3.5 h-3.5" /> {onMap ? 'On map' : 'Map'}
          </button>
        )}
      </div>
    </li>
  );
};

const PendingNode: React.FC<{ index: number; question: string }> = ({ index, question }) => (
  <li className="shrink-0 w-[17.5rem] rounded-xl border border-dashed border-slate-300 bg-white/40 px-3.5 py-3">
    <div className="flex items-center gap-2">
      <span className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold bg-slate-100 text-slate-400">
        {index}
      </span>
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Not run</span>
    </div>
    <p className="mt-1.5 text-sm text-slate-500 leading-snug line-clamp-2">
      {question.replace(/\bthe counties from q(\d)\b/gi, 'the counties from step $1')}
    </p>
  </li>
);

/** The hand-off between two steps: what flows into the next one. */
const Connector: React.FC<{ feeds: boolean; label: string | null }> = ({ feeds, label }) => (
  <li aria-hidden className="shrink-0 w-24 flex flex-col items-center justify-center px-1 text-center">
    {label && <span className="text-[10px] font-medium text-slate-600 leading-tight mb-1 tabular-nums">{label}</span>}
    <span className={`flex items-center w-full ${feeds ? 'text-ink' : 'text-slate-300'}`}>
      <span className={`flex-1 h-px ${feeds ? 'bg-ink' : 'border-t border-dashed border-slate-300'}`} />
      <ArrowRight className="w-4 h-4 -ml-1" />
    </span>
    {feeds && <span className="text-[10px] text-slate-500 mt-1">feeds next</span>}
  </li>
);

const Drawer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="pointer-events-auto glass glass-raisable rounded-2xl max-h-[min(52vh,34rem)] overflow-y-auto
                  overscroll-contain md:max-w-[52rem]">
    {children}
  </div>
);

const Methods: React.FC<{ text: string | null; onClose: () => void }> = ({ text, onClose }) => (
  <div className="p-4">
    <div className="flex items-center gap-2 mb-2">
      <FileText className="w-4 h-4 text-slate-500" />
      <h3 className="text-sm font-semibold text-ink mr-auto">Methods</h3>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(text ?? '')}
              className="text-xs text-brand-700 hover:underline">Copy</button>
      <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close">
        <X className="w-4 h-4" />
      </button>
    </div>
    <pre className="text-xs leading-relaxed text-slate-700 whitespace-pre-wrap font-mono bg-white/70
                    border border-slate-200 rounded-lg p-3">{text}</pre>
  </div>
);

const Inspector: React.FC<{
  step: WorkflowStep;
  index: number;
  total: number;
  steps: WorkflowStep[];
  busy: boolean;
  isFinal: boolean;
  shown: boolean;
  onClose: () => void;
  onShow: () => void;
  onEdit: (edit: FollowUpEdit, text: string) => void;
}> = ({ step: s, index, total, steps, busy, isFinal, shown, onClose, onShow, onEdit }) => {
  const [changing, setChanging] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const r = s.result;
  const own = (s.attribute_origins ?? []).filter(o => !isResultAttr(o.attr_id));
  const inputs = s.uses.map(u => steps.findIndex(x => x.id === u) + 1).filter(n => n > 0);
  const downstream = steps.slice(index).length;
  const canChange = !!r?.followups?.can?.swap &&
    (r.followups.in_use ?? []).some(m => !isResultAttr(m.attr_id));

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 shrink-0 rounded-full bg-ink text-white flex items-center justify-center text-sm font-semibold">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Step {index} of {total}{isFinal ? ' · the answer' : ''}
            {inputs.length > 0 && <> · works on the counties from step {inputs.join(', ')}</>}
          </p>
          <h3 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {s.question.replace(/\bthe counties from q(\d)\b/gi, 'the counties from step $1')}
          </h3>
          {s.intent && <p className="text-sm text-slate-600 mt-0.5">Planned as: {s.intent}</p>}
        </div>
        <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {s.error && (
        <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{s.error}</p>
      )}

      {/* What it produced */}
      {r?.comparison ? (
        <ComparisonCard result={r} comparison={r.comparison} compact />
      ) : s.summary ? (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Counties" value={s.summary.counties.toLocaleString()} />
          <Stat label="Lowest" value={fmtValue(s.summary.min)} />
          <Stat label="Highest" value={fmtValue(s.summary.max)} />
          {s.summary.examples.length > 0 && (
            <p className="col-span-3 text-xs text-slate-600 truncate">
              Highest values: {s.summary.examples.join(', ')}
            </p>
          )}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {r && !s.error && (
          <button type="button" onClick={onShow} disabled={shown}
                  className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-ink text-white
                             hover:bg-brand-700 disabled:bg-slate-300 disabled:text-slate-600 transition-colors">
            <Eye className="w-4 h-4" /> {shown ? 'On the map' : 'Show on the map'}
          </button>
        )}
        {canChange && (
          <button type="button" onClick={() => setChanging(c => !c)} disabled={busy} aria-expanded={changing}
                  className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors
                    disabled:opacity-40 ${changing ? 'border-ink bg-white text-ink' : 'border-slate-300 bg-white/80 text-slate-700 hover:border-brand-400'}`}>
            <Replace className="w-4 h-4" /> Change data
          </button>
        )}
        <button type="button" onClick={() => setShowPlan(p => !p)} aria-expanded={showPlan}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg text-slate-700 hover:bg-white/70">
          {showPlan ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />} Plan and SQL
        </button>
        {busy && <Loader2 className="w-4 h-4 animate-spin text-brand-700 self-center" />}
      </div>

      {changing && r && (
        <div>
          <MeasurePanel
            mode="swap" result={r} uploads={[]} disabled={busy}
            locked={isResultAttr}
            title={`Change the data in step ${index}`}
            hint={downstream > 0
              ? `Step ${index} re-runs with the new data, then the ${downstream === 1 ? 'step' : `${downstream} steps`} after it, using the same plans. No re-planning; seconds, not minutes.`
              : `Step ${index} re-runs with the new data, using the same plan.`}
            onSend={(edit, text) => { setChanging(false); onEdit(edit, text ?? 'Change data'); }}
            onClose={() => setChanging(false)}
          />
        </div>
      )}

      {/* Data this step reads */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 mb-1.5">Data used</p>
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white/80">
          {inputs.map(n => (
            <li key={`in-${n}`} className="flex items-center gap-2 px-3 py-2 text-sm">
              <GitBranch className="w-4 h-4 text-slate-400 rotate-90" />
              <span className="text-slate-800">Counties from step {n}</span>
              <span className="ml-auto text-xs text-slate-500">earlier result</span>
            </li>
          ))}
          {own.map(o => (
            <li key={o.attr_id} className="flex items-center gap-2 px-3 py-2 text-sm min-w-0">
              <Layers className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="text-slate-800 truncate" title={o.description ?? undefined}>
                {(o.description ?? o.census_code ?? o.attr_id).replace(/[|!]{1,2}/g, ' › ')}
              </span>
              <span className="ml-auto text-xs text-slate-500 shrink-0">
                {[o.dataset, o.start_date].filter(Boolean).join(', ')}
              </span>
            </li>
          ))}
          {!own.length && !inputs.length && (
            <li className="px-3 py-2 text-sm text-slate-500">No data recorded for this step.</li>
          )}
        </ul>
      </div>

      {(s.definitions.length > 0 || s.adjustments.length > 0) && (
        <div className="space-y-1">
          {s.definitions.map(d => (
            <p key={d.id + d.step} className="text-xs text-slate-600 flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
              <span>Definition used: “{d.term}” = {d.rule}. Source: {d.source}.</span>
            </p>
          ))}
          {s.adjustments.map(a => (
            <p key={a} className="text-xs text-amber-800 flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" /><span>{a}</span>
            </p>
          ))}
        </div>
      )}

      {showPlan && r && (
        <ErrorBoundary label="the plan">
          <AnalysisReport result={r} />
        </ErrorBoundary>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded-lg border border-slate-200 bg-white/80 px-3 py-2">
    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    <p className="text-lg font-semibold tabular-nums text-ink">{value}</p>
  </div>
);

export default WorkflowPipeline;
