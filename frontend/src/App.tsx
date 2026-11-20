import React from 'react';
import DataCartPage from './components/DataCartPage';
import Header from './components/Header';
import ReportPage from './components/ReportPage';
import AnalysisPage from './components/AnalysisPage';
import ExplorePage from './components/ExplorePage';
import LoginGate from './components/LoginGate';
import { IdleMap } from './components/MapStage';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

function App() {
  return (
    <LoginGate>
    <BrowserRouter>
      <Header />

      <Routes>
        {/* Analysis is the front door: it is the thing that answers a
            question. Browsing the catalog is how you find out what can be
            asked about. */}
        <Route path="/" element={<Navigate replace to="/analysis" />} />

        {/* Full-screen: the map is the page, and everything floats over it. */}
        <Route path="/analysis" element={<AnalysisPage />} />

        {/* The data cart (docs/DATA_CART_PLAN.md): ask for data, get a
            suggested set with reasons, download one table with its sources. */}
        <Route path="/data-search" element={<BackdropPage><DataCartPage /></BackdropPage>} />

        <Route path="/csv-report" element={<BackdropPage><ReportPage /></BackdropPage>} />

        {/* Any loaded measure at the finest level that fits the view: real
            units with real values (backend/geo_layers.js), unlike the old
            /map-explorer below. */}
        <Route path="/explore" element={<ExplorePage />} />

        {/* /map-explorer is deliberately absent: it plotted datasets at
            coordinates derived from a hash of their id. Anything still
            linking to it lands on the analysis page rather than a blank. */}
        <Route path="*" element={<Navigate replace to="/analysis" />} />
      </Routes>

    </BrowserRouter>
    </LoginGate>
  );
}

/**
 * The pages that are documents rather than maps scroll normally, over the same
 * map held still and washed out, so moving between them and the analysis does
 * not feel like leaving the product.
 */
const BackdropPage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <>
    <div className="fixed inset-0 z-0 map-stage" aria-hidden>
      <IdleMap decorative />
      <div className="absolute inset-0 bg-[#f3f1ec]/85" />
    </div>
    <div className="relative z-10 pt-[var(--header-offset)] min-h-full">{children}</div>
  </>
);

export default App;