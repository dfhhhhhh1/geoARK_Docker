import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Globe, Sparkles, Search, BarChart2 } from 'lucide-react';

/**
 * Site navigation.
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
  { to: '/analysis', label: 'Analysis', icon: Sparkles,
    hint: 'Ask a question, get a map' },
  { to: '/data-search', label: 'Browse data', icon: Search,
    hint: 'What is in the catalog' },
  { to: '/csv-report', label: 'CSV tools', icon: BarChart2,
    hint: 'Analyze your own file' },
];

const Header: React.FC = () => {
  const { pathname } = useLocation();

  return (
    <header className="bg-white shadow-sm border-b border-slate-200">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <Link to="/analysis" className="flex items-center space-x-3 group">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-teal-600 rounded-lg
                            flex items-center justify-center">
              <Globe className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 group-hover:text-blue-700
                             transition-colors">
                GeoARK
              </h1>
              <p className="text-xs text-slate-500">Geospatial Data Platform</p>
            </div>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label, icon: Icon, hint }) => {
              const active = pathname === to;
              return (
                <Link
                  key={to}
                  to={to}
                  title={hint}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium ' +
                    'transition-colors ' +
                    (active
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50')
                  }
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
    </header>
  );
};

export default Header;
