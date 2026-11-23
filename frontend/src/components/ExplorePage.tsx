import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, useMap, useMapEvents } from 'react-leaflet';
import { useSearchParams } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Loader2, Layers as LayersIcon, Info, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { BaseLayers, BasemapPicker, StageZoom } from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId } from '../lib/basemaps';
import { NO_DATA_LIGHT, NO_DATA_DARK, fmt } from './ChoroplethMap';
import { useIsDark } from '../hooks/useIsDark';
import {
  fetchGeoCatalog, fetchGeoLayer, binOf, unitLabel,
  type GeoCatalog, type GeoMeasure, type GeoLayerResponse, type UnitProps,
} from '../lib/geoLayers';
import { FinePointsLayer, FinePointsPanel, emptyTileStats, type TileStats } from './FinePoints';
import { LayerStyle, RampLegend } from './LayerStyle';
import {
  AREA_RAMPS, POINT_RAMPS, rampById, loadAreaPrefs, saveAreaPrefs, loadPointPrefs, savePointPrefs,
  loadPanelCollapsed, savePanelCollapsed,
} from '../lib/explorePrefs';
import {
  fetchPointsCatalog, fetchPointBreaks, fetchPointAt,
  type PointsCatalog, type PointBreaks, type PointAt, type PointsMode, type TileTiming,
} from '../lib/finePoints';

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
  const styleRef = useRef(styleFor);
  styleRef.current = styleFor;

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
          // The CURRENT style (opacity, colours), not the one this layer was
          // built with: those handlers outlive every slider change.
          (l as L.Path).setStyle(styleRef.current(f.properties as UnitProps));
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
  const [areaPrefs, setAreaPrefs] = useState(loadAreaPrefs);
  const opacity = areaPrefs.opacity;
  const [ptStyle, setPtStyle] = useState(() => { const p = loadPointPrefs(); return { ramp: p.ramp, opacity: p.opacity }; });
  const [collapsed, setCollapsed] = useState(loadPanelCollapsed);
  const [basemapId, setBasemapId] = useState(() => loadBasemapId('light'));
  const view = useRef<{ bounds: L.LatLngBounds; z: number } | null>(null);
  const initialAt = useRef(parseAt(params.get('at')));
  const abort = useRef<AbortController | null>(null);

  const code = params.get('code');
  const level = params.get('level') || 'auto';
  const familyParam = params.get('family') as Family | null;
  const perParam = params.get('per') as 'km2' | 'none' | null;
  // Fine points: ?pts=<column> turns the layer on; ?ptmode, ?areas=0.
  const pts = params.get('pts');
  const ptMode = (['auto', 'points', 'cells'].includes(params.get('ptmode') || '') ? params.get('ptmode') : 'auto') as PointsMode;
  // Points on: the area layer is off unless asked for (two fills muddy each other).
  const showAreas = params.get('areas') === '1' || (!pts && params.get('areas') !== '0');
  const viewScale = params.get('ptscale') === 'view';
  const [viewKey, setViewKey] = useState(0);
  const [ptsCatalog, setPtsCatalog] = useState<PointsCatalog | null>(null);
  const [ptBreaks, setPtBreaks] = useState<PointBreaks | null>(null);
  const [tiles, setTiles] = useState<TileStats>(emptyTileStats);
  const [pick, setPick] = useState<PointAt | null>(null);
  const [picking, setPicking] = useState(false);
  const [zoom, setZoom] = useState(initialAt.current ? initialAt.current[2] : 4);
  const pickAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchPointsCatalog(ac.signal).then(setPtsCatalog).catch(() => { /* no points loaded: no section */ });
    return () => ac.abort();
  }, []);
  useEffect(() => {
    if (!pts) return undefined;
    const ac = new AbortController();
    const b = viewScale ? view.current?.bounds : null;
    fetchPointBreaks(pts, ac.signal, b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : undefined)
      // Same breaks after a pan: keep the object, so the layer is not rebuilt.
      .then(nb => setPtBreaks(prev => (prev && JSON.stringify(prev.breaks) === JSON.stringify(nb.breaks)
        && prev.scope === nb.scope ? prev : nb)))
      .catch(() => { /* legend stays empty */ });
    return () => ac.abort();
  }, [pts, viewScale, viewScale ? viewKey : 0]);
  useEffect(() => { setPtBreaks(null); }, [pts]);
  useEffect(() => { setTiles(emptyTileStats()); }, [pts, ptMode]);
  const onTile = useCallback((t: TileTiming) => setTiles(prev => ({
    tiles: prev.tiles + 1, cached: prev.cached + (t.cached ? 1 : 0), points: prev.points + t.n,
    bytes: prev.bytes + t.bytes, server: [...prev.server, t.serverMs].slice(-500),
    total: [...prev.total, t.totalMs].slice(-500),
  })), []);
  const onPick = useCallback((lat: number, lon: number, z: number) => {
    pickAbort.current?.abort();
    const ac = new AbortController();
    pickAbort.current = ac;
    setPicking(true);
    fetchPointAt(lat, lon, z, ac.signal).then(setPick)
      .catch(e => { if (e.name !== 'AbortError') setPick(null); })
      .finally(() => { if (pickAbort.current === ac) setPicking(false); });
  }, []);

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
    setZoom(z);
    setViewKey(k => k + 1);
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

  const ramp = rampById(AREA_RAMPS, areaPrefs.ramp);
  const colors = isDark ? ramp.dark : ramp.light;
  const ptColors = rampById(POINT_RAMPS, ptStyle.ramp).light;
  const updateArea = (patch: Partial<typeof areaPrefs>) => setAreaPrefs(prev => {
    const next = { ...prev, ...patch }; saveAreaPrefs(next); return next;
  });
  const updatePtStyle = (patch: Partial<typeof ptStyle>) => setPtStyle(prev => {
    const next = { ...prev, ...patch }; savePointPrefs(next); return next;
  });
  // While the points are on, what is chosen is remembered, so turning them
  // off and on again brings it back.
  useEffect(() => {
    if (!pts) return;
    savePointPrefs({ pts, ptmode: ptMode, ptscale: viewScale ? 'view' : 'all', areas: showAreas });
  }, [pts, ptMode, viewScale, showAreas]);
  const togglePoints = (on: boolean) => {
    if (!on) { set({ pts: null, ptmode: null, ptscale: null, areas: null }); setPick(null); return; }
    const p = loadPointPrefs();
    const valid = ptsCatalog?.columns.some(c => c.column === p.pts) ? p.pts : 'hosp_mi';
    set({ pts: valid, ptmode: p.ptmode === 'auto' ? null : p.ptmode, ptscale: p.ptscale === 'view' ? 'view' : null,
          areas: p.areas ? '1' : null });
    const st = ptsCatalog?.states[0];
    if (st?.bbox && ptsCatalog && zoom < ptsCatalog.min_zoom) {
      mapRef.current?.fitBounds([[st.bbox[1], st.bbox[0]], [st.bbox[3], st.bbox[2]]],
        { paddingTopLeft: [collapsed ? 24 : PANEL_W + 24, 90], paddingBottomRight: [24, 24] });
    }
  };
  const toggleCollapsed = (v: boolean) => { setCollapsed(v); savePanelCollapsed(v); };
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
          {showAreas && <UnitLayer data={data} colors={colors} noData={noData} opacity={opacity}
                     onHover={setHover} />}
          {pts && <FinePointsLayer measure={pts} mode={ptMode} breaks={ptBreaks} colors={ptColors}
                                   opacity={ptStyle.opacity} pick={pick} onTile={onTile} onPick={onPick} />}
        </MapContainer>
      </div>

      {/* ---- controls ------------------------------------------------- */}
      {collapsed ? (
        <button type="button" onClick={() => toggleCollapsed(false)}
                className="absolute left-3 z-[600] glass glass-raisable glass-floor rounded-xl px-3 py-2 text-sm
                           flex items-center gap-1.5"
                style={{ top: 'var(--header-offset)' }} aria-label="Show the layer controls">
          <PanelLeftOpen className="w-4 h-4" aria-hidden /> Layers
        </button>
      ) : (
      <aside className="absolute left-3 z-[600] glass glass-raisable rounded-2xl p-3.5 space-y-3 overflow-y-auto"
             style={{ top: 'var(--header-offset)', width: PANEL_W, maxHeight: 'calc(100vh - var(--header-offset) - 12px)' }}>
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold text-ink flex items-center gap-2">
            <LayersIcon className="w-4 h-4" aria-hidden /> Explore
          </h1>
          <button type="button" onClick={() => toggleCollapsed(true)} aria-label="Hide the layer controls"
                  title="Hide" className="p-1 rounded-md hover:bg-white/60">
            <PanelLeftClose className="w-4 h-4" aria-hidden />
          </button>
        </div>

        {catalogError && <p className="text-sm text-red-700">Could not load measures: {catalogError}</p>}

        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Areas</h2>
            <button type="button" onClick={() => set({ areas: showAreas ? '0' : '1' })}
                    className={`px-2 py-0.5 rounded-full text-xs border ${showAreas
                      ? 'bg-ink text-white border-ink' : 'bg-white/60 border-slate-300 hover:bg-white'}`}>
              {showAreas ? 'On' : 'Off'}
            </button>
          </div>
          {showAreas && (<>
          <select className="w-full rounded-lg border border-slate-300 bg-white/80 px-2 py-1.5 text-sm"
                  value={measure?.code ?? ''} aria-label="Measure"
                  onChange={e => set({ code: e.target.value, level: null, family: null, per: null })}>
            {grouped.map(([ds, ms]) => (
              <optgroup key={ds} label={ds}>
                {ms.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
              </optgroup>
            ))}
          </select>
          {measure && (
            <div className="text-[11px] text-slate-600 truncate" title={measure.dataset}>
              {measure.dataset}
              {measure.source_url && <> · <a className="underline" href={measure.source_url} target="_blank" rel="noreferrer">source</a></>}
            </div>
          )}

          {families.size > 1 && (
            <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs">
              {(['grid', 'admin'] as Family[]).filter(f => families.has(f)).map(f => (
                <button key={f} type="button" aria-pressed={family === f}
                        onClick={() => set({ family: f, level: null })}
                        className={`flex-1 px-2 py-1 ${family === f ? 'bg-ink text-white' : 'bg-white/60 hover:bg-white'}`}>
                  {f === 'grid' ? 'Grid' : 'Areas'}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-pressed={level === 'auto'} onClick={() => set({ level: null })}
                    title="The finest level that fits the view"
                    className={`px-2 py-0.5 rounded-full text-xs border ${level === 'auto'
                      ? 'bg-ink text-white border-ink' : 'bg-white/60 border-slate-300 hover:bg-white'}`}>
              Auto
            </button>
            {familyLevels.map(l => {
              const fits = l.in_view !== null && l.in_view <= l.budget;
              return (
                <button key={l.level} type="button" aria-pressed={level === l.level}
                        onClick={() => set({ level: l.level })}
                        title={l.in_view === null ? '' : `${l.in_view.toLocaleString()} in view`}
                        className={`px-2 py-0.5 rounded-full text-xs border ${level === l.level
                          ? 'bg-ink text-white border-ink'
                          : data?.level === l.level ? 'bg-brand-100 border-brand-300'
                          : 'bg-white/60 border-slate-300 hover:bg-white'} ${fits ? '' : 'opacity-60'}`}>
                  {l.label}{l.derived ? ' (est.)' : ''}
                </button>
              );
            })}
          </div>

          {measure?.is_count && (
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={(data?.per ?? 'km2') === 'km2'}
                     onChange={e => set({ per: e.target.checked ? 'km2' : 'none' })} />
              Per km²
            </label>
          )}

          <LayerStyle label="Areas" ramps={AREA_RAMPS} rampId={ramp.id} dark={isDark} opacity={opacity}
                      onRamp={id => updateArea({ ramp: id })} onOpacity={v => updateArea({ opacity: v })} />

          {loading && <div className="text-xs text-slate-600 flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...</div>}
          {error && <div className="text-xs text-red-700">{error}</div>}
          {data?.too_many && (
            <div className="text-xs text-amber-800 flex gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>Too many {data.level_label.toLowerCase()} to draw here. Zoom in or pick a coarser level.</span>
            </div>
          )}
          {data && !data.too_many && data.estimated && data.estimated.count > 0 && (
            <div className="text-[11px] text-slate-600">
              Dashed: estimated from {data.estimated.from_label.toLowerCase()}.
            </div>
          )}
          {data && (
            <RampLegend colors={colors} fmt={fmt}
                        edges={[data.bins.min, ...data.bins.breaks, data.bins.max]}
                        unit={`${unitLabel(data.units, data.per)}${data.too_many ? '' : ` · ${data.level_label}`}`} />
          )}
          </>)}
        </section>

        {ptsCatalog && ptsCatalog.states.length > 0 && (
          <FinePointsPanel catalog={ptsCatalog} on={Boolean(pts)} measure={pts ?? 'hosp_mi'} mode={ptMode}
            viewScale={viewScale} breaks={ptBreaks} colors={ptColors} rampId={ptStyle.ramp} opacity={ptStyle.opacity}
            tiles={tiles} zoom={zoom} pick={pick} picking={picking}
            viewBbox={() => {
              const b = view.current?.bounds;
              return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : null;
            }}
            onToggle={togglePoints}
            onMeasure={m => set({ pts: m })}
            onMode={m => set({ ptmode: m === 'auto' ? null : m })}
            onViewScale={v => set({ ptscale: v ? 'view' : null })}
            onRamp={id => updatePtStyle({ ramp: id })}
            onOpacity={v => updatePtStyle({ opacity: v })}
            onClearPick={() => setPick(null)} />
        )}
      </aside>
      )}

      {/* ---- readout + map chrome ---------------------------------------- */}
      {hover && data && showAreas && (
        <div className="absolute z-[600] pointer-events-none glass rounded-xl px-3 py-2 text-sm"
             style={{ left: collapsed ? 16 : PANEL_W + 24, bottom: 16 }}>
          <div className="font-medium">
            {data.level.startsWith('grid') ? `${hover.levelLabel} cell` : hover.props.name ?? hover.props.id}
          </div>
          <div className="text-xs text-slate-600">{hover.levelLabel}, {hover.props.id}</div>
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
                {hover.props.km2 ? <span className="text-slate-500">, {fmt(hover.props.km2)} km²</span> : null}
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
