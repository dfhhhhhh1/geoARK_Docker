import React, { useEffect, useRef, useState } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Loader2, MapPin, X } from 'lucide-react';
import { fmt } from './ChoroplethMap';
import { LayerStyle, RampLegend } from './LayerStyle';
import { POINT_RAMPS } from '../lib/explorePrefs';
import {
  PointsGridLayer, fetchPointAt, fetchPointStats,
  type PointsCatalog, type PointBreaks, type PointAt, type PointStats, type PointsMode,
  type StatsArea, type TileTiming,
} from '../lib/finePoints';

/**
 * The fine sample points on the explore map (backend/fine_points.js):
 *   - <FinePointsLayer>  the tiled canvas layer, plus the clicked point's
 *                        Thiessen cell; lives inside the MapContainer;
 *   - <FinePointsPanel>  the controls: kept short on purpose; numbers about
 *                        the tiles themselves sit behind "Speed".
 */

export interface TileStats { tiles: number; cached: number; points: number; bytes: number; server: number[]; total: number[] }
export const emptyTileStats = (): TileStats => ({ tiles: 0, cached: 0, points: 0, bytes: 0, server: [], total: [] });

export const FinePointsLayer: React.FC<{
  measure: string;
  mode: PointsMode;
  /** From the catalog: 3 with the precomputed zoomed-out cells, else 5. */
  minZoom: number;
  breaks: PointBreaks | null;
  colors: string[];
  opacity: number;
  pick: PointAt | null;
  onTile: (t: TileTiming) => void;
  onPick: (lat: number, lon: number, z: number) => void;
}> = ({ measure, mode, minZoom, breaks, colors, opacity, pick, onTile, onPick }) => {
  const map = useMap();
  const onTileRef = useRef(onTile);
  onTileRef.current = onTile;
  const layerRef = useRef<InstanceType<typeof PointsGridLayer> | null>(null);
  const styleRef = useRef({ colors, breaks, opacity });
  styleRef.current = { colors, breaks, opacity };
  const ready = Boolean(breaks);

  useEffect(() => {
    if (!map.getPane('finepoints')) {
      const pane = map.createPane('finepoints');
      pane.style.zIndex = '450';          // above area fills (400), below tooltips
      pane.style.pointerEvents = 'none';  // the area layer's hover still works
    }
  }, [map]);

  // Rebuilt (tiles refetched) only for a new measure or drawing mode.
  useEffect(() => {
    if (!ready) return undefined;
    const s = styleRef.current;
    const layer = new PointsGridLayer({
      measure, mode, colors: s.colors, breaks: s.breaks!.breaks, pane: 'finepoints',
      opacity: s.opacity, updateWhenZooming: false, keepBuffer: 1, minZoom, maxZoom: 20,
      onTile: (t: TileTiming) => onTileRef.current(t),
    });
    layer.addTo(map);
    layerRef.current = layer;
    return () => { layer.remove(); layerRef.current = null; };
  }, [map, measure, mode, minZoom, ready]);

  // Colours and breaks redraw the loaded tiles in place.
  useEffect(() => {
    if (breaks) layerRef.current?.restyle(colors, breaks.breaks);
  }, [colors, breaks]);
  useEffect(() => { layerRef.current?.setOpacity(opacity); }, [opacity]);

  useMapEvents({ click: e => onPick(e.latlng.lat, e.latlng.lng, map.getZoom()) });

  // The clicked point and its Thiessen cell.
  useEffect(() => {
    if (!pick?.found || !pick.point) return undefined;
    const g = L.layerGroup();
    if (pick.cell) {
      L.geoJSON(pick.cell.geometry as never, {
        style: { color: '#e11d48', weight: 2.5, fillOpacity: 0.1, fillColor: '#e11d48' },
        interactive: false, pane: 'finepoints',
      } as L.GeoJSONOptions).addTo(g);
    }
    L.circleMarker([pick.point.lat, pick.point.lon], {
      radius: 5, color: '#e11d48', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, pane: 'finepoints',
    }).addTo(g);
    g.addTo(map);
    return () => { g.remove(); };
  }, [map, pick]);

  return null;
};

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
const mi = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${v < 10 ? v.toFixed(1) : Math.round(v)} mi`);
const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

export const FinePointsPanel: React.FC<{
  catalog: PointsCatalog;
  on: boolean;
  measure: string;
  mode: PointsMode;
  viewScale: boolean;
  breaks: PointBreaks | null;
  colors: string[];
  rampId: string;
  opacity: number;
  tiles: TileStats;
  zoom: number;
  pick: PointAt | null;
  picking: boolean;
  viewBbox: () => [number, number, number, number] | null;
  onToggle: (on: boolean) => void;
  onMeasure: (m: string) => void;
  onMode: (m: PointsMode) => void;
  onViewScale: (v: boolean) => void;
  onRamp: (id: string) => void;
  onOpacity: (v: number) => void;
  onClearPick: () => void;
}> = (p) => {
  const { catalog, on, measure, mode, viewScale, breaks, colors, pick, picking } = p;
  const col = catalog.columns.find(c => c.column === measure) ?? catalog.columns[0];
  const [stats, setStats] = useState<PointStats | null>(null);
  const [statsArea, setStatsArea] = useState('');
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [radius, setRadius] = useState(10);
  const ac = useRef<AbortController | null>(null);

  const runStats = (area: StatsArea, label: string) => {
    ac.current?.abort();
    const a = new AbortController();
    ac.current = a;
    setStatsBusy(true); setStatsErr(null); setStatsArea(label);
    fetchPointStats(measure, area, a.signal)
      .then(setStats)
      .catch(e => { if (e.name !== 'AbortError') { setStats(null); setStatsErr(String(e.message || e)); } })
      .finally(() => { if (ac.current === a) setStatsBusy(false); });
  };
  useEffect(() => { setStats(null); setStatsArea(''); }, [measure]);

  const units = pick?.units ?? {};
  const picked = pick?.found ? pick.distances?.find(d => d.column === col.column) : null;

  return (
    <section className="border-t border-slate-200/70 pt-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink flex items-center gap-1.5">
          <MapPin className="w-4 h-4" aria-hidden /> Fine points
        </h2>
        <button type="button" onClick={() => p.onToggle(!on)}
                className={`px-2 py-0.5 rounded-full text-xs border ${on
                  ? 'bg-ink text-white border-ink' : 'bg-white/60 border-slate-300 hover:bg-white'}`}>
          {on ? 'On' : 'Off'}
        </button>
      </div>
      {!on ? null : (<>
        <select className="w-full rounded-lg border border-slate-300 bg-white/80 px-2 py-1.5 text-sm"
                value={col.column} onChange={e => p.onMeasure(e.target.value)}
                aria-label="Distance to the nearest">
          {catalog.columns.map(c => <option key={c.column} value={c.column}>Distance to {c.short.toLowerCase()}</option>)}
        </select>

        <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs">
          {([['auto', 'Auto'], ['points', 'Points'], ['cells', 'Thiessen cells']] as [PointsMode, string][]).map(([m, l]) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => p.onMode(m)}
                    className={`flex-1 px-2 py-1 ${mode === m ? 'bg-ink text-white' : 'bg-white/60 hover:bg-white'}`}>
              {l}
            </button>
          ))}
        </div>
        {p.zoom < catalog.min_zoom && <div className="text-[11px] text-amber-800">Zoom in to see the points.</div>}
        {mode === 'cells' && p.zoom >= catalog.min_zoom && p.zoom < catalog.cell_min_zoom && (
          <div className="text-[11px] text-slate-500">Cells appear from zoom {catalog.cell_min_zoom}.</div>
        )}

        <LayerStyle label="Points" ramps={POINT_RAMPS} rampId={p.rampId} opacity={p.opacity}
                    onRamp={p.onRamp} onOpacity={p.onOpacity} />
        {breaks && <RampLegend colors={colors} edges={[breaks.min, ...breaks.breaks, breaks.max]} unit="mi" fmt={fmt} />}
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={viewScale} onChange={e => p.onViewScale(e.target.checked)} />
          Fit colours to this view
        </label>

        {(picking || pick) && (
          <div className="rounded-lg bg-white/50 border border-slate-200 p-2 text-xs space-y-1">
            <div className="flex items-start justify-between gap-2">
              <span className="text-slate-700">
                {picking ? <span className="inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Looking up...</span>
                  : !pick?.found ? 'No point here.'
                  : <>{units.county ? `${units.county.name} County` : ''}{units.tract ? `, ${units.tract.name}` : ''}</>}
              </span>
              <button type="button" onClick={p.onClearPick} aria-label="Clear"><X className="w-3.5 h-3.5" /></button>
            </div>
            {picked && <div className="text-sm"><span className="font-semibold tabular-nums">{mi(picked.miles)}</span> to the nearest {col.short.toLowerCase()}</div>}
            {pick?.found && (
              <details>
                <summary className="cursor-pointer text-slate-600">All distances</summary>
                <table className="w-full tabular-nums mt-1">
                  <tbody>
                    {(pick.distances ?? []).map(d => (
                      <tr key={d.column} className={d.column === col.column ? 'font-semibold' : ''}>
                        <td className="pr-2">
                          <button type="button" className="text-left hover:underline" onClick={() => p.onMeasure(d.column)}>{d.label}</button>
                        </td>
                        <td className="text-right">{mi(d.miles)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-700">Summarize:</span>
            <AreaButton onClick={() => { const b = p.viewBbox(); if (b) runStats({ kind: 'bbox', bbox: b }, 'This view'); }}>View</AreaButton>
            {(['tract', 'county'] as const).filter(l => units[l]).map(l => (
              <AreaButton key={l} onClick={() => runStats({ kind: 'unit', level: l, geoid: units[l].geoid, label: units[l].name ?? '' },
                l === 'county' ? `${units[l].name} County` : `${units[l].name}`)}>
                {l === 'tract' ? 'Tract' : 'County'}
              </AreaButton>
            ))}
            {pick?.found && pick.point && (
              <span className="inline-flex items-center gap-1">
                <AreaButton onClick={() => runStats({ kind: 'radius', lat: pick.point!.lat, lon: pick.point!.lon, miles: radius },
                  `Within ${radius} mi`)}>Within</AreaButton>
                <input type="number" min={0.5} max={100} step={0.5} value={radius} aria-label="Radius in miles"
                       onChange={e => setRadius(Math.max(0.5, Math.min(100, Number(e.target.value) || 10)))}
                       className="w-12 rounded border border-slate-300 bg-white/70 px-1 py-0.5 text-xs" />mi
              </span>
            )}
          </div>
          {statsBusy && <div className="text-xs text-slate-600 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Computing...</div>}
          {statsErr && <div className="text-xs text-red-700">{statsErr}</div>}
          {stats && !statsBusy && <StatsTable s={stats} area={statsArea} />}
        </div>

        <details className="text-[11px] text-slate-600">
          <summary className="cursor-pointer">About and speed</summary>
          <p className="mt-1">Straight-line (not driving) distance from {catalog.total_points.toLocaleString()} block
            centroids and hexagon points ({catalog.states.map(s => s.name ?? s.state_fp).join(', ')}). {col.method}.</p>
          {p.tiles.tiles > 0 && (
            <p className="tabular-nums mt-1">{p.tiles.tiles} tiles, median {Math.round(median(p.tiles.total))} ms
              (SQL {Math.round(median(p.tiles.server.filter(x => x > 0)))} ms), {p.tiles.cached} cached.</p>
          )}
        </details>
      </>)}
    </section>
  );
};

const AreaButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button type="button" onClick={onClick}
          className="px-2 py-0.5 rounded-full text-xs border bg-white/60 border-slate-300 hover:bg-white">
    {children}
  </button>
);

const StatsTable: React.FC<{ s: PointStats; area: string }> = ({ s, area }) => {
  if (s.n === 0) return <div className="text-xs text-slate-600">No points in {area.toLowerCase()}.</div>;
  const beyond = s.beyond.filter(b => b.share_area !== null && b.share_area > 0.0005);
  return (
    <div className="text-xs space-y-1">
      <div className="font-medium">{area}</div>
      <div className="grid grid-cols-4 gap-1 tabular-nums text-center">
        {([['Mean', s.mean], ['Median', s.median], ['90th %', s.p90], ['Max', s.max]] as [string, number | null][]).map(([k, v]) => (
          <div key={k} className="rounded bg-white/50 py-1">
            <div className="text-[10px] text-slate-500">{k}</div>
            <div className="font-semibold">{mi(v)}</div>
          </div>
        ))}
      </div>
      {beyond.length > 0 && (
        <div className="text-slate-700 tabular-nums">
          Area farther than {beyond.map(b => `${b.miles} mi: ${pct(b.share_area)}`).join(' · ')}
        </div>
      )}
    </div>
  );
};

export { fetchPointAt };
