import React from 'react';
import { 
  ShoppingCart, 
  Eye, 
  Clock, 
  Database, 
  MapPin, 
  CheckCircle,
  BarChart3,
  Star
} from 'lucide-react';
import { Dataset } from '../types';

interface DatasetCardProps {
  dataset: Dataset;
  onAddToCart: (dataset: Dataset) => void;
  onSelect: (dataset: Dataset) => void;
  isInCart: boolean;
}

const DatasetCard: React.FC<DatasetCardProps> = ({ 
  dataset, 
  onAddToCart, 
  onSelect, 
  isInCart 
}) => {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-6 hover:shadow-lg transition-all duration-200 hover:border-slate-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center space-x-2 mb-2">
            <h3 className="text-lg font-semibold text-slate-800 hover:text-blue-600 cursor-pointer" 
                onClick={() => onSelect(dataset)}>
              {dataset.title}
            </h3>
            {dataset.similarity && (
              <div className="flex items-center space-x-1 px-2 py-1 bg-green-100 text-green-700 rounded-full text-xs">
                <Star className="w-3 h-3 fill-current" />
                <span>{(dataset.similarity * 100).toFixed(0)}%</span>
              </div>
            )}
          </div>
          <p className="text-slate-600 text-sm leading-relaxed mb-3">
            {dataset.description}
          </p>
          
          {/* Source and Coverage */}
          <div className="flex items-center space-x-4 text-sm text-slate-500 mb-3">
            <div className="flex items-center space-x-1">
              <Database className="w-4 h-4" />
              <span>{dataset.source}</span>
            </div>
            <div className="flex items-center space-x-1">
              <MapPin className="w-4 h-4" />
              <span>{dataset.coverage.geographic}</span>
            </div>
            <div className="flex items-center space-x-1">
              <Clock className="w-4 h-4" />
              <span>{dataset.coverage.temporal}</span>
            </div>
          </div>

          {/* Entity Type Badge */}
          {dataset.entityType && (
            <div className="mb-3">
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                dataset.entityType === 'STATE' 
                  ? 'bg-purple-100 text-purple-700' 
                  : 'bg-blue-100 text-blue-700'
              }`}>
                {dataset.entityType} Level Data
              </span>
            </div>
          )}
        </div>
        
        {/* Preview Thumbnail or Variable Count */}
        <div className="ml-4 flex-shrink-0">
          {dataset.previewUrl ? (
            <img 
              src={dataset.previewUrl} 
              alt={`${dataset.title} preview`}
              className="w-20 h-20 rounded-lg object-cover border border-slate-200"
            />
          ) : (
            <div className="w-20 h-20 rounded-lg border border-slate-200 bg-slate-50 flex flex-col items-center justify-center">
              <BarChart3 className="w-8 h-8 text-slate-400 mb-1" />
              <span className="text-xs text-slate-500 font-medium">
                {dataset.variables?.length || dataset.fields.length} vars
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Variables Preview */}
      {dataset.variables && dataset.variables.length > 0 ? (
        <div className="mb-4">
          <p className="text-sm font-medium text-slate-700 mb-2">
            Key variables (showing top {Math.min(3, dataset.variables.length)}):
          </p>
          <div className="space-y-2">
            {dataset.variables
              .sort((a, b) => b.similarity - a.similarity)
              .slice(0, 3)
              .map((variable) => (
              <div key={variable.id} className="flex items-start space-x-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-2 flex-shrink-0"></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-700 font-medium truncate">
                    {variable.description}
                  </p>
                  <div className="flex items-center space-x-2 mt-1">
                    <span className="text-xs text-slate-500">
                      Match: {(variable.similarity * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {dataset.variables.length > 3 && (
              <p className="text-xs text-slate-500 mt-2">
                +{dataset.variables.length - 3} more variables
              </p>
            )}
          </div>
        </div>
      ) : (
        /* Fallback to fields display */
        <div className="mb-4">
          <p className="text-sm font-medium text-slate-700 mb-2">
            Contains data on:
          </p>
          <div className="flex flex-wrap gap-2">
            {dataset.fields.slice(0, 3).map((field, index) => (
              <span 
                key={index}
                className="px-2 py-1 bg-blue-50 text-blue-700 text-xs rounded-md font-medium"
              >
                {field.length > 40 ? field.substring(0, 40) + '...' : field}
              </span>
            ))}
            {dataset.fields.length > 3 && (
              <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-md">
                +{dataset.fields.length - 3} more
              </span>
            )}
          </div>
        </div>
      )}

      {/* Tags */}
      <div className="mb-4">
        <div className="flex flex-wrap gap-1">
          {dataset.tags.slice(0, 5).map((tag, index) => (
            <span 
              key={index}
              className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-md"
            >
              #{tag}
            </span>
          ))}
          {dataset.tags.length > 5 && (
            <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs rounded-md">
              +{dataset.tags.length - 5}
            </span>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 border-t border-slate-100">
        <div className="flex items-center space-x-4 text-sm text-slate-500">
          <span className="font-medium">{dataset.fileSize}</span>
          <span>•</span>
          <span>{dataset.lastUpdated}</span>
        </div>
        
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onSelect(dataset)}
            className="flex items-center space-x-1 px-3 py-1.5 text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors text-sm"
          >
            <Eye className="w-4 h-4" />
            <span>Details</span>
          </button>
          
          <button
            onClick={() => onAddToCart(dataset)}
            disabled={isInCart}
            className={`flex items-center space-x-1 px-4 py-1.5 rounded-lg transition-all text-sm font-medium ${
              isInCart
                ? 'bg-green-100 text-green-700 cursor-default'
                : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-md'
            }`}
          >
            {isInCart ? (
              <>
                <CheckCircle className="w-4 h-4" />
                <span>In Cart</span>
              </>
            ) : (
              <>
                <ShoppingCart className="w-4 h-4" />
                <span>Add to Cart</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DatasetCard;