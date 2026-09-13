import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Search, 
  MapPin, 
  Heart, 
  Menu, 
  User, 
  Briefcase, 
  Mail, 
  Sparkles, 
  X,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { CITIES } from '../data/mockJobs';
import { searchJobTitles } from '../data/jobTitles';

interface NavbarProps {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedCity: string;
  setSelectedCity: (cityId: string) => void;
  activeLocationLabel?: string;
  onSearchDestination?: (dest: string) => void;
  lastPosted: string;
  setLastPosted: (time: string) => void;
  savedCount: number;
  showSavedOnly: boolean;
  setShowSavedOnly: (saved: boolean) => void;
  onOpenPostJob: () => void;
  activeTopTab: 'jobs' | 'emails' | 'interview';
  setActiveTopTab: (tab: 'jobs' | 'emails' | 'interview') => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  searchQuery,
  setSearchQuery,
  selectedCity,
  setSelectedCity,
  activeLocationLabel: _activeLocationLabel = '',
  onSearchDestination,
  lastPosted,
  setLastPosted,
  savedCount,
  showSavedOnly,
  setShowSavedOnly,
  onOpenPostJob,
  activeTopTab,
  setActiveTopTab,
}) => {
  const [activeSegment, setActiveSegment] = useState<'where' | 'title' | 'posted' | null>(null);
  const searchBarRef = useRef<HTMLDivElement>(null);

  const [whereInput, setWhereInput] = useState('');

  // Recomputed only when the text changes, not on every keystroke elsewhere in
  // the bar. With the list this short the work is trivial either way; the memo
  // is here so the popover does not re-render while the map is loading.
  const titleSuggestions = useMemo(() => searchJobTitles(searchQuery), [searchQuery]);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchBarRef.current && !searchBarRef.current.contains(event.target as Node)) {
        setActiveSegment(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectCity = (cityId: string) => {
    setSelectedCity(cityId);
    const target = CITIES.find((c) => c.id === cityId);
    if (target) {
      setWhereInput(target.name);
    }
    setActiveSegment('title');
  };

  const handleSearchWhere = (input: string) => {
    setActiveSegment(null);
    if (!input.trim()) return;

    const lower = input.toLowerCase().trim();
    const match = CITIES.find(
      (c) => c.name.toLowerCase().includes(lower) || c.id.toLowerCase() === lower || lower.includes(c.id.toLowerCase())
    );
    if (match) {
      setSelectedCity(match.id);
      setWhereInput(match.name.split(',')[0]);
    } else if (onSearchDestination) {
      onSearchDestination(input.trim());
    }
  };

  const getLastPostedLabel = () => {
    switch (lastPosted) {
      case '24h': return 'Past 24 hours';
      case '3d': return 'Past 3 days';
      case '7d': return 'Past week';
      case '14d': return 'Past 14 days';
      case '30d': return 'Past month';
      default: return 'Anytime';
    }
  };

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-gray-200 select-none transition-all">
      <div className="max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8">
        
        {/* ROW 1: Logo (Left) | DEAD-CENTER TOP MENU (Grid centered, NO subpixel translate blur!) | Right Actions */}
        <div className="grid grid-cols-3 items-center h-20">
          
          {/* Col 1: Logo */}
          <div className="flex items-center justify-start">
            <div 
              className="flex items-center gap-2.5 cursor-pointer select-none shrink-0" 
              onClick={() => {
                setSearchQuery('');
                setShowSavedOnly(false);
                setActiveSegment(null);
              }}
            >
              <div className="w-10 h-10 rounded-2xl bg-[#FF385C] flex items-center justify-center text-white shadow-md shadow-rose-200">
                <MapPin className="w-6 h-6 stroke-[2.3]" />
              </div>
              <div className="hidden sm:block">
                <span className="text-2xl font-black tracking-tight text-[#FF385C]">
                  map<span className="text-gray-900 font-black">job</span>
                </span>
              </div>
            </div>
          </div>

          {/* Col 2: DEAD-CENTER TOP MENU (Exact physical pixel alignment, zero subpixel translation!) */}
          <div className="hidden md:flex items-center justify-center gap-8 lg:gap-10 text-sm font-semibold">
            
            {/* Tab 1: Jobs */}
            <button
              type="button"
              onClick={() => setActiveTopTab('jobs')}
              className={`flex items-center gap-2 pb-2.5 transition-colors duration-150 relative group cursor-pointer ${
                activeTopTab === 'jobs' 
                  ? 'text-[#222222] font-bold' 
                  : 'text-[#717171] hover:text-[#222222]'
              }`}
            >
              <Briefcase className={`w-4 h-4 ${activeTopTab === 'jobs' ? 'text-[#FF385C]' : ''}`} />
              <span className="text-[15px] tracking-tight">Jobs</span>
              {activeTopTab === 'jobs' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#222222] rounded-full" />
              )}
            </button>

            {/* Tab 2: Automated Emails */}
            <button
              type="button"
              onClick={() => setActiveTopTab('emails')}
              className={`flex items-center gap-2 pb-2.5 transition-colors duration-150 relative group cursor-pointer ${
                activeTopTab === 'emails' 
                  ? 'text-[#222222] font-bold' 
                  : 'text-[#717171] hover:text-[#222222]'
              }`}
            >
              <Mail className={`w-4 h-4 ${activeTopTab === 'emails' ? 'text-[#FF385C]' : ''}`} />
              <span className="text-[15px] tracking-tight">Automated Emails</span>
              {activeTopTab === 'emails' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#222222] rounded-full" />
              )}
            </button>

            {/* Tab 3: Interview Helper */}
            <button
              type="button"
              onClick={() => setActiveTopTab('interview')}
              className={`flex items-center gap-2 pb-2.5 transition-colors duration-150 relative group cursor-pointer ${
                activeTopTab === 'interview' 
                  ? 'text-[#222222] font-bold' 
                  : 'text-[#717171] hover:text-[#222222]'
              }`}
            >
              <Sparkles className={`w-4 h-4 ${activeTopTab === 'interview' ? 'text-[#FF385C]' : ''}`} />
              <span className="text-[15px] tracking-tight">Interview Helper</span>
              {activeTopTab === 'interview' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#222222] rounded-full" />
              )}
            </button>

          </div>

          {/* Col 3: Right Header Actions */}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onOpenPostJob}
              className="hidden lg:inline-block px-4 py-2 text-sm font-bold text-[#222222] hover:bg-gray-100 rounded-full transition"
            >
              Post a Job
            </button>

            {/* Saved Wishlist Button */}
            <button
              type="button"
              onClick={() => setShowSavedOnly(!showSavedOnly)}
              className={`p-2.5 rounded-full text-sm font-semibold transition relative hover:bg-gray-100 ${
                showSavedOnly ? 'text-[#FF385C]' : 'text-gray-700'
              }`}
              title="Saved Wishlist"
            >
              <Heart className={`w-5 h-5 ${showSavedOnly ? 'fill-[#FF385C] text-[#FF385C]' : 'text-gray-700'}`} />
              {savedCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-[#FF385C] text-white text-[10px] font-extrabold w-4 h-4 rounded-full flex items-center justify-center">
                  {savedCount}
                </span>
              )}
            </button>

            {/* Airbnb User Menu Pill */}
            <div className="border border-gray-300 rounded-full py-1.5 px-3.5 flex items-center gap-3 hover:shadow-md cursor-pointer transition ml-1">
              <Menu className="w-4 h-4 text-gray-600" />
              <div className="w-7 h-7 rounded-full bg-gray-600 text-white flex items-center justify-center">
                <User className="w-4 h-4" />
              </div>
            </div>
          </div>

        </div>

        {/* ROW 2: DEAD-CENTER AIRBNB SEARCH BAR (Where | Job Title | Last Posted + Search) */}
        {activeTopTab === 'jobs' && (
          <div ref={searchBarRef} className="pb-6 hidden md:block">
            <div className="max-w-4xl mx-auto relative">
              
              {/* Floating Multi-segment Search Pill Bar - Razor-sharp HD */}
              <div className="bg-white h-[66px] rounded-full border border-[#DDDDDD] hover:border-[#B0B0B0] flex items-center shadow-[0_3px_12px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_4px_16px_rgba(0,0,0,0.1)] p-2 relative transition-[border-color,box-shadow] duration-150">
                
                {/* 1. WHERE (Location) */}
                <div
                  onClick={() => setActiveSegment('where')}
                  className={`flex-1 h-full px-6 flex flex-col justify-center rounded-full cursor-pointer transition-colors ${
                    activeSegment === 'where'
                      ? 'bg-[#F7F7F7]'
                      : 'hover:bg-[#F7F7F7]'
                  }`}
                >
                  <span className="block text-[12px] font-bold text-[#222222] tracking-wider uppercase leading-none mb-1">
                    Where
                  </span>
                  <input
                    type="text"
                    value={whereInput}
                    onChange={(e) => {
                      setWhereInput(e.target.value);
                      if (activeSegment !== 'where') setActiveSegment('where');
                    }}
                    onFocus={() => {
                      setActiveSegment('where');
                    }}
                    onBlur={() => {
                      // Allow click handlers inside dropdown to fire before closing
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleSearchWhere(whereInput);
                      }
                    }}
                    placeholder="Search city, region, or country..."
                    className="w-full bg-transparent text-[14px] font-medium text-[#222222] placeholder:text-[#717171] outline-none leading-tight"
                  />
                </div>

                <div className="w-[1px] h-8 bg-[#DDDDDD] shrink-0" />

                {/* 2. JOB TITLE */}
                <div
                  // Opens, never toggles. Clicking the input focuses it first,
                  // and a toggle would read that focus as "already open" and
                  // shut the list again on the very click meant to show it.
                  onClick={() => setActiveSegment('title')}
                  className={`flex-[1.2] h-full px-6 flex flex-col justify-center rounded-full cursor-pointer transition-colors ${
                    activeSegment === 'title'
                      ? 'bg-[#F7F7F7]'
                      : 'hover:bg-[#F7F7F7]'
                  }`}
                >
                  <span className="block text-[12px] font-bold text-[#222222] tracking-wider uppercase leading-none mb-1">
                    Job Title
                  </span>
                  <input
                    type="text"
                    placeholder="Mechanical Engineer, Ingénieur Mécanique…"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      // Typing re-opens the list even if it was dismissed, so
                      // the suggestions track what is in the box.
                      setActiveSegment('title');
                    }}
                    onFocus={() => setActiveSegment('title')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        // Take the top suggestion when the text is a prefix of
                        // it and nothing has been picked; otherwise search the
                        // literal text, which may be a title we do not list.
                        const top = titleSuggestions[0];
                        if (top && searchQuery.trim() && searchQuery !== top.title) {
                          setSearchQuery(top.title);
                        }
                        setActiveSegment(null);
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        setActiveSegment(null);
                        e.currentTarget.blur();
                      }
                    }}
                    className="w-full bg-transparent text-[14px] font-medium text-[#222222] placeholder:text-[#717171] outline-none leading-tight"
                  />
                </div>

                <div className="w-[1px] h-8 bg-[#DDDDDD] shrink-0" />

                {/* 3. LAST POSTED (Matches When/Dates) */}
                <div
                  onClick={() => setActiveSegment(activeSegment === 'posted' ? null : 'posted')}
                  className={`flex-1 h-full px-6 flex items-center justify-between rounded-full cursor-pointer transition-colors ${
                    activeSegment === 'posted'
                      ? 'bg-[#F7F7F7]'
                      : 'hover:bg-[#F7F7F7]'
                  }`}
                >
                  <div className="flex flex-col justify-center min-w-0 pr-2">
                    <span className="block text-[12px] font-bold text-[#222222] tracking-wider uppercase leading-none mb-1">
                      Last Posted
                    </span>
                    <span className="block text-[14px] font-medium text-[#222222] truncate leading-tight">
                      {getLastPostedLabel()}
                    </span>
                  </div>

                  {lastPosted !== 'all' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLastPosted('all');
                      }}
                      className="p-1 hover:bg-gray-200 rounded-full text-gray-500 hover:text-gray-900 shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* 4. SEARCH BUTTON (Airbnb Pink Pill) */}
                <div className="pl-2 pr-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (activeSegment === 'where') {
                        handleSearchWhere(whereInput);
                      } else {
                        setActiveSegment(null);
                      }
                    }}
                    className="h-12 px-6 rounded-full bg-[#FF385C] hover:bg-[#E00B41] text-white font-bold text-[14px] flex items-center gap-2 shadow-sm transition active:scale-95 cursor-pointer"
                  >
                    <Search className="w-4 h-4 stroke-[2.8]" />
                    <span>Search</span>
                  </button>
                </div>

              </div>

              {/* POPOVER 1: WHERE (Suggested Destinations with Airbnb Landmark Icons) */}
              {activeSegment === 'where' && (
                <div className="absolute left-0 top-full mt-3 w-[440px] bg-white rounded-[28px] shadow-[0_16px_40px_rgba(0,0,0,0.16)] border border-gray-100 p-5 z-50 animate-airbnb-pop">
                  <div className="flex items-center justify-between mb-3 px-2">
                    <span className="text-xs font-bold text-gray-800">
                      {whereInput.trim() ? `Destinations matching "${whereInput}"` : 'Suggested European hubs'}
                    </span>
                    <span className="text-[11px] text-gray-400 font-medium">Type any city or select</span>
                  </div>

                  <div className="max-h-[390px] overflow-y-auto pr-1 space-y-1">
                    {/* Direct search option for custom typed location */}
                    {whereInput.trim().length > 1 && (
                      <div
                        onClick={() => handleSearchWhere(whereInput)}
                        className="flex items-center gap-3 p-3 rounded-2xl cursor-pointer bg-rose-50/80 hover:bg-rose-100 text-[#FF385C] font-bold text-sm border border-rose-200/80 transition mb-2"
                      >
                        <div className="w-9 h-9 rounded-xl bg-[#FF385C] flex items-center justify-center text-white shrink-0 shadow-xs">
                          <Search className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-gray-900">
                            Search <span className="font-black text-[#FF385C]">"{whereInput.trim()}"</span> on live map
                          </span>
                          <span className="block text-[11px] text-gray-500 font-normal truncate">
                            Fly map to visible area and fetch live jobs
                          </span>
                        </div>
                      </div>
                    )}

                    {[
                      {
                        id: 'nearby',
                        cityTarget: 'eindhoven',
                        name: 'Nearby Hubs',
                        subtitle: "Find engineering centers around you",
                        bgColor: 'bg-[#EBF5FB]',
                        borderColor: 'border-[#D4E8F8]',
                        iconColor: 'text-[#0070BA]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="3 3 10 21 13 13 21 10 3 3" />
                            <line x1="13" y1="13" x2="21" y2="3" strokeWidth="1.8" />
                          </svg>
                        ),
                      },
                      {
                        id: 'luxembourg',
                        cityTarget: 'luxembourg',
                        name: 'Luxembourg',
                        subtitle: 'ArcelorMittal R&D, Goodyear & Automotive (LU)',
                        bgColor: 'bg-[#FDF0F3]',
                        borderColor: 'border-[#FBD6DD]',
                        iconColor: 'text-[#C23555]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 9h18v2H3z" />
                            <path d="M10 5l2-2 2 2M12 3v6" />
                            <path d="M5 11v8M8 11v8M11 11v8M13 11v8M16 11v8M19 11v8" />
                            <path d="M2 19h20v2H2z" />
                          </svg>
                        ),
                      },
                      {
                        id: 'eindhoven',
                        cityTarget: 'eindhoven',
                        name: 'Eindhoven',
                        subtitle: 'ASML, Brainport & High-Tech (NL)',
                        bgColor: 'bg-[#EDF7EE]',
                        borderColor: 'border-[#D6EDD8]',
                        iconColor: 'text-[#1E7B42]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="6" width="6" height="11" rx="0.5" />
                            <path d="M5 9h2M5 12h2M5 15h2" />
                            <rect x="9" y="9" width="4" height="8" rx="0.5" />
                            <path d="M11 12h1M11 15h1" />
                            <path d="M18 17v-8M16.5 12l1.5-3 1.5 3M15.5 15l2.5-3 2.5 3" />
                            <path d="M3 19h18M5 21h14" />
                          </svg>
                        ),
                      },
                      {
                        id: 'paris',
                        cityTarget: 'paris',
                        name: 'Paris',
                        subtitle: 'Automotive, Rail, Dassault & Energy R&D (FR)',
                        bgColor: 'bg-[#EFF2FC]',
                        borderColor: 'border-[#DCE2F8]',
                        iconColor: 'text-[#3D52A0]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2v2" />
                            <path d="M10.5 4h3" />
                            <path d="M10.5 4L9 11h6l-1.5-7" />
                            <path d="M8 11h8" />
                            <path d="M9 11L5 22" />
                            <path d="M15 11l4 11" />
                            <path d="M8 22c0-2.5 1.8-4.5 4-4.5s4 2 4 4.5" />
                            <path d="M10 8h4" />
                          </svg>
                        ),
                      },
                      {
                        id: 'toulouse',
                        cityTarget: 'toulouse',
                        name: 'Toulouse',
                        subtitle: 'Airbus, Safran & Satellite Systems (FR)',
                        bgColor: 'bg-[#FFF2EB]',
                        borderColor: 'border-[#FCE1D2]',
                        iconColor: 'text-[#D84C24]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2l3 7h6l-5 4 2 7-6-4-6 4 2-7-5-4h6z" />
                          </svg>
                        ),
                      },
                      {
                        id: 'brussels',
                        cityTarget: 'brussels',
                        name: 'Brussels',
                        subtitle: 'Aero-structures, Sonaca & Automation (BE)',
                        bgColor: 'bg-[#FBF6EE]',
                        borderColor: 'border-[#F2E5D0]',
                        iconColor: 'text-[#916223]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 20V9l2-4 2 4v11" />
                            <path d="M16 20V9l2-4 2 4v11" />
                            <path d="M6 9h12M6 11h12" />
                            <path d="M8 16h8" />
                            <path d="M2 16h2M20 16h2" />
                            <path d="M2 13c1 1 1.5 2 2 3M22 13c-1 1-1.5 2-2 3" />
                          </svg>
                        ),
                      },
                      {
                        id: 'munich',
                        cityTarget: 'munich',
                        name: 'Munich',
                        subtitle: 'BMW, Siemens & Precision Robotics (DE)',
                        bgColor: 'bg-[#F0F4F8]',
                        borderColor: 'border-[#D9E2EC]',
                        iconColor: 'text-[#334E68]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 3v18M3 12h18" />
                          </svg>
                        ),
                      },
                      {
                        id: 'stuttgart',
                        cityTarget: 'stuttgart',
                        name: 'Stuttgart',
                        subtitle: 'Mercedes-Benz, Porsche, Bosch & Powertrain (DE)',
                        bgColor: 'bg-[#EBF5FB]',
                        borderColor: 'border-[#D4E8F8]',
                        iconColor: 'text-[#0070BA]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                          </svg>
                        ),
                      },
                      {
                        id: 'amsterdam',
                        cityTarget: 'amsterdam',
                        name: 'Amsterdam',
                        subtitle: 'Advanced High-Tech & Semiconductors (NL)',
                        bgColor: 'bg-[#EDF7EE]',
                        borderColor: 'border-[#D6EDD8]',
                        iconColor: 'text-[#1E7B42]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 21h18M5 21V7l8-4v18M13 21V11l6-3v13" />
                          </svg>
                        ),
                      },
                      {
                        id: 'rotterdam',
                        cityTarget: 'rotterdam',
                        name: 'Rotterdam',
                        subtitle: 'Offshore, Marine Propulsion & Heavy Machinery (NL)',
                        bgColor: 'bg-[#EBF5FB]',
                        borderColor: 'border-[#D4E8F8]',
                        iconColor: 'text-[#0070BA]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="5" r="3" />
                            <line x1="12" y1="22" x2="12" y2="8" />
                            <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
                          </svg>
                        ),
                      },
                      {
                        id: 'turin',
                        cityTarget: 'turin',
                        name: 'Turin & Motor Valley (IT)',
                        subtitle: 'Stellantis, Iveco & Hypercar Powertrain',
                        bgColor: 'bg-[#FFF2EB]',
                        borderColor: 'border-[#FCE1D2]',
                        iconColor: 'text-[#D84C24]',
                        icon: (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                          </svg>
                        ),
                      },
                    ]
                      .filter((dest) => {
                        if (!whereInput.trim()) return true;
                        const q = whereInput.toLowerCase().trim();
                        return (
                          dest.name.toLowerCase().includes(q) ||
                          dest.subtitle.toLowerCase().includes(q) ||
                          dest.cityTarget.toLowerCase().includes(q)
                        );
                      })
                      .map((dest) => {
                        const isSelected = selectedCity === dest.cityTarget && dest.id !== 'nearby';
                        return (
                          <div
                            key={dest.id}
                            onClick={() => handleSelectCity(dest.cityTarget)}
                            className={`flex items-center gap-4 p-2.5 rounded-2xl cursor-pointer transition-all duration-150 airbnb-spring group ${
                              isSelected 
                                ? 'bg-rose-50/70 border border-rose-200/80 shadow-xs' 
                                : 'hover:bg-gray-100/80 border border-transparent'
                            }`}
                          >
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border transition-transform duration-200 group-hover:scale-105 ${dest.bgColor} ${dest.borderColor} ${dest.iconColor}`}>
                              {dest.icon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="block font-bold text-sm text-gray-900 group-hover:text-black truncate">
                                {dest.name}
                              </span>
                              <span className="block text-xs text-gray-500 truncate">
                                {dest.subtitle}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* POPOVER 2: JOB TITLE (real titles, filtered as you type) */}
              {activeSegment === 'title' && titleSuggestions.length > 0 && (
                <div className="absolute left-1/4 top-full mt-3 w-96 bg-white rounded-3xl shadow-[0_16px_40px_rgba(0,0,0,0.18)] border border-gray-100 p-3 z-50 animate-airbnb-pop">
                  <div className="text-[11px] font-extrabold text-gray-500 uppercase tracking-wider mb-2 px-3 pt-2">
                    {searchQuery.trim() ? 'Matching Roles' : 'Popular Roles'}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {titleSuggestions.map((role) => (
                      <button
                        key={role.title}
                        type="button"
                        // onMouseDown, not onClick: the input's blur fires first
                        // on a click and closes the popover out from under the
                        // pointer, so the click never lands on anything.
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setSearchQuery(role.title);
                          setActiveSegment('posted');
                        }}
                        className={`w-full flex items-center justify-between gap-3 text-left px-3 py-2.5 rounded-2xl transition-all airbnb-spring active:scale-[0.98] ${
                          searchQuery === role.title
                            ? 'bg-gray-900 text-white'
                            : 'hover:bg-gray-100 text-gray-900'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Search
                            className={`w-3.5 h-3.5 shrink-0 ${
                              searchQuery === role.title ? 'text-white' : 'text-gray-400'
                            }`}
                          />
                          <span className="text-sm font-semibold truncate">{role.title}</span>
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${
                            searchQuery === role.title
                              ? 'bg-white/20 text-white'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {role.lang}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* POPOVER 3: LAST POSTED (Matches Airbnb Date/Calendar Picker with Airbnb Pop Animation) */}
              {activeSegment === 'posted' && (
                <div className="absolute right-0 top-full mt-3 w-[460px] bg-white rounded-3xl shadow-[0_16px_40px_rgba(0,0,0,0.18)] border border-gray-100 p-6 z-50 animate-airbnb-pop">
                  
                  {/* Top toggle: Exact dates / Flexible */}
                  <div className="flex justify-center mb-5">
                    <div className="inline-flex p-1 bg-gray-100 rounded-full">
                      <button
                        type="button"
                        className="px-6 py-2 rounded-full text-xs font-bold bg-white text-gray-900 shadow-sm transition"
                      >
                        Dates
                      </button>
                      <button
                        type="button"
                        className="px-6 py-2 rounded-full text-xs font-semibold text-gray-500 hover:text-gray-900 transition"
                      >
                        Flexible
                      </button>
                    </div>
                  </div>

                  {/* Calendar simulation */}
                  <div className="mb-5 border-b border-gray-100 pb-5">
                    <div className="flex items-center justify-between mb-3 px-2">
                      <button type="button" className="p-1 hover:bg-gray-100 rounded-full text-gray-500 transition">
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="font-extrabold text-sm text-gray-900">
                        September 2026
                      </span>
                      <button type="button" className="p-1 hover:bg-gray-100 rounded-full text-gray-500 transition">
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-gray-400 mb-2">
                      <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold">
                      {[...Array(30)].map((_, i) => {
                        const day = i + 1;
                        const isToday = day === 4;
                        const isSelectedRange = day >= 1 && day <= 4;
                        return (
                          <div
                            key={day}
                            onClick={() => {
                              if (day === 4) setLastPosted('24h');
                              else if (day >= 2) setLastPosted('3d');
                              else setLastPosted('7d');
                            }}
                            className={`h-9 flex items-center justify-center rounded-full cursor-pointer transition airbnb-spring ${
                              isToday
                                ? 'bg-gray-900 text-white font-bold scale-105 shadow-sm'
                                : isSelectedRange
                                ? 'bg-gray-100 text-gray-900'
                                : 'hover:bg-gray-100 text-gray-700'
                            }`}
                          >
                            {day}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Bottom Quick Select Pills */}
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {[
                      { id: 'all', label: 'Anytime' },
                      { id: '24h', label: 'Past 24h' },
                      { id: '3d', label: 'Past 3 days' },
                      { id: '7d', label: 'Past week' },
                      { id: '14d', label: 'Past 14 days' },
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setLastPosted(item.id);
                          setActiveSegment(null);
                        }}
                        className={`px-3.5 py-1.5 rounded-full text-xs font-bold border transition airbnb-spring active:scale-95 ${
                          lastPosted === item.id
                            ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                            : 'bg-white border-gray-200 text-gray-700 hover:border-gray-900'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                </div>
              )}

            </div>
          </div>
        )}

        {/* Mobile Search Input */}
        <div className="pb-3 md:hidden">
          <div className="relative">
            <input
              type="text"
              placeholder="Search roles, locations, skills..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-100 focus:bg-white border border-transparent focus:border-[#FF385C] rounded-full text-sm outline-none transition"
            />
            <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-3" />
          </div>
        </div>

      </div>
    </header>
  );
};
