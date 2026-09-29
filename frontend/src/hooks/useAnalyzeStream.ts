import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AnalysisEvent, AnalysisFailure, AnalysisResponse, AnalysisStage,
} from '../types';

/**
 * Drives GET /api/analyze/stream.
 *
 * Analysis takes tens of seconds (p50 ~45s with PLAN_MODEL=qwen3:14b), almost
 * all of it inside one or two LLM calls. A spinner for that long reads as a
 * hang, so the server emits a stage per phase and this hook exposes them.
 *
 * EventSource is used rather than fetch+ReadableStream because it handles the
 * SSE framing, and the request is a GET with a short querystring.
 *
 * THE RECONNECT TRAP: EventSource reconnects automatically whenever the
 * connection closes -- including the normal end of our stream. Left alone it
 * would silently re-run the whole 45s analysis, repeatedly. Every terminal path
 * below closes the connection explicitly.
 */
export interface AnalyzeStreamState {
  stage: AnalysisStage;
  events: AnalysisEvent[];
  result: AnalysisResponse | null;
  error: string | null;
  /**
   * The structured failure, kept alongside `error`. A 422 carries grounded
   * follow-up suggestions and the names of datasets that were matched but never
   * loaded -- discarding all that to keep a single string throws away the only
   * actionable part of the response.
   */
  failure: AnalysisFailure | null;
  isRunning: boolean;
  elapsedMs: number;
}

/** The shown result belongs to a previous question, not the one running now. */
export const isStale = (s: { isRunning: boolean; result: unknown }) =>
  s.isRunning && s.result !== null;

const TERMINAL: AnalysisStage[] = ['done', 'failed'];

export function useAnalyzeStream() {
  const [state, setState] = useState<AnalyzeStreamState>({
    stage: 'idle', events: [], result: null,
    error: null, failure: null, isRunning: false, elapsedMs: 0,
  });

  const sourceRef = useRef<EventSource | null>(null);
  const startedAtRef = useRef<number>(0);

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  // A live elapsed counter, because the only honest thing to show during a long
  // opaque LLM call is how long it has actually been running.
  useEffect(() => {
    if (!state.isRunning) return;
    const id = window.setInterval(() => {
      setState(s => (s.isRunning
        ? { ...s, elapsedMs: Date.now() - startedAtRef.current }
        : s));
    }, 100);
    return () => window.clearInterval(id);
  }, [state.isRunning]);

  // Close the stream if the component unmounts mid-run, so navigating away does
  // not leave the server planning into a dead socket.
  useEffect(() => close, [close]);

  const cancel = useCallback(() => {
    close();
    setState(s => ({ ...s, isRunning: false, stage: 'idle' }));
  }, [close]);

  const run = useCallback((query: string) => {
    if (!query.trim()) return;
    close();

    startedAtRef.current = Date.now();
    // The PREVIOUS result is deliberately kept until a new one replaces it.
    // Clearing it here unmounted the whole result block, which destroyed the
    // Leaflet map and rebuilt it at the default national zoom on every query --
    // the user saw the map "zoom all the way out" each time they asked
    // something. Keeping it mounted also means the last answer stays readable
    // while the next one is being planned, which takes ~20s.
    setState(s => ({
      ...s,
      stage: 'started', events: [],
      error: null, failure: null, isRunning: true, elapsedMs: 0,
    }));

    const url = `/api/analyze/stream?q=${encodeURIComponent(query)}`;
    const es = new EventSource(url);
    sourceRef.current = es;

    const onStage = (stage: AnalysisStage) => (e: MessageEvent) => {
      let payload: AnalysisEvent;
      try {
        payload = JSON.parse(e.data);
      } catch {
        payload = { stage };
      }
      setState(s => ({ ...s, stage, events: [...s.events, payload] }));
    };

    for (const stage of ['queued', 'started', 'decomposed', 'retrieved', 'planning',
                         'plan_invalid', 'plan_valid', 'executing'] as const) {
      es.addEventListener(stage, onStage(stage));
    }

    // Recorded but does NOT advance the stage: a deterministic correction
    // happens *during* planning, and treating it as a phase would rewind the
    // progress display to a step that is not a step.
    es.addEventListener('plan_adjusted', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data) as AnalysisEvent;
        setState(s => ({ ...s, events: [...s.events, payload] }));
      } catch { /* an unparseable progress note is not worth failing over */ }
    });

    es.addEventListener('done', (e: MessageEvent) => {
      close();
      let result: AnalysisResponse | null = null;
      try {
        result = JSON.parse(e.data);
      } catch {
        /* fall through to the error branch below */
      }
      setState(s => ({
        ...s,
        stage: result ? 'done' : 'failed',
        result,
        error: result ? null : 'the server sent a result that could not be parsed',
        isRunning: false,
        elapsedMs: Date.now() - startedAtRef.current,
      }));
    });

    es.addEventListener('failed', (e: MessageEvent) => {
      close();
      let message = 'analysis failed';
      let failure: AnalysisFailure | null = null;
      try {
        const payload = JSON.parse(e.data);
        // 422 is a coverage answer, not a crash -- the message names the cause,
        // so surface it verbatim rather than replacing it with "something went
        // wrong". See docs/RUNBOOK.md section 7.
        message = payload.error || message;
        failure = {
          error: payload.error,
          detail: payload.detail,
          suggestions: payload.suggestions,
          unavailable_datasets: payload.unavailable_datasets,
        };
      } catch { /* keep the generic message */ }
      setState(s => ({
        ...s, stage: 'failed', error: message, failure, isRunning: false,
        elapsedMs: Date.now() - startedAtRef.current,
      }));
    });

    // Fires on a genuine transport failure. Because every terminal event above
    // closes the socket first, reaching here means the connection dropped
    // mid-analysis rather than the stream having ended normally.
    es.onerror = () => {
      if (!sourceRef.current) return;   // already finished; nothing to report
      close();
      setState(s => (TERMINAL.includes(s.stage) ? s : {
        ...s,
        stage: 'failed',
        error: 'lost connection to the analysis stream',
        isRunning: false,
      }));
    };
  }, [close]);

  return { ...state, run, cancel };
}
