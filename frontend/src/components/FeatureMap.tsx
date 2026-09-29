import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LeafletMouseEvent, PathOptions } from 'leaflet';
import type { Feature, Geometry } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { MappedFeature } from '../types';
import { BaseLayers, MapToolbar } from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId } from '../lib/basemaps';
import { useIsDark } from '../hooks/useIsDark';

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

/**
 * Frame the map on the features, ONCE per result.
 *
 * The signature guard matches ChoroplethMap's: without it, any parent re-render
 * that produced a new array (typing in the question box, moving a slider)
 * discarded the zoom the user had just set.
 */
const FitToFeatures: React.FC<{
  data: GeoJSON.FeatureCollection;
  signature: string;
}> = ({ data, signature }) => {
  const map = useMap();
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (fitted.current === signature || !data.features.length) return;
    const bounds = L.geoJSON(data as never).getBounds();
    // A single point yields a zero-area bounds that fitBounds would zoom to
    // maximum; pad it to something readable instead.
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15), { maxZoom: 13 });
      fitted.current = signature;
    }
  }, [data, signature, map]);

  return null;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const FeatureMap: React.FC<Props> = ({ features, intent }) => {
  const isDark = useIsDark();
  const accent = isDark ? ACCENT_DARK : ACCENT;
  const surface = isDark ? SURFACE_DARK : SURFACE;

  const [basemapId, setBasemapId] = useState(() => loadBasemapId('streets'));
  const [opacity, setOpacity] = useState(0.9);
  const [hovered, setHovered] = useState<Record<string, string | null> | null>(null);

  const basemap = basemapById(basemapId);
  const chooseBasemap = (id: string) => { setBasemapId(id); saveBasemapId(id); };

  const collection = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: features as unknown as GeoJSON.Feature[],
  }), [features]);

  const kinds = useMemo(() => {
    const set = new Set(features.map(f => f.geometry?.type).filter(Boolean));
    return [...set];
  }, [features]);

  const fitSignature = useMemo(
    () => `${features.length}:${JSON.stringify(features[0]?.geometry ?? null).slice(0, 60)}`,
    [features]);

  const style = useCallback((): PathOptions => ({
    color: accent,
    weight: 2,
    opacity,
    fillColor: accent,
    // Fills stay well below the stroke so overlapping polygons remain readable,
    // and so imagery underneath a polygon layer is not painted out entirely.
    fillOpacity: opacity * 0.28,
  }), [accent, opacity]);

  /** Points get a circle marker: the default Leaflet pin needs image assets
   *  that are not bundled, and a circle scales better at low zoom. */
  const pointToLayer = useCallback((_f: Feature<Geometry>, latlng: L.LatLng) =>
    L.circleMarker(latlng, {
      radius: 5,
      color: surface,          // a surface ring keeps overlapping marks legible
      weight: 1.5,
      fillColor: accent,
      opacity,
      fillOpacity: Math.min(opacity + 0.05, 1),
    }), [surface, accent, opacity]);

  const onEachFeature = useCallback((feature: Feature<Geometry>, layer: L.Layer) => {
    const props = (feature.properties ?? {}) as Record<string, string | null>;
    const entries = Object.entries(props).filter(([, v]) => v !== null && v !== '');
    if (!entries.length) return;
    // A popup on CLICK, kept alongside the hover readout: it is dismissed
    // deliberately, so it can be read and copied from without the pointer
    // having to stay still.
    const title = props.name ? `<strong>${escapeHtml(props.name)}</strong>` : '';
    const rest = entries
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `<div><span style="opacity:.6">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`)
      .join('');
    layer.bindPopup(`<div style="min-width:160px">${title}${rest}</div>`);
  }, []);

  const geoRef = useRef<L.GeoJSON | null>(null);
  const hoveredLayerRef = useRef<L.Path | null>(null);

  /**
   * See the long note in ChoroplethMap: Leaflet's `mouseout` can be missed at
   * the edge of the container, which used to leave a bound tooltip on screen
   * with the pointer nowhere near it. The readout is React state cleared by the
   * wrapper's own DOM `mouseleave`, which always fires.
   */
  const clearHover = useCallback(() => {
    const layer = hoveredLayerRef.current;
    if (layer) {
      layer.setStyle(
        layer instanceof L.CircleMarker
          ? { weight: 1.5, color: surface }
          : { weight: 2, color: accent });
      hoveredLayerRef.current = null;
    }
    setHovered(null);
  }, [surface, accent]);

  const onMouseOver = useCallback((e: LeafletMouseEvent) => {
    const layer = ((e as unknown as { propagatedFrom?: L.Path; layer?: L.Path })
      .propagatedFrom ?? (e as unknown as { layer?: L.Path }).layer) as L.Path | undefined;
    if (!layer) return;

    const previous = hoveredLayerRef.current;
    if (previous && previous !== layer) {
      previous.setStyle(
        previous instanceof L.CircleMarker
          ? { weight: 1.5, color: surface }
          : { weight: 2, color: accent });
    }

    layer.setStyle({ weight: 3.5, color: isDark ? '#fcfcfb' : '#1a1a19' });
    layer.bringToFront();
    hoveredLayerRef.current = layer;

    const feature = (layer as L.Path & { feature?: Feature<Geometry> }).feature;
    const props = (feature?.properties ?? {}) as Record<string, string | null>;
    setHovered(props);
  }, [surface, accent, isDark]);

  // Restyle in place rather than remounting, so the opacity slider stays smooth
  // with up to 3,000 features on screen.
  useEffect(() => {
    geoRef.current?.setStyle(style as never);
  }, [style]);

  if (!features.length) {
    return (
      <div className="h-[420px] flex items-center justify-center text-sm
                      text-slate-500 bg-slate-50 rounded-lg">
        No locations matched.
      </div>
    );
  }

  const readout = hovered
    ? Object.entries(hovered).filter(([, v]) => v !== null && v !== '')
    : [];

  return (
    <div>
      <MapToolbar
        basemapId={basemapId}
        onBasemap={chooseBasemap}
        opacity={opacity}
        onOpacity={setOpacity}
        opacityLabel="Location marker"
      />

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
            key={`${features.length}-${isDark}`}
            ref={geoRef as never}
            data={collection}
            style={style}
            pointToLayer={pointToLayer}
            onEachFeature={onEachFeature}
            eventHandlers={{ mouseover: onMouseOver, mouseout: clearHover }}
          />
          <FitToFeatures data={collection} signature={fitSignature} />
        </MapContainer>

        {readout.length > 0 && (
          <div className="absolute top-2.5 right-2.5 z-[500] pointer-events-none
                          bg-white/95 backdrop-blur-sm border border-slate-200
                          rounded-lg shadow-sm px-3 py-2 max-w-[15rem]">
            {hovered?.name && (
              <p className="text-sm font-semibold text-slate-800 leading-tight mb-0.5">
                {hovered.name}
              </p>
            )}
            {readout.filter(([k]) => k !== 'name').slice(0, 4).map(([k, v]) => (
              <p key={k} className="text-xs leading-snug text-slate-600">
                <span className="text-slate-400 capitalize">{k}: </span>{v}
              </p>
            ))}
            <p className="text-[11px] text-slate-400 mt-1">Click for all details</p>
          </div>
        )}
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
