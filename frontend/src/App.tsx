import { useState } from 'react';
import Header from './components/Header';
import SearchBar from './components/SearchBar';
import SearchResults from './components/SearchResults';
import DatasetModal from './components/DatasetModal';
import { Dataset, UnifiedSearchResponse } from './types';
import ReportPage from './components/ReportPage';
import AnalysisPage from './components/AnalysisPage';
import LoginGate from './components/LoginGate';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

function MainGeospatialPage({
  searchQuery,
  searchResults,
  isLoading,
  handleSearch,
  setSelectedDataset,
  unifiedResponse,
}: any) {
  return (
    <div className="relative z-10">
      <main className="container mx-auto px-4 py-8">
        {/*Hero Section */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-800 mb-4">
            Discover Geospatial Data
          </h1>
          <p className="text-xl text-slate-600 mb-8 max-w-3xl mx-auto">
            Use natural language to search through US's comprehensive geospatial datasets on demographic, health, environmental, and social data at state and county levels.
          </p>
          
          <SearchBar onSearch={handleSearch} isLoading={isLoading} />
        </div>

        {/* Query Decomposition Info */}
        {unifiedResponse && unifiedResponse.decomposition && (
          <div className="mb-8 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Query Intelligence
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="font-medium text-slate-600">Primary Concepts:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {unifiedResponse.decomposition.primary_concepts.map((c: string, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs">{c}</span>
                  ))}
                </div>
              </div>
              <div>
                <span className="font-medium text-slate-600">Normalization:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {unifiedResponse.decomposition.normalization_concepts.map((c: string, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">{c}</span>
                  ))}
                </div>
              </div>
              <div>
                <span className="font-medium text-slate-600">Filters:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {unifiedResponse.decomposition.filter_concepts.length > 0
                    ? unifiedResponse.decomposition.filter_concepts.map((c: string, i: number) => (
                        <span key={i} className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs">{c}</span>
                      ))
                    : <span className="text-slate-400 text-xs">None</span>
                  }
                </div>
              </div>
            </div>
            {unifiedResponse.stats && (
              <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4 text-xs text-slate-500">
                <span>Total: {unifiedResponse.stats.total_results} results</span>
                <span>Primary: {unifiedResponse.stats.primary_count}</span>
                <span>Normalization: {unifiedResponse.stats.normalization_count}</span>
                <span>Time: {unifiedResponse.stats.processing_time_ms}ms</span>
                {unifiedResponse.stats.llm_filtered && (
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-600 rounded-full">LLM Filtered</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Main Content Area*/}
        {searchResults.length > 0 && (
          <div className="mb-8">
            {/* Single column now. The right-hand pane held a map that placed
                every dataset at a hashed, invented coordinate. */}
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
                onSelectDataset={setSelectedDataset}
              />
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
              <p className="text-slate-600">Search using natural language. Our AI decomposes your query into concepts for comprehensive results.</p>
            </div>
            <div className="text-center p-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-green-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Data Analysis</h3>
              <p className="text-slate-600">Upload CSV files for ML-powered analysis with clustering, regression, and correlation insights.</p>
            </div>
            <div className="text-center p-6">
              <div className="w-16 h-16 mx-auto mb-4 bg-purple-100 rounded-full flex items-center justify-center">
                <svg className="w-8 h-8 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Map Explorer</h3>
              <p className="text-slate-600">Visualize datasets on interactive maps with choropleth overlays and spatial analysis.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}


function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Dataset[]>([]);
  const [selectedDataset, setSelectedDataset] = useState<Dataset | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [unifiedResponse, setUnifiedResponse] = useState<UnifiedSearchResponse | null>(null);

  // Transform unified search response to Dataset format for backward compatibility
  const transformUnifiedResponse = (response: UnifiedSearchResponse): Dataset[] => {
    const allResults = response.all_results;
    
    // Group results by dataset_id
    const datasetGroups = allResults.reduce((acc, result) => {
      const { dataset_id } = result;
      if (!acc[dataset_id]) {
        acc[dataset_id] = [];
      }
      acc[dataset_id].push(result);
      return acc;
    }, {} as Record<string, typeof allResults>);

    return Object.entries(datasetGroups).map(([datasetId, results]) => {
      const firstResult = results[0];
      const allTags = results.flatMap(r => {
        try {
          return JSON.parse(r.tags.replace(/'/g, '"'));
        } catch {
          return r.tags.split(',').map(t => t.trim().replace(/[[\]']/g, ''));
        }
      });
      
      const uniqueTags = [...new Set(allTags.filter((tag: string) => tag && tag.length > 0))];
      const allFields = results.map(r => r.attr_desc);

      const coverage = {
        geographic: firstResult.entity_type === 'STATE' ? 'State' : 
                   firstResult.entity_type === 'COUNTY' ? 'County' : 
                   'Region',
        temporal: firstResult.dataset_clean || 'N/A'
      };

      // Determine best score from hybrid_score
      const bestScore = Math.max(...results.map(r => r.hybrid_score));

      return {
        id: datasetId,
        title: `${firstResult.dataset_clean}, ${firstResult.entity_type.toLowerCase()} level`,
        description: `Contains ${results.length} variable${results.length > 1 ? 's' : ''}: ${results.map(r => r.attr_desc).slice(0, 3).join('; ')}${results.length > 3 ? ` (+${results.length - 3} more)` : ''}`,
        source: firstResult.dataset_clean || 'Geographic Data Repository',
        fields: allFields,
        tags: uniqueTags,
        // No fileSize, coordinates, boundingBox, downloadUrl or previewUrl:
        // every one of those was invented here or pointed at an endpoint that
        // does not exist. See the note on the Dataset type.
        lastUpdated: 'Recent',
        coverage,
        variables: results.map(r => ({
          id: r.attr_id,
          label: r.attr_orig,
          description: r.attr_desc,
          similarity: r.hybrid_score
        })),
        entityType: firstResult.entity_type,
        similarity: bestScore
      };
    }).sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  };


  // NEW: Use unified search endpoint (POST /api/unified-search)
  const handleSearch = async (query: string) => {
    setIsLoading(true);
    setSearchQuery(query);
    
    try {
      const res = await fetch('/api/unified-search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          use_llm_filter: false,
          top_k: 20,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      
      const responseData: UnifiedSearchResponse = await res.json();
      setUnifiedResponse(responseData);
      
      const transformedData = transformUnifiedResponse(responseData);
      setSearchResults(transformedData);
    } catch (err) {
      console.error("Error fetching datasets:", err);
      setSearchResults([]);
      setUnifiedResponse(null);
    } finally {
      setIsLoading(false);
    }
  };




  return (
    <LoginGate>
    <BrowserRouter>
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
        
        <div className="fixed inset-0 opacity-5">
          <div className="absolute inset-0" style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.1'%3E%3Ccircle cx='7' cy='7' r='1'/%3E%3Ccircle cx='53' cy='53' r='1'/%3E%3Ccircle cx='30' cy='30' r='1'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }} />
        </div>

        <div className="relative z-10">

          <Header />

          <Routes>
            {/* Analysis is the front door: it is the thing that answers a
                question. Browsing the catalog is how you find out what can be
                asked about. */}
            <Route path="/" element={<Navigate replace to="/analysis" />} />

            <Route path="/analysis" element={<AnalysisPage />} />

            <Route
              path="/data-search"
              element={
                <MainGeospatialPage
                  searchQuery={searchQuery}
                  searchResults={searchResults}
                  isLoading={isLoading}
                  handleSearch={handleSearch}
                  setSelectedDataset={setSelectedDataset}
                  unifiedResponse={unifiedResponse}
                />
              }
            />

            <Route path="/csv-report" element={<ReportPage />} />

            {/* /map-explorer is deliberately absent: it plotted datasets at
                coordinates derived from a hash of their id. Anything still
                linking to it lands on the analysis page rather than a blank. */}
            <Route path="*" element={<Navigate replace to="/analysis" />} />
          </Routes>

          {selectedDataset && (
            <DatasetModal
              dataset={selectedDataset}
              onClose={() => setSelectedDataset(null)}
            />
          )}

        </div>
      </div>
    </BrowserRouter>
    </LoginGate>
  );
}

export default App;