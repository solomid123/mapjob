export type JobType = 'Full-time' | 'Part-time' | 'Contract' | 'Internship';
export type RemoteType = 'On-site' | 'Hybrid' | 'Remote';

export interface Job {
  id: string;
  title: string;
  company: string;
  companyLogo: string;
  rating: number;
  reviewsCount: number;
  isSuperEmployer?: boolean;
  isFeatured?: boolean;
  category: string; // Engineering, Design, Product, Marketing, Sales, Operations, Healthcare
  location: string;
  address?: string;
  city: string;
  lat: number;
  lng: number;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string; // '$', '€', '£'
  salaryPeriod?: 'year' | 'month' | 'hour';
  salaryDisplay: string; // e.g. "€85k", "$120k - $140k"
  salaryBadge: string; // Short badge for the map pill: "€85k", "$130k"
  jobType: JobType;
  remoteType: RemoteType;
  experienceLevel: 'Entry' | 'Mid' | 'Senior' | 'Lead' | 'Executive';
  visaSponsorship: boolean;
  images: string[];
  description: string;
  responsibilities: string[];
  requirements: string[];
  benefits: string[];
  postedAt: string;
  postedDaysAgo?: number;
  applicantCount: number;
  applyUrl?: string;
  atsProvider?: AtsProvider;
  isDirectApply?: boolean;
  canApplyViaApi?: boolean;
  atsBoard?: string;
  jobId?: string;
}

export type AtsProvider = 
  | 'Workday' 
  | 'Greenhouse' 
  | 'Lever' 
  | 'SmartRecruiters' 
  | 'Ashby' 
  | 'Teamtailor'
  | 'Direct Portal'
  | 'Aggregator'
  | 'France Travail'
  | 'Apec'
  | 'HelloWork'
  | 'Meteojob'
  | 'Indeed'
  | 'LinkedIn'
  | 'Agency';

export function isDirectAts(provider?: AtsProvider): boolean {
  if (!provider) return false;
  return ['Workday', 'Greenhouse', 'Lever', 'SmartRecruiters', 'Ashby', 'Teamtailor', 'Direct Portal'].includes(provider);
}

export interface FilterState {
  searchQuery: string;
  city: string;
  category: string;
  jobType: string;
  remoteType: string;
  experienceLevel: string;
  minSalary: number;
  visaSponsorshipOnly: boolean;
  lastPosted: string; // 'all' | '24h' | '3d' | '7d' | '14d' | '30d'
}
