import React from 'react';
import { TileLayer } from 'react-leaflet';
import type L from 'leaflet';
import { Layers, Droplet, Plus, Minus, Maximize } from 'lucide-react';
import type { Basemap } from '../lib/basemaps';
import { BASEMAPS } from '../lib/basemaps';

/**
 * Map furniture shared by ChoroplethMap and FeatureMap.
 *
 * The controls live OUTSIDE the MapContainer, in a plain toolbar above it.
 * Leaflet stops propagation on its own control panes, so an interactive React
 * control placed inside the map has to fight it for wheel, drag and click
 * events -- a slider in particular pans the map while being dragged unless
 * every handler is intercepted. A toolbar has none of that, and it keeps the
 * whole map area available for the map.
 */

/** The base tiles plus, for imagery, the transparent labels layer over them. */
export const BaseLayers: React.FC<{ basemap: Basemap }> = ({ basemap }) => (
  <>
    <TileLayer
      // Leaflet mutates a TileLayer in place when props change, and that leaves
      // the previous tiles faded underneath during the swap. Remounting per
      // basemap gives a clean replacement.
      key={basemap.id}
      url={basemap.url}
      attribution={basemap.attribution}
      maxZoom={basemap.maxZoom}
    />
    {basemap.overlayUrl && (
      <TileLayer
        key={`${basemap.id}-labels`}
        url={basemap.overlayUrl}
        maxZoom={basemap.maxZoom}
        // Labels must sit above the data, or county fills bury the place names
        // that are the reason for having them.
        zIndex={650}
      />
    )}
  </>
);

interface ToolbarProps {
  basemapId: string;
  onBasemap: (id: string) => void;
  opacity: number;
  onOpacity: (v: number) => void;
  /** Named so the slider says what it is making transparent. */
  opacityLabel: string;
  children?: React.ReactNode;
  /** Replaces the default row layout, e.g. inside a floating glass pill. */
  className?: string;
}

export const MapToolbar: React.FC<ToolbarProps> = ({
  basemapId, onBasemap, opacity, onOpacity, opacityLabel, children,
  className = 'flex flex-wrap items-center gap-x-4 gap-y-2 mb-2.5',
}) => (
  <div className={className}>
    {children}

    <div className="flex items-center gap-1.5">
      <Layers className="w-4 h-4 text-slate-400" aria-hidden />
      <div className="flex rounded-lg border border-slate-300 overflow-hidden">
        {BASEMAPS.map(b => (
          <button
            key={b.id}
            type="button"
            onClick={() => onBasemap(b.id)}
            aria-pressed={basemapId === b.id}
            className={`px-2.5 py-1 text-xs transition-colors border-r border-slate-300
                        last:border-r-0 ${
              basemapId === b.id
                ? 'bg-brand-600 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>

    <label className="flex items-center gap-1.5 text-xs text-slate-600">
      <Droplet className="w-4 h-4 text-slate-400" aria-hidden />
      <span className="sr-only">{opacityLabel} opacity</span>
      <input
        type="range"
        min={10}
        max={100}
        step={5}
        value={Math.round(opacity * 100)}
        onChange={e => onOpacity(Number(e.target.value) / 100)}
        className="w-24 accent-brand-600 cursor-pointer"
        aria-label={`${opacityLabel} opacity`}
      />
      <span className="tabular-nums text-slate-500 w-8">{Math.round(opacity * 100)}%</span>
    </label>
  </div>
);

/**
 * How the map is drawn.
 *
 * `inline` is a bordered box inside a card, with its controls in a toolbar
 * above it. `stage` fills its positioned parent -- the full-screen map behind
 * the analysis page -- and its controls float over it as glass.
 */
export type MapVariant = 'inline' | 'stage';

/**
 * Padding for fitting the view, in pixels. On the stage the chat panel and
 * header cover part of the map, and data framed under them is data hidden.
 */
export interface FitPadding {
  topLeft: [number, number];
  bottomRight: [number, number];
}

export const fitOptions = (p: FitPadding | undefined, fallback: number): L.FitBoundsOptions =>
  p ? { paddingTopLeft: p.topLeft, paddingBottomRight: p.bottomRight }
    : { padding: [fallback, fallback] };

/**
 * Zoom buttons for the stage.
 *
 * Leaflet's own control sits in a map corner, and every corner of a full-screen
 * map is under some piece of floating chrome. These live in the overlay column
 * instead, and the third button re-frames the data after the user has wandered.
 */
export const StageZoom: React.FC<{
  mapRef: React.MutableRefObject<L.Map | null>;
  onReset: () => void;
}> = ({ mapRef, onReset }) => {
  const btn = 'p-2 text-slate-700 hover:text-ink hover:bg-white/60 transition-colors';
  return (
    <div className="pointer-events-auto glass glass-raisable glass-floor rounded-xl flex flex-col overflow-hidden">
      <button type="button" className={btn} onClick={() => mapRef.current?.zoomIn()}
              title="Zoom in" aria-label="Zoom in">
        <Plus className="w-4 h-4" />
      </button>
      <button type="button" className={`${btn} border-t border-slate-300`}
              onClick={() => mapRef.current?.zoomOut()} title="Zoom out" aria-label="Zoom out">
        <Minus className="w-4 h-4" />
      </button>
      <button type="button" className={`${btn} border-t border-slate-300`} onClick={onReset}
              title="Frame the data again" aria-label="Reset view">
        <Maximize className="w-4 h-4" />
      </button>
    </div>
  );
};
