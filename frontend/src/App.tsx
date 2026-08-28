import React, { useState } from 'react';
import Header from './components/Header';
import SearchBar from './components/SearchBar';
import SearchResults from './components/SearchResults';
import MapVisualization from './components/MapVisualization';
import DatasetModal from './components/DatasetModal';
import { Dataset, CartItem } from './types';
import ReportPage from './components/ReportPage';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

//Interface for the new backend API response
interface BackendSearchResult {
  dataset_id: string;
  attr_id: string;
  attr_label: string;
  attr_desc: string;
  tags: string;
  entity_type: string;
  start_date: string;
  end_date: string;
  similarity: number;
  embeddingText: string;
}

function MainGeospatialPage({
  searchQuery,
  searchResults,
  selectedDataset,
  isLoading,
  handleSearch,
  addToCart,
  isInCart,
  setSelectedDataset
}: any) {
  return (
    <div className="relative z-10">
      <main className="container mx-auto px-4 py-8">
        {/*Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-800 mb-4">
            Discover Missouri Geospatial Data
          </h1>
          <p className="text-xl text-slate-600 mb-8 max-w-3xl mx-auto">
            Search through Missouri's comprehensive geospatial datasets using natural language queries. 
            Find demographic, health, environmental, and social data at state and county levels.
          </p>
          
          <SearchBar onSearch={handleSearch} isLoading={isLoading} />
        </div>

        {/* Main Content Area*/}
        {searchResults.length > 0 && (
          <div className="grid lg:grid-cols-2 gap-8 mb-8">
            {/* Search Results */}
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-semibold text-slate-800">
                  Search Results
                </h2>
                <span className="text-sm text-slate-500">
                  {searchResults.length} dataset{searchResults.length !== 1 ? 's' : ''} found
                  {searchResults.length > 0 && (
                    <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
                      Sorted by relevance
                    </span>
                  )}
                </span>
              </div>
              
              <SearchResults 
                results={searchResults}
                onAddToCart={addToCart}
                onSelectDataset={setSelectedDataset}
                isInCart={isInCart}
              />
            </div>

            {/* Map Visualization */}
            <div className="lg:sticky lg:top-8 h-fit">
              <MapVisualization datasets={searchResults} />
            </div>
          </div>
        )}

        {/* Empty State */}
        {searchResults.length === 0 && searchQuery && !isLoading && (
          <div className="text-center py-16">
            <div className="w-24 h-24 mx-auto mb-6 bg-slate-100 rounded-full flex items-center justify-center">
              <svg className="w-12 h-12 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-slate-700 mb-2">No datasets found</h3>
            <p className="text-slate-500">Try adjusting your search terms. For example: "population data", "health statistics", or "environmental measurements".</p>
          </div>
        )}

        {/* Getting Started */}
        {searchResults.length === 0 && !searchQuery && (
          <div className="grid md:grid-cols-3 gap-8 mt-16">
            <div className="text-center p-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-blue-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Smart Search</h3>
              <p className="text-slate-600">Search using natural language. Try "elderly population health data" or "demographic statistics by county".</p>
            </div>
            
            <div className="text-center p-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-teal-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Missouri Focus</h3>
              <p className="text-slate-600">All datasets cover Missouri regions with state and county-level granularity for comprehensive analysis.</p>
            </div>
            
            <div className="text-center p-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4m0 0L7 13m0 0l-2.5 5M7 13l2.5 5m6.5-5v5a2 2 0 01-2 2H9a2 2 0 01-2-2v-5m8 0V9a2 2 0 00-2-2H9a2 2 0 00-2 2v4.01" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Variable-Rich</h3>
              <p className="text-slate-600">Each dataset contains multiple related variables, giving you comprehensive data for your research.</p>
            </div>
          </div>
        )}
      </main>

      {/* Dataset Detail Modal */}
      {selectedDataset && (
        <DatasetModal 
          dataset={selectedDataset}
          onClose={() => setSelectedDataset(null)}
          onAddToCart={addToCart}
          isInCart={isInCart(selectedDataset.id)}
        />
      )}
    </div>
  );
}

function MapPage({ datasets }: { datasets: Dataset[] }) {
  return (
    <div className="container mx-auto px-4 py-8">
      <h2 className="text-3xl font-bold text-slate-800 mb-6 text-center">
        Interactive Map Explorer 🗺️
      </h2>
      <div className="lg:sticky lg:top-8 h-fit">
        <MapVisualization datasets={datasets} />
      </div>
    </div>
  );
}

function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Dataset[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  //Function to transform backend response to Dataset format
  const transformBackendResponse = (backendResults: BackendSearchResult[]): Dataset[] => {
    //Group results by dataset_id to create consolidated datasets
    const datasetGroups = backendResults.reduce((acc, result) => {
      const { dataset_id } = result;
      if (!acc[dataset_id]) {
        acc[dataset_id] = [];
      }
      acc[dataset_id].push(result);
      return acc;
    }, {} as Record<string, BackendSearchResult[]>);

    //Transform each group into a Dataset
    return Object.entries(datasetGroups).map(([datasetId, results]) => {
      const firstResult = results[0];
      const allTags = results.flatMap(r => {
        try {
          //Parse tags string that looks like "['tag1', 'tag2']"
          return JSON.parse(r.tags.replace(/'/g, '"'));
        } catch {
          //Fallback if parsing fails
          return r.tags.split(',').map(t => t.trim().replace(/[[\]']/g, ''));
        }
      });
      
      const uniqueTags = [...new Set(allTags.filter(tag => tag && tag.length > 0))];
      const allFields = results.map(r => r.attr_desc);
      
      //Generate mock coordinates based on entity type and dataset ID
      const mockCoordinates = generateMockCoordinates(firstResult.entity_type, datasetId);
      
      //Determine coverage based on entity type
      const coverage = {
        geographic: firstResult.entity_type === 'STATE' ? 'Missouri State' : 
                   firstResult.entity_type === 'COUNTY' ? 'Missouri Counties' : 
                   'Missouri Region',
        temporal: `${firstResult.start_date} - ${firstResult.end_date}`
      };

      return {
        id: datasetId,
        title: `${firstResult.entity_type.toLowerCase()} Dataset - ${datasetId.substring(0, 8)}`,
        description: `Contains ${results.length} variable${results.length > 1 ? 's' : ''} including ${results[0].attr_desc}${results.length > 1 ? ' and others' : ''}`,
        source: 'Missouri Geographic Data Repository',
        fields: allFields,
        tags: uniqueTags,
        fileSize: estimateFileSize(results.length, firstResult.entity_type),
        lastUpdated: formatLastUpdated(firstResult.end_date),
        coverage,
        coordinates: mockCoordinates.center,
        boundingBox: mockCoordinates.boundingBox,
        downloadUrl: `/api/download/${datasetId}`,
        previewUrl: `/api/preview/${datasetId}`,
        //Add extra metadata for the new fields
        variables: results.map(r => ({
          id: r.attr_id,
          label: r.attr_label,
          description: r.attr_desc,
          similarity: r.similarity
        })),
        entityType: firstResult.entity_type,
        similarity: Math.max(...results.map(r => r.similarity))
      };
    }).sort((a: { similarity: number }, b: { similarity: number }) => 
      b.similarity - a.similarity );
  };

  //Generate mock coordinates based on entity type and dataset ID
  const generateMockCoordinates = (entityType: string, datasetId: string) => {
    //Missouri bounds
    const missouriBounds = {
      north: 40.61364,
      south: 35.995683,
      east: -89.098968,
      west: -95.774704
    };

    //Generate pseudo-random coordinates based on dataset ID
    const hash = datasetId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    
    const latOffset = (Math.abs(hash) % 1000) / 1000;
    const lngOffset = (Math.abs(hash >> 16) % 1000) / 1000;
    
    const lat = missouriBounds.south + (missouriBounds.north - missouriBounds.south) * latOffset;
    const lng = missouriBounds.west + (missouriBounds.east - missouriBounds.west) * lngOffset;

    return {
      center: { lat, lng },
      boundingBox: entityType === 'STATE' ? missouriBounds : {
        north: Math.min(lat + 0.5, missouriBounds.north),
        south: Math.max(lat - 0.5, missouriBounds.south),
        east: Math.min(lng + 0.5, missouriBounds.east),
        west: Math.max(lng - 0.5, missouriBounds.west)
      }
    };
  };

  //Estimate file size based on number of variables and entity type
  const estimateFileSize = (variableCount: number, entityType: string) => {
    const baseSize = entityType === 'STATE' ? 1 : entityType === 'COUNTY' ? 10 : 5;
    const totalSize = baseSize * variableCount;
    return totalSize > 1024 ? `${(totalSize / 1024).toFixed(1)} GB` : `${totalSize} MB`;
  };

  //Format last updated date
  const formatLastUpdated = (endDate: string) => {
    const year = parseInt(endDate);
    const currentYear = new Date().getFullYear();
    const yearsAgo = currentYear - year;
    
    if (yearsAgo === 0) return 'This year';
    if (yearsAgo === 1) return '1 year ago';
    return `${yearsAgo} years ago`;
  };

  const handleSearch = async (query: string) => {
    setIsLoading(true);
    setSearchQuery(query);
    
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const backendData: BackendSearchResult[] = await res.json();
      const transformedData = transformBackendResponse(backendData);
      setSearchResults(transformedData);
    } catch (err) {
      console.error("Error fetching datasets:", err);
      setSearchResults([]);
    } finally {
      setIsLoading(false);
    }
  };

  const addToCart = (dataset: Dataset) => {
    const existingItem = cartItems.find(item => item.dataset.id === dataset.id);
    if (!existingItem) {
      setCartItems(prev => [...prev, { dataset, quantity: 1, addedAt: new Date() }]);
    }
  };

  const removeFromCart = (datasetId: string) => {
    setCartItems(prev => prev.filter(item => item.dataset.id !== datasetId));
  };

  const isInCart = (datasetId: string) => {
    return cartItems.some(item => item.dataset.id === datasetId);
  };

  return (
    // 1. BrowserRouter is correctly wrapping the entire application
    <BrowserRouter>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        
        {/*Background Pattern (Keep this outside the z-10 div) */}
        <div className="fixed inset-0 opacity-5">
          <div className="absolute inset-0" style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.1'%3E%3Ccircle cx='7' cy='7' r='1'/%3E%3Ccircle cx='53' cy='53' r='1'/%3E%3Ccircle cx='30' cy='30' r='1'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }} />
        </div>

        <div className="relative z-10">
          
          {/* 2. HEADER stays OUTSIDE of Routes because it appears on ALL pages */}
          <Header 
            cartItemCount={cartItems.length} 
            cartItems={cartItems}
            onRemoveFromCart={removeFromCart}
          />
          
          {/* 3. The entire content of the page (Hero, Search, Map) must be wrapped in Routes */}
          <Routes>
            {/* Default Route: Redirects root path to the search page */}
            <Route path="/" element={<Navigate replace to="/data-search" />} />

            {/* Route for the Main Geospatial Search Page */}
            <Route 
              path="/data-search" 
              element={
                // We render the MainGeospatialPage component here
                <MainGeospatialPage
                  searchQuery={searchQuery}
                  searchResults={searchResults}
                  selectedDataset={selectedDataset}
                  isLoading={isLoading}
                  handleSearch={handleSearch}
                  addToCart={addToCart}
                  isInCart={isInCart}
                  setSelectedDataset={setSelectedDataset} // Pass setSelectedDataset
                />
              } 
            />
            <Route 
              path="/map-explorer" 
              element={<MapPage datasets={searchResults} />} 
            />

            {/* Route for the New CSV Report Page */}
            <Route 
              path="/csv-report" 
              element={<ReportPage />} 
            />
          </Routes>
          
          {/* 4. Dataset Modal stays OUTSIDE of Routes so it can overlay any page */}
          {selectedDataset && (
            <DatasetModal 
              dataset={selectedDataset}
              onClose={() => setSelectedDataset(null)}
              onAddToCart={addToCart}
              isInCart={isInCart(selectedDataset.id)}
            />
          )}

        </div>
      </div>
    </BrowserRouter>
  );
}

export default App;

//   return (
//     <BrowserRouter>
//     <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
//       {/*Background Pattern */}
//       <div className="fixed inset-0 opacity-5">
//         <div className="absolute inset-0" style={{
//           backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.1'%3E%3Ccircle cx='7' cy='7' r='1'/%3E%3Ccircle cx='53' cy='53' r='1'/%3E%3Ccircle cx='30' cy='30' r='1'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
//         }} />
//       </div>

//       <div className="relative z-10">
//         <Header 
//           cartItemCount={cartItems.length} 
//           cartItems={cartItems}
//           onRemoveFromCart={removeFromCart}
//         />
        
//         <main className="container mx-auto px-4 py-8">
//           {/*Hero Section */}
//           <div className="text-center mb-12">
//             <h1 className="text-4xl md:text-5xl font-bold text-slate-800 mb-4">
//               Discover Missouri Geospatial Data
//             </h1>
//             <p className="text-xl text-slate-600 mb-8 max-w-3xl mx-auto">
//               Search through Missouri's comprehensive geospatial datasets using natural language queries. 
//               Find demographic, health, environmental, and social data at state and county levels.
//             </p>
            
//             <SearchBar onSearch={handleSearch} isLoading={isLoading} />
//           </div>

//           {/* Main Content Area*/}
//           {searchResults.length > 0 && (
//             <div className="grid lg:grid-cols-2 gap-8 mb-8">
//               {/* Search Results */}
//               <div className="space-y-6">
//                 <div className="flex items-center justify-between">
//                   <h2 className="text-2xl font-semibold text-slate-800">
//                     Search Results
//                   </h2>
//                   <span className="text-sm text-slate-500">
//                     {searchResults.length} dataset{searchResults.length !== 1 ? 's' : ''} found
//                     {searchResults.length > 0 && (
//                       <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-full">
//                         Sorted by relevance
//                       </span>
//                     )}
//                   </span>
//                 </div>
                
//                 <SearchResults 
//                   results={searchResults}
//                   onAddToCart={addToCart}
//                   onSelectDataset={setSelectedDataset}
//                   isInCart={isInCart}
//                 />
//               </div>

//               {/* Map Visualization */}
//               <div className="lg:sticky lg:top-8 h-fit">
//                 <MapVisualization datasets={searchResults} />
//               </div>
//             </div>
//           )}

//           {/* Empty State */}
//           {searchResults.length === 0 && searchQuery && !isLoading && (
//             <div className="text-center py-16">
//               <div className="w-24 h-24 mx-auto mb-6 bg-slate-100 rounded-full flex items-center justify-center">
//                 <svg className="w-12 h-12 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
//                 </svg>
//               </div>
//               <h3 className="text-xl font-semibold text-slate-700 mb-2">No datasets found</h3>
//               <p className="text-slate-500">Try adjusting your search terms. For example: "population data", "health statistics", or "environmental measurements".</p>
//             </div>
//           )}

//           {/* Getting Started */}
//           {searchResults.length === 0 && !searchQuery && (
//             <div className="grid md:grid-cols-3 gap-8 mt-16">
//               <div className="text-center p-6">
//                 <div className="w-16 h-16 mx-auto mb-4 bg-blue-100 rounded-full flex items-center justify-center">
//                   <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
//                   </svg>
//                 </div>
//                 <h3 className="text-lg font-semibold text-slate-800 mb-2">Smart Search</h3>
//                 <p className="text-slate-600">Search using natural language. Try "elderly population health data" or "demographic statistics by county".</p>
//               </div>
              
//               <div className="text-center p-6">
//                 <div className="w-16 h-16 mx-auto mb-4 bg-teal-100 rounded-full flex items-center justify-center">
//                   <svg className="w-8 h-8 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
//                   </svg>
//                 </div>
//                 <h3 className="text-lg font-semibold text-slate-800 mb-2">Missouri Focus</h3>
//                 <p className="text-slate-600">All datasets cover Missouri regions with state and county-level granularity for comprehensive analysis.</p>
//               </div>
              
//               <div className="text-center p-6">
//                 <div className="w-16 h-16 mx-auto mb-4 bg-green-100 rounded-full flex items-center justify-center">
//                   <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//                     <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4m0 0L7 13m0 0l-2.5 5M7 13l2.5 5m6.5-5v5a2 2 0 01-2 2H9a2 2 0 01-2-2v-5m8 0V9a2 2 0 00-2-2H9a2 2 0 00-2 2v4.01" />
//                   </svg>
//                 </div>
//                 <h3 className="text-lg font-semibold text-slate-800 mb-2">Variable-Rich</h3>
//                 <p className="text-slate-600">Each dataset contains multiple related variables, giving you comprehensive data for your research.</p>
//               </div>
//             </div>
//           )}
//         </main>

//         {/* Dataset Detail Modal */}
//         {selectedDataset && (
//           <DatasetModal 
//             dataset={selectedDataset}
//             onClose={() => setSelectedDataset(null)}
//             onAddToCart={addToCart}
//             isInCart={isInCart(selectedDataset.id)}
//           />
//         )}
//       </div>
//     </div>
//   </BrowserRouter>
//   );
// }

// export default App;

