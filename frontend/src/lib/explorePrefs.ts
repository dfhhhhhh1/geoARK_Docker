import { SEQUENTIAL_RAMPS, type Ramp } from './basemaps';

/**
 * Viewing preferences for the Explore page, remembered in this browser: the
 * colour ramp and opacity of each layer, the fine-point settings (so hiding
 * the points and showing them again brings back what was chosen), and whether
 * the control panel is collapsed. A preference, never data: storage can be
 * unavailable, and everything falls back to a default.
 */

export const PLASMA: Ramp = {
  id: 'plasma', label: 'Plasma',
  // Without plasma's pale-yellow end, which vanishes on the light basemap.
  light: ['#0d0887', '#5302a3', '#8b0aa5', '#b83289', '#db5c68', '#f48849'],
  dark: ['#0d0887', '#5302a3', '#8b0aa5', '#b83289', '#db5c68', '#f48849'],
};

export const AREA_RAMPS: Ramp[] = SEQUENTIAL_RAMPS;
export const POINT_RAMPS: Ramp[] = [PLASMA, ...SEQUENTIAL_RAMPS];

export interface AreaPrefs { ramp: string; opacity: number }
export interface PointPrefs {
  pts: string;
  ptmode: 'auto' | 'points' | 'cells';
  ptscale: 'all' | 'view';
  areas: boolean;
  ramp: string;
  opacity: number;
}

const AREA_KEY = 'geoark.explore.areas';
const POINT_KEY = 'geoark.explore.points';
const PANEL_KEY = 'geoark.explore.panelCollapsed';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* not worth surfacing */ }
}

export const DEFAULT_AREA: AreaPrefs = { ramp: 'blue', opacity: 0.78 };
export const DEFAULT_POINTS: PointPrefs = {
  pts: 'hosp_mi', ptmode: 'auto', ptscale: 'all', areas: false, ramp: 'plasma', opacity: 0.9,
};

export const loadAreaPrefs = () => read(AREA_KEY, DEFAULT_AREA);
export const saveAreaPrefs = (p: AreaPrefs) => write(AREA_KEY, p);
export const loadPointPrefs = () => read(POINT_KEY, DEFAULT_POINTS);
export const savePointPrefs = (p: Partial<PointPrefs>) => write(POINT_KEY, { ...loadPointPrefs(), ...p });

export function loadPanelCollapsed(): boolean {
  try { return window.localStorage.getItem(PANEL_KEY) === '1'; } catch { return false; }
}
export function savePanelCollapsed(v: boolean) {
  try { window.localStorage.setItem(PANEL_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

export const rampById = (list: Ramp[], id: string) => list.find(r => r.id === id) ?? list[0];
