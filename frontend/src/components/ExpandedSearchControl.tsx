import React from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import type { ExpandedSearch } from '../hooks/useAnalyzeStream';

/**
 * The Expanded search switch and its two sources. Off by default; turned on,
 * both sources are on and either can be unticked.
 *   Literature  SemMedDB relations, looked up on this machine
 *   PubMed      keywords read from PubMed abstracts; the condition's NAME is
 *               sent to NCBI, the one call that leaves the machine
 */
const ExpandedSearchControl: React.FC<{
  value: ExpandedSearch;
  onChange: (e: ExpandedSearch) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled = false }) => (
  <div className="flex flex-wrap items-center gap-1">
    <button type="button" aria-pressed={value.on} disabled={disabled}
            onClick={() => onChange({ ...value, on: !value.on })}
            title="Also search for measures linked to the condition you ask about (risk factors, causes), using the medical literature"
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors
              ${value.on ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-white/70 border border-slate-300'}`}>
      <Sparkles className="w-3.5 h-3.5" /> Expanded search {value.on ? 'on' : 'off'}
    </button>
    {value.on && (
      <>
        <SourceChip on={value.literature} disabled={disabled}
                    title="SemMedDB relations, looked up on this machine"
                    onClick={() => onChange({ ...value, literature: !value.literature })}>
          Literature
        </SourceChip>
        <SourceChip on={value.pubmed} disabled={disabled}
                    title="Keywords read from PubMed abstracts. The condition's name is sent to NCBI."
                    onClick={() => onChange({ ...value, pubmed: !value.pubmed })}>
          PubMed
        </SourceChip>
        {!value.literature && !value.pubmed && (
          <span className="text-xs text-amber-700">no source selected: runs as a normal search</span>
        )}
      </>
    )}
  </div>
);

const SourceChip: React.FC<{ on: boolean; disabled: boolean; title: string; onClick: () => void;
                             children: React.ReactNode }> =
  ({ on, disabled, title, onClick, children }) => (
    <button type="button" role="checkbox" aria-checked={on} disabled={disabled} title={title} onClick={onClick}
            className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors
              ${on ? 'bg-ink text-white border-ink' : 'text-slate-600 border-slate-300 hover:bg-white/70'}`}>
      {on && <CheckCircle2 className="w-3 h-3" />}{children}
    </button>
  );

export default ExpandedSearchControl;
