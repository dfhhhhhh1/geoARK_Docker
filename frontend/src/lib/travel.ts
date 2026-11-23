import type { FeatureStyle, MappedFeature } from '../types';

/**
 * Colours for travel answers (backend ops/service_area.js, ops/route.js):
 * travel-time bands around facilities, and routes binned by minutes.
 *
 * One ORDERED ramp, nearest first, blue through teal and yellow to red: the
 * bands must read as "closer -> farther" at a glance, and neighbouring bands
 * must still be told apart when there are six of them. It is not one of the
 * choropleth ramps on purpose: a travel band is not a county value, and
 * drawing both on the same ramp would invite comparing them.
 */
const TRAVEL_LIGHT = ['#1d4e89', '#1f7a8c', '#2a9d8f', '#8ab17d', '#e9c46a', '#f4a261', '#e76f51', '#b5302a'];
const TRAVEL_DARK = ['#4c8bd6', '#3fb0c4', '#45c4b0', '#a7cf8f', '#f1d37e', '#f6b07a', '#ef8a6f', '#e0574f'];

/** n colours from the travel ramp, spread across it. */
export function travelColors(n: number, isDark: boolean): string[] {
  const ramp = isDark ? TRAVEL_DARK : TRAVEL_LIGHT;
  if (n <= 1) return [ramp[0]];
  return Array.from({ length: n }, (_, i) => ramp[Math.round((i / (n - 1)) * (ramp.length - 1))]);
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Round breaks for a ramp over route values: 5 equal steps on a nice unit. */
function rampBreaks(values: number[]): number[] {
  if (!values.length) return [];
  const max = Math.max(...values);
  if (!(max > 0)) return [];
  const raw = max / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  return Array.from({ length: 4 }, (_, i) => +(step * (i + 1)).toFixed(6)).filter(b => b < max);
}

const fmtN = (v: number) => (Math.abs(v) >= 10 ? String(Math.round(v)) : String(+v.toFixed(1)));

export interface TravelScale {
  /** Upper limit of each class; a value goes in the first class it is <= of. */
  stops: number[];
  colors: string[];
  labels: string[];
  colorOf: (f: MappedFeature) => string;
}

/**
 * The classes a travel layer is drawn in. Bands use the stops the backend
 * declared (each feature IS a band); a ramp bins the features' own values.
 */
export function travelScale(style: FeatureStyle, features: MappedFeature[], isDark: boolean): TravelScale | null {
  const by = style.by;
  if (!by || (style.kind !== 'bands' && style.kind !== 'ramp')) return null;
  const unit = style.unit === 'miles' ? 'mi' : 'min';
  let stops: number[];
  let labels: string[];
  if (style.kind === 'bands' && style.stops?.length) {
    stops = style.stops;
    labels = style.labels?.length === stops.length ? style.labels
      : stops.map((s, i) => `${i ? fmtN(stops[i - 1]) : 0}–${fmtN(s)} ${unit}`);
  } else {
    const values = features.map(f => num(f.properties[by])).filter((v): v is number => v !== null);
    const b = rampBreaks(values);
    const max = values.length ? Math.max(...values) : 0;
    stops = [...b, max];
    labels = stops.map((s, i) => (i === stops.length - 1
      ? (i ? `> ${fmtN(stops[i - 1])} ${unit}` : `≤ ${fmtN(s)} ${unit}`)
      : `${i ? fmtN(stops[i - 1]) : 0}–${fmtN(s)} ${unit}`));
  }
  const colors = travelColors(stops.length, isDark);
  const colorOf = (f: MappedFeature) => {
    const v = num(f.properties[by]);
    if (v === null) return colors[colors.length - 1];
    const i = stops.findIndex(s => v <= s + 1e-9);
    return colors[i < 0 ? colors.length - 1 : i];
  };
  return { stops, colors, labels, colorOf };
}

/** A short layer name for a travel answer's layer, from its style. */
export function travelLayerName(style: FeatureStyle | null | undefined, features: MappedFeature[] = []): string | null {
  if (!style) return null;
  // raster_calc: where a raster condition holds, named by the condition.
  if (style.kind === 'mask') {
    const c = features[0]?.properties?.condition;
    return c ? `Where ${c}` : 'Where the condition holds';
  }
  if (style.kind === 'bands') {
    const u = style.unit === 'miles' ? 'mi' : 'min';
    return `Travel bands (${(style.stops ?? []).map(fmtN).join(', ')} ${u})`;
  }
  if (style.kind === 'ramp') return 'Routes';
  return null;
}

/** Per band: its area and people, read off the band features, for the legend. */
export function bandFacts(features: MappedFeature[], by: string): Map<number, { area?: number; people?: number }> {
  const out = new Map<number, { area?: number; people?: number }>();
  for (const f of features) {
    const k = num(f.properties[by]);
    if (k === null) continue;
    out.set(k, { area: num(f.properties.area_sq_mi) ?? undefined, people: num(f.properties.people) ?? undefined });
  }
  return out;
}
