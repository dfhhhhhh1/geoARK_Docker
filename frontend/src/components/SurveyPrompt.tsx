import React, { useState } from 'react';
import { ClipboardList, ExternalLink, X } from 'lucide-react';

/**
 * The user-study survey, offered under an answer.
 *
 * Its questions are about the answer the user just got (were the recommended
 * data layers relevant, would you trust them as a starting point), so it is
 * offered beside one rather than as a site-wide banner. It opens in a new tab
 * so the map and conversation stay put while it is filled in.
 *
 * Nothing about the question or the result is sent with the link. The rule
 * here is that no question leaves the machine, and a survey URL is no
 * exception.
 *
 * Once taken or dismissed it stays gone, per browser. That is a viewing
 * preference, not data, so localStorage is the right place for it.
 */
export const SURVEY_URL = 'https://missouri.qualtrics.com/jfe/form/SV_2iyrhdDslalgJxA';

const KEY = 'geoark.survey';

function loadState(): string | null {
  try { return window.localStorage.getItem(KEY); } catch { return null; }
}

function saveState(v: 'taken' | 'dismissed'): void {
  try { window.localStorage.setItem(KEY, v); } catch { /* not worth surfacing */ }
}

const SurveyPrompt: React.FC = () => {
  const [state, setState] = useState(loadState);
  if (state) return null;

  const close = (v: 'taken' | 'dismissed') => { saveState(v); setState(v); };

  return (
    <div className="flex items-start gap-3 rounded-xl border border-brand-200 bg-brand-50/80 px-4 py-3">
      <ClipboardList className="w-5 h-5 text-brand-600 shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-800">How useful was this answer?</p>
        <p className="text-xs text-slate-600 mt-0.5">
          A short survey (12 questions, under 5 minutes) about whether the data layers
          were relevant to your research.
        </p>
        <a
          href={SURVEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => close('taken')}
          className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5
                     text-xs font-medium text-white hover:bg-brand-700 transition-colors"
        >
          Take the survey <ExternalLink className="w-3.5 h-3.5" aria-hidden />
        </a>
      </div>
      <button type="button" onClick={() => close('dismissed')}
              className="p-1 text-slate-400 hover:text-slate-700" title="Don't ask again"
              aria-label="Dismiss survey">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

export default SurveyPrompt;
