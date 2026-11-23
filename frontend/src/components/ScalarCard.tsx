import React from 'react';
import type { AnalysisResponse } from '../types';

/**
 * A result that is one number, not one per county: summarize or
 * network_population with group_by "none" ("how many people in St. Louis live
 * within a 10-minute drive of a hospital"). The server returns it as a single
 * row with no fips, which a choropleth draws as an empty map and the county
 * table as a nameless row, so it gets its own card instead.
 */
export const isScalarResult = (r: AnalysisResponse): boolean =>
  r.output_mode !== 'features' && !r.stats && !r.explain && !r.comparison &&
  (r.layers?.length ?? 0) <= 1 &&
  (r.rows?.length ?? 0) === 1 && !r.rows![0].fips;

const format = (v: number, percent: boolean): string => {
  if (percent) return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 4;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
};

const ScalarCard: React.FC<{ result: AnalysisResponse }> = ({ result }) => {
  const raw = result.rows?.[0]?.value;
  const v = raw === null || raw === undefined ? null : Number(raw);
  const label = result.value_label ?? null;
  const percent = !!label && /^percent\b/i.test(label);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-5 py-6 text-center">
      <div className="text-4xl font-semibold tabular-nums text-slate-900">
        {v === null || Number.isNaN(v) ? 'No value' : format(v, percent)}
      </div>
      <div className="mt-2 text-sm text-slate-600">
        {label ?? result.plan.intent}
      </div>
    </div>
  );
};

export default ScalarCard;
