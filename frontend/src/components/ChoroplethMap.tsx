import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LeafletMouseEvent, PathOptions } from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { AnalysisResponse, AnalysisRow } from '../types';
import { BaseLayers, MapToolbar } from './MapControls';
import {
  basemapById, loadBasemapId, saveBasemapId,
  rampsFor, loadRampId, saveRampId,
} from '../lib/basemaps';
import { deriveSeries } from '../lib/series';
import { useIsDark } from '../hooks/useIsDark';
import { Palette } from 'lucide-react';

/**
 * Choropleth of an analysis result.
 *
 * GEOMETRY IS NOT FETCHED FROM THE API. /api/analyze can return ST_AsGeoJSON
 * per row, but that is ~6.6 MB for a 1,000-row result and this app already
 * ships public/counties.geojson. The stream requests values only (~70 KB) and
 * the join happens here on fips -> GEOID.
 *
 * Color follows the validated sequential blue ramp: ONE hue, light -> dark,
 * six quantile bins. Quantiles rather than equal intervals because county
 * measures are heavily skewed -- equal intervals put 95% of counties in the
 * first bin and the map reads as empty.
 *
 * TWO MEASURES. When the plan ends in a `join` every row carries a second
 * number, and both are shown: the readout lists them together, and the color
 * follows whichever is selected. Not a bivariate ramp -- that needs a 2D color
 * matrix, and it is unreadable without a legend most people will not read.
 */

// The colour ramps live in lib/basemaps.ts now, beside the basemap list:
// both are viewing preferences the user picks and the app remembers.
export const NO_DATA_LIGHT = '#e8e8e4';
export const NO_DATA_DARK = '#383835';

/** Hover emphasis. Stroke only: changing the fill would misreport the value. */
const HIGHLIGHT: PathOptions = { weight: 2.5, color: '#1a1a19', opacity: 1 };

interface Props {
  rows: AnalysisRow[];
  /** Used for the legend heading, so the map says what it is showing. */
  intent: string;
  /** Supplies the plan and candidates that name a second measure. */
  result?: AnalysisResponse;
  /**
   * The values are signed around zero (hotspot, outlier), so the ramp must
   * diverge and the bins must be symmetric. Declared by the backend from the
   * op that produced the layer rather than sniffed from the numbers.
   */
  diverging?: boolean;
  /** What the number means, e.g. "Gi* z-score". Shown beside the legend. */
  valueLabel?: string | null;
  /**
   * False while another view tab is showing. The map stays MOUNTED and is
   * hidden with CSS rather than unmounted: unmounting destroys the Leaflet
   * instance, and remounting rebuilds it at the default national zoom, which
   * threw away the user's pan and zoom every time they looked at the chart and
   * came back.
   */
  visible?: boolean;
}

/**
 * Leaflet measures its container once, at creation. A map that was hidden when
 * it initialised, or hidden while the window changed size, renders into stale
 * dimensions -- grey bands, or tiles in the wrong place. invalidateSize on
 * becoming visible is the documented fix.
 */
const InvalidateOnShow: React.FC<{ visible: boolean }> = ({ visible }) => {
  const map = useMap();
  useEffect(() => {
    if (!visible) return;
    // After the browser has applied the un-hiding, so the box has a size.
    const id = window.requestAnimationFrame(() => map.invalidateSize());
    return () => window.cancelAnimationFrame(id);
  }, [visible, map]);
  return null;
};

/** Quantile breaks; returns the upper bound of each bin except the last. */
export function quantileBreaks(values: number[], bins: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const breaks: number[] = [];
  for (let i = 1; i < bins; i++) {
    const idx = Math.floor((i / bins) * sorted.length);
    breaks.push(sorted[Math.min(idx, sorted.length - 1)]);
  }
  // Collapse duplicates: a measure where >1/6 of counties share a value (often
  // zero) yields repeated breaks, which would render as unused legend bins.
  return [...new Set(breaks)];
}

/**
 * Breaks for a signed measure, SYMMETRIC about zero.
 *
 * Plain quantiles are wrong here. They put a bin edge wherever the data is
 * dense, so zero lands mid-bin and the neutral colour drifts off it -- a county
 * with a Gi* of +0.4 would be painted the same as one at -0.4, which inverts
 * the finding. The magnitudes come from the quantiles of the ABSOLUTE value and
 * are then mirrored, so the ramp stays data-driven while zero stays neutral.
 */
export function divergingBreaks(values: number[], bins: number): number[] {
  const magnitudes = values.map(Math.abs).filter(v => v > 0).sort((a, b) => a - b);
  if (!magnitudes.length) return [];
  const perSide = Math.max(Math.floor(bins / 2) - 1, 1);
  const cuts: number[] = [];
  for (let i = 1; i <= perSide; i++) {
    const idx = Math.floor((i / (perSide + 1)) * magnitudes.length);
    cuts.push(magnitudes[Math.min(idx, magnitudes.length - 1)]);
  }
  const unique = [...new Set(cuts)].filter(v => v > 0);
  return [...unique.map(v => -v).reverse(), 0, ...unique];
}

export const fmt = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  // Counts are integers; rendering "0.000" for zero hospitals reads as a
  // precision the measure does not have.
  if (Number.isInteger(n) && abs < 1_000) return String(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 1) return n.toFixed(1);
  return n.toFixed(3);
};

/**
 * Frame the map on the counties that actually have data, ONCE per result.
 *
 * `features` must be referentially stable across unrelated re-renders or this
 * refits on every keystroke in the question box: the effect used to depend on
 * an array rebuilt inline during render, so typing a new query threw away the
 * zoom and pan the user had just set on the previous answer. The array is
 * memoized by the caller, and the ref below is the second guard -- it makes
 * refitting depend on the DATA changing rather than on the effect re-running.
 */
const FitToData: React.FC<{
  features: Feature<Geometry>[];
  signature: string;
}> = ({ features, signature }) => {
  const map = useMap();
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (fitted.current === signature || !features.length) return;
    const bounds = L.geoJSON({
      type: 'FeatureCollection', features,
    } as never).getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [16, 16] });
      fitted.current = signature;
    }
  }, [features, signature, map]);

  return null;
};

const ChoroplethMap: React.FC<Props> = ({
  rows, intent, result, diverging = false, valueLabel = null, visible = true,
}) => {
  const isDark = useIsDark();
  // Sequential and diverging selections are remembered separately, because a
  // signed measure must never fall back to a single-hue ramp.
  const [rampId, setRampId] = useState(() => loadRampId(diverging));
  const rampChoices = rampsFor(diverging);
  const chosen = rampChoices.find(r => r.id === rampId) ?? rampChoices[0];
  const ramp = isDark ? chosen.dark : chosen.light;
  const chooseRamp = (id: string) => { setRampId(id); saveRampId(diverging, id); };
  // Switching between a signed and an unsigned result changes which list
  // applies, so the selection has to be re-read rather than carried over.
  useEffect(() => { setRampId(loadRampId(diverging)); }, [diverging]);
  const noData = isDark ? NO_DATA_DARK : NO_DATA_LIGHT;

  const [counties, setCounties] = useState<FeatureCollection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [basemapId, setBasemapId] = useState(() => loadBasemapId('light'));
  const [opacity, setOpacity] = useState(0.85);
  const [seriesIdx, setSeriesIdx] = useState(0);
  const [hovered, setHovered] = useState<AnalysisRow | null>(null);

  // The basemap object itself is resolved in the body, which is what renders it.
  const chooseBasemap = (id: string) => { setBasemapId(id); saveBasemapId(id); };

  useEffect(() => {
    let cancelled = false;
    fetch('/counties.geojson')
      .then(r => {
        if (!r.ok) throw new Error(`counties.geojson: HTTP ${r.status}`);
        return r.json();
      })
      .then((d: FeatureCollection) => { if (!cancelled) setCounties(d); })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const series = useMemo(
    () => (result ? deriveSeries(result, rows) : [{ key: 'value' as const, label: intent }]),
    [result, rows, intent]);

  // A new result may carry fewer series than the last one was showing.
  const active = series[Math.min(seriesIdx, series.length - 1)];
  useEffect(() => { setSeriesIdx(0); }, [rows]);

  const { byFips, breaks, binColours } = useMemo(() => {
    const map = new Map<string, AnalysisRow>();
    for (const r of rows) if (r.fips) map.set(String(r.fips).padStart(5, '0'), r);
    const values = rows
      .map(r => r[active.key])
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    const b = diverging
      ? divergingBreaks(values, ramp.length)
      : quantileBreaks(values, ramp.length);

    // De-duplication can leave fewer breaks than ramp steps -- a measure where
    // most counties share a value (hospital counts are mostly 0) collapses
    // several quantiles onto the same number. Sample the ramp down to the bins
    // that actually exist so the map still spans light -> dark instead of using
    // only its first two steps.
    const binCount = b.length + 1;
    const colors = binCount >= ramp.length
      ? ramp
      : Array.from({ length: binCount }, (_, i) =>
          ramp[Math.round((i / Math.max(binCount - 1, 1)) * (ramp.length - 1))]);

    return { byFips: map, breaks: b, binColours: colors };
  }, [rows, ramp, active.key, diverging]);

  const colourFor = useCallback((value: number | null | undefined): string => {
    if (value === null || value === undefined || !Number.isFinite(value)) return noData;
    let i = 0;
    while (i < breaks.length && value > breaks[i]) i++;
    return binColours[Math.min(i, binColours.length - 1)];
  }, [breaks, binColours, noData]);

  const style = useCallback((feature?: Feature<Geometry>): PathOptions => {
    const geoid = (feature?.properties as { GEOID?: string })?.GEOID ?? '';
    const row = byFips.get(geoid);
    const value = row?.[active.key];
    return {
      fillColor: colourFor(value),
      // A thin surface-colored separation between adjacent fills, so county
      // boundaries read without a heavy stroke competing with the data.
      weight: 0.5,
      color: isDark ? '#1a1a19' : '#fcfcfb',
      opacity: 1,
      // Counties with no value stay faint at any setting: they are context, and
      // at full opacity a flat grey mass competes with the data for attention.
      fillOpacity: row ? opacity : opacity * 0.4,
    };
  }, [byFips, active.key, colourFor, isDark, opacity]);

  /**
   * The live style function, for handlers Leaflet bound before the latest
   * render. Restoring a hovered county by calling `resetStyle` would reapply
   * the style captured when the layer was CREATED, so moving the opacity slider
   * and then hovering would snap that one county back to the old opacity.
   */
  const styleRef = useRef(style);
  styleRef.current = style;

  const geoRef = useRef<L.GeoJSON | null>(null);
  const hoveredLayerRef = useRef<L.Path | null>(null);

  /**
   * Drop the hover state and restore the county underneath it.
   *
   * THE STUCK-READOUT BUG. Leaflet's own `mouseout` is not reliable at the edge
   * of the map: moving the pointer off the container quickly, or onto a control
   * or popup drawn above the tiles, can leave the last `mouseover` unmatched,
   * and the highlight and its label then stay on screen with the pointer
   * nowhere near them. This is why the readout is React state in an overlay
   * rather than an `L.Tooltip`: the wrapper div's own `mouseleave` is a plain
   * DOM event that always fires, so it can be used as the backstop that clears
   * whatever Leaflet left behind.
   */
  const clearHover = useCallback(() => {
    const layer = hoveredLayerRef.current;
    if (layer) {
      const feature = (layer as L.Path & { feature?: Feature<Geometry> }).feature;
      layer.setStyle(styleRef.current(feature));
      hoveredLayerRef.current = null;
    }
    setHovered(null);
  }, []);

  // Opacity must not remount the layer: rebuilding 3,233 polygons on every tick
  // of a slider drag is visibly slow. Restyle the existing layer in place.
  useEffect(() => {
    geoRef.current?.setStyle(style as never);
  }, [style]);

  const onMouseOver = useCallback((e: LeafletMouseEvent) => {
    const layer = ((e as unknown as { propagatedFrom?: L.Path; layer?: L.Path })
      .propagatedFrom ?? (e as unknown as { layer?: L.Path }).layer) as L.Path | undefined;
    if (!layer) return;

    // Restore whatever was highlighted before, in case its mouseout was missed.
    const previous = hoveredLayerRef.current;
    if (previous && previous !== layer) {
      const pf = (previous as L.Path & { feature?: Feature<Geometry> }).feature;
      previous.setStyle(styleRef.current(pf));
    }

    layer.setStyle(HIGHLIGHT);
    layer.bringToFront();
    hoveredLayerRef.current = layer;

    const feature = (layer as L.Path & { feature?: Feature<Geometry> }).feature;
    const props = feature?.properties as { GEOID?: string; NAME?: string } | undefined;
    const geoid = props?.GEOID ?? '';
    const row = byFips.get(geoid);
    setHovered(row ?? {
      fips: geoid, name: props?.NAME ?? 'Unknown', state_fp: null, value: null,
    });
  }, [byFips]);

  if (loadError) {
    return (
      <div className="h-[420px] flex items-center justify-center text-sm text-slate-500 bg-slate-50 rounded-lg">
        Could not load county boundaries, {loadError}
      </div>
    );
  }

  if (!counties) {
    return <div className="h-[420px] bg-slate-100 rounded-lg animate-pulse" />;
  }

  return (
    <ChoroplethBody
      counties={counties}
      byFips={byFips}
      rows={rows}
      series={series}
      active={active}
      seriesIdx={Math.min(seriesIdx, series.length - 1)}
      onSeries={setSeriesIdx}
      breaks={breaks}
      binColours={binColours}
      noData={noData}
      intent={intent}
      style={style}
      geoRef={geoRef}
      basemapId={basemapId}
      onBasemap={chooseBasemap}
      opacity={opacity}
      onOpacity={setOpacity}
      hovered={hovered}
      onMouseOver={onMouseOver}
      clearHover={clearHover}
      isDark={isDark}
      valueLabel={valueLabel}
      visible={visible}
      rampId={chosen.id}
      rampChoices={rampChoices}
      onRamp={chooseRamp}
    />
  );
};

/**
 * Split out only so the hooks above can run before the counties fetch resolves
 * without the early returns changing hook order. Nothing here has its own
 * state.
 */
interface BodyProps {
  counties: FeatureCollection;
  byFips: Map<string, AnalysisRow>;
  rows: AnalysisRow[];
  series: ReturnType<typeof deriveSeries>;
  active: { key: 'value' | 'value_b'; label: string };
  seriesIdx: number;
  onSeries: (i: number) => void;
  breaks: number[];
  binColours: string[];
  noData: string;
  intent: string;
  style: (f?: Feature<Geometry>) => PathOptions;
  geoRef: React.MutableRefObject<L.GeoJSON | null>;
  basemapId: string;
  onBasemap: (id: string) => void;
  opacity: number;
  onOpacity: (v: number) => void;
  hovered: AnalysisRow | null;
  onMouseOver: (e: LeafletMouseEvent) => void;
  clearHover: () => void;
  isDark: boolean;
  valueLabel: string | null;
  visible: boolean;
  rampId: string;
  rampChoices: ReturnType<typeof rampsFor>;
  onRamp: (id: string) => void;
}

const ChoroplethBody: React.FC<BodyProps> = ({
  counties, byFips, rows, series, active, seriesIdx, onSeries, breaks, binColours,
  noData, intent, style, geoRef, basemapId, onBasemap, opacity, onOpacity,
  hovered, onMouseOver, clearHover, isDark, valueLabel, visible,
  rampId, rampChoices, onRamp,
}) => {
  const basemap = basemapById(basemapId);

  // Memoized so FitToData's effect does not re-run on every parent render. See
  // the note on FitToData: an inline .filter() here reset the zoom on keystroke.
  const withData = useMemo(
    () => counties.features.filter(f =>
      byFips.has((f.properties as { GEOID?: string })?.GEOID ?? '')),
    [counties, byFips]);

  // Identifies the RESULT, not the render. Changing basemap, opacity or series
  // must not refit the view the user has set.
  const fitSignature = useMemo(
    () => `${rows.length}:${rows[0]?.fips ?? ''}:${rows[rows.length - 1]?.fips ?? ''}`,
    [rows]);

  // Built from the bins that exist, never from ramp.length. Reading breaks[i-1]
  // past the end produced `undefined.toFixed` and took the whole page down.
  const legendBins = binColours.map((color, i) => {
    const lo = i === 0 ? undefined : breaks[i - 1];
    const hi = i < breaks.length ? breaks[i] : undefined;
    // Bounds must match colourFor, which advances while `value > breaks[i]`.
    // Each bin is therefore (lo, hi] -- inclusive at the top, not the bottom.
    const label =
      lo === undefined && hi === undefined ? 'all values'
      : lo === undefined ? `≤ ${fmt(hi as number)}`
      : hi === undefined ? `> ${fmt(lo)}`
      : `${fmt(lo)}, ${fmt(hi)}`;
    return { color, label };
  });

  return (
    <div className={visible ? undefined : 'hidden'}>
      <MapToolbar
        basemapId={basemapId}
        onBasemap={onBasemap}
        opacity={opacity}
        onOpacity={onOpacity}
        opacityLabel="County fill"
      >
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <Palette className="w-4 h-4 text-slate-400" aria-hidden />
          <span className="sr-only">Color scale</span>
          <select
            value={rampId}
            onChange={e => onRamp(e.target.value)}
            className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white
                       text-slate-700 cursor-pointer"
          >
            {rampChoices.map(r => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
          {/* The ramp itself, so the name is not the only clue. */}
          <span className="flex rounded-sm overflow-hidden border border-slate-300">
            {(isDark ? (rampChoices.find(r => r.id === rampId) ?? rampChoices[0]).dark
                     : (rampChoices.find(r => r.id === rampId) ?? rampChoices[0]).light
             ).map((c, i) => (
              <span key={i} className="w-2.5 h-4" style={{ backgroundColor: c }} />
            ))}
          </span>
        </label>
        {series.length > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500">Color by</span>
            <div className="flex rounded-lg border border-slate-300 overflow-hidden">
              {series.map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => onSeries(i)}
                  aria-pressed={seriesIdx === i}
                  title={s.label}
                  className={`px-2.5 py-1 text-xs max-w-[13rem] truncate transition-colors
                              border-r border-slate-300 last:border-r-0 ${
                    seriesIdx === i
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </MapToolbar>

      {/* mouseleave on the wrapper is the backstop for a missed Leaflet
          mouseout. It is a real DOM event on a real box, so it fires even when
          the pointer leaves the window entirely. */}
      <div
        className="relative h-[420px] rounded-lg overflow-hidden border border-slate-200"
        onMouseLeave={clearHover}
      >
        <MapContainer
          center={[39.5, -98.35]}
          zoom={4}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <BaseLayers basemap={basemap} />
          <GeoJSON
            // Remount when the values, bins, series or theme change: Leaflet
            // caches the style function per layer, so without this the fills
            // stay on the previous result. Opacity is deliberately NOT in this
            // key -- it is applied by setStyle instead, so dragging the slider
            // does not rebuild every polygon.
            key={`${rows.length}-${breaks.join(',')}-${isDark}-${active.key}`}
            ref={geoRef as never}
            data={counties}
            style={style}
            eventHandlers={{ mouseover: onMouseOver, mouseout: clearHover }}
          />
          <FitToData features={withData} signature={fitSignature} />
          <InvalidateOnShow visible={visible} />
        </MapContainer>

        {/* pointer-events-none matters: a readout that can itself receive the
            pointer steals the mouseout from the county underneath it, which is
            one of the ways the old tooltip got stuck. */}
        {hovered && (
          <div className="absolute top-2.5 right-2.5 z-[500] pointer-events-none
                          bg-white/95 backdrop-blur-sm border border-slate-200
                          rounded-lg shadow-sm px-3 py-2 max-w-[15rem]">
            <p className="text-sm font-semibold text-slate-800 leading-tight">
              {hovered.name ?? 'Unknown'}
            </p>
            {series.map(s => (
              <p key={s.key} className="mt-1 text-xs leading-tight">
                <span className="text-slate-500">{series.length > 1 ? s.label : 'Value'}</span>
                <br />
                <span className={`tabular-nums ${
                  s.key === active.key ? 'text-slate-900 font-medium' : 'text-slate-600'
                }`}>
                  {hovered[s.key] === null || hovered[s.key] === undefined
                    ? 'no data'
                    : fmt(hovered[s.key])}
                </span>
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium text-slate-600 mb-1.5">
          {series.length > 1 ? `${intent} · colored by ${active.label}` : intent}
          {/* Names the unit for a derived statistic. "14.2" means nothing on
              its own; "14.2 Gi* z-score" is checkable. */}
          {valueLabel && (
            <span className="font-normal text-slate-500"> · {valueLabel}</span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {legendBins.map(({ color, label }, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-xs text-slate-600">
              <span
                className="inline-block w-3.5 h-3.5 rounded-sm border border-slate-300"
                style={{ backgroundColor: color }}
              />
              {label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <span
              className="inline-block w-3.5 h-3.5 rounded-sm border border-slate-300"
              style={{ backgroundColor: noData }}
            />
            no data
          </span>
        </div>
      </div>
    </div>
  );
};

export default ChoroplethMap;
