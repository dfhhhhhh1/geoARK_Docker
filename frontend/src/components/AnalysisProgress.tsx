import React from 'react';
import Skeleton, { SkeletonTheme } from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import type { AnalysisEvent, AnalysisStage } from '../types';

/**
 * Progress for a long analysis.
 *
 * Four phases, in the order the server emits them. They are collapsed from the
 * raw stages because "plan_invalid -> planning" is a retry loop the user should
 * see as one phase that is taking a while, not as a failure.
 */
const PHASES = [
  { key: 'understand', label: 'Understanding the question',
    reached: ['decomposed', 'retrieved', 'planning', 'plan_invalid', 'plan_valid', 'executing', 'done'] },
  { key: 'search', label: 'Searching the catalog',
    reached: ['retrieved', 'planning', 'plan_invalid', 'plan_valid', 'executing', 'done'] },
  { key: 'plan', label: 'Planning the analysis',
    reached: ['plan_valid', 'executing', 'done'] },
  { key: 'execute', label: 'Running the query',
    reached: ['done'] },
] as const;

/** Which phase is in flight for a given stage. */
const ACTIVE_PHASE: Partial<Record<AnalysisStage, string>> = {
  queued: 'understand',
  started: 'understand',
  decomposed: 'search',
  retrieved: 'plan',
  planning: 'plan',
  plan_invalid: 'plan',
  plan_valid: 'execute',
  executing: 'execute',
};

interface Props {
  stage: AnalysisStage;
  events: AnalysisEvent[];
  elapsedMs: number;
  onCancel: () => void;
}

const AnalysisProgress: React.FC<Props> = ({ stage, events, elapsedMs, onCancel }) => {
  const failed = stage === 'failed';
  const activePhase = ACTIVE_PHASE[stage];

  const last = <K extends keyof AnalysisEvent>(key: K): AnalysisEvent[K] | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i][key] !== undefined) return events[i][key];
    }
    return undefined;
  };

  const retrieved = last('retrieved');
  const executable = last('executable');
  const attempt = last('attempt');
  const queuePosition = last('position');
  const planErrors = events.filter(e => e.stage === 'plan_invalid').length;
  // Deterministic corrections, surfaced so a filter that could not be applied
  // is visible rather than silently widening the result.
  const adjustments = events
    .filter(e => e.stage === 'plan_adjusted' && e.detail)
    .map(e => e.detail as string);

  // Detail lines are only shown once their phase has actually reported, so the
  // panel never displays a number it is guessing at.
  const detailFor = (key: string): string | null => {
    if (key === 'understand') {
      const d = last('decomposition');
      return d ? `${d.primary_concepts.length} concept(s), ${d.geographic_level.toLowerCase()} level` : null;
    }
    if (key === 'search' && retrieved !== undefined) {
      return executable !== undefined
        ? `${retrieved} retrieved, ${executable} executable`
        : `${retrieved} retrieved`;
    }
    if (key === 'plan') {
      if (stage === 'planning' || stage === 'plan_invalid') {
        return planErrors > 0
          ? `attempt ${attempt ?? 1}, repairing ${planErrors} validation error(s)`
          : `attempt ${attempt ?? 1}`;
      }
      const ops = last('ops');
      if (ops) return ops.join(' → ');
    }
    return null;
  };

  const stateOf = (phase: typeof PHASES[number]): 'done' | 'active' | 'failed' | 'pending' => {
    if (phase.reached.includes(stage as never)) return 'done';
    // The stream does not say which phase a failure happened in, so every
    // unfinished segment is marked and the heading carries the message.
    if (failed) return 'failed';
    return activePhase === phase.key ? 'active' : 'pending';
  };
  const STATUS: Record<ReturnType<typeof stateOf>, string> = {
    done: 'Done', active: 'In progress', failed: '', pending: '',
  };

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-baseline justify-between gap-3 mb-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            {failed ? 'Analysis stopped' : stage === 'queued' ? 'Waiting to start' : 'Analysis in progress'}
          </h3>
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-mono tabular-nums text-ink">
              {(elapsedMs / 1000).toFixed(1)}s
            </span>
            {!failed && (
              <button
                onClick={onCancel}
                className="text-xs font-medium text-slate-500 hover:text-ink underline underline-offset-2"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* One segment per phase: a glance says how far along, without an icon
            per row doing the same job four times. */}
        <div className="grid grid-cols-4 gap-1.5 mb-5" aria-hidden>
          {PHASES.map(p => <div key={p.key} className="rail-seg" data-state={stateOf(p)} />)}
        </div>

        {/* The GPU runs one analysis at a time, so a wait here is a real queue
            rather than a slow step. Saying which place you are in is the
            difference between a queue and an unexplained delay. */}
        {stage === 'queued' && (
          <p className="mb-4 border-l-2 border-brand-400 pl-3 text-sm text-slate-700">
            {queuePosition && queuePosition > 1
              ? <>Position <strong className="text-ink">{queuePosition}</strong> in the queue. Each analysis takes roughly 20 seconds.</>
              : <>Next in line, starting shortly.</>}
          </p>
        )}

        <ol className="space-y-2.5">
          {PHASES.map((phase, i) => {
            const st = stateOf(phase);
            const detail = detailFor(phase.key);
            return (
              <li key={phase.key} className="grid grid-cols-[1.75rem_1fr_auto] gap-x-2 items-baseline">
                <span className={`font-mono text-xs tabular-nums ${
                  st === 'active' ? 'text-brand-700 font-semibold'
                    : st === 'done' ? 'text-ink' : 'text-slate-400'}`}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <p className={`text-sm ${st === 'pending' || st === 'failed' ? 'text-slate-400' : 'text-ink font-medium'}`}>
                  {phase.label}
                </p>
                <span className={`text-[11px] uppercase tracking-wider ${
                  st === 'active' ? 'text-brand-700' : 'text-slate-400'}`}>
                  {STATUS[st]}
                </span>
                {detail && (
                  <p className="col-start-2 col-span-2 text-xs text-slate-500 mt-0.5">{detail}</p>
                )}
              </li>
            );
          })}
        </ol>

        {/* Planning is the one phase that can sit silent for 30s+ inside a single
            LLM call, so it gets an explicit reassurance rather than a stalled bar. */}
        {(stage === 'planning' || stage === 'plan_invalid') && elapsedMs > 12000 && (
          <p className="mt-4 text-xs text-slate-500 border-t border-slate-200 pt-3">
            The planner runs a 14B model locally. Thirty seconds or so is normal.
          </p>
        )}

        {adjustments.length > 0 && (
          <ul className="mt-4 border-t border-slate-200 pt-3 space-y-1">
            {[...new Set(adjustments)].map(a => (
              <li key={a} className="text-xs text-amber-800">{a}</li>
            ))}
          </ul>
        )}
      </div>

      {!failed && <ResultSkeleton />}
    </div>
  );
};

/**
 * Placeholder in the shape of the real result, so the panel does not jump when
 * it lands: a title and export row, the view tabs, a run of table rows, then
 * the report. Warm neutrals with a pale gold sweep, translucent so it sits in
 * the glass rather than on it.
 */
const ResultSkeleton: React.FC = () => (
  <SkeletonTheme baseColor="rgba(28, 25, 20, 0.07)" highlightColor="rgba(255, 244, 214, 0.75)"
                 borderRadius="0.375rem" duration={1.6}>
    <div className="space-y-4" aria-hidden>
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-4">
          <Skeleton width={72} height={16} />
          <div className="flex gap-1.5">
            {[0, 1, 2].map(i => <Skeleton key={i} width={56} height={24} />)}
          </div>
        </div>
        <div className="mt-4"><Skeleton width={190} height={26} /></div>
        <div className="mt-4 space-y-2">
          {[92, 78, 85, 70, 88, 64].map((w, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton width={18} height={10} />
              <div className="flex-1"><Skeleton width={`${w}%`} height={10} /></div>
              <Skeleton width={44} height={10} />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2.5">
        <Skeleton width="40%" height={14} />
        <Skeleton count={3} height={10} />
      </div>
    </div>
  </SkeletonTheme>
);

export default AnalysisProgress;
