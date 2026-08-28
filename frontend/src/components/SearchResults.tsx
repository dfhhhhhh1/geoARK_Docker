import React from 'react';
import DatasetCard from './DatasetCard';
import { Dataset } from '../types';

interface SearchResultsProps {
  results: Dataset[];
  onAddToCart: (dataset: Dataset) => void;
  onSelectDataset: (dataset: Dataset) => void;
  isInCart: (datasetId: string) => boolean;
}

const SearchResults: React.FC<SearchResultsProps> = ({ 
  results, 
  onAddToCart, 
  onSelectDataset, 
  isInCart 
}) => {
  return (
    <div className="space-y-4">
      {results.map((dataset) => (
        <DatasetCard
          key={dataset.id}
          dataset={dataset}
          onAddToCart={onAddToCart}
          onSelect={onSelectDataset}
          isInCart={isInCart(dataset.id)}
        />
      ))}
    </div>
  );
};

export default SearchResults;