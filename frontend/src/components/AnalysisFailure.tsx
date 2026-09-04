import React from 'react';
import { AlertTriangle, ArrowRight, DatabaseZap } from 'lucide-react';
import type { AnalysisFailure as Failure } from '../types';

/**
 * What to show when a question could not be answered.
 *
 * The important distinction this draws is between "we cannot answer that" and
 * "that data was never loaded". They look identical to a user and have
 * completely different remedies: one means rephrase, the other means the source
 * archive is incomplete and no rephrasing will help. 22 datasets are in that
 * second category -- schools, power plants, roads, transit.
 *
 * Suggestions are clickable because a dead-end that makes you retype is a
 * dead-end. Each one is built server-side from an attribute that actually
 * resolved, so clicking cannot land in the same failure.
 */
interface Props {
  failure: Failure;
  message: string;
  onPick: (query: string) => void;
}

const AnalysisFailurePanel: React.FC<Props> = ({ failure, message, onPick }) => {
  const suggestions = failure.suggestions ?? [];
  const unavailable = failure.unavailable_datasets ?? [];

  return (
    <div className="max-w-3xl mx-auto mt-4 space-y-4">
      <div className="flex gap-3 bg-amber-50 border border-amber-200 text-amber-900
                      rounded-xl p-4">
        <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="font-medium">{failure.error || message}</p>
          {failure.detail && (
            <p className="text-sm mt-1 opacity-90">{failure.detail}</p>
          )}
        </div>
      </div>

      {unavailable.length > 0 && (
        <div className="flex gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
          <DatabaseZap className="w-5 h-5 shrink-0 mt-0.5 text-slate-400" />
          <div className="text-sm text-slate-700">
            <p className="font-medium text-slate-800">Not loaded on this machine</p>
            <p className="mt-1">
              {unavailable.join(', ')} {unavailable.length > 1 ? 'are' : 'is'} listed
              in the catalog but {unavailable.length > 1 ? 'their' : 'its'} source
              data was never imported, so no phrasing of the question will reach it.
            </p>
          </div>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-1">
            Try one of these instead
          </h3>
          <p className="text-xs text-slate-500 mb-3">
            Each of these is built from data that is loaded, so it will run.
          </p>
          <ul className="space-y-1.5">
            {suggestions.map(s => (
              <li key={s.query}>
                <button
                  onClick={() => onPick(s.query)}
                  className="w-full text-left group flex items-start gap-2 px-3 py-2
                             rounded-lg border border-slate-200 hover:border-blue-400
                             hover:bg-blue-50/50 transition-colors"
                >
                  <ArrowRight className="w-4 h-4 mt-0.5 shrink-0 text-slate-400
                                         group-hover:text-blue-600" />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800 group-hover:text-blue-800">
                      {s.query}
                    </span>
                    <span className="block text-xs text-slate-500 mt-0.5">{s.why}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AnalysisFailurePanel;
