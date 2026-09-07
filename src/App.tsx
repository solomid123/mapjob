import { useState, useMemo, useEffect, useRef } from 'react';
import type L from 'leaflet';
import { 
  Map as MapIcon, 
  ListFilter, 
  MapPin, 
  Check, 
  Loader2 
} from 'lucide-react';
import { Navbar } from './components/Navbar';
import { FilterBar } from './components/FilterBar';
import { JobCard } from './components/JobCard';
import { JobMap } from './components/JobMap';
import { JobPage } from './components/JobPage';
import { LiveAgentModal } from './components/LiveAgentModal';
import { PostJobModal } from './components/PostJobModal';
import { AutomatedEmailsModal } from './components/AutomatedEmailsModal';
import { InterviewHelperModal } from './components/InterviewHelperModal';
import { CITIES } from './data/mockJobs';
import { fetchAdzunaJobs, resolveLocationFromCoords, getVisibleHubsInBounds } from './services/adzuna';
import { fetchArbeitnowJobs } from './services/arbeitnow';
import { getDirectAtsJobs } from './services/directAtsJobs';
import { isDirectAts, type Job } from './types/job';
import {
  saveJobToSupabase,
  fetchSavedJobsFromSupabase,
  updateJobStatusInSupabase,
} from './services/supabase';

export function App() {
  // Data state: 100% strictly live data from Adzuna API
  const [jobs, setJobs] = useState<Job[]>([]);

  const [savedJobIds, setSavedJobIds] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('mapjob_saved_ids');
    if (saved) {
      try {
        return new Set(JSON.parse(saved));
      } catch (e) {
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
  const activeParamsRef = useRef<Parameters<typeof fetchAdzunaJobs>[0]>({ cityId: 'eindhoven' });

  // Unified multi-source job aggregator (Verified Direct ATS + Adzuna parallel feed + Arbeitnow European tech feed)
  const loadAggregatedJobs = async (params: Parameters<typeof fetchAdzunaJobs>[0]): Promise<Job[]> => {
    try {
      const directJobs = getDirectAtsJobs(params.cityId || params.where);
      const [adzunaJobs, arbeitnowJobs] = await Promise.all([
        fetchAdzunaJobs(params),
        fetchArbeitnowJobs(params.where || params.cityId),
      ]);

      const seen = new Set<string>();
      const combined: Job[] = [];
      for (const j of [...directJobs, ...adzunaJobs, ...arbeitnowJobs]) {
        if (!seen.has(j.id)) {
          seen.add(j.id);
          combined.push(j);
        }
      }
      return combined;
    } catch (err) {
      console.warn('Aggregated fetch error:', err);
      return fetchAdzunaJobs(params);
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
    async function loadLiveJobs() {
      setIsLoadingJobs(true);
      try {
        const currentHub = CITIES.find((c) => c.id === selectedCity);
        if (currentHub) {
          setActiveLocationLabel(currentHub.name);
        }
        const params = {
          cityId: selectedCity,
          query: searchQuery,
          lastPosted,
          page: 1,
        };
        activeParamsRef.current = params;
        setCurrentPage(2);

        const liveJobs = await loadAggregatedJobs(params);
        if (isMounted) {
          setJobs(liveJobs);
        }
      } catch (err) {
        console.error('Failed to load real Adzuna jobs:', err);
      } finally {
        if (isMounted) setIsLoadingJobs(false);
      }
    }

    loadLiveJobs();
    return () => {
      isMounted = false;
    };
  }, [selectedCity, searchQuery, lastPosted]);

  // Load more jobs dynamically in the current map view (+50 more pins)
  const handleLoadMoreInArea = async () => {
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = currentPage + 1;
      const moreJobs = await fetchAdzunaJobs({
        ...activeParamsRef.current,
        query: searchQuery,
        lastPosted,
        page: nextPage,
      });

      if (moreJobs.length > 0) {
        setJobs((prev) => {
          const seen = new Set(prev.map((j) => j.id));
          const additions = moreJobs.filter((j) => !seen.has(j.id));
          return [...prev, ...additions];
        });
        setCurrentPage(nextPage);
        showToast(`Added ${moreJobs.length} more vacancies to this area!`);
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

  // Immediate loading trigger as soon as map dragging / zooming begins
  const handleMapMoveStart = () => {
    if (!searchAsMapMoves) return;
    setIsLoadingJobs(true);
  };

  const handleMapMoveEnd = (center: { lat: number; lng: number }, bounds: L.LatLngBounds) => {
    setMapBounds(bounds);
    if (!searchAsMapMoves) return;

    setIsLoadingJobs(true);

    if (mapMoveTimerRef.current) {
      clearTimeout(mapMoveTimerRef.current);
    }

    mapMoveTimerRef.current = setTimeout(async () => {
      try {
        const visibleHubs = getVisibleHubsInBounds(bounds);

        if (visibleHubs.length > 1) {
          // Multiple cities in visible viewport! (e.g. Eindhoven, Tilburg, Breda, Den Bosch)
          // Sort by distance to center and pick up to 4 closest hubs
          const sortedHubs = [...visibleHubs]
            .sort((a, b) => {
              const distA = Math.hypot(a.lat - center.lat, a.lng - center.lng);
              const distB = Math.hypot(b.lat - center.lat, b.lng - center.lng);
              return distA - distB;
            })
            .slice(0, 4);

          const cityNames = sortedHubs.map((h) => h.name).join(', ');
          setActiveLocationLabel(cityNames);

          const primaryHub = sortedHubs[0];
          const matchCity = CITIES.find(
            (c) =>
              c.name.toLowerCase().includes(primaryHub.name.toLowerCase()) ||
              primaryHub.name.toLowerCase().includes(c.id)
          );
          if (matchCity) {
            setSelectedCity(matchCity.id);
          }

          // Fetch live jobs across all visible cities simultaneously
          const hubPromises = sortedHubs.map((hub) =>
            loadAggregatedJobs({
              where: hub.name,
              country: hub.country,
              centerLat: hub.lat,
              centerLng: hub.lng,
              defaultWhat: hub.defaultWhat,
              query: searchQuery,
              lastPosted,
              page: 1,
            })
          );

          const results = await Promise.all(hubPromises);
          const seen = new Set<string>();
          const combinedJobs: Job[] = [];
          for (const list of results) {
            for (const j of list) {
              if (!seen.has(j.id)) {
                seen.add(j.id);
                combinedJobs.push(j);
              }
            }
          }

          activeParamsRef.current = {
            where: primaryHub.name,
            country: primaryHub.country,
            centerLat: primaryHub.lat,
            centerLng: primaryHub.lng,
            defaultWhat: primaryHub.defaultWhat,
            query: searchQuery,
            lastPosted,
            page: 1,
          };
          setCurrentPage(2);

          if (combinedJobs.length > 0) {
            setJobs(combinedJobs);
          }
        } else {
          // Single hub or reverse geocode viewport center
          const location = await resolveLocationFromCoords(center.lat, center.lng);
          setActiveLocationLabel(location.displayLabel || `${location.name}, ${location.country.toUpperCase()}`);

          if (location.name.toLowerCase().includes('luxembourg')) {
            setSelectedCity('luxembourg');
          } else if (location.name.toLowerCase().includes('brussel') || location.name.toLowerCase().includes('bruxelles')) {
            setSelectedCity('brussels');
          } else {
            const matchCity = CITIES.find((c) => c.name.toLowerCase().includes(location.name.toLowerCase()) || location.name.toLowerCase().includes(c.id));
            if (matchCity) {
              setSelectedCity(matchCity.id);
            }
          }

          const fetchParams = {
            where: location.name,
            country: location.country,
            centerLat: center.lat,
            centerLng: center.lng,
            defaultWhat: location.defaultWhat,
            query: searchQuery,
            lastPosted,
            page: 1,
          };
          activeParamsRef.current = fetchParams;
          setCurrentPage(2);

          // Fetch live jobs for this visible location
          const liveJobs = await loadAggregatedJobs(fetchParams);

          if (liveJobs.length > 0) {
            setJobs(liveJobs);
          }
        }
      } catch (err) {
        console.error('Failed to load real Adzuna jobs on map move:', err);
      } finally {
        setIsLoadingJobs(false);
      }
    }, 250);
  };

  // Search any European destination (via Enter key, suggested hub click, or Search button)
  const handleSearchDestination = async (destination: string) => {
    if (!destination.trim()) return;
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

        const liveJobs = await loadAggregatedJobs(params);
        setJobs(liveJobs);
      } catch (err) {
        console.error('Failed to load jobs for hub:', err);
      } finally {
        setIsLoadingJobs(false);
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

          const liveJobs = await loadAggregatedJobs(fetchParams);

          if (liveJobs.length > 0) {
            setJobs(liveJobs);
          } else {
            showToast(`Found 0 jobs directly in ${cleanDest}. Expanding radius...`);
          }
          return;
        }
      }
    } catch (err) {
      console.warn('Geocoding error:', err);
    }

    // 3. Fallback: Search Adzuna with destination string
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

      const liveJobs = await loadAggregatedJobs(fallbackParams);
      if (liveJobs.length > 0) {
        setJobs(liveJobs);
      }
    } catch (err) {
      console.error('Fallback destination search failed:', err);
    } finally {
      setIsLoadingJobs(false);
    }
  };

  // Interaction state
  const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);
  const [hoveredListJobId, setHoveredListJobId] = useState<string | null>(null);

  const handleCardHover = (id: string | null) => {
    setHoveredJobId(id);
    setHoveredListJobId(id);
  };
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
  const [isPostJobOpen, setIsPostJobOpen] = useState(false);
  const [mobileView, setMobileView] = useState<'both' | 'map' | 'list'>('both');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<string | null>(null);
  const [isLiveAgentOpen, setIsLiveAgentOpen] = useState(false);

  // Cancel any running autonomous application
  const handleCancelApply = async () => {
    try {
      await fetch('http://127.0.0.1:8000/api/cancel', { method: 'POST' });
    } catch {}
    setApplyingJobId(null);
    setLiveActivity(null);
    showToast('Autonomous application stopped.');
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

  // Autonomous 1-Click Fast Apply powered by Fuelix PageAgent (visible browser mode)
  const handleFastApply = async (job: Job) => {
    if (applyingJobId) {
      setIsLiveAgentOpen(true);
      showToast('An autonomous application is already running. Opening live inspector...');
      return;
    }

    setApplyingJobId(job.id);
    setLiveActivity('Opening browser & navigating to portal...');
    setIsLiveAgentOpen(true);
    showToast(`⚡ Launching PageAgent browser for ${job.title}...`);

    try {
      const targetUrl = job.applyUrl || '';
      const response = await fetch('http://127.0.0.1:8000/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          job_title: job.title,
          company: job.company,
          headless: false, // Visible Chrome browser window so user can watch actions live!
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || 'Could not start application bridge.');
      }

      showToast(`🤖 Browser opened! Autonomous PageAgent in progress...`);

      // Stream live progress
      const eventSource = new EventSource('http://127.0.0.1:8000/api/apply/stream');

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.message) {
            setLiveActivity(data.message);
          }
          if (data.done) {
            eventSource.close();
            setApplyingJobId(null);
            setLiveActivity(null);
            if (data.success) {
              setAppliedJobIds((prev) => {
                const next = new Set(prev);
                next.add(job.id);
                try {
                  localStorage.setItem('mapjob_applied_ids', JSON.stringify(Array.from(next)));
                } catch {}
                return next;
              });
              setJobs((prev) =>
                prev.map((j) => (j.id === job.id ? { ...j, applicantCount: j.applicantCount + 1 } : j))
              );
              showToast(`🎉 Application successfully submitted to ${job.company}!`);
            } else {
              showToast(`⚠️ Automation notice: ${data.message || 'Workflow finished.'}`);
            }
          }
        } catch (e) {
          console.error('SSE parse error:', e);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        setApplyingJobId(null);
      };
    } catch (err: any) {
      setApplyingJobId(null);
      showToast(`❌ ${err.message || 'Could not connect to automation server'}`);
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
      const customJobs = updated.filter((j) => !j.id.startsWith('adzuna-'));
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
      if (!searchAsMapMoves && job.city !== selectedCity) {
        return false;
      }

      // Search keyword / role
      // Note: Live jobs from Adzuna were already queried on server with searchQuery.
      // Only filter custom/local jobs or match leniently so we never reject valid API results.
      if (searchQuery.trim() && !job.id.startsWith('adzuna-')) {
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
        const days = job.postedDaysAgo ?? 2;
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
      if (minSalary > 0 && job.salaryMax < minSalary) {
        return false;
      }

      // Visa Sponsorship
      if (visaSponsorshipOnly && !job.visaSponsorship) {
        return false;
      }

      // ⚡ 1-Click Direct ATS Filter (filters out aggregators like Apec, France Travail, HelloWork, Indeed, etc.)
      if (directAtsOnly && !isDirectAts(job.atsProvider)) {
        return false;
      }

      return true;
    });

    // 2. Viewport bounds filtering when "Search as I move the map" is enabled
    if (searchAsMapMoves && mapBounds) {
      // Pad bounds generously by 40% so surrounding industrial facilities are included
      const paddedBounds = mapBounds.pad ? mapBounds.pad(0.4) : mapBounds;
      const withinBounds = baseFiltered.filter((job) => paddedBounds.contains([job.lat, job.lng]));
      // If user zoomed in very tight and none are directly in that 1km square,
      // show the region's active jobs so the list never empties out while viewing that city
      if (withinBounds.length > 0) {
        return withinBounds;
      }
    }

    return baseFiltered;
  }, [
    jobs,
    selectedCity,
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
  ]);

  const currentCity = CITIES.find((c) => c.id === selectedCity) || CITIES[0];

  return (
    <div className={`bg-white text-gray-900 font-sans antialiased ${activeJobPage ? 'min-h-screen flex flex-col overflow-y-auto' : 'h-screen flex flex-col overflow-hidden'}`}>
      
      {/* Toast / Live Activity Notification Banner */}
      {(toastMessage || liveActivity) && (
        <div className="fixed top-28 left-1/2 -translate-x-1/2 z-[100] bg-gray-900 text-white text-xs font-bold px-5 py-2.5 rounded-full shadow-2xl flex items-center gap-2.5 animate-in fade-in slide-in-from-top-4 duration-200">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="max-w-[420px] truncate">{liveActivity || toastMessage}</span>
          {applyingJobId && (
            <button
              type="button"
              onClick={() => setIsLiveAgentOpen(true)}
              className="ml-2 px-3 py-1 rounded-full bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-extrabold uppercase tracking-wider transition cursor-pointer shrink-0 shadow flex items-center gap-1"
            >
              <span>👁 Live View</span>
            </button>
          )}
          {(applyingJobId || (toastMessage && toastMessage.includes('already running'))) && (
            <button
              type="button"
              onClick={handleCancelApply}
              className="ml-1 px-2.5 py-1 rounded-full bg-gray-800 hover:bg-gray-700 text-rose-300 text-[10px] font-extrabold uppercase tracking-wider transition cursor-pointer shrink-0"
            >
              Stop
            </button>
          )}
        </div>
      )}

      {/* Top Airbnb Navbar with Menu (Jobs, Automated Emails, Interview Helper) & Search Bar */}
      {!activeJobPage && (
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
          showSavedOnly={showSavedOnly}
          setShowSavedOnly={setShowSavedOnly}
          onOpenPostJob={() => setIsPostJobOpen(true)}
          activeTopTab={activeTopTab}
          setActiveTopTab={setActiveTopTab}
        />
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
          liveActivity={applyingJobId === activeJobPage.id ? liveActivity : null}
          onUnmarkApplied={handleUnmarkApplied}
          onOpenLiveInspector={() => setIsLiveAgentOpen(true)}
        />
      ) : activeTopTab === 'interview' ? (
        <InterviewHelperModal
          isOpen={true}
          onClose={() => setActiveTopTab('jobs')}
        />
      ) : (
        <>
          {/* Categories & Filter Bar */}
          <div className="shrink-0 bg-white">
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

          {/* MAIN SPLIT LAYOUT (Matches English Airbnb: Cards on Left, Map on Right) */}
          <main className="flex-1 max-w-[1760px] w-full mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-3 flex flex-col md:flex-row gap-6 xl:gap-8 overflow-hidden min-h-0 relative">
            
            {/* Left: Job Listings Column (Scrolls independently with slim custom scrollbar) */}
            <div
              className={`flex-1 h-full overflow-y-auto custom-scrollbar pr-2 pb-16 ${
                mobileView === 'map' ? 'hidden md:block' : 'block'
              }`}
            >
          {/* Subheader matching exact Airbnb screenshot layout */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-2 border-b border-gray-100">
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-2xl font-black text-[#222222] tracking-tight">
                  {isLoadingJobs ? 'Searching jobs in map area...' : `${filteredJobs.length} mechanical engineering jobs`}
                </h2>
              </div>
              <p className="text-xs text-[#717171] mt-0.5">
                {searchAsMapMoves ? `Showing offers in visible map area (${activeLocationLabel})` : `${currentCity.name} Engineering Corridor`}
              </p>
            </div>
          </div>

          {/* Cards Grid: When loading with no jobs yet, show skeletons; when jobs exist, maintain cards with smooth opacity */}
          {isLoadingJobs && jobs.length === 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8 animate-pulse">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <div key={n} className="flex flex-col">
                  {/* Top pill placeholder */}
                  <div className="h-3.5 w-28 bg-gray-200 rounded-full mb-2.5" />
                  {/* Photo placeholder matching media_1788486684713.png */}
                  <div className="aspect-[20/19] w-full rounded-2xl bg-gray-200 shadow-xs" />
                  {/* Content line placeholders */}
                  <div className="space-y-2 pt-3">
                    <div className="h-4 bg-gray-200 rounded-md w-3/4" />
                    <div className="h-3.5 bg-gray-200/80 rounded-md w-1/2" />
                    <div className="h-3 bg-gray-200/60 rounded-md w-1/3" />
                    <div className="h-4 bg-gray-200 rounded-md w-2/5 pt-1" />
                  </div>
                </div>
              ))}
            </div>
          ) : filteredJobs.length > 0 ? (
            <div className="space-y-8">
              <div className={`grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-8 transition-opacity duration-150 ${isLoadingJobs ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
                {filteredJobs.map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    isHovered={hoveredJobId === job.id}
                    isSelected={false}
                    isSaved={savedJobIds.has(job.id)}
                    onHover={handleCardHover}
                    onSelect={handleOpenJobPage}
                    onToggleSave={handleToggleSave}
                    onApply={handleFastApply}
                  />
                ))}
              </div>

              {/* Explore More Jobs In This Area Button */}
              <div className="pt-4 pb-12 flex flex-col items-center justify-center gap-2 border-t border-gray-100">
                <button
                  type="button"
                  onClick={handleLoadMoreInArea}
                  disabled={isLoadingMore || isLoadingJobs}
                  className="px-8 py-3.5 rounded-full bg-white border border-gray-900 text-gray-900 hover:bg-gray-900 hover:text-white font-bold text-xs tracking-tight shadow-sm hover:shadow-md transition active:scale-95 flex items-center gap-2 select-none disabled:opacity-50 cursor-pointer"
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                      <span>Fetching more jobs in this area...</span>
                    </>
                  ) : (
                    <>
                      <span>Explore more jobs in this area (+50)</span>
                    </>
                  )}
                </button>
                <p className="text-[11px] text-gray-400 font-medium">Showing {filteredJobs.length} active opportunities</p>
              </div>
            </div>
          ) : (
            /* Empty State */
            <div className="py-20 text-center space-y-4 max-w-md mx-auto">
              <div className="w-14 h-14 rounded-full bg-rose-50 text-rose-500 flex items-center justify-center mx-auto">
                <MapPin className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-gray-900">
                  No job offers match your current search
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Try clearing your active filters or expanding the timeframe.
                </p>
              </div>
              <button
                onClick={handleResetFilters}
                className="px-5 py-2.5 bg-gray-900 hover:bg-black text-white rounded-xl text-xs font-bold transition shadow-sm"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>

        {/* Right: Framed Interactive Map Container (Permanent Fixed Full-Height) */}
        <div
          className={`w-full md:w-[48%] xl:w-[46%] h-full pb-2 shrink-0 ${
            mobileView === 'list' ? 'hidden md:block' : 'block'
          }`}
        >
          <div className="w-full h-full rounded-3xl overflow-hidden border border-gray-200/90 shadow-sm relative">
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

      {/* Floating Toggle for Mobile Screens (Map vs List) */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 md:hidden">
        <button
          onClick={() => setMobileView(mobileView === 'map' ? 'list' : 'map')}
          className="flex items-center gap-2 px-5 py-3 rounded-full bg-gray-900 hover:bg-black text-white font-bold text-xs shadow-2xl transition"
        >
          {mobileView === 'map' ? (
            <>
              <ListFilter className="w-4 h-4" />
              <span>Show List</span>
            </>
          ) : (
            <>
              <MapIcon className="w-4 h-4" />
              <span>Show Map</span>
            </>
          )}
        </button>
      </div>
        </>
      )}

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


      {/* Autonomous PageAgent Live Inspector Modal & Picture-in-Picture */}
      <LiveAgentModal
        isOpen={isLiveAgentOpen}
        onClose={() => setIsLiveAgentOpen(false)}
        onStop={handleCancelApply}
        onReapply={() => {
          const currentJob = activeJobPage || jobs.find((j) => j.id === applyingJobId);
          if (currentJob) handleFastApply(currentJob);
        }}
      />

    </div>
  );
}

export default App;
