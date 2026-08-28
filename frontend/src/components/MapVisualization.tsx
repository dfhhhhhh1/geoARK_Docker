// MapVisualization.tsx
import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Rectangle, useMap, GeoJSON } from 'react-leaflet';
import { ZoomIn, ZoomOut, Layers, Move3D } from 'lucide-react';
import Papa from 'papaparse';
import 'leaflet/dist/leaflet.css';

// Fix for default marker icon issue with Webpack
interface Dataset {
// ... (existing Dataset interface)
  id: string;
  title: string;
  description: string;
  source: string;
  downloadUrl?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  boundingBox?: {
    north: number;
    south: number;
    east: number;
    west: number;
  };
  coverage: {
    geographic: string;
    temporal: string;
  };
}

interface MapVisualizationProps {
  datasets: Dataset[];
}

// Custom component to handle map interactions like zoom
const MapController: React.FC<{ zoomLevel: number }> = ({ zoomLevel }) => {
// ... (existing MapController)
  const map = useMap();
  useEffect(() => {
    map.setZoom(zoomLevel);
  }, [zoomLevel, map]);
  return null;
};

const MapVisualization: React.FC<MapVisualizationProps> = ({ datasets }) => {
  const [zoomLevel, setZoomLevel] = useState(3);
  const [showLayers, setShowLayers] = useState(true);
  const [countyData, setCountyData] = useState<any>(null);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<string>('');
  const [selectedDenominator, setSelectedDenominator] = useState<string>('None'); // 1. New State for Denominator
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [availableDenominators, setAvailableDenominators] = useState<string[]>(['None']); // New state for denominators
  
  // Load GeoJSON
  useEffect(() => {
// ... (existing GeoJSON load)
    fetch('/counties.geojson')
      .then(response => response.json())
      .then(data => {
        setCountyData(data);
      })
      .catch(error => console.error("Failed to load GeoJSON data:", error));
  }, []);

  // Load and parse CSV
  useEffect(() => {
    fetch('/usa_county.csv') // Replace with your CSV file path
      .then(response => response.text())
      .then(csvText => {
        Papa.parse(csvText, {
          header: true,
          dynamicTyping: true,
          skipEmptyLines: true,
          complete: (results) => {
            setCsvData(results.data);
            // Get available metrics (all columns except FIPS)
            if (results.data.length > 0) {
              const metrics = Object.keys(results.data[0]).filter(
                key => key.toLowerCase() !== 'fips'
              );
              setAvailableMetrics(metrics);
              // 2. Update Denominators List
              setAvailableDenominators(['None', ...metrics]); 
              if (metrics.length > 0) setSelectedMetric(metrics[0]);
            }
          },
          error: (error) => console.error("Failed to parse CSV:", error)
        });
      })
      .catch(error => console.error("Failed to load CSV:", error));
  }, []);

  const centerLat = datasets.length > 0
    ? datasets.reduce((sum, d) => sum + d.coordinates.lat, 0) / datasets.length
    : 39.8283;
  const centerLng = datasets.length > 0
    ? datasets.reduce((sum, d) => sum + d.coordinates.lng, 0) / datasets.length
    : -98.5795;

  // Create a lookup map from CSV data by FIPS code
  const dataByFips = React.useMemo(() => {
    const map = new Map();
    csvData.forEach(row => {
      const fips = String(row.FIPS || row.fips || '').padStart(5, '0');
      if (fips) map.set(fips, row);
    });
    return map;
  }, [csvData]);

  // Helper function to get the value (normalized or raw)
  const getDisplayValue = (rowData: any) => {
    if (!rowData || !selectedMetric) return undefined;

    const numerator = rowData[selectedMetric];
    if (typeof numerator !== 'number' || isNaN(numerator)) return undefined;

    if (selectedDenominator === 'None') {
      return numerator;
    }

    const denominator = rowData[selectedDenominator];
    if (typeof denominator !== 'number' || isNaN(denominator) || denominator === 0) {
      return undefined; // Cannot normalize
    }

    // Normalize and multiply by a large number (e.g., 100,000) for better visibility as a rate per population
    return (numerator / denominator);
  };

  // Get min and max values for the selected metric
  const { min, max } = React.useMemo(() => {
    if (!selectedMetric || csvData.length === 0) return { min: 0, max: 1 };
    
    // 4. Use normalized values for min/max calculation
    const values = csvData
      .map(getDisplayValue)
      .filter(val => typeof val === 'number' && !isNaN(val));
    
    // Handle case where all values are filtered out
    if (values.length === 0) return { min: 0, max: 1 };

    return {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  }, [csvData, selectedMetric, selectedDenominator]); // 4. Add selectedDenominator dependency

  // Color scale function
  const getColor = (value: number) => {
// ... (existing getColor function - no change, as it uses min/max)
    if (value === undefined || value === null || isNaN(value)) return '#e0e0e0';
    
    const normalized = (value - min) / (max - min);
    
    // Color gradient from light blue to dark blue
    const colors = [
      '#f0f9ff', // lightest
      '#bae6fd',
      '#7dd3fc',
      '#38bdf8',
      '#0ea5e9',
      '#0284c7',
      '#0369a1',
      '#075985'  // darkest
    ];
    
    const index = Math.min(Math.floor(normalized * colors.length), colors.length - 1);
    return colors[index];
  };

  // Style function for GeoJSON
  const getFeatureStyle = (feature: any) => {
    const fips = String(feature.properties.GEOID || feature.properties.FIPS || '').padStart(5, '0');
    const rowData = dataByFips.get(fips);
    // 5. Use the helper to get the display value
    const value = getDisplayValue(rowData);
    
    return {
      fillColor: getColor(value),
      weight: 0.2,
      opacity: 1,
      color: '#666',
      fillOpacity: 0.7,
    };
  };

  // Helper function for display text in the popup/legend
  const getMetricDisplayLabel = () => {
    return selectedDenominator === 'None' 
      ? selectedMetric
      : `${selectedMetric} / ${selectedDenominator}`;
  };
  
  // Helper function to format the displayed value
  const formatValue = (value: number | undefined) => {
      if (typeof value !== 'number' || isNaN(value)) return 'No data';
      if (selectedDenominator !== 'None') {
          // Format normalized value as a percentage or with more decimal places
          return value.toFixed(3); 
      }
      return value.toLocaleString();
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-lg">
      {/* Map Header */}
      <div className="p-4 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h3 className="font-semibold text-slate-800">Data Coverage Map</h3>
            
            {/* Numerator (Selected Metric) Dropdown */}
            {availableMetrics.length > 0 && (
              <select
                value={selectedMetric}
                onChange={(e) => setSelectedMetric(e.target.value)}
                className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {availableMetrics.map(metric => (
                  <option key={metric} value={metric}>{metric}</option>
                ))}
              </select>
            )}

            {/* 3. Denominator (Normalization) Dropdown */}
            {availableDenominators.length > 1 && (
              <>
                <span className="text-sm text-slate-600">Normalized by:</span>
                <select
                  value={selectedDenominator}
                  onChange={(e) => setSelectedDenominator(e.target.value)}
                  className="text-sm border border-slate-300 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {availableDenominators.map(denominator => (
                    <option key={denominator} value={denominator}>{denominator}</option>
                  ))}
                </select>
              </>
            )}
            
          </div>
          <div className="flex items-center space-x-2">
{/* ... (existing zoom and layers buttons) */}
            <button
              onClick={() => setZoomLevel(Math.max(1, zoomLevel - 1))}
              className="p-1.5 text-slate-600 hover:text-slate-800 hover:bg-white rounded-lg transition-colors"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-sm text-slate-500 px-2">
              Zoom {zoomLevel}x
            </span>
            <button
              onClick={() => setZoomLevel(Math.min(10, zoomLevel + 1))}
              className="p-1.5 text-slate-600 hover:text-slate-800 hover:bg-white rounded-lg transition-colors"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
            <div className="w-px h-4 bg-slate-300" />
            <button
              onClick={() => setShowLayers(!showLayers)}
              className={`p-1.5 rounded-lg transition-colors ${
                showLayers
                  ? 'text-blue-600 bg-blue-50'
                  : 'text-slate-600 hover:text-slate-800 hover:bg-white'
              }`}
            >
              <Layers className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
      
      {/* Map Display using Leaflet */}
      <div className="relative relative h-80 md:h-[600px]">
        <MapContainer
// ... (existing MapContainer props)
          center={[centerLat, centerLng]}
          zoom={zoomLevel}
          scrollWheelZoom={true}
          className="h-full w-full z-0"
        >
          <MapController zoomLevel={zoomLevel} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          
          {/* Use the GeoJSON component to render the county shapes */}
          {countyData && (
            <GeoJSON
              key={selectedMetric + selectedDenominator} // Re-render when metric OR denominator changes
              data={countyData}
              style={getFeatureStyle}
              onEachFeature={(feature, layer) => {
                const fips = String(feature.properties.GEOID || feature.properties.FIPS || '').padStart(5, '0');
                const rowData = dataByFips.get(fips);
                // 5. Get the display value
                const value = getDisplayValue(rowData);
                
                const countyName = feature.properties.NAME || 'Unknown';
                
                layer.bindPopup(`
                  <div>
                    <h3 class="font-semibold">${countyName} County</h3>
                    <p class="text-sm"><strong>${getMetricDisplayLabel()}:</strong> ${formatValue(value)}</p>
                    ${fips ? `<p class="text-xs text-gray-500">FIPS: ${fips}</p>` : ''}
                  </div>
                `);
              }}
            />
          )}

{/* ... (existing Dataset markers and rectangles) */}
        </MapContainer>
        
{/* ... (existing Interactive Controls Overlay) */}
        
        {/* Legend */}
        {showLayers && (
          <div className="absolute bottom-4 left-4 bg-white rounded-lg shadow-lg p-3 text-xs z-10">
            <div className="font-medium text-slate-800 mb-2">Legend</div>
            <div className="space-y-2">
              {selectedMetric && csvData.length > 0 && (
                <div className="mb-3">
                  {/* 5. Update Legend Label */}
                  <div className="text-slate-600 font-medium mb-1">{getMetricDisplayLabel()}</div>
                  <div className="flex items-center space-x-1">
                    <span className="text-slate-500">{formatValue(min)}</span>
                    <div className="flex-1 h-4 rounded" style={{
                      background: 'linear-gradient(to right, #f0f9ff, #bae6fd, #7dd3fc, #38bdf8, #0ea5e9, #0284c7, #0369a1, #075985)'
                    }}></div>
                    <span className="text-slate-500">{formatValue(max)}</span>
                  </div>
                  <div className="flex items-center space-x-2 mt-1">
                    <div className="w-3 h-3 bg-gray-300 rounded"></div>
                    <span className="text-slate-600">No data</span>
                  </div>
                </div>
              )}
{/* ... (existing Legend items) */}
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 bg-blue-600 rounded-full"></div>
                <span className="text-slate-600">Dataset Location</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-3 h-3 border-2 border-blue-600 bg-blue-400 opacity-50"></div>
                <span className="text-slate-600">Coverage Area (Bounding Box)</span>
              </div>
            </div>
          </div>
        )}
      </div>
      
      {/* Map Footer */}
    </div>
  );
};

export default MapVisualization;