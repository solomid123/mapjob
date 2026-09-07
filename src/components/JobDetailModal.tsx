import React, { useState } from 'react';
import { 
  X, 
  Heart, 
  Share2, 
  MapPin, 
  ShieldCheck, 
  Clock, 
  CheckCircle2, 
  Sparkles, 
  Building2, 
  Check,
  ArrowUpRight
} from 'lucide-react';
import type { Job } from '../types/job';

interface JobDetailModalProps {
  job: Job | null;
  isOpen: boolean;
  onClose: () => void;
  onApply: (job: Job) => void;
  isSaved: boolean;
  onToggleSave: (id: string) => void;
}

export const JobDetailModal: React.FC<JobDetailModalProps> = ({
  job,
  isOpen,
  onClose,
  onApply,
  isSaved,
  onToggleSave,
}) => {
  const [copiedShare, setCopiedShare] = useState(false);

  if (!isOpen || !job) return null;

  const handleCopyShare = () => {
    navigator.clipboard?.writeText(window.location.href);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 md:p-6 animate-in fade-in duration-200">
      
      {/* Modal Card */}
      <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border border-gray-100">
        
        {/* Sticky Header Bar */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-md px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-full transition"
              title="Close modal"
            >
              <X className="w-5 h-5" />
            </button>
            <span className="text-sm font-semibold text-gray-400 truncate max-w-[240px] sm:max-w-md">
              {job.company} • {job.title}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyShare}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 rounded-full transition"
            >
              {copiedShare ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Share2 className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{copiedShare ? 'Copied!' : 'Share'}</span>
            </button>

            <button
              onClick={() => onToggleSave(job.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-100 rounded-full transition"
            >
              <Heart className={`w-3.5 h-3.5 ${isSaved ? 'fill-rose-500 text-rose-500' : 'text-gray-700'}`} />
              <span className="hidden sm:inline">{isSaved ? 'Saved' : 'Save'}</span>
            </button>
          </div>
        </div>

        {/* Scrollable Modal Body */}
        <div className="overflow-y-auto p-6 md:p-8 space-y-8">
          
          {/* Header info */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2.5 py-0.5 rounded-full bg-rose-50 text-rose-600 text-xs font-bold tracking-wide">
                {job.category}
              </span>
              <span className="text-xs font-semibold text-gray-400">•</span>
              <span className="text-xs font-medium text-gray-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Posted {job.postedAt}
              </span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-extrabold text-gray-900 tracking-tight mb-2">
              {job.title}
            </h1>

            <div className="flex flex-wrap items-center gap-y-2 gap-x-4 text-sm font-medium text-gray-600">
              <div className="flex items-center gap-1.5 font-bold text-gray-900">
                <Building2 className="w-4 h-4 text-rose-500" />
                {job.company}
              </div>

              <span>•</span>
              <div className="flex items-center gap-1 text-gray-600">
                <MapPin className="w-4 h-4 text-gray-400" />
                {job.location}
              </div>
            </div>
          </div>

          {/* Airbnb-style Photo Gallery Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-2xl overflow-hidden aspect-[16/9] max-h-[360px]">
            <div className="md:col-span-2 h-full bg-gray-100 overflow-hidden">
              <img
                src={job.images[0]}
                alt={`${job.company} main office`}
                className="w-full h-full object-cover hover:scale-105 transition duration-300 cursor-pointer"
              />
            </div>
            <div className="hidden md:flex flex-col gap-3 h-full">
              {job.images.slice(1, 3).map((img, idx) => (
                <div key={idx} className="flex-1 bg-gray-100 overflow-hidden">
                  <img
                    src={img}
                    alt={`${job.company} workspace`}
                    className="w-full h-full object-cover hover:scale-105 transition duration-300 cursor-pointer"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Main Content & Sticky Application Widget */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            
            {/* Left 2 Columns: Detailed Information */}
            <div className="lg:col-span-2 space-y-8">
              
              {/* Highlights & Badges */}
              <div className="p-4 bg-gray-50 rounded-2xl border border-gray-100 grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div>
                  <span className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider">Format</span>
                  <span className="text-sm font-extrabold text-gray-900">{job.remoteType}</span>
                </div>
                <div>
                  <span className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider">Contract</span>
                  <span className="text-sm font-extrabold text-gray-900">{job.jobType}</span>
                </div>
                <div>
                  <span className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider">Seniority</span>
                  <span className="text-sm font-extrabold text-gray-900">{job.experienceLevel} Level</span>
                </div>
                <div>
                  <span className="block text-[11px] font-bold text-gray-400 uppercase tracking-wider">Visa</span>
                  <span className="text-sm font-extrabold text-gray-900">
                    {job.visaSponsorship ? 'Supported' : 'No Visa'}
                  </span>
                </div>
              </div>

              {/* Verified Physical Location & Facility */}
              <div className="p-4 bg-emerald-50/60 rounded-2xl border border-emerald-100/80 flex items-start gap-3.5">
                <div className="p-2 rounded-xl bg-emerald-100 text-emerald-700 shrink-0 mt-0.5">
                  <MapPin className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xs font-bold text-emerald-800 uppercase tracking-wider mb-0.5">
                    Physical Workplace & Facility Address
                  </div>
                  <div className="text-sm font-bold text-gray-900">
                    {job.location}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Verified building or technology campus coordinates in {job.city.toUpperCase()}
                  </div>
                </div>
              </div>

              {/* About the Position */}
              <div>
                <h3 className="text-lg font-bold text-gray-900 mb-3">About the Position</h3>
                <p className="text-gray-700 leading-relaxed text-sm sm:text-base">
                  {job.description}
                </p>
              </div>

              {/* Key Responsibilities */}
              <div>
                <h3 className="text-lg font-bold text-gray-900 mb-3">What You Will Do</h3>
                <ul className="space-y-2.5">
                  {job.responsibilities.map((resp, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-gray-700">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                      <span>{resp}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Requirements */}
              <div>
                <h3 className="text-lg font-bold text-gray-900 mb-3">Requirements & Qualifications</h3>
                <ul className="space-y-2.5">
                  {job.requirements.map((req, i) => (
                    <li key={i} className="flex items-start gap-3 text-sm text-gray-700">
                      <div className="w-1.5 h-1.5 rounded-full bg-rose-500 mt-2 flex-shrink-0" />
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Benefits & Perks */}
              <div>
                <h3 className="text-lg font-bold text-gray-900 mb-3">Company Benefits & Perks</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {job.benefits.map((benefit, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 p-3 rounded-xl bg-gray-50 border border-gray-100 text-xs sm:text-sm font-semibold text-gray-800"
                    >
                      <Sparkles className="w-4 h-4 text-rose-500 flex-shrink-0" />
                      <span>{benefit}</span>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* Right Column: Airbnb Sticky Booking / Apply Card */}
            <div className="lg:col-span-1">
              <div className="sticky top-20 bg-white rounded-3xl p-6 border border-gray-200 shadow-xl space-y-5">
                
                {/* Salary display */}
                <div>
                  <span className="block text-xs font-bold text-gray-400 uppercase tracking-wider mb-1">
                    Offered Compensation
                  </span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-2xl sm:text-3xl font-black text-gray-900">
                      {job.salaryDisplay}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500 mt-0.5 block">
                    Full package including equity & health coverage
                  </span>
                </div>

                <div className="p-3 bg-rose-50/70 rounded-2xl border border-rose-100 text-xs font-medium text-rose-900 space-y-1">
                  <div className="flex items-center gap-1.5 font-bold text-rose-700">
                    <ShieldCheck className="w-4 h-4" />
                    Verified Employer
                  </div>
                  <p className="text-[11px] text-rose-800/80">
                    Responds to 95% of candidates within 48 business hours.
                  </p>
                </div>

                {/* Primary CTA Apply Button */}
                {job.applyUrl ? (
                  <div className="space-y-2">
                    <a
                      href={job.applyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-extrabold text-sm sm:text-base shadow-lg shadow-rose-200 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                    >
                      <span>Apply on Employer Portal</span>
                      <ArrowUpRight className="w-4 h-4" />
                    </a>
                    <button
                      onClick={() => onApply(job)}
                      className="w-full py-2 px-4 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-bold transition"
                    >
                      Quick 1-Click Fast Apply
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onApply(job)}
                    className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white font-extrabold text-base shadow-lg shadow-rose-200 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                  >
                    <span>Quick Apply Now</span>
                  </button>
                )}

                <div className="border-t border-gray-100 pt-4 space-y-2 text-xs text-gray-500">
                  <div className="flex justify-between">
                    <span>Application format</span>
                    <span className="font-semibold text-gray-800">1-Click Fast Resume</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Interview stages</span>
                    <span className="font-semibold text-gray-800">3 rounds (Async intro)</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Hiring timeline</span>
                    <span className="font-semibold text-gray-800">Immediate Start</span>
                  </div>
                </div>

              </div>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
};
