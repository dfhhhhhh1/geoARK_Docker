import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Sparkles, Loader2, AlertTriangle, Send, Paperclip, CornerDownRight, Pencil,
  RotateCcw, Eye, Trash2, Zap, MessageSquarePlus, MessagesSquare, CheckCircle2,
} from 'lucide-react';
import { useConversation, type Turn } from '../hooks/useConversation';
import AnalysisProgress from './AnalysisProgress';
import AnalysisFailurePanel from './AnalysisFailure';
import ErrorBoundary from './ErrorBoundary';
import ResultBlock from './ResultBlock';
import FollowUpBar from './FollowUpBar';
import UploadPanel from './UploadPanel';
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

/**
 * The analysis page, as a conversation.
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
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Bring the newest turn, or the one the user chose to look at, into view.
  const lastId = convo.turns[convo.turns.length - 1]?.id;
  useEffect(() => {
    const id = convo.activeId ?? lastId;
    if (!id) return;
    document.getElementById(`turn-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [convo.activeId, lastId]);

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
      large={!hasThread}
    />
  );

  return (
    <main className="container mx-auto px-4 py-8">
      {!hasThread && (
        <>
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-slate-800 mb-3">Ask for an analysis</h1>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Describe what you want to know. The question is planned into a query
              against county data, run, and mapped, with every step shown. Then keep
              going: refine it, add measures, or bring your own data.
            </p>
          </div>
          <div className="max-w-3xl mx-auto">
            {composer}
            <div className="flex flex-wrap gap-2 mt-3 justify-center">
              {EXAMPLES.map(ex => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => void convo.ask(ex, { followUp: false })}
                  className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200
                             text-slate-600 hover:border-blue-400 hover:text-blue-700 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
            <div className="mt-8">
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
          </div>
        </>
      )}

      {hasThread && (
        <div className="max-w-6xl mx-auto space-y-8 pb-40">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-700 flex items-center gap-2">
              <MessagesSquare className="w-5 h-5 text-slate-400" /> Analysis conversation
            </h2>
            <button type="button" onClick={convo.clear}
                    className="text-sm text-slate-500 hover:text-red-700 flex items-center gap-1.5">
              <Trash2 className="w-4 h-4" /> Clear conversation
            </button>
          </div>

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
            />
          ))}
        </div>
      )}

      {/* Above Leaflet, whose panes and controls sit at z-index 400-1000 in
          the page's stacking context and otherwise draw over the box. */}
      {hasThread && (
        <div className="fixed bottom-0 inset-x-0 z-[1100] bg-gradient-to-t from-slate-100 via-slate-100/95 to-transparent
                        pt-6 pb-4 px-4">
          <div className="max-w-3xl mx-auto">{composer}</div>
        </div>
      )}

      {showUpload && (
        <div className="fixed inset-0 z-[1200] bg-slate-900/30 flex items-start justify-center p-4 overflow-y-auto"
             onClick={e => { if (e.target === e.currentTarget) setShowUpload(false); }}>
          <div className="w-full max-w-2xl mt-16">
            <UploadPanel onAdd={convo.addUploads} onClose={() => setShowUpload(false)} />
          </div>
        </div>
      )}
    </main>
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
  large: boolean;
}> = ({ value, onChange, onSend, busy, hasActive, followUp, onFollowUpChange, onUpload, inputRef, large }) => (
  <form
    onSubmit={e => { e.preventDefault(); onSend(); }}
    className={`bg-white rounded-2xl border border-slate-300 shadow-sm focus-within:ring-2
                focus-within:ring-blue-500 focus-within:border-transparent ${large ? 'p-2' : 'p-1.5'}`}
  >
    {hasActive && (
      <div className="flex flex-wrap items-center gap-1 px-2 pt-1 pb-1.5" role="radiogroup"
           aria-label="How to read this message">
        <ModeButton on={followUp} onClick={() => onFollowUpChange(true)}>
          <CornerDownRight className="w-3.5 h-3.5" /> Follow up on this result
        </ModeButton>
        <ModeButton on={!followUp} onClick={() => onFollowUpChange(false)}>
          <MessageSquarePlus className="w-3.5 h-3.5" /> New question
        </ModeButton>
        {followUp && (
          <span className="text-xs text-slate-400 ml-1 hidden sm:inline">
            e.g. {FOLLOW_UP_HINTS.map(h => `“${h}”`).join(', ')}
          </span>
        )}
      </div>
    )}
    <div className="flex items-end gap-2">
      <Sparkles className={`shrink-0 text-slate-400 ${large ? 'w-5 h-5 mb-3 ml-2' : 'w-4 h-4 mb-2.5 ml-2'}`} />
      <textarea
        ref={inputRef}
        value={value}
        rows={1}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        }}
        placeholder={hasActive && followUp
          ? 'Refine this result, or ask a follow-up…'
          : 'e.g. poverty rate normalized by total population for counties'}
        className={`flex-1 min-w-0 resize-none bg-transparent focus:outline-none text-slate-800
                    placeholder:text-slate-400 ${large ? 'py-2.5 text-base' : 'py-2 text-sm'} max-h-32`}
      />
      <button type="button" onClick={onUpload} title="Add your own county data (CSV)"
              className="shrink-0 p-2 mb-0.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800">
        <Paperclip className="w-5 h-5" />
        <span className="sr-only">Add your own data</span>
      </button>
      <button
        type="submit"
        disabled={busy || !value.trim()}
        className={`shrink-0 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700
                    disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors flex items-center gap-2
                    ${large ? 'px-5 py-2.5' : 'px-3 py-2'}`}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        <span className={large ? '' : 'sr-only sm:not-sr-only'}>{busy ? 'Working' : 'Send'}</span>
      </button>
    </div>
  </form>
);

const ModeButton: React.FC<{ on: boolean; onClick: () => void; children: React.ReactNode }> =
  ({ on, onClick, children }) => (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors
              ${on ? 'bg-blue-100 text-blue-800' : 'text-slate-500 hover:bg-slate-100'}`}>
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
}> = ({ turn: t, isActive, convo, view, onViewChange, onReuseText, onPrefill, onUpload }) => {
  const r = t.result;
  return (
    <section id={`turn-${t.id}`} className="space-y-3 scroll-mt-20">
      {/* The user's side. What was typed, and -- when it differs -- what it was
          read as. A rewrite nobody can see is a silent reinterpretation. */}
      <div className="flex justify-end">
        {/* A flex COLUMN, so each note is its own row under the bubble. The
            notes used to be inline boxes, and whenever the row had room they
            sat on the bubble's line beside it instead of below it. */}
        <div className="max-w-[85%] sm:max-w-[70%] flex flex-col items-end gap-1 text-right">
          <div className="w-fit text-left rounded-2xl rounded-br-md bg-blue-600 text-white px-4 py-2.5 text-sm">
            {t.userText}
          </div>
          {t.interpreted && (
            <p className="text-xs text-slate-500">
              Read as: <span className="text-slate-700">“{t.interpreted}”</span>{' '}
              <button type="button" onClick={() => onReuseText(t.interpreted!)}
                      className="inline-flex items-center gap-0.5 text-blue-700 hover:underline">
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
        <div className="max-w-5xl">
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
            <div className="max-w-3xl flex gap-2 bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
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
                className="w-full max-w-3xl text-left group flex items-center gap-3 rounded-xl border border-slate-200
                           bg-white px-4 py-3 hover:border-blue-400 transition-colors">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-slate-800 truncate">{r.plan.intent}</span>
            <span className="block text-xs text-slate-500">
              {summarize(r)}{t.elapsedMs ? ` · ${(t.elapsedMs / 1000).toFixed(1)}s` : ''}
            </span>
          </span>
          <span className="text-xs text-blue-700 flex items-center gap-1 opacity-70 group-hover:opacity-100">
            <Eye className="w-4 h-4" /> Show and refine
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
            <ResultBlock result={r} view={view} onViewChange={onViewChange} onEdit={convo.edit} />
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
            className="inline-flex items-center gap-1 text-blue-700 hover:underline disabled:opacity-40">
      <RotateCcw className="w-3.5 h-3.5" /> Try again
    </button>
    {turn.kind === 'question' && (
      <button type="button" onClick={() => onReuseText(turn.interpreted || turn.userText)}
              className="inline-flex items-center gap-1 text-blue-700 hover:underline">
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
