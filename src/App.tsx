import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type L from 'leaflet';
import { 
  Map as MapIcon, 
  ListFilter, 
  MapPin, 
  Check,
  Loader2,
  ChevronsLeft,
  ChevronsRight,
  X,
} from 'lucide-react';
import { daysAgo, parsePostedRange } from './utils/postedRange';
import { Navbar } from './components/Navbar';
import { FilterBar } from './components/FilterBar';
import { FooterInfo, SiteFooter } from './components/SiteFooter';
import { JobCard } from './components/JobCard';
import { JobMap } from './components/JobMap';
import { JobPage } from './components/JobPage';
import { PostJobModal } from './components/PostJobModal';
import { OutreachPage } from './components/OutreachPage';
import { InterviewHelperModal } from './components/InterviewHelperModal';
import {
  SearchSetup,
  readSearchBrief,
  writeSearchBrief,
  clearSearchBrief,
  defaultSearchBrief,
  type SearchBrief,
} from './components/SearchSetup';
import { CITIES } from './data/mockJobs';
import { resolveLocationFromCoords, getVisibleHubsInBounds } from './services/adzuna';
import { matchTitle, terms } from './services/relevance';
import {
  fetchDirectAtsJobs,
  fetchJobFeed,
  startBrowserApply,
  submitReviewedForm,
  cancelBrowserApply,
  pollBrowserApply,
  runOutcome,
  type ApplyOutcome,
  type BrowserApplyRun,
  type FetchJobsOptions,
} from './services/directAtsApi';
import { ApplyReviewPanel } from './components/ApplyReviewPanel';
import { BottomTabBar, type BottomTabType } from './components/BottomTabBar';
import { BulkApplyBar } from './components/BulkApplyBar';
import {
  bulkBlocker,
  runBulkQueue,
  bulkTally,
  type BulkControl,
  type BulkQueue,
} from './services/bulkApply';

/**
 * Below this fraction of the loaded region's width, a viewport is refetched even
 * though its jobs are technically already in hand.
 *
 * The backend answers a viewport by naming the town at its centre and searching
 * a radius around it, and a fixed number of listings spread over a 50km radius
 * is thin once you are looking at one street. So "we already have this area" is
 * true but not useful past a certain point: the closer view deserves its own,
 * tighter search. A quarter is about two zoom levels, which is far enough to be
 * worth a request and near enough that ordinary panning still costs nothing.
 */
const REFETCH_BELOW_WIDTH_RATIO = 0.25;

function isAlreadyLoaded(region: L.LatLngBounds | null, bounds: L.LatLngBounds): boolean {
  if (!region?.contains(bounds)) return false;
  const regionWidth = region.getEast() - region.getWest();
  const width = bounds.getEast() - bounds.getWest();
  return regionWidth <= 0 || width / regionWidth > REFETCH_BELOW_WIDTH_RATIO;
}

/**
 * Fetch a feed, then keep collecting the rest of it.
 *
 * The backend answers a cold search from one fast wave of calls and fills in
 * the deeper pages behind it, so the first response is real but partial. This
 * paints that immediately and then asks again every couple of seconds until the
 * backend says it is done -- the follow-up calls are cheap, because by then it
 * is serving them out of memory.
 *
 * `isCurrent` is checked before every update so a superseded search (the user
 * typed again, or moved the map) can never overwrite the newer results.
 */
const REFILL_DELAY_MS = 1800;
const REFILL_MAX_TRIES = 6;

async function loadFeedWithRefill(
  options: FetchJobsOptions,
  isCurrent: () => boolean,
  onJobs: (jobs: Job[]) => void
): Promise<void> {
  /* Only hand up a wave that differs from the one already on screen.
   *
   * The refill polls until the backend reports complete, and most of those
   * polls come back with the identical list -- the point of waiting is that
   * it is not ready yet. Each one was still calling setJobs(), and each
   * setJobs() re-renders sixty cards. That measured as ~1s of blocked main
   * thread, repeatedly, which is long enough that hover does not respond:
   * :hover needs a style recalc on the same thread, so the cursor moves over
   * a control and nothing happens until the burst ends.
   *
   * Comparing ids costs one pass over an array we already hold, against a
   * render of the whole list. */
  let lastSignature = '';
  const publish = (jobs: Job[]) => {
    const signature = `${jobs.length}:${jobs.map((j) => j.id).join(',')}`;
    if (signature === lastSignature) return;
    lastSignature = signature;
    onJobs(jobs);
  };

  let feed = await fetchJobFeed(options);
  if (!isCurrent()) return;
  publish(feed.jobs);

  for (let tries = 0; tries < REFILL_MAX_TRIES && !feed.complete; tries++) {
    await new Promise((resolve) => setTimeout(resolve, REFILL_DELAY_MS));
    if (!isCurrent()) return;
    try {
      feed = await fetchJobFeed(options);
    } catch {
      return; // The first wave is already on screen; a failed top-up is not an error.
    }
    if (!isCurrent()) return;
    publish(feed.jobs);
  }
}
import type { Job } from './types/job';
import {
  saveJobToSupabase,
  fetchSavedJobsFromSupabase,
  updateJobStatusInSupabase,
} from './services/supabase';

interface JobSearchParams {
  cityId?: string;
  where?: string;
  country?: string;
  query?: string;
  lastPosted?: string;
  page?: number;
  centerLat?: number;
  centerLng?: number;
  defaultWhat?: string;
}

/**
 * A town-level coordinate stands for the whole town, so the viewport test has
 * to be as coarse as the data is. Six kilometres is about a European city's own
 * half-width, and it is the difference between "zoom into a street in Eindhoven
 * and the column says 3 jobs" and it saying what the town actually holds: every
 * Eindhoven listing shares one geocoded centre point, and a street-level box
 * simply misses that point.
 *
 * An exact coordinate is a real address and is judged exactly, with no slack.
 * Kept in step with `CITY_RADIUS_KM` in `direct_ats_client.py`, which culls the
 * same jobs server-side.
 */
const CITY_RADIUS_KM = 6;

function inViewOf(bounds: L.LatLngBounds): (job: Job) => boolean {
  const midLat = (bounds.getNorth() + bounds.getSouth()) / 2;
  const padLat = CITY_RADIUS_KM / 111;
  const padLng = CITY_RADIUS_KM / (111 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));
  const loose = bounds.pad(0); // a copy, so the map's own bounds are untouched
  loose.extend([bounds.getNorth() + padLat, bounds.getEast() + padLng]);
  loose.extend([bounds.getSouth() - padLat, bounds.getWest() - padLng]);

  return (job: Job) =>
    job.locationPrecision === 'exact'
      ? bounds.contains([job.lat, job.lng])
      : loose.contains([job.lat, job.lng]);
}

export function App() {
  // Live ATS listings; API submission is a separate capability.
  const [jobs, setJobs] = useState<Job[]>([]);

  const [savedJobIds, setSavedJobIds] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('mapjob_saved_ids');
    if (saved) {
      try {
        return new Set(JSON.parse(saved));
      } catch {
        return new Set();
      }
    }
    return new Set();
  });

  // Hydrate bookmarked jobs from Supabase on mount
  useEffect(() => {
    fetchSavedJobsFromSupabase().then((dbJobs) => {
      if (dbJobs && dbJobs.length > 0) {
        const ids = dbJobs
          .filter((j) => j.status === 'saved' || j.status === 'applied')
          .map((j) => j.id);
        setSavedJobIds((prev) => new Set([...prev, ...ids]));
      }
    }).catch(() => {});
  }, []);

  /**
   * Top Nav Menu tab: 'jobs' | 'emails' | 'interview'.
   *
   * Kept in the address bar rather than in state alone. A tab that only exists
   * in memory is a tab you lose to a refresh, and the interview helper is the
   * worst possible place to be thrown out of -- it happens minutes before, or
   * during, a call. `?tab=` also makes the helper linkable and survives the
   * browser's back button.
   */
  const [activeTopTab, setActiveTopTab] = useState<'jobs' | 'emails' | 'interview'>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'interview' || t === 'emails' ? t : 'jobs';
  });

  useEffect(() => {
    const url = new URL(window.location.href);
    if ((url.searchParams.get('tab') || 'jobs') === activeTopTab) return;
    if (activeTopTab === 'jobs') url.searchParams.delete('tab');
    else url.searchParams.set('tab', activeTopTab);
    // push, not replace: leaving the interview with the back button should
    // land on the map, the way leaving any other page does.
    window.history.pushState({ tab: activeTopTab }, '', url.toString());
  }, [activeTopTab]);

  /**
   * What this search is for, asked on arrival instead of assumed.
   *
   * Null means the questions have not been answered on this machine, and the
   * questionnaire is the page -- the same shape as the interview setup, for
   * the same reason: a good search is worth fifteen seconds, and the
   * alternative was opening on a city and a discipline nobody picked.
   */
  const [searchBrief, setSearchBrief] = useState<SearchBrief | null>(() => readSearchBrief());

  // Filter state
  // Every filter below opens on the answers given to the questionnaire, so a
  // returning visit lands on its own search rather than on the app's defaults.
  const briefHub = searchBrief && CITIES.some((c) => c.id === searchBrief.where) ? searchBrief.where : null;
  /**
   * A saved brief that names a town rather than a hub has to be geocoded before
   * anything is fetched. Until that happens the hub feed below must stay out of
   * the way: left to run, it would load Eindhoven and relabel the page under the
   * restored search.
   */
  const pendingDestinationRef = useRef<string | null>(
    searchBrief && !briefHub && searchBrief.where.trim() ? searchBrief.where : null,
  );
  const [searchQuery, setSearchQuery] = useState(searchBrief?.query ?? '');
  const [committedQuery, setCommittedQuery] = useState(searchBrief?.query ?? '');
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQuery(searchQuery), 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [selectedCity, setSelectedCity] = useState(briefHub ?? 'eindhoven');
  const [activeLocationLabel, setActiveLocationLabel] = useState(
    searchBrief?.whereLabel || 'Eindhoven & Brainport (NL)',
  );
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [jobType, setJobType] = useState(searchBrief?.jobType ?? '');
  const [remoteType, setRemoteType] = useState(searchBrief?.remoteType ?? '');
  const [minSalary, setMinSalary] = useState(0);
  const [visaSponsorshipOnly, setVisaSponsorshipOnly] = useState(false);
  const [directAtsOnly, setDirectAtsOnly] = useState(false);
  const [lastPosted, setLastPosted] = useState(searchBrief?.lastPosted ?? 'all');
  const [showSavedOnly, setShowSavedOnly] = useState(false);
  const [isLoadingJobs, setIsLoadingJobs] = useState(false);
  const [currentPage, setCurrentPage] = useState(2);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [visibleCardCount, setVisibleCardCount] = useState(60);
  const activeParamsRef = useRef<JobSearchParams>({ cityId: 'eindhoven' });
  const searchRequestRef = useRef(0);
  const [searchError, setSearchError] = useState('');
  const [activeBottomTab, setActiveBottomTab] = useState<BottomTabType>('explore');

  const handleSelectBottomTab = (tab: BottomTabType) => {
    setActiveBottomTab(tab);
    setActiveJobPage(null);
    if (tab === 'explore') {
      setShowSavedOnly(false);
      setActiveTopTab('jobs');
    } else if (tab === 'wishlists') {
      setShowSavedOnly(true);
      setActiveTopTab('jobs');
    } else if (tab === 'profile') {
      setIsPostJobOpen(true);
    }
  };

  // Live aggregated job fetching for initial/dropdown selection
  useEffect(() => {
    // Purge any stale legacy mock jobs from browser storage
    try {
      localStorage.removeItem('mapjob_custom_jobs');
    } catch {
      // ignore
    }

    // Held back while a saved non-hub destination is still being restored.
    if (pendingDestinationRef.current) return;

    let isMounted = true;
    const requestId = ++searchRequestRef.current;
    if (mapMoveTimerRef.current) clearTimeout(mapMoveTimerRef.current);
    // A new city or query invalidates whatever area the map had already loaded.
    fetchedRegionRef.current = null;
    async function loadLiveJobs() {
      setIsLoadingJobs(true);
      setSearchError('');
      try {
        const currentHub = CITIES.find((c) => c.id === selectedCity);
        if (currentHub) {
          setActiveLocationLabel(currentHub.name);
        }
        const params = {
          cityId: selectedCity,
          query: committedQuery,
          lastPosted,
          page: 1,
        };
        activeParamsRef.current = params;
        setCurrentPage(2);

        await loadFeedWithRefill(
          { keywords: params.query, city: params.cityId },
          () => isMounted && requestId === searchRequestRef.current,
          (liveJobs) => {
            setJobs(liveJobs);
            // Cleared on the first wave, not the last: the map is usable now.
            setIsLoadingJobs(false);
          }
        );
      } catch (err) {
        console.error('Failed to load jobs:', err);
        if (requestId === searchRequestRef.current) setSearchError('Job feed unavailable. Check the backend and retry.');
      } finally {
        if (isMounted && requestId === searchRequestRef.current) setIsLoadingJobs(false);
      }
    }

    loadLiveJobs();
    return () => {
      isMounted = false;
    };
  }, [selectedCity, committedQuery, lastPosted]);

  // Load more jobs dynamically in the current map view (+50 more pins)
  // Load more jobs dynamically in the current map view
  const handleLoadMoreInArea = async () => {
    if (visibleCardCount < filteredJobs.length) {
      setVisibleCardCount((count) => count + 60);
      return;
    }
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = currentPage + 1;
      const cityQuery = activeParamsRef.current.cityId || activeParamsRef.current.where;
      const moreAts = await fetchDirectAtsJobs({ keywords: searchQuery, city: cityQuery });
      const moreJobs = moreAts;

      if (moreJobs.length > 0) {
        setJobs((prev) => {
          const seen = new Set(prev.map((j) => j.id));
          const additions = moreJobs.filter((j) => !seen.has(j.id));
          return [...prev, ...additions];
        });
        setCurrentPage(nextPage);
        showToast(`Refreshed ${moreJobs.length} direct vacancies in this area!`);
      } else {
        showToast('All available vacancies in this radius are already displayed.');
      }
    } catch (err) {
      console.error('Failed to load more jobs in area:', err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Map state: Enabled by default just like Airbnb
  const [searchAsMapMoves, setSearchAsMapMoves] = useState(true);
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null);
  const [mapCenterTarget, setMapCenterTarget] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);

  // Debounced live API caller as the user moves/drags the map
  const mapMoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (mapMoveTimerRef.current) clearTimeout(mapMoveTimerRef.current);
    searchRequestRef.current += 1;
  }, []);

  // Immediate loading trigger as soon as map dragging / zooming begins
  const handleMapMoveStart = () => {
    if (!searchAsMapMoves) return;
    // Only drop a fetch that has not started yet. This deliberately does not
    // invalidate the in-flight search as well: a move does not always end in a
    // request (the area may already be loaded, or the map may have no size yet),
    // and cancelling the city search that is still arriving left the app with an
    // empty list and nothing on its way to fill it. `handleMapMoveEnd` claims
    // the request slot at the moment it actually decides to fetch.
    if (mapMoveTimerRef.current) clearTimeout(mapMoveTimerRef.current);
  };

  /**
   * The geographic region the jobs currently in state were fetched for. While
   * the camera stays inside it, panning needs no network round trip at all.
   */
  const fetchedRegionRef = useRef<L.LatLngBounds | null>(null);

  const handleMapMoveEnd = (center: { lat: number; lng: number }, bounds: L.LatLngBounds) => {
    // A map with no size on screen reports its bounds as a single point, and a
    // zero-area viewport contains nothing, so filtering by it empties the whole
    // result column. That is not hypothetical: below the `md` breakpoint the map
    // pane is `display:none`, and the list next to it went to "0 jobs" while the
    // feed held six hundred.
    if (bounds.getNorth() === bounds.getSouth() || bounds.getEast() === bounds.getWest()) {
      return;
    }
    setMapBounds(bounds);
    if (!searchAsMapMoves) return;
    if (isAlreadyLoaded(fetchedRegionRef.current, bounds)) return;

    const requestId = ++searchRequestRef.current;
    setIsLoadingJobs(true);

    if (mapMoveTimerRef.current) {
      clearTimeout(mapMoveTimerRef.current);
    }

    mapMoveTimerRef.current = setTimeout(async () => {
      setSearchError('');
      // Fetch a ring beyond the viewport so the next nudge is already covered.
      const region = bounds.pad(0.35);
      try {
        await loadFeedWithRefill(
          {
            keywords: searchQuery,
            bbox: [region.getWest(), region.getSouth(), region.getEast(), region.getNorth()],
          },
          () => requestId === searchRequestRef.current,
          (liveJobs) => {
            fetchedRegionRef.current = region;
            activeParamsRef.current = {
              centerLat: center.lat,
              centerLng: center.lng,
              query: searchQuery,
              lastPosted,
              page: 1,
            };
            setCurrentPage(2);
            setJobs(liveJobs);
            setIsLoadingJobs(false);
          }
        );
      } catch (err) {
        console.error('Failed to load jobs on map move:', err);
        if (requestId === searchRequestRef.current) {
          setSearchError('Unable to refresh this area. Retry when the backend is available.');
        }
      } finally {
        if (requestId === searchRequestRef.current) setIsLoadingJobs(false);
      }

      // Naming the area is cosmetic, so it never blocks the pins from appearing.
      const visibleHubs = getVisibleHubsInBounds(bounds)
        .sort(
          (a, b) =>
            Math.hypot(a.lat - center.lat, a.lng - center.lng) -
            Math.hypot(b.lat - center.lat, b.lng - center.lng)
        )
        .slice(0, 4);
      if (visibleHubs.length) {
        setActiveLocationLabel(visibleHubs.map((h) => h.name).join(', '));
      } else {
        resolveLocationFromCoords(center.lat, center.lng)
          .then((location) => {
            if (requestId !== searchRequestRef.current) return;
            setActiveLocationLabel(
              location.displayLabel || `${location.name}, ${location.country.toUpperCase()}`
            );
          })
          .catch(() => undefined);
      }
    }, 200);
  };

  // Search any European destination (via Enter key, suggested hub click, or Search button)
  /**
   * Run a search against a place.
   *
   * `overrides` exists for the setup questionnaire, which chooses the place,
   * the keywords and the freshness in the same breath: calling this straight
   * after setSearchQuery would read the state from before the click, and
   * search the new city for the old words.
   */
  const handleSearchDestination = async (
    destination: string,
    overrides?: { query?: string; lastPosted?: string },
  ) => {
    if (!destination.trim()) return;
    const useQuery = overrides?.query ?? searchQuery;
    const usePosted = overrides?.lastPosted ?? lastPosted;
    if (mapMoveTimerRef.current) clearTimeout(mapMoveTimerRef.current);
    const requestId = ++searchRequestRef.current;
    fetchedRegionRef.current = null;
    setSearchError('');
    const cleanDest = destination.trim();
    setActiveJobPage(null);
    setIsLoadingJobs(true);

    // 1. Direct match with configured European hubs
    const match = CITIES.find(
      (c) =>
        c.name.toLowerCase().includes(cleanDest.toLowerCase()) ||
        c.id.toLowerCase() === cleanDest.toLowerCase() ||
        cleanDest.toLowerCase().includes(c.id.toLowerCase())
    );

    if (match) {
      whereRef.current = match.id;
      setSelectedCity(match.id);
      setActiveLocationLabel(match.name);
      setMapBounds(null);
      setMapCenterTarget({ lat: match.lat, lng: match.lng, zoom: match.zoom });

      try {
        const params = {
          cityId: match.id,
          query: useQuery,
          lastPosted: usePosted,
          page: 1,
        };
        activeParamsRef.current = params;
        setCurrentPage(2);

        await loadFeedWithRefill(
          { keywords: params.query, city: params.cityId },
          () => requestId === searchRequestRef.current,
          (liveJobs) => {
            setJobs(liveJobs);
            setIsLoadingJobs(false);
          }
        );
      } catch (err) {
        console.error('Failed to load jobs for hub:', err);
      } finally {
        if (requestId === searchRequestRef.current) setIsLoadingJobs(false);
      }
      return;
    }

    // 2. Geocode custom European destination via OpenStreetMap Nominatim
    try {
      const q = encodeURIComponent(cleanDest);
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
        headers: { 'User-Agent': 'MapJob/1.0' },
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);

          const location = await resolveLocationFromCoords(lat, lng);
          if (requestId !== searchRequestRef.current) return;
          const display = location.displayLabel || `${cleanDest}, ${location.country.toUpperCase()}`;
          whereRef.current = cleanDest;
          setActiveLocationLabel(display);
          setMapBounds(null);
          setMapCenterTarget({ lat, lng, zoom: 12 });

          const fetchParams = {
            where: location.name,
            country: location.country,
            centerLat: lat,
            centerLng: lng,
            defaultWhat: location.defaultWhat,
            query: useQuery,
            lastPosted: usePosted,
            page: 1,
          };
          activeParamsRef.current = fetchParams;
          setCurrentPage(2);

          await loadFeedWithRefill(
            { keywords: fetchParams.query, city: fetchParams.where },
            () => requestId === searchRequestRef.current,
            (liveJobs) => {
              setJobs(liveJobs);
              setIsLoadingJobs(false);
            }
          );
          return;
        }
      }
    } catch (err) {
      console.warn('Geocoding error:', err);
    }

    // 3. Fallback: Search direct jobs with destination string
    if (requestId !== searchRequestRef.current) return;
    try {
      whereRef.current = cleanDest;
      setActiveLocationLabel(cleanDest);
      setMapBounds(null);
      const fallbackParams = {
        where: cleanDest,
        country: 'nl',
        query: useQuery,
        lastPosted: usePosted,
        page: 1,
      };
      activeParamsRef.current = fallbackParams;
      setCurrentPage(2);

      await loadFeedWithRefill(
        { keywords: fallbackParams.query, city: fallbackParams.where },
        () => requestId === searchRequestRef.current,
        (liveJobs) => {
          setJobs(liveJobs);
          setIsLoadingJobs(false);
        }
      );
    } catch (err) {
      console.error('Fallback destination search failed:', err);
    } finally {
      if (requestId === searchRequestRef.current) setIsLoadingJobs(false);
    }
  };

  /**
   * The questionnaire is finished: adopt its answers and run the search.
   *
   * Everything is handed to the search explicitly rather than set and awaited,
   * because setState is not synchronous and the first search would otherwise
   * go out with the previous answers.
   */
  /**
   * The destination currently in force, as a string the search accepts.
   * `selectedCity` cannot play this part: a typed town leaves it on the last
   * hub and only moves the label, so saving it would store "eindhoven" under
   * the name "Delft".
   */
  const whereRef = useRef(searchBrief?.where ?? 'eindhoven');

  const handleStartFromBrief = (brief: SearchBrief) => {
    writeSearchBrief(brief);
    setSearchBrief(brief);
    setSearchQuery(brief.query);
    setCommittedQuery(brief.query);
    setLastPosted(brief.lastPosted);
    setRemoteType(brief.remoteType);
    setJobType(brief.jobType);
    setActiveLocationLabel(brief.whereLabel || brief.where);
    void handleSearchDestination(brief.where, { query: brief.query, lastPosted: brief.lastPosted });
  };

  /** "Browse everything instead": the defaults, saved, so it is not asked twice. */
  /**
   * Backing out of the questionnaire keeps whatever search is already on
   * screen. Writing defaults here would be a lie on the re-entry path: you
   * open "New search" over your Paris results, change your mind, and a reload
   * would quietly move you to Eindhoven. On a genuine first visit the live
   * state *is* the defaults, so this reads the same as a reset.
   */
  const handleSkipBrief = () => {
    const brief: SearchBrief = {
      ...defaultSearchBrief(),
      query: committedQuery,
      where: whereRef.current,
      whereLabel: activeLocationLabel,
      lastPosted,
      remoteType,
      jobType,
    };
    writeSearchBrief(brief);
    setSearchBrief(brief);
  };

  /**
   * A returning brief that names a town rather than a hub has to be geocoded
   * again -- the feed effect above only knows how to open a hub.
   *
   * Deliberately re-runnable rather than one-shot. The unmount cleanup above
   * invalidates every in-flight search, and StrictMode unmounts once on mount,
   * so a search fired from a guarded mount effect is cancelled and never
   * retried. Re-running on the second pass is what the hub feed effect already
   * does; this follows it.
   */
  useEffect(() => {
    if (!searchBrief) return;
    const isHub = CITIES.some((c) => c.id === searchBrief.where);
    if (isHub || !searchBrief.where.trim()) {
      pendingDestinationRef.current = null;
      return;
    }
    // The gate comes down when the restore settles, not when it starts, so the
    // hub feed cannot slip a default Eindhoven load in underneath it.
    void handleSearchDestination(searchBrief.where, {
      query: searchBrief.query,
      lastPosted: searchBrief.lastPosted,
    }).finally(() => {
      pendingDestinationRef.current = null;
    });
    // Reads the brief this mount inherited; later changes go through the
    // search bar, not through here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Keep the saved brief pointed at the search that is actually on screen.
   * Without this the brief is only a record of the answers, so searching
   * Delft from the bar and reloading would drop you back in Paris. Never
   * runs while the questionnaire is up: writing a brief there would dismiss
   * it mid-question.
   */
  useEffect(() => {
    if (!searchBrief || pendingDestinationRef.current) return;
    const next: SearchBrief = {
      query: committedQuery,
      where: whereRef.current,
      whereLabel: activeLocationLabel,
      lastPosted,
      remoteType,
      jobType,
    };
    if (JSON.stringify(next) === JSON.stringify(searchBrief)) return;
    writeSearchBrief(next);
    setSearchBrief(next);
  }, [searchBrief, committedQuery, activeLocationLabel, lastPosted, remoteType, jobType]);

  // Interaction state
  const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);
  const [hoveredListJobId, setHoveredListJobId] = useState<string | null>(null);

  const handleCardHover = useCallback((id: string | null) => {
    setHoveredJobId(id);
    setHoveredListJobId(id);
  }, [setHoveredJobId, setHoveredListJobId]);
  // Check if URL has ?job= parameter on initial load (e.g. opened in a new tab)
  const [activeJobPage, setActiveJobPage] = useState<Job | null>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const jobId = params.get('job');
      if (jobId) {
        const stored = localStorage.getItem(`mapjob_job_${jobId}`) || localStorage.getItem('mapjob_latest_opened_job');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && (parsed.id === jobId || !jobId)) {
            return parsed;
          }
        }
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);
  const [appliedJobIds, setAppliedJobIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('mapjob_applied_ids');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  // The live browser application, if one is running or waiting for approval.
  const [applyRun, setApplyRun] = useState<BrowserApplyRun | null>(null);
  const [isSubmittingForReal, setIsSubmittingForReal] = useState(false);
  const [isStoppingApply, setIsStoppingApply] = useState(false);
  const [isPostJobOpen, setIsPostJobOpen] = useState(false);
  const [mobileView, setMobileView] = useState<'both' | 'map' | 'list'>('list');
  /**
   * How much of the map the results are allowed to cover. The map is the canvas
   * now, so the list is a guest on it: `rows` is the reading width, `grid`
   * widens to the two-up cards for browsing, `hidden` gives the map back.
   */
  const [listPane, setListPane] = useState<'rows' | 'grid' | 'hidden'>('rows');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  /**
   * What the last attempt at each job came to, kept across reloads.
   *
   * `appliedJobIds` only ever remembered the wins, so a job that was tried and
   * blocked looked exactly like a job nobody had touched -- and the only way
   * to find out was to run the whole thing again and watch it fail again. The
   * failures are the ones worth writing down: a success announces itself.
   */
  const [applyOutcomes, setApplyOutcomes] = useState<Record<string, ApplyOutcome>>(() => {
    try {
      const saved = localStorage.getItem('mapjob_apply_outcomes');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const rememberOutcome = (job: Job, outcome: ApplyOutcome) => {
    setApplyOutcomes((prev) => {
      const next = { ...prev, [job.id]: outcome };
      try {
        localStorage.setItem('mapjob_apply_outcomes', JSON.stringify(next));
      } catch {
        // A full quota is not worth losing the run over.
      }
      return next;
    });
  };

  const handleUnmarkApplied = (id: string) => {
    setAppliedJobIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      try {
        localStorage.setItem('mapjob_applied_ids', JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
    showToast('Status reset. You can now re-apply.');
  };

  /** Records a job as applied to, and persists it across reloads. */
  const markApplied = (job: Job) => {
    setAppliedJobIds((prev) => {
      const next = new Set(prev);
      next.add(job.id);
      try {
        localStorage.setItem('mapjob_applied_ids', JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, applicantCount: (j.applicantCount || 0) + 1 } : j))
    );
  };

  /** The job the open panel belongs to, so "Submit" can re-run the same one. */
  const applyJobRef = useRef<Job | null>(null);

  /* ---- Bulk apply ------------------------------------------------------
   *
   * Picking several jobs and letting the agent work through them one at a
   * time. The queue is in the client because the backend drives one browser
   * with one signed-in profile; running two at once would be two tabs
   * fighting over the same cookies, not twice the throughput.
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkQueue, setBulkQueue] = useState<BulkQueue | null>(null);
  // A ref, not state: the loop reads this between jobs and must see the press
  // that happened while it was awaiting, which a captured state value cannot.
  const bulkControlRef = useRef<BulkControl>({ stopRequested: false });

  /**
   * The applied set as the running queue sees it.
   *
   * The loop is one long-lived async call: the `appliedJobIds` it closed over
   * is the one from the render that started it, and would still be empty
   * twenty applications later. A ref is read fresh each time, so a duplicate
   * listing in the queue is skipped rather than applied to twice.
   */
  const appliedJobIdsRef = useRef(appliedJobIds);
  useEffect(() => {
    appliedJobIdsRef.current = appliedJobIds;
  }, [appliedJobIds]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  /**
   * Says what a finished run actually achieved, and marks the job applied when
   * something left the browser.
   *
   * `SUBMITTED_UNVERIFIED` is marked applied too. It means the form went but the
   * page showed no confirmation, and the expensive mistake there is applying
   * twice, not failing to notice once — so it is recorded, and said plainly
   * enough to be checked rather than assumed.
   */
  const reportApplyOutcome = (job: Job, final: BrowserApplyRun) => {
    // Written down first, whatever happened. The toast is gone in four seconds
    // and the panel closes; this is the part that is still there tomorrow.
    rememberOutcome(job, runOutcome(final));

    if (final.status === 'APPLIED') {
      markApplied(job);
      showToast(`Applied to ${job.company}. Their page confirmed it.`);
    } else if (final.status === 'SUBMITTED_UNVERIFIED') {
      markApplied(job);
      showToast(`Sent to ${job.company}, but their page showed no confirmation. Worth checking.`);
    } else if (final.status === 'NEEDS_CHECKPOINT') {
      showToast(`Not sent — ${job.company}'s site blocked the application.`);
    } else if (final.status === 'DRY_RUN_COMPLETED') {
      showToast(`Form filled for ${job.company}. Nothing sent yet.`);
    } else if (final.status === 'SKIPPED') {
      // Stopped on purpose. Reported as a fact, not as a failure -- there is
      // nothing here to apologise for or to retry automatically.
      showToast(`Stopped. Nothing was sent to ${job.company}.`);
    } else {
      showToast(`Not sent to ${job.company}. ${final.message}`.trim());
    }
  };

  /**
   * Applies by driving the employer's own form in a real browser.
   *
   * This used to POST to an ATS "apply API" that does not exist on any public
   * board, so it could only ever answer `portal_required` and dump the
   * candidate on the form to type it all themselves. Filling the real form is
   * the mechanism that actually works.
   *
   * The run goes all the way through: it fills every field and presses Submit
   * itself, then reports what the employer's page said back. It used to stop on
   * the last button and wait for a second click, which bought nothing — by that
   * point it had already typed real answers into a real employer's form, and the
   * page's own confirmation is better evidence than a human skimming a
   * screenshot. The panel still streams every step, so a bad run can be watched
   * and killed while it happens.
   */
  const runOneApplication = async (job: Job): Promise<BrowserApplyRun> => {
    applyJobRef.current = job;
    setApplyingJobId(job.id);
    try {
      const started = await startBrowserApply(job);
      setApplyRun(started);
      const final = await pollBrowserApply(started.id, setApplyRun);
      setApplyRun(final);
      reportApplyOutcome(job, final);
      return final;
    } finally {
      setApplyingJobId(null);
    }
  };

  const handleFastApply = async (job: Job) => {
    if (!job.applyUrl) {
      showToast('This listing has no official application URL.');
      return;
    }
    if (applyingJobId) {
      showToast('An application is already running.');
      return;
    }

    try {
      await runOneApplication(job);
    } catch (err: any) {
      showToast(err?.message || 'The apply service is unreachable.');
      setApplyRun(null);
    }
  };

  /**
   * Starts working through the ticked jobs, one application at a time.
   *
   * Each one goes through `runOneApplication`, the same path a single click
   * takes, so the live panel, the outcome history and the "applied" marks all
   * behave identically -- a bulk run is twenty ordinary runs, not a second
   * apply implementation that has to be kept in step with the first.
   */
  const handleBulkStart = async () => {
    const chosen = filteredJobs.filter(
      (job) => selectedIds.has(job.id) && !bulkBlocker(job, (j) => appliedJobIds.has(j.id)),
    );
    if (chosen.length === 0) {
      showToast('None of those can be applied to automatically.');
      return;
    }
    if (applyingJobId) {
      showToast('An application is already running.');
      return;
    }

    bulkControlRef.current = { stopRequested: false };
    exitSelectMode();

    const finished = await runBulkQueue(chosen, {
      applyOne: runOneApplication,
      onChange: setBulkQueue,
      control: bulkControlRef.current,
      isApplied: (job) => appliedJobIdsRef.current.has(job.id),
    });

    // The panel for the last job is left open on its result; the bar now
    // carries the summary for the whole run.
    const tally = bulkTally(finished);
    showToast(
      tally.sent > 0
        ? `${tally.sent} of ${tally.total} applications sent.`
        : `Nothing was sent. ${tally.failed + tally.skipped} of ${tally.total} did not go through.`,
    );
  };

  /**
   * Abandons the job being worked on and moves to the next.
   *
   * Cancelling the run is enough: the backend closes that browser and reports
   * the ending, the poll loop unwinds on its next tick, and the queue -- which
   * only waits for the promise -- carries straight on.
   */
  const handleBulkSkip = async () => {
    try {
      setApplyRun(await cancelBrowserApply());
    } catch (err: any) {
      showToast(err?.message || 'Could not skip that one.');
    }
  };

  /** Stops the current application and drops everything still queued. */
  const handleBulkStop = async () => {
    bulkControlRef.current.stopRequested = true;
    setBulkQueue((prev) => (prev ? { ...prev, stopping: true } : prev));
    try {
      setApplyRun(await cancelBrowserApply());
    } catch {
      // The run may already have ended on its own; the flag still stands and
      // the queue will stop at the next job either way.
    }
  };

  /**
   * Calls off a run that is still going.
   *
   * The browser is closed at the other end and the attempt is written down as
   * stopped, so a job someone changed their mind about does not sit in the
   * history looking like a failure or, worse, like nothing at all. The poll
   * loop sees the finished state on its next tick and unwinds itself.
   */
  const handleStopApply = async () => {
    if (isStoppingApply) return;
    setIsStoppingApply(true);
    try {
      setApplyRun(await cancelBrowserApply());
    } catch (err: any) {
      showToast(err?.message || 'Could not stop that run.');
    } finally {
      setIsStoppingApply(false);
    }
  };

  /**
   * Sends the application the candidate just read, for real. Only reachable
   * from the review panel, after a dry run has shown the filled form.
   */
  const handleSubmitForReal = async () => {
    const job = applyJobRef.current;
    if (!job || isSubmittingForReal) return;

    setIsSubmittingForReal(true);
    try {
      const started = await submitReviewedForm();
      setApplyRun(started);
      const final = await pollBrowserApply(started.id, setApplyRun);
      setApplyRun(final);
      reportApplyOutcome(job, final);
    } catch (err: any) {
      showToast(err?.message || 'The submission could not be completed.');
    } finally {
      setIsSubmittingForReal(false);
    }
  };

  // Open dedicated Airbnb-style Job Offer Page in a NEW TAB
  const handleOpenJobPage = (job: Job) => {
    // 1. Cache the complete job object in localStorage so the new tab has instant access
    try {
      localStorage.setItem(`mapjob_job_${job.id}`, JSON.stringify(job));
      localStorage.setItem('mapjob_latest_opened_job', JSON.stringify(job));
    } catch {
      // ignore
    }

    // 2. Open in a new tab
    const url = new URL(window.location.href);
    url.searchParams.set('job', job.id);
    const newTab = window.open(url.toString(), '_blank');
    if (!newTab || newTab.closed || typeof newTab.closed === 'undefined') {
      // Fallback: If browser blocked popup window, navigate in current tab
      setActiveJobPage(job);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.history.pushState({ jobId: job.id }, '', url.toString());
    }
  };

  // Back from dedicated Job Offer Page to map search results
  const handleBackFromJobPage = () => {
    setActiveJobPage(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('job');
      window.history.pushState({}, '', url.toString());
    } catch {
      // ignore
    }
  };

  // Sync with browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      setActiveTopTab(tab === 'interview' || tab === 'emails' ? tab : 'jobs');
      const jobId = params.get('job');
      if (!jobId) {
        setActiveJobPage(null);
      } else {
        const match = jobs.find((j) => j.id === jobId);
        if (match) {
          setActiveJobPage(match);
        }
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [jobs]);

  // Show temporary toast notification
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Toggle Save Job
  const handleToggleSave = (id: string) => {
    const targetJob = jobs.find((j) => j.id === id);
    setSavedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        showToast('Job removed from saved list');
        void updateJobStatusInSupabase(id, 'archived');
      } else {
        next.add(id);
        showToast('Job saved to your wishlist & Supabase database');
        if (targetJob) {
          void saveJobToSupabase({
            id: targetJob.id,
            title: targetJob.title,
            company: targetJob.company,
            location: targetJob.location,
            latitude: targetJob.lat,
            longitude: targetJob.lng,
            salary_min: targetJob.salaryMin,
            salary_max: targetJob.salaryMax,
            salary_currency: targetJob.salaryCurrency || 'EUR',
            contract_type: targetJob.jobType,
            description: targetJob.description,
            redirect_url: targetJob.applyUrl,
            status: 'saved',
          });
        }
      }
      localStorage.setItem('mapjob_saved_ids', JSON.stringify(Array.from(next)));
      return next;
    });
  };

  // Add new job from employer modal
  const handleAddJob = (newJob: Job) => {
    setJobs((prev) => {
      const updated = [newJob, ...prev];
      const customJobs = updated;
      localStorage.setItem('mapjob_custom_jobs', JSON.stringify(customJobs));
      return updated;
    });
    void saveJobToSupabase({
      id: newJob.id,
      title: newJob.title,
      company: newJob.company,
      location: newJob.location,
      latitude: newJob.lat,
      longitude: newJob.lng,
      salary_min: newJob.salaryMin,
      salary_max: newJob.salaryMax,
      salary_currency: newJob.salaryCurrency || 'EUR',
      contract_type: newJob.jobType,
      description: newJob.description,
      redirect_url: newJob.applyUrl,
      source: 'employer_portal',
      status: 'discovered',
    });
    showToast(`"${newJob.title}" pinned to the map and synced to Supabase!`);
  };

  // Reset all active filters
  const handleResetFilters = () => {
    setSearchQuery('');
    setSelectedCategory('all');
    setJobType('');
    setRemoteType('');
    setMinSalary(0);
    setVisaSponsorshipOnly(false);
    setDirectAtsOnly(false);
    setLastPosted('all');
    setShowSavedOnly(false);
    setMapBounds(null);
  };

  const hasActiveFilters = Boolean(
    searchQuery ||
    selectedCategory !== 'all' ||
    jobType ||
    remoteType ||
    minSalary > 0 ||
    visaSponsorshipOnly ||
    directAtsOnly ||
    lastPosted !== 'all' ||
    showSavedOnly
  );

  /* The words the search is actually asking for -- folded, with the gender
   * tags and contract noise dropped. Taken from the committed query, not the
   * one being typed, so the list is filtered by the same words that fetched
   * it instead of emptying itself half way through a word. */
  const queryTerms = useMemo(() => terms(committedQuery), [committedQuery]);

  // Filter jobs dynamically
  const filteredJobs = useMemo(() => {
    // 1. General criteria filtering (saved, role, category, jobType, remote, minSalary, visa, timeframe)
    const baseFiltered = jobs.filter((job) => {
      // Saved filter
      if (showSavedOnly && !savedJobIds.has(job.id)) {
        return false;
      }

      // City filter (if map bounds are not constraining)

      // Relevance to the search is judged further down, on the whole set at
      // once, because "is this the job you asked for" cannot be answered one
      // row at a time -- it depends on what else came back.

      // Last posted timeframe filter
      if (lastPosted !== 'all') {
        const days = job.postedDaysAgo ?? Infinity;
        const range = parsePostedRange(lastPosted);
        if (range) {
          // An explicit interval, so it is bounded at BOTH ends -- picking
          // 1-10 September means jobs from the 11th onward are excluded too.
          // daysAgo(start) is the older edge, so it is the larger number.
          if (days > daysAgo(range.start) || days < daysAgo(range.end)) return false;
          return true;
        }
        if (lastPosted === '24h' && days > 1) return false;
        if (lastPosted === '3d' && days > 3) return false;
        if (lastPosted === '7d' && days > 7) return false;
        if (lastPosted === '14d' && days > 14) return false;
        if (lastPosted === '30d' && days > 30) return false;
      }

      // Category / Discipline
      if (selectedCategory !== 'all') {
        const catMap: Record<string, string[]> = {
          'Precision & Mechatronics': ['mechatron', 'precision', 'asml', 'semiconductor', 'motion', 'optics', 'control', 'micro'],
          'Aerospace & Defense': ['aero', 'airbus', 'safran', 'defense', 'space', 'satellit', 'propulsion', 'aviation', 'flight'],
          'Mechanical Design (CAD)': ['design', 'cad', 'catia', 'solidworks', 'nx', 'creo', 'conception', 'progettista', 'draft'],
          'Simulation & FEA': ['fea', 'fem', 'cfd', 'simulation', 'ansys', 'abaqus', 'thermal', 'fluid', 'calcul', 'stress'],
          'Automotive & EV': ['automotive', 'vehicle', 'ev', 'battery', 'powertrain', 'chassis', 'car', 'motor'],
          'Automation & Robotics': ['robot', 'automation', 'plc', 'scada', 'industry 4', 'automate'],
          'Materials & Metallurgy': ['material', 'metallurg', 'steel', 'composite', 'polymer', 'metal'],
        };
        const keywords = catMap[selectedCategory] || [selectedCategory.toLowerCase()];
        const fullText = `${job.title} ${job.description} ${job.category}`.toLowerCase();
        const matches = job.category === selectedCategory || keywords.some((k) => fullText.includes(k));
        if (!matches) {
          return false;
        }
      }

      // Job type (Full-time / Part-time / Contract)
      if (jobType && job.jobType !== jobType) {
        return false;
      }

      // Remote type (Remote / Hybrid / On-site)
      if (remoteType && job.remoteType !== remoteType) {
        return false;
      }

      // Min Salary
      if (minSalary > 0 && (job.salaryMax ?? 0) < minSalary) {
        return false;
      }

      // Visa Sponsorship
      if (visaSponsorshipOnly && !job.visaSponsorship) {
        return false;
      }

      // Listings the agent can actually drive: a direct employer ATS form, not
      // an aggregator redirect, and with an application URL to submit.
      if (directAtsOnly && !(job.applyUrl && job.isDirectApply)) {
        return false;
      }

      return true;
    });

    // 2. Viewport bounds filtering when "Search as I move the map" is enabled
    let inArea = baseFiltered;
    if (searchAsMapMoves && mapBounds) {
      // Unresolved locations remain in the list, never as invented map pins.
      const reach = inViewOf(mapBounds);
      inArea = baseFiltered.filter(
        (job) => !Number.isFinite(job.lat) || !Number.isFinite(job.lng) || reach(job)
      );
    }

    /* 3. Relevance.
     *
     * The old test was `words.some(w => text.includes(w))` over the title, the
     * company, the location, the description AND the category -- so searching
     * "ingénieur mécanique" kept every ad whose description said "ingénieur"
     * once, which in this industry is all of them. That is why the results
     * were maintenance technicians and electrical engineers.
     *
     * Now the question is asked of the title (plus the company, so that typing
     * an employer's name still works) and asked of the whole set at once: if
     * anything here answers the query completely, only those are shown. Only
     * when nothing does -- a thin rural map area, a niche title -- do partial
     * matches appear, best first, because an approximate answer beats an empty
     * page. A title that answers none of it is never shown. */
    if (queryTerms.length === 0) return inArea;

    const scored = inArea.map((job) => ({
      job,
      match: matchTitle(`${job.title} ${job.company}`, queryTerms),
    }));
    const exact = scored.filter((s) => s.match.full);
    if (exact.length > 0) return exact.map((s) => s.job);

    /* Nothing here answers the query. Show the nearest things, but only the
     * nearest FEW: a title that says half of what was asked is worth offering
     * when there is nothing better, and worthless three hundred times over --
     * that is the same page of not-quite-right jobs, just arrived by another
     * route. Half the words is the floor, twenty-four the ceiling. */
    return scored
      .filter((s) => s.match.covered * 2 >= s.match.wanted && s.match.covered > 0)
      .sort((a, b) => b.match.covered - a.match.covered)
      .slice(0, 24)
      .map((s) => s.job);
  }, [
    jobs,
    queryTerms,
    selectedCategory,
    jobType,
    remoteType,
    minSalary,
    visaSponsorshipOnly,
    directAtsOnly,
    showSavedOnly,
    savedJobIds,
    searchAsMapMoves,
    mapBounds,
    lastPosted,
  ]);

  // The column and the map always show the same set: `filteredJobs`. The map
  // used to be able to pin the list to one cluster's contents, which needed a
  // separate `listedJobs`; it no longer has clusters, so that indirection is
  // gone and both read the same value.

  const currentCity = CITIES.find((c) => c.id === selectedCity) || CITIES[0];

  /* How many, where, and the way in to the filters.
   *
   * It lives in two places on purpose. On a wide window it is handed to the
   * navbar and sits level with the search field, out over the left edge of the
   * listings -- which is what lets the first row of cards start at the same
   * height as the map instead of one heading lower. On anything narrower there
   * is no room beside a centred search field, so it goes back to the top of the
   * column. Same markup either way, so the two cannot drift apart. */
  const resultsSummary = (
    <div className="min-w-0">
      {/* Wraps rather than squeezes. The count is the one thing on this line
        * that has to stay readable, and on a phone "587 jobs" was losing its
        * tail to make room for two pills. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h2 className="text-[22px] md:text-[26px] leading-tight font-semibold text-[#f5f5f7] tracking-[-0.028em] truncate">
           {isLoadingJobs && !jobs.length
             ? 'Searching jobs...'
             : `${filteredJobs.length} ${filteredJobs.length === 1 ? 'job' : 'jobs'}`}
        </h2>
        {/* The whole filter strip, folded into the glyph beside the
          * count -- same vocabulary as the ribbon icons up top. */}
        <FilterBar
          selectedCategory={selectedCategory}
          setSelectedCategory={setSelectedCategory}
          jobType={jobType}
          setJobType={setJobType}
          remoteType={remoteType}
          setRemoteType={setRemoteType}
          minSalary={minSalary}
          setMinSalary={setMinSalary}
          visaSponsorshipOnly={visaSponsorshipOnly}
          setVisaSponsorshipOnly={setVisaSponsorshipOnly}
          directAtsOnly={directAtsOnly}
          setDirectAtsOnly={setDirectAtsOnly}
          totalResults={filteredJobs.length}
          onResetFilters={handleResetFilters}
          hasActiveFilters={hasActiveFilters}
        />
        {/* Back to the four questions. The bar at the top edits one field at a
          * time, which is right for a nudge; this is for starting over. */}
        {!selectMode && !bulkQueue?.running && (
          <button
            type="button"
            onClick={() => {
              clearSearchBrief();
              setSearchBrief(null);
            }}
            className="shrink-0 px-2.5 py-1 rounded-full ic-fill text-[12px] font-semibold tracking-[-0.01em] text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition-colors duration-200 cursor-pointer"
            title="Answer the four questions again"
          >
            New search
          </button>
        )}
        {/* Picking several at once. Beside the count and the filters because
          * it acts on exactly what they describe: this list, as filtered. */}
        {!bulkQueue?.running && (
          <button
            type="button"
            onClick={() => {
              if (selectMode) {
                exitSelectMode();
                return;
              }
              // The summary of the last run is not in the way of the next one:
              // starting to choose again is as clear a dismissal as the X.
              setBulkQueue(null);
              setSelectMode(true);
            }}
            className={`shrink-0 px-2.5 py-1 rounded-full text-[12px] font-semibold tracking-[-0.01em] transition-colors duration-200 ease-apple-out cursor-pointer ${
              selectMode
                ? 'bg-[#0a84ff] text-white'
                : 'ic-fill text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]'
            }`}
            title="Pick several jobs and apply to all of them"
          >
            {selectMode ? 'Done' : 'Select'}
          </button>
        )}
        {selectMode && filteredJobs.length > 0 && (
          <button
            type="button"
            onClick={() => {
              const eligible = filteredJobs
                .slice(0, visibleCardCount)
                .filter((job) => !bulkBlocker(job, (j) => appliedJobIds.has(j.id)));
              const allChosen = eligible.every((job) => selectedIds.has(job.id));
              setSelectedIds(allChosen ? new Set() : new Set(eligible.map((job) => job.id)));
            }}
            className="shrink-0 px-2.5 py-1 rounded-full text-[12px] font-medium tracking-[-0.01em] text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
          >
            Select all
          </button>
        )}
      </div>
      {/* Wraps rather than truncates: beside the search field this line has
        * about half the width it has in the column, and an ellipsis through
        * the middle of a sentence reads as breakage. Two short lines do not. */}
      <p className="text-[13px] leading-snug text-[rgba(235,235,245,0.42)] mt-0.5 tracking-[-0.01em]">
         {searchAsMapMoves ? `Map area: ${activeLocationLabel}. Unmapped results are listed separately.` : `${currentCity.name} and nearby jobs`}
      </p>
    </div>
  );

  return (
    /* No background of its own: the body carries the blue canvas, and an opaque
     * root here painted straight over it. */
    <div className={`text-[#f5f5f7] font-sans antialiased ${activeJobPage ? 'min-h-screen flex flex-col overflow-y-auto' : 'h-screen flex flex-col overflow-hidden'}`}>
      
      {/* Toast notification banner */}
      {toastMessage && (
        <div className="fixed top-28 left-1/2 -translate-x-1/2 z-[100] bg-gray-900 text-white text-xs font-bold px-5 py-2.5 rounded-full shadow-2xl flex items-center gap-2.5 animate-in fade-in slide-in-from-top-4 duration-200">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="max-w-[420px] truncate">{toastMessage}</span>
        </div>
      )}

      {/* The live application: what the browser is doing, the filled form, and
          the only button that sends it. */}
      {applyRun && (
        <ApplyReviewPanel
          run={applyRun}
          isSubmitting={isSubmittingForReal}
          isStopping={isStoppingApply}
          onStop={handleStopApply}
          onSubmitForReal={handleSubmitForReal}
          onClose={() => setApplyRun(null)}
        />
      )}

      {/* Choosing several jobs, then watching them go. Rendered beside the
          live panel rather than inside it: the panel is about one application
          and closes with it, while this outlives every run in the queue. */}
      <BulkApplyBar
        selectedCount={selectedIds.size}
        eligibleCount={
          filteredJobs.filter(
            (job) => selectedIds.has(job.id) && !bulkBlocker(job, (j) => appliedJobIds.has(j.id)),
          ).length
        }
        queue={bulkQueue}
        onStart={handleBulkStart}
        onClear={exitSelectMode}
        onSkip={handleBulkSkip}
        onStop={handleBulkStop}
        onDismiss={() => setBulkQueue(null)}
      />

      {/* The chrome, decomposed the way iCloud's is: a ribbon welded to the top
        * edge for identity and navigation, then the work floating under it as
        * separate blocks on the wallpaper -- search in one island, filters in
        * another.
        *
        * This was one slab until now, and for a reason: two *touching* bars
        * cannot each have a shadow, because the upper one's would fall behind
        * the lower one and show straight through its translucency as a dark
        * band. Separating them by a real gap is what makes the shadows legal
        * again -- each one now lands on the wallpaper, which is the whole
        * point of the look. The price is one extra backdrop-filter pass. */}
      {!activeJobPage && (
        <div className="shrink-0">
        <Navbar
          searchQuery={searchQuery}
          setSearchQuery={(q) => {
            setActiveJobPage(null);
            setSearchQuery(q);
          }}
          selectedCity={selectedCity}
          setSelectedCity={(cityId) => {
            setActiveJobPage(null);
            whereRef.current = cityId;
            setSelectedCity(cityId);
            setMapBounds(null);
          }}
          activeLocationLabel={activeLocationLabel}
          onSearchDestination={handleSearchDestination}
          lastPosted={lastPosted}
          setLastPosted={setLastPosted}
          savedCount={savedJobIds.size}
          appliedCount={appliedJobIds.size}
          showSavedOnly={showSavedOnly}
          setShowSavedOnly={setShowSavedOnly}
          onOpenPostJob={() => setIsPostJobOpen(true)}
          activeTopTab={activeTopTab}
          setActiveTopTab={setActiveTopTab}
          /* The results island carries its own count now. */
          resultsSummary={null}
          hideSearch={activeTopTab === 'jobs' && !searchBrief}
        />
        </div>
      )}

      {/* If viewing a dedicated Job Offer Page (Airbnb-style) */}
      {activeJobPage ? (
        <JobPage
          job={activeJobPage}
          onBack={handleBackFromJobPage}
          onApply={handleFastApply}
          isSaved={savedJobIds.has(activeJobPage.id)}
          onToggleSave={handleToggleSave}
          isApplying={applyingJobId === activeJobPage.id}
          isApplied={appliedJobIds.has(activeJobPage.id)}
          onUnmarkApplied={handleUnmarkApplied}
        />
      ) : activeTopTab === 'interview' ? (
        <InterviewHelperModal
          isOpen={true}
          onClose={() => setActiveTopTab('jobs')}
        />
      ) : activeTopTab === 'emails' ? (
        /* Outreach is a page, not a dialog: it is worked in for an hour at a
           time, it has four sections of its own, and a modal that covers the
           app to show a ledger is a window pretending to be a sheet. */
        <OutreachPage onClose={() => setActiveTopTab('jobs')} />
      ) : !searchBrief ? (
        /* Nothing is guessed until the questions are answered. Same shape as
           the interview setup, and for the same reason. */
        <SearchSetup onStart={handleStartFromBrief} onSkip={handleSkipBrief} />
      ) : (
        <>

          {/* THE CANVAS.
            * The map is no longer a panel beside the results; it is the page,
            * and the results float on it. Two columns meant six vertical edges
            * to reconcile -- listings, search field and map each aligned to a
            * different one -- and a card whose cover was 61% of its height so
            * that two jobs filled a screen. One surface has no edges to
            * reconcile, and the list can lie down. */}
          <main className="flex-1 min-h-0 w-full px-4 sm:px-6 lg:px-8 pt-2 pb-3 overflow-hidden">
            <div className="relative h-full w-full max-w-[1760px] mx-auto">

              {/*
                `isolate` is load-bearing: Leaflet gives its internal panes
                z-index 400-800, and without a stacking context here those
                numbers compete at the document root and paint straight over
                the navbar's search dropdowns (which live inside a z-40 sticky
                header). It also keeps the map below the island, which is the
                whole arrangement.
              */}
              <div
                className={`absolute inset-0 rounded-[22px] overflow-hidden ic-panel isolate z-0 ${
                  mobileView === 'list' ? 'hidden md:block' : 'block'
                }`}
              >
            <JobMap
              jobs={filteredJobs}
              selectedCity={selectedCity}
              mapCenterTarget={mapCenterTarget}
              hoveredJobId={hoveredJobId}
              hoveredListJobId={hoveredListJobId}
              selectedJobId={null}
              onHoverJob={setHoveredJobId}
              onSelectJob={handleOpenJobPage}
              onApplyJob={handleFastApply}
              searchAsMapMoves={searchAsMapMoves}
              setSearchAsMapMoves={setSearchAsMapMoves}
              onBoundsChange={setMapBounds}
              onMapMoveStart={handleMapMoveStart}
              onMapMoveEnd={handleMapMoveEnd}
              isLoadingMapMove={isLoadingJobs}
              savedJobIds={savedJobIds}
              onToggleSave={handleToggleSave}
            />
              </div>

              {/* THE ISLAND.
                * Absolutely placed rather than floated in a flex row: the map
                * must run underneath it, edge to edge, or the canvas is just a
                * column again. Width is the only thing that animates. */}
              {listPane !== 'hidden' && (
                <div
                  className={`absolute inset-y-0 left-0 z-10 p-3 max-w-full flex transition-[width] duration-300 ease-apple-spring ${
                    mobileView === 'map' ? 'hidden md:flex' : 'flex'
                  } ${
                    listPane === 'grid'
                      ? 'w-full md:w-[64%] xl:w-[58%]'
                      : 'w-full md:w-[440px] xl:w-[476px]'
                  }`}
                >
                  <div className="ic-panel w-full flex flex-col min-h-0 rounded-[20px] overflow-hidden bg-[rgba(16,18,22,0.72)] backdrop-blur-2xl">

                    {/* The island's own header, welded above the scroll so the
                      * count and the way out never scroll away. */}
                    <div className="shrink-0 flex items-start justify-between gap-2 px-3.5 pt-3 pb-2.5 border-b border-white/[0.09]">
                      {/* The count lives here at every width now. It was put
                        * beside the search field to line the listings column up
                        * with the map; there is no column left to line up, and
                        * up there it read as a caption for the whole page
                        * rather than for this list. */}
                      <div className="min-w-0">{resultsSummary}</div>
                      {/* Desktop only: on a phone the island is the screen, and
                        * the floating Map/List pill already does this job. */}
                      <div className="shrink-0 hidden md:flex items-center gap-1 pt-0.5">
                        <button
                          type="button"
                          onClick={() => setListPane(listPane === 'grid' ? 'rows' : 'grid')}
                          className="p-1.5 rounded-full text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
                          title={listPane === 'grid' ? 'Narrow the list, widen the map' : 'Widen the list to cards'}
                        >
                          {listPane === 'grid'
                            ? <ChevronsLeft className="w-4 h-4 stroke-[2.2]" />
                            : <ChevronsRight className="w-4 h-4 stroke-[2.2]" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => setListPane('hidden')}
                          className="p-1.5 rounded-full text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
                          title="Hide the list and show the whole map"
                        >
                          <X className="w-4 h-4 stroke-[2.2]" />
                        </button>
                      </div>
                    </div>

                    {/* px-3 -mx-3 is not decoration: `overflow-y: auto` forces
                      * `overflow-x: auto` too, so this box clips horizontally,
                      * and the cards sat flush against both of its edges --
                      * which cut the side shadows off. The padding gives the
                      * shadow somewhere to fall. */}
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3.5 pt-3 pb-28 md:pb-4">
                       {searchError && <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{searchError}</p>}
                       {/* Keep existing cards usable while refreshing the feed. */}
                      {isLoadingJobs && jobs.length === 0 ? (
                        listPane === 'grid' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8 animate-pulse">
                          {[1, 2, 3, 4, 5, 6].map((n) => (
                            <div key={n} className="flex flex-col">
                              {/* Top pill placeholder */}
                              <div className="h-3.5 w-28 bg-white/10 rounded-full mb-2.5" />
                              {/* Photo placeholder matching media_1788486684713.png */}
                              <div className="aspect-[20/19] w-full rounded-2xl bg-white/10 shadow-xs" />
                              {/* Content line placeholders */}
                              <div className="space-y-2 pt-3">
                                <div className="h-4 bg-white/10 rounded-md w-3/4" />
                                <div className="h-3.5 bg-white/[0.07] rounded-md w-1/2" />
                                <div className="h-3 bg-white/[0.05] rounded-md w-1/3" />
                                <div className="h-4 bg-white/10 rounded-md w-2/5 pt-1" />
                              </div>
                            </div>
                          ))}
                        </div>
                        ) : (
                        /* The same skeleton lying down, so the wait has the shape of what
                           is coming rather than of the layout that was replaced. */
                        <div className="flex flex-col gap-2.5 animate-pulse">
                          {[1, 2, 3, 4, 5, 6].map((n) => (
                            <div key={n} className="flex gap-3 p-2.5 rounded-2xl bg-white/[0.04]">
                              <div className="w-[104px] h-[104px] shrink-0 rounded-[13px] bg-white/10" />
                              <div className="flex-1 min-w-0 space-y-2 py-1">
                                <div className="h-4 bg-white/10 rounded-md w-3/4" />
                                <div className="h-3.5 bg-white/[0.07] rounded-md w-1/2" />
                                <div className="h-3 bg-white/[0.05] rounded-md w-1/3" />
                                <div className="h-4 bg-white/10 rounded-md w-2/5" />
                              </div>
                            </div>
                          ))}
                        </div>
                        )
                      ) : filteredJobs.length > 0 ? (
                        <div className="space-y-8">
                           <div className={listPane === 'grid'
                             ? 'grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-6'
                             : 'flex flex-col gap-2.5'}>
                             {filteredJobs.slice(0, visibleCardCount).map((job) => (
                              <JobCard
                                key={job.id}
                                layout={listPane === 'grid' ? 'tile' : 'row'}
                                job={job}
                                isHovered={hoveredJobId === job.id}
                                isSelected={false}
                                isSaved={savedJobIds.has(job.id)}
                                isApplied={appliedJobIds.has(job.id)}
                                applyOutcome={applyOutcomes[job.id]}
                                onHover={handleCardHover}
                                onSelect={handleOpenJobPage}
                                onToggleSave={handleToggleSave}
                                onApply={handleFastApply}
                                selectable={selectMode}
                                isChecked={selectedIds.has(job.id)}
                                onToggleCheck={toggleSelected}
                              />
                            ))}
                          </div>

                          {/* Explore More Jobs In This Area Button */}
                          <div className="pt-4 pb-12 flex flex-col items-center justify-center gap-2 border-t border-white/10">
                            <button
                              type="button"
                              onClick={handleLoadMoreInArea}
                              disabled={isLoadingMore || isLoadingJobs}
                              className="px-8 py-3.5 rounded-full bg-white/10 text-[#f5f5f7] hover:bg-white/20 font-bold text-xs tracking-tight shadow-sm hover:shadow-md transition active:scale-95 flex items-center gap-2 select-none disabled:opacity-50 cursor-pointer"
                            >
                              {isLoadingMore ? (
                                <>
                                  <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                                  <span>Fetching more jobs in this area...</span>
                                </>
                              ) : (
                                <>
                                   <span>{visibleCardCount < filteredJobs.length ? 'Show more jobs' : 'Refresh this area'}</span>
                                </>
                              )}
                            </button>
                            <p className="text-[11px] text-[rgba(235,235,245,0.42)] font-medium">Showing {filteredJobs.length} active opportunities</p>
                          </div>
                        </div>
                      ) : (
                        /* Empty State */
                        <div className="py-20 text-center space-y-4 max-w-md mx-auto">
                          <div className="w-14 h-14 rounded-full bg-white/10 text-[rgba(235,235,245,0.42)] flex items-center justify-center mx-auto">
                            <MapPin className="w-7 h-7" />
                          </div>
                          <div>
                            <h3 className="text-[17px] font-semibold tracking-[-0.022em] text-[#f5f5f7]">
                              No job offers match your current search
                            </h3>
                            <p className="text-xs text-[rgba(235,235,245,0.62)] mt-1">
                              Try clearing your active filters or expanding the timeframe.
                            </p>
                          </div>
                          <button
                            onClick={handleResetFilters}
                            className="px-5 py-2.5 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-[13px] font-medium tracking-[-0.01em] transition-[background-color,transform] duration-200 ease-apple-spring active:scale-[0.97]"
                          >
                            Clear all filters
                          </button>
                        </div>
                      )}

                      {/* The iCloud footer band, at the only place on this view where
                        * scrolling ends. Pinning it to the window instead would cost every
                        * screen ~130px of map, permanently, to show something iCloud only
                        * ever shows you below the fold.
                        *
                        * Three columns need width to be three columns. In the 440px
                        * reading pane they collapsed to a word a line -- "Where / these /
                        * come / from" -- so the band waits for a pane wide enough to lay
                        * it out: the two-up cards, or a phone, where the island is the
                        * whole screen and the columns stack the way they were drawn to. */}
                      <div className={listPane === 'grid' ? '' : 'md:hidden'}>
                        <FooterInfo
                          savedCount={savedJobIds.size}
                          appliedCount={appliedJobIds.size}
                          jobCount={filteredJobs.length}
                          locationLabel={searchAsMapMoves ? activeLocationLabel : currentCity.name}
                          onShowSaved={() => setShowSavedOnly(true)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* What is left of the island when it is put away. */}
              {listPane === 'hidden' && (
                <button
                  type="button"
                  onClick={() => setListPane('rows')}
                  className="absolute top-3 left-3 z-10 px-4 py-2.5 rounded-full ic-panel bg-[rgba(16,18,22,0.78)] backdrop-blur-2xl text-[13px] font-semibold tracking-[-0.01em] text-[#f5f5f7] hover:bg-[rgba(28,30,36,0.86)] transition-colors duration-200 cursor-pointer flex items-center gap-2"
                >
                  <ListFilter className="w-4 h-4 stroke-[2.2]" />
                  <span>
                    {isLoadingJobs && !jobs.length
                      ? 'Searching jobs...'
                      : `${filteredJobs.length} ${filteredJobs.length === 1 ? 'job' : 'jobs'}`}
                  </span>
                </button>
              )}

            </div>
          </main>

      {/* Floating Toggle for Mobile Screens (Map vs List) - Airbnb floating pill */}
      {activeBottomTab === 'explore' && (
        <div className="fixed bottom-[96px] left-1/2 -translate-x-1/2 z-30 md:hidden pointer-events-auto">
          <button
            type="button"
            onClick={() => setMobileView(mobileView === 'map' ? 'list' : 'map')}
            className="flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#222222] hover:bg-black text-white font-medium text-xs shadow-[0_4px_16px_rgba(0,0,0,0.22)] active:scale-95 transition-all cursor-pointer"
          >
            {mobileView === 'map' ? (
              <>
                <ListFilter className="w-3.5 h-3.5 stroke-[2]" />
                <span>List</span>
              </>
            ) : (
              <>
                <MapIcon className="w-3.5 h-3.5 stroke-[2]" />
                <span>Map</span>
              </>
            )}
          </button>
        </div>
      )}

        </>
      )}

      {/* The job page is the one view that scrolls as a page, so the band can
        * sit at the end of it the way iCloud's does -- costing nothing, since
        * there is always more page below. */}
      {activeJobPage && (
        <div className="max-w-[1760px] w-full mx-auto px-4 sm:px-6 lg:px-8 pb-4">
          <FooterInfo
            savedCount={savedJobIds.size}
            appliedCount={appliedJobIds.size}
            onShowSaved={() => {
              handleBackFromJobPage();
              setShowSavedOnly(true);
            }}
          />
        </div>
      )}

      {/* Last row of the flex column: shrink-0, so it takes its 32px and leaves
        * the rest to the map and the list. Carries the Mapbox/OpenStreetMap
        * credit that the map itself no longer shows. */}
      <SiteFooter />

      {/* Signature Airbnb Mobile Bottom Tab Bar (Always accessible so user never gets stuck) */}
      <BottomTabBar
        activeTab={activeBottomTab}
        setActiveTab={handleSelectBottomTab}
        savedCount={savedJobIds.size}
        onOpenPostJob={() => setIsPostJobOpen(true)}
      />

      {/* Post a Job Modal (Employer) */}
      <PostJobModal
        isOpen={isPostJobOpen}
        onClose={() => setIsPostJobOpen(false)}
        onAddJob={handleAddJob}
        selectedCity={selectedCity}
      />

    </div>
  );
}

export default App;
