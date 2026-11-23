import L from 'leaflet';

/**
 * Client for the fine sample points (backend/fine_points.js): 2020 block
 * centroids + hexagon points, each with straight-line distances to the
 * nearest facility of 30 kinds.
 *
 * Drawn as a canvas GridLayer: each 256 px tile is one request, and the
 * server decides what the tile holds: the mean of every 4x4 px cell when
 * there are too many points to draw ('agg'), the points themselves
 * ('points'), or, asked for and zoomed in, each point's Thiessen cell
 * ('cells'). No DOM element per point, so a tile of 6,000 points costs one
 * canvas.
 */

export interface PointColumn {
  column: string;
  label: string;
  short: string;
  units: string;
  method: string;
}

export interface PointsCatalog {
  columns: PointColumn[];
  states: { state_fp: string; name: string | null; points: number; bbox: [number, number, number, number] | null }[];
  total_points: number;
  min_zoom: number;
  cell_min_zoom: number;
  point_budget: number;
  thresholds: number[];
  note: string;
}

export interface PointBreaks { breaks: number[]; min: number; max: number; scope?: 'all' | 'view'; sampled?: boolean }

export interface PointAt {
  found: boolean;
  ms: number;
  tolerance_m?: number;
  point?: {
    id: string; lon: number; lat: number; block20: string; kind: string; grid_id: string | null;
    zip: string | null; huc12: string | null; thiessen_km2: number | null; power_line_density: number | null;
  };
  units?: Record<string, { geoid: string; name: string | null }>;
  distances?: { column: string; label: string; miles: number | null }[];
  cell?: { geometry: GeoJSON.Geometry; km2: number } | null;
}

export interface PointStats {
  column: string; label: string; units: string;
  n: number; n_centroid: number; n_value: number; blocks: number; km2: number;
  mean: number | null; block_mean: number | null; area_mean: number | null;
  p10: number | null; median: number | null; p90: number | null; min: number | null; max: number | null;
  beyond: { miles: number; share_points: number | null; share_area: number | null }[];
  ms: number;
}

export type StatsArea =
  | { kind: 'bbox'; bbox: [number, number, number, number] }
  | { kind: 'unit'; level: string; geoid: string; label: string }
  | { kind: 'radius'; lat: number; lon: number; miles: number };

export type PointsMode = 'auto' | 'points' | 'cells';

/** One tile's timing, reported to whoever is measuring the layer. */
export interface TileTiming {
  z: number; mode: string; n: number;
  /** Server time spent in SQL (0 when the tile came from its cache). */
  serverMs: number;
  /** Request sent to tile drawn, as the browser saw it. */
  totalMs: number;
  cached: boolean;
  bytes: number;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j as T;
}

export const fetchPointsCatalog = (signal?: AbortSignal) =>
  getJson<PointsCatalog>('/api/points/catalog', signal);

/** Colour breaks: over every loaded point, or (bbox given) over the view. */
export const fetchPointBreaks = (m: string, signal?: AbortSignal, bbox?: [number, number, number, number]) =>
  getJson<PointBreaks>(`/api/points/breaks?m=${encodeURIComponent(m)}${
    bbox ? `&bbox=${bbox.map(v => v.toFixed(4)).join(',')}` : ''}`, signal);

export const fetchPointAt = (lat: number, lon: number, z: number, signal?: AbortSignal) =>
  getJson<PointAt>(`/api/points/at?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&z=${Math.round(z)}`, signal);

export function fetchPointStats(m: string, area: StatsArea, signal?: AbortSignal): Promise<PointStats> {
  const p = new URLSearchParams({ m });
  if (area.kind === 'bbox') p.set('bbox', area.bbox.map(v => v.toFixed(5)).join(','));
  else if (area.kind === 'unit') { p.set('level', area.level); p.set('geoid', area.geoid); }
  else { p.set('lat', String(area.lat)); p.set('lon', String(area.lon)); p.set('radius_mi', String(area.miles)); }
  return getJson<PointStats>(`/api/points/stats?${p}`, signal);
}

export function binOfBreaks(v: number, breaks: number[]): number {
  for (let i = 0; i < breaks.length; i++) if (v <= breaks[i]) return i;
  return breaks.length;
}

interface PointsLayerOptions extends L.GridLayerOptions {
  measure: string;
  mode: PointsMode;
  colors: string[];
  breaks: number[];
  onTile?: (t: TileTiming) => void;
}

interface TileMsg {
  mode: 'empty' | 'agg' | 'points' | 'cells';
  n: number;
  d: (number | null)[];
  cell?: number;
  polys?: { v: number | null; r: number[][] }[];
  sql_ms?: number;
  ms?: number;
  cached?: boolean;
}

/** Dot radius in CSS px by zoom: legible when sparse, not a blob when dense. */
function radiusFor(z: number): number {
  return z <= 9 ? 1.4 : z <= 11 ? 1.8 : z <= 13 ? 2.4 : z <= 15 ? 3.2 : 4.2;
}

/**
 * L.GridLayer that draws one fetched tile per canvas. Aborts a tile's request
 * when Leaflet unloads it (panning fast must not queue hundreds of requests).
 */
export const PointsGridLayer = L.GridLayer.extend({
  initialize(this: L.GridLayer & { _aborts: Map<string, AbortController> }, opts: PointsLayerOptions) {
    L.setOptions(this, opts);
    this._aborts = new Map();
    this.on('tileunload', (e: L.TileEvent) => {
      const key = (e.tile as unknown as HTMLCanvasElement).dataset.key;
      if (key) { this._aborts.get(key)?.abort(); this._aborts.delete(key); }
    });
  },

  createTile(this: L.GridLayer & { options: PointsLayerOptions; _aborts: Map<string, AbortController> },
             coords: L.Coords, done: L.DoneCallback) {
    const o = this.options;
    const canvas = L.DomUtil.create('canvas', 'leaflet-tile') as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = this.getTileSize();
    canvas.width = size.x * dpr;
    canvas.height = size.y * dpr;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    canvas.dataset.key = key;
    const ac = new AbortController();
    this._aborts.set(key, ac);
    const t0 = performance.now();
    const url = `/api/points/tile/${key}?m=${encodeURIComponent(o.measure)}&mode=${o.mode}`;
    fetch(url, { signal: ac.signal, credentials: 'same-origin' })
      .then(async r => {
        const text = await r.text();
        if (!r.ok) throw new Error(`tile ${key}: HTTP ${r.status}`);
        const msg = JSON.parse(text) as TileMsg;
        (canvas as TileCanvas)._msg = msg;
        (canvas as TileCanvas)._z = coords.z;
        draw(canvas, msg, coords.z, dpr, o);
        o.onTile?.({ z: coords.z, mode: msg.mode, n: msg.n, serverMs: msg.cached ? 0 : (msg.sql_ms ?? msg.ms ?? 0),
          totalMs: performance.now() - t0, cached: Boolean(msg.cached), bytes: text.length });
        done(undefined, canvas);
      })
      .catch(err => { if (err.name !== 'AbortError') done(err, canvas); })
      .finally(() => this._aborts.delete(key));
    return canvas;
  },

  /** New colours or breaks: redraw the tiles already loaded, no refetch. */
  restyle(this: L.GridLayer & { options: PointsLayerOptions; _tiles: Record<string, { el: HTMLElement }> },
          colors: string[], breaks: number[]) {
    this.options.colors = colors;
    this.options.breaks = breaks;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const t of Object.values(this._tiles || {})) {
      const c = t.el as TileCanvas;
      if (c._msg) draw(c, c._msg, c._z ?? 0, dpr, this.options);
    }
  },
}) as unknown as new (opts: PointsLayerOptions) => L.GridLayer & { restyle(colors: string[], breaks: number[]): void };

type TileCanvas = HTMLCanvasElement & { _msg?: TileMsg; _z?: number };

function draw(canvas: HTMLCanvasElement, msg: TileMsg, z: number, dpr: number, o: PointsLayerOptions) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const color = (v: number | null) => (v === null ? 'rgba(128,128,128,0.6)' : o.colors[binOfBreaks(v, o.breaks)]);
  const d = msg.d;
  if (msg.mode === 'agg') {
    const c = msg.cell ?? 4;
    for (let i = 0; i < d.length; i += 4) {
      ctx.fillStyle = color(d[i + 2] as number);
      ctx.fillRect((d[i] as number) * c, (d[i + 1] as number) * c, c, c);
    }
  } else if (msg.mode === 'points') {
    const r = radiusFor(z);
    for (let i = 0; i < d.length; i += 4) {
      ctx.beginPath();
      ctx.arc(d[i] as number, d[i + 1] as number, r, 0, Math.PI * 2);
      ctx.fillStyle = color(d[i + 2]);
      ctx.fill();
      if (z >= 13) {
        // Block centroids get a dark ring: they stand for a whole block that
        // held no hexagon point, so they are not interchangeable with one.
        ctx.lineWidth = d[i + 3] ? 1 : 0.5;
        ctx.strokeStyle = d[i + 3] ? 'rgba(20,20,20,0.85)' : 'rgba(255,255,255,0.6)';
        ctx.stroke();
      }
    }
  } else if (msg.mode === 'cells') {
    ctx.lineWidth = z >= 15 ? 0.6 : 0.3;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    for (const p of msg.polys ?? []) {
      ctx.beginPath();
      for (const ring of p.r) {
        for (let i = 0; i < ring.length; i += 2) {
          if (i === 0) ctx.moveTo(ring[i], ring[i + 1]); else ctx.lineTo(ring[i], ring[i + 1]);
        }
        ctx.closePath();
      }
      ctx.fillStyle = color(p.v);
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }
}
