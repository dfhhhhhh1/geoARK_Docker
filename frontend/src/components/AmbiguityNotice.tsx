import React from 'react';
import { HelpCircle } from 'lucide-react';
import type { CityAmbiguity } from '../types';

/**
 * A result that ran fine but probably answered a broader question than was asked.
 *
 * "fire stations in Springfield" returns 97 stations across 25 states, because
 * there is a Springfield in most of them. Nothing failed, so there is no error
 * to show -- and that is exactly why this is worth surfacing. A silently
 * over-broad answer is more dangerous than a visible failure: it looks correct,
 * and it is downloadable.
 *
 * Offered as a follow-up rather than applied automatically. Which Springfield
 * was meant is the user's to say, and the planner already applies the state
 * when the question names one.
 */
interface Props {
  ambiguity: CityAmbiguity;
  /** Full state names keyed by postal code, for a readable follow-up query. */
  onNarrow: (stateCode: string) => void;
}

const AmbiguityNotice: React.FC<Props> = ({ ambiguity, onNarrow }) => (
  <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 flex gap-3">
    <HelpCircle className="w-5 h-5 shrink-0 mt-0.5 text-brand-600" />
    <div className="min-w-0">
      <p className="text-sm font-medium text-brand-900">
        “{ambiguity.city}” exists in {ambiguity.state_count} states
      </p>
      <p className="text-sm text-brand-800 mt-0.5">
        These results cover all of them. Narrow to one:
      </p>
      <div className="flex flex-wrap gap-2 mt-2">
        {ambiguity.states.map(({ state, count }) => (
          <button
            key={state}
            onClick={() => onNarrow(state)}
            className="text-xs px-2.5 py-1 rounded-full bg-white border border-brand-300
                       text-brand-800 hover:bg-brand-100 transition-colors"
          >
            {state} <span className="opacity-60">({count})</span>
          </button>
        ))}
      </div>
    </div>
  </div>
);

export default AmbiguityNotice;
