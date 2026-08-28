import React from 'react';
import { 
  X, 
  Download, 
  Eye, 
  Calendar, 
  MapPin, 
  Database, 
  FileText, 
  ShoppingCart,
  CheckCircle,
  ExternalLink
} from 'lucide-react';
import { Dataset } from '../types';

interface DatasetModalProps {
  dataset: Dataset;
  onClose: () => void;
  onAddToCart: (dataset: Dataset) => void;
  isInCart: boolean;
}

const DatasetModal: React.FC<DatasetModalProps> = ({ 
  dataset, 
  onClose, 
  onAddToCart, 
  isInCart 
}) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h2 className="text-2xl font-bold text-slate-800 mb-2">
                {dataset.title}
              </h2>
              <p className="text-slate-600 leading-relaxed">
                {dataset.description}
              </p>
            </div>
            <button
              onClick={onClose}
              className="ml-4 p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[70vh]">
          <div className="p-6 space-y-6">
            {/* Quick Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-1">
                  <Database className="w-4 h-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">Source</span>
                </div>
                <p className="text-slate-800 font-semibold">{dataset.source}</p>
              </div>
              
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-1">
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">File Size</span>
                </div>
                <p className="text-slate-800 font-semibold">{dataset.fileSize}</p>
              </div>
              
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-1">
                  <Calendar className="w-4 h-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">Updated</span>
                </div>
                <p className="text-slate-800 font-semibold">{dataset.lastUpdated}</p>
              </div>
              
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="flex items-center space-x-2 mb-1">
                  <MapPin className="w-4 h-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">Coverage</span>
                </div>
                <p className="text-slate-800 font-semibold">{dataset.coverage.geographic}</p>
              </div>
            </div>

            {/* Preview Image */}
            {dataset.previewUrl && (
              <div className="bg-slate-50 rounded-lg p-4">
                <h3 className="font-semibold text-slate-800 mb-3">Data Preview</h3>
                <img 
                  src={dataset.previewUrl} 
                  alt={`${dataset.title} preview`}
                  className="w-full h-48 object-cover rounded-lg border border-slate-200"
                />
              </div>
            )}

            {/* Coverage Information */}
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold text-slate-800 mb-3">Geographic Coverage</h3>
                <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                  <p className="text-slate-700">{dataset.coverage.geographic}</p>
                  <div className="text-sm text-slate-600">
                    <p>Coordinates: {dataset.coordinates.lat.toFixed(4)}, {dataset.coordinates.lng.toFixed(4)}</p>
                    <p>Bounding Box: N {dataset.boundingBox.north}°, S {dataset.boundingBox.south}°</p>
                    <p className="ml-12">E {dataset.boundingBox.east}°, W {dataset.boundingBox.west}°</p>
                  </div>
                </div>
              </div>
              
              <div>
                <h3 className="font-semibold text-slate-800 mb-3">Temporal Coverage</h3>
                <div className="bg-slate-50 rounded-lg p-4">
                  <p className="text-slate-700">{dataset.coverage.temporal}</p>
                  <p className="text-sm text-slate-600 mt-2">
                    Last updated: {dataset.lastUpdated}
                  </p>
                </div>
              </div>
            </div>

            {/* Data Fields */}
            <div>
              <h3 className="font-semibold text-slate-800 mb-3">Available Data Fields</h3>
              <div className="bg-slate-50 rounded-lg p-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {dataset.fields.map((field, index) => (
                    <div key={index} className="flex items-center space-x-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0" />
                      <span className="text-slate-700 text-sm font-medium">
                        {field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Tags */}
            <div>
              <h3 className="font-semibold text-slate-800 mb-3">Tags</h3>
              <div className="flex flex-wrap gap-2">
                {dataset.tags.map((tag, index) => (
                  <span 
                    key={index}
                    className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm font-medium"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button className="flex items-center space-x-2 px-4 py-2 text-slate-600 hover:text-slate-800 hover:bg-white rounded-lg transition-colors">
                <Eye className="w-4 h-4" />
                <span>Preview Data</span>
              </button>
              
              <button className="flex items-center space-x-2 px-4 py-2 text-slate-600 hover:text-slate-800 hover:bg-white rounded-lg transition-colors">
                <ExternalLink className="w-4 h-4" />
                <span>View Source</span>
              </button>
            </div>
            
            <div className="flex items-center space-x-3">
              <button
                onClick={() => onAddToCart(dataset)}
                disabled={isInCart}
                className={`flex items-center space-x-2 px-6 py-2.5 rounded-lg transition-all font-medium ${
                  isInCart
                    ? 'bg-green-100 text-green-700 cursor-default'
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg hover:shadow-xl'
                }`}
              >
                {isInCart ? (
                  <>
                    <CheckCircle className="w-5 h-5" />
                    <span>Added to Cart</span>
                  </>
                ) : (
                  <>
                    <ShoppingCart className="w-5 h-5" />
                    <span>Add to Cart</span>
                  </>
                )}
              </button>
              
              <button className="flex items-center space-x-2 px-6 py-2.5 bg-gradient-to-r from-green-600 to-teal-600 text-white rounded-lg hover:from-green-700 hover:to-teal-700 transition-all font-medium shadow-lg hover:shadow-xl">
                <Download className="w-5 h-5" />
                <span>Download Now</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DatasetModal;