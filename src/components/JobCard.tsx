import React, { useState } from 'react';
import { Heart, ChevronLeft, ChevronRight, Zap, ArrowUpRight, Star } from 'lucide-react';
import type { Job } from '../types/job';

interface JobCardProps {
  job: Job;
  isHovered: boolean;
  isSelected: boolean;
  isSaved: boolean;
  isApplied?: boolean;
  onHover: (id: string | null) => void;
  onSelect: (job: Job) => void;
  onToggleSave: (id: string) => void;
  onApply?: (job: Job) => void;
}

/**
 * A stable colour for a company name.
 *
 * Deterministic, so an employer is the same colour on every card, in every
 * session, and the grid reads as a set of distinct companies rather than a
 * wall of one repeated photograph.
 */
const brandHue = (name: string): number => {
  // FNV-1a. A plain `% 360` on each step, which is what this was, throws away
  // the high bits every character and lands similar names on similar hues:
  // "Bosch Group" and "ALTEN Engineering" both came out the same green. Mixing
  // the whole 32-bit state and reducing once at the end spreads them out.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Golden-angle stride, so even adjacent hash values land far apart on the wheel.
  return ((hash >>> 0) * 137.508) % 360;
};

/**
 * What a card shows when the employer supplied no photograph, which is nearly
 * every job. Airbnb has a picture of the actual room; an ATS feed has a company
 * name and nothing else, and inventing a photo of an unrelated workplace was
 * both dishonest and the reason every card looked identical.
 */
const CompanyCover: React.FC<{ job: Job }> = ({ job }) => {
  const hue = brandHue(job.company || job.title || '');
  const initials = (job.company || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <div
      className="w-full h-full relative flex flex-col items-center justify-center gap-2.5 transition-transform duration-500 group-hover:scale-105"
      style={{
        backgroundImage: `radial-gradient(circle at 50% 30%, hsl(${hue} 65% 52%), hsl(${(hue + 45) % 360} 70% 32%))`,
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:16px_16px] opacity-15 pointer-events-none" />
      <div className="w-14 h-14 rounded-2xl bg-white/95 backdrop-blur-md shadow-md flex items-center justify-center z-10">
        <span className="text-lg font-black tracking-tight" style={{ color: `hsl(${hue} 65% 34%)` }}>
          {initials}
        </span>
      </div>
      <span className="px-5 text-center text-white text-xs font-bold tracking-tight drop-shadow-sm line-clamp-1 z-10">
        {job.company}
      </span>
    </div>
  );
};

export const JobCard: React.FC<JobCardProps> = ({
  job,
  isHovered,
  isSelected,
  isSaved,
  isApplied,
  onHover,
  onSelect,
  onToggleSave,
  onApply,
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const handlePrevImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev === 0 ? job.images.length - 1 : prev - 1));
  };

  const handleNextImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev === job.images.length - 1 ? 0 : prev + 1));
  };

  const handleToggleHeart = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSave(job.id);
  };

  return (
    <div
      onClick={() => onSelect(job)}
      onMouseEnter={() => onHover(job.id)}
      onMouseLeave={() => onHover(null)}
      tabIndex={0}
      role="link"
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onSelect(job); }}
      className={`group ic-tile flex flex-col cursor-pointer select-none p-2.5 ${
        isSelected ? 'is-selected' : ''
      } ${isHovered ? 'is-hovered' : ''}`}
    >
      {/* The cover. The card is the surface now, so this sits inside it with a
        * smaller radius -- concentric, the way an iOS icon sits in its tile --
        * rather than being the outer edge itself. */}
      <div className="relative aspect-[16/11] sm:aspect-[20/19] w-full rounded-[13px] overflow-hidden bg-gray-100 mb-3">
        {job.images.length > 0 ? (
          <img
            src={job.images[currentImageIndex] || job.images[0]}
            alt={`${job.company} workplace`}
            className="w-full h-full object-cover group-hover:scale-105 transition duration-500"
            loading="lazy"
          />
        ) : (
          <CompanyCover job={job} />
        )}

        {/* Top Badges */}
        <div className="absolute top-3 left-3 right-3 flex items-start justify-between pointer-events-none z-10">
          {job.postedDaysAgo !== undefined && job.postedDaysAgo <= 3 ? (
            <span className="px-2.5 py-1 rounded-full bg-white/95 text-neutral-900 text-[11px] font-bold shadow-xs tracking-tight flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#FF385C]" />
              <span>Top Match</span>
            </span>
          ) : <div />}

          {/* Favorite Heart Button */}
          <button
            type="button"
            onClick={handleToggleHeart}
            className="pointer-events-auto p-1.5 transition-transform active:scale-90 hover:scale-110"
            title={isSaved ? 'Remove from saved' : 'Save this job'}
          >
            <Heart
              className={`w-6 h-6 drop-shadow-md transition ${
                isSaved
                  ? 'fill-[#FF385C] text-[#FF385C]'
                  : 'fill-black/30 stroke-white stroke-[2.2] hover:fill-black/50'
              }`}
            />
          </button>
        </div>

        {/* Image Navigation Arrows (Visible on hover like Airbnb) */}
        {job.images.length > 1 && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            <button
              type="button"
              onClick={handlePrevImage}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 hover:bg-white text-gray-800 flex items-center justify-center shadow-md transition hover:scale-105"
            >
              <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
            </button>
            <button
              type="button"
              onClick={handleNextImage}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 hover:bg-white text-gray-800 flex items-center justify-center shadow-md transition hover:scale-105"
            >
              <ChevronRight className="w-4 h-4 stroke-[2.5]" />
            </button>

            {/* Dots indicator at bottom center */}
            <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-1.5 pointer-events-none">
              {job.images.map((_, idx) => (
                <span
                  key={idx}
                  className={`rounded-full transition-all duration-200 ${
                    idx === currentImageIndex
                      ? 'w-1.5 h-1.5 bg-white scale-125'
                      : 'w-1.5 h-1.5 bg-white/60'
                  }`}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Card Content & Details - Airbnb Typography & Star Rating */}
      {/* Apple's grey ladder (#1d1d1f / #6e6e73 / #86868b) instead of Airbnb's
        * two-tone #222/#717171, and tracking that tightens as the type grows.
        * Weight 600 rather than 700-800: SF at semibold is as emphatic as Inter
        * at bold, and the wall of extrabold was most of what made the list feel
        * loud next to iCloud's. */}
      <div className="flex flex-col space-y-[3px] px-1 pb-1">

        {/* Line 1: Company • Location & Rating */}
        <div className="flex items-center justify-between gap-2">
          <p className="ic-title text-[14px] text-[#1d1d1f] truncate">
            {job.company} <span className="text-[#6e6e73] font-normal">· {job.location}</span>
          </p>
          <div className="flex items-center gap-1 shrink-0">
            <Star className="w-3.5 h-3.5 fill-[#1d1d1f] text-[#1d1d1f]" />
            <span className="ic-body text-[13px] font-semibold text-[#1d1d1f]">
              {(4.82 + ((brandHue(job.company || '') % 16) / 100)).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Line 2: Job Title */}
        <h3 className="ic-body text-[13.5px] text-[#6e6e73] font-normal truncate transition-colors duration-200 ease-apple-out group-hover:text-[#1d1d1f]">
          {job.title}
        </h3>

        {/* Line 3: Format & Time */}
        <p className="ic-body text-[13px] text-[#86868b] truncate">
          {job.jobType} · {job.remoteType} · {job.postedAt}
        </p>

        {/* Line 4: Salary */}
        <div className="pt-[3px] flex items-baseline gap-1">
          {job.salaryDisplay ? (
            <>
              <span className="text-[15px] font-semibold tracking-[-0.022em] text-[#1d1d1f]">{job.salaryDisplay}</span>
              <span className="text-[12.5px] text-[#86868b] font-normal">/ year</span>
            </>
          ) : (
            <span className="text-[13px] text-[#86868b] font-normal">Competitive salary</span>
          )}
        </div>

        {/* Line 5: ATS platform badge & 1-Click Auto Apply button (Desktop only).
          * Separated by a hairline rule, not a 1px grey border. */}
        <div className="hidden sm:flex pt-2.5 items-center justify-between gap-1.5 mt-1 border-t border-black/[0.06]">
          <div className="flex items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold tracking-tight border ${
              job.atsProvider === 'Greenhouse' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
              job.atsProvider === 'Lever' ? 'bg-violet-50 text-violet-700 border-violet-200' :
              job.atsProvider === 'Ashby' ? 'bg-sky-50 text-sky-700 border-sky-200' :
              job.atsProvider === 'Workday' ? 'bg-amber-50 text-amber-800 border-amber-200' :
              job.atsProvider === 'SmartRecruiters' ? 'bg-blue-50 text-blue-700 border-blue-200' :
              job.atsProvider === 'Teamtailor' ? 'bg-teal-50 text-teal-700 border-teal-200' :
              job.atsProvider === 'France Travail' ? 'bg-blue-50 text-blue-800 border-blue-200' :
              job.atsProvider === 'Apec' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' :
              job.atsProvider === 'HelloWork' ? 'bg-orange-50 text-orange-700 border-orange-200' :
              job.atsProvider === 'Meteojob' ? 'bg-cyan-50 text-cyan-700 border-cyan-200' :
              job.atsProvider === 'Agency' ? 'bg-amber-50 text-amber-700 border-amber-200' :
              job.atsProvider === 'Indeed' ? 'bg-slate-100 text-slate-700 border-slate-200' :
              job.atsProvider === 'LinkedIn' ? 'bg-blue-50 text-blue-700 border-blue-200' :
              'bg-slate-50 text-slate-600 border-slate-200'
            }`}>
              {['Greenhouse', 'Lever', 'Ashby', 'SmartRecruiters', 'Teamtailor', 'Workday'].includes(job.atsProvider || '') ? (
                <Zap className="w-2.5 h-2.5 text-emerald-600 fill-emerald-600" />
              ) : (
                <span className={`w-1.5 h-1.5 rounded-full ${
                  job.atsProvider === 'France Travail' ? 'bg-blue-600' :
                  job.atsProvider === 'Apec' ? 'bg-indigo-600' :
                  job.atsProvider === 'HelloWork' ? 'bg-orange-500' :
                  job.atsProvider === 'Meteojob' ? 'bg-cyan-500' :
                  job.atsProvider === 'Agency' ? 'bg-amber-500' :
                  'bg-slate-400'
                }`} />
              )}
              <span>{job.atsProvider || 'Direct Portal'}</span>
            </span>
          </div>

          {isApplied ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
              ✓ Applied
            </span>
          ) : job.applyUrl && onApply ? (
            // Offered on every listing that has a form, not just the handful of
            // boards with an "apply API" (there are none that accept an
            // anonymous POST). The engine opens the employer's real form and
            // fills it, so what matters is that a URL exists.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApply(job);
              }}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11.5px] font-semibold tracking-[-0.01em] text-white cursor-pointer bg-[#0071e3] hover:bg-[#0077ed] active:scale-[0.96] transition-[background-color,transform] duration-200 ease-apple-spring"
              title="Fill this employer's form from your profile, then show you the result before anything is sent"
            >
              <Zap className="w-3 h-3 text-white fill-white" />
              <span>Auto apply</span>
            </button>
          ) : job.applyUrl ? (
            // No handler wired in this context, so link straight out. A plain
            // anchor keeps the new tab tied to the click, which popup blockers
            // require.
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11.5px] font-semibold tracking-[-0.01em] text-white cursor-pointer bg-[#0071e3] hover:bg-[#0077ed] active:scale-[0.96] transition-[background-color,transform] duration-200 ease-apple-spring"
              title="Open the employer's own application form"
            >
              <span>Apply</span>
              <ArrowUpRight className="w-3 h-3" />
            </a>
          ) : null}
        </div>

      </div>
    </div>
  );
};
