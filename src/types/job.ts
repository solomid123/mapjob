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
  locationPrecision?: 'exact' | 'city' | 'region' | 'unknown';
  /**
   * Where the map draws this pin, when that is not where the job is.
   *
   * A city-level listing has no address of its own, so it geocodes to the town
   * centre along with every other job in that town — forty of them on one pixel,
   * which no amount of zooming separates. The map offsets those by up to ~700m
   * so each gets a pin, and keeps the result here rather than overwriting
   * `lat`/`lng`: those stay as the feed published them, so nothing outside the
   * map can mistake a spread-out pin for a real address.
   *
   * Never set for a job with `locationPrecision: 'exact'`.
   */
  mapLat?: number;
  mapLng?: number;
  /**
   * Which feed this listing came from. 'adzuna' means an aggregator: the pin is
   * a town centroid rather than the employer's address, and the apply link is a
   * tracking redirect that has to be followed before a form exists.
   */
  source?: 'ats' | 'adzuna';
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
  /**
   * False when the feed only shipped a snippet. The full text is fetched from
   * /api/jobs/detail when the job is actually opened, which keeps the map feed
   * roughly 25x smaller than sending every description to every client.
   */
  hasFullDescription?: boolean;
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
