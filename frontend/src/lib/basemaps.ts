/**
 * Basemap choices, shared by both map components.
 *
 * WHY MORE THAN ONE. A choropleth and a satellite image want opposite things
 * from the layer underneath. Data drawn in color needs a base that carries no
 * color of its own, or the fill and the terrain compete and neither is
 * readable; locations of individual places need context that a grey abstraction
 * cannot give, which is what imagery is for. So the default differs by
 * component rather than being one compromise: `light` under a choropleth,
 * `streets` under features.
 *
 * EXTERNAL DEPENDENCY, STATED PLAINLY. These are public tile services. The
 * project's "no cloud APIs" rule is about inference -- no question or result
 * ever leaves the machine -- and tiles were already fetched from OpenStreetMap
 * before this file existed. What is new is that a second and third host now see
 * the same thing a tile request always revealed: the area being looked at, not
 * the question asked. None of them need an API key. If this is deployed
 * somewhere that must be fully self-contained, point every `url` below at a
 * local tile server; nothing else has to change.
 */

/**
 * CARTO basemaps now require a key, and without one every tile carries an
 * "API key required" watermark.
 *
 * It is read from the environment rather than hardcoded, but understand what
 * kind of secret this is: Vite inlines every VITE_-prefixed value into the
 * browser bundle, and a tile URL is fetched by the visitor's browser, so this
 * key is PUBLIC by construction. Keeping it out of the source tree stops it
 * being committed to a public repository; it does not keep it private from
 * anyone using the site. Scope and rotate it accordingly.
 */
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY ?? '';

/** CARTO raster tiles, with the key appended when one is configured. */
const carto = (style: string): string =>
  `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png` +
  (CARTO_KEY ? `?key=${CARTO_KEY}` : '');

export interface Basemap {
  id: string;
  label: string;
  url: string;
  attribution: string;
  maxZoom: number;
  /** Drawn over the base, for imagery that carries no place names. */
  overlayUrl?: string;
  /** True when the base is dark, so map furniture can invert against it. */
  dark?: boolean;
}

export const BASEMAPS: Basemap[] = [
  {
    id: 'light',
    label: 'Light',
    // Positron is deliberately desaturated, which is exactly what a choropleth
    // needs: the only saturated color on screen should be the data.
    url: carto('light_all'),
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  },
  {
    id: 'streets',
    label: 'Streets',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  {
    id: 'satellite',
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    // World Imagery ships no labels at all, so a county fill sits over
    // unidentifiable ground. The reference overlay is a separate transparent
    // layer for exactly this pairing.
    overlayUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Imagery &copy; <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics, ' +
      'and the GIS User Community',
    maxZoom: 19,
    dark: true,
  },
  {
    id: 'terrain',
    label: 'Terrain',
    url: carto('rastertiles/voyager'),
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  },
  {
    id: 'dark',
    label: 'Dark',
    url: carto('dark_all'),
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
    dark: true,
  },
];

export const basemapById = (id: string): Basemap =>
  BASEMAPS.find(b => b.id === id) ?? BASEMAPS[0];

/**
 * The chosen basemap, remembered across analyses.
 *
 * Re-picking "Satellite" after every question would be tedious, and the choice
 * is a viewing preference rather than a property of any one result. Kept in
 * localStorage, which is allowed to be absent or unwritable (private windows,
 * storage disabled) -- hence the try/catch rather than a feature test.
 */
const KEY = 'geoark.basemap';

export function loadBasemapId(fallback: string): string {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved && BASEMAPS.some(b => b.id === saved)) return saved;
  } catch { /* storage unavailable; the default is fine */ }
  return fallback;
}

export function saveBasemapId(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch { /* not worth surfacing */ }
}


/**
 * Colour scales for the choropleth.
 *
 * Sequential scales are all SINGLE-HUE, light to dark. A rainbow reads as
 * categorical and implies boundaries the data does not have, which is why none
 * is offered. Viridis is the exception and earns it: it is perceptually uniform
 * and survives greyscale printing, so equal steps in value look like equal
 * steps in colour.
 *
 * Diverging scales are only used for signed measures, and the selection is kept
 * separate: a hotspot drawn on a sequential ramp paints a cold spot and a hot
 * spot as two shades of one colour, which is not a styling preference but a
 * misstatement.
 */
export interface Ramp {
  id: string;
  label: string;
  light: string[];
  dark: string[];
}

export const SEQUENTIAL_RAMPS: Ramp[] = [
  { id: 'blue', label: 'Blue',
    light: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281'],
    dark:  ['#0d366b', '#184f95', '#256abf', '#3987e5', '#86b6ef', '#cde2fb'] },
  { id: 'viridis', label: 'Viridis',
    light: ['#fde725', '#90d743', '#35b779', '#21918c', '#31688e', '#443983'],
    dark:  ['#443983', '#31688e', '#21918c', '#35b779', '#90d743', '#fde725'] },
  { id: 'warm', label: 'Warm',
    light: ['#fee5d9', '#fcbba1', '#fc9272', '#fb6a4a', '#de2d26', '#a50f15'],
    dark:  ['#67000d', '#a50f15', '#de2d26', '#fb6a4a', '#fcbba1', '#fee5d9'] },
  { id: 'green', label: 'Green',
    light: ['#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#31a354', '#006d2c'],
    dark:  ['#00441b', '#006d2c', '#31a354', '#74c476', '#a1d99b', '#e5f5e0'] },
  { id: 'grey', label: 'Grey',
    light: ['#f0f0f0', '#d9d9d9', '#bdbdbd', '#969696', '#636363', '#252525'],
    dark:  ['#252525', '#636363', '#969696', '#bdbdbd', '#d9d9d9', '#f0f0f0'] },
];

export const DIVERGING_RAMPS: Ramp[] = [
  { id: 'redblue', label: 'Red / Blue',
    light: ['#2166ac', '#7fb0d5', '#d6e3ee', '#f7d9cb', '#df8062', '#b2182b'],
    dark:  ['#5b9bd5', '#3c7bb5', '#2f4858', '#6b3b33', '#c0554a', '#e8736a'] },
  { id: 'purplegreen', label: 'Purple / Green',
    light: ['#762a83', '#af8dc3', '#e7d4e8', '#d9f0d3', '#7fbf7b', '#1b7837'],
    dark:  ['#9970ab', '#762a83', '#40004b', '#00441b', '#1b7837', '#5aae61'] },
  { id: 'brownteal', label: 'Brown / Teal',
    light: ['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e'],
    dark:  ['#bf812d', '#8c510a', '#543005', '#003c30', '#01665e', '#35978f'] },
];

const RAMP_KEY = 'geoark.ramp';

export function rampsFor(diverging: boolean): Ramp[] {
  return diverging ? DIVERGING_RAMPS : SEQUENTIAL_RAMPS;
}

/** Remembered across analyses, like the basemap: it is a viewing preference. */
export function loadRampId(diverging: boolean): string {
  const list = rampsFor(diverging);
  try {
    const saved = window.localStorage.getItem(`${RAMP_KEY}.${diverging ? 'div' : 'seq'}`);
    if (saved && list.some(r => r.id === saved)) return saved;
  } catch { /* storage unavailable */ }
  return list[0].id;
}

export function saveRampId(diverging: boolean, id: string): void {
  try {
    window.localStorage.setItem(`${RAMP_KEY}.${diverging ? 'div' : 'seq'}`, id);
  } catch { /* not worth surfacing */ }
}
