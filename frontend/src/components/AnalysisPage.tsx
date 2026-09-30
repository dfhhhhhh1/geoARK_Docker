import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Loader2, AlertTriangle, Send, Paperclip, CornerDownRight, Pencil,
  RotateCcw, Eye, Trash2, Zap, MessageSquarePlus, CheckCircle2,
  Pin, PinOff, PanelLeftClose, MessagesSquare, ChevronsLeftRight,
} from 'lucide-react';
import { useConversation, type Turn } from '../hooks/useConversation';
import AnalysisProgress from './AnalysisProgress';
import AnalysisFailurePanel from './AnalysisFailure';
import ErrorBoundary from './ErrorBoundary';
import ResultBlock from './ResultBlock';
import FollowUpBar from './FollowUpBar';
import UploadPanel from './UploadPanel';
import MapStage from './MapStage';
import type { FitPadding } from './MapControls';
import type { ViewKind } from './ResultViews';

const EXAMPLES = [
  'poverty rate normalized by total population for counties',
  'median household income for counties in Missouri',
  'hospitals within 10 miles of electric power transmission lines',
  'how far is each county from the nearest hospital',
  'population density per square mile in the Midwest',
];

/** What a follow-up can look like, shown under the box once there is an answer. */
const FOLLOW_UP_HINTS = ['what about Texas?', 'top 10', 'and unemployment?', 'the whole country'];

/** Panel widths in px, matching w-[30rem] / w-[44rem] at the default root size. */
const PANEL_W = { normal: 480, wide: 704 } as const;

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

/**
 * The analysis page, as a conversation over a full-screen map.
 *
 * A first answer is rarely the last: the useful next steps are "only Texas",
 * "the top ten", "use the other poverty measure", "put my numbers next to
 * this". Each of those used to be a fresh question typed in full and planned
 * from scratch, with nothing guaranteeing the second plan read the same measure
 * as the first.
 *
 * Now every exchange is a turn. A follow-up is read against the answer on
 * screen: structural changes are applied to that plan directly (instant, and
 * cannot drift to another measure), and anything else is rewritten into a full
 * question that is SHOWN before it runs. Older answers stay in the thread and
 * can be brought back and refined from, which is a branch, not an undo.
 *
 * LAYOUT. The active answer's map fills the window (MapStage). The thread is a
 * glass panel over it that lies flat -- mostly transparent -- until the pointer
 * or keyboard focus is on it, then lifts and frosts so it is easy to read.
 * "Keep raised" pins it up; the header's Readable toggle makes it solid.
 */
const AnalysisPage: React.FC = () => {
  // Seeded from ?q= so "Use in analysis" on a catalog entry lands here with
  // the dataset already in the box. Deliberately NOT auto-run: a dataset name
  // is a starting point, not a question, and spending 20s of GPU on something
  // the user has not finished typing would be rude.
  const [searchParams] = useSearchParams();
  const [draft, setDraft] = useState(() => searchParams.get('q') ?? '');
  const convo = useConversation();
  // Which view is on screen. `null` means "follow the plan", so a new analysis
  // lands on whatever it asked for; once the user picks a tab their choice is
  // kept across turns, because overriding it every answer would be rude.
  const [view, setView] = useState<ViewKind | null>(null);
  // Whether the box continues the conversation or starts a new topic. A new
  // topic sends no context at all, so nothing earlier can leak into it.
  const [followUp, setFollowUp] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Panel chrome.
  const [collapsed, setCollapsed] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [wide, setWide] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // A county picked in a result table, for the stage map to zoom to. Lives
  // here because the table is in the panel and the map is behind it.
  const [focus, setFocus] = useState<{ fips: string; nonce: number } | null>(null);
  const activeId = convo.active?.id ?? null;
  useEffect(() => { setFocus(null); }, [activeId]);

  const hasThread = convo.turns.length > 0;
  const asFollowUp = followUp && !!convo.active;

  const send = (text: string) => {
    if (!text.trim() || convo.busy) return;
    void convo.ask(text, { followUp: asFollowUp });
    setDraft('');
  };

  const prefill = (text: string) => {
    setDraft(text);
    setFollowUp(false);
    setCollapsed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Bring the newest turn, or the one the user chose to look at, into view
  // inside the panel's own scroller.
  const lastId = convo.turns[convo.turns.length - 1]?.id;
  useEffect(() => {
    const id = convo.activeId ?? lastId;
    if (!id) return;
    document.getElementById(`turn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [convo.activeId, lastId]);

  // Frame data in the part of the window the chrome does not cover. Memoized:
  // the map components refit when this object changes identity.
  const panelW = wide ? PANEL_W.wide : PANEL_W.normal;
  const fitPadding = useMemo<FitPadding>(() => {
    if (!isDesktop) {
      const sheet = collapsed ? 0 : Math.round(window.innerHeight * 0.5);
      return { topLeft: [16, 92], bottomRight: [16, sheet + 24] };
    }
    return {
      topLeft: [collapsed ? 24 : panelW + 36, 100],
      bottomRight: [32, 96],
    };
  }, [isDesktop, collapsed, panelW]);

  const composer = (
    <Composer
      value={draft}
      onChange={setDraft}
      onSend={() => send(draft)}
      busy={convo.busy}
      hasActive={!!convo.active}
      followUp={asFollowUp}
      onFollowUpChange={setFollowUp}
      onUpload={() => setShowUpload(true)}
      inputRef={inputRef}
    />
  );

  const iconBtn = 'p-1.5 rounded-lg text-slate-600 hover:text-ink hover:bg-white/60 transition-colors';

  return (
    <>
      {/* The map. Its own stacking context (z-0), so Leaflet's internal
          z-indices of 400-1000 stay beneath every floating panel. */}
      <div
        className="map-stage fixed inset-0 z-0"
        style={{
          ['--stage-bottom-inset' as string]: !isDesktop && !collapsed ? '50vh' : '0px',
        } as React.CSSProperties}
      >
        <MapStage
          result={convo.active?.result ?? null}
          resultKey={activeId}
          focus={focus}
          fitPadding={fitPadding}
        />
        {convo.busy && (
          <div className="stage-activity z-[700]" style={{ top: 'calc(var(--header-offset) - 0.6rem)' }}
               role="progressbar" aria-label="Analysis running" />
        )}
      </div>

      {!collapsed && (
        <aside
          aria-label="Analysis conversation"
          data-raised={pinned ? 'true' : undefined}
          className={`glass glass-raisable fixed z-[1100] flex flex-col rounded-2xl
                      left-3 right-3 bottom-3 h-[50vh]
                      md:right-auto md:h-auto md:top-[var(--header-offset)]
                      ${wide ? 'md:w-[44rem]' : 'md:w-[30rem]'} md:max-w-[calc(100vw-1.5rem)]`}
        >
          <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-ink mr-auto pl-1">
              {hasThread ? 'Analysis conversation' : 'Ask for an analysis'}
            </h2>
            <button type="button" onClick={() => setPinned(p => !p)} aria-pressed={pinned}
                    title={pinned ? 'Let the panel lie flat when not in use' : 'Keep the panel raised'}
                    className={`${iconBtn} ${pinned ? 'bg-ink text-white hover:bg-ink hover:text-white' : ''}`}>
              {pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
              <span className="sr-only">Keep raised</span>
            </button>
            <button type="button" onClick={() => setWide(w => !w)} aria-pressed={wide}
                    title={wide ? 'Narrow the panel' : 'Widen the panel'}
                    className={`${iconBtn} hidden md:inline-flex`}>
              <ChevronsLeftRight className="w-4 h-4" />
              <span className="sr-only">Widen</span>
            </button>
            {hasThread && (
              <button type="button" onClick={convo.clear} title="Clear conversation"
                      className={`${iconBtn} hover:text-red-700`}>
                <Trash2 className="w-4 h-4" />
                <span className="sr-only">Clear conversation</span>
              </button>
            )}
            <button type="button" onClick={() => setCollapsed(true)} title="Hide the panel and show the whole map"
                    className={iconBtn}>
              <PanelLeftClose className="w-4 h-4" />
              <span className="sr-only">Hide panel</span>
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
            {!hasThread ? (
              <div className="space-y-5">
                <p className="text-sm text-slate-700 leading-relaxed">
                  Describe what you want to know. The question is planned into a query
                  against county data, run, and mapped behind this panel, with every step
                  shown. Then keep going: refine it, add measures, or bring your own data.
                </p>
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 mb-2">
                    Try
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {EXAMPLES.map(ex => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => void convo.ask(ex, { followUp: false })}
                        className="text-left text-sm px-3 py-2 rounded-lg bg-white border border-slate-200
                                   text-slate-700 hover:border-brand-400 hover:text-ink transition-colors"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
                <FollowUpBar
                  result={null}
                  uploads={convo.uploads}
                  disabled={convo.busy}
                  onEdit={convo.edit}
                  onPrefill={prefill}
                  onUpload={() => setShowUpload(true)}
                  onRemoveUpload={convo.removeUpload}
                />
              </div>
            ) : (
              <div className="space-y-6">
                {convo.turns.map(t => (
                  <TurnView
                    key={t.id}
                    turn={t}
                    isActive={convo.activeId === t.id}
                    convo={convo}
                    view={view}
                    onViewChange={setView}
                    onReuseText={text => { setDraft(text); inputRef.current?.focus(); }}
                    onPrefill={prefill}
                    onUpload={() => setShowUpload(true)}
                    focusFips={focus?.fips ?? null}
                    onPick={fips => setFocus({ fips, nonce: Date.now() })}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="p-3 border-t border-slate-200">{composer}</div>
        </aside>
      )}

      {collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="glass glass-raisable fixed z-[1100] left-3 bottom-3 md:bottom-auto md:top-[var(--header-offset)]
                     rounded-xl px-3.5 py-2.5 flex items-center gap-2 text-sm font-medium text-ink"
        >
          <MessagesSquare className="w-4 h-4" />
          {hasThread ? `Conversation · ${convo.turns.length}` : 'Ask a question'}
          {convo.busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-700" />}
        </button>
      )}

      {showUpload && (
        <div className="fixed inset-0 z-[1200] bg-ink/30 flex items-start justify-center p-4 overflow-y-auto"
             onClick={e => { if (e.target === e.currentTarget) setShowUpload(false); }}>
          <div className="w-full max-w-2xl mt-16">
            <UploadPanel onAdd={convo.addUploads} onClose={() => setShowUpload(false)} />
          </div>
        </div>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------

const Composer: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  busy: boolean;
  hasActive: boolean;
  followUp: boolean;
  onFollowUpChange: (v: boolean) => void;
  onUpload: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
}> = ({ value, onChange, onSend, busy, hasActive, followUp, onFollowUpChange, onUpload, inputRef }) => (
  <form
    onSubmit={e => { e.preventDefault(); onSend(); }}
    className="bg-white/70 rounded-xl border border-slate-300 focus-within:ring-2
               focus-within:ring-brand-400 focus-within:border-transparent p-1.5"
  >
    {hasActive && (
      <div className="flex flex-wrap items-center gap-1 px-1.5 pt-0.5 pb-1.5" role="radiogroup"
           aria-label="How to read this message">
        <ModeButton on={followUp} onClick={() => onFollowUpChange(true)}>
          <CornerDownRight className="w-3.5 h-3.5" /> Follow up
        </ModeButton>
        <ModeButton on={!followUp} onClick={() => onFollowUpChange(false)}>
          <MessageSquarePlus className="w-3.5 h-3.5" /> New question
        </ModeButton>
        {followUp && (
          <span className="text-xs text-slate-500 ml-1 hidden sm:inline truncate min-w-0">
            e.g. {FOLLOW_UP_HINTS.slice(0, 2).map(h => `“${h}”`).join(', ')}
          </span>
        )}
      </div>
    )}
    <div className="flex items-end gap-1.5">
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }}
        aria-label={hasActive && followUp ? 'Follow-up' : 'Question'}
        placeholder={hasActive && followUp
          ? 'Refine this result, or ask a follow-up…'
          : 'Ask about county data…'}
        className="flex-1 min-w-0 resize-none bg-transparent focus:outline-none text-ink
                   placeholder:text-slate-500 py-2 pl-2 text-sm max-h-32"
      />
      <button type="button" onClick={onUpload} title="Add your own county data (CSV)"
              className="shrink-0 p-2 rounded-lg text-slate-600 hover:bg-white/70 hover:text-ink">
        <Paperclip className="w-4 h-4" />
        <span className="sr-only">Add your own data</span>
      </button>
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className="shrink-0 rounded-lg bg-ink text-white font-medium hover:bg-brand-700
                   disabled:bg-slate-400/60 disabled:cursor-not-allowed transition-colors flex items-center gap-2
                   px-3 py-2 text-sm"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        <span className="sr-only sm:not-sr-only">{busy ? 'Working' : 'Send'}</span>
      </button>
    </div>
  </form>
);

const ModeButton: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> =
  ({ on, onClick, children }) => (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors
              ${on ? 'bg-ink text-white' : 'text-slate-600 hover:bg-white/70'}`}>
      {children}
    </button>
  );

// ---------------------------------------------------------------------------

const TurnView: React.FC<{
  turn: Turn;
  isActive: boolean;
  convo: ReturnType<typeof useConversation>;
  view: ViewKind | null;
  onViewChange: (v: ViewKind) => void;
  onReuseText: (text: string) => void;
  onPrefill: (text: string) => void;
  onUpload: () => void;
  /** The county picked in a table, which the stage map is showing. */
  focusFips: string | null;
  onPick: (fips: string) => void;
}> = ({ turn: t, isActive, convo, view, onViewChange, onReuseText, onPrefill, onUpload, focusFips, onPick }) => {
  const r = t.result;
  return (
    <section id={`turn-${t.id}`} className="space-y-3 scroll-mt-2">
      {/* The user's side. What was typed, and -- when it differs -- what it was
          read as. A rewrite nobody can see is a silent reinterpretation. */}
      <div className="flex justify-end">
        {/* A flex COLUMN, so each note is its own row under the bubble. The
            notes used to be inline boxes, and whenever the row had room they
            sat on the bubble's line beside it instead of below it. */}
        <div className="max-w-[88%] flex flex-col items-end gap-1 text-right">
          <div className="w-fit text-left rounded-2xl rounded-br-md bg-ink text-white px-4 py-2.5 text-sm">
            {t.userText}
          </div>
          {t.interpreted && (
            <p className="text-xs text-slate-500">
              Read as: <span className="text-slate-700">“{t.interpreted}”</span>{' '}
              <button type="button" onClick={() => onReuseText(t.interpreted!)}
                      className="inline-flex items-center gap-0.5 text-brand-700 hover:underline">
                <Pencil className="w-3 h-3" /> edit
              </button>
            </p>
          )}
          {t.interpretNote && <p className="text-xs text-amber-700">{t.interpretNote}</p>}
          {t.kind === 'edit' && t.status !== 'interpreting' && (
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-500" />
              {t.baseTurnId ? 'applied directly to the previous result' : 'run directly, no planning needed'}
            </p>
          )}
        </div>
      </div>

      {/* The system's side. */}
      {t.status === 'interpreting' && (
        <Pending text="Reading this against the previous answer…" />
      )}
      {t.status === 'running' && t.kind === 'question' && (
        <div>
          <AnalysisProgress stage={convo.stream.stage} events={convo.stream.events}
                            elapsedMs={convo.stream.elapsedMs} onCancel={convo.stream.cancel} />
        </div>
      )}
      {t.status === 'running' && t.kind === 'edit' && <Pending text="Applying the change…" />}

      {t.status === 'failed' && (
        <div className="space-y-2">
          {t.failure ? (
            <AnalysisFailurePanel failure={t.failure} message={t.error ?? 'failed'}
                                  onPick={q => void convo.ask(q, { followUp: false })} />
          ) : (
            <div className="flex gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Could not complete this</p>
                <p className="text-sm mt-0.5">{t.error}</p>
              </div>
            </div>
          )}
          <TurnActions turn={t} convo={convo} onReuseText={onReuseText} />
        </div>
      )}
      {t.status === 'cancelled' && (
        <div className="flex items-center gap-3 text-sm text-slate-500">
          Cancelled. <TurnActions turn={t} convo={convo} onReuseText={onReuseText} />
        </div>
      )}

      {t.status === 'done' && r && !isActive && (
        <button type="button" onClick={() => convo.setActiveId(t.id)}
                className="w-full text-left group flex items-center gap-3 rounded-xl border border-slate-200
                           bg-white px-4 py-3 hover:border-brand-400 transition-colors">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800 truncate">{r.plan.intent}</span>
            <span className="block text-xs text-slate-500">
              {summarize(r)}{t.elapsedMs ? ` · ${(t.elapsedMs / 1000).toFixed(1)}s` : ''}
            </span>
          </span>
          <span className="text-xs text-brand-700 flex items-center gap-1 opacity-70 group-hover:opacity-100">
            <Eye className="w-4 h-4" /> Show on map
          </span>
        </button>
      )}

      {t.status === 'done' && r && isActive && (
        <div className="space-y-4">
          {r.revision && (
            <p className="text-sm text-slate-600 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              {r.revision.note}
              <span className="text-xs text-slate-400">
                {t.elapsedMs ? `${(t.elapsedMs / 1000).toFixed(1)}s` : ''}
              </span>
            </p>
          )}
          <ErrorBoundary label="the result">
            <ResultBlock result={r} view={view} onViewChange={onViewChange} onEdit={convo.edit}
                         stage onPick={onPick} selectedFips={focusFips} />
          </ErrorBoundary>
          <FollowUpBar
            result={r}
            uploads={convo.uploads}
            disabled={convo.busy}
            onEdit={convo.edit}
            onPrefill={onPrefill}
            onUpload={onUpload}
            onRemoveUpload={convo.removeUpload}
          />
        </div>
      )}
    </section>
  );
};

const Pending: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-sm text-slate-500 flex items-center gap-2">
    <Loader2 className="w-4 h-4 animate-spin" /> {text}
  </p>
);

const TurnActions: React.FC<{
  turn: Turn;
  convo: ReturnType<typeof useConversation>;
  onReuseText: (text: string) => void;
}> = ({ turn, convo, onReuseText }) => (
  <span className="inline-flex gap-3 text-sm">
    <button type="button" disabled={convo.busy} onClick={() => convo.retry(turn.id)}
            className="inline-flex items-center gap-1 text-brand-700 hover:underline disabled:opacity-40">
      <RotateCcw className="w-3.5 h-3.5" /> Try again
    </button>
    {turn.kind === 'question' && (
      <button type="button" onClick={() => onReuseText(turn.interpreted || turn.userText)}
              className="inline-flex items-center gap-1 text-brand-700 hover:underline">
        <Pencil className="w-3.5 h-3.5" /> Edit and resend
      </button>
    )}
  </span>
);

/** One line for a collapsed turn: what shape of answer, and how much of it. */
function summarize(r: NonNullable<Turn['result']>): string {
  if (r.execution_error) return 'execution failed';
  if (r.stats) {
    const rho = r.stats.value;
    return rho === null || rho === undefined ? 'correlation' : `correlation ρ = ${rho.toFixed(2)}`;
  }
  if (r.explain) return `${r.explain.factors.filter(f => f.role === 'factor').length} factors ranked`;
  if (r.output_mode === 'features') return `${(r.features?.length ?? r.row_count ?? 0).toLocaleString()} locations`;
  return `${(r.row_count ?? 0).toLocaleString()} counties`;
}

export default AnalysisPage;
