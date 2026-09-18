import React from 'react';
import { Search, Heart, User } from 'lucide-react';

export type BottomTabType = 'explore' | 'wishlists' | 'profile';

interface BottomTabBarProps {
  activeTab: BottomTabType;
  setActiveTab: (tab: BottomTabType) => void;
  savedCount: number;
  onOpenPostJob: () => void;
}

export const BottomTabBar: React.FC<BottomTabBarProps> = ({
  activeTab,
  setActiveTab,
  savedCount,
  onOpenPostJob,
}) => {
  return (
    <nav 
      aria-label="Mobile Navigation"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[rgba(8,14,32,0.72)] backdrop-blur-xl backdrop-saturate-150 shadow-[inset_0_0.5px_0_rgba(255,255,255,0.12)] pt-2.5 pb-8 px-6 select-none"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 28px), 28px)' }}
    >
      <div className="flex items-center justify-around max-w-xs mx-auto">
        
        {/* 1. Explore */}
        <button
          type="button"
          onClick={() => setActiveTab('explore')}
          className={`flex flex-col items-center justify-center py-1 transition-all active:scale-95 cursor-pointer ${
            activeTab === 'explore' ? 'text-[#FF385C]' : 'text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7]'
          }`}
        >
          <Search className={`w-[22px] h-[22px] mb-1 transition-transform ${activeTab === 'explore' ? 'stroke-[2.2]' : 'stroke-[1.6]'}`} />
          <span className={`text-[10px] tracking-tight ${activeTab === 'explore' ? 'font-semibold text-[#f5f5f7]' : 'font-medium text-[rgba(235,235,245,0.42)]'}`}>
            Explore
          </span>
        </button>

        {/* 2. Wishlists */}
        <button
          type="button"
          onClick={() => setActiveTab('wishlists')}
          className={`relative flex flex-col items-center justify-center py-1 transition-all active:scale-95 cursor-pointer ${
            activeTab === 'wishlists' ? 'text-[#FF385C]' : 'text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7]'
          }`}
        >
          <div className="relative">
            <Heart 
              className={`w-[22px] h-[22px] mb-1 transition-all ${
                activeTab === 'wishlists' ? 'fill-[#FF385C] stroke-[#FF385C] stroke-[2]' : 'stroke-[1.6]'
              }`} 
            />
            {savedCount > 0 && (
              <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-[#FF385C] ring-2 ring-white" />
            )}
          </div>
          <span className={`text-[10px] tracking-tight ${activeTab === 'wishlists' ? 'font-semibold text-[#f5f5f7]' : 'font-medium text-[rgba(235,235,245,0.42)]'}`}>
            Wishlists
          </span>
        </button>

        {/* 3. Profile */}
        <button
          type="button"
          onClick={() => {
            setActiveTab('profile');
            onOpenPostJob();
          }}
          className={`flex flex-col items-center justify-center py-1 transition-all active:scale-95 cursor-pointer ${
            activeTab === 'profile' ? 'text-[#FF385C]' : 'text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7]'
          }`}
        >
          <User className={`w-[22px] h-[22px] mb-1 transition-transform ${activeTab === 'profile' ? 'stroke-[2.2]' : 'stroke-[1.6]'}`} />
          <span className={`text-[10px] tracking-tight ${activeTab === 'profile' ? 'font-semibold text-[#f5f5f7]' : 'font-medium text-[rgba(235,235,245,0.42)]'}`}>
            Profile
          </span>
        </button>

      </div>
    </nav>
  );
};
