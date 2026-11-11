import type { AnalysisResponse, FollowUpEdit, WorkflowStep } from '../types';
import { FollowUpRequestError } from './followup';

/**
 * Client helpers for multi-step research workflows (backend/workflow.js).
 *
 * As with single-analysis follow-ups, nothing is decided here: which measures a
 * step can use instead, and whether the changed chain is still valid, are both
 * answered by the server, which re-validates every step's plan.
 */

/** Earlier-step results, which a step's "change data" must not offer to swap. */
export const RESULT_PREFIX = 'result:';
export const isResultAttr = (id: string | null | undefined) => !!id && id.startsWith(RESULT_PREFIX);

/** A workflow worth showing as a pipeline: more than one step was planned. */
export function isMultiStep(r: AnalysisResponse | null | undefined): boolean {
  const w = r?.workflow;
  return !!w && Math.max(w.steps.length, w.decomposition?.steps?.length ?? 0) > 1;
}

/** 1-based position of a step, for "Step 2" labels. */
export const stepNumber = (r: AnalysisResponse, id: string) =>
  (r.workflow?.steps.findIndex(s => s.id === id) ?? -1) + 1;

/**
 * Change the data one step uses, and re-run the workflow from there.
 *
 * Every step is re-executed with the plan it already has (no planner call), so
 * this takes seconds. Steps before the edited one reproduce their results; the
 * ones after it see its new counties.
 */
export async function reviseWorkflow(base: AnalysisResponse, stepId: string,
                                     edit: FollowUpEdit): Promise<AnalysisResponse> {
  const w = base.workflow;
  if (!w) throw new FollowUpRequestError('this result is not a multi-step analysis', null);
  const res = await fetch('/api/research/revise', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: w.question,
      steps: w.steps.map((s: WorkflowStep) => ({
        id: s.id, question: s.question, uses: s.uses, plan: s.plan, candidate_ids: s.candidate_ids,
      })),
      edit: { ...edit, step: stepId },
    }),
  });
  let data: (AnalysisResponse & { error?: string; detail?: string }) | null = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok || !data) {
    const message = data?.error || `request failed (HTTP ${res.status})`;
    throw new FollowUpRequestError(message, data?.error ? { error: data.error, detail: data.detail } : null);
  }
  return data;
}

/** Compact number formatting for summaries: 28,972 / 0.21 / 47.8. */
export function fmtValue(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString();
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

export function fmtP(p: number | null | undefined): string {
  if (p === null || p === undefined) return '–';
  if (p < 0.001) return '< 0.001';
  return p.toFixed(3);
}

/**
 * The measure a step is about, for its card: the first dataset it loads that
 * is not an earlier step's result.
 */
export function stepDataLabel(s: WorkflowStep): string | null {
  const own = (s.attribute_origins ?? []).filter(o => !isResultAttr(o.attr_id));
  const o = own[own.length - 1] ?? own[0];
  if (!o) return null;
  return (o.description ?? o.census_code ?? o.table_name ?? '').replace(/[|!]{1,2}/g, ' › ').trim();
}
