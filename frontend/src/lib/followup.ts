import type {
  AnalysisFailure, AnalysisResponse, FollowUpEdit, FollowUpMeasure, UserSeries,
} from '../types';

/**
 * Client for the follow-up endpoints (backend/followup.js).
 *
 * Nothing here decides anything. Which edits apply, what a measure is called,
 * and whether an attribute can be loaded are all answered by the server, so
 * the browser cannot offer something the server would then refuse.
 */

export const USER_PREFIX = 'user:';
export const isUserAttr = (id: string | null | undefined) => !!id && id.startsWith(USER_PREFIX);

/** A failed request, carrying the server's structured reason when it sent one. */
export class FollowUpRequestError extends Error {
  failure: AnalysisFailure | null;
  constructor(message: string, failure: AnalysisFailure | null) {
    super(message);
    this.failure = failure;
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: (T & { error?: string; detail?: string } & Partial<AnalysisFailure>) | null = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok) {
    const message = data?.error || `request failed (HTTP ${res.status})`;
    throw new FollowUpRequestError(message, data?.error ? {
      error: data.error, detail: data.detail, suggestions: data.suggestions,
      unavailable_datasets: data.unavailable_datasets,
    } : null);
  }
  return data as T;
}

/** What earlier turns asked, for rewriting "and in Ohio?" into a full question. */
export interface HistoryEntry {
  query: string;
  intent: string | null;
  measures: string[];
}

export type FollowUpInterpretation =
  | { kind: 'edit'; edit: FollowUpEdit; ms: number }
  | { kind: 'question'; question: string; rewritten: boolean; note?: string; ms: number };

export function interpretFollowUp(text: string, history: HistoryEntry[],
                                  plan: AnalysisResponse['plan'] | null) {
  return post<FollowUpInterpretation>('/api/analyze/followup', { text, history, plan });
}

/** The attr_ids a plan and an edit reference, so only those uploads are sent. */
function referencedAttrs(plan: AnalysisResponse['plan'] | null, edit: FollowUpEdit): Set<string> {
  const ids = new Set<string>();
  for (const s of plan?.steps ?? []) {
    if (s.attr_id) ids.add(s.attr_id);
    for (const f of (s as { factors?: Array<{ attr_id: string }> }).factors ?? []) ids.add(f.attr_id);
  }
  if ('attr_id' in edit && edit.attr_id) ids.add(edit.attr_id);
  if (edit.kind === 'swap_measure') ids.add(edit.to);
  return ids;
}

/**
 * Apply one edit to an earlier result and run it.
 *
 * `base` is null only for map_measure, which needs no earlier plan. Uploads are
 * sent only when the plan or the edit cites them: the server holds nothing
 * between requests, and sending every upload every time would push large files
 * past the request size limit for no reason.
 */
export function reviseAnalysis(base: AnalysisResponse | null, edit: FollowUpEdit,
                               uploads: UserSeries[]) {
  const refs = referencedAttrs(base?.plan ?? null, edit);
  const missing = [...refs].filter(id => isUserAttr(id) &&
    !uploads.some(u => USER_PREFIX + u.id === id));
  if (missing.length) {
    return Promise.reject(new FollowUpRequestError(
      'this result uses uploaded data that has since been removed', null));
  }
  const user_series = uploads
    .filter(u => refs.has(USER_PREFIX + u.id))
    .map(u => ({ id: u.id, name: u.name, file: u.file, fips: u.fips, values: u.values }));
  return post<AnalysisResponse>('/api/analyze/revise', {
    query: base?.query ?? '',
    plan: base?.plan ?? null,
    edit,
    candidate_ids: (base?.candidates ?? []).map(c => c.attr_id).filter(id => !isUserAttr(id)),
    user_series,
    decomposition: base?.decomposition ?? null,
  });
}

/** Catalog search limited to attributes that hold data. No model call. */
export async function searchMeasures(q: string): Promise<FollowUpMeasure[]> {
  const out = await post<{ results: FollowUpMeasure[] }>('/api/measures/search', { q });
  return out.results ?? [];
}

/** The earlier turns a follow-up should be read against, oldest first. */
export function historyFrom(results: AnalysisResponse[]): HistoryEntry[] {
  return results.slice(-3).map(r => ({
    query: r.revision?.from_query || r.query,
    intent: r.plan?.intent ?? null,
    measures: (r.followups?.in_use ?? []).map(m => m.label),
  }));
}

/** A one-line description of an edit, for the user's side of the thread. */
export function describeEdit(edit: FollowUpEdit, label: (id: string) => string): string {
  switch (edit.kind) {
    case 'restrict_area': return `Only ${edit.states.join(', ')}`;
    case 'clear_area': return 'Show the whole country';
    case 'rank': return `${edit.direction === 'desc' ? 'Top' : 'Bottom'} ${edit.limit}`;
    case 'remove_step': return 'Remove that filter';
    case 'swap_measure': return `Use ${label(edit.to)} instead`;
    case 'add_measure': return edit.mode === 'correlate'
      ? `Is it related to ${label(edit.attr_id)}?`
      : `Add ${label(edit.attr_id)} alongside`;
    case 'add_stat': return edit.op === 'hotspot' ? 'Find hot and cold spots' : 'Find outliers';
    case 'map_measure': return `Map ${label(edit.attr_id)}`;
    case 'add_factor': return `Add ${label(edit.attr_id)} as a factor`;
  }
}
