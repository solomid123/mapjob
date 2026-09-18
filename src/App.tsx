import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type L from 'leaflet';
import { 
  Map as MapIcon, 
  ListFilter, 
  MapPin, 
  Check, 
  Loader2 
} from 'lucide-react';
import { daysAgo, parsePostedRange } from './utils/postedRange';
import { Navbar } from './components/Navbar';
import { FilterBar } from './components/FilterBar';
import { FooterInfo, SiteFooter } from './components/SiteFooter';
import { JobCard } from './components/JobCard';
import { JobMap } from './components/JobMap';
import { JobPage } from './components/JobPage';
import { PostJobModal } from './components/PostJobModal';
import { AutomatedEmailsModal } from './components/AutomatedEmailsModal';
import { InterviewHelperModal } from './components/InterviewHelperModal';
import { CITIES } from './data/mockJobs';
import { resolveLocationFromCoords, getVisibleHubsInBounds } from './services/adzuna';
import {
  fetchDirectAtsJobs,
  fetchJobFeed,
  startBrowserApply,
  submitReviewedForm,
  pollBrowserApply,
  runOutcome,
  type ApplyOutcome,
  type BrowserApplyRun,
  type FetchJobsOptions,
} from './services/directAtsApi';
import { ApplyReviewPanel } from './components/ApplyReviewPanel';
import { BottomTabBar, type BottomTabType } from './components/BottomTabBar';

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

  // Top Nav Menu tab: 'jobs' | 'emails' | 'interview'
  const [activeTopTab, setActiveTopTab] = useState<'jobs' | 'emails' | 'interview'>('jobs');

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setCommittedQuery(searchQuery), 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const [selectedCity, setSelectedCity] = useState('eindhoven');
  const [activeLocationLabel, setActiveLocationLabel] = useState('Eindhoven & Brainport (NL)');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [jobType, setJobType] = useState('');
  const [remoteType, setRemoteType] = useState('');
  const [minSalary, setMinSalary] = useState(0);
  const [visaSponsorshipOnly, setVisaSponsorshipOnly] = useState(false);
  const [directAtsOnly, setDirectAtsOnly] = useState(false);
  const [lastPosted, setLastPosted] = useState('all');
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
  const handleSearchDestination = async (destination: string) => {
    if (!destination.trim()) return;
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
      setSelectedCity(match.id);
      setActiveLocationLabel(match.name);
      setMapBounds(null);
      setMapCenterTarget({ lat: match.lat, lng: match.lng, zoom: match.zoom });

      try {
        const params = {
          cityId: match.id,
          query: searchQuery,
          lastPosted,
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
          setActiveLocationLabel(display);
          setMapBounds(null);
          setMapCenterTarget({ lat, lng, zoom: 12 });

          const fetchParams = {
            where: location.name,
            country: location.country,
            centerLat: lat,
            centerLng: lng,
            defaultWhat: location.defaultWhat,
            query: searchQuery,
            lastPosted,
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
      setActiveLocationLabel(cleanDest);
      setMapBounds(null);
      const fallbackParams = {
        where: cleanDest,
        country: 'nl',
        query: searchQuery,
        lastPosted,
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
  const [isPostJobOpen, setIsPostJobOpen] = useState(false);
  const [mobileView, setMobileView] = useState<'both' | 'map' | 'list'>('list');
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
  const handleFastApply = async (job: Job) => {
    if (!job.applyUrl) {
      showToast('This listing has no official application URL.');
      return;
    }
    if (applyingJobId) {
      showToast('An application is already running.');
      return;
    }

    applyJobRef.current = job;
    setApplyingJobId(job.id);

    try {
      const started = await startBrowserApply(job);
      setApplyRun(started);
      const final = await pollBrowserApply(started.id, setApplyRun);
      setApplyRun(final);
      reportApplyOutcome(job, final);
    } catch (err: any) {
      showToast(err?.message || 'The apply service is unreachable.');
      setApplyRun(null);
    } finally {
      setApplyingJobId(null);
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

  // Filter jobs dynamically
  const filteredJobs = useMemo(() => {
    // 1. General criteria filtering (saved, role, category, jobType, remote, minSalary, visa, timeframe)
    const baseFiltered = jobs.filter((job) => {
      // Saved filter
      if (showSavedOnly && !savedJobIds.has(job.id)) {
        return false;
      }

      // City filter (if map bounds are not constraining)

      // Search keyword / role matching
      if (searchQuery.trim()) {
        const words = searchQuery
          .toLowerCase()
          .replace(/[()[\]{}"'’]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 2);
        if (words.length > 0) {
          const text = `${job.title} ${job.company} ${job.location} ${job.description} ${job.category}`.toLowerCase();
          const matches = words.some((w) => text.includes(w));
          if (!matches) return false;
        }
      }

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
    if (searchAsMapMoves && mapBounds) {
      // Unresolved locations remain in the list, never as invented map pins.
      const reach = inViewOf(mapBounds);
      return baseFiltered.filter(
        (job) => !Number.isFinite(job.lat) || !Number.isFinite(job.lng) || reach(job)
      );
    }

    return baseFiltered;
  }, [
    jobs,
    searchQuery,
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
          onSubmitForReal={handleSubmitForReal}
          onClose={() => setApplyRun(null)}
        />
      )}

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
      ) : (
        <>

          {/* MAIN SPLIT LAYOUT (Matches English Airbnb: Cards on Left, Map on Right) */}
          <main className="flex-1 max-w-[1760px] w-full mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-3 flex flex-col md:flex-row gap-6 xl:gap-8 overflow-hidden min-h-0 relative">
            
            {/* Left: Job Listings Column (Scrolls independently with slim custom scrollbar) */}
            <div
              /* px-3 -mx-3 is not decoration: `overflow-y: auto` forces
                 `overflow-x: auto` too, so this box clips horizontally, and
                 the cards sat flush against both of its edges -- which cut
                 the side shadows off and left the cards looking lit only from
                 below while the map, clipped by nothing, kept its shadow all
                 the way round. The padding gives the shadow somewhere to fall
                 and the negative margin gives the padding back to the layout. */
              className={`flex-1 h-full overflow-y-auto custom-scrollbar px-3 -mx-3 pb-36 md:pb-16 ${
                mobileView === 'map' ? 'hidden md:block' : 'block'
              }`}
            >
          {/* Subheader. It used to be desktop-only, because the filter strip
            * above the map carried the controls on a phone. That strip is gone,
            * so this row is now the only way to reach the filters and it shows
            * at every width. */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 md:mb-5 pt-1">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-[22px] md:text-[28px] font-semibold text-[#f5f5f7] tracking-[-0.028em]">
                   {isLoadingJobs && !jobs.length ? 'Searching jobs...' : `${filteredJobs.length} jobs`}
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
              </div>
              <p className="text-[13px] text-[rgba(235,235,245,0.42)] mt-1 tracking-[-0.01em]">
                 {searchAsMapMoves ? `Map area: ${activeLocationLabel}. Unmapped results are listed separately.` : `${currentCity.name} and nearby jobs`}
              </p>
            </div>
          </div>

           {searchError && <p role="alert" className="mb-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-800">{searchError}</p>}
           {/* Keep existing cards usable while refreshing the feed. */}
          {isLoadingJobs && jobs.length === 0 ? (
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
          ) : filteredJobs.length > 0 ? (
            <div className="space-y-8">
               <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-6">
                 {filteredJobs.slice(0, visibleCardCount).map((job) => (
                  <JobCard
                    key={job.id}
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
            * ever shows you below the fold. */}
          <FooterInfo
            savedCount={savedJobIds.size}
            appliedCount={appliedJobIds.size}
            jobCount={filteredJobs.length}
            locationLabel={searchAsMapMoves ? activeLocationLabel : currentCity.name}
            onShowSaved={() => setShowSavedOnly(true)}
          />
        </div>

        {/* Right: Framed Interactive Map Container (Permanent Fixed Full-Height) */}
        <div
          className={`w-full md:w-[48%] xl:w-[46%] h-full pb-2 shrink-0 ${
            mobileView === 'list' ? 'hidden md:block' : 'block'
          }`}
        >
          {/*
            `isolate` is load-bearing: Leaflet gives its internal panes z-index
            400-800, and without a stacking context here those numbers compete
            at the document root and paint straight over the navbar's search
            dropdowns (which live inside a z-40 sticky header).
          */}
          <div className="w-full h-full rounded-[22px] overflow-hidden ic-panel relative isolate z-0">
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

      {/* Automated Emails Feature Modal */}
      <AutomatedEmailsModal
        isOpen={activeTopTab === 'emails'}
        onClose={() => setActiveTopTab('jobs')}
      />

    </div>
  );
}

export default App;
