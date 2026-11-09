import type { FeatureCollection, Geometry } from 'geojson';

/**
 * Client for the multi-scale map API (backend/geo_layers.js).
 *
 * The server decides the level: the finest one whose unit count in the view
 * fits its budget. The client only says what it is looking at (bbox, zoom)
 * and, optionally, which level or family it wants instead.
 */

export interface Derivation {
  from: string;
  method: 'sum' | 'wmean';
  weight: string | null;
}

export interface GeoLevel {
  level: string;
  label: string;
  family: 'admin' | 'grid';
  /** Not stored: estimated from a finer level (geoark_aggregate). */
  derived?: Derivation;
  /** Stored, with gaps (e.g. Connecticut) filled from a finer level. */
  fill?: Derivation;
  min_year?: number;
  max_year?: number;
  n_units?: number | null;
}

export interface GeoMeasure {
  code: string;
  label: string;
  units: string | null;
  dataset: string;
  dataset_id: string;
  source_url: string | null;
  originator: string | null;
  is_count: boolean;
  raster?: { id: string; aggregate: string };
  levels: GeoLevel[];
}

export interface GeoCatalog {
  measures: GeoMeasure[];
  level_labels: Record<string, string>;
}

export interface UnitProps {
  id: string;
  name: string | null;
  /** The stored value. */
  value: number | null;
  /** What is coloured: the value, or the value per km² for counts. */
  shown: number | null;
  km2: number | null;
  /** Present when the value is an estimate built from finer units. */
  derived?: {
    from: string; from_label: string; method: 'sum' | 'wmean'; weight: string | null;
    parts: number; coverage: number | null;
  } | null;
}

export interface LayerLevelInfo {
  level: string;
  label: string;
  family: 'admin' | 'grid';
  in_view: number | null;
  budget: number;
  years: [number, number];
  derived?: boolean;
}

export interface GeoLayerResponse {
  code: string;
  label: string;
  units: string | null;
  dataset: string;
  source_url: string | null;
  level: string;
  level_label: string;
  year: number;
  per: 'km2' | 'none';
  is_count: boolean;
  reason: string;
  levels: LayerLevelInfo[];
  finer_available: { level: string; label: string; in_view: number }[];
  too_many: boolean;
  in_view: number;
  /** How many units in view are estimates, and how they were made. */
  estimated?: {
    count: number; whole_level: boolean; from: string; from_label: string;
    method: 'sum' | 'wmean'; weight: string | null;
  } | null;
  features: FeatureCollection<Geometry, UnitProps>;
  /** National breaks, and the percentiles they sit at. */
  bins: { breaks: number[]; min: number; max: number; quantiles?: number[] };
  ms: number;
}

export interface LayerQuery {
  code: string;
  bbox: [number, number, number, number];
  z: number;
  level?: string;           // 'auto' or a level
  family?: 'admin' | 'grid';
  per?: 'km2' | 'none';
}

export async function fetchGeoCatalog(signal?: AbortSignal): Promise<GeoCatalog> {
  const r = await fetch('/api/geo/catalog', { signal, credentials: 'same-origin' });
  if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`);
  return r.json();
}

export async function fetchGeoLayer(q: LayerQuery, signal?: AbortSignal): Promise<GeoLayerResponse> {
  const p = new URLSearchParams({
    code: q.code,
    bbox: q.bbox.map(v => v.toFixed(5)).join(','),
    z: String(Math.round(q.z * 10) / 10),
  });
  if (q.level && q.level !== 'auto') p.set('level', q.level);
  if (q.family) p.set('family', q.family);
  if (q.per) p.set('per', q.per);
  const r = await fetch(`/api/geo/layer?${p}`, { signal, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `layer: HTTP ${r.status}`);
  // Anything else (an HTML error page from a proxy, a partial body) must not
  // reach the map as if it were a layer.
  if (!Array.isArray(j.levels) || !j.features || !j.bins) {
    throw new Error('layer: unexpected response from the server');
  }
  return j as GeoLayerResponse;
}

/** Bin index for a value: the first break it does not exceed. */
export function binOf(v: number, breaks: number[]): number {
  for (let i = 0; i < breaks.length; i++) if (v <= breaks[i]) return i;
  return breaks.length;
}

/** "people per km²", "percent", ... for the legend and readout. */
export function unitLabel(units: string | null, per: 'km2' | 'none'): string {
  const u = (units || '').trim();
  if (per === 'km2') return `${u || 'per unit'} per km²`.replace(/^persons per/, 'people per');
  return u;
}

let catalogPromise: Promise<GeoCatalog> | null = null;

/** One catalog fetch per page load; answers ask for it every time they render. */
export function getGeoCatalogCached(): Promise<GeoCatalog> {
  if (!catalogPromise) {
    catalogPromise = fetchGeoCatalog().catch(e => { catalogPromise = null; throw e; });
  }
  return catalogPromise;
}
