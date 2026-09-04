import React from 'react';
import Skeleton, { SkeletonTheme } from 'react-loading-skeleton';
import { Check, Loader2, AlertTriangle, Circle, Users } from 'lucide-react';
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

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-semibold text-slate-800">
            {failed ? 'Analysis failed' : stage === 'queued' ? 'Waiting to start' : 'Analyzing'}
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-slate-500">
              {(elapsedMs / 1000).toFixed(1)}s
            </span>
            {!failed && (
              <button
                onClick={onCancel}
                className="text-sm text-slate-500 hover:text-slate-800 underline underline-offset-2"
              >
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* The GPU runs one analysis at a time, so a wait here is a real queue
            rather than a slow step. Saying which place you are in is the
            difference between a queue and an unexplained delay. */}
        {stage === 'queued' && (
          <div className="mb-4 flex gap-2 bg-blue-50 border border-blue-200
                          text-blue-900 rounded-lg p-3 text-sm">
            <Users className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {queuePosition && queuePosition > 1
                ? <>Position <strong>{queuePosition}</strong> in the queue. Each analysis takes roughly 20 seconds.</>
                : <>Next in line, starting shortly.</>}
            </span>
          </div>
        )}

        <ol className="space-y-3">
          {PHASES.map(phase => {
            const done = phase.reached.includes(stage as never);
            const active = activePhase === phase.key && !failed;
            const detail = detailFor(phase.key);

            return (
              <li key={phase.key} className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0">
                  {done ? (
                    <Check className="w-5 h-5 text-emerald-600" aria-hidden />
                  ) : active ? (
                    <Loader2 className="w-5 h-5 text-blue-600 animate-spin" aria-hidden />
                  ) : failed ? (
                    <AlertTriangle className="w-5 h-5 text-amber-500" aria-hidden />
                  ) : (
                    <Circle className="w-5 h-5 text-slate-300" aria-hidden />
                  )}
                </span>
                <div className="min-w-0">
                  <p className={
                    done ? 'text-slate-800 font-medium'
                      : active ? 'text-slate-800 font-medium'
                      : 'text-slate-400'
                  }>
                    {phase.label}
                  </p>
                  {detail && <p className="text-sm text-slate-500 mt-0.5">{detail}</p>}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Planning is the one phase that can sit silent for 30s+ inside a single
            LLM call, so it gets an explicit reassurance rather than a stalled bar. */}
        {(stage === 'planning' || stage === 'plan_invalid') && elapsedMs > 12000 && (
          <p className="mt-4 text-sm text-slate-500 border-t border-slate-100 pt-3">
            The planner runs a 14B model locally. Thirty seconds or so is normal.
          </p>
        )}

        {adjustments.length > 0 && (
          <ul className="mt-4 border-t border-slate-100 pt-3 space-y-1">
            {[...new Set(adjustments)].map(a => (
              <li key={a} className="text-sm text-amber-800">{a}</li>
            ))}
          </ul>
        )}
      </div>

      {!failed && <ResultSkeleton />}
    </div>
  );
};

/** Placeholder in the shape of the real result, so the layout does not jump. */
const ResultSkeleton: React.FC = () => (
  <SkeletonTheme baseColor="#e9eef5" highlightColor="#f6f8fb">
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
        <Skeleton height={22} width="45%" />
        <div className="mt-4"><Skeleton height={340} /></div>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-4">
        <Skeleton height={22} width="35%" />
        <Skeleton count={3} height={14} />
        <div className="pt-2"><Skeleton height={18} width="30%" /></div>
        <Skeleton count={4} height={40} />
      </div>
    </div>
  </SkeletonTheme>
);

export default AnalysisProgress;
