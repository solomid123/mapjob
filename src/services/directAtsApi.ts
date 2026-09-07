import type { Job } from '../types/job';

const BACKEND_URL = 'http://127.0.0.1:8000';

export interface DirectApplyResult {
  success: boolean;
  confirmation_id?: string;
  message: string;
  provider?: string;
  board?: string;
  status_code?: number;
}

export async function fetchDirectAtsJobs(keywords?: string, city?: string): Promise<Job[]> {
  try {
    const params = new URLSearchParams();
    if (keywords && keywords.trim()) params.append('keywords', keywords.trim());
    if (city && city.trim()) params.append('city', city.trim());
    params.append('limit', '80');

    const res = await fetch(`${BACKEND_URL}/api/jobs/direct-ats?${params.toString()}`);
    if (!res.ok) return [];

    const data = await res.json();
    const rawJobs = data.jobs || [];

    return rawJobs.map((j: any): Job => ({
      id: j.id,
      title: j.title,
      company: j.company,
      companyLogo: j.companyLogo || `https://avatar.vercel.sh/${j.company}.svg`,
      rating: j.rating || 4.8,
      reviewsCount: j.reviewsCount || 200,
      isSuperEmployer: true,
      isFeatured: true,
      category: j.category || 'Engineering',
      location: j.location,
      address: j.location,
      city: j.city,
      lat: j.lat,
      lng: j.lng,
      salaryDisplay: j.salaryDisplay || 'Competitive',
      salaryBadge: 'Direct ATS',
      jobType: j.jobType || 'Full-time',
      remoteType: j.remoteType || 'Hybrid',
      experienceLevel: 'Mid',
      visaSponsorship: true,
      images: j.images || [
        'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=1000&auto=format&fit=crop&q=85',
        'https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=1000&auto=format&fit=crop&q=85',
      ],
      description: j.description,
      responsibilities: [
        'Design and deploy scalable technical workflows and systems',
        'Collaborate across cross-functional engineering teams',
        'Optimize reliability, testing, and implementation cycles'
      ],
      requirements: [
        'Degree in Engineering or equivalent practical experience',
        'Demonstrated track record of technical ownership',
        'Strong problem-solving and communication skills'
      ],
      benefits: [
        'Comprehensive health coverage & retirement plans',
        'Competitive equity / stock options package',
        'Flexible hybrid working arrangements'
      ],
      postedDaysAgo: 1,
      postedAt: 'Verified ATS',
      applicantCount: 12,
      applyUrl: j.applyUrl,
      atsProvider: j.atsProvider,
      isDirectApply: true,
      canApplyViaApi: true,
      atsBoard: j.atsBoard,
      jobId: j.jobId,
    }));
  } catch (err) {
    console.warn('Direct ATS API fetch failed (backend may be initializing):', err);
    return [];
  }
}

export async function applyViaDirectAtsApi(job: Job): Promise<DirectApplyResult> {
  const payload = {
    job_id: (job as any).jobId || job.id.replace(/^(gh|ashby)-[^-]+-/, ''),
    board: (job as any).atsBoard || job.company.toLowerCase().replace(/[^a-z0-9]/g, ''),
    provider: job.atsProvider || 'Greenhouse',
    company: job.company,
    job_title: job.title,
    candidate: {
      full_name: 'Badreddine Barki',
      first_name: 'Badreddine',
      last_name: 'Barki',
      email: 'badreddinebarki@gmail.com',
      phone: '+33 6 00 00 00 00',
    }
  };

  const res = await fetch(`${BACKEND_URL}/api/jobs/apply-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    return {
      success: false,
      message: `Direct ATS API error (HTTP ${res.status})`,
      status_code: res.status,
    };
  }

  return await res.json();
}
