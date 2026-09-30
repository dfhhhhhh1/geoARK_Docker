import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LeafletMouseEvent, PathOptions } from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { Eye, EyeOff } from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import type { AnalysisLayer, AnalysisRow } from '../types';
import { BaseLayers } from './MapControls';
import { Layers as LayersIcon } from 'lucide-react';
import {
  basemapById, loadBasemapId, saveBasemapId, BASEMAPS,
  rampsFor, type Ramp,
} from '../lib/basemaps';
import {
  quantileBreaks, divergingBreaks, fmt, NO_DATA_LIGHT, NO_DATA_DARK,
} from './ChoroplethMap';
import { useIsDark } from '../hooks/useIsDark';
import { OP_LABEL } from '../lib/ops';

/**
 * Several result layers on ONE map, stacked, each with its own opacity.
 *
 * WHY THIS IS A SEPARATE COMPONENT. ChoroplethMap draws exactly one measure and
 * owns a lot of behaviour for it -- series switching, the diverging ramp, the
 * hover readout, the fit-once guard. Parameterising all of that over N layers
 * would have put an "and which layer is this" branch in every one of those
 * paths. Here the per-layer state is an array and the shared state (basemap,
 * hovered county, viewport) is held once, which is the shape the problem
 * actually has.
 *
 * STACKING ORDER IS THE RESULT ORDER. layers[0] is the answer and draws on TOP;
 * the components of an arithmetic result sit under it. Leaflet paints in
 * insertion order, so the array is reversed on the way in.
 *
 * OPACITY IS THE WHOLE POINT. Two county choropleths are opaque fills covering
 * the same 3,233 polygons, so without per-layer opacity the top one simply
 * hides the rest and the stack is pointless. Each layer carries its own, and
 * changing it restyles in place rather than remounting -- rebuilding thousands
 * of polygons on every tick of a slider drag is visibly slow.
 */

interface Props {
  layers: AnalysisLayer[];
  intent: string;
  /** Names each layer, so the control list reads as more than "Layer 2". */
  describe?: (layer: AnalysisLayer, index: number) => string;
  /** Zoom to and outline one county, e.g. from a click in the results table. */
  focus?: { fips: string; nonce: number } | null;
}

/**
 * The focused county as its own outline, drawn above every values layer.
 * Independent of the hover highlight, which belongs to whichever layer is on
 * top and changes as layers are toggled.
 */
const FocusOutline: React.FC<{ counties: FeatureCollection | null; focus: Props['focus'] }> =
  ({ counties, focus }) => {
    const map = useMap();
    const feature = useMemo(() => (focus && counties
      ? counties.features.find(f => (f.properties as { GEOID?: string } | null)?.GEOID === focus.fips) ?? null
      : null), [counties, focus]);
    useEffect(() => {
      if (!feature) return;
      const b = L.geoJSON(feature as never).getBounds();
      if (b.isValid()) map.fitBounds(b, { maxZoom: 8, padding: [60, 60] });
    }, [feature, focus?.nonce, map]);
    if (!feature) return null;
    return (
      <GeoJSON key={`focus-${focus!.fips}-${focus!.nonce}`} data={feature as never} interactive={false}
               style={{ color: '#1a1a19', weight: 3, fill: false, opacity: 1 }} />
    );
  };

interface LayerState {
  visible: boolean;
  opacity: number;
  rampId: string;
}

/** Per-layer scale, bins and lookup. Recomputed only when its inputs change. */
function useLayerScale(layer: AnalysisLayer, ramp: Ramp, isDark: boolean) {
  return useMemo(() => {
    const rows = layer.rows ?? [];
    const byFips = new Map<string, AnalysisRow>();
    for (const r of rows) if (r.fips) byFips.set(String(r.fips).padStart(5, '0'), r);

    const values = rows
      .map(r => r.value)
      .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    const steps = isDark ? ramp.dark : ramp.light;
    const breaks = layer.diverging
      ? divergingBreaks(values, steps.length)
      : quantileBreaks(values, steps.length);

    // Same de-duplication rule as the single-layer map: a measure where most
    // counties share a value collapses several quantiles onto one number, and
    // the ramp is sampled down so the map still spans light to dark.
    const binCount = breaks.length + 1;
    const colors = binCount >= steps.length
      ? steps
      : Array.from({ length: binCount }, (_, i) =>
          steps[Math.round((i / Math.max(binCount - 1, 1)) * (steps.length - 1))]);

    return { byFips, breaks, colors };
  }, [layer, ramp, isDark]);
}

/** Frame the map once, on the union of every layer that has data. */
const FitToLayers: React.FC<{
  features: Feature<Geometry>[];
  signature: string;
}> = ({ features, signature }) => {
  const map = useMap();
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitted.current === signature || !features.length) return;
    // Same antimeridian exclusion as ChoroplethMap's FitToData: Aleutians West
    // would otherwise make every national view the whole globe.
    const fitTo = features.filter(f => {
      const b = L.geoJSON(f as never).getBounds();
      return !b.isValid() || b.getEast() - b.getWest() < 180;
    });
    const bounds = L.geoJSON({
      type: 'FeatureCollection', features: fitTo.length ? fitTo : features,
    } as never).getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [16, 16] });
      fitted.current = signature;
    }
  }, [features, signature, map]);
  return null;
};

/** One values layer, drawn and restyled in place. */
const ValuesLayer: React.FC<{
  layer: AnalysisLayer;
  counties: FeatureCollection;
  state: LayerState;
  ramp: Ramp;
  isDark: boolean;
  onHover: (e: LeafletMouseEvent) => void;
  onLeave: () => void;
  interactive: boolean;
}> = ({ layer, counties, state, ramp, isDark, onHover, onLeave, interactive }) => {
  const { byFips, breaks, colors } = useLayerScale(layer, ramp, isDark);
  const noData = isDark ? NO_DATA_DARK : NO_DATA_LIGHT;
  const ref = useRef<L.GeoJSON | null>(null);

  const colourFor = useCallback((v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return noData;
    let i = 0;
    while (i < breaks.length && v > breaks[i]) i++;
    return colors[Math.min(i, colors.length - 1)];
  }, [breaks, colors, noData]);

  const style = useCallback((feature?: Feature<Geometry>): PathOptions => {
    const geoid = (feature?.properties as { GEOID?: string })?.GEOID ?? '';
    const row = byFips.get(geoid);
    return {
      fillColor: colourFor(row?.value),
      weight: 0.4,
      color: isDark ? '#1a1a19' : '#fcfcfb',
      opacity: state.opacity,
      // A county this layer has no value for is left fully transparent rather
      // than painted grey: in a stack, "no data" must let the layer beneath
      // show through, or the top layer's gaps erase everything below them.
      fillOpacity: row ? state.opacity : 0,
      // Only the topmost layer answers the pointer. Without this every stacked
      // layer fires its own mouseover for the same county and the readout
      // flickers between them.
      interactive,
    };
  }, [byFips, colourFor, isDark, state.opacity, interactive]);

  useEffect(() => { ref.current?.setStyle(style as never); }, [style]);

  return (
    <GeoJSON
      // Opacity is deliberately NOT in the key; it is applied by setStyle.
      key={`${layer.id}-${breaks.join(',')}-${isDark}-${ramp.id}`}
      ref={ref as never}
      data={counties}
      style={style}
      eventHandlers={interactive ? { mouseover: onHover, mouseout: onLeave } : {}}
    />
  );
};

const LayeredMap: React.FC<Props> = ({ layers, intent, describe, focus = null }) => {
  const isDark = useIsDark();
  const [basemapId, setBasemapId] = useState(() => loadBasemapId('light'));
  const [counties, setCounties] = useState<FeatureCollection | null>(null);
  const [hovered, setHovered] = useState<{ fips: string; name: string } | null>(null);

  const [states, setStates] = useState<LayerState[]>(() =>
    layers.map((l, i) => ({
      // Everything visible by default: hiding a layer the analysis produced
      // would be deciding for the reader which half of the answer matters.
      visible: true,
      // The answer is solid; components underneath are translucent so the
      // stack is legible without touching a control first.
      opacity: i === 0 ? 0.85 : 0.55,
      rampId: rampsFor(l.diverging === true)[Math.min(i, 2)].id,
    })));

  // A new result can have a different number of layers.
  useEffect(() => {
    setStates(layers.map((l, i) => ({
      visible: true,
      opacity: i === 0 ? 0.85 : 0.55,
      rampId: rampsFor(l.diverging === true)[Math.min(i, 2)].id,
    })));
  }, [layers]);

  useEffect(() => {
    let cancelled = false;
    fetch('/counties.geojson')
      .then(r => r.json())
      .then((d: FeatureCollection) => { if (!cancelled) setCounties(d); })
      .catch(() => { /* the single-layer map reports this path */ });
    return () => { cancelled = true; };
  }, []);

  const valueLayers = layers.filter(l => l.mode === 'values');
  const topVisible = states.findIndex(s => s.visible);

  const withData = useMemo(() => {
    if (!counties) return [];
    const seen = new Set<string>();
    for (const l of valueLayers) {
      for (const r of l.rows ?? []) if (r.fips) seen.add(String(r.fips).padStart(5, '0'));
    }
    return counties.features.filter(f =>
      seen.has((f.properties as { GEOID?: string })?.GEOID ?? ''));
  }, [counties, valueLayers]);

  const fitSignature = useMemo(
    () => layers.map(l => `${l.id}:${l.row_count}`).join('|'), [layers]);

  const onHover = useCallback((e: LeafletMouseEvent) => {
    const layer = ((e as unknown as { propagatedFrom?: L.Path; layer?: L.Path })
      .propagatedFrom ?? (e as unknown as { layer?: L.Path }).layer) as L.Path | undefined;
    const feature = (layer as L.Path & { feature?: Feature<Geometry> })?.feature;
    const props = feature?.properties as { GEOID?: string; NAME?: string } | undefined;
    if (!props?.GEOID) return;
    setHovered({ fips: props.GEOID, name: props.NAME ?? 'Unknown' });
  }, []);

  const clearHover = useCallback(() => setHovered(null), []);

  const setLayer = (i: number, patch: Partial<LayerState>) =>
    setStates(prev => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  if (!counties) return <div className="h-[460px] bg-slate-100 rounded-lg animate-pulse" />;

  const basemap = basemapById(basemapId);
  const label = (l: AnalysisLayer, i: number) =>
    describe?.(l, i) ?? `${OP_LABEL[l.op] ?? l.op}${l.part ? ' (component)' : ''}`;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2.5">
        <LayersIcon className="w-4 h-4 text-slate-400" aria-hidden />
        <div className="flex rounded-lg border border-slate-300 overflow-hidden">
          {BASEMAPS.map(b => (
            <button
              key={b.id}
              type="button"
              onClick={() => { setBasemapId(b.id); saveBasemapId(b.id); }}
              aria-pressed={basemapId === b.id}
              className={`px-2.5 py-1 text-xs border-r border-slate-300 last:border-r-0 ${
                basemapId === b.id ? 'bg-blue-600 text-white'
                                   : 'bg-white text-slate-600 hover:bg-slate-50'}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* One row per layer. Drawn top-first, which is the order they stack. */}
      <div className="mb-3 space-y-1.5">
        {layers.map((l, i) => {
          const st = states[i];
          if (!st) return null;
          const choices = rampsFor(l.diverging === true);
          const ramp = choices.find(r => r.id === st.rampId) ?? choices[0];
          return (
            <div key={l.id}
                 className="flex items-center gap-2 text-xs bg-slate-50 border
                            border-slate-200 rounded-lg px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => setLayer(i, { visible: !st.visible })}
                title={st.visible ? 'Hide this layer' : 'Show this layer'}
                className="text-slate-500 hover:text-slate-800 shrink-0"
              >
                {st.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
              <span className={`flex-1 truncate ${
                st.visible ? 'text-slate-700' : 'text-slate-400'}`} title={label(l, i)}>
                {i === 0 && <span className="text-slate-400">top · </span>}
                {label(l, i)}
                <span className="text-slate-400"> · {l.row_count.toLocaleString()}</span>
              </span>

              <select
                value={st.rampId}
                onChange={e => setLayer(i, { rampId: e.target.value })}
                className="text-xs border border-slate-300 rounded px-1.5 py-0.5 bg-white"
              >
                {choices.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              <span className="flex rounded-sm overflow-hidden border border-slate-300 shrink-0">
                {(isDark ? ramp.dark : ramp.light).map((c, k) => (
                  <span key={k} className="w-2 h-3.5" style={{ backgroundColor: c }} />
                ))}
              </span>

              <input
                type="range" min={5} max={100} step={5}
                value={Math.round(st.opacity * 100)}
                onChange={e => setLayer(i, { opacity: Number(e.target.value) / 100 })}
                aria-label={`${label(l, i)} opacity`}
                className="w-20 accent-blue-600 cursor-pointer shrink-0"
              />
              <span className="w-8 text-right tabular-nums text-slate-500 shrink-0">
                {Math.round(st.opacity * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="relative h-[460px] rounded-lg overflow-hidden border border-slate-200"
           onMouseLeave={clearHover}>
        <MapContainer center={[39.5, -98.35]} zoom={4} scrollWheelZoom
                      style={{ height: '100%', width: '100%' }}>
          <BaseLayers basemap={basemap} />
          {/* Reversed: the last drawn is painted on top, and layers[0] is the
              answer. */}
          {layers.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => {
            const st = states[i];
            if (!st?.visible || l.mode !== 'values') return null;
            const choices = rampsFor(l.diverging === true);
            return (
              <ValuesLayer
                key={l.id}
                layer={l}
                counties={counties}
                state={st}
                ramp={choices.find(r => r.id === st.rampId) ?? choices[0]}
                isDark={isDark}
                onHover={onHover}
                onLeave={clearHover}
                interactive={i === topVisible}
              />
            );
          })}
          <FitToLayers features={withData} signature={fitSignature} />
          <FocusOutline counties={counties} focus={focus} />
        </MapContainer>

        {/* Every visible layer's value for the hovered county, so a stack can
            actually be compared rather than just looked at. */}
        {hovered && (
          <div className="absolute top-2.5 right-2.5 z-[500] pointer-events-none
                          bg-white/95 backdrop-blur-sm border border-slate-200
                          rounded-lg shadow-sm px-3 py-2 max-w-[17rem]">
            <p className="text-sm font-semibold text-slate-800 leading-tight">
              {hovered.name}
            </p>
            {layers.map((l, i) => {
              if (!states[i]?.visible || l.mode !== 'values') return null;
              const row = (l.rows ?? []).find(
                r => String(r.fips).padStart(5, '0') === hovered.fips);
              return (
                <p key={l.id} className="mt-1 text-xs leading-tight">
                  <span className="text-slate-500">{label(l, i)}</span><br />
                  <span className="tabular-nums text-slate-900 font-medium">
                    {row?.value === null || row?.value === undefined
                      ? 'no data' : fmt(row.value)}
                  </span>
                </p>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-xs font-medium text-slate-600 mt-3">{intent}</p>
    </div>
  );
};

export default LayeredMap;
