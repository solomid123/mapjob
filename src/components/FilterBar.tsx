import React, { useState } from 'react';
import { SlidersHorizontal, X, Zap } from 'lucide-react';

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

export const FilterBar: React.FC<FilterBarProps> = ({
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

  // Only consider pills themselves active for pill-level reset and indicator
  const hasPillFilters = Boolean(
    jobType ||
    remoteType ||
    minSalary > 0 ||
    visaSponsorshipOnly
  );

  return (
    <div className="bg-white border-b border-gray-200 py-3 select-none">
      <div className="max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 flex items-center gap-3 overflow-x-auto no-scrollbar">
        
        {/* All Filters Button - Clean Airbnb White Pill */}
        <button
          onClick={() => setShowFilterDropdown(!showFilterDropdown)}
          className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-bold border transition shrink-0 bg-white text-gray-800 border-gray-300 hover:border-gray-900 cursor-pointer"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 stroke-[2.2]" />
          <span>Filters</span>
          {hasActiveFilters && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#FF385C]" />
          )}
        </button>

        {/* ⚡ 1-Click Apply Only Toggle Pill */}
        {setDirectAtsOnly && (
          <button
            type="button"
            onClick={() => setDirectAtsOnly(!directAtsOnly)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold border transition shrink-0 cursor-pointer ${
              directAtsOnly
                ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs ring-2 ring-emerald-300'
                : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:border-emerald-400 hover:bg-emerald-100/70'
            }`}
            title="Filter to only jobs with direct 1-click ATS applications (Greenhouse, Lever, Ashby, Workday, etc.) without external account barriers"
          >
            <Zap className={`w-3.5 h-3.5 ${directAtsOnly ? 'text-amber-300 fill-amber-300' : 'text-emerald-600 fill-emerald-600'}`} />
            <span>1-Click Apply Only</span>
          </button>
        )}

        {/* Remote */}
        <button
          onClick={() => setRemoteType(remoteType === 'Remote' ? '' : 'Remote')}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            remoteType === 'Remote'
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          Remote
        </button>

        {/* Hybrid */}
        <button
          onClick={() => setRemoteType(remoteType === 'Hybrid' ? '' : 'Hybrid')}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            remoteType === 'Hybrid'
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          Hybrid
        </button>

        {/* Full-time */}
        <button
          onClick={() => setJobType(jobType === 'Full-time' ? '' : 'Full-time')}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            jobType === 'Full-time'
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          Full-time
        </button>

        {/* Visa Sponsorship */}
        <button
          onClick={() => setVisaSponsorshipOnly(!visaSponsorshipOnly)}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            visaSponsorshipOnly
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          Visa Sponsorship
        </button>

        {/* €60k+ Salary */}
        <button
          onClick={() => setMinSalary(minSalary === 60000 ? 0 : 60000)}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            minSalary === 60000
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          €60k+ Salary
        </button>

        {/* €80k+ Salary */}
        <button
          onClick={() => setMinSalary(minSalary === 80000 ? 0 : 80000)}
          className={`px-4 py-2 rounded-full text-xs font-semibold border transition shrink-0 cursor-pointer ${
            minSalary === 80000
              ? 'bg-gray-900 text-white border-gray-900 shadow-xs'
              : 'bg-white text-gray-800 border-gray-300 hover:border-gray-900'
          }`}
        >
          €80k+ Salary
        </button>

        {/* Clear Filters button */}
        {hasPillFilters && (
          <button
            onClick={() => {
              setJobType('');
              setRemoteType('');
              setMinSalary(0);
              setVisaSponsorshipOnly(false);
            }}
            className="flex items-center gap-1 text-xs font-bold text-gray-500 hover:text-gray-900 underline ml-auto shrink-0 px-2 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
        )}

        {/* Filter Popover Modal / Dropdown */}
        {showFilterDropdown && (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl shadow-2xl border border-gray-200 w-full max-w-md p-6 animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between pb-4 border-b border-gray-100">
                <h3 className="text-base font-bold text-gray-900">Job Filters</h3>
                <button
                  onClick={() => setShowFilterDropdown(false)}
                  className="p-1.5 text-gray-400 hover:text-gray-700 rounded-full"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="py-5 space-y-5">
                {/* Workplace Format */}
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">
                    Work Location
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {['', 'Remote', 'Hybrid', 'On-site'].map((type) => (
                      <button
                        key={type || 'all'}
                        onClick={() => setRemoteType(type)}
                        className={`px-3 py-2 text-xs font-semibold rounded-xl border text-center transition ${
                          remoteType === type
                            ? 'bg-gray-900 text-white border-gray-900'
                            : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        {type || 'All'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Employment Type */}
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">
                    Employment Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {['', 'Full-time', 'Contract'].map((type) => (
                      <button
                        key={type || 'any'}
                        onClick={() => setJobType(type)}
                        className={`px-3 py-2 text-xs font-semibold rounded-xl border text-center transition ${
                          jobType === type
                            ? 'bg-gray-900 text-white border-gray-900'
                            : 'border-gray-200 text-gray-700 hover:bg-gray-50'
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
                    <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                      Minimum Salary
                    </span>
                    <span className="text-sm font-extrabold text-[#FF385C]">
                      {minSalary > 0 ? `$${(minSalary / 1000)}k / year` : 'Any salary'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="200000"
                    step="10000"
                    value={minSalary}
                    onChange={(e) => setMinSalary(Number(e.target.value))}
                    className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#FF385C]"
                  />
                </div>

                {/* Visa Sponsorship */}
                <div>
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={visaSponsorshipOnly}
                      onChange={(e) => setVisaSponsorshipOnly(e.target.checked)}
                      className="w-4 h-4 text-[#FF385C] rounded border-gray-300 focus:ring-[#FF385C]"
                    />
                    <span className="text-xs font-bold text-gray-800">
                      Visa Sponsorship Available
                    </span>
                  </label>
                </div>
              </div>

              <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
                <button
                  onClick={onResetFilters}
                  className="text-xs font-bold text-gray-600 hover:text-black underline"
                >
                  Clear all
                </button>
                <button
                  onClick={() => setShowFilterDropdown(false)}
                  className="px-6 py-2.5 bg-gray-900 text-white rounded-xl text-xs font-bold hover:bg-black transition"
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
