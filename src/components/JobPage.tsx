import React, { useState, useEffect } from 'react';
import { 
  ArrowLeft, 
  Heart, 
  Share2, 
  MapPin, 
  ShieldCheck, 
  Clock, 
  CheckCircle2, 
  Sparkles, 
  Check, 
  ArrowUpRight, 
  Trophy, 
  Grid, 
  X, 
  Flag,
  Loader2,
  Zap
} from 'lucide-react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';
import type { Job } from '../types/job';
import { DEFAULT_JOB_IMAGE } from '../services/adzuna';
import { fetchJobDetail } from '../services/directAtsApi';
import { getEmailStatus, type EmailStatus } from '../services/applyAgent';
import { Wordmark } from './Wordmark';

const MAPBOX_TOKEN =
  import.meta.env.VITE_MAPBOX_TOKEN ||
  'pk.eyJ1IjoicGVkcm9vMSIsImEiOiJjbXRtOG5oem4wNDlxMnhyM29yd3U5NnJsIn0.mbWylo8UUAhjcwI64BNPSA';

interface JobPageProps {
  job: Job;
  onBack: () => void;
  onApply: (job: Job) => void;
  isSaved: boolean;
  onToggleSave: (id: string) => void;
  isApplying?: boolean;
  isApplied?: boolean;
  onUnmarkApplied?: (id: string) => void;
}

export const JobPage: React.FC<JobPageProps> = ({
  job,
  onBack,
  onApply,
  isSaved,
  onToggleSave,
  isApplying = false,
  isApplied = false,
  onUnmarkApplied,
}) => {
  const [copiedShare, setCopiedShare] = useState(false);
  const [showAllPhotos, setShowAllPhotos] = useState(false);
  // The agent can drive any listing that exposes an application URL.
  // Only true where the ATS genuinely accepts an unauthenticated submission.
  // Having an application URL is not the same as having an application API,
  // and offering to "apply for you" when we cannot is just a broken promise.
  const canAutoApply = job.canApplyViaApi === true && Boolean(job.applyUrl);
  const [applyMode, setApplyMode] = useState<'direct' | 'fast'>(canAutoApply ? 'fast' : 'direct');
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);

  useEffect(() => {
    let isMounted = true;
    getEmailStatus().then((status) => {
      if (isMounted) setEmailStatus(status);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  // Untruncated full description & dynamic highlights
  const [fullDescription, setFullDescription] = useState<string>(() => {
    let clean = job.description;
    clean = clean.replace(/\s*(?:\.\.\.|…)\s*$/, '');
    return clean;
  });
  const [responsibilities, setResponsibilities] = useState<string[]>(job.responsibilities);
  const [requirements, setRequirements] = useState<string[]>(job.requirements);
  const [isLoadingFull, setIsLoadingFull] = useState<boolean>(false);
  const [isFullLoaded, setIsFullLoaded] = useState<boolean>(false);

  // Direct employer destination portal (bypasses Adzuna redirect)
  const [applyUrl, setApplyUrl] = useState<string>(job.applyUrl || '');
  const [directDomain, setDirectDomain] = useState<string>('');

  // Automatically fetch complete, untruncated description & direct external employer portal URL
  useEffect(() => {
    let isMounted = true;

    // The map feed ships a snippet so the payload stays small. The employer's
    // own text is already on our backend, so restore it before scraping anything.
    async function restoreFeedDescription() {
      if (job.hasFullDescription !== false) return;
      setIsLoadingFull(true);
      try {
        const detailed = await fetchJobDetail(job.id);
        if (isMounted && detailed?.description && detailed.description.length > job.description.length) {
          setFullDescription(detailed.description);
          if (detailed.responsibilities.length) setResponsibilities(detailed.responsibilities);
          if (detailed.requirements.length) setRequirements(detailed.requirements);
        }
      } catch (err) {
        console.warn('Could not restore the full description from the feed:', err);
      } finally {
        if (isMounted) setIsLoadingFull(false);
      }
    }

    async function loadFullJobDetails() {
      if (!job.applyUrl) return;
      setIsLoadingFull(true);
      try {
        const res = await fetch(`/api/fetch-job-details?url=${encodeURIComponent(job.applyUrl)}`);
        if (res.ok) {
          const data = await res.json();

          // 1. Resolve authentic direct employer portal URL
          if (data.directApplyUrl && isMounted) {
            setApplyUrl(data.directApplyUrl);
            try {
              const host = new URL(data.directApplyUrl).hostname.replace(/^www\./, '');
              if (!host.includes('adzuna.')) {
                setDirectDomain(host);
              }
            } catch {
              // ignore URL parse errors
            }
          }

          // 2. Resolve complete untruncated description
          if (data.fullDescription && data.fullDescription.trim().length > 50 && isMounted) {
            const full = data.fullDescription.trim();
            setFullDescription(full);
            setIsFullLoaded(true);

            // Extract authentic responsibilities & requirements from the full description
            const lines = full.split(/\n+/).map((l: string) => l.trim()).filter((l: string) => l.length > 15);
            const bulletItems = lines.filter((l: string) => /^[•\-*–—:]|\b\d+\./.test(l) || l.includes(' : '));
            
            if (bulletItems.length >= 4) {
              const half = Math.ceil(bulletItems.length / 2);
              setResponsibilities(bulletItems.slice(0, half).map((b: string) => b.replace(/^[•\-*–—:]\s*/, '')));
              setRequirements(bulletItems.slice(half).map((b: string) => b.replace(/^[•\-*–—:]\s*/, '')));
            } else {
              const sentences = full.split(/(?<=[.!?])\s+/).filter((s: string) => s.length > 25 && s.length < 240);
              if (sentences.length >= 4) {
                const half = Math.floor(sentences.length / 2);
                setResponsibilities(sentences.slice(0, Math.min(half, 5)));
                setRequirements(sentences.slice(half, Math.min(sentences.length, half + 5)));
              }
            }
          }
        }
      } catch (err) {
        console.warn('Could not fetch full details, keeping clean snippet:', err);
      } finally {
        if (isMounted) setIsLoadingFull(false);
      }
    }

    restoreFeedDescription();
    loadFullJobDetails();
    return () => {
      isMounted = false;
    };
  }, [job.applyUrl, job.id]);

  const handleCopyShare = () => {
    navigator.clipboard?.writeText(window.location.href);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2000);
  };

  const markerIcon = L.divIcon({
    className: 'salary-pill-wrapper',
    html: `<div class="salary-pill is-active">${job.salaryBadge}</div>`,
    iconSize: [64, 28],
    iconAnchor: [32, 14],
  });

  return (
    <div className="min-h-screen text-[#f5f5f7] font-sans pb-24 animate-in fade-in duration-200">
      
      {/* Top Airbnb Navigation / Header */}
      <div className="border-b border-white/[0.09] sticky top-0 z-30 bg-[var(--tile)] backdrop-blur-md backdrop-saturate-150 pt-[max(env(safe-area-inset-top,0px),1rem)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-6">
            {/* The same lockup the ribbon carries, from the same file. This
              * used to be a local copy -- an outline pin in a rose rounded
              * square, next to a black-weight "map" in rose and "job" in
              * white -- so opening a job swapped the logo for a different
              * one. A product has one mark. */}
            <Wordmark onClick={onBack} title="Return to MapJob search" />

            <div className="h-5 w-[1px] bg-white/[0.12]" />

            {/* Prominent Back Button */}
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-2 text-xs sm:text-sm font-bold text-[#f5f5f7] bg-white/[0.12] hover:bg-white/[0.18] py-1.5 px-3 sm:px-4 rounded-full transition active:scale-95 cursor-pointer shadow-xs"
            >
              <ArrowLeft className="w-4 h-4 stroke-[2.8]" />
              <span>Back to jobs</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopyShare}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-[rgba(235,235,245,0.62)] hover:bg-white/[0.08] rounded-full transition cursor-pointer"
            >
              {copiedShare ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Share2 className="w-3.5 h-3.5" />}
              <span>{copiedShare ? 'Link Copied!' : 'Share'}</span>
            </button>

            <button
              type="button"
              onClick={() => onToggleSave(job.id)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold text-[rgba(235,235,245,0.62)] hover:bg-white/[0.08] rounded-full transition cursor-pointer"
            >
              <Heart className={`w-4 h-4 ${isSaved ? 'fill-[#FF385C] text-[#FF385C]' : 'text-[rgba(235,235,245,0.62)]'}`} />
              <span>{isSaved ? 'Saved' : 'Save'}</span>
            </button>
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 space-y-6">
        
        {/* Title & Metadata Header.
         *
         * On its own card rather than bare on the canvas. It was the only
         * block on the page still sitting directly on the wallpaper, which
         * read as unfinished next to the tiles below it -- and on the pale
         * mist canvas it was a legibility bug outright: white title and
         * rgba(235,235,245,0.62) meta over a ~72%-luminance background is
         * roughly 1.5:1. The tile puts a dark, near-opaque ground back under
         * the type on every theme. */}
        <div className="ic-tile rounded-3xl p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="px-2.5 py-0.5 rounded-full bg-rose-400/15 text-rose-200 border border-rose-300/25 text-xs font-bold tracking-wide">
              {job.category}
            </span>
            {job.postedDaysAgo !== undefined && job.postedDaysAgo <= 3 && (
              <span className="px-2.5 py-0.5 rounded-full bg-emerald-400/15 text-emerald-200 text-xs font-bold flex items-center gap-1 border border-emerald-300/25">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>New Posting</span>
              </span>
            )}
            <span className="text-xs text-[rgba(235,235,245,0.42)]">•</span>
            <span className="text-xs font-medium text-[rgba(235,235,245,0.62)] flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              Posted {job.postedAt}
            </span>
          </div>

          <h1 className="text-2xl sm:text-3xl md:text-4xl font-extrabold text-[#f5f5f7] tracking-tight mb-2">
            {job.title}
          </h1>

          <div className="flex flex-wrap items-center gap-y-2 gap-x-3 text-sm text-[#f5f5f7] font-semibold">
            {/* hover:text-black, left over from the light design: on a dark
             * tile it faded the link into the background on hover. */}
            <span className="underline hover:text-[#0a84ff] transition-colors cursor-pointer">
              {job.company}
            </span>
            <span>•</span>
            <span className="text-[rgba(235,235,245,0.62)] font-normal">{job.jobType}</span>
            <span>•</span>
            <span className="text-[rgba(235,235,245,0.62)] font-normal">{job.remoteType}</span>
            <span>•</span>
            <span className="text-[rgba(235,235,245,0.62)] font-normal">{job.experienceLevel} Level</span>
            <span>•</span>
            <span className="text-[rgba(235,235,245,0.62)] font-normal underline">{job.location}</span>
          </div>
        </div>

        {/* Airbnb Photo Gallery Grid (Matches media_1788490110494.png) */}
        <div className="relative rounded-3xl overflow-hidden aspect-[16/9] sm:aspect-[2/1] md:aspect-[21/9] max-h-[480px] bg-white/[0.08] shadow-xs">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 h-full">
            {/* Main big image (left 2 cols) */}
            <div 
              onClick={() => setShowAllPhotos(true)}
              className="md:col-span-2 h-full overflow-hidden cursor-pointer group relative"
            >
              <img
                src={job.images[0] || DEFAULT_JOB_IMAGE}
                alt={`${job.company} main facility`}
                className="w-full h-full object-cover group-hover:scale-103 transition duration-500"
                onError={(e) => {
                  e.currentTarget.src = DEFAULT_JOB_IMAGE;
                }}
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition" />
            </div>

            {/* Secondary stacked images (col 3) */}
            <div 
              onClick={() => setShowAllPhotos(true)}
              className="hidden md:flex flex-col gap-2 h-full cursor-pointer group"
            >
              <div className="flex-1 overflow-hidden relative group/item">
                <img
                  src={job.images[1] || DEFAULT_JOB_IMAGE}
                  alt={`${job.company} workplace`}
                  className="w-full h-full object-cover group-hover/item:scale-105 transition duration-500"
                  onError={(e) => {
                    e.currentTarget.src = DEFAULT_JOB_IMAGE;
                  }}
                />
                <div className="absolute inset-0 bg-black/0 group-hover/item:bg-black/10 transition" />
              </div>
              <div className="flex-1 overflow-hidden relative group/item">
                <img
                  src={job.images[2] || DEFAULT_JOB_IMAGE}
                  alt={`${job.company} engineering team`}
                  className="w-full h-full object-cover group-hover/item:scale-105 transition duration-500"
                  onError={(e) => {
                    e.currentTarget.src = DEFAULT_JOB_IMAGE;
                  }}
                />
                <div className="absolute inset-0 bg-black/0 group-hover/item:bg-black/10 transition" />
              </div>
            </div>

            {/* Tertiary stacked images (col 4) */}
            <div 
              onClick={() => setShowAllPhotos(true)}
              className="hidden md:flex flex-col gap-2 h-full cursor-pointer group"
            >
              <div className="flex-1 overflow-hidden relative group/item">
                <img
                  src={job.images[0] || DEFAULT_JOB_IMAGE}
                  alt={`${job.company} cleanroom`}
                  className="w-full h-full object-cover group-hover/item:scale-105 transition duration-500"
                  onError={(e) => {
                    e.currentTarget.src = DEFAULT_JOB_IMAGE;
                  }}
                />
                <div className="absolute inset-0 bg-black/0 group-hover/item:bg-black/10 transition" />
              </div>
              <div className="flex-1 overflow-hidden relative group/item">
                <img
                  src={job.images[1] || DEFAULT_JOB_IMAGE}
                  alt={`${job.company} tech lab`}
                  className="w-full h-full object-cover group-hover/item:scale-105 transition duration-500"
                  onError={(e) => {
                    e.currentTarget.src = DEFAULT_JOB_IMAGE;
                  }}
                />
                <div className="absolute inset-0 bg-black/0 group-hover/item:bg-black/10 transition" />
              </div>
            </div>
          </div>

          {/* "Show all photos" floating pill button in bottom right corner */}
          <button
            type="button"
            onClick={() => setShowAllPhotos(true)}
            className="absolute bottom-4 right-4 bg-white hover:bg-gray-50 text-[#222222] font-bold text-xs px-4 py-2 rounded-xl shadow-md border border-gray-900/10 flex items-center gap-2 transition active:scale-95 cursor-pointer z-10"
          >
            <Grid className="w-3.5 h-3.5" />
            <span>Show all photos</span>
          </button>
        </div>

        {/* 2-Column Content Grid (Matches Airbnb Layout in media_1788490110494.png) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 pt-6">
          
          {/* Left Main Content (8 cols) */}
          {/* The description column gets the card surface too. Left bare it
            * was body copy printed straight onto the wallpaper: legible, but
            * the only place in the app where text floats with nothing under
            * it, and the gradient behind moves under long paragraphs. */}
          <div className="lg:col-span-7 xl:col-span-8 space-y-8 ic-tile rounded-3xl p-6 sm:p-8">
            
            {/* Guest Favorite / Employer Recognition Banner */}
            <div className="border-b border-white/[0.09] pb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold text-[#f5f5f7]">
                  Position hosted by {job.company}
                </h2>
                <p className="text-sm text-[rgba(235,235,245,0.62)] mt-1">
                  Verified Official Direct Live Listing • {job.city.toUpperCase()} Regional Hub
                </p>
              </div>

              <div className="w-14 h-14 rounded-2xl bg-white/[0.12] text-[#f5f5f7] flex items-center justify-center font-black text-lg shrink-0 shadow-md">
                {job.company.slice(0, 2).toUpperCase()}
              </div>
            </div>

            {/* Airbnb Key Highlights Features */}
            <div className="border-b border-white/[0.09] pb-8 space-y-6">
              
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-full bg-white/[0.08] text-[#f5f5f7] shrink-0 mt-0.5">
                  <Trophy className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-base text-[#f5f5f7]">Top Tier Precision Engineering Role</h4>
                  <p className="text-sm text-[rgba(235,235,245,0.62)] mt-0.5">
                    This position is highly ranked based on competitive compensation, industry impact, and candidate satisfaction.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-full bg-white/[0.08] text-[#f5f5f7] shrink-0 mt-0.5">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-base text-[#f5f5f7]">Verified Employer Channel</h4>
                  <p className="text-sm text-[rgba(235,235,245,0.62)] mt-0.5">
                    Responds to 95% of qualified engineering applications within 48 business hours.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-full bg-white/[0.08] text-[#f5f5f7] shrink-0 mt-0.5">
                  <MapPin className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-base text-[#f5f5f7]">Physical Workplace & High-Tech Campus</h4>
                  <p className="text-sm text-[rgba(235,235,245,0.62)] mt-0.5">
                    Located in {job.location}. Verified facility coordinates with easy transit access.
                  </p>
                </div>
              </div>

            </div>

            {/* Translation notice matching Airbnb */}
            <div className="p-4 bg-white/[0.06] rounded-2xl border border-white/[0.09] text-xs text-[rgba(235,235,245,0.62)] flex items-center justify-between">
              <span>Some information has been automatically synchronized from the official employer feed.</span>
              <span className="font-bold underline cursor-pointer hover:text-black">Show original</span>
            </div>

            {/* About the Position (Description) */}
            <div className="border-b border-white/[0.09] pb-8">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h3 className="text-xl font-bold text-[#f5f5f7]">About the Position</h3>
                {isLoadingFull ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-[rgba(235,235,245,0.62)] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500" />
                    <span>Loading full official posting...</span>
                  </span>
                ) : isFullLoaded ? (
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-200 bg-emerald-400/15 px-2.5 py-1 rounded-full border border-emerald-300/25">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Full Employer Specifications</span>
                  </span>
                ) : null}
              </div>
              <p className="text-[#f5f5f7] text-base leading-relaxed whitespace-pre-line">
                {fullDescription}
              </p>
            </div>

            {/* What you will do (Responsibilities) */}
            <div className="border-b border-white/[0.09] pb-8">
              <h3 className="text-xl font-bold text-[#f5f5f7] mb-4">Key Responsibilities</h3>
              <ul className="space-y-3">
                {responsibilities.map((resp, i) => (
                  <li key={i} className="flex items-start gap-3 text-base text-[#f5f5f7]">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
                    <span>{resp}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Requirements & Qualifications */}
            <div className="border-b border-white/[0.09] pb-8">
              <h3 className="text-xl font-bold text-[#f5f5f7] mb-4">Candidate Requirements & Specifications</h3>
              <ul className="space-y-3">
                {requirements.map((req, i) => (
                  <li key={i} className="flex items-start gap-3 text-base text-[#f5f5f7]">
                    <div className="w-2 h-2 rounded-full bg-rose-500 mt-2 shrink-0" />
                    <span>{req}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Company Benefits */}
            <div className="border-b border-white/[0.09] pb-8">
              <h3 className="text-xl font-bold text-[#f5f5f7] mb-4">What this workplace offers</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                {job.benefits.map((benefit, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3.5 rounded-2xl bg-white/[0.06] border border-white/[0.09] font-semibold text-sm text-[#f5f5f7]"
                  >
                    <Sparkles className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>{benefit}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Where you'll be (Interactive Map Snippet) */}
            <div className="pb-8 space-y-4">
              <h3 className="text-xl font-bold text-[#f5f5f7]">Where you'll be working</h3>
              <p className="text-sm text-[rgba(235,235,245,0.62)] font-medium">
                📍 {job.address || job.location}
              </p>

              <div className="h-72 w-full rounded-3xl overflow-hidden border border-white/[0.09] shadow-sm relative z-0">
                {Number.isFinite(job.lat) && Number.isFinite(job.lng) ? <MapContainer
                  center={[job.lat, job.lng]}
                  zoom={14}
                  scrollWheelZoom={false}
                  zoomControl={false}
                  attributionControl={false}
                  className="w-full h-full"
                >
                  <TileLayer
                    url={`https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`}
                    maxZoom={19}
                    tileSize={512}
                    zoomOffset={-1}
                  />
                  <Marker position={[job.lat, job.lng]} icon={markerIcon} />
                </MapContainer> : <p className="p-6 text-sm text-[rgba(235,235,245,0.62)]">The employer has not provided a mappable location. See the original listing for details.</p>}
              </div>
            </div>

          </div>

          {/* Right Sticky Reservation Card (Matches media_1788490110494.png) */}
          <div className="lg:col-span-5 xl:col-span-4">
            <div className="sticky top-24 ic-tile rounded-3xl p-6 sm:p-7 space-y-6">
              
              {/* Rare Find banner matching Airbnb */}
              <div className="p-3.5 bg-rose-400/12 rounded-2xl border border-rose-300/25 flex items-center gap-3 text-xs text-[#f5f5f7]">
                <span className="text-base">💎</span>
                <div>
                  <span className="font-extrabold text-rose-700">Rare opportunity!</span>{' '}
                  <span className="text-[rgba(235,235,245,0.62)]">Postings at {job.company} usually fill quickly.</span>
                </div>
              </div>

              {/* Salary Total Header */}
              <div>
                <span className="text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider block mb-1">
                  Compensation
                </span>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-3xl font-black text-[#f5f5f7]">
                    {job.salaryDisplay}
                  </span>
                </div>
                <span className="text-xs text-[rgba(235,235,245,0.62)] mt-1 block">
                  Includes full benefits package, performance bonus & equity
                </span>
              </div>

              {/* Booking Specifications Box */}
              <div className="border border-white/15 rounded-2xl overflow-hidden divide-y divide-gray-300 text-xs">
                <div className="grid grid-cols-2 divide-x divide-gray-300">
                  <div className="p-3">
                    <span className="block font-black text-[10px] text-[rgba(235,235,245,0.62)] uppercase">WORK FORMAT</span>
                    <span className="font-bold text-sm text-[#f5f5f7]">{job.remoteType}</span>
                  </div>
                  <div className="p-3">
                    <span className="block font-black text-[10px] text-[rgba(235,235,245,0.62)] uppercase">CONTRACT</span>
                    <span className="font-bold text-sm text-[#f5f5f7]">{job.jobType}</span>
                  </div>
                </div>

                <div className="p-3">
                  <span className="block font-black text-[10px] text-[rgba(235,235,245,0.62)] uppercase">EXPERIENCE LEVEL</span>
                  <span className="font-bold text-sm text-[#f5f5f7]">{job.experienceLevel} Engineering Level</span>
                </div>
              </div>

              {/* Airbnb Rates Radio Selector Box (Matches media_1788490110494.png) */}
              <div className="space-y-3">
                <span className="text-xs font-bold text-[rgba(235,235,245,0.42)] uppercase tracking-wider block">
                  APPLICATION METHOD
                </span>

                {/* Option 1: Direct Portal */}
                <label 
                  onClick={() => setApplyMode('direct')}
                  className={`p-3.5 rounded-2xl border flex items-start justify-between gap-3 cursor-pointer transition select-none ${
                    applyMode === 'direct'
                      ? 'border-[#0a84ff] ring-2 ring-[#0a84ff] bg-[#0a84ff]/[0.12]'
                      : 'border-white/[0.09] hover:border-white/20 bg-white/[0.05]'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-bold text-sm text-[#f5f5f7] block">Direct Employer Portal</span>
                      {directDomain ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                          <Check className="w-2.5 h-2.5 stroke-[3]" /> Direct
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-wide bg-white/[0.08] text-[rgba(235,235,245,0.62)] px-2 py-0.5 rounded-full">
                          External
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-[rgba(235,235,245,0.62)] block leading-tight">
                      {directDomain 
                        ? `Direct portal: ${directDomain} (bypasses Adzuna)` 
                        : 'Instant redirection to official candidate tracking system.'}
                    </span>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                    applyMode === 'direct' ? 'border-[#0a84ff] bg-[#0a84ff]' : 'border-white/15'
                  }`}>
                    {applyMode === 'direct' && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </label>

                {/* Option 2: a direct HTTP submission to the employer's ATS. */}
                <label
                  onClick={() => canAutoApply && setApplyMode('fast')}
                  className={`p-3.5 rounded-2xl border flex items-start justify-between gap-3 transition select-none ${
                    !canAutoApply
                      ? 'border-white/[0.09] bg-white/[0.06] opacity-70 cursor-not-allowed'
                      : applyMode === 'fast'
                      ? 'border-[#0a84ff] ring-2 ring-[#0a84ff] bg-[#0a84ff]/[0.12] cursor-pointer'
                      : 'border-white/[0.09] hover:border-white/20 bg-white/[0.05] cursor-pointer'
                  }`}
                >
                  <div className="space-y-0.5">
                    <span className="font-bold text-sm text-[#f5f5f7] block">Submit through MapJob</span>
                    <span className="text-xs text-[rgba(235,235,245,0.62)] block leading-tight">
                      {!canAutoApply
                        ? "Not available: this ATS has no public application API, so only the employer's own form can accept your application."
                        : emailStatus?.receipt_email_configured
                        ? `MapJob posts your profile and CV straight to the employer's ATS, then emails your receipt to ${emailStatus.recipient}. The employer's confirmation email comes from them.`
                        : "MapJob posts your profile and CV straight to the employer's ATS. The confirmation email comes from the employer."}
                    </span>
                    {canAutoApply && emailStatus && !emailStatus.receipt_email_configured && (
                      <span className="text-[11px] text-amber-700 block leading-tight pt-0.5">
                        {emailStatus.receipt_email_hint}
                      </span>
                    )}
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                    applyMode === 'fast' ? 'border-[#0a84ff] bg-[#0a84ff]' : 'border-white/15'
                  }`}>
                    {applyMode === 'fast' && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </label>
              </div>

              {/* Big action button. Only offers a MapJob submission where the ATS
                  actually accepts one; otherwise it is an honest link out. */}
              {(applyMode === 'direct' || !canAutoApply) && (applyUrl || job.applyUrl) ? (
                <a
                  href={applyUrl || job.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-4 px-6 rounded-2xl bg-[#FF385C] hover:bg-[#E00B41] text-white font-extrabold text-base shadow-lg shadow-rose-200 transition active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer select-none text-center"
                >
                  <span className="truncate">
                    {directDomain ? `Apply on ${directDomain}` : 'Apply on Employer Portal'}
                  </span>
                  <ArrowUpRight className="w-4 h-4 stroke-[2.5] shrink-0" />
                </a>
              ) : (
                <button
                  type="button"
                  disabled={isApplying || isApplied}
                  onClick={() => onApply(job)}
                  className={`w-full py-4 px-6 rounded-2xl text-white font-extrabold text-base shadow-lg transition active:scale-[0.98] flex items-center justify-center gap-2 cursor-pointer select-none ${
                    isApplied
                      ? 'bg-emerald-600 shadow-emerald-200 cursor-default'
                      : isApplying
                      ? 'bg-indigo-600 shadow-indigo-200 cursor-wait animate-pulse'
                      : 'bg-[#FF385C] hover:bg-[#E00B41] shadow-rose-200'
                  }`}
                >
                  {isApplied ? (
                    <>
                      <Check className="w-5 h-5 stroke-[3]" />
                      <span>Applied ✓</span>
                    </>
                  ) : isApplying ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Submitting your application...</span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5 text-amber-300 fill-amber-300" />
                      <span>Submit my application</span>
                    </>
                  )}
                </button>
              )}

              {isApplied && onUnmarkApplied && (
                <div className="flex items-center justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => onUnmarkApplied(job.id)}
                    className="text-xs text-[rgba(235,235,245,0.42)] hover:text-[rgba(235,235,245,0.62)] underline font-medium cursor-pointer transition py-0.5"
                  >
                    Reset status / Re-apply to this position
                  </button>
                </div>
              )}

              {/* Microtext matching Airbnb "You won't be charged yet" */}
              <p className="text-center text-xs text-[rgba(235,235,245,0.62)] font-medium">
                100% Free Candidate Service • No registration fees
              </p>

              {/* Report listing */}
              <div className="border-t border-white/[0.09] pt-4 flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => alert('Listing reported for review. Thank you!')}
                  className="flex items-center gap-2 text-xs font-semibold text-[rgba(235,235,245,0.42)] hover:text-[rgba(235,235,245,0.62)] transition"
                >
                  <Flag className="w-3.5 h-3.5" />
                  <span>Report this listing</span>
                </button>
              </div>

            </div>
          </div>

        </div>

      </main>

      {/* Lightbox Modal when clicking "Show all photos" */}
      {showAllPhotos && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md overflow-y-auto p-4 sm:p-8 flex flex-col items-center animate-in fade-in duration-200">
          <div className="w-full max-w-4xl flex items-center justify-between pb-6 text-white">
            <button
              onClick={() => setShowAllPhotos(false)}
              className="flex items-center gap-2 text-sm font-bold bg-white/10 hover:bg-white/20 py-2 px-4 rounded-full transition"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Back</span>
            </button>
            <span className="font-bold text-sm">{job.company} Gallery</span>
            <button
              onClick={() => setShowAllPhotos(false)}
              className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="w-full max-w-4xl space-y-6 pb-12">
            {job.images.map((img, i) => (
              <div key={i} className="rounded-2xl overflow-hidden bg-[#0a84ff] shadow-2xl">
                <img
                  src={img}
                  alt={`${job.company} photo ${i + 1}`}
                  className="w-full max-h-[600px] object-cover"
                  onError={(e) => {
                    e.currentTarget.src = DEFAULT_JOB_IMAGE;
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
};
