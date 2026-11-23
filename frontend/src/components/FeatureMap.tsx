import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LeafletMouseEvent, PathOptions } from 'leaflet';
import type { Feature, Geometry } from 'geojson';
import 'leaflet/dist/leaflet.css';
import type { FeatureTiles, MappedFeature } from '../types';
import { FeatureTilesLayer, fetchFeatureAt, tilesBounds } from '../lib/featureTiles';
import {
  BaseLayers, MapToolbar, StageZoom, fitOptions, type FitPadding, type MapVariant,
} from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId } from '../lib/basemaps';
import { useIsDark } from '../hooks/useIsDark';
import { featureKeyLabel, featureValueText } from '../lib/featureKeys';

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
/** The colours a reader can pick; the same set the layer stack offers, after the default blue. */
export const FEATURE_PICKS = ['#2a78d6', '#c2410c', '#7c3aed', '#0f766e', '#be123c', '#a16207', '#1a1a19'];
const COLOR_KEY = 'geoark.featureColor';
const loadColor = () => { try { return window.localStorage.getItem(COLOR_KEY); } catch { return null; } };
const saveColor = (c: string) => { try { window.localStorage.setItem(COLOR_KEY, c); } catch { /* ignore */ } };
const SURFACE = '#fcfcfb';
const SURFACE_DARK = '#1a1a19';

interface Props {
  features: MappedFeature[];
  /** Names the layer, so the map says what it is showing. */
  intent: string;
  /** `stage` fills the parent and floats its controls; see MapVariant. */
  variant?: MapVariant;
  fitPadding?: FitPadding;
  /** Extra stage toolbar controls, e.g. "Add layer". */
  toolbarExtra?: React.ReactNode;
  /** Over the feature cap: the whole layer as server tiles; `features` is then a sample. */
  tiles?: FeatureTiles | null;
  /** What a computed column (a distance, zonal_value, ...) means; see lib/featureKeys. */
  valueLabel?: string | null;
}

/**
 * A large point answer from tiles (lib/featureTiles.ts). Hover asks the server
 * for the nearest point (throttled), click opens its details in a popup.
 */
export const TiledPoints: React.FC<{
  tiles: FeatureTiles; color: string; ring: string; opacity: number;
  onHover: (props: Record<string, string | null> | null) => void;
  onError: (msg: string) => void;
  /** A map pane to draw in (the layer stack gives each layer its own). */
  pane?: string;
}> = ({ tiles, color, ring, opacity, onHover, onError, pane }) => {
  const map = useMap();
  const layerRef = useRef<InstanceType<typeof FeatureTilesLayer> | null>(null);
  const style = useRef({ color, ring, opacity });
  style.current = { color, ring, opacity };
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    const s = style.current;
    const layer = new FeatureTilesLayer({ setId: tiles.id, color: s.color, ringColor: s.ring, opacity: s.opacity,
      updateWhenZooming: false, keepBuffer: 1, onError, ...(pane ? { pane } : {}) });
    layer.addTo(map);
    layerRef.current = layer;
    return () => { layer.remove(); layerRef.current = null; };
  }, [map, tiles.id, onError, pane]);
  useEffect(() => { layerRef.current?.recolor(color, ring); }, [color, ring]);
  useEffect(() => { layerRef.current?.setOpacity(opacity); }, [opacity]);

  // Hover: the nearest point within a few pixels, asked at most every 120 ms,
  // newest wins. A ring marks it.
  useEffect(() => {
    let timer: number | null = null;
    let last: L.LeafletMouseEvent | null = null;
    let ac: AbortController | null = null;
    const mark = L.circleMarker([0, 0], { radius: 7, color: '#1a1a19', weight: 2.5, fill: false, interactive: false });
    const lookup = () => {
      timer = null;
      if (!last) return;
      const { lat, lng } = last.latlng;
      ac?.abort();
      ac = new AbortController();
      fetchFeatureAt(tiles, lat, lng, map.getZoom(), ac.signal).then(f => {
        if (f) { mark.setLatLng([f.lat, f.lon]).addTo(map); onHoverRef.current(f.properties); }
        else { mark.remove(); onHoverRef.current(null); }
      }).catch(() => { /* superseded */ });
    };
    const move = (e: L.LeafletMouseEvent) => { last = e; if (timer === null) timer = window.setTimeout(lookup, 120); };
    const out = () => { last = null; ac?.abort(); mark.remove(); onHoverRef.current(null); };
    const click = (e: L.LeafletMouseEvent) => {
      fetchFeatureAt(tiles, e.latlng.lat, e.latlng.lng, map.getZoom()).then(f => {
        if (!f) return;
        const props = Object.entries(f.properties).filter(([, v]) => v !== null && v !== '');
        const title = f.properties.name ? `<strong>${escapeHtml(f.properties.name)}</strong>` : '';
        const rest = props.filter(([k]) => k !== 'name')
          .map(([k, v]) => `<div><span style="opacity:.6">${escapeHtml(k)}:</span> ${escapeHtml(String(v))}</div>`).join('');
        L.popup().setLatLng([f.lat, f.lon]).setContent(`<div style="min-width:160px">${title}${rest}</div>`).openOn(map);
      }).catch(() => { /* nothing there */ });
    };
    map.on('mousemove', move);
    map.on('mouseout', out);
    map.on('click', click);
    return () => {
      map.off('mousemove', move); map.off('mouseout', out); map.off('click', click);
      if (timer !== null) window.clearTimeout(timer);
      ac?.abort(); mark.remove();
    };
  }, [map, tiles]);
  return null;
};

const FitToBounds: React.FC<{ bounds: L.LatLngBounds | null; signature: string; padding?: FitPadding }> =
  ({ bounds, signature, padding }) => {
    const map = useMap();
    const fitted = useRef<string | null>(null);
    useEffect(() => {
      if (!bounds || !bounds.isValid() || fitted.current === signature) return;
      map.fitBounds(bounds.pad(0.05), { maxZoom: 13, ...fitOptions(padding, 0) });
      fitted.current = signature;
    }, [bounds, signature, map, padding]);
    return null;
  };

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
  padding?: FitPadding;
}> = ({ data, signature, padding }) => {
  const map = useMap();
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    if (fitted.current === signature || !data.features.length) return;
    const bounds = L.geoJSON(data as never).getBounds();
    // A single point yields a zero-area bounds that fitBounds would zoom to
    // maximum; pad it to something readable instead.
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15), { maxZoom: 13, ...fitOptions(padding, 0) });
      fitted.current = signature;
    }
  }, [data, signature, map, padding]);

  return null;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const FeatureMap: React.FC<Props> = ({ features, intent, variant = 'inline', fitPadding, toolbarExtra, tiles = null, valueLabel = null }) => {
  const stage = variant === 'stage';
  const mapRef = useRef<L.Map | null>(null);
  // Bumped by the stage's reset button; see ChoroplethMap.
  const [refit, setRefit] = useState(0);
  const isDark = useIsDark();
  const [picked, setPicked] = useState<string | null>(loadColor);
  const accent = picked && FEATURE_PICKS.includes(picked) ? picked : (isDark ? ACCENT_DARK : ACCENT);
  const pickColor = (c: string) => { setPicked(c); saveColor(c); };
  const [tileError, setTileError] = useState<string | null>(null);
  const onTileError = useCallback((m: string) => setTileError(m), []);
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
    () => `${features.length}:${JSON.stringify(features[0]?.geometry ?? null).slice(0, 60)}:${refit}`,
    [features, refit]);

  // Points and shapes are styled apart. One style for both used to give a
  // point the polygon's faint fill, and a hover reset to the point's own
  // marker options then left it white (the surface ring, a near-clear fill).
  const style = useCallback((f?: Feature<Geometry>): PathOptions => {
    const t = f?.geometry?.type;
    if (t === 'Point' || t === 'MultiPoint') {
      return { color: surface, weight: 1.5, opacity, fillColor: accent, fillOpacity: Math.min(opacity + 0.05, 1) };
    }
    return {
      color: accent,
      weight: 2,
      opacity,
      fillColor: accent,
      // Fills stay well below the stroke so overlapping polygons remain readable,
      // and so imagery underneath a polygon layer is not painted out entirely.
      fillOpacity: opacity * 0.28,
    };
  }, [accent, surface, opacity]);
  const styleRef = useRef(style);
  styleRef.current = style;
  /** Back to exactly what the style function gives this feature now. Leaflet's
   *  resetStyle is NOT used: on these circle markers it dropped fill and stroke. */
  const restyle = (layer: L.Path) => {
    const f = (layer as L.Path & { feature?: Feature<Geometry> }).feature;
    layer.setStyle(styleRef.current(f));
  };

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
    // A MultiPoint is a group of markers, and the marker under the pointer is
    // what hover sees: without its feature it had no style branch (it got the
    // polygon one, which read as white) and no readout.
    if (layer instanceof L.FeatureGroup) {
      layer.eachLayer(c => { (c as L.Layer & { feature?: Feature<Geometry> }).feature = feature; });
    }
    const props = (feature.properties ?? {}) as Record<string, string | null>;
    const entries = Object.entries(props).filter(([, v]) => v !== null && v !== '');
    if (!entries.length) return;
    // A popup on CLICK, kept alongside the hover readout: it is dismissed
    // deliberately, so it can be read and copied from without the pointer
    // having to stay still.
    const title = props.name ? `<strong>${escapeHtml(props.name)}</strong>` : '';
    const rest = entries
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `<div><span style="opacity:.6">${escapeHtml(featureKeyLabel(k, valueLabel))}:</span> ${escapeHtml(featureValueText(k, v))}</div>`)
      .join('');
    layer.bindPopup(`<div style="min-width:160px;max-width:260px">${title}${rest}</div>`);
  }, [valueLabel]);

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
      // Colour and opacity as they are now, not as when the layer was drawn.
      restyle(layer);
      hoveredLayerRef.current = null;
    }
    setHovered(null);
  }, []);

  const onMouseOver = useCallback((e: LeafletMouseEvent) => {
    const layer = ((e as unknown as { propagatedFrom?: L.Path; layer?: L.Path })
      .propagatedFrom ?? (e as unknown as { layer?: L.Path }).layer) as L.Path | undefined;
    if (!layer) return;

    const previous = hoveredLayerRef.current;
    if (previous && previous !== layer) restyle(previous);

    layer.setStyle({ weight: 3.5, color: isDark ? '#fcfcfb' : '#1a1a19' });
    layer.bringToFront();
    hoveredLayerRef.current = layer;

    const feature = (layer as L.Path & { feature?: Feature<Geometry> }).feature;
    const props = (feature?.properties ?? {}) as Record<string, string | null>;
    setHovered(props);
  }, [isDark]);

  // Restyle in place rather than remounting, so the opacity slider stays smooth
  // with up to 3,000 features on screen.
  useEffect(() => {
    geoRef.current?.setStyle(style as never);
  }, [style]);

  if (!features.length && !tiles) {
    return (
      <div className={`${stage ? 'absolute inset-0' : 'h-[420px] rounded-lg'} flex items-center
                       justify-center text-sm text-slate-500 bg-slate-50`}>
        No locations matched.
      </div>
    );
  }

  const readout = hovered
    ? Object.entries(hovered).filter(([, v]) => v !== null && v !== '')
    : [];

  const toolbar = (className?: string) => (
    <MapToolbar
      basemapId={basemapId}
      onBasemap={chooseBasemap}
      opacity={opacity}
      onOpacity={setOpacity}
      opacityLabel="Location marker"
      className={className}
    >
      <span className="inline-flex items-center gap-1" role="radiogroup" aria-label="Marker colour">
        {FEATURE_PICKS.map(c => (
          <button key={c} type="button" role="radio" aria-checked={accent === c} onClick={() => pickColor(c)}
                  aria-label={`Colour ${c}`} title="Marker colour"
                  className={`w-4 h-4 rounded-full border-2 ${accent === c ? 'border-ink' : 'border-white shadow-sm'}`}
                  style={{ backgroundColor: c }} />
        ))}
      </span>
      {stage ? toolbarExtra : null}
    </MapToolbar>
  );

  const map = (
    <MapContainer
      ref={mapRef}
      center={[39.5, -98.35]}
      zoom={4}
      scrollWheelZoom
      zoomControl={!stage}
      style={{ height: '100%', width: '100%' }}
    >
      <BaseLayers basemap={basemap} />
      {tiles ? (
        <>
          <TiledPoints tiles={tiles} color={accent} ring={surface} opacity={opacity}
                       onHover={setHovered} onError={onTileError} />
          <FitToBounds bounds={tilesBounds(tiles)} signature={`${tiles.id}:${refit}`} padding={fitPadding} />
        </>
      ) : (
        <>
          <GeoJSON
            key={`${features.length}-${isDark}`}
            ref={geoRef as never}
            data={collection}
            style={style}
            pointToLayer={pointToLayer}
            onEachFeature={onEachFeature}
            eventHandlers={{ mouseover: onMouseOver, mouseout: clearHover }}
          />
          <FitToFeatures data={collection} signature={fitSignature} padding={fitPadding} />
        </>
      )}
    </MapContainer>
  );

  const readoutBox = readout.length > 0 && (
    <div className={`pointer-events-none px-3 py-2 max-w-[15rem] ${stage
      ? 'glass glass-raised rounded-xl'
      : 'absolute top-2.5 right-2.5 z-[500] bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm'}`}>
      {hovered?.name && (
        <p className="text-sm font-semibold text-slate-800 leading-tight mb-0.5">
          {hovered.name}
        </p>
      )}
      {readout.filter(([k]) => k !== 'name').slice(0, 4).map(([k, v]) => (
        <p key={k} className="text-xs leading-snug text-slate-600">
          <span className="text-slate-400">{featureKeyLabel(k, valueLabel)}: </span>{featureValueText(k, v)}
        </p>
      ))}
      <p className="text-[11px] text-slate-400 mt-1">Click for all details</p>
    </div>
  );

  const caption = (
    <>
      <p className="text-xs font-medium text-slate-700">{intent}</p>
      <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
        <span className="inline-block w-3 h-3 rounded-full border border-white shadow-sm"
              style={{ backgroundColor: accent }} />
        {(tiles?.total ?? features.length).toLocaleString()} location{(tiles?.total ?? features.length) === 1 ? '' : 's'}
        {kinds.length ? `, ${kinds.join(', ').toLowerCase()}` : ''}
        {tiles?.truncated ? ' (map capped here)' : ''}
      </span>
      {tiles && features.length < tiles.total && (
        <span className="text-[11px] text-slate-500">
          All {tiles.total.toLocaleString()} on the map; the table and downloads hold the first {features.length.toLocaleString()}.
        </span>
      )}
      {tileError && <span className="text-[11px] text-red-700">{tileError}</span>}
    </>
  );

  if (stage) {
    return (
      <div className="absolute inset-0" onMouseLeave={clearHover}>
        {map}
        <div className="absolute right-3 z-[600] flex flex-col items-end gap-2 pointer-events-none
                        max-w-[min(34rem,calc(100vw-1.5rem))]"
             style={{ top: 'var(--header-offset)' }}>
          <div className="pointer-events-auto glass glass-raisable glass-floor rounded-2xl px-3 py-2">
            {toolbar('flex flex-wrap items-center justify-end gap-x-3 gap-y-2')}
          </div>
          <StageZoom mapRef={mapRef} onReset={() => setRefit(n => n + 1)} />
          {readoutBox}
        </div>
        <div className="absolute right-3 z-[600] glass glass-raisable glass-floor rounded-2xl px-3.5 py-2.5
                        flex flex-col gap-1 max-w-[min(28rem,calc(100vw-1.5rem))]"
             style={{ bottom: 'calc(var(--stage-bottom-inset, 0px) + 1.75rem)' }}>
          {caption}
        </div>
      </div>
    );
  }

  return (
    <div>
      {toolbar()}

      <div
        className="relative h-[420px] rounded-lg overflow-hidden border border-slate-200"
        onMouseLeave={clearHover}
      >
        {map}
        {readoutBox}
      </div>

      <div className="mt-3 flex items-center gap-x-4 gap-y-1.5 flex-wrap">
        {caption}
      </div>
    </div>
  );
};

export default FeatureMap;
