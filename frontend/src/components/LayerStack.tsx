import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import type { LeafletMouseEvent, PathOptions } from 'leaflet';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import {
  ChevronDown, ChevronUp, Eye, EyeOff, GripVertical, Layers as LayersIcon, MapPin,
  Plus, SlidersHorizontal, X, ArrowUp, ArrowDown,
} from 'lucide-react';
import 'leaflet/dist/leaflet.css';
import type { AnalysisRow } from '../types';
import { BaseLayers, BasemapPicker, StageZoom, fitOptions, type FitPadding } from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId, rampsFor, type Ramp } from '../lib/basemaps';
import { divergingBreaks, fmt, NO_DATA_LIGHT, NO_DATA_DARK } from './ChoroplethMap';
import {
  CLASSIFICATIONS, classBreaks, loadClassification, type Classification,
} from '../lib/classify';
import type { StackLayer } from '../lib/layers';
import { useIsDark } from '../hooks/useIsDark';

/**
 * Several geospatial layers stacked on the stage map, each styled on its own.
 *
 * What a reader comparing layers needs, and what this gives each one:
 *   - visibility, and OPACITY, because two county fills cover the same
 *     polygons and without transparency the top one simply hides the rest;
 *   - its own colour ramp (fills) or colour (points and lines), so layers can
 *     be told apart;
 *   - its own CLASSIFICATION (natural breaks / quantile / equal interval) and a
 *     legend, because one layer's bins say nothing about another's;
 *   - ORDER: which layer is on top, by drag or the arrows.
 *
 * Order is implemented with one Leaflet pane per layer and the pane's z-index,
 * so reordering is a style change and never rebuilds thousands of polygons.
 * A county a fill layer has no value for is transparent, not grey: in a stack,
 * "no data" must let the layer beneath show through.
 *
 * The hover readout lists every visible fill layer's value for the county under
 * the pointer, so the stack can be compared rather than only looked at.
 */

interface Props {
  layers: StackLayer[];
  /** The analysis the map is answering, for the panel's subtitle. */
  intent: string;
  focus?: { fips: string; nonce: number } | null;
  fitPadding?: FitPadding;
  /** Opens the "add a layer" menu. */
  onAdd?: () => void;
  onRemove?: (key: string) => void;
  /** Rendered under the panel: the add-layer menu when it is open. */
  addMenu?: React.ReactNode;
}

interface LayerStyle {
  visible: boolean;
  opacity: number;
  rampId: string;
  method: Classification;
  /** Points and lines. */
  color: string;
}

/** Distinct from every sequential ramp, and from each other. */
const FEATURE_COLORS = ['#c2410c', '#7c3aed', '#0f766e', '#be123c', '#1d4ed8', '#a16207'];

const pad = (f: string) => String(f).padStart(5, '0');

/** Breaks and colours for one fill layer. */
function scaleFor(layer: StackLayer, style: LayerStyle, ramp: Ramp, isDark: boolean) {
  const key = layer.valueKey ?? 'value';
  const rows = layer.rows ?? [];
  const byFips = new Map<string, number | null>();
  const values: number[] = [];
  for (const r of rows) {
    if (!r.fips) continue;
    const v = r[key] as number | null | undefined;
    byFips.set(pad(r.fips), v ?? null);
    if (v !== null && v !== undefined && Number.isFinite(v)) values.push(v);
  }
  const steps = isDark ? ramp.dark : ramp.light;
  const breaks = layer.diverging
    ? divergingBreaks(values, steps.length)
    : classBreaks(values, steps.length, style.method);
  // Fewer distinct breaks than steps (many identical values): sample the ramp
  // so the map still spans light to dark.
  const n = breaks.length + 1;
  const colors = n >= steps.length ? steps
    : Array.from({ length: n }, (_, i) => steps[Math.round((i / Math.max(n - 1, 1)) * (steps.length - 1))]);
  return { byFips, breaks, colors };
}

const colourOf = (v: number, breaks: number[], colors: string[]) => {
  let i = 0;
  while (i < breaks.length && v > breaks[i]) i++;
  return colors[Math.min(i, colors.length - 1)];
};

/** Panes, one per layer, with z-index from the stack order (top = highest). */
const Panes: React.FC<{ order: string[] }> = ({ order }) => {
  const map = useMap();
  useEffect(() => {
    order.forEach((key, i) => {
      const name = paneName(key);
      const pane = map.getPane(name) ?? map.createPane(name);
      // Leaflet's overlay pane is 400 and markers 600; stack between them.
      pane.style.zIndex = String(410 + (order.length - i) * 2);
    });
  }, [map, order]);
  return null;
};
const paneName = (key: string) => `stack-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const FillLayer: React.FC<{
  layer: StackLayer; counties: FeatureCollection; style: LayerStyle; ramp: Ramp; isDark: boolean;
  interactive: boolean; onHover: (e: LeafletMouseEvent) => void; onLeave: () => void;
}> = ({ layer, counties, style, ramp, isDark, interactive, onHover, onLeave }) => {
  const { byFips, breaks, colors } = useMemo(
    () => scaleFor(layer, style, ramp, isDark),
    // style.opacity and style.visible deliberately excluded: neither changes
    // the scale, and recomputing natural breaks on an opacity drag is waste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layer, style.method, ramp, isDark]);
  const ref = useRef<L.GeoJSON | null>(null);
  const pathStyle = useCallback((f?: Feature<Geometry>): PathOptions => {
    const v = byFips.get((f?.properties as { GEOID?: string })?.GEOID ?? '');
    const has = v !== null && v !== undefined && Number.isFinite(v);
    return {
      fillColor: has ? colourOf(v as number, breaks, colors) : (isDark ? NO_DATA_DARK : NO_DATA_LIGHT),
      fillOpacity: has ? style.opacity : 0,
      weight: has ? 0.4 : 0,
      color: isDark ? '#1a1a19' : '#fcfcfb',
      opacity: has ? Math.min(style.opacity, 0.8) : 0,
      interactive,
    };
  }, [byFips, breaks, colors, isDark, style.opacity, interactive]);
  useEffect(() => { ref.current?.setStyle(pathStyle as never); }, [pathStyle]);
  return (
    <GeoJSON
      key={`${layer.key}-${breaks.join(',')}-${ramp.id}-${isDark}-${interactive}`}
      ref={ref as never}
      data={counties}
      style={pathStyle}
      pane={paneName(layer.key)}
      eventHandlers={interactive ? { mouseover: onHover, mouseout: onLeave } : {}}
    />
  );
};

const FeatureLayer: React.FC<{
  layer: StackLayer; style: LayerStyle; onFeature: (props: Record<string, string | null> | null) => void;
}> = ({ layer, style, onFeature }) => {
  const data = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: (layer.features ?? []).map(f => ({ type: 'Feature' as const, geometry: f.geometry, properties: f.properties })),
  }), [layer.features]);
  const ref = useRef<L.GeoJSON | null>(null);
  const pane = paneName(layer.key);
  const pathStyle = useCallback((): PathOptions => ({
    color: style.color, weight: 2, opacity: style.opacity,
    fillColor: style.color, fillOpacity: style.opacity * 0.35,
  }), [style.color, style.opacity]);
  useEffect(() => {
    ref.current?.eachLayer(l => {
      if (l instanceof L.CircleMarker) {
        l.setStyle({ fillColor: style.color, color: '#ffffff', fillOpacity: style.opacity, opacity: style.opacity });
      } else if (l instanceof L.Path) {
        l.setStyle(pathStyle());
      }
    });
  }, [style.color, style.opacity, pathStyle]);
  return (
    <GeoJSON
      key={layer.key}
      ref={ref as never}
      data={data as never}
      pane={pane}
      style={pathStyle}
      pointToLayer={(_f, latlng) => L.circleMarker(latlng, {
        pane, radius: 4.5, weight: 1.2, color: '#ffffff',
        fillColor: style.color, fillOpacity: style.opacity, opacity: style.opacity,
      })}
      eventHandlers={{
        mouseover: (e: LeafletMouseEvent) => {
          const props = ((e as unknown as { propagatedFrom?: { feature?: Feature } }).propagatedFrom?.feature
            ?.properties ?? null) as Record<string, string | null> | null;
          onFeature(props);
        },
        mouseout: () => onFeature(null),
      }}
    />
  );
};

/** Frame the map once per answer, on everything the answer's layers cover. */
const FitOnce: React.FC<{ bounds: L.LatLngBounds | null; signature: string; padding?: FitPadding }> =
  ({ bounds, signature, padding }) => {
    const map = useMap();
    const done = useRef<string | null>(null);
    useEffect(() => {
      if (!bounds || !bounds.isValid() || done.current === signature) return;
      map.fitBounds(bounds, fitOptions(padding, 16));
      done.current = signature;
    }, [bounds, signature, padding, map]);
    return null;
  };

const FocusOutline: React.FC<{ counties: FeatureCollection; focus: Props['focus']; padding?: FitPadding }> =
  ({ counties, focus, padding }) => {
    const map = useMap();
    const feature = useMemo(() => (focus
      ? counties.features.find(f => (f.properties as { GEOID?: string } | null)?.GEOID === focus.fips) ?? null
      : null), [counties, focus]);
    useEffect(() => {
      if (!feature) return;
      const b = L.geoJSON(feature as never).getBounds();
      if (b.isValid()) map.fitBounds(b, { maxZoom: 8, ...fitOptions(padding, 60) });
    }, [feature, focus?.nonce, map, padding]);
    if (!feature) return null;
    return <GeoJSON key={`focus-${focus!.fips}-${focus!.nonce}`} data={feature as never} interactive={false}
                    style={{ color: '#1a1a19', weight: 3, fill: false, opacity: 1 }} />;
  };

const LayerStack: React.FC<Props> = ({ layers, intent, focus = null, fitPadding, onAdd, onRemove, addMenu }) => {
  const isDark = useIsDark();
  const mapRef = useRef<L.Map | null>(null);
  const [refit, setRefit] = useState(0);
  const [basemapId, setBasemapId] = useState(() => loadBasemapId('light'));
  const [counties, setCounties] = useState<FeatureCollection | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hoverCounty, setHoverCounty] = useState<{ fips: string; name: string } | null>(null);
  const [hoverFeature, setHoverFeature] = useState<Record<string, string | null> | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  // The card is draggable only while its grip is held, so the opacity slider
  // (and the selects) inside it keep their own drags.
  const [armedKey, setArmedKey] = useState<string | null>(null);

  // Stack order (top first) and per-layer style, keyed by layer key so they
  // survive the list changing. A layer that arrives later goes on TOP: it is
  // the one the reader just asked for.
  const [order, setOrder] = useState<string[]>(() => layers.map(l => l.key));
  const [styles, setStyles] = useState<Record<string, LayerStyle>>({});
  useEffect(() => {
    const keys = layers.map(l => l.key);
    setOrder(prev => {
      const kept = prev.filter(k => keys.includes(k));
      const fresh = keys.filter(k => !prev.includes(k));
      return [...fresh, ...kept];
    });
    setStyles(prev => {
      const next: Record<string, LayerStyle> = {};
      // A new layer takes the first colour (points) or ramp (fills) NOT already
      // in use, so two layers never arrive looking the same. Existing layers
      // keep theirs: restyling what the reader already set would be rude.
      const kept = layers.filter(l => prev[l.key]);
      const usedColors = new Set(kept.filter(l => l.mode === 'features').map(l => prev[l.key].color));
      const usedRamps = new Set(kept.filter(l => l.mode === 'values').map(l => prev[l.key].rampId));
      let fills = kept.filter(l => l.mode === 'values').length;
      layers.forEach((l, i) => {
        if (prev[l.key]) { next[l.key] = prev[l.key]; return; }
        const ramps = rampsFor(l.diverging === true);
        const ramp = ramps.find(r => !usedRamps.has(r.id)) ?? ramps[fills % ramps.length];
        const color = FEATURE_COLORS.find(c => !usedColors.has(c)) ?? FEATURE_COLORS[usedColors.size % FEATURE_COLORS.length];
        if (l.mode === 'values') { usedRamps.add(ramp.id); fills++; } else { usedColors.add(color); }
        next[l.key] = {
          visible: true,
          // The top fill is near-solid; fills underneath are translucent so the
          // stack reads without touching a control first.
          opacity: l.mode === 'features' ? 0.9 : i === 0 || fills === 1 ? 0.8 : 0.55,
          rampId: ramp.id,
          method: loadClassification(),
          color,
        };
      });
      return next;
    });
  }, [layers]);

  useEffect(() => {
    let cancelled = false;
    fetch('/counties.geojson').then(r => r.json())
      .then((d: FeatureCollection) => { if (!cancelled) setCounties(d); })
      .catch(() => { /* the single-layer map reports this path */ });
    return () => { cancelled = true; };
  }, []);

  const byKey = useMemo(() => new Map(layers.map(l => [l.key, l])), [layers]);
  const ordered = order.map(k => byKey.get(k)).filter((l): l is StackLayer => !!l);
  const topFill = ordered.find(l => l.mode === 'values' && styles[l.key]?.visible)?.key ?? null;

  // The answer's own layers decide the framing; added layers do not refit,
  // because yanking the view when a layer is added loses where the reader was.
  const answerKeys = layers.filter(l => !l.removable).map(l => l.key).join('|');
  const bounds = useMemo(() => {
    if (!counties) return null;
    const b = L.latLngBounds([]);
    const seen = new Set<string>();
    for (const l of layers.filter(x => !x.removable)) {
      if (l.mode === 'values') {
        for (const r of l.rows ?? []) if (r.fips) seen.add(pad(r.fips));
      } else {
        for (const f of l.features ?? []) {
          const fb = L.geoJSON(f.geometry as never).getBounds();
          if (fb.isValid()) b.extend(fb);
        }
      }
    }
    for (const f of counties.features) {
      if (!seen.has((f.properties as { GEOID?: string })?.GEOID ?? '')) continue;
      const fb = L.geoJSON(f as never).getBounds();
      // Aleutians West crosses the antimeridian and would make every national
      // view the whole globe; see ChoroplethMap's FitToData.
      if (fb.isValid() && fb.getEast() - fb.getWest() < 180) b.extend(fb);
    }
    return b.isValid() ? b : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counties, answerKeys]);

  const setStyle = (key: string, patch: Partial<LayerStyle>) =>
    setStyles(s => ({ ...s, [key]: { ...s[key], ...patch } }));
  const move = (key: string, delta: number) => setOrder(o => {
    const i = o.indexOf(key), j = i + delta;
    if (i < 0 || j < 0 || j >= o.length) return o;
    const n = [...o]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const dropOn = (target: string) => {
    if (!dragKey || dragKey === target) return;
    setOrder(o => {
      const n = o.filter(k => k !== dragKey);
      n.splice(n.indexOf(target), 0, dragKey);
      return n;
    });
  };

  const onHover = useCallback((e: LeafletMouseEvent) => {
    const layer = ((e as unknown as { propagatedFrom?: L.Path }).propagatedFrom
      ?? (e as unknown as { layer?: L.Path }).layer) as (L.Path & { feature?: Feature }) | undefined;
    const p = layer?.feature?.properties as { GEOID?: string; NAME?: string } | undefined;
    if (p?.GEOID) setHoverCounty({ fips: p.GEOID, name: p.NAME ?? 'Unknown' });
  }, []);
  const clearHover = useCallback(() => setHoverCounty(null), []);

  if (!counties) return <div className="absolute inset-0 bg-[#e7e5df]" />;
  const basemap = basemapById(basemapId);

  const readout = (hoverCounty || hoverFeature) && (
    <div className="pointer-events-none glass glass-raised rounded-xl px-3 py-2 max-w-[18rem]">
      {hoverFeature ? (
        <>
          <p className="text-sm font-semibold text-slate-800 leading-tight">
            {hoverFeature.name ?? hoverFeature.NAME ?? 'Location'}
          </p>
          {Object.entries(hoverFeature).filter(([k, v]) => v && !/^name$/i.test(k)).slice(0, 4).map(([k, v]) => (
            <p key={k} className="text-xs text-slate-600 leading-tight mt-0.5">{k}: {v}</p>
          ))}
        </>
      ) : hoverCounty && (
        <>
          <p className="text-sm font-semibold text-slate-800 leading-tight">{hoverCounty.name}</p>
          {ordered.filter(l => l.mode === 'values' && styles[l.key]?.visible).map(l => {
            const row = (l.rows ?? []).find(r => pad(r.fips) === hoverCounty.fips) as AnalysisRow | undefined;
            const v = row ? (row[l.valueKey ?? 'value'] as number | null | undefined) : null;
            return (
              <p key={l.key} className="mt-1 text-xs leading-tight">
                <span className="text-slate-500">{l.label}</span><br />
                <span className="tabular-nums text-slate-900 font-medium">
                  {v === null || v === undefined ? 'no data' : fmt(v)}
                </span>
              </p>
            );
          })}
        </>
      )}
    </div>
  );

  return (
    <div className="absolute inset-0" onMouseLeave={() => { clearHover(); setHoverFeature(null); }}>
      <MapContainer ref={mapRef} center={[39.5, -98.35]} zoom={4} scrollWheelZoom zoomControl={false}
                    style={{ height: '100%', width: '100%' }}>
        <BaseLayers basemap={basemap} />
        <Panes order={order} />
        {ordered.map(l => {
          const st = styles[l.key];
          if (!st?.visible) return null;
          if (l.mode === 'features') {
            return <FeatureLayer key={l.key} layer={l} style={st} onFeature={setHoverFeature} />;
          }
          const ramps = rampsFor(l.diverging === true);
          return (
            <FillLayer key={l.key} layer={l} counties={counties} style={st}
                       ramp={ramps.find(r => r.id === st.rampId) ?? ramps[0]} isDark={isDark}
                       interactive={l.key === topFill} onHover={onHover} onLeave={clearHover} />
          );
        })}
        <FitOnce bounds={bounds} signature={`${answerKeys}:${refit}`} padding={fitPadding} />
        <FocusOutline counties={counties} focus={focus} padding={fitPadding} />
      </MapContainer>

      <div className="absolute right-3 z-[600] flex flex-col items-end gap-2 pointer-events-none
                      w-[min(25rem,calc(100vw-1.5rem))]"
           style={{ top: 'var(--header-offset)', maxHeight: 'calc(100% - var(--header-offset) - var(--stage-bottom-inset, 0px) - 1rem)' }}>
        <section className="pointer-events-auto glass glass-raisable glass-floor rounded-2xl w-full flex flex-col min-h-0">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200/80">
            <LayersIcon className="w-4 h-4 text-slate-500" />
            <div className="min-w-0 mr-auto">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                Layers · {ordered.length}
              </p>
              <p className="text-xs text-slate-600 truncate" title={intent}>{intent}</p>
            </div>
            {onAdd && (
              <button type="button" onClick={onAdd}
                      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                                 bg-ink text-white hover:bg-brand-700 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add layer
              </button>
            )}
            <button type="button" onClick={() => setPanelOpen(o => !o)} aria-expanded={panelOpen}
                    title={panelOpen ? 'Collapse the layer list' : 'Show the layer list'}
                    className="p-1 rounded-md text-slate-500 hover:text-ink hover:bg-white/70">
              {panelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {panelOpen && (
            <div className="overflow-y-auto overscroll-contain min-h-0 p-2 space-y-1.5">
              <p className="px-1 text-[10px] uppercase tracking-[0.12em] text-slate-400">Top of the map</p>
              {ordered.map((l, i) => {
                const st = styles[l.key];
                if (!st) return null;
                const ramps = rampsFor(l.diverging === true);
                const ramp = ramps.find(r => r.id === st.rampId) ?? ramps[0];
                const swatch = isDark ? ramp.dark : ramp.light;
                const open = expanded === l.key;
                return (
                  <div key={l.key}
                       draggable={armedKey === l.key}
                       onDragStart={() => setDragKey(l.key)}
                       onDragEnd={() => { setDragKey(null); setArmedKey(null); }}
                       onDragOver={e => e.preventDefault()}
                       onDrop={() => dropOn(l.key)}
                       className={`rounded-xl border bg-white/80 transition-colors
                         ${dragKey === l.key ? 'opacity-50' : ''}
                         ${dragKey && dragKey !== l.key ? 'border-dashed border-brand-400' : 'border-slate-200'}`}>
                    <div className="flex items-center gap-1.5 px-2 py-1.5">
                      <span onPointerDown={() => setArmedKey(l.key)}
                            onPointerUp={() => setArmedKey(null)}
                            title="Drag to reorder"
                            className="shrink-0 cursor-grab touch-none">
                        <GripVertical className="w-3.5 h-3.5 text-slate-300 hover:text-slate-500" aria-hidden />
                      </span>
                      <button type="button" onClick={() => setStyle(l.key, { visible: !st.visible })}
                              title={st.visible ? 'Hide this layer' : 'Show this layer'}
                              className="text-slate-500 hover:text-ink shrink-0">
                        {st.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                      {l.mode === 'features' ? (
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm shrink-0"
                              style={{ backgroundColor: st.color }} aria-hidden />
                      ) : (
                        <span className="flex rounded-sm overflow-hidden border border-slate-300 shrink-0" aria-hidden>
                          {swatch.slice(0, 5).map((c, k) => <span key={k} className="w-1.5 h-3.5" style={{ backgroundColor: c }} />)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs font-medium truncate ${st.visible ? 'text-ink' : 'text-slate-400'}`}
                              title={l.label}>{l.label}</span>
                        <span className="block text-[10px] text-slate-500 truncate">
                          {l.source} · {l.mode === 'features'
                            ? `${(l.features?.length ?? 0).toLocaleString()} locations`
                            : `${(l.rows?.length ?? 0).toLocaleString()} counties`}
                        </span>
                      </span>
                      <span className="flex flex-col shrink-0">
                        <button type="button" onClick={() => move(l.key, -1)} disabled={i === 0}
                                title="Move up (draw above)" className="text-slate-400 hover:text-ink disabled:opacity-25">
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button type="button" onClick={() => move(l.key, 1)} disabled={i === ordered.length - 1}
                                title="Move down (draw below)" className="text-slate-400 hover:text-ink disabled:opacity-25">
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </span>
                      <button type="button" onClick={() => setExpanded(open ? null : l.key)} aria-expanded={open}
                              title="Style and legend"
                              className={`p-1 rounded-md shrink-0 ${open ? 'bg-ink text-white' : 'text-slate-500 hover:text-ink hover:bg-slate-100'}`}>
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                      </button>
                      {l.removable && onRemove && (
                        <button type="button" onClick={() => onRemove(l.key)} title="Remove this layer"
                                className="p-1 rounded-md text-slate-400 hover:text-red-700 shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-2 px-2 pb-1.5 pl-[2.6rem]">
                      <input type="range" min={5} max={100} step={5} value={Math.round(st.opacity * 100)}
                             onChange={e => setStyle(l.key, { opacity: Number(e.target.value) / 100 })}
                             aria-label={`${l.label} opacity`} className="flex-1 accent-brand-600 cursor-pointer h-1" />
                      <span className="w-8 text-right text-[11px] tabular-nums text-slate-500">
                        {Math.round(st.opacity * 100)}%
                      </span>
                    </div>

                    {open && (
                      <div className="border-t border-slate-200 px-2.5 py-2 space-y-2">
                        {l.mode === 'features' ? (
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-slate-500 w-16">Colour</span>
                            {FEATURE_COLORS.map(c => (
                              <button key={c} type="button" onClick={() => setStyle(l.key, { color: c })}
                                      aria-label={`Colour ${c}`} aria-pressed={st.color === c}
                                      className={`w-5 h-5 rounded-full border-2 ${st.color === c ? 'border-ink' : 'border-white shadow-sm'}`}
                                      style={{ backgroundColor: c }} />
                            ))}
                          </div>
                        ) : (
                          <>
                            <label className="flex items-center gap-2 text-[11px] text-slate-500">
                              <span className="w-16">Colours</span>
                              <select value={st.rampId} onChange={e => setStyle(l.key, { rampId: e.target.value })}
                                      className="flex-1 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-700">
                                {ramps.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                              </select>
                            </label>
                            {!l.diverging && (
                              <label className="flex items-center gap-2 text-[11px] text-slate-500"
                                     title={CLASSIFICATIONS.find(c => c.id === st.method)?.hint}>
                                <span className="w-16">Classes</span>
                                <select value={st.method}
                                        onChange={e => setStyle(l.key, { method: e.target.value as Classification })}
                                        className="flex-1 text-xs border border-slate-300 rounded-md px-1.5 py-0.5 bg-white text-slate-700">
                                  {CLASSIFICATIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                                </select>
                              </label>
                            )}
                            <Legend layer={l} style={st} ramp={ramp} isDark={isDark} />
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="px-1 text-[10px] uppercase tracking-[0.12em] text-slate-400">Bottom</p>
            </div>
          )}

          <div className="border-t border-slate-200/80 px-3 py-1.5">
            <BasemapPicker basemapId={basemapId} onBasemap={id => { setBasemapId(id); saveBasemapId(id); }} />
          </div>
        </section>
        {addMenu}
        <StageZoom mapRef={mapRef} onReset={() => setRefit(n => n + 1)} />
        {readout}
      </div>
    </div>
  );
};

/** The class legend for one fill layer, in its own breaks and colours. */
const Legend: React.FC<{ layer: StackLayer; style: LayerStyle; ramp: Ramp; isDark: boolean }> =
  ({ layer, style, ramp, isDark }) => {
    const { breaks, colors } = useMemo(() => scaleFor(layer, style, ramp, isDark),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [layer, style.method, ramp, isDark]);
    const bins = colors.map((c, i) => {
      const lo = breaks[i - 1], hi = breaks[i];
      return {
        c,
        label: lo === undefined && hi === undefined ? 'all values'
          : lo === undefined ? `≤ ${fmt(hi as number)}` : hi === undefined ? `> ${fmt(lo)}` : `${fmt(lo)} – ${fmt(hi)}`,
      };
    });
    return (
      <div>
        {layer.valueLabel && <p className="text-[11px] text-slate-500 mb-1">{layer.valueLabel}</p>}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {bins.map(b => (
            <span key={b.label} className="inline-flex items-center gap-1.5 text-[11px] text-slate-700 tabular-nums">
              <span className="w-3 h-3 rounded-sm border border-slate-300" style={{ backgroundColor: b.c }} />
              {b.label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
            <MapPin className="w-3 h-3" /> no value: transparent
          </span>
        </div>
      </div>
    );
  };

export default LayerStack;
