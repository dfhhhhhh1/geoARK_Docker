import React, { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { Layer, PathOptions } from 'leaflet';
import type { Feature, Geometry } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { MappedFeature } from '../types';

/**
 * Individual locations on a map -- points, lines or polygons -- as opposed to
 * the county choropleth in ChoroplethMap.
 *
 * These are two genuinely different answers and get two components rather than
 * one with a mode flag. A choropleth encodes ONE number per county in color; a
 * feature layer encodes identity and position, carries per-feature attributes,
 * and has no value to bin. Sharing a component would mean every branch inside
 * it asking which kind it was.
 *
 * Color here is identity, not magnitude: a single categorical hue, because
 * every feature belongs to the same dataset. Nothing is being compared, so a
 * sequential ramp would imply an ordering that is not in the data.
 */

const ACCENT = '#2a78d6';          // categorical slot 1, light surface
const ACCENT_DARK = '#3987e5';
const SURFACE = '#fcfcfb';
const SURFACE_DARK = '#1a1a19';

interface Props {
  features: MappedFeature[];
  /** Names the layer, so the map says what it is showing. */
  intent: string;
}

const FitToFeatures: React.FC<{ data: GeoJSON.FeatureCollection }> = ({ data }) => {
  const map = useMap();
  useEffect(() => {
    if (!data.features.length) return;
    const bounds = L.geoJSON(data as never).getBounds();
    // A single point yields a zero-area bounds that fitBounds would zoom to
    // maximum; pad it to something readable instead.
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
    }
  }, [data, map]);
  return null;
};

function useIsDark(): boolean {
  const [dark, setDark] = React.useState(
    () => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.dataset.theme === 'dark'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const FeatureMap: React.FC<Props> = ({ features, intent }) => {
  const isDark = useIsDark();
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const surface = isDark ? SURFACE_DARK : SURFACE;

  const collection = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: features as unknown as GeoJSON.Feature[],
  }), [features]);

  const kinds = useMemo(() => {
    const set = new Set(features.map(f => f.geometry?.type).filter(Boolean));
    return [...set];
  }, [features]);

  const style = (): PathOptions => ({
    color: accent,
    weight: 2,
    opacity: 0.9,
    fillColor: accent,
    fillOpacity: 0.25,
  });

  /** Points get a circle marker: the default Leaflet pin needs image assets
   *  that are not bundled, and a circle scales better at low zoom. */
  const pointToLayer = (_f: Feature<Geometry>, latlng: L.LatLng) =>
    L.circleMarker(latlng, {
      radius: 5,
      color: surface,          // a 2px surface ring keeps overlapping marks legible
      weight: 1.5,
      fillColor: accent,
      fillOpacity: 0.95,
    });

  const onEachFeature = (feature: Feature<Geometry>, layer: Layer) => {
    const props = (feature.properties ?? {}) as Record<string, string | null>;
    const entries = Object.entries(props).filter(([, v]) => v !== null && v !== '');
    if (!entries.length) return;

    const title = props.name ? `<strong>${escapeHtml(props.name)}</strong>` : '';
    const rest = entries
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `<div><span style="opacity:.6">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`)
      .join('');
    layer.bindPopup(`<div style="min-width:160px">${title}${rest}</div>`);
    layer.bindTooltip(props.name ? escapeHtml(props.name) : escapeHtml(String(entries[0][1])));
  };

  if (!features.length) {
    return (
      <div className="h-[420px] flex items-center justify-center text-sm
                      text-slate-500 bg-slate-50 rounded-lg">
        No locations matched.
      </div>
    );
  }

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
            key={features.length}
            data={collection}
            style={style}
            pointToLayer={pointToLayer}
            onEachFeature={onEachFeature}
          />
          <FitToFeatures data={collection} />
        </MapContainer>
      </div>

      <div className="mt-3 flex items-center gap-x-4 gap-y-1.5 flex-wrap">
        <p className="text-xs font-medium text-slate-600">{intent}</p>
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
          <span className="inline-block w-3 h-3 rounded-full border border-white shadow-sm"
                style={{ backgroundColor: accent }} />
          {features.length.toLocaleString()} location{features.length === 1 ? '' : 's'}
          {kinds.length ? ` · ${kinds.join(', ').toLowerCase()}` : ''}
        </span>
      </div>
    </div>
  );
};

export default FeatureMap;
