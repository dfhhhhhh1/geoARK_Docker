import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Contrast } from 'lucide-react';
import { useLegibility } from '../hooks/useLegibility';

/**
 * Site navigation, floating over the map as a glass bar.
 *
 * Ordered by what the product actually is: Analysis is the front door, because
 * it is the thing that answers a question. Catalog search is a way of finding
 * out what data exists, and the CSV tool is a separate utility that happens to
 * live here.
 *
 * The data cart is gone. Its checkout opened /api/download, which the backend
 * has never implemented, so the whole flow ended in a 404 after asking people
 * to collect things. Map Explorer is gone for a worse reason: it plotted
 * datasets at coordinates derived from a hash of their id, inside a hardcoded
 * Missouri bounding box. Those positions were invented, and shown next to real
 * ones.
 */
const NAV = [
  { to: '/analysis', label: 'Analysis', short: 'Analysis', hint: 'Ask a question, get a map' },
  { to: '/data-search', label: 'Browse data', short: 'Data', hint: 'What is in the catalog' },
  { to: '/csv-report', label: 'CSV tools', short: 'CSV', hint: 'Analyze your own file' },
];

const Header: React.FC = () => {
  const { pathname } = useLocation();
  const [legible, setLegible] = useLegibility();

  return (
    <header className="fixed top-3 inset-x-3 z-[1150] h-14 rounded-2xl glass glass-raisable glass-floor
                       flex items-center gap-2 sm:gap-3 pl-3 sm:pl-4 pr-2">
      <Link to="/analysis" className="shrink-0 flex items-center" aria-label="GeoARK home">
        <img src="/brand/geoark-dark.webp" alt="GeoARK" className="h-5 sm:h-7 w-auto select-none"
             draggable={false} />
      </Link>

      <nav className="flex items-center gap-0.5 sm:gap-1 ml-auto sm:ml-4 min-w-0">
        {NAV.map(({ to, label, short, hint }) => {
          const active = pathname === to;
          return (
            <Link
              key={to}
              to={to}
              title={hint}
              aria-current={active ? 'page' : undefined}
              className={
                'px-2.5 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium whitespace-nowrap ' +
                'transition-colors ' +
                (active
                  ? 'bg-ink text-white'
                  : 'text-slate-700 hover:text-ink hover:bg-white/60')
              }
            >
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Readable mode. Glass is a real legibility cost for some people, and
          on satellite imagery for everybody, so the way out is one click and
          labelled, not buried in a settings page. */}
      <button
        type="button"
        onClick={() => setLegible(!legible)}
        aria-pressed={legible}
        title={legible
          ? 'Readable mode is on: panels are solid. Click to return to glass.'
          : 'Readable mode: make every panel solid and higher-contrast'}
        className={`sm:ml-auto shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium
                    border transition-colors ${
          legible
            ? 'bg-ink text-white border-ink'
            : 'border-slate-300 text-slate-700 hover:bg-white/60'}`}
      >
        <Contrast className="w-4 h-4" aria-hidden />
        <span className="hidden md:inline">Readable</span>
        <span className="sr-only md:hidden">Readable mode</span>
      </button>
    </header>
  );
};

export default Header;
