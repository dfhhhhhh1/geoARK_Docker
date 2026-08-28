import React, { useState } from 'react';
import { Search, Loader2, Sparkles } from 'lucide-react';

interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
}

const SearchBar: React.FC<SearchBarProps> = ({ onSearch, isLoading }) => {
  const [query, setQuery] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query.trim());
    }
  };

  const exampleQueries = [
    "population density in midwest cities",
    "river pollution measurements for 2023",
    "satellite imagery of deforestation",
    "2023 pulmonary cancer rates in Missouri by tract",
    "agricultural soil quality data"
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Main Search Bar */}
      <form onSubmit={handleSubmit} className="relative mb-6">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
            {isLoading ? (
              <Loader2 className="h-6 w-6 text-slate-400 animate-spin" />
            ) : (
              <Search className="h-6 w-6 text-slate-400" />
            )}
          </div>
          
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Describe the geospatial data you need in plain English..."
            className="w-full pl-12 pr-32 py-4 text-lg border-2 border-slate-200 rounded-2xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 outline-none transition-all duration-200 bg-white shadow-lg"
            disabled={isLoading}
          />
          
          <div className="absolute inset-y-0 right-0 flex items-center pr-2">
            <button
              type="submit"
              disabled={!query.trim() || isLoading}
              className="px-6 py-2 bg-gradient-to-r from-blue-600 to-teal-600 text-white rounded-xl hover:from-blue-700 hover:to-teal-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 font-medium shadow-lg hover:shadow-xl"
            >
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {/* AI-Powered Search Badge */}
      <div className="flex items-center justify-center mb-6">
        <div className="inline-flex items-center space-x-2 px-4 py-2 bg-gradient-to-r from-purple-100 to-blue-100 text-purple-700 rounded-full text-sm font-medium">
          <Sparkles className="w-4 h-4" />
          <span>AI-powered natural language search</span>
        </div>
      </div>

      {/* Example Queries */}
      <div className="text-center">
        <p className="text-sm text-slate-500 mb-3">Try searching for:</p>
        <div className="flex flex-wrap justify-center gap-2">
          {exampleQueries.map((example, index) => (
            <button
              key={index}
              onClick={() => {
                setQuery(example);
                onSearch(example);
              }}
              className="px-3 py-1.5 text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-full transition-colors duration-200"
              disabled={isLoading}
            >
              "{example}"
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SearchBar;