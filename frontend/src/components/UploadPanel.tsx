import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import type { UserSeries } from '../types';
import {
  countyFips, detectFipsColumn, extractSeries, numericColumns, parseCsv, type ParsedCsv,
} from '../lib/csv';

/**
 * Bring your own county data.
 *
 * Parsed and checked entirely in the browser, and kept there: the file is never
 * stored on the server. Each analysis that uses it sends just the FIPS codes
 * and values, which are bound into the query and discarded when it finishes.
 *
 * The check that matters is the MATCH RATE against the county boundaries the
 * map draws. A file keyed on something that only looks like FIPS -- ZIP codes,
 * state+county built wrong, a lost leading zero -- still parses, and would
 * otherwise join to nothing and come back as an empty, plausible-looking map.
 */
interface Props {
  onAdd: (series: UserSeries[]) => void;
  onClose: () => void;
}

interface Draft {
  file: string;
  parsed: ParsedCsv;
  fipsCol: number;
  valueCols: number[];
  selected: Set<number>;
  names: Record<number, string>;
}

const MAX_BYTES = 5 * 1024 * 1024;

const UploadPanel: React.FC<Props> = ({ onAdd, onClose }) => {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [counties, setCounties] = useState<Set<string> | null>(null);

  const read = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(`That file is ${(file.size / 1e6).toFixed(1)} MB. A county file is well under 1 MB; the limit is 5 MB.`);
      return;
    }
    setBusy(true);
    try {
      const [text, known] = await Promise.all([file.text(), countyFips().catch(() => null)]);
      setCounties(known);
      const parsed = parseCsv(text);
      if (!parsed.rows.length) throw new Error('The file has a header row but no data rows.');
      const fipsCol = detectFipsColumn(parsed);
      if (fipsCol < 0) {
        throw new Error('No column of county FIPS codes was found. The file needs one column of ' +
          '5-digit county codes (e.g. 29001), called something like "fips" or "GEOID".');
      }
      const valueCols = numericColumns(parsed, fipsCol);
      if (!valueCols.length) throw new Error('No numeric column was found to use as values.');
      const base = file.name.replace(/\.(csv|tsv|txt)$/i, '');
      setDraft({
        file: file.name, parsed, fipsCol, valueCols,
        selected: new Set([valueCols[0]]),
        names: Object.fromEntries(valueCols.map(c => [c, `${parsed.headers[c]} (${base})`])),
      });
    } catch (e) {
      setError((e as Error).message);
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void read(file);
  };

  const preview = (col: number) => {
    if (!draft) return null;
    const s = extractSeries(draft.parsed, draft.fipsCol, col);
    const matched = counties ? s.fips.filter(f => counties.has(f)).length : s.fips.length;
    const unmatched = counties ? s.fips.filter(f => !counties.has(f)) : [];
    return { ...s, matched, unmatched };
  };

  const commit = () => {
    if (!draft) return;
    const out: UserSeries[] = [];
    for (const col of draft.selected) {
      const p = preview(col)!;
      // Rows that are not counties on the map are dropped here rather than
      // sent: they could only ever appear as nameless rows in the table.
      const keep = p.fips.map(f => !counties || counties.has(f));
      out.push({
        id: Math.random().toString(36).slice(2, 10) || 'u1',
        name: (draft.names[col] || draft.parsed.headers[col]).slice(0, 120),
        file: draft.file,
        column: draft.parsed.headers[col],
        fips: p.fips.filter((_, i) => keep[i]),
        values: p.values.filter((_, i) => keep[i]),
        matched: p.matched, unmatched: p.unmatched.slice(0, 5),
      });
    }
    onAdd(out);
    onClose();
  };

  const tooMany = (draft?.selected.size ?? 0) > 6;

  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <FileSpreadsheet className="w-5 h-5 text-emerald-700 mt-0.5" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-800">Add your own county data</h3>
          <p className="text-sm text-slate-600 mt-0.5">
            A CSV with a county FIPS column and one or more number columns. It stays in this
            browser tab: nothing is saved on the server, and it is forgotten when you reload.
          </p>
        </div>
        <button type="button" onClick={onClose} className="ml-auto p-1 text-slate-400 hover:text-slate-700"
                aria-label="Close"><X className="w-5 h-5" /></button>
      </div>

      {!draft && (
        <label
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed
                      px-4 py-8 cursor-pointer transition-colors
                      ${dragging ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400'}`}
        >
          {busy ? <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                : <Upload className="w-6 h-6 text-slate-400" />}
          <span className="text-sm text-slate-700">Drop a .csv here, or click to choose one</span>
          <span className="text-xs text-slate-500">
            Example header: <code className="font-mono">fips,clinic_visits,wait_days</code>
          </span>
          <input type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only"
                 onChange={e => { const f = e.target.files?.[0]; if (f) void read(f); }} />
        </label>
      )}

      {error && (
        <div className="flex gap-2 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {draft && (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">
            <strong>{draft.file}</strong> · {draft.parsed.rows.length.toLocaleString()} rows ·
            county codes from <code className="font-mono">{draft.parsed.headers[draft.fipsCol]}</code>
          </p>
          <p className="text-xs text-slate-500">Choose the columns to add. Each becomes its own measure.</p>
          <ul className="space-y-2">
            {draft.valueCols.map(col => {
              const p = preview(col)!;
              const on = draft.selected.has(col);
              const rate = p.fips.length ? p.matched / p.fips.length : 0;
              return (
                <li key={col} className={`rounded-lg border p-3 ${on ? 'border-blue-300 bg-blue-50/40' : 'border-slate-200'}`}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" checked={on} className="mt-1"
                           onChange={() => setDraft(d => {
                             if (!d) return d;
                             const sel = new Set(d.selected);
                             if (sel.has(col)) sel.delete(col); else sel.add(col);
                             return { ...d, selected: sel };
                           })} />
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="block text-sm font-medium text-slate-800">{draft.parsed.headers[col]}</span>
                      {on && (
                        <input value={draft.names[col]}
                               onChange={e => setDraft(d => d && ({ ...d, names: { ...d.names, [col]: e.target.value } }))}
                               className="w-full text-sm px-2 py-1 rounded border border-slate-300"
                               aria-label="Name for this measure" />
                      )}
                      <span className={`flex items-center gap-1.5 text-xs ${rate >= 0.9 ? 'text-emerald-700' : 'text-amber-700'}`}>
                        {rate >= 0.9 ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                        {counties
                          ? `${p.matched.toLocaleString()} of ${p.fips.length.toLocaleString()} rows match a county on the map`
                          : `${p.fips.length.toLocaleString()} rows (could not check them against the county map)`}
                        {p.unmatched.length > 0 && ` · not counties: ${p.unmatched.slice(0, 3).join(', ')}${p.unmatched.length > 3 ? '…' : ''}`}
                      </span>
                      {(p.badFips + p.duplicates + p.badValues) > 0 && (
                        <span className="block text-xs text-slate-500">
                          {[p.badFips && `${p.badFips} rows skipped with no FIPS code`,
                            p.duplicates && `${p.duplicates} repeated counties skipped (first kept)`,
                            p.badValues && `${p.badValues} non-numeric values left blank`]
                            .filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {tooMany && <p className="text-xs text-amber-700">That is a lot of columns; add the ones you need.</p>}
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setDraft(null)}
                    className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50">
              Choose another file
            </button>
            <button type="button" onClick={commit} disabled={!draft.selected.size}
                    className="text-sm px-4 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700
                               disabled:bg-slate-300">
              Add {draft.selected.size > 1 ? `${draft.selected.size} measures` : 'measure'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default UploadPanel;
