import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, Globe, User, BarChart2, Map } from 'lucide-react';
import ShoppingCartModal from './ShoppingCartModal';
import { CartItem } from '../types';

interface HeaderProps {
  cartItemCount: number;
  cartItems: CartItem[];
  onRemoveFromCart: (datasetId: string) => void;
}

const Header: React.FC<HeaderProps> = ({ cartItemCount, cartItems, onRemoveFromCart }) => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <header className="bg-white shadow-sm border-b border-slate-200">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-teal-600 rounded-lg flex items-center justify-center">
                <Globe className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-800">GeoARK</h1>
                <p className="text-xs text-slate-500">Geospatial Data Platform</p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="hidden md:flex items-center space-x-8">
            <Link 
                to="/data-search" 
                className="text-slate-600 hover:text-slate-800 transition-colors font-medium"
              >
                Data Search
              </Link>
              
              <Link 
                to="/map-explorer" 
                className="flex items-center space-x-2 text-slate-600 hover:text-blue-600 transition-colors font-medium"
              >
                <Map className="w-4 h-4" />
                <span>Map Explorer</span>
              </Link>
              {/* 3. Add the new link to the CSV Report Page */}
              <Link 
                to="/csv-report" 
                className="flex items-center space-x-2 text-slate-600 hover:text-blue-600 transition-colors font-medium"
              >
                <BarChart2 className="w-4 h-4" />
                <span>CSV Report Tool</span>
              </Link>
              <a href="#" className="text-slate-600 hover:text-slate-800 transition-colors">Tools</a>
              <a href="#" className="text-slate-600 hover:text-slate-800 transition-colors">Help</a>
            </nav>

            {/* User Actions */}
            <div className="flex items-center space-x-4">
              {/* Shopping Cart */}
              <button
                onClick={() => setIsCartOpen(true)}
                className="relative p-2 text-slate-600 hover:text-slate-800 transition-colors group"
              >
                <ShoppingCart className="w-6 h-6" />
                {cartItemCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium">
                    {cartItemCount}
                  </span>
                )}
                <span className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-full bg-slate-800 text-white text-xs py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  Data Cart ({cartItemCount})
                </span>
              </button>

              {/* User Profile */}
              <button className="flex items-center space-x-2 p-2 text-slate-600 hover:text-slate-800 transition-colors">
                <User className="w-5 h-5" />
                <span className="hidden sm:inline text-sm">Account</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Shopping Cart Modal */}
      {isCartOpen && (
        <ShoppingCartModal
          cartItems={cartItems}
          onClose={() => setIsCartOpen(false)}
          onRemoveFromCart={onRemoveFromCart}
        />
      )}
    </>
  );
};

export default Header;