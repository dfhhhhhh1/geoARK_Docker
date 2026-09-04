import React from 'react';
import DatasetCard from './DatasetCard';
import { Dataset } from '../types';

interface SearchResultsProps {
  results: Dataset[];
  onSelectDataset: (dataset: Dataset) => void;
}

const SearchResults: React.FC<SearchResultsProps> = ({ results, onSelectDataset }) => (
  <div className="space-y-4">
    {results.map((dataset) => (
      <DatasetCard
        key={dataset.id}
        dataset={dataset}
        onSelect={onSelectDataset}
      />
    ))}
  </div>
);

export default SearchResults;
