import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ZoomIn } from 'lucide-react';
import type { AnalysisResponse } from '../types';
import { getGeoCatalogCached, type GeoCatalog, type GeoMeasure } from '../lib/geoLayers';

/**
 * "See this at a finer level" for an answer whose measure exists below county.
 *
 * Answers are still computed per county: the planner's ops have not been moved
 * onto other levels (docs/DATA_LOADING_PLAN.md, Phase 6). What CAN be offered
 * honestly is the same measure on the explore map, where it is drawn at the
 * finest level that fits the view. Shown only when the measure really has one,
 * stored or estimated, and the link says which.
 */

const FINER = new Set(['tract', 'bg', 'zcta', 'place', 'pixel', 'grid4k']);

const FinerLevels: React.FC<{ result: AnalysisResponse }> = ({ result }) => {
  // The catalog is the same for every answer: load it once, and derive the
  // offers from whichever answer is showing, synchronously. A per-answer async
  // effect left the offers empty after an in-place edit swapped the measure.
  const [catalog, setCatalog] = useState<GeoCatalog | null>(null);
  useEffect(() => {
    let live = true;
    const load = (retry: boolean) => getGeoCatalogCached()
      .then(c => { if (live) setCatalog(c); })
      .catch(() => { if (live && retry) window.setTimeout(() => void load(false), 3000); });
    void load(true);
    return () => { live = false; };
  }, []);

  const codes = (result.provenance?.attribute_origins ?? [])
    .map(o => o.census_code)
    .filter((c): c is string => Boolean(c));
  const key = codes.join('|');
  const measures: GeoMeasure[] = useMemo(
    () => (catalog ? catalog.measures.filter(m => key.split('|').includes(m.code)) : []),
    [catalog, key]);

  const offers = measures
    .map(m => ({ m, finer: m.levels.filter(l => FINER.has(l.level)) }))
    .filter(o => o.finer.length);
  if (!offers.length) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400 w-20 shrink-0">Zoom in</span>
      {offers.map(({ m, finer }) => {
        const raster = Boolean(m.raster);
        const names = finer.map(l => `${l.label.toLowerCase()}${l.derived ? ' (est.)' : ''}`).join(', ');
        return (
          <Link key={m.code}
                to={`/explore?code=${encodeURIComponent(m.code)}${raster ? '' : '&family=admin'}`}
                title={`${m.label}: also available as ${names}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border
                           border-slate-300 bg-white text-slate-700 hover:border-brand-400 hover:text-ink">
            <ZoomIn className="w-4 h-4" />
            {m.label.length > 48 ? `${m.label.slice(0, 46)}…` : m.label} by {names}
          </Link>
        );
      })}
    </div>
  );
};

export default FinerLevels;
