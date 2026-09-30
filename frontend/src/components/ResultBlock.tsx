import React, { useState } from 'react';
import { Download } from 'lucide-react';
import type { FeatureCollection } from 'geojson';
import ChoroplethMap from './ChoroplethMap';
import LayeredMap from './LayeredMap';
import FeatureMap from './FeatureMap';
import ErrorBoundary from './ErrorBoundary';
import AnalysisReport from './AnalysisReport';
import AmbiguityNotice from './AmbiguityNotice';
import CorrelationCard from './CorrelationCard';
import FactorTable from './FactorTable';
import CountyTable from './CountyTable';
import type { AnalysisResponse, FollowUpEdit, MappedFeature } from '../types';
import {
  download, slug, toCsv, toGeoJson, toMarkdownReport, toBundle,
} from '../lib/exports';
import { deriveSeries } from '../lib/series';
import { OP_LABEL } from '../lib/ops';
import {
  ViewTabs, ChartView, StatisticsView, suggestedView, type ViewKind,
} from './ResultViews';

/**
 * One analysis result: map or statistic, the step-by-step report, the table and
 * the exports. Extracted from AnalysisPage so every turn of a conversation is
 * drawn by the same component -- a revised result and a planned one are the
 * same response shape and must not render differently.
 *
 * `view` is owned by the caller so a tab the user picked survives across turns.
 */
/** "(covers 2,957 counties)" rides on every PLACES name; the table says it already. */
const stripCoverage = (d: string) => d.replace(/\s*\(covers [\d,]+ counties\)/i, '');

interface Props {
  result: AnalysisResponse;
  view: ViewKind | null;
  onViewChange: (v: ViewKind) => void;
  /** Apply a follow-up edit to this result. */
  onEdit: (edit: FollowUpEdit, userText?: string) => void;
}

const ResultBlock: React.FC<Props> = ({ result, view, onViewChange, onEdit }) => {
  const [exporting, setExporting] = useState(false);
  const setView = onViewChange;
  // A county picked in the table, for the map to zoom to.
  const [focus, setFocus] = useState<{ fips: string; nonce: number } | null>(null);
  const mapBoxRef = React.useRef<HTMLDivElement>(null);
  const rows = React.useMemo(() => result.rows ?? [], [result]);
  const features = React.useMemo(() => result.features ?? [], [result]);
  const isFeatures = result.output_mode === 'features';
  // One statistic (correlate): no county to map, so it replaces the map.
  const isStatistic = !!result.stats;
  // A ranked factor table (explain): also no county layer to map.
  const isFactors = !!result.explain;
  // Attributes the relevance check judged to be stand-ins for what was asked.
  const proxies = (result.relevance ?? []).filter(v => v.verdict === 'proxy');
  const hasRows = !isStatistic && !isFactors && (result.layers?.length ?? 0) > 1
    ? result.layers!.some(l => (l.rows?.length ?? l.features?.length ?? 0) > 0)
    : isFeatures ? features.length > 0 : rows.length > 0;
  // The chart, summary and table tabs are for a per-county layer. A correlation
  // or a factor table is one row or no county rows at all, and its summary tab
  // read "Counties 1, Minimum -0.042 ... Maximum -0.042".
  const countyViews = hasRows && !isFeatures && !isStatistic && !isFactors;
  // One entry, or two when the plan ended in a join. Derived once here and
  // passed down so the map, the table and the exports agree on the names.
  const series = React.useMemo(
    () => (!isFeatures ? deriveSeries(result, rows) : []),
    [result, rows, isFeatures]);
  // Present only when the plan had more than one `output` step. A single-output
  // plan keeps the flat shape, so this stays empty and nothing below changes.
  const layers = result.layers ?? [];
  // The user's tab wins once they have chosen one; otherwise follow the plan.
  const activeView: ViewKind = view ?? suggestedView(result);

  /** Table click: show the map if another tab is up, then zoom to the county. */
  const pick = (fips: string) => {
    if (countyViews && activeView !== 'map') setView('map');
    setFocus({ fips, nonce: Date.now() });
    // After the tab switch has rendered, or the map box may still be hidden.
    requestAnimationFrame(() => mapBoxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  // Any county map can be zoomed from the table; a feature layer has no counties.
  const canFocus = !isFeatures;

  // explain: name the OUTCOME, walking back from the explain step to the
  // attribute it loads. The generic series label falls back to the plan's
  // whole intent, which reads as a sentence about factors, not a measure.
  const outcomeLabel = React.useMemo(() => {
    if (!isFactors) return null;
    const steps = result.plan.steps;
    let st = steps.find(x => x.op === 'explain');
    const seen = new Set<string>();
    while (st && !st.attr_id && st.inputs?.[0] && !seen.has(st.id)) {
      seen.add(st.id);
      st = steps.find(x => x.id === st!.inputs[0]);
    }
    const id = st?.attr_id;
    const desc = result.provenance?.attribute_origins.find(o => o.attr_id === id)?.description
      ?? result.candidates?.find(c => c.attr_id === id)?.attr_desc;
    return desc ? stripCoverage(desc) : null;
  }, [isFactors, result]);

  /**
   * GeoJSON export joins values to the local county boundaries, the same source
   * the map draws from -- so what downloads is what was on screen.
   */
  const exportGeoJson = async () => {
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
    <div className="space-y-6">
      {result.ambiguity && (
        <AmbiguityNotice
          ambiguity={result.ambiguity}
          onNarrow={code => {
            const name = result.ambiguity?.states.find(s => s.state === code)?.state_name;
            if (!name) return;
            // Applied as an edit, so the city is kept and nothing is
            // re-planned: which Springfield is the only thing changing.
            onEdit({ kind: 'restrict_area', states: [name], keep_city: true },
                   `Only ${result.ambiguity?.city}, ${name}`);
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
          {countyViews && (
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
          {countyViews && activeView === 'chart' && (
            <ChartView rows={rows} series={series}
                       valueLabel={result.value_label ?? null} />
          )}
          {countyViews && activeView === 'statistics' && (
            <StatisticsView rows={rows} series={series} />
          )}
          {countyViews && activeView === 'table' && (
            <CountyTable rows={rows} series={series} heightClass="max-h-[420px]"
                         onPick={canFocus ? pick : undefined} selected={focus?.fips ?? null} />
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
            <>
              <FactorTable
                result={result}
                onMap={f => onEdit({ kind: 'map_measure', attr_id: f.attr_id },
                                   `Map ${stripCoverage(f.description ?? f.attr_id)}`)}
              />
              {/* The outcome itself, per county. The ranking says what tracks
                  it; this says where it is high. */}
              {rows.length > 0 && (
                <div className="mt-6 space-y-3">
                  <h4 className="text-sm font-semibold text-slate-800">
                    Where it is: {outcomeLabel ?? 'the outcome'}
                  </h4>
                  <ErrorBoundary label="the map">
                    <div ref={mapBoxRef}>
                    <ChoroplethMap rows={rows} intent={outcomeLabel ?? result.plan.intent}
                                   result={result} focus={focus} />
                    </div>
                  </ErrorBoundary>
                  <CountyTable rows={rows} series={[{ key: 'value', label: outcomeLabel ?? 'Value' }]} onPick={pick}
                               selected={focus?.fips ?? null} />
                </div>
              )}
            </>
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
                    <div ref={mapBoxRef}>
                    <LayeredMap
                      focus={focus}
                      layers={layers.filter(l => l.mode === 'values')}
                      intent={result.plan.intent}
                      describe={(l) =>
                        `${OP_LABEL[l.op] ?? l.op}${l.part ? ' (component)' : ''}`}
                    />
                    </div>
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
                <div ref={mapBoxRef}>
                  <ChoroplethMap
                    rows={rows}
                    intent={result.plan.intent}
                    result={result}
                    diverging={result.diverging}
                    valueLabel={result.value_label ?? null}
                    visible={activeView === 'map'}
                    focus={focus} />
                </div>
              )}
              {/* Compact, scrollable, and clickable: every county, not the
                  first 50 at full height pushing everything else away. */}
              {countyViews && activeView === 'map' && (
                <div className="mt-4">
                  <CountyTable rows={rows} series={series}
                               onPick={canFocus ? pick : undefined} selected={focus?.fips ?? null} />
                </div>
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
              {features.length.toLocaleString()}
            </span>
          </h3>
          <FeatureTable features={features} />
        </div>
      )}

    </div>
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
    <div className="overflow-auto max-h-72 rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_rgb(226,232,240)]">
          <tr className="text-left text-xs text-slate-500">
            {keys.map(k => (
              <th key={k} className="py-1.5 px-3 font-medium capitalize">{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {features.slice(0, 2000).map((f, i) => (
            <tr key={i} className="border-t border-slate-100">
              {keys.map(k => (
                <td key={k} className="py-1 px-3 text-slate-800">
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

export default ResultBlock;
