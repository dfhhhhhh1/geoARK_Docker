import React, { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import type { AnalysisResponse, PlanStep } from '../types';

/**
 * The "how did it get this answer" panel.
 *
 * The plan is the honest record of the analysis: which attributes were loaded
 * and what was done to them. Showing it is the difference between a number the
 * user can check and a number they have to trust. It matters here specifically
 * because the planner CAN pick a defensible-looking wrong attribute, and the
 * step list is where that becomes visible.
 */

const OP_LABEL: Record<PlanStep['op'], string> = {
  load: 'Load',
  count_features: 'Count features',
  count_near: 'Count nearby',
  nearest_distance: 'Distance to nearest',
  select_features: 'Map locations',
  filter_attr: 'Filter',
  filter_area: 'Restrict to area',
  filter_place: 'Restrict to place',
  per_area: 'Per square mile',
  normalize: 'Normalize',
  aggregate: 'Aggregate',
  rank: 'Rank',
  join: 'Combine',
  output: 'Output',
};

/**
 * The attribute narrowing a step applied.
 *
 * Shown unconditionally, because a filtered count and an unfiltered one look
 * identical on a map. "Hospitals, counted per county" over a critical-access
 * filter would be a quietly wrong caption on a downloadable result.
 */
/** How each boundary kind reads to someone who did not choose it. */
const PLACE_KIND_LABEL: Record<string, string> = {
  place: 'city or town', zcta: 'ZIP code',
  cbsa: 'metro area', urban: 'urbanized area',
};

const describeFilters = (step: PlanStep): string => {
  const filters = step.attribute_filters ?? [];
  if (!filters.length) return '';
  return ` (${filters.map(f => `${f.column} = ${f.value}`).join(', ')})`;
};

interface Props {
  result: AnalysisResponse;
}

const AnalysisReport: React.FC<Props> = ({ result }) => {
  const [showSql, setShowSql] = useState(false);
  const [showOrigin, setShowOrigin] = useState(false);
  const { plan, decomposition, candidates, repairs } = result;

  const describeAttr = (attrId: string): string => {
    const c = candidates?.find(x => x.attr_id === attrId);
    if (!c) return attrId;
    const desc = (c.attr_desc || '').replace(/[|!]{1,2}/g, ' › ').trim();
    return desc || c.attr_orig || attrId;
  };

  const stepNumber = (id: string): number =>
    plan.steps.findIndex(s => s.id === id) + 1;

  const describeStep = (step: PlanStep): string => {
    const from = step.inputs.map(i => `step ${stepNumber(i)}`).join(' and ');
    switch (step.op) {
      case 'load':
        return describeAttr(step.attr_id);
      case 'count_features':
        return `${describeAttr(step.attr_id)}${describeFilters(step)}, counted per county`;
      case 'count_near':
        return `${describeAttr(step.attr_id)} within ${step.miles} miles of ` +
               `${describeAttr(step.near_attr_id ?? '')}, counted per county`;
      case 'nearest_distance':
        return `miles from each county to the nearest ${describeAttr(step.attr_id)}`;
      case 'select_features': {
        // City first, then state: "in Springfield, Missouri" rather than the
        // "in Missouri in Springfield" that two separate clauses produced.
        const place = [step.city, ...(step.states ?? [])].filter(Boolean).join(', ');
        return `${describeAttr(step.attr_id)}${describeFilters(step)}` +
               `${place ? `, in ${place}` : ''}`;
      }
      case 'filter_area':
        return `keep only ${(step.states ?? []).join(', ')}`;
      case 'filter_place': {
        const where = [step.place_name, ...(step.states ?? [])].filter(Boolean).join(', ');
        return `keep only counties in ${where} (${PLACE_KIND_LABEL[step.place_kind ?? 'place']})`;
      }
      case 'per_area':
        return `${from} divided by county land area (per square mile)`;
      case 'normalize':
        return `${from}${step.scale && step.scale !== 1 ? `, scaled by ${step.scale}` : ''}`;
      case 'filter_attr':
        return `keep rows from ${from} where value ${step.operator} ${step.value}`;
      case 'aggregate':
        return `${step.function} of ${from}`;
      case 'rank':
        return `${step.direction === 'asc' ? 'lowest' : 'highest'} ${step.limit ?? 20} from ${from}`;
      case 'join':
        return `${from}, matched on county`;
      case 'output':
        return `result of ${from}`;
      default:
        return from;
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-slate-800">What was done</h3>
        <p className="text-slate-600 mt-1">{plan.intent}</p>
      </div>

      {result.execution_error && (
        <div className="flex gap-2 text-sm bg-red-50 border border-red-200 text-red-800 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>The plan was valid but failed to run: {result.execution_error}</span>
        </div>
      )}

      {result.row_count === 0 && !result.execution_error && (
        <div className="flex gap-2 text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            The query ran and returned no rows. Usually this means one of the
            attributes below is registered but holds no data.
          </span>
        </div>
      )}

      <ol className="space-y-2">
        {plan.steps.map((step, i) => (
          <li key={step.id} className="flex gap-3 text-sm">
            <span className="shrink-0 w-6 h-6 rounded-full bg-slate-100 text-slate-600
                             flex items-center justify-center text-xs font-medium">
              {i + 1}
            </span>
            <div className="min-w-0 pt-0.5">
              <span className="font-medium text-slate-800">{OP_LABEL[step.op] ?? step.op}</span>
              <span className="text-slate-600">, {describeStep(step)}</span>
            </div>
          </li>
        ))}
      </ol>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-slate-100 pt-4">
        <div>
          <dt className="text-slate-500">Rows</dt>
          <dd className="font-medium text-slate-800 tabular-nums">
            {result.row_count ?? 0}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Total time</dt>
          <dd className="font-medium text-slate-800 tabular-nums">
            {(result.ms / 1000).toFixed(1)}s
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Query time</dt>
          <dd className="font-medium text-slate-800 tabular-nums">
            {result.execution_ms !== undefined ? `${result.execution_ms}ms` : '-'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Plan repairs</dt>
          <dd className="font-medium text-slate-800 tabular-nums">{repairs}</dd>
        </div>
      </dl>

      {decomposition && (
        <div className="border-t border-slate-100 pt-4">
          <p className="text-sm text-slate-500 mb-2">Concepts identified</p>
          <div className="flex flex-wrap gap-1.5">
            {decomposition.primary_concepts.map(c => (
              <span key={c} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full text-xs">
                {c}
              </span>
            ))}
            {decomposition.normalization_concepts.map(c => (
              <span key={c} className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full text-xs">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {result.provenance && (
        <div className="border-t border-slate-100 pt-4">
          <button
            onClick={() => setShowOrigin(v => !v)}
            className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
          >
            {showOrigin ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Data origin &amp; provenance
          </button>
          {showOrigin && (
            <div className="mt-3 space-y-3 text-sm">
              {/* Named sources are the part that makes a downloaded number
                  checkable: "poverty rate" is not verifiable, "S1701_C03_001E
                  from acs_county_values, 2018" is. */}
              {result.provenance.attribute_origins.map(o => (
                <div key={o.attr_id} className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <p className="font-medium text-slate-800">
                    {o.dataset ?? 'Unknown dataset'}
                    {o.start_date && (
                      <span className="font-normal text-slate-500">
                        {' '}· {o.start_date}{o.end_date && o.end_date !== o.start_date ? `, ${o.end_date}` : ''}
                      </span>
                    )}
                  </p>
                  <p className="text-slate-600 mt-0.5">{o.description}</p>
                  <p className="text-xs text-slate-500 mt-1 font-mono break-all">
                    {o.census_code
                      ? `acs_county_values · ${o.census_code}`
                      : o.geometry_column
                        ? `${o.table_name} · ${o.geometry_column} (geometry)`
                        : `${o.table_name}${o.value_column ? ` · ${o.value_column}` : ''}`}
                  </p>
                </div>
              ))}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs text-slate-600">
                <dt className="text-slate-500">Generated</dt>
                <dd className="tabular-nums">
                  {new Date(result.provenance.generated_at).toLocaleString()}
                </dd>
                <dt className="text-slate-500">Planner model</dt>
                <dd className="font-mono">{result.provenance.models.planner}</dd>
                <dt className="text-slate-500">Decomposition model</dt>
                <dd className="font-mono">{result.provenance.models.decomposition}</dd>
                <dt className="text-slate-500">Embedding model</dt>
                <dd className="font-mono break-all">{result.provenance.models.embedding}</dd>
                <dt className="text-slate-500">Catalog searched</dt>
                <dd className="tabular-nums">
                  {result.provenance.retrieval.catalog_rows.toLocaleString()} attributes
                </dd>
                <dt className="text-slate-500">Database</dt>
                <dd className="font-mono">{result.provenance.database}</dd>
              </dl>
              <p className="text-xs text-slate-500 border-t border-slate-200 pt-2">
                {result.provenance.units_note}
              </p>
            </div>
          )}
        </div>
      )}

      {result.sql && (
        <div className="border-t border-slate-100 pt-4">
          <button
            onClick={() => setShowSql(v => !v)}
            className="flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
          >
            {showSql ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            Generated SQL
          </button>
          {showSql && (
            <pre className="mt-2 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3
                            overflow-x-auto text-slate-700 whitespace-pre">
              {result.sql}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

export default AnalysisReport;
