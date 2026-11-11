import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { MapContainer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AnalysisResponse } from '../types';
import ChoroplethMap from './ChoroplethMap';
import LayerStack from './LayerStack';
import AddLayerMenu, { type LayerSource } from './AddLayerMenu';
import { layersOf, type StackLayer } from '../lib/layers';
import FeatureMap from './FeatureMap';
import ErrorBoundary from './ErrorBoundary';
import { BaseLayers, BasemapPicker, StageZoom, fitOptions, type FitPadding } from './MapControls';
import { basemapById, loadBasemapId, saveBasemapId } from '../lib/basemaps';
import { outcomeLabelOf } from '../lib/series';

/**
 * The full-screen map behind the analysis page.
 *
 * The map IS the answer, so it gets the whole window and everything else --
 * header, conversation, controls, legend -- floats over it as glass. This
 * component decides which map a result needs; the map components themselves
 * are the same ones the inline views use, in their `stage` variant.
 *
 * One map at a time. The answer on screen is the conversation's ACTIVE turn:
 * clicking back to an earlier answer puts its map here. Each answer remounts
 * the map (keyed on the turn), which also gives it a clean fit to its data.
 */

/** The lower 48, which is what "the country" means for a first view. */
const CONUS: L.LatLngBoundsExpression = [[24.5, -125], [49.5, -66.9]];

const FitConus: React.FC<{ padding?: FitPadding; nonce: number }> = ({ padding, nonce }) => {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(CONUS, fitOptions(padding, 16));
  }, [map, padding, nonce]);
  return null;
};

/**
 * The map with no answer on it: before the first question, and behind a
 * result that has no counties to draw (a correlation is one number).
 *
 * `decorative` is for the pages that are not about a map -- it is a backdrop
 * there, so it takes no input at all rather than stealing scrolls.
 */
export const IdleMap: React.FC<{ fitPadding?: FitPadding; decorative?: boolean }> =
  ({ fitPadding, decorative = false }) => {
    const mapRef = useRef<L.Map | null>(null);
    const [nonce, setNonce] = React.useState(0);
    // A backdrop is always the quiet basemap; imagery behind a page of text is
    // noise. The stage follows whatever the user last picked, and can be
    // changed here before any question is asked. The choice is saved, so the
    // answer's map opens on the same basemap.
    const [basemapId, setBasemapId] = React.useState(() => loadBasemapId('light'));
    const basemap = basemapById(decorative ? 'light' : basemapId);
    const chooseBasemap = (id: string) => { setBasemapId(id); saveBasemapId(id); };
    return (
      // z-0 makes this a stacking context, so Leaflet's panes (z-index 400+)
      // cannot paint over anything layered on top of the map.
      <div className="absolute inset-0 z-0" aria-hidden={decorative || undefined}>
        <MapContainer
          ref={mapRef}
          center={[39.5, -98.35]}
          zoom={4}
          zoomControl={false}
          attributionControl={!decorative}
          dragging={!decorative}
          scrollWheelZoom={!decorative}
          doubleClickZoom={!decorative}
          touchZoom={!decorative}
          keyboard={!decorative}
          boxZoom={!decorative}
          style={{ height: '100%', width: '100%' }}
        >
          <BaseLayers basemap={basemap} />
          <FitConus padding={fitPadding} nonce={nonce} />
        </MapContainer>
        {!decorative && (
          <div className="absolute right-3 z-[600] flex flex-col items-end gap-2 pointer-events-none"
               style={{ top: 'var(--header-offset)' }}>
            <div className="pointer-events-auto glass glass-raisable glass-floor rounded-2xl px-3 py-2">
              <BasemapPicker basemapId={basemapId} onBasemap={chooseBasemap} />
            </div>
            <StageZoom mapRef={mapRef} onReset={() => setNonce(n => n + 1)} />
          </div>
        )}
      </div>
    );
  };

interface Props {
  result: AnalysisResponse | null;
  /** Identifies the answer; a new one remounts the map. */
  resultKey: string | null;
  focus: { fips: string; nonce: number } | null;
  fitPadding: FitPadding;
  /** Layers the reader added on top of this answer (components/AddLayerMenu). */
  extraLayers?: StackLayer[];
  onAddLayers?: (layers: StackLayer[]) => void;
  onRemoveLayer?: (key: string) => void;
  /** What can be added from the conversation: earlier answers, workflow steps. */
  layerSources?: LayerSource[];
}

/**
 * MORE THAN ONE LAYER. An answer with several outputs, a two-measure join, or
 * anything the reader added goes to the layer stack (LayerStack), where each
 * layer has its own colours, classes, opacity and place in the order. A single
 * layer keeps the full single-measure map, which has behaviour the stack does
 * not need (series switching, the diverging legend), plus an "Add layer"
 * button that turns it into a stack.
 */
const MapStage: React.FC<Props> = ({
  result, resultKey, focus, fitPadding, extraLayers = [], onAddLayers, onRemoveLayer, layerSources = [],
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [resultKey]);
  const base = useMemo(() => layersOf(result, 'ans', 'This answer'), [result]);
  const idle = <IdleMap fitPadding={fitPadding} />;

  const present = new Set([...base, ...extraLayers].map(l => l.key));
  const menu = menuOpen && onAddLayers ? (
    <AddLayerMenu sources={layerSources} present={present}
                  onAdd={ls => { onAddLayers(ls); setMenuOpen(false); }}
                  onClose={() => setMenuOpen(false)} />
  ) : null;

  if (base.length > 1 || extraLayers.length > 0) {
    return (
      <ErrorBoundary key={resultKey ?? 'none'} label="the map">
        <LayerStack
          layers={[...extraLayers, ...base]}
          intent={result?.plan.intent ?? 'Layers'}
          focus={focus}
          fitPadding={fitPadding}
          onAdd={onAddLayers ? () => setMenuOpen(o => !o) : undefined}
          onRemove={onRemoveLayer}
          addMenu={menu}
        />
      </ErrorBoundary>
    );
  }

  if (!result || result.execution_error || result.stats) return idle;

  // A single layer: the full map, with the button that starts a stack.
  const addButton = onAddLayers ? (
    <button type="button" onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen}
            className="inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg
                       bg-ink text-white hover:bg-brand-700 transition-colors">
      <Plus className="w-3.5 h-3.5" /> Add layer
    </button>
  ) : null;
  const floatingMenu = menu && (
    <div className="absolute right-3 z-[650] w-[min(25rem,calc(100vw-1.5rem))]"
         style={{ top: 'calc(var(--header-offset) + 3.75rem)' }}>
      {menu}
    </div>
  );

  const rows = result.rows ?? [];
  const features = result.features ?? [];
  const layers = result.layers ?? [];
  const common = { fitPadding, variant: 'stage' as const };

  let map: React.ReactNode = idle;
  if (result.explain) {
    // The ranking says what tracks the outcome; the map says where it is high.
    if (rows.length) {
      const label = outcomeLabelOf(result) ?? result.plan.intent;
      map = <ChoroplethMap rows={rows} intent={label} result={result} focus={focus} {...common} />;
    }
  } else if (layers.length === 1 && layers[0].mode === 'features') {
    map = <FeatureMap features={layers[0].features ?? []} intent={result.plan.intent}
                      toolbarExtra={addButton} {...common} />;
  } else if (result.output_mode === 'features') {
    if (features.length) {
      map = <FeatureMap features={features} intent={result.plan.intent} toolbarExtra={addButton} {...common} />;
    }
  } else if (rows.length) {
    map = (
      <ChoroplethMap rows={rows} intent={result.plan.intent} result={result}
                     diverging={result.diverging} valueLabel={result.value_label ?? null}
                     focus={focus} toolbarExtra={addButton} {...common} />
    );
  }

  return (
    // Keyed on the answer, so a map that failed for one result does not leave
    // the boundary tripped for the next.
    <ErrorBoundary key={resultKey ?? 'none'} label="the map">
      {map}
      {floatingMenu}
    </ErrorBoundary>
  );
};

export default MapStage;
