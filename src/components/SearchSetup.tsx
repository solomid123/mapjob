import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Briefcase, CalendarClock, Check, Laptop, MapPin, Search, X,
} from 'lucide-react';
import { CITIES } from '../data/mockJobs';

/**
 * What a search is looking for, asked once rather than guessed.
 *
 * Before this the app opened on 450 jobs in Eindhoven: a city nobody chose,
 * for a role nobody named. Four questions cost fifteen seconds and replace the
 * guess with an answer.
 */
export interface SearchBrief {
  /** Free-text keywords, fed to the same search the bar at the top runs. */
  query: string;
  /** A hub id or a typed destination; resolved by the app's geocoder. */
  where: string;
  /** What to call that place on screen while it resolves. */
  whereLabel: string;
  /**
   * Where the place actually is, when it was picked from the suggestions.
   *
   * Carried so the map opens on the town that was chosen rather than on
   * whatever a second lookup of the same word returns: there are nine Neustadts
   * in Germany, and the list is where the ambiguity was already settled.
   */
  whereLat?: number;
  whereLng?: number;
  /** One of the posted-date buckets the filter bar uses: 'all', '24h', ... */
  lastPosted: string;
  /** '' | 'Remote' | 'Hybrid' | 'On-site' */
  remoteType: string;
  /** '' | 'Full-time' | 'Contract' */
  jobType: string;
}

const STORAGE_KEY = 'mapjob.search.brief';

/**
 * The brief is kept so the questions are asked once, not once a day.
 *
 * localStorage rather than sessionStorage, and unlike the interview transcript
 * that is the right call here: a job title and a city are a standing
 * preference, there is nothing confidential in them, and being asked again
 * every morning would turn the questions into a toll gate.
 */
export function readSearchBrief(): SearchBrief | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as SearchBrief;
    return b && typeof b.where === 'string' ? b : null;
  } catch {
    return null;
  }
}

export function writeSearchBrief(b: SearchBrief) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    // Private mode. The search still runs; it just gets asked again next time.
  }
}

export function clearSearchBrief() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** A sensible starting point, and what "Browse everything" falls back to. */
export const defaultSearchBrief = (): SearchBrief => ({
  query: '',
  where: 'eindhoven',
  whereLabel: 'Eindhoven',
  lastPosted: 'all',
  remoteType: '',
  jobType: '',
});

type StepId = 'role' | 'where' | 'when' | 'shape';

const STEPS: {
  id: StepId;
  icon: React.ComponentType<{ className?: string }>;
  question: string;
  hint: string;
  optional: boolean;
}[] = [
  {
    id: 'role',
    icon: Briefcase,
    question: 'What kind of work are you after?',
    hint: 'The words that would be in the job title. Everything else narrows from here.',
    optional: false,
  },
  {
    id: 'where',
    icon: MapPin,
    question: 'Where should we look?',
    hint: 'A hub, or any town in Europe. The map opens there.',
    optional: false,
  },
  {
    id: 'when',
    icon: CalendarClock,
    question: 'How fresh should the postings be?',
    hint: 'A vacancy two months old has usually been filled, or was never real.',
    optional: true,
  },
  {
    id: 'shape',
    icon: Laptop,
    question: 'Anything else to narrow it?',
    hint: 'Skip this and see everything. Both are one click away afterwards.',
    optional: true,
  },
];

/** Starting points, not a taxonomy: one tap fills the field, then edit it. */
const ROLE_SUGGESTIONS = [
  'Mechanical Engineer',
  'Ing\u00e9nieur m\u00e9canique',
  'Design Engineer (CAD)',
  'Simulation & FEA',
  'Project Engineer',
  'Automation & Robotics',
];

const FRESHNESS = [
  { id: '24h', label: 'Past 24 hours', sub: 'First in the pile' },
  { id: '3d', label: 'Past 3 days', sub: 'Still being read' },
  { id: '7d', label: 'Past week', sub: 'A good balance' },
  { id: '14d', label: 'Past fortnight', sub: 'Widest that is still warm' },
  { id: 'all', label: 'Anytime', sub: 'Everything on the board' },
];

/** One row of the place list: what to show, what to search, where it is. */
interface PlaceHit {
  /** "Amiens, Somme, France" -- enough to tell two towns of one name apart. */
  label: string;
  /** Just the town, because that is what a job board understands. */
  name: string;
  lat: number;
  lng: number;
}

/**
 * Towns matching what has been typed, from OpenStreetMap.
 *
 * Nominatim asks callers to stay under a request a second, which the debounce
 * below and the three-character floor between them keep to comfortably: a
 * request only leaves after the typing stops.
 */
async function lookupPlaces(text: string, signal: AbortSignal): Promise<PlaceHit[]> {
  const q = encodeURIComponent(text.trim());
  const res = await fetch(
    'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1'
    + `&accept-language=en&limit=6&q=${q}`,
    { signal });
  if (!res.ok) return [];
  const rows = (await res.json()) as {
    lat: string; lon: string; name?: string; display_name?: string;
    addresstype?: string; type?: string; address?: Record<string, string>;
  }[];
  const seen = new Set<string>();
  const hits: PlaceHit[] = [];
  for (const row of rows) {
    const addr = row.address || {};
    const name = row.name || addr.city || addr.town || addr.village || addr.municipality || '';
    if (!name) continue;
    // Region and country, not the whole postal address: the full display_name
    // runs to eight fields and buries the one word that tells two Neustadts
    // apart.
    const region = addr.state || addr.county || addr.region || '';
    const country = addr.country || '';
    const label = [name, region, country].filter(Boolean).join(', ');
    if (seen.has(label)) continue;
    seen.add(label);
    hits.push({ label, name, lat: parseFloat(row.lat), lng: parseFloat(row.lon) });
  }
  return hits.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng));
}

interface SearchSetupProps {
  onStart: (brief: SearchBrief) => void;
  /** Take the defaults and go straight to the map. */
  onSkip: () => void;
}

export const SearchSetup: React.FC<SearchSetupProps> = ({ onStart, onSkip }) => {
  const [step, setStep] = useState(0);
  const [brief, setBrief] = useState<SearchBrief>(defaultSearchBrief);
  const [whereText, setWhereText] = useState('');
  const fieldRef = useRef<HTMLInputElement | null>(null);

  // The place list, and which row the arrow keys are on. -1 is "none": the
  // typed text stands on its own, so Enter without choosing still works.
  const [places, setPlaces] = useState<PlaceHit[]>([]);
  const [placeIndex, setPlaceIndex] = useState(-1);
  const [lookingUp, setLookingUp] = useState(false);
  // Set when a row is taken, cleared by the next keystroke. Without it the
  // effect below would immediately look up the label it just filled in and
  // reopen the list under the choice.
  const chosenRef = useRef('');

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // The cursor lands in the field on every step: this should be fillable with
  // the keyboard alone, at speed.
  useEffect(() => {
    const t = setTimeout(() => fieldRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [step]);

  const blocked = current.id === 'role' && !brief.query.trim();

  const back = useCallback(() => {
    if (step === 0) onSkip();
    else setStep((s) => s - 1);
  }, [step, onSkip]);

  const next = useCallback(() => {
    if (blocked) return;
    if (isLast) onStart(brief);
    else setStep((s) => s + 1);
  }, [blocked, isLast, onStart, brief]);

  /** Typing a town beats the hub tapped before it, and tapping a hub clears the text. */
  const chooseTypedWhere = (v: string) => {
    setWhereText(v);
    chosenRef.current = '';
    // Typing after a choice discards its coordinates: they described the row
    // that was picked, not whatever the word says now.
    setBrief((b) => ({
      ...b, where: v.trim(), whereLabel: v.trim(),
      whereLat: undefined, whereLng: undefined,
    }));
  };

  /** A row from the list: the exact place, coordinates and all. */
  const choosePlace = (hit: PlaceHit) => {
    chosenRef.current = hit.label;
    setWhereText(hit.label);
    setPlaces([]);
    setPlaceIndex(-1);
    setBrief((b) => ({
      ...b, where: hit.name, whereLabel: hit.label, whereLat: hit.lat, whereLng: hit.lng,
    }));
  };

  const chooseHub = (id: string, name: string) => {
    setWhereText('');
    setPlaces([]);
    setPlaceIndex(-1);
    chosenRef.current = '';
    setBrief((b) => ({
      ...b, where: id, whereLabel: name, whereLat: undefined, whereLng: undefined,
    }));
  };

  /*
   * Look the typed town up while it is being typed.
   *
   * Only after the typing stops: a lookup per keystroke would be six requests
   * for one word, and OpenStreetMap asks for one a second. The request is
   * abandoned when the next one starts, so a slow answer for "ami" cannot
   * arrive after "amiens" and replace the right list with a stale one.
   */
  useEffect(() => {
    const text = whereText.trim();
    if (current.id !== 'where' || text.length < 3 || text === chosenRef.current) {
      setPlaces([]);
      setPlaceIndex(-1);
      setLookingUp(false);
      return;
    }
    const controller = new AbortController();
    setLookingUp(true);
    const timer = setTimeout(() => {
      lookupPlaces(text, controller.signal)
        .then((hits) => { setPlaces(hits); setPlaceIndex(-1); })
        .catch(() => undefined)
        .finally(() => setLookingUp(false));
    }, 320);
    return () => { clearTimeout(timer); controller.abort(); setLookingUp(false); };
  }, [whereText, current.id]);

  /** Arrow keys walk the list; Enter takes the highlighted row, or the text. */
  const whereKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && places.length) {
      e.preventDefault();
      setPlaceIndex((i) => (i + 1) % places.length);
      return;
    }
    if (e.key === 'ArrowUp' && places.length) {
      e.preventDefault();
      setPlaceIndex((i) => (i <= 0 ? places.length - 1 : i - 1));
      return;
    }
    if (e.key === 'Escape' && places.length) {
      // Swallowed, so dismissing the list does not also walk back a question.
      e.preventDefault();
      e.stopPropagation();
      setPlaces([]);
      setPlaceIndex(-1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (placeIndex >= 0 && places[placeIndex]) choosePlace(places[placeIndex]);
      else next();
    }
  };

  const Icon = current.icon;

  return (
    <div
      className="flex-1 w-full flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-200"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); back(); }
      }}
    >
      {/* One segment per question, filled as they are passed. */}
      <div className="w-full max-w-[760px] mx-auto px-6 pt-6 shrink-0">
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1 flex-1 rounded-full transition-all duration-300 ease-apple-out ${
                i < step ? 'bg-[#0a84ff]' : i === step ? 'bg-[#0a84ff]/70' : 'bg-white/15'
              }`}
            />
          ))}
        </div>
        <div className="mt-2.5 flex items-center justify-between">
          <span className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
            New search {'\u00b7'} {step + 1} of {STEPS.length}
          </span>
          <button
            type="button"
            onClick={onSkip}
            className="ic-caption text-[12px] font-medium text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition-colors duration-200 cursor-pointer flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" /> Browse everything instead
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full max-w-[760px] mx-auto px-6 py-8">
          <div key={current.id} className="animate-airbnb-pop">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-full bg-[#0a84ff]/15 text-[#0a84ff] flex items-center justify-center shrink-0">
                <Icon className="w-[18px] h-[18px]" />
              </span>
              {current.optional && (
                <span className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                  Optional
                </span>
              )}
            </div>

            <h1 className="ic-title mt-4 text-[32px] sm:text-[38px] leading-[1.08] text-[#f5f5f7]">
              {current.question}
            </h1>
            <p className="ic-body mt-2.5 text-[15px] text-[rgba(235,235,245,0.62)]">
              {current.hint}
            </p>

            <div className="mt-7">
              {current.id === 'role' && (
                <>
                  <input
                    ref={fieldRef}
                    value={brief.query}
                    onChange={(e) => setBrief((b) => ({ ...b, query: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
                    placeholder={'Ing\u00e9nieur M\u00e9canique'}
                    className="w-full bg-transparent border-0 border-b border-white/15 focus:border-[#0a84ff] outline-none px-0 py-3 text-[24px] sm:text-[28px] ic-title text-[#f5f5f7] placeholder:text-white/20 transition-colors duration-200"
                  />
                  <div className="mt-5 flex flex-wrap gap-2">
                    {ROLE_SUGGESTIONS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setBrief((b) => ({ ...b, query: r }))}
                        className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium cursor-pointer transition-colors duration-200 ${
                          brief.query === r
                            ? 'bg-[#0a84ff] text-white'
                            : 'ic-fill text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]'
                        }`}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {current.id === 'where' && (
                <>
                  <div className="relative">
                    <Search className="absolute left-0 top-1/2 -translate-y-1/2 w-5 h-5 text-[rgba(235,235,245,0.42)]" />
                    <input
                      ref={fieldRef}
                      value={whereText}
                      onChange={(e) => chooseTypedWhere(e.target.value)}
                      onKeyDown={whereKeys}
                      placeholder="Any town in Europe"
                      autoComplete="off"
                      role="combobox"
                      aria-expanded={places.length > 0}
                      aria-controls="where-suggestions"
                      className="w-full bg-transparent border-0 border-b border-white/15 focus:border-[#0a84ff] outline-none pl-8 pr-10 py-3 text-[24px] sm:text-[28px] ic-title text-[#f5f5f7] placeholder:text-white/20 transition-colors duration-200"
                    />
                    {/* A quiet spinner, because a list that appears half a
                      * second after you stop typing looks like a page that
                      * ignored you until it does not. */}
                    {lookingUp && (
                      <span className="absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-white/20 border-t-[#0a84ff] animate-spin" />
                    )}
                    {/* The towns themselves. Picking one settles which Neustadt
                      * is meant and hands the map its coordinates, so the place
                      * that opens is the place that was chosen rather than
                      * whatever a second lookup of the same word returns. */}
                    {places.length > 0 && (
                      <ul
                        id="where-suggestions"
                        role="listbox"
                        className="absolute left-0 right-0 top-full mt-2 z-20 ic-glass rounded-2xl overflow-hidden py-1 max-h-[280px] overflow-y-auto animate-in fade-in slide-in-from-top-1 duration-150"
                      >
                        {places.map((hit, i) => (
                          <li key={hit.label}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={i === placeIndex}
                              // Mouse down, not click: the field blurring first
                              // would close the list out from under the cursor.
                              onMouseDown={(e) => { e.preventDefault(); choosePlace(hit); }}
                              onMouseEnter={() => setPlaceIndex(i)}
                              className={`w-full text-left px-4 py-2.5 cursor-pointer transition-colors duration-150 ${
                                i === placeIndex ? 'bg-[#0a84ff]/25' : 'hover:bg-white/[0.06]'
                              }`}
                            >
                              <span className="block ic-title text-[15px] text-[#f5f5f7] truncate">
                                {hit.name}
                              </span>
                              <span className="block ic-caption text-[12px] text-[rgba(235,235,245,0.52)] truncate">
                                {hit.label.slice(hit.name.length + 2) || hit.label}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <p className="ic-caption mt-5 mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                    Or one of the hubs
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {CITIES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => chooseHub(c.id, c.name)}
                        className={`ic-tile ${
                          !whereText && brief.where === c.id ? 'is-selected' : ''
                        } rounded-2xl px-3.5 py-3 text-left cursor-pointer`}
                      >
                        <span className="block ic-title text-[15px] text-[#f5f5f7] truncate">{c.name}</span>
                        <span className="block ic-caption text-[11.5px] text-[rgba(235,235,245,0.42)] mt-0.5 truncate">
                          {c.subtitle}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {current.id === 'when' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-w-[520px]">
                  {FRESHNESS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setBrief((b) => ({ ...b, lastPosted: f.id }))}
                      className={`ic-tile ${brief.lastPosted === f.id ? 'is-selected' : ''} rounded-2xl px-4 py-3.5 text-left cursor-pointer`}
                    >
                      <span className="block ic-title text-[16px] text-[#f5f5f7]">{f.label}</span>
                      <span className="block ic-caption text-[12px] text-[rgba(235,235,245,0.42)] mt-0.5">{f.sub}</span>
                    </button>
                  ))}
                </div>
              )}

              {current.id === 'shape' && (
                <div className="space-y-6 max-w-[520px]">
                  <div>
                    <p className="ic-caption mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                      Where the work happens
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {['', 'Remote', 'Hybrid', 'On-site'].map((t) => (
                        <button
                          key={t || 'any'}
                          type="button"
                          onClick={() => setBrief((b) => ({ ...b, remoteType: t }))}
                          className={`ic-press-wide px-2 py-2.5 text-[13px] font-semibold rounded-xl text-center cursor-pointer ${
                            brief.remoteType === t
                              ? 'bg-[#0a84ff] text-white'
                              : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
                          }`}
                        >
                          {t || 'Any'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="ic-caption mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                      Contract
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      {['', 'Full-time', 'Contract'].map((t) => (
                        <button
                          key={t || 'any'}
                          type="button"
                          onClick={() => setBrief((b) => ({ ...b, jobType: t }))}
                          className={`ic-press-wide px-3 py-2.5 text-[13px] font-semibold rounded-xl text-center cursor-pointer ${
                            brief.jobType === t
                              ? 'bg-[#0a84ff] text-white'
                              : 'bg-white/[0.06] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.12]'
                          }`}
                        >
                          {t || 'Any'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* What is about to be searched, on the last step only. */}
            {isLast && (
              <div className="mt-8 ic-tile is-static rounded-2xl px-5 py-4">
                <p className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                  We will look for
                </p>
                <ul className="mt-2.5 space-y-1.5">
                  {[
                    brief.query && `\u201c${brief.query.trim()}\u201d`,
                    brief.whereLabel && `Around ${brief.whereLabel}`,
                    `Posted ${(FRESHNESS.find((f) => f.id === brief.lastPosted)?.label || 'anytime').toLowerCase()}`,
                    brief.remoteType && brief.remoteType,
                    brief.jobType && brief.jobType,
                  ].filter(Boolean).map((line) => (
                    <li key={String(line)} className="ic-body text-[14px] text-[#f5f5f7] flex items-start gap-2">
                      <Check className="w-3.5 h-3.5 mt-[3px] text-[#0a84ff] shrink-0 stroke-[2.5]" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Same place on every question, so it is never hunted for. */}
      <div className="shrink-0 w-full max-w-[760px] mx-auto px-6 pb-7 pt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={back}
          className="ic-press px-4 py-2.5 rounded-full flex items-center gap-1.5 cursor-pointer ic-body text-[14px] font-medium text-[#f5f5f7]"
        >
          <ArrowLeft className="w-4 h-4" />
          {step === 0 ? 'Skip' : 'Back'}
        </button>

        <div className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={next}
            disabled={blocked}
            className="px-6 py-2.5 rounded-full bg-[#0a84ff] hover:bg-[#3395ff] disabled:opacity-40 disabled:hover:bg-[#0a84ff] text-white ic-body text-[14px] font-semibold flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed transition-colors duration-200"
          >
            {isLast && <Search className="w-4 h-4" />}
            {isLast ? 'Show me the map' : 'Continue'}
            {!isLast && <ArrowRight className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};
