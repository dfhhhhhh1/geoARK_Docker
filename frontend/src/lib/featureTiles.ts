import L from 'leaflet';
import type { FeatureTiles } from '../types';

/**
 * A large point answer drawn from tiles (backend/feature_tiles.js) instead of
 * one Leaflet marker per feature. Each 256 px tile is fetched and painted on a
 * canvas: every point when the tile holds few enough, else the count in each
 * 4x4 px cell, drawn darker where there are more. Hover and click ask the
 * server for the nearest point, so no feature is ever held in the browser.
 */

interface Opts extends L.GridLayerOptions {
  setId: string;
  color: string;
  ringColor: string;
  onError?: (msg: string) => void;
}

interface TileMsg { mode: 'points' | 'agg'; n: number; d: number[]; cell?: number }
type TileCanvas = HTMLCanvasElement & { _msg?: TileMsg; _z?: number };

const radiusFor = (z: number) => (z <= 4 ? 1.6 : z <= 6 ? 2.2 : z <= 9 ? 3 : 4.2);

function draw(c: TileCanvas, msg: TileMsg, z: number, o: Opts) {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 256, 256);
  const d = msg.d;
  if (msg.mode === 'agg') {
    const s = msg.cell ?? 4;
    ctx.fillStyle = o.color;
    for (let i = 0; i < d.length; i += 3) {
      // One point reads as a light cell, ten or more as solid.
      ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * Math.log10(1 + d[i + 2]) / Math.log10(11));
      ctx.fillRect(d[i] * s, d[i + 1] * s, s, s);
    }
    ctx.globalAlpha = 1;
    return;
  }
  const r = radiusFor(z);
  ctx.fillStyle = o.color;
  ctx.strokeStyle = o.ringColor;
  ctx.lineWidth = r >= 3 ? 1.2 : 0.6;
  for (let i = 0; i < d.length; i += 2) {
    ctx.beginPath();
    ctx.arc(d[i], d[i + 1], r, 0, Math.PI * 2);
    ctx.fill();
    if (r >= 2.2) ctx.stroke();
  }
}

export const FeatureTilesLayer = L.GridLayer.extend({
  initialize(this: L.GridLayer & { _aborts: Map<string, AbortController> }, opts: Opts) {
    L.setOptions(this, opts);
    this._aborts = new Map();
    this.on('tileunload', (e: L.TileEvent) => {
      const key = (e.tile as unknown as HTMLCanvasElement).dataset.key;
      if (key) { this._aborts.get(key)?.abort(); this._aborts.delete(key); }
    });
  },

  createTile(this: L.GridLayer & { options: Opts; _aborts: Map<string, AbortController> },
             coords: L.Coords, done: L.DoneCallback) {
    const o = this.options;
    const c = L.DomUtil.create('canvas', 'leaflet-tile') as TileCanvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = 256 * dpr; c.height = 256 * dpr;
    c.style.width = '256px'; c.style.height = '256px';
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    c.dataset.key = key;
    const ac = new AbortController();
    this._aborts.set(key, ac);
    fetch(`/api/featuresets/${encodeURIComponent(o.setId)}/tile/${key}`, { signal: ac.signal, credentials: 'same-origin' })
      .then(async r => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        c._msg = j as TileMsg; c._z = coords.z;
        draw(c, c._msg, coords.z, o);
        done(undefined, c);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        o.onError?.(String(err.message || err));
        done(err, c);
      })
      .finally(() => this._aborts.delete(key));
    return c;
  },

  /** New colour: repaint the loaded tiles, no refetch. */
  recolor(this: L.GridLayer & { options: Opts; _tiles: Record<string, { el: HTMLElement }> }, color: string, ringColor: string) {
    this.options.color = color;
    this.options.ringColor = ringColor;
    for (const t of Object.values(this._tiles || {})) {
      const c = t.el as TileCanvas;
      if (c._msg) draw(c, c._msg, c._z ?? 0, this.options);
    }
  },
}) as unknown as new (opts: Opts) => L.GridLayer & { recolor(color: string, ringColor: string): void };

export interface FeatureAt { lon: number; lat: number; properties: Record<string, string | null> }

export async function fetchFeatureAt(tiles: FeatureTiles, lat: number, lon: number, z: number,
                                     signal?: AbortSignal): Promise<FeatureAt | null> {
  const r = await fetch(`/api/featuresets/${encodeURIComponent(tiles.id)}/at?lat=${lat}&lon=${lon}&z=${z}`,
    { signal, credentials: 'same-origin' });
  if (!r.ok) return null;
  return ((await r.json()) as { found: FeatureAt | null }).found;
}

export const tilesBounds = (t: FeatureTiles): L.LatLngBounds | null =>
  t.bbox ? L.latLngBounds([t.bbox[1], t.bbox[0]], [t.bbox[3], t.bbox[2]]) : null;
