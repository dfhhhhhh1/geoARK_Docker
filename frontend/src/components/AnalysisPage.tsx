import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Sparkles, Loader2, Download, AlertTriangle } from 'lucide-react';
import type { FeatureCollection } from 'geojson';
import { useAnalyzeStream } from '../hooks/useAnalyzeStream';
import AnalysisProgress from './AnalysisProgress';
import AnalysisReport from './AnalysisReport';
import ChoroplethMap from './ChoroplethMap';
import LayeredMap from './LayeredMap';
import FeatureMap from './FeatureMap';
import ErrorBoundary from './ErrorBoundary';
import AnalysisFailurePanel from './AnalysisFailure';
import AmbiguityNotice from './AmbiguityNotice';
import CorrelationCard from './CorrelationCard';
import FactorTable from './FactorTable';
import type { MappedFeature } from '../types';
import {
  download, slug, toCsv, toGeoJson, toMarkdownReport, toBundle,
} from '../lib/exports';
import { deriveSeries } from '../lib/series';
import { OP_LABEL } from '../lib/ops';
import {
  ViewTabs, ChartView, StatisticsView, suggestedView, type ViewKind,
} from './ResultViews';

const EXAMPLES = [
  'poverty rate normalized by total population for counties',
  'median household income for counties in Missouri',
  'hospitals within 10 miles of electric power transmission lines',
  'how far is each county from the nearest hospital',
  'population density per square mile in the Midwest',
];

const AnalysisPage: React.FC = () => {
  // Seeded from ?q= so "Use in analysis" on a catalog entry lands here with
  // the dataset already in the box. Deliberately NOT auto-run: a dataset name
  // is a starting point, not a question, and spending 20s of GPU on something
  // the user has not finished typing would be rude.
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q') ?? '');
  const {
    stage, events, result, error, failure, isRunning, elapsedMs, run, cancel,
  } = useAnalyzeStream();
  const [exporting, setExporting] = useState(false);
  // Which view is on screen. `null` means "follow the plan", so a new analysis
  // lands on whatever it asked for; once the user picks a tab their choice is
  // kept across queries, because overriding it every 20 seconds would be rude.
  const [view, setView] = useState<ViewKind | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isRunning) run(query.trim());
  };

  const rows = result?.rows ?? [];
  const features = result?.features ?? [];
  const isFeatures = result?.output_mode === 'features';
  // One statistic (correlate): no county to map, so it replaces the map.
  const isStatistic = !!result?.stats;
  // A ranked factor table (explain): also no county layer to map.
  const isFactors = !!result?.explain;
  // Attributes the relevance check judged to be stand-ins for what was asked.
  const proxies = (result?.relevance ?? []).filter(v => v.verdict === 'proxy');
  const hasRows = !isStatistic && !isFactors && (result?.layers?.length ?? 0) > 1
    ? result!.layers!.some(l => (l.rows?.length ?? l.features?.length ?? 0) > 0)
    : isFeatures ? features.length > 0 : rows.length > 0;
  // One entry, or two when the plan ended in a join. Derived once here and
  // passed down so the map, the table and the exports agree on the names.
  const series = React.useMemo(
    () => (result && !isFeatures ? deriveSeries(result, rows) : []),
    [result, rows, isFeatures]);
  // Present only when the plan had more than one `output` step. A single-output
  // plan keeps the flat shape, so this stays empty and nothing below changes.
  const layers = result?.layers ?? [];
  // The user's tab wins once they have chosen one; otherwise follow the plan.
  const activeView: ViewKind = view ?? suggestedView(result);

  /**
   * GeoJSON export joins values to the local county boundaries, the same source
   * the map draws from -- so what downloads is what was on screen.
   */
  const exportGeoJson = async () => {
    if (!result) return;
    setExporting(true);
    try {
      const res = await fetch('/counties.geojson');
      const fc: FeatureCollection = await res.json();
      download(
        `${slug(result.plan.intent)}.geojson`,
        toGeoJson(result, rows, fc as never),
        'application/geo+json',
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="container mx-auto px-4 py-8">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-slate-800 mb-3">Ask for an analysis</h1>
        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
          Describe what you want to know. The question is planned into a query
          against county data, run, and mapped, with every step shown.
        </p>
      </div>

      <form onSubmit={submit} className="max-w-3xl mx-auto mb-4">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. poverty rate normalized by total population for counties"
              disabled={isRunning}
              className="w-full pl-11 pr-4 py-3 rounded-xl border border-slate-300
                         focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                         disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <button
            type="submit"
            disabled={isRunning || !query.trim()}
            className="px-6 py-3 rounded-xl bg-blue-600 text-white font-medium
                       hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed
                       transition-colors flex items-center gap-2"
          >
            {isRunning ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
            {isRunning ? 'Analyzing' : 'Analyze'}
          </button>
        </div>

        {!isRunning && !result && (
          <div className="flex flex-wrap gap-2 mt-3 justify-center">
            {EXAMPLES.map(ex => (
              <button
                key={ex}
                type="button"
                onClick={() => { setQuery(ex); run(ex); }}
                className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200
                           text-slate-600 hover:border-blue-400 hover:text-blue-700 transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </form>

      {(isRunning || stage === 'failed') && (
        <div className="max-w-5xl mx-auto">
          <AnalysisProgress
            stage={stage}
            events={events}
            elapsedMs={elapsedMs}
            onCancel={cancel}
          />
        </div>
      )}

      {error && failure && (
        <AnalysisFailurePanel
          failure={failure}
          message={error}
          onPick={q => { setQuery(q); run(q); }}
        />
      )}

      {/* A transport failure has no structured payload to explain itself. */}
      {error && !failure && (
        <div className="max-w-3xl mx-auto mt-4 flex gap-2 bg-red-50 border border-red-200
                        text-red-800 rounded-lg p-4">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Could not complete the analysis</p>
            <p className="text-sm mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Rendered while a new query runs, not only after it finishes. Clearing
          it unmounted the Leaflet map and rebuilt it at the default national
          zoom on every question. The previous answer stays readable, dimmed,
          until the new one replaces it. */}
      {result && (
        <div className={`max-w-6xl mx-auto space-y-6 transition-opacity ${
          isRunning ? 'opacity-45 pointer-events-none' : ''}`}>
          {isRunning && (
            <p className="text-center text-sm text-slate-500">
              Showing the previous result while this question is planned.
            </p>
          )}
          {result.ambiguity && (
            <AmbiguityNotice
              ambiguity={result.ambiguity}
              onNarrow={code => {
                const name = result.ambiguity?.states.find(s => s.state === code)?.state_name;
                if (!name) return;
                const q = `${result.query}, ${name}`;
                setQuery(q);
                run(q);
              }}
            />
          )}

          <div className="grid lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-start justify-between mb-4 gap-3">
                <h3 className="text-lg font-semibold text-slate-800 shrink-0">Result</h3>
                {/* Every export carries the provenance block: the CSV as `#`
                    comment lines, the GeoJSON as a `metadata` member, the report
                    in full. A file that outlives this screen has to be able to
                    say where its numbers came from. */}
                <div className="flex flex-wrap gap-2 justify-end">
                  {([
                    ['GeoJSON', exportGeoJson],
                    ['CSV', () => download(`${slug(result.plan.intent)}.csv`,
                                           toCsv(result, rows), 'text/csv')],
                    ['Report', () => download(`${slug(result.plan.intent)}-report.md`,
                                              toMarkdownReport(result, rows), 'text/markdown')],
                    ['Bundle', () => download(`${slug(result.plan.intent)}-bundle.json`,
                                              toBundle(result, rows), 'application/json')],
                  ] as const).map(([label, onClick]) => (
                    <button
                      key={label}
                      onClick={onClick}
                      disabled={(!hasRows && label !== 'Report') || exporting}
                      className="text-sm px-3 py-1.5 rounded-lg border border-slate-300
                                 text-slate-700 hover:bg-slate-50 disabled:opacity-40
                                 flex items-center gap-1.5"
                    >
                      <Download className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* The planner's output_type picks the default tab; every view
                  stays reachable. A feature result has no per-county numbers,
                  so it only ever gets the map. */}
              {hasRows && !isFeatures && (
                <div className="mb-4">
                  <ViewTabs
                    active={activeView}
                    suggested={suggestedView(result)}
                    onChange={setView}
                  />
                </div>
              )}

              {/* The chart and summary mount and unmount freely; the MAP does
                  not. Unmounting it destroys the Leaflet instance, and coming
                  back rebuilds it at the default national zoom -- so it stays
                  mounted and hides itself via the `visible` prop. */}
              {hasRows && !isFeatures && activeView === 'chart' && (
                <ChartView rows={rows} series={series}
                           valueLabel={result.value_label ?? null} />
              )}
              {hasRows && !isFeatures && activeView === 'statistics' && (
                <StatisticsView rows={rows} series={series} />
              )}
              {hasRows && !isFeatures && activeView === 'table' && (
                <p className="text-sm text-slate-500">
                  The full table is below, under Results.
                </p>
              )}
              {proxies.length > 0 && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5
                                text-sm text-amber-900">
                  Answered with a stand-in:{' '}
                  {proxies.map((p, i) => (
                    <span key={p.attr_id}>
                      {i > 0 && '; '}
                      <strong>{p.description ?? p.attr_id}</strong>
                      {p.reason ? ` (${p.reason})` : ''}
                    </span>
                  ))}
                </div>
              )}
              {isStatistic ? (
                <CorrelationCard result={result} />
              ) : isFactors ? (
                <FactorTable result={result} />
              ) : hasRows ? (
                <ErrorBoundary label="the map">
                  {/* A plan with several `output` steps returns several layers,
                      and they can be different shapes -- a point layer and a
                      choropleth from one question. Each is drawn by the
                      component that matches its shape rather than by one
                      component with a mode flag. */}
                  {layers.length > 1 ? (
                    <>
                      {/* Values layers share ONE map so they can be compared
                          through each other; a feature layer has its own
                          geometry and gets its own. */}
                      {layers.some(l => l.mode === 'values') && (
                        <LayeredMap
                          layers={layers.filter(l => l.mode === 'values')}
                          intent={result.plan.intent}
                          describe={(l) =>
                            `${OP_LABEL[l.op] ?? l.op}${l.part ? ' (component)' : ''}`}
                        />
                      )}
                      {layers.filter(l => l.mode === 'features').map(l => (
                        <div key={l.id} className="mt-5">
                          <p className="text-xs font-medium text-slate-500 mb-1.5">
                            Locations · {l.row_count.toLocaleString()}
                          </p>
                          <FeatureMap features={l.features ?? []}
                                      intent={result.plan.intent} />
                        </div>
                      ))}
                    </>
                  ) : isFeatures ? (
                    <FeatureMap features={features} intent={result.plan.intent} />
                  ) : (
                    <ChoroplethMap
                      rows={rows}
                      intent={result.plan.intent}
                      result={result}
                      diverging={result.diverging}
                      valueLabel={result.value_label ?? null}
                      visible={activeView === 'map'} />
                  )}
                </ErrorBoundary>
              ) : (
                <div className="h-[420px] flex items-center justify-center text-sm
                                text-slate-500 bg-slate-50 rounded-lg">
                  {isFeatures ? 'No locations matched.' : 'No rows to map.'}
                </div>
              )}
            </div>

            <ErrorBoundary label="the report">
              <AnalysisReport result={result} />
            </ErrorBoundary>
          </div>

          {hasRows && isFeatures && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-semibold text-slate-800 mb-3">
                Locations
                <span className="ml-2 text-sm font-normal text-slate-500">
                  showing {Math.min(features.length, 50)} of {features.length}
                </span>
              </h3>
              <FeatureTable features={features} />
            </div>
          )}

          {hasRows && !isFeatures && (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h3 className="text-lg font-semibold text-slate-800 mb-3">
                Results
                <span className="ml-2 text-sm font-normal text-slate-500">
                  showing {Math.min(rows.length, 50)} of {result.row_count}
                </span>
              </h3>
              {/* The table view is the accessible counterpart to the choropleth:
                  the same numbers, readable without relying on color. */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4 font-medium">County</th>
                      <th className="py-2 pr-4 font-medium">FIPS</th>
                      {/* One column per measure. A two-attribute question
                          returns both, and a table that showed only the first
                          would quietly answer half of it. */}
                      {series.map(s => (
                        <th key={s.key} className="py-2 pl-4 font-medium text-right"
                            title={s.label}>
                          <span className="inline-block max-w-[14rem] truncate align-bottom">
                            {series.length > 1 ? s.label : 'Value'}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 50).map(r => (
                      <tr key={r.fips} className="border-b border-slate-100 last:border-0">
                        <td className="py-1.5 pr-4 text-slate-800">{r.name ?? '-'}</td>
                        <td className="py-1.5 pr-4 text-slate-500 tabular-nums">{r.fips}</td>
                        {series.map(s => (
                          <td key={s.key}
                              className="py-1.5 pl-4 text-right text-slate-800 tabular-nums">
                            {r[s.key] === null || r[s.key] === undefined
                              ? '-'
                              : (r[s.key] as number).toLocaleString(undefined, {
                                  maximumFractionDigits: 3,
                                })}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
};

/**
 * Tabular view of mapped locations -- the accessible counterpart to the feature
 * map, and the only way to read attributes without clicking every marker.
 *
 * Columns are the UNION of keys present, because layers are inconsistent: about
 * half carry `name`, 41% carry `city`. A fixed column list would silently drop
 * real data on some layers and show empty columns on others.
 */
const FeatureTable: React.FC<{ features: MappedFeature[] }> = ({ features }) => {
  const keys = React.useMemo(
    () => [...new Set(features.flatMap(f => Object.keys(f.properties ?? {})))],
    [features],
  );
  if (!keys.length) {
    return <p className="text-sm text-slate-500">This layer carries no descriptive attributes.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            {keys.map(k => (
              <th key={k} className="py-2 pr-4 font-medium capitalize">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {features.slice(0, 50).map((f, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {keys.map(k => (
                <td key={k} className="py-1.5 pr-4 text-slate-800">
                  {f.properties?.[k] ?? '-'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default AnalysisPage;
