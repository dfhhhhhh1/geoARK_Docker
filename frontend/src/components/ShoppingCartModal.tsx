import React from 'react';
import { X, Download, Trash2, FileText, Calendar } from 'lucide-react';
import { CartItem } from '../types';

interface ShoppingCartModalProps {
  cartItems: CartItem[];
  onClose: () => void;
  onRemoveFromCart: (datasetId: string) => void;
}

const ShoppingCartModal: React.FC<ShoppingCartModalProps> = ({
  cartItems,
  onClose,
  onRemoveFromCart
}) => {
  const totalSize = cartItems.reduce((sum, item) => {
    const size = parseFloat(item.dataset.fileSize.split(' ')[0]);
    const unit = item.dataset.fileSize.split(' ')[1];
    const sizeInMB = unit === 'GB' ? size * 1024 : size;
    return sum + sizeInMB;
  }, 0);

  const formatTotalSize = (sizeInMB: number) => {
    if (sizeInMB >= 1024) {
      return `${(sizeInMB / 1024).toFixed(1)} GB`;
    }
    return `${sizeInMB.toFixed(1)} MB`;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-6 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-slate-800">Data Cart</h2>
              <p className="text-slate-600">
                {cartItems.length} dataset{cartItems.length !== 1 ? 's' : ''} • {formatTotalSize(totalSize)}
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Cart Items */}
        <div className="overflow-y-auto max-h-[50vh]">
          {cartItems.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-16 h-16 mx-auto mb-4 bg-slate-100 rounded-full flex items-center justify-center">
                <FileText className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-700 mb-2">Your cart is empty</h3>
              <p className="text-slate-500">Add some datasets to get started with your download.</p>
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {cartItems.map((item) => (
                <div key={item.dataset.id} className="flex items-center space-x-4 p-4 bg-slate-50 rounded-lg">
                  <div className="flex-1">
                    <h4 className="font-semibold text-slate-800 mb-1">
                      {item.dataset.title}
                    </h4>
                    <div className="flex items-center space-x-4 text-sm text-slate-500">
                      <span className="flex items-center space-x-1">
                        <FileText className="w-3 h-3" />
                        <span>{item.dataset.fileSize}</span>
                      </span>
                      <span className="flex items-center space-x-1">
                        <Calendar className="w-3 h-3" />
                        <span>Added {item.addedAt.toLocaleDateString()}</span>
                      </span>
                    </div>
                  </div>
                  
                  <button
                    onClick={() => onRemoveFromCart(item.dataset.id)}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {cartItems.length > 0 && (
          <div className="p-6 border-t border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="font-semibold text-slate-800">Total Download Size</p>
                <p className="text-slate-600">{formatTotalSize(totalSize)}</p>
              </div>
              
              <div className="text-right text-sm text-slate-500">
                <p>Estimated download time:</p>
                <p className="font-medium">{Math.ceil(totalSize / 100)} minutes (100 Mbps)</p>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2.5 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 transition-colors font-medium"
              >
                Continue Shopping
              </button>
              
              <button className="flex-1 flex items-center justify-center space-x-2 px-4 py-2.5 bg-gradient-to-r from-green-600 to-teal-600 text-white rounded-lg hover:from-green-700 hover:to-teal-700 transition-all font-medium shadow-lg hover:shadow-xl">
                <Download className="w-5 h-5" />
                <span>Download All ({cartItems.length})</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShoppingCartModal;