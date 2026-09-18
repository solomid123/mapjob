import {
  encodePostedRange,
  formatPostedRange,
  monthGrid,
  parsePostedRange,
  toISODate,
} from '../utils/postedRange';
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { WallpaperPicker } from './WallpaperPicker';
import { ProfileMenu } from './ProfileMenu';
import {
  Search,
  Heart,
  Briefcase,
  Mail,
  Sparkles,
  PlusCircle,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown
} from 'lucide-react';
import { CITIES } from '../data/mockJobs';
import { searchJobTitles } from '../data/jobTitles';
import { Wordmark } from './Wordmark';


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
  appliedCount: number;
  showSavedOnly: boolean;
  setShowSavedOnly: (saved: boolean) => void;
  onOpenPostJob: () => void;
  activeTopTab: 'jobs' | 'emails' | 'interview';
  setActiveTopTab: (tab: 'jobs' | 'emails' | 'interview') => void;
  /** The result count and the filter glyph, to sit level with the search
   *  field on wide windows. Passed in rather than computed here because the
   *  count is the list's business, not the chrome's. */
  resultsSummary?: React.ReactNode;
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
  appliedCount,
  showSavedOnly,
  setShowSavedOnly,
  onOpenPostJob,
  activeTopTab,
  setActiveTopTab,
  resultsSummary,
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

  /* Calendar state. `pendingStart` holds the first click while the second is
   * still to come; `selectedRange` is the committed interval, derived from the
   * filter value itself so the popover reopens showing what is actually
   * applied rather than a stale local copy. */
  const today = new Date();
  const todayISO = toISODate(today);
  const selectedRange = parsePostedRange(lastPosted);
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const handleDayClick = (iso: string) => {
    // Third click starts a fresh range rather than silently extending the old
    // one, which is the behaviour every booking calendar has trained people on.
    if (selectedRange || !pendingStart) {
      setLastPosted('all');
      setPendingStart(iso);
      return;
    }
    // Clicking backwards past the start is an ordering, not a mistake.
    const [start, end] = iso < pendingStart ? [iso, pendingStart] : [pendingStart, iso];
    setPendingStart(null);
    setLastPosted(encodePostedRange(start, end));
  };

  const getLastPostedLabel = () => {
    if (selectedRange) return formatPostedRange(selectedRange);
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
    <>
      {/* THE RIBBON.
        *
        * Welded to the top edge: full bleed, square corners, 48px. It holds
        * the two things that are true no matter what you are doing -- who the
        * app is, and which of its three parts you are in -- and nothing else.
        * Search and filters used to share this bar and made it a 220px
        * masthead; they are their own islands below now. */}
      <header className="ic-ribbon sticky top-0 z-50 select-none">
        <div className="max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-12 gap-2">

            <Wordmark
              onClick={() => {
                setSearchQuery('');
                setShowSavedOnly(false);
                setActiveSegment(null);
                setActiveTopTab('jobs');
              }}
            />

            <div className="flex items-center gap-1">

              {/* The app switcher. Three glyphs, the current one filled --
                * iCloud's grid of apps, flattened out because there are only
                * three. The labels come back as tooltips; they were costing
                * ~280px of the widest row in the app to say three words that
                * never change. */}
              {([
                { id: 'jobs', label: 'Jobs', Icon: Briefcase },
                { id: 'emails', label: 'Automated Emails', Icon: Mail },
                { id: 'interview', label: 'Interview Helper', Icon: Sparkles },
              ] as const).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTopTab(id)}
                  title={label}
                  aria-label={label}
                  aria-pressed={activeTopTab === id}
                  /* Colour lives on the button, not the glyph, so `color`
                   * transitions with the fill and lucide's currentColor
                   * follows it. */
                  className={`ic-fill w-8 h-8 rounded-full flex items-center justify-center cursor-pointer text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] ${
                    activeTopTab === id ? 'is-on' : ''
                  }`}
                >
                  <Icon className={`w-4 h-4 ${activeTopTab === id ? 'stroke-[2.1]' : 'stroke-[1.8]'}`} />
                </button>
              ))}

              <span className="ic-ribbon-sep mx-1.5" />

              <button
                type="button"
                onClick={onOpenPostJob}
                title="Post a job"
                aria-label="Post a job"
                className="ic-fill w-8 h-8 rounded-full hidden sm:flex items-center justify-center cursor-pointer text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]"
              >
                <PlusCircle className="w-[17px] h-[17px] stroke-[1.8]" />
              </button>

              <button
                type="button"
                onClick={() => setShowSavedOnly(!showSavedOnly)}
                className="ic-fill w-8 h-8 rounded-full flex items-center justify-center relative cursor-pointer text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]"
                title="Saved jobs"
                aria-label="Saved jobs"
                aria-pressed={showSavedOnly}
              >
                <Heart className={`w-4 h-4 stroke-[1.8] ${showSavedOnly ? 'fill-[#FF385C] text-[#FF385C]' : ''}`} />
                {savedCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-[#FF385C] text-white text-[9px] font-semibold min-w-[15px] h-[15px] px-1 rounded-full flex items-center justify-center">
                    {savedCount}
                  </span>
                )}
              </button>

              <span className="hidden sm:block">
                <WallpaperPicker />
              </span>

              <ProfileMenu
                savedCount={savedCount}
                appliedCount={appliedCount}
                onShowSaved={() => setShowSavedOnly(true)}
                onOpenPostJob={onOpenPostJob}
              />
            </div>

          </div>
        </div>
      </header>

      {/* THE SEARCH ISLAND. Its own block on the wallpaper, floating clear of
        * the ribbon, with its own shadow and its own hover lift. */}
      {activeTopTab === 'jobs' && (
        <div className="px-4 sm:px-6 lg:px-8 pt-2.5 select-none">
          {/* This row is measured to the main grid below it, not to itself:
            * max-w-[1696px] is the 1760px content width minus its lg padding,
            * so the left edge here lands exactly on the left edge of the
            * listings column. That is the whole point of the row -- the result
            * count sits out there, level with the search field, which lets the
            * column start at the same height as the map instead of a heading's
            * worth lower. */}
          <div className="relative mx-auto max-w-[1696px] hidden md:block">
            {/* Only once there is room for it. The slot is the gap the centred
              * search field leaves on its left: half the row, less half the
              * field (448px), less a little air. Below 2xl that gap is too
              * narrow to hold a number and a glyph without crowding the field,
              * so the count stays at the top of the column instead. */}
            {resultsSummary && (
              <div className="hidden 2xl:flex absolute inset-y-0 left-0 w-[calc(50%-472px)] items-center">
                {resultsSummary}
              </div>
            )}
          <div ref={searchBarRef} className="ic-island max-w-4xl mx-auto p-2.5">
            <div className="relative">

              {/* Floating Multi-segment Search Pill Bar - Razor-sharp HD */}
              <div className="ic-searchfield h-[52px] flex items-center p-1 gap-0.5 relative">
                <Search className="w-[18px] h-[18px] text-[rgba(235,235,245,0.42)] shrink-0 ml-3 mr-1" />
                
                {/* 1. WHERE (Location) */}
                <div
                  onClick={() => setActiveSegment('where')}
                  className={`ic-segment flex-1 h-full px-3 flex items-center cursor-pointer ${
                    activeSegment === 'where' ? 'is-active' : ''
                  }`}
                >
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
                    placeholder="Where"
                    className="w-full bg-transparent text-[14px] font-normal tracking-[-0.01em] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.42)] outline-none leading-tight"
                  />
                </div>

                

                {/* 2. JOB TITLE */}
                <div
                  // Opens, never toggles. Clicking the input focuses it first,
                  // and a toggle would read that focus as "already open" and
                  // shut the list again on the very click meant to show it.
                  onClick={() => setActiveSegment('title')}
                  className={`ic-segment flex-[1.4] h-full px-3 flex items-center cursor-pointer ${
                    activeSegment === 'title' ? 'is-active' : ''
                  }`}
                >
                  <input
                    type="text"
                    placeholder="Job title"
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
                    className="w-full bg-transparent text-[14px] font-normal tracking-[-0.01em] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.42)] outline-none leading-tight"
                  />
                </div>

                

                {/* 3. LAST POSTED (Matches When/Dates) */}
                <div
                  onClick={() => setActiveSegment(activeSegment === 'posted' ? null : 'posted')}
                  className={`ic-segment flex-[0.8] h-full px-3 flex items-center justify-between gap-1 cursor-pointer ${
                    activeSegment === 'posted' ? 'is-active' : ''
                  }`}
                >
                  {/* No caption above it. iCloud never stacks a tiny uppercase
                    * field name over a value -- the value states its own case
                    * ("Anytime", "Past week") and the chevron says it opens. */}
                  <span className={`text-[14px] tracking-[-0.01em] truncate ${
                    lastPosted === 'all' ? 'text-[rgba(235,235,245,0.42)]' : 'text-[#f5f5f7]'
                  }`}>
                    {getLastPostedLabel()}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-[rgba(235,235,245,0.42)] transition-transform duration-200 ease-apple-out ${
                    activeSegment === 'posted' ? 'rotate-180' : ''
                  }`} />

                  {lastPosted !== 'all' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLastPosted('all');
                      }}
                      className="p-1 hover:bg-white/[0.12] rounded-full text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7] shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* The action lives inside the well as a tinted pill, the way
                  * Apple puts "Go" inside a field. A 48px red capsule bolted to
                  * the right end of a white bar is the Airbnb search bar's most
                  * recognisable single feature, and while it stayed the header
                  * could not read as anything else. */}
                <button
                  type="button"
                  onClick={() => {
                    if (activeSegment === 'where') {
                      handleSearchWhere(whereInput);
                    } else {
                      setActiveSegment(null);
                    }
                  }}
                  className="ic-press-wide h-[44px] px-5 mr-0.5 shrink-0 rounded-[12px] bg-[#0a84ff] hover:bg-[#3b9bff] text-white font-medium tracking-[-0.01em] text-[14px] flex items-center cursor-pointer"
                >
                  Search
                </button>

              </div>

              {/* POPOVER 1: WHERE (Suggested Destinations with Airbnb Landmark Icons) */}
              {activeSegment === 'where' && (
                <div className="ic-popover absolute left-0 top-full mt-3 w-[440px] p-5 z-50 animate-airbnb-pop">
                  <div className="flex items-center justify-between mb-3 px-2">
                    <span className="text-xs font-bold text-[#f5f5f7]">
                      {whereInput.trim() ? `Destinations matching "${whereInput}"` : 'Suggested European hubs'}
                    </span>
                    <span className="text-[11px] text-[rgba(235,235,245,0.42)] font-medium">Type any city or select</span>
                  </div>

                  <div className="max-h-[390px] overflow-y-auto pr-1 space-y-1">
                    {/* Direct search option for custom typed location */}
                    {whereInput.trim().length > 1 && (
                      <div
                        onClick={() => handleSearchWhere(whereInput)}
                        className="flex items-center gap-3 p-3 rounded-2xl cursor-pointer bg-[#FF385C]/15 hover:bg-[#FF385C]/25 text-[#ff7089] font-bold text-sm border border-[#FF385C]/30 transition mb-2"
                      >
                        <div className="w-9 h-9 rounded-xl bg-[#FF385C] flex items-center justify-center text-white shrink-0 shadow-xs">
                          <Search className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[#f5f5f7]">
                            Search <span className="font-black text-[#FF385C]">"{whereInput.trim()}"</span> on live map
                          </span>
                          <span className="block text-[11px] text-[rgba(235,235,245,0.42)] font-normal truncate">
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
                                ? 'bg-[#FF385C]/15 border border-[#FF385C]/30' 
                                : 'hover:bg-white/[0.08] border border-transparent'
                            }`}
                          >
                            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border transition-transform duration-200 group-hover:scale-105 ${dest.bgColor} ${dest.borderColor} ${dest.iconColor}`}>
                              {dest.icon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <span className="block font-bold text-sm text-[#f5f5f7] truncate">
                                {dest.name}
                              </span>
                              <span className="block text-xs text-[rgba(235,235,245,0.42)] truncate">
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
                <div className="ic-popover absolute left-1/4 top-full mt-3 w-96 p-3 z-50 animate-airbnb-pop">
                  <div className="text-[11px] font-extrabold text-[rgba(235,235,245,0.42)] uppercase tracking-wider mb-2 px-3 pt-2">
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
                            ? 'bg-[#0a84ff] text-white'
                            : 'hover:bg-white/[0.08] text-[#f5f5f7]'
                        }`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <Search
                            className={`w-3.5 h-3.5 shrink-0 ${
                              searchQuery === role.title ? 'text-white' : 'text-[rgba(235,235,245,0.42)]'
                            }`}
                          />
                          <span className="text-sm font-semibold truncate">{role.title}</span>
                        </span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0 ${
                            searchQuery === role.title
                              ? 'bg-white/20 text-white'
                              : 'bg-white/10 text-[rgba(235,235,245,0.62)]'
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
                <div className="ic-popover absolute right-0 top-full mt-3 w-[460px] p-6 z-50 animate-airbnb-pop">
                  
                  {/* Top toggle: Exact dates / Flexible */}
                  <div className="flex justify-center mb-5">
                    <div className="inline-flex p-1 bg-white/10 rounded-full">
                      <button
                        type="button"
                        className="px-6 py-2 rounded-full text-xs font-bold bg-white/20 text-[#f5f5f7] shadow-sm transition"
                      >
                        Dates
                      </button>
                      <button
                        type="button"
                        className="px-6 py-2 rounded-full text-xs font-semibold text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition"
                      >
                        Flexible
                      </button>
                    </div>
                  </div>

                  {/* A real calendar. Weekday-aligned, navigable, and it
                    * selects an interval: first click sets the start, second
                    * sets the end, a third starts over. Future days are
                    * disabled -- nothing can have been posted tomorrow. */}
                  <div className="mb-5 border-b border-white/10 pb-5">
                    <div className="flex items-center justify-between mb-3 px-2">
                      <button
                        type="button"
                        onClick={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
                        className="p-1 hover:bg-white/[0.1] rounded-full text-[rgba(235,235,245,0.62)] transition"
                        aria-label="Previous month"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="font-extrabold text-sm text-[#f5f5f7]">
                        {calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                      </span>
                      <button
                        type="button"
                        disabled={calMonth.getFullYear() === today.getFullYear() && calMonth.getMonth() === today.getMonth()}
                        onClick={() => setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
                        className="p-1 hover:bg-white/[0.1] rounded-full text-[rgba(235,235,245,0.62)] transition disabled:opacity-30 disabled:hover:bg-transparent"
                        aria-label="Next month"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold text-[rgba(235,235,245,0.42)] mb-2">
                      <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
                    </div>

                    <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold">
                      {monthGrid(calMonth.getFullYear(), calMonth.getMonth()).map((day, i) => {
                        if (day === null) return <div key={`blank-${i}`} className="h-9" />;

                        const iso = toISODate(new Date(calMonth.getFullYear(), calMonth.getMonth(), day));
                        const isFuture = iso > todayISO;
                        const isToday = iso === todayISO;
                        // While only the start is set, the cell under the
                        // cursor previews where the range would end.
                        const provisionalEnd = pendingStart && !selectedRange ? hoverDay : null;
                        const lo = selectedRange ? selectedRange.start : pendingStart;
                        const hi = selectedRange
                          ? selectedRange.end
                          : provisionalEnd && pendingStart
                            ? (provisionalEnd < pendingStart ? pendingStart : provisionalEnd)
                            : pendingStart;
                        const loEff = selectedRange
                          ? lo
                          : provisionalEnd && pendingStart && provisionalEnd < pendingStart
                            ? provisionalEnd
                            : lo;
                        const isEdge = iso === loEff || iso === hi;
                        const inRange = Boolean(loEff && hi && iso > loEff && iso < hi);

                        return (
                          <button
                            key={iso}
                            type="button"
                            disabled={isFuture}
                            onMouseEnter={() => setHoverDay(iso)}
                            onMouseLeave={() => setHoverDay(null)}
                            onClick={() => handleDayClick(iso)}
                            className={`h-9 flex items-center justify-center rounded-full transition airbnb-spring ${
                              isFuture
                                ? 'text-[rgba(235,235,245,0.18)] cursor-default'
                                : isEdge
                                  ? 'bg-[#0a84ff] text-white font-bold shadow-sm'
                                  : inRange
                                    ? 'bg-white/[0.14] text-[#f5f5f7] cursor-pointer'
                                    : `cursor-pointer hover:bg-white/[0.08] ${
                                        isToday ? 'text-[#0a84ff] font-bold' : 'text-[rgba(235,235,245,0.62)]'
                                      }`
                            }`}
                          >
                            {day}
                          </button>
                        );
                      })}
                    </div>

                    <p className="mt-3 text-center text-[11px] text-[rgba(235,235,245,0.42)]">
                      {selectedRange
                        ? formatPostedRange(selectedRange)
                        : pendingStart
                          ? 'Now pick the end of the range'
                          : 'Pick a start date'}
                    </p>
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
                          // Drop a half-finished range, or it would still be
                          // sitting there highlighted behind a bucket filter.
                          setPendingStart(null);
                          setLastPosted(item.id);
                          setActiveSegment(null);
                        }}
                        className={`px-3.5 py-1.5 rounded-full text-xs font-bold border transition airbnb-spring active:scale-95 ${
                          lastPosted === item.id
                            ? 'bg-[#0a84ff] text-white border-transparent shadow-sm'
                            : 'bg-white/[0.08] border-white/15 text-[rgba(235,235,245,0.62)] hover:border-white/40'
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
          </div>

          {/* The same island at phone width, holding one plain field. */}
          <div className="ic-island md:hidden p-2.5">
            <div className="ic-searchfield relative flex items-center h-11">
              <Search className="w-4 h-4 text-[rgba(235,235,245,0.42)] shrink-0 ml-3 mr-2" />
              <input
                type="text"
                placeholder="Search roles, locations, skills..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent pr-3 text-[14px] tracking-[-0.01em] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.42)] outline-none"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
};
