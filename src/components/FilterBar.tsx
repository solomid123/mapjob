import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  SlidersHorizontal,
  X,
  Zap,
  Briefcase,
  Cpu,
  Rocket,
  Layers,
  Activity,
  Bot,
  Shield,
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

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Cpu,
  Rocket,
  Layers,
  Activity,
  Zap,
  Bot,
  Shield,
  Briefcase,
};

/**
 * Every filter in the app, behind one glyph.
 *
 * This used to be a 118px island holding a horizontal carousel of eight
 * disciplines and a row of seven pills -- about a fifth of the window,
 * permanently, to show choices that are almost always left alone. iCloud does
 * not do that: the toolbar is a handful of glyphs and the options live behind
 * them.
 *
 * So the strip is gone and this is one round button beside the result count,
 * in the same vocabulary as the ribbon glyphs above it. Nothing was dropped on
 * the way: the discipline picker and the 1-Click Apply toggle moved into the
 * sheet, which already held work location, employment type, salary and visa.
 */
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
  const [open, setOpen] = useState(false);

  // A sheet this size over the whole window needs the key everyone reaches for
  // first. Clicking the scrim works too, but it is not always visible.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Filters"
        aria-label="Filters"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`ic-fill ic-glass w-9 h-9 rounded-full flex items-center justify-center relative shrink-0 cursor-pointer text-[rgba(235,235,245,0.78)] hover:text-[#f5f5f7] ${
          hasActiveFilters ? 'is-on' : ''
        }`}
      >
        <SlidersHorizontal className="w-[17px] h-[17px] stroke-[1.8]" />
        {/* With the strip gone this dot is the only thing left saying that a
          * filter is narrowing the list. Ringed in the tile colour so it reads
          * as sitting on the button rather than punched into it. */}
        {hasActiveFilters && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#FF385C] ring-2 ring-[rgba(9,15,33,0.9)]" />
        )}
      </button>

      {/* Portalled to <body>. Anything carrying a backdrop-filter becomes the
        * containing block for its fixed-position descendants, and this sheet
        * has already been laid out inside a header strip and stacked under the
        * map once because of it. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-label="Job filters"
            className="ic-popover rounded-3xl w-full max-w-md max-h-[86vh] overflow-y-auto custom-scrollbar p-6 animate-in fade-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-4 border-b border-white/10">
              <h3 className="text-base font-bold text-[#f5f5f7]">Job Filters</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="ic-fill w-8 h-8 rounded-full flex items-center justify-center cursor-pointer text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-5 space-y-5">
              {/* Discipline. This was the carousel across the top of the page;
                * it is one grid here and costs nothing while the sheet is
                * shut. */}
              <div>
                <label className="block text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider mb-2">
                  Discipline
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {CATEGORIES.map((cat) => {
                    const Icon = CATEGORY_ICONS[cat.icon] ?? Briefcase;
                    const isActive = selectedCategory === cat.id;
                    return (
                      <button
                        type="button"
                        key={cat.id}
                        onClick={() => setSelectedCategory(cat.id)}
                        className={`ic-press-wide flex items-center gap-2 px-3 py-2.5 text-[12px] font-medium rounded-xl text-left cursor-pointer ${
                          isActive
                            ? 'bg-[#0a84ff] text-white'
                            : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{cat.name.split('(')[0].trim()}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 1-Click Apply. Was a bolt-marked pill in the strip. */}
              {setDirectAtsOnly && (
                <button
                  type="button"
                  onClick={() => setDirectAtsOnly(!directAtsOnly)}
                  className={`ic-press-wide w-full flex items-center gap-3 px-3.5 py-3 rounded-xl text-left cursor-pointer ${
                    directAtsOnly
                      ? 'bg-[#0a84ff] text-white'
                      : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
                  }`}
                >
                  <Zap className={`w-4 h-4 shrink-0 ${directAtsOnly ? 'fill-white' : 'fill-current'}`} />
                  <span className="text-xs font-bold">1-Click Apply only</span>
                  <span
                    className={`ml-auto text-[11px] font-medium ${
                      directAtsOnly ? 'text-white/70' : 'text-[rgba(235,235,245,0.42)]'
                    }`}
                  >
                    Straight into the ATS
                  </span>
                </button>
              )}

              {/* Workplace Format */}
              <div>
                <label className="block text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider mb-2">
                  Work Location
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {['', 'Remote', 'Hybrid', 'On-site'].map((type) => (
                    <button
                      type="button"
                      key={type || 'all'}
                      onClick={() => setRemoteType(type)}
                      className={`ic-press-wide px-2 py-2 text-xs font-semibold rounded-xl text-center cursor-pointer ${
                        remoteType === type
                          ? 'bg-[#0a84ff] text-white'
                          : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
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
                      className={`ic-press-wide px-3 py-2 text-xs font-semibold rounded-xl text-center cursor-pointer ${
                        jobType === type
                          ? 'bg-[#0a84ff] text-white'
                          : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
                      }`}
                    >
                      {type || 'All'}
                    </button>
                  ))}
                </div>
              </div>
              {/* Salary */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider">
                    Minimum Salary
                  </span>
                  <span className="text-sm font-extrabold text-[#FF385C]">
                    {minSalary > 0 ? `\u20AC${minSalary / 1000}k / year` : 'Any salary'}
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
                onClick={() => setOpen(false)}
                className="px-6 py-2.5 bg-[#0a84ff] text-white rounded-xl text-xs font-bold hover:bg-[#3b9bff] transition"
              >
                Show {totalResults} Jobs
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
