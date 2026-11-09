import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, useMap, useMapEvents } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Loader2, Layers as LayersIcon, Info } from 'lucide-react';
import { BaseLayers, BasemapPicker, StageZoom } from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId, rampsFor, loadRampId } from '../lib/basemaps';
import { NO_DATA_LIGHT, NO_DATA_DARK, fmt } from './ChoroplethMap';
import { useIsDark } from '../hooks/useIsDark';
import {
  fetchGeoCatalog, fetchGeoLayer, binOf, unitLabel,
  type GeoCatalog, type GeoMeasure, type GeoLayerResponse, type UnitProps,
} from '../lib/geoLayers';

/**
 * Any loaded measure, at whatever geographic level fits the screen.
 *
 * The server picks the level (backend/geo_layers.js): the finest one whose unit
 * count in the current view fits a drawing budget. Zoom out and tracts give way
 * to counties; zoom into a city and 4 km grid cells give way to the raster's
 * own 1 km pixels. The colour breaks come from the server too, computed once
 * over the whole country for that measure and level, so a unit keeps its colour
 * while you pan past it.
 *
 * Two families. "Areas" are administrative units (counties, tracts, ZIP code
 * areas); "Grid" is a raster's own cells (64/16/4 km, then 1 km pixels). A
 * raster measure that has also been summarised to areas can be viewed either
 * way, and the switch is explicit because they answer different questions:
 * the grid shows where the people are, the areas show how a unit compares.
 *
 * Drawn on a canvas renderer: thousands of SVG paths make every pan stutter.
 */

const CONUS: L.LatLngBoundsExpression = [[24.5, -125], [49.5, -66.9]];
const PANEL_W = 360;

type Family = 'admin' | 'grid';

interface Hover { props: UnitProps; levelLabel: string }

/** Fetches the layer for the current view whenever it settles, newest wins. */
const ViewWatcher: React.FC<{ onView: (b: L.LatLngBounds, z: number) => void }> = ({ onView }) => {
  const map = useMap();
  const timer = useRef<number | null>(null);
  const fire = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onView(map.getBounds(), map.getZoom()), 180);
  }, [map, onView]);
  useMapEvents({ moveend: fire, zoomend: fire });
  useEffect(() => { fire(); }, [fire]);
  return null;
};

/** "lat,lng,zoom" from the URL, so a view can be linked to. */
function parseAt(s: string | null): [number, number, number] | null {
  const p = (s || '').split(',').map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

const InitialView: React.FC<{ at: [number, number, number] | null }> = ({ at }) => {
  const map = useMap();
  useEffect(() => {
    // The container gets its size after Leaflet first measures it; fitting a
    // zero-size map yields a degenerate view (and a bbox the API rejects).
    const id = window.requestAnimationFrame(() => {
      map.invalidateSize();
      // A linked view is already the map's initial centre and zoom (props on
      // MapContainer, so no effect can race it); only the default view is fitted.
      if (!at) map.fitBounds(CONUS, { paddingTopLeft: [PANEL_W + 24, 90], paddingBottomRight: [24, 24] });
    });
    return () => window.cancelAnimationFrame(id);
    // Only the first view comes from the URL; after that the URL follows the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  return null;
};

/** The units, on canvas, restyled in place when only the colours change. */
const UnitLayer: React.FC<{
  data: GeoLayerResponse | null;
  colors: string[];
  noData: string;
  opacity: number;
  onHover: (h: Hover | null) => void;
}> = ({ data, colors, noData, opacity, onHover }) => {
  const map = useMap();
  const renderer = useMemo(() => L.canvas({ padding: 0.3, tolerance: 2 }), []);
  const layerRef = useRef<L.GeoJSON | null>(null);

  const styleFor = useCallback((p: UnitProps | undefined): L.PathOptions => {
    const v = p?.shown;
    const fill = v === null || v === undefined || !data ? noData : colors[binOf(v, data.bins.breaks)];
    const grid = data?.level.startsWith('grid') || data?.level === 'pixel';
    if (p?.derived && v !== null && v !== undefined) {
      // An estimate is drawn with a dashed edge, so it never passes for a
      // stored value; the readout says what it was built from.
      return { fillColor: fill, fillOpacity: opacity, color: '#333', weight: 1.2, dashArray: '4 3' };
    }
    return {
      fillColor: fill, fillOpacity: opacity,
      // Grid cells abut exactly; an outline on each turns the map into a mesh.
      color: grid ? fill : 'rgba(30,30,30,0.35)', weight: grid ? 0 : 0.4, dashArray: undefined,
    };
  }, [colors, noData, opacity, data]);

  useEffect(() => {
    if (!data || data.too_many) {
      layerRef.current?.remove();
      layerRef.current = null;
      return;
    }
    // `renderer` is passed through to each path; Leaflet's types omit it here.
    const layer = L.geoJSON(data.features as never, {
      renderer,
      style: f => styleFor((f?.properties ?? undefined) as UnitProps | undefined),
      onEachFeature: (f, l) => {
        l.on('mouseover', () => {
          (l as L.Path).setStyle({ weight: 2, color: '#111' });
          (l as L.Path).bringToFront();
          onHover({ props: f.properties as UnitProps, levelLabel: data.level_label });
        });
        l.on('mouseout', () => {
          (l as L.Path).setStyle(styleFor(f.properties as UnitProps));
          onHover(null);
        });
      },
    } as L.GeoJSONOptions);
    layer.addTo(map);
    // Swap only once the new layer is on the map, so a pan never flashes empty.
    const old = layerRef.current;
    layerRef.current = layer;
    old?.remove();
    return undefined;
    // styleFor is applied by the restyle effect below; rebuilding on it would
    // re-create thousands of paths for an opacity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, map, renderer, onHover]);

  useEffect(() => {
    layerRef.current?.setStyle(f => styleFor((f?.properties ?? undefined) as UnitProps | undefined));
  }, [styleFor]);

  useEffect(() => () => { layerRef.current?.remove(); }, []);
  return null;
};

const Legend: React.FC<{ data: GeoLayerResponse; colors: string[] }> = ({ data, colors }) => {
  const { breaks, min, max } = data.bins;
  const edges = [min, ...breaks, max];
  const unit = unitLabel(data.units, data.per);
  return (
    <div>
      <div className="flex h-3 rounded overflow-hidden">
        {colors.slice(0, breaks.length + 1).map((c, i) => (
          <div key={i} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-slate-600 mt-1 tabular-nums">
        {edges.map((e, i) => <span key={i}>{fmt(e)}</span>)}
      </div>
      {unit && <div className="text-[11px] text-slate-500 mt-0.5">{unit}</div>}
      <div className="text-[11px] text-slate-500 mt-1">
        Breaks at the {(data.bins.quantiles ?? []).map(q => Math.round(q * 100)).join(', ')}th
        percentiles of every {data.level_label.toLowerCase().replace(/s$/, '')} in the
        country{data.per === 'km2' ? ' (weighted to the tail: densities are skewed)' : ''}, so
        colours hold steady as you pan.
      </div>
    </div>
  );
};

const ExplorePage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const isDark = useIsDark();
  const mapRef = useRef<L.Map | null>(null);

  const [catalog, setCatalog] = useState<GeoCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [data, setData] = useState<GeoLayerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [opacity, setOpacity] = useState(0.78);
  const [basemapId, setBasemapId] = useState(() => loadBasemapId('light'));
  const view = useRef<{ bounds: L.LatLngBounds; z: number } | null>(null);
  const initialAt = useRef(parseAt(params.get('at')));
  const abort = useRef<AbortController | null>(null);

  const code = params.get('code');
  const level = params.get('level') || 'auto';
  const familyParam = params.get('family') as Family | null;
  const perParam = params.get('per') as 'km2' | 'none' | null;

  useEffect(() => {
    const ac = new AbortController();
    fetchGeoCatalog(ac.signal).then(setCatalog).catch(e => {
      if (e.name !== 'AbortError') setCatalogError(String(e.message || e));
    });
    return () => ac.abort();
  }, []);

  const measure: GeoMeasure | null = useMemo(() => {
    if (!catalog) return null;
    return catalog.measures.find(m => m.code === code)
      ?? catalog.measures.find(m => m.code === 'WORLDPOP_POP')
      ?? catalog.measures[0] ?? null;
  }, [catalog, code]);

  const families = useMemo(() => new Set(measure?.levels.map(l => l.family) ?? []), [measure]);
  const family: Family = familyParam && families.has(familyParam)
    ? familyParam : (measure?.raster ? 'grid' : 'admin');

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k); else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const load = useCallback(() => {
    if (!measure || !view.current) return;
    const b = view.current.bounds;
    // A map not yet laid out reports a zero-area view; nothing to ask for.
    if (!(b.getEast() > b.getWest()) || !(b.getNorth() > b.getSouth())) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setLoading(true);
    fetchGeoLayer({
      code: measure.code,
      bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
      z: view.current.z,
      level,
      family,
      per: perParam ?? undefined,
    }, ac.signal).then(r => { setData(r); setError(null); })
      .catch(e => { if (e.name !== 'AbortError') setError(String(e.message || e)); })
      .finally(() => { if (abort.current === ac) setLoading(false); });
  }, [measure, level, family, perParam]);

  const onView = useCallback((bounds: L.LatLngBounds, z: number) => {
    view.current = { bounds, z };
    load();
    const c = bounds.getCenter();
    setParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('at', `${c.lat.toFixed(4)},${c.lng.toFixed(4)},${z}`);
      return next;
    }, { replace: true });
  }, [load, setParams]);

  // A new measure, level, family or unit re-asks for the same view.
  useEffect(() => { load(); }, [load]);

  const ramp = useMemo(() => {
    const ramps = rampsFor(false);
    return ramps.find(r => r.id === loadRampId(false)) ?? ramps[0];
  }, []);
  const colors = isDark ? ramp.dark : ramp.light;
  const noData = isDark ? NO_DATA_DARK : NO_DATA_LIGHT;
  const basemap = basemapById(basemapId);

  const grouped = useMemo(() => {
    const g = new Map<string, GeoMeasure[]>();
    for (const m of catalog?.measures ?? []) {
      const arr = g.get(m.dataset) ?? [];
      arr.push(m);
      g.set(m.dataset, arr);
    }
    return [...g.entries()];
  }, [catalog]);

  const familyLevels = data?.levels?.filter(l => l.family === family) ?? [];

  return (
    <div className="fixed inset-0">
      <div className="absolute inset-0 z-0">
        <MapContainer ref={mapRef}
                      center={initialAt.current ? [initialAt.current[0], initialAt.current[1]] : [39.5, -98.35]}
                      zoom={initialAt.current ? initialAt.current[2] : 4} zoomControl={false}
                      preferCanvas style={{ height: '100%', width: '100%' }}>
          <BaseLayers basemap={basemap} />
          <InitialView at={initialAt.current} />
          <ViewWatcher onView={onView} />
          <UnitLayer data={data} colors={colors} noData={noData} opacity={opacity}
                     onHover={setHover} />
        </MapContainer>
      </div>

      {/* ---- controls ------------------------------------------------- */}
      <aside className="absolute left-3 z-[600] glass glass-floor rounded-2xl p-4 space-y-4
                        overflow-y-auto"
             style={{ top: 'var(--header-offset)', width: PANEL_W, maxHeight: 'calc(100vh - var(--header-offset) - 12px)' }}>
        <div>
          <h1 className="text-base font-semibold text-ink flex items-center gap-2">
            <LayersIcon className="w-4 h-4" aria-hidden /> Explore the data
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            Every loaded measure, drawn at the finest level that fits the view.
            Zoom in to go from counties to tracts, or from a 64 km grid to 1 km pixels.
          </p>
        </div>

        {catalogError && <p className="text-sm text-red-700">Could not load measures: {catalogError}</p>}

        <label className="block">
          <span className="text-xs font-medium text-slate-700">Measure</span>
          <select className="mt-1 w-full rounded-lg border border-slate-300 bg-white/80 px-2 py-1.5 text-sm"
                  value={measure?.code ?? ''}
                  onChange={e => set({ code: e.target.value, level: null, family: null, per: null })}>
            {grouped.map(([ds, ms]) => (
              <optgroup key={ds} label={ds}>
                {ms.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>

        {measure && (
          <div className="text-xs text-slate-600 space-y-0.5">
            <div><span className="font-medium">{measure.dataset}</span>
              {measure.originator ? `, ${measure.originator}` : ''}</div>
            <div>Levels loaded: {measure.levels.map(l => l.label).join(', ')}</div>
            {measure.source_url && (
              <a className="underline break-all" href={measure.source_url} target="_blank" rel="noreferrer">
                Source</a>
            )}
          </div>
        )}

        {families.size > 1 && (
          <div>
            <span className="text-xs font-medium text-slate-700">View as</span>
            <div className="mt-1 flex rounded-lg border border-slate-300 overflow-hidden text-sm">
              {(['grid', 'admin'] as Family[]).filter(f => families.has(f)).map(f => (
                <button key={f} type="button" aria-pressed={family === f}
                        onClick={() => set({ family: f, level: null })}
                        className={`flex-1 px-2 py-1 ${family === f ? 'bg-ink text-white' : 'bg-white/60 hover:bg-white'}`}>
                  {f === 'grid' ? 'Grid (raster)' : 'Areas'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <span className="text-xs font-medium text-slate-700">Level</span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={level === 'auto'} onClick={() => set({ level: null })}
                    className={`px-2 py-1 rounded-full text-xs border ${level === 'auto'
                      ? 'bg-ink text-white border-ink' : 'bg-white/60 border-slate-300 hover:bg-white'}`}>
              Auto
            </button>
            {familyLevels.map(l => {
              const fits = l.in_view !== null && l.in_view <= l.budget;
              return (
                <button key={l.level} type="button" aria-pressed={level === l.level}
                        onClick={() => set({ level: l.level })}
                        title={l.in_view === null ? '' : `${l.in_view.toLocaleString()} in view (draws up to ${l.budget.toLocaleString()})`}
                        className={`px-2 py-1 rounded-full text-xs border ${level === l.level
                          ? 'bg-ink text-white border-ink'
                          : data?.level === l.level ? 'bg-brand-100 border-brand-300'
                          : 'bg-white/60 border-slate-300 hover:bg-white'} ${fits ? '' : 'opacity-60'}`}>
                  {l.label}{l.derived ? ' (est.)' : ''}
                  {l.in_view !== null && <span className="ml-1 tabular-nums opacity-70">{fmt(l.in_view)}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {measure?.is_count && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={(data?.per ?? 'km2') === 'km2'}
                   onChange={e => set({ per: e.target.checked ? 'km2' : 'none' })} />
            Per km² <span className="text-xs text-slate-500">(a count mostly maps unit size)</span>
          </label>
        )}

        <label className="block">
          <span className="text-xs font-medium text-slate-700">Fill opacity</span>
          <input type="range" min={0.2} max={1} step={0.05} value={opacity}
                 onChange={e => setOpacity(Number(e.target.value))} className="w-full" />
        </label>

        <div className="border-t border-slate-200 pt-3 space-y-2">
          {loading && <div className="text-xs text-slate-600 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the view...</div>}
          {error && <div className="text-xs text-red-700">{error}</div>}
          {data && !data.too_many && (
            <div className="text-sm">
              <span className="font-medium">{data.level_label}</span>
              <span className="text-slate-600"> · {data.in_view.toLocaleString()} in view · {data.year}</span>
              <div className="text-[11px] text-slate-500">
                {level === 'auto' ? 'Auto: the finest level that fits this view' : 'Level fixed'}
                {' '}({data.ms} ms)
              </div>
            </div>
          )}
          {data && !data.too_many && data.estimated && data.estimated.count > 0 && (
            <div className="text-xs text-slate-700 flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                {data.estimated.whole_level
                  ? <>Not loaded at this level: every value here is estimated </>
                  : <>{data.estimated.count.toLocaleString()} {data.level_label.toLowerCase()} have no
                      stored value and are estimated </>}
                from {data.estimated.from_label.toLowerCase()}
                {data.estimated.method === 'sum' ? ' (summed)' : ' (population-weighted mean)'}.
                Dashed outlines mark estimates.
              </span>
            </div>
          )}
          {data?.too_many && (
            <div className="text-sm text-amber-800 flex gap-1.5">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{data.in_view.toLocaleString()} {data.level_label.toLowerCase()} in view, more than
                can be drawn at once. Zoom in, or choose a coarser level.</span>
            </div>
          )}
          {data && <Legend data={data} colors={colors} />}
        </div>
      </aside>

      {/* ---- readout + map chrome ---------------------------------------- */}
      {hover && data && (
        <div className="absolute z-[600] pointer-events-none glass rounded-xl px-3 py-2 text-sm"
             style={{ left: PANEL_W + 24, bottom: 16 }}>
          <div className="font-medium">
            {data.level.startsWith('grid') ? `${hover.levelLabel} cell` : hover.props.name ?? hover.props.id}
          </div>
          <div className="text-xs text-slate-600">{hover.levelLabel} · {hover.props.id}</div>
          {hover.props.derived && (
            <div className="text-xs text-amber-800">
              Estimate from {hover.props.derived.parts} {hover.props.derived.from_label.toLowerCase()}
              {hover.props.derived.method === 'sum' ? ', summed' : ', population-weighted'}
              {hover.props.derived.coverage !== null && hover.props.derived.coverage < 0.995
                ? ` (${Math.round(hover.props.derived.coverage * 100)}% covered)` : ''}
            </div>
          )}
          {hover.props.value === null ? <div className="text-slate-500">No data</div> : (
            <div className="tabular-nums">
              {data.per === 'km2' && hover.props.shown !== null && (
                <div><span className="font-semibold">{fmt(hover.props.shown)}</span> {unitLabel(data.units, 'km2')}</div>
              )}
              <div>{data.per === 'km2' ? 'Total ' : ''}<span className={data.per === 'km2' ? '' : 'font-semibold'}>
                {fmt(hover.props.value)}</span> {data.units ?? ''}
                {hover.props.km2 ? <span className="text-slate-500"> · {fmt(hover.props.km2)} km²</span> : null}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="absolute right-3 z-[600] flex flex-col items-end gap-2 pointer-events-none"
           style={{ top: 'var(--header-offset)' }}>
        <div className="pointer-events-auto glass glass-raisable glass-floor rounded-2xl px-3 py-2">
          <BasemapPicker basemapId={basemapId} onBasemap={id => { setBasemapId(id); saveBasemapId(id); }} />
        </div>
        <StageZoom mapRef={mapRef} onReset={() => mapRef.current?.fitBounds(CONUS,
          { paddingTopLeft: [PANEL_W + 24, 90], paddingBottomRight: [24, 24] })} />
      </div>
    </div>
  );
};

export default ExplorePage;
