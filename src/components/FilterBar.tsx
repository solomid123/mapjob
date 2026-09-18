import React, { useState, useRef } from 'react';
import { 
  SlidersHorizontal, 
  X, 
  Zap, 
  ChevronLeft, 
  ChevronRight,
  Briefcase,
  Cpu,
  Rocket,
  Layers,
  Activity,
  Bot,
  Shield
} from 'lucide-react';
import { CATEGORIES } from '../data/mockJobs';

interface FilterBarProps {
  selectedCategory: string;
  setSelectedCategory: (cat: string) => void;
  jobType: string;
  setJobType: (type: string) => void;
  remoteType: string;
  setRemoteType: (type: string) => void;
  minSalary: number;
  setMinSalary: (sal: number) => void;
  visaSponsorshipOnly: boolean;
  setVisaSponsorshipOnly: (v: boolean) => void;
  directAtsOnly?: boolean;
  setDirectAtsOnly?: (val: boolean) => void;
  totalResults: number;
  onResetFilters: () => void;
  hasActiveFilters: boolean;
}

const renderCategoryIcon = (iconName: string, isActive: boolean) => {
  const iconClass = `w-6 h-6 transition-all duration-150 ${
    isActive ? 'text-[#f5f5f7] stroke-[2.4]' : 'text-[rgba(235,235,245,0.42)] group-hover:text-[#f5f5f7] stroke-[1.8]'
  }`;

  switch (iconName) {
    case 'Cpu':
      return <Cpu className={iconClass} />;
    case 'Rocket':
      return <Rocket className={iconClass} />;
    case 'Layers':
      return <Layers className={iconClass} />;
    case 'Activity':
      return <Activity className={iconClass} />;
    case 'Zap':
      return <Zap className={iconClass} />;
    case 'Bot':
      return <Bot className={iconClass} />;
    case 'Shield':
      return <Shield className={iconClass} />;
    case 'Briefcase':
    default:
      return <Briefcase className={iconClass} />;
  }
};

export const FilterBar: React.FC<FilterBarProps> = ({
  selectedCategory,
  setSelectedCategory,
  jobType,
  setJobType,
  remoteType,
  setRemoteType,
  minSalary,
  setMinSalary,
  visaSponsorshipOnly,
  setVisaSponsorshipOnly,
  directAtsOnly = false,
  setDirectAtsOnly,
  totalResults,
  onResetFilters,
  hasActiveFilters,
}) => {
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleScroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const scrollAmount = direction === 'left' ? -260 : 260;
      scrollContainerRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  const hasPillFilters = Boolean(
    jobType ||
    remoteType ||
    minSalary > 0 ||
    visaSponsorshipOnly ||
    directAtsOnly
  );

  return (
    <div className="ic-header pt-1 pb-2 select-none">
      <div className="max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* ROW 1: Signature Airbnb Category Icon Carousel */}
        <div className="relative flex items-center pb-1">
          
          {/* Left Arrow Button */}
          <button
            type="button"
            onClick={() => handleScroll('left')}
            className="hidden md:flex absolute left-0 z-10 w-8 h-8 rounded-full bg-[rgba(24,30,52,0.9)] backdrop-blur shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_2px_8px_rgba(0,0,0,0.4)] items-center justify-center text-[#f5f5f7] hover:scale-105 active:scale-95 transition-transform duration-200 ease-apple-spring"
            aria-label="Scroll categories left"
          >
            <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
          </button>

          {/* Category Carousel Scroll Area */}
          <div
            ref={scrollContainerRef}
            className="flex items-center gap-1 overflow-x-auto no-scrollbar scroll-smooth w-full px-1 md:px-9"
          >
            {CATEGORIES.map((cat) => {
              const isActive = selectedCategory === cat.id;
              // Short friendly display name
              const shortName = cat.name.split('(')[0].trim();

              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setSelectedCategory(cat.id)}
                  /* A selected item is a filled rounded rect, not a 2px rule under
                    * the label. The underline is a browser-tab metaphor; Apple
                    * marks selection by filling the control's own shape. */
                  className={`group flex flex-col items-center gap-1 px-3 py-2 rounded-xl shrink-0 cursor-pointer transition-[background-color,color] duration-200 ease-apple-out ${
                    isActive
                      ? 'bg-white/[0.14] text-[#f5f5f7]'
                      : 'text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7] hover:bg-white/[0.07]'
                  }`}
                >
                  {renderCategoryIcon(cat.icon, isActive)}
                  <span
                    className={`text-[11px] tracking-[-0.01em] whitespace-nowrap ${
                      isActive ? 'font-semibold' : 'font-normal'
                    }`}
                  >
                    {shortName}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Right Arrow Button */}
          <button
            type="button"
            onClick={() => handleScroll('right')}
            className="hidden md:flex absolute right-0 z-10 w-8 h-8 rounded-full bg-[rgba(24,30,52,0.9)] backdrop-blur shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_2px_8px_rgba(0,0,0,0.4)] items-center justify-center text-[#f5f5f7] hover:scale-105 active:scale-95 transition-transform duration-200 ease-apple-spring"
            aria-label="Scroll categories right"
          >
            <ChevronRight className="w-4 h-4 stroke-[2.5]" />
          </button>
        </div>

        {/* ROW 2: Filter Pills Strip (Desktop only - mobile uses search pill filter button) */}
        <div className="hidden md:flex items-center gap-2 pt-2.5 overflow-x-auto no-scrollbar">
          
          {/* All Filters Button - Clean Airbnb White Pill */}
          <button
            type="button"
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className={`ic-chip flex items-center gap-2 px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              hasActiveFilters ? 'is-on' : ''
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5 stroke-[2.2]" />
            <span>Filters</span>
            {hasActiveFilters && (
              <span className="w-1.5 h-1.5 rounded-full bg-[#FF385C]" />
            )}
          </button>

          {/* ⚡ API Apply Only Toggle Pill */}
          {setDirectAtsOnly && (
            <button
              type="button"
              onClick={() => setDirectAtsOnly(!directAtsOnly)}
              // Keeps its green: it is the one chip that says something about the
              // job rather than filtering it, and losing the colour lost that.
              // Everything else about it is the shared chip -- half-pixel ring,
              // weight 500, spring press -- so it stops shouting.
              className={`ic-chip flex items-center gap-1.5 px-3 py-1.5 text-xs shrink-0 cursor-pointer ${
                directAtsOnly
                  ? '!bg-emerald-600 !text-white !shadow-[0_0_0_0.5px_theme(colors.emerald.700),0_2px_8px_rgba(5,150,105,0.3)]'
                  : '!text-emerald-800 !bg-emerald-50/80 hover:!bg-emerald-50 !shadow-[0_0_0_0.5px_rgba(5,150,105,0.3)]'
              }`}
            >
              <Zap className={`w-3.5 h-3.5 ${directAtsOnly ? 'text-white fill-white' : 'text-emerald-600 fill-emerald-600'}`} />
              <span>1-Click Apply</span>
            </button>
          )}

          {/* Remote */}
          <button
            type="button"
            onClick={() => setRemoteType(remoteType === 'Remote' ? '' : 'Remote')}
            className={`ic-chip px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              remoteType === 'Remote'
                ? 'is-on'
                : ''
            }`}
          >
            Remote
          </button>

          {/* Hybrid */}
          <button
            type="button"
            onClick={() => setRemoteType(remoteType === 'Hybrid' ? '' : 'Hybrid')}
            className={`ic-chip px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              remoteType === 'Hybrid'
                ? 'is-on'
                : ''
            }`}
          >
            Hybrid
          </button>

          {/* Full-time */}
          <button
            type="button"
            onClick={() => setJobType(jobType === 'Full-time' ? '' : 'Full-time')}
            className={`ic-chip px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              jobType === 'Full-time'
                ? 'is-on'
                : ''
            }`}
          >
            Full-time
          </button>

          {/* Visa Sponsorship */}
          <button
            type="button"
            onClick={() => setVisaSponsorshipOnly(!visaSponsorshipOnly)}
            className={`ic-chip px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              visaSponsorshipOnly
                ? 'is-on'
                : ''
            }`}
          >
            Visa Support
          </button>

          {/* €60k+ */}
          <button
            type="button"
            onClick={() => setMinSalary(minSalary === 60000 ? 0 : 60000)}
            className={`ic-chip px-3.5 py-1.5 text-xs shrink-0 cursor-pointer ${
              minSalary === 60000
                ? 'is-on'
                : ''
            }`}
          >
            €60k+
          </button>

          {/* Reset Filters */}
          {hasPillFilters && (
            <button
              type="button"
              onClick={() => {
                setJobType('');
                setRemoteType('');
                setMinSalary(0);
                setVisaSponsorshipOnly(false);
                if (setDirectAtsOnly) setDirectAtsOnly(false);
              }}
              className="flex items-center gap-1 text-xs font-bold text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] underline ml-auto shrink-0 px-2 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          )}

        </div>

        {/* Filter Popover Modal / Dropdown */}
        {showFilterDropdown && (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="ic-popover rounded-3xl w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between pb-4 border-b border-white/10">
                <h3 className="text-base font-bold text-[#f5f5f7]">Job Filters</h3>
                <button
                  type="button"
                  onClick={() => setShowFilterDropdown(false)}
                  className="p-1.5 text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7] rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="py-5 space-y-5">
                {/* Workplace Format */}
                <div>
                  <label className="block text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider mb-2">
                    Work Location
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {['', 'Remote', 'Hybrid', 'On-site'].map((type) => (
                      <button
                        type="button"
                        key={type || 'all'}
                        onClick={() => setRemoteType(type)}
                        className={`px-3 py-2 text-xs font-semibold rounded-xl border text-center transition ${
                          remoteType === type
                            ? 'bg-[#0a84ff] text-white border-transparent'
                            : 'border-white/15 text-[rgba(235,235,245,0.62)] hover:bg-white/[0.08]'
                        }`}
                      >
                        {type || 'All'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Employment Type */}
                <div>
                  <label className="block text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider mb-2">
                    Employment Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {['', 'Full-time', 'Contract'].map((type) => (
                      <button
                        type="button"
                        key={type || 'any'}
                        onClick={() => setJobType(type)}
                        className={`px-3 py-2 text-xs font-semibold rounded-xl border text-center transition ${
                          jobType === type
                            ? 'bg-[#0a84ff] text-white border-transparent'
                            : 'border-white/15 text-[rgba(235,235,245,0.62)] hover:bg-white/[0.08]'
                        }`}
                      >
                        {type || 'All'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Salary slider */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider">
                      Minimum Salary
                    </span>
                    <span className="text-sm font-extrabold text-[#FF385C]">
                      {minSalary > 0 ? `€${(minSalary / 1000)}k / year` : 'Any salary'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="200000"
                    step="10000"
                    value={minSalary}
                    onChange={(e) => setMinSalary(Number(e.target.value))}
                    className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-[#FF385C]"
                  />
                </div>

                {/* Visa Sponsorship */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={visaSponsorshipOnly}
                      onChange={(e) => setVisaSponsorshipOnly(e.target.checked)}
                      className="w-4 h-4 text-[#FF385C] rounded border-white/25 bg-transparent focus:ring-[#FF385C]"
                    />
                    <span className="text-xs font-bold text-[#f5f5f7]">
                      Visa Sponsorship Available
                    </span>
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-white/10 flex items-center justify-between">
                <button
                  type="button"
                  onClick={onResetFilters}
                  className="text-xs font-bold text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] underline"
                >
                  Clear all
                </button>
                <button
                  type="button"
                  onClick={() => setShowFilterDropdown(false)}
                  className="px-6 py-2.5 bg-[#0a84ff] text-white rounded-xl text-xs font-bold hover:bg-[#3b9bff] transition"
                >
                  Show {totalResults} Jobs
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
