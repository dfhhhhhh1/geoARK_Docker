import React, { useEffect, useRef } from 'react';
import { MapContainer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { AnalysisResponse } from '../types';
import ChoroplethMap from './ChoroplethMap';
import LayeredMap from './LayeredMap';
import FeatureMap from './FeatureMap';
import ErrorBoundary from './ErrorBoundary';
import { BaseLayers, StageZoom, fitOptions, type FitPadding } from './MapControls';
import { basemapById, loadBasemapId } from '../lib/basemaps';
import { outcomeLabelOf } from '../lib/series';
import { OP_LABEL } from '../lib/ops';

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
    // noise. The stage follows whatever the user last picked.
    const basemap = basemapById(decorative ? 'light' : loadBasemapId('light'));
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
          <div className="absolute right-3 z-[600]" style={{ top: 'var(--header-offset)' }}>
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
}

const MapStage: React.FC<Props> = ({ result, resultKey, focus, fitPadding }) => {
  const idle = <IdleMap fitPadding={fitPadding} />;
  if (!result || result.execution_error || result.stats) return idle;

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
  } else if (layers.length > 1) {
    const values = layers.filter(l => l.mode === 'values');
    const firstFeatures = layers.find(l => l.mode === 'features' && (l.features?.length ?? 0) > 0);
    // Values layers share one map so they can be compared through each other.
    // A feature layer alongside them is drawn in the conversation panel, since
    // it has its own geometry and would need its own map.
    if (values.length) {
      map = (
        <LayeredMap layers={values} intent={result.plan.intent} focus={focus}
                    describe={l => `${OP_LABEL[l.op] ?? l.op}${l.part ? ' (component)' : ''}`}
                    {...common} />
      );
    } else if (firstFeatures) {
      map = <FeatureMap features={firstFeatures.features ?? []} intent={result.plan.intent} {...common} />;
    }
  } else if (result.output_mode === 'features') {
    if (features.length) map = <FeatureMap features={features} intent={result.plan.intent} {...common} />;
  } else if (rows.length) {
    map = (
      <ChoroplethMap rows={rows} intent={result.plan.intent} result={result}
                     diverging={result.diverging} valueLabel={result.value_label ?? null}
                     focus={focus} {...common} />
    );
  }

  return (
    // Keyed on the answer, so a map that failed for one result does not leave
    // the boundary tripped for the next.
    <ErrorBoundary key={resultKey ?? 'none'} label="the map">{map}</ErrorBoundary>
  );
};

export default MapStage;
