import React, { useState } from 'react';
import { Heart, ChevronLeft, ChevronRight, Zap, ArrowUpRight } from 'lucide-react';
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
      className="w-full h-full flex flex-col items-center justify-center gap-3 transition duration-500 group-hover:scale-105"
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 58% 46%), hsl(${(hue + 34) % 360} 62% 33%))`,
      }}
    >
      <div className="w-16 h-16 rounded-2xl bg-white/95 shadow-sm flex items-center justify-center">
        <span className="text-xl font-black tracking-tight" style={{ color: `hsl(${hue} 58% 34%)` }}>
          {initials}
        </span>
      </div>
      <span className="px-6 text-center text-white text-sm font-bold tracking-tight drop-shadow-sm line-clamp-2">
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
      className="group flex flex-col cursor-pointer transition select-none"
    >
      {/* Airbnb Photo Carousel Container - Aspect ratio ~20/19 (almost square like Airbnb) */}
      <div className={`relative aspect-[20/19] w-full rounded-2xl overflow-hidden bg-gray-100 mb-3 transition-all ${
        isHovered || isSelected ? 'ring-2 ring-black shadow-lg' : ''
      }`}>
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
          {/* Top Choice / Sector Badge */}
          {job.postedDaysAgo !== undefined && job.postedDaysAgo <= 3 ? (
            <span className="px-2.5 py-1 rounded-full bg-gray-900/90 backdrop-blur-md text-white text-[11px] font-bold shadow-md tracking-tight flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>New</span>
            </span>
          ) : (
            <span className="px-2.5 py-1 rounded-full bg-white/95 text-gray-900 text-[11px] font-bold shadow-md tracking-tight">
              {job.category || 'Engineering'}
            </span>
          )}

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

      {/* Card Content & Details */}
      <div className="flex flex-col space-y-0.5">
        
        {/* Line 1: Title & Posted time */}
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="font-bold text-[15px] text-[#222222] truncate group-hover:underline">
            {job.title}
          </h3>
          <span className="text-[12px] font-semibold text-[#717171] shrink-0">
            {job.postedAt}
          </span>
        </div>

        {/* Line 2: Company & Location */}
        <p className="text-[14px] text-[#222222] font-semibold truncate">
          {job.company} <span className="text-[#717171] font-normal">• {job.location}</span>
        </p>

        {/* Line 3: Format & Seniority */}
        <p className="text-[13px] text-[#717171] truncate">
          {job.jobType} • {job.remoteType} {job.visaSponsorship ? '• Visa Support' : ''}
        </p>

        {/* Line 4: Salary, only when the employer actually published one. The
            slot keeps its height either way so the grid stays aligned. */}
        <div className="pt-1 flex items-baseline gap-1.5 min-h-[22px]">
          {job.salaryDisplay ? (
            <>
              <span className="text-[15px] font-bold text-[#222222]">{job.salaryDisplay}</span>
              <span className="text-[13px] text-[#717171] font-normal">/ year</span>
            </>
          ) : (
            <span className="text-[13px] text-[#717171]">Salary not published</span>
          )}
        </div>

        {/* Line 5: ATS platform badge & 1-Click Auto Apply button */}
        <div className="pt-2 flex items-center justify-between gap-1.5 border-t border-gray-100 mt-1">
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
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold shadow-xs transition active:scale-95 cursor-pointer bg-gray-900 hover:bg-black text-white"
              title="Fill this employer's form from your profile, then show you the result before anything is sent"
            >
              <Zap className="w-3 h-3 text-amber-400 fill-amber-400" />
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
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold shadow-xs transition active:scale-95 cursor-pointer bg-gray-900 hover:bg-black text-white"
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
