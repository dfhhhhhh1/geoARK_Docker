import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Layer, PathOptions } from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { AnalysisRow } from '../types';

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
 */

// Sequential blue, steps 100..650. Light surface: lightest = near zero.
const RAMP_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281'];
// Dark surface: the ramp inverts so "near zero" is the step that recedes toward
// the surface. Unused until the app has a dark theme; wired so it follows when
// it does, rather than needing to be rediscovered then.
const RAMP_DARK = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#86b6ef', '#cde2fb'];

const NO_DATA_LIGHT = '#e8e8e4';
const NO_DATA_DARK = '#383835';

interface Props {
  rows: AnalysisRow[];
  /** Used for the legend heading, so the map says what it is showing. */
  intent: string;
}

/**
 * Follows the APP's theme, not the operating system's.
 *
 * Deliberately ignores prefers-color-scheme: the rest of this UI is light-only
 * (white cards, slate text), so honoring an OS dark preference painted a dark
 * ramp and a #383835 "no data" fill onto white panels. Observed directly.
 *
 * When a theme toggle lands it should stamp data-theme on <html>, and the map
 * follows from here with no further change.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === 'dark');

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(
      () => setDark(el.dataset.theme === 'dark'));
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

/** Quantile breaks; returns the upper bound of each bin except the last. */
function quantileBreaks(values: number[], bins: number): number[] {
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

const fmt = (n: number): string => {
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
 * Frame the map on the counties that actually have data.
 *
 * A `filter_area` result covers one state, and leaving the view on the whole
 * country renders it as a speck in an otherwise empty map -- the answer is on
 * screen but unreadable. Only counties WITH a value are considered, so the
 * national default is preserved for national results.
 */
const FitToData: React.FC<{ features: Feature<Geometry>[] }> = ({ features }) => {
  const map = useMap();
  useEffect(() => {
    if (!features.length) return;
    const bounds = L.geoJSON({
      type: 'FeatureCollection', features,
    } as never).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
  }, [features, map]);
  return null;
};

const ChoroplethMap: React.FC<Props> = ({ rows, intent }) => {
  const isDark = useIsDark();
  const ramp = isDark ? RAMP_DARK : RAMP_LIGHT;
  const noData = isDark ? NO_DATA_DARK : NO_DATA_LIGHT;

  const [counties, setCounties] = useState<FeatureCollection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const { byFips, breaks, binColours } = useMemo(() => {
    const map = new Map<string, AnalysisRow>();
    for (const r of rows) if (r.fips) map.set(String(r.fips).padStart(5, '0'), r);
    const values = rows
      .map(r => r.value)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const b = quantileBreaks(values, ramp.length);

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
  }, [rows, ramp]);

  const colourFor = (value: number | null | undefined): string => {
    if (value === null || value === undefined || !Number.isFinite(value)) return noData;
    let i = 0;
    while (i < breaks.length && value > breaks[i]) i++;
    return binColours[Math.min(i, binColours.length - 1)];
  };

  const style = (feature?: Feature<Geometry>): PathOptions => {
    const geoid = (feature?.properties as { GEOID?: string })?.GEOID ?? '';
    const row = byFips.get(geoid);
    return {
      fillColor: colourFor(row?.value),
      // A 2px surface-colored separation between adjacent fills, so county
      // boundaries read without a heavy stroke competing with the data.
      weight: 0.5,
      color: isDark ? '#1a1a19' : '#fcfcfb',
      fillOpacity: row ? 0.85 : 0.35,
    };
  };

  const onEachFeature = (feature: Feature<Geometry>, layer: Layer) => {
    const props = feature.properties as { GEOID?: string; NAME?: string };
    const row = byFips.get(props?.GEOID ?? '');
    const name = row?.name || props?.NAME || 'Unknown';
    const value = row?.value;
    layer.bindTooltip(
      `<strong>${name}</strong><br/>` +
      (value === null || value === undefined
        ? '<span style="opacity:.7">no data</span>'
        : fmt(value)),
      { sticky: true },
    );
  };

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

  const withData = counties.features.filter(f =>
    byFips.has((f.properties as { GEOID?: string })?.GEOID ?? ''));

  // Built from the bins that exist, never from ramp.length. Reading breaks[i-1]
  // past the end produced `undefined.toFixed` and took the whole page down.
  const legendBins = binColours.map((color, i) => {
    const lo = i === 0 ? undefined : breaks[i - 1];
    const hi = i < breaks.length ? breaks[i] : undefined;
    // Bounds must match colourFor, which advances while `value > breaks[i]`.
    // Each bin is therefore (lo, hi] -- inclusive at the top, not the bottom.
    // Labelling bin 0 as "< 0" claimed a range holding nothing, when what it
    // actually holds is every county with exactly zero.
    const label =
      lo === undefined && hi === undefined ? 'all values'
      : lo === undefined ? `≤ ${fmt(hi as number)}`
      : hi === undefined ? `> ${fmt(lo)}`
      : `${fmt(lo)}, ${fmt(hi)}`;
    return { color, label };
  });

  return (
    <div>
      <div className="h-[420px] rounded-lg overflow-hidden border border-slate-200">
        <MapContainer
          center={[39.5, -98.35]}
          zoom={4}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <GeoJSON
            // Remount when the values change: Leaflet caches the style function
            // per layer, so without this the fills stay on the previous result.
            key={`${rows.length}-${breaks.join(',')}-${isDark}`}
            data={counties}
            style={style}
            onEachFeature={onEachFeature}
          />
          <FitToData features={withData} />
        </MapContainer>
      </div>

      <div className="mt-3">
        <p className="text-xs font-medium text-slate-600 mb-1.5">{intent}</p>
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
