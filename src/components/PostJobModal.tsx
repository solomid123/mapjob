import React, { useState } from 'react';
import { X, Plus, MapPin, Sparkles } from 'lucide-react';
import type { Job, JobType, RemoteType } from '../types/job';
import { CITIES } from '../data/mockJobs';

interface PostJobModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddJob: (job: Job) => void;
  selectedCity: string;
}

export const PostJobModal: React.FC<PostJobModalProps> = ({
  isOpen,
  onClose,
  onAddJob,
  selectedCity,
}) => {
  const currentCity = CITIES.find((c) => c.id === selectedCity) || CITIES[0];

  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [category, setCategory] = useState('Engineering');
  const [jobType, setJobType] = useState<JobType>('Full-time');
  const [remoteType, setRemoteType] = useState<RemoteType>('Hybrid');
  const [location, setLocation] = useState(`${currentCity.name.split(',')[0]} Downtown`);
  const [salaryMin, setSalaryMin] = useState(120000);
  const [salaryMax, setSalaryMax] = useState(150000);
  const [visaSponsorship, setVisaSponsorship] = useState(true);
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState(
    'https://images.unsplash.com/photo-1497366216548-37526070297c?w=800&auto=format&fit=crop&q=80'
  );

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Slight random offset around city center so it pins cleanly
    const latOffset = (Math.random() - 0.5) * 0.08;
    const lngOffset = (Math.random() - 0.5) * 0.08;

    const minK = Math.round(salaryMin / 1000);
    const maxK = Math.round(salaryMax / 1000);

    const newJob: Job = {
      id: `job-${Date.now()}`,
      title,
      company,
      companyLogo: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=120&auto=format&fit=crop&q=80',
      rating: 5.0,
      reviewsCount: 1,
      isSuperEmployer: true,
      isFeatured: true,
      category,
      location,
      city: selectedCity,
      lat: currentCity.lat + latOffset,
      lng: currentCity.lng + lngOffset,
      salaryMin,
      salaryMax,
      salaryCurrency: '$',
      salaryPeriod: 'year',
      salaryDisplay: `$${minK}k - $${maxK}k / yr`,
      salaryBadge: `$${maxK}k`,
      jobType,
      remoteType,
      experienceLevel: 'Senior',
      visaSponsorship,
      images: [
        imageUrl,
        'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=80',
      ],
      description: description || 'Exciting career opportunity at an innovative and fast-growing company.',
      responsibilities: [
        'Drive critical technical roadmap initiatives and architecture execution',
        'Collaborate across product, engineering, and leadership teams',
        'Deliver reliable, scalable customer experiences',
      ],
      requirements: [
        'Demonstrated track record of delivering high-impact solutions',
        'Strong problem-solving and communication abilities',
      ],
      benefits: [
        'Comprehensive healthcare coverage',
        'Generous equity and 401(k) match',
        'Flexible working hours and remote stipend',
      ],
      postedAt: 'Just now',
      applicantCount: 0,
    };

    onAddJob(newJob);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="bg-white w-full max-w-xl rounded-3xl shadow-2xl overflow-hidden border border-gray-100 animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-rose-500" />
            <h3 className="font-extrabold text-gray-900 text-base">
              Post a New Job Offer on Map
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Job Title *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Senior Frontend Architect"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Company Name *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Apex Dynamics"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none transition"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-rose-500 outline-none"
              >
                <option value="Engineering">Engineering</option>
                <option value="Design">Design</option>
                <option value="Product">Product</option>
                <option value="Marketing">Marketing</option>
                <option value="Data">Data & AI</option>
                <option value="Healthcare">Healthcare</option>
                <option value="Finance">Finance</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Employment
              </label>
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value as JobType)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-rose-500 outline-none"
              >
                <option value="Full-time">Full-time</option>
                <option value="Part-time">Part-time</option>
                <option value="Contract">Contract</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Workplace
              </label>
              <select
                value={remoteType}
                onChange={(e) => setRemoteType(e.target.value as RemoteType)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs font-semibold focus:bg-white focus:border-rose-500 outline-none"
              >
                <option value="Remote">Remote</option>
                <option value="Hybrid">Hybrid</option>
                <option value="On-site">On-site</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
              Location / Neighborhood *
            </label>
            <div className="relative">
              <input
                type="text"
                required
                placeholder="e.g. Downtown Denver, CO"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                className="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none"
              />
              <MapPin className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              Position will automatically be pinned to the {currentCity.name} map.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Min Salary ($)
              </label>
              <input
                type="number"
                step="5000"
                value={salaryMin}
                onChange={(e) => setSalaryMin(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
                Max Salary ($)
              </label>
              <input
                type="number"
                step="5000"
                value={salaryMax}
                onChange={(e) => setSalaryMax(Number(e.target.value))}
                className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
              Office / Workspace Photo URL
            </label>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="w-full px-3.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs focus:bg-white focus:border-rose-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1">
              Role Description
            </label>
            <textarea
              rows={3}
              placeholder="Outline the mission, impact, and requirements for this role..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3.5 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:border-rose-500 outline-none resize-none"
            />
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={visaSponsorship}
                onChange={(e) => setVisaSponsorship(e.target.checked)}
                className="w-4 h-4 text-rose-500 rounded border-gray-300 focus:ring-rose-500"
              />
              <span className="text-xs font-semibold text-gray-700">
                Offer Visa Sponsorship / Relocation
              </span>
            </label>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              className="w-full py-3.5 px-6 rounded-2xl bg-gray-900 hover:bg-black text-white font-extrabold text-sm shadow-md transition flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              <span>Publish Job Pin to Map</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
