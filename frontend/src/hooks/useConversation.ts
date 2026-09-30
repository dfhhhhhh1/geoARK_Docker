import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  AnalysisFailure, AnalysisResponse, FollowUpEdit, UserSeries,
} from '../types';
import { useAnalyzeStream, type AnalyzeOutcome } from './useAnalyzeStream';
import {
  describeEdit, FollowUpRequestError, historyFrom, interpretFollowUp,
  isUserAttr, reviseAnalysis, USER_PREFIX,
} from '../lib/followup';

/**
 * One exchange in the thread: what the user asked or clicked, and what came back.
 *
 * A turn records the turn it was BASED on, because a follow-up applies to the
 * result that was on screen when it was asked -- not necessarily the newest one.
 * Clicking back to an earlier answer and refining it is a branch, and the
 * rewrite history is read along that branch rather than down the whole thread.
 */
export interface Turn {
  id: string;
  kind: 'question' | 'edit';
  /** What the user typed, or the label of the action they clicked. */
  userText: string;
  /** The standalone question a follow-up was rewritten into, when it differs. */
  interpreted?: string | null;
  interpretNote?: string | null;
  edit?: FollowUpEdit;
  baseTurnId: string | null;
  status: 'interpreting' | 'running' | 'done' | 'failed' | 'cancelled';
  result?: AnalysisResponse;
  error?: string;
  failure?: AnalysisFailure | null;
  startedAt: number;
  elapsedMs?: number;
}

/**
 * Results are ~230 KB each for a national layer. The thread keeps the last few
 * in full and older ones as their titles, so a long session does not hold
 * megabytes of rows nobody is looking at.
 */
const KEEP_RESULTS = 8;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export function useConversation() {
  const stream = useAnalyzeStream();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UserSeries[]>([]);
  // Read inside async flows, which would otherwise close over stale state.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const uploadsRef = useRef<UserSeries[]>([]);
  uploadsRef.current = uploads;

  const update = useCallback((id: string, patch: Partial<Turn>) => {
    setTurns(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const add = useCallback((turn: Omit<Turn, 'id' | 'startedAt'>) => {
    const id = newId();
    setTurns(ts => {
      const next = [...ts, { ...turn, id, startedAt: Date.now() }];
      // Drop full results from turns far enough back, keeping their titles.
      const cut = next.length - KEEP_RESULTS;
      return cut > 0
        ? next.map((t, i) => (i < cut && t.result && t.id !== turn.baseTurnId
          ? { ...t, result: { ...t.result, rows: [], features: [], layers: undefined } }
          : t))
        : next;
    });
    return id;
  }, []);

  const finish = useCallback((id: string, outcome: AnalyzeOutcome | { status: 'done'; result: AnalysisResponse }) => {
    const turn = turnsRef.current.find(t => t.id === id);
    const elapsedMs = turn ? Date.now() - turn.startedAt : undefined;
    if (outcome.status === 'done') {
      update(id, { status: 'done', result: outcome.result, elapsedMs });
      setActiveId(id);
    } else if (outcome.status === 'failed') {
      update(id, { status: 'failed', error: outcome.error, failure: outcome.failure, elapsedMs });
    } else {
      update(id, { status: 'cancelled', elapsedMs });
    }
  }, [update]);

  const active = useMemo(
    () => turns.find(t => t.id === activeId && t.status === 'done' && t.result) ?? null,
    [turns, activeId]);

  const busy = turns.some(t => t.status === 'running' || t.status === 'interpreting');

  /** The results along this turn's branch, oldest first: what "it" can refer to. */
  const lineage = useCallback((turnId: string | null): AnalysisResponse[] => {
    const out: AnalysisResponse[] = [];
    const seen = new Set<string>();
    let id = turnId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const t = turnsRef.current.find(x => x.id === id);
      if (!t) break;
      if (t.result) out.unshift(t.result);
      id = t.baseTurnId;
    }
    return out;
  }, []);

  /** Names for attr_ids, from what the server said about the active result. */
  const labelFor = useCallback((id: string) => {
    if (isUserAttr(id)) {
      return uploadsRef.current.find(u => USER_PREFIX + u.id === id)?.name ?? 'your data';
    }
    const f = active?.result?.followups;
    return [...(f?.in_use ?? []), ...(f?.alternatives ?? [])].find(m => m.attr_id === id)?.label ?? id;
  }, [active]);

  const runEdit = useCallback(async (id: string, base: AnalysisResponse | null, edit: FollowUpEdit) => {
    try {
      const result = await reviseAnalysis(base, edit, uploadsRef.current);
      finish(id, { status: 'done', result });
    } catch (err) {
      const e = err as FollowUpRequestError;
      finish(id, { status: 'failed', error: e.message, failure: e.failure ?? null });
    }
  }, [finish]);

  /**
   * Apply an edit to the result on screen. `userText` overrides the default
   * description, for when the click was worded differently ("Narrow to Ohio").
   */
  const edit = useCallback((e: FollowUpEdit, userText?: string) => {
    if (busy) return;
    const base = active;
    const id = add({
      kind: 'edit', edit: e, userText: userText ?? describeEdit(e, labelFor),
      baseTurnId: base?.id ?? null, status: 'running',
    });
    void runEdit(id, base?.result ?? null, e);
  }, [busy, active, add, labelFor, runEdit]);

  /**
   * Ask something. As a follow-up, the server first decides whether the text is
   * an edit it can apply directly or a question to rewrite; as a new topic, it
   * runs as typed with no context at all.
   */
  const ask = useCallback(async (text: string, { followUp }: { followUp: boolean }) => {
    const q = text.trim();
    if (!q || busy) return;
    const base = followUp ? active : null;
    const id = add({
      kind: 'question', userText: q, baseTurnId: base?.id ?? null,
      status: base ? 'interpreting' : 'running',
    });

    let question = q;
    if (base?.result) {
      try {
        const interp = await interpretFollowUp(q, historyFrom(lineage(base.id)), base.result.plan);
        if (interp.kind === 'edit') {
          update(id, { kind: 'edit', edit: interp.edit, status: 'running' });
          await runEdit(id, base.result, interp.edit);
          return;
        }
        question = interp.question;
        update(id, {
          interpreted: interp.rewritten ? interp.question : null,
          interpretNote: interp.note ?? null,
        });
      } catch {
        // The rewrite is a convenience. If it is unavailable the question
        // still runs, as typed, and the thread says so.
        update(id, { interpretNote: 'could not read this against the earlier answer; running it as typed' });
      }
    }
    update(id, { status: 'running' });
    finish(id, await stream.run(question));
  }, [busy, active, add, update, lineage, runEdit, finish, stream]);

  /** Re-run a failed or cancelled turn exactly as it was sent. */
  const retry = useCallback((turnId: string) => {
    const t = turnsRef.current.find(x => x.id === turnId);
    if (!t || busy) return;
    const base = turnsRef.current.find(x => x.id === t.baseTurnId)?.result ?? null;
    if (t.kind === 'edit' && t.edit) {
      const id = add({ ...t, status: 'running', result: undefined, error: undefined, failure: null });
      void runEdit(id, base, t.edit);
      return;
    }
    const id = add({ kind: 'question', userText: t.userText, interpreted: t.interpreted,
                     baseTurnId: t.baseTurnId, status: 'running' });
    void stream.run(t.interpreted || t.userText).then(o => finish(id, o));
  }, [busy, add, runEdit, stream, finish]);

  const clear = useCallback(() => {
    if (busy) stream.cancel();
    setTurns([]);
    setActiveId(null);
  }, [busy, stream]);

  const addUploads = useCallback((list: UserSeries[]) => {
    setUploads(us => [...us, ...list]);
  }, []);
  const removeUpload = useCallback((id: string) => {
    setUploads(us => us.filter(u => u.id !== id));
  }, []);

  return {
    turns, active, activeId, setActiveId, busy, uploads,
    ask, edit, retry, clear, addUploads, removeUpload, labelFor,
    // Progress of the one question that can be running.
    stream: { stage: stream.stage, events: stream.events, elapsedMs: stream.elapsedMs, cancel: stream.cancel },
  };
}
