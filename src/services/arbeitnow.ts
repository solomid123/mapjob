import { isDirectAts, type Job } from '../types/job';
import { resolveJobLocation, detectAtsProvider } from './adzuna';

interface ArbeitnowItem {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

const CITY_COORDS: Record<string, { lat: number; lng: number; country: string }> = {
  berlin: { lat: 52.5200, lng: 13.4050, country: 'de' },
  munich: { lat: 48.1351, lng: 11.5820, country: 'de' },
  münchen: { lat: 48.1351, lng: 11.5820, country: 'de' },
  frankfurt: { lat: 50.1109, lng: 8.6821, country: 'de' },
  hamburg: { lat: 53.5511, lng: 9.9937, country: 'de' },
  stuttgart: { lat: 48.7758, lng: 9.1829, country: 'de' },
  cologne: { lat: 50.9375, lng: 6.9603, country: 'de' },
  köln: { lat: 50.9375, lng: 6.9603, country: 'de' },
  amsterdam: { lat: 52.3676, lng: 4.9041, country: 'nl' },
  rotterdam: { lat: 51.9244, lng: 4.4777, country: 'nl' },
  eindhoven: { lat: 51.4416, lng: 5.4697, country: 'nl' },
  utrecht: { lat: 52.0907, lng: 5.1214, country: 'nl' },
  brussels: { lat: 50.8503, lng: 4.3517, country: 'be' },
  bruxelles: { lat: 50.8503, lng: 4.3517, country: 'be' },
  gent: { lat: 51.0543, lng: 3.7174, country: 'be' },
  antwerpen: { lat: 51.2194, lng: 4.4025, country: 'be' },
  paris: { lat: 48.8566, lng: 2.3522, country: 'fr' },
  lyon: { lat: 45.7640, lng: 4.8357, country: 'fr' },
  toulouse: { lat: 43.6047, lng: 1.4442, country: 'fr' },
  luxembourg: { lat: 49.6116, lng: 6.1319, country: 'lu' },
  london: { lat: 51.5074, lng: -0.1278, country: 'gb' },
  madrid: { lat: 40.4168, lng: -3.7038, country: 'es' },
  barcelona: { lat: 41.3879, lng: 2.1699, country: 'es' },
  milan: { lat: 45.4642, lng: 9.1900, country: 'it' },
  milano: { lat: 45.4642, lng: 9.1900, country: 'it' },
  turin: { lat: 45.0703, lng: 7.6869, country: 'it' },
  torino: { lat: 45.0703, lng: 7.6869, country: 'it' },
};

function cleanHtml(str: string): string {
  if (!str) return '';
  return str.replace(/<\/?[^>]+(>|$)/g, '').trim();
}

let cachedArbeitnowJobs: Job[] | null = null;
let lastArbeitnowFetchTime = 0;

export async function fetchArbeitnowJobs(targetCity?: string): Promise<Job[]> {
  const now = Date.now();
  // Cache for 5 minutes
  if (cachedArbeitnowJobs && now - lastArbeitnowFetchTime < 5 * 60 * 1000) {
    if (targetCity) {
      const c = targetCity.toLowerCase();
      return cachedArbeitnowJobs.filter((j) => j.city.includes(c) || j.location.toLowerCase().includes(c));
    }
    return cachedArbeitnowJobs;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch('https://www.arbeitnow.com/api/job-board-api', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];

    const data = await res.json();
    const items: ArbeitnowItem[] = data.data || [];

    const jobs: Job[] = items.map((item, index) => {
      const locStr = item.location || 'Europe';
      const locKey = locStr.toLowerCase().split(/[,/ -]/)[0].trim();
      const coords = CITY_COORDS[locKey] || { lat: 50.8503, lng: 4.3517, country: 'eu' };

      const resolvedLoc = resolveJobLocation(
        item.company_name,
        item.title,
        item.slug,
        locKey,
        index,
        coords.lat,
        coords.lng
      );

      const daysAgo = Math.max(0, Math.floor((now / 1000 - item.created_at) / 86400));
      const textDesc = cleanHtml(item.description);

      return {
        id: `arbeitnow-${item.slug}`,
        title: item.title,
        company: item.company_name,
        companyLogo: `https://avatar.vercel.sh/${encodeURIComponent(item.company_name)}.svg?text=${item.company_name.slice(0, 2).toUpperCase()}`,
        rating: 0,
        reviewsCount: 0,
        isSuperEmployer: false,
        isFeatured: false,
        category: item.tags?.[0] || 'Engineering',
        location: `${item.location || 'Europe'} (Arbeitnow)`,
        address: resolvedLoc.address,
        city: locKey,
        lat: resolvedLoc.lat,
        lng: resolvedLoc.lng,
        salaryMin: 0,
        salaryMax: 0,
        salaryCurrency: '€',
        salaryPeriod: 'year',
        salaryDisplay: 'Salary on Application',
        salaryBadge: 'Apply',
        jobType: item.job_types?.includes('part_time') ? 'Part-time' : 'Full-time',
        remoteType: item.remote ? 'Remote' : 'On-site',
        experienceLevel: item.title.toLowerCase().includes('senior') ? 'Senior' : 'Mid',
        visaSponsorship: textDesc.toLowerCase().includes('visa') || textDesc.toLowerCase().includes('relocation'),
        images: [
          'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1000&auto=format&fit=crop&q=85',
          'https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=1000&auto=format&fit=crop&q=85',
          'https://images.unsplash.com/photo-1581091226825-a6a2a5aee158?w=1000&auto=format&fit=crop&q=85',
        ],
        description: textDesc.slice(0, 500) + '...',
        responsibilities: [textDesc.slice(0, 160) + '...'],
        requirements: ['Consult official employer posting for complete job requirements and specifications.'],
        benefits: ['Direct live listing via Arbeitnow network'],
        postedDaysAgo: daysAgo,
        postedAt: daysAgo === 0 ? 'Today' : `${daysAgo} days ago`,
        applicantCount: 0,
        applyUrl: item.url,
        atsProvider: detectAtsProvider(item.company_name, item.url, item.title),
        isDirectApply: isDirectAts(detectAtsProvider(item.company_name, item.url, item.title)),
      };
    });

    cachedArbeitnowJobs = jobs;
    lastArbeitnowFetchTime = now;

    if (targetCity) {
      const c = targetCity.toLowerCase();
      return jobs.filter((j) => j.city.includes(c) || j.location.toLowerCase().includes(c));
    }

    return jobs;
  } catch (err) {
    console.warn('Arbeitnow feed error (non-fatal):', err);
    return [];
  }
}
