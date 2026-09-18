import type { Job } from '../types/job';

const BACKEND_URL = import.meta.env.VITE_API_BASE_URL || (typeof window !== 'undefined' ? `http://${window.location.hostname || 'localhost'}:8000` : 'http://localhost:8000');

export interface DirectApplyResult {
  success: boolean;
  confirmation_id?: string;
  candidate_id?: string;
  message: string;
  provider?: string;
  board?: string;
  status_code?: number;
  /** 'submitted' | 'portal_required' | 'duplicate' | 'rejected' | 'network_error' | 'incomplete_profile' */
  status?: string;
  applyUrl?: string;
  detail?: string;
  resume_attached?: boolean;
  recipient?: string;
  receipt_email?: { sent: boolean; to?: string; reason?: string };
  employer_confirmation?: { found: boolean; pending?: boolean; from?: string; subject?: string };
}

function resolveJobSalary(j: any): { badge: string; display: string; min?: number; max?: number } {
  // 1. If explicit valid numbers exist
  const min = typeof j.salaryMin === 'number' && j.salaryMin > 0 ? j.salaryMin : undefined;
  const max = typeof j.salaryMax === 'number' && j.salaryMax > 0 ? j.salaryMax : undefined;

  if (min || max) {
    const k = (v: number) => `€${Math.round(v / 1000)}k`;
    let badge = '';
    if (min && max && Math.round(min / 1000) !== Math.round(max / 1000)) {
      badge = `${k(min)}–${k(max)}`;
    } else if (max) {
      badge = k(max);
    } else if (min) {
      badge = `${k(min)}+`;
    }
    const display = j.salaryDisplay || (badge ? `${badge} / year` : '');
    if (badge) return { badge, display, min, max };
  }

  // 2. If salaryDisplay contains numbers like "€88,000 - €118,000" or "€65k"
  const rawDisplay = typeof j.salaryDisplay === 'string' ? j.salaryDisplay : '';
  const numMatches = [...rawDisplay.matchAll(/(?:€|EUR)?\s*(\d{2,3}(?:[.,]\d{3})*|\d{2,3})\s*(?:k|K|000)?/g)];
  if (numMatches.length > 0) {
    const parsedNums: number[] = [];
    for (const m of numMatches) {
      const valStr = m[1].replace(/[.,]/g, '');
      let val = parseInt(valStr, 10);
      if (val < 200) val *= 1000;
      if (val >= 25000 && val <= 350000) {
        parsedNums.push(val);
      }
    }
    if (parsedNums.length >= 2) {
      const pMin = Math.min(...parsedNums);
      const pMax = Math.max(...parsedNums);
      const badge = `€${Math.round(pMin / 1000)}k–€${Math.round(pMax / 1000)}k`;
      return { badge, display: rawDisplay || `${badge} / year`, min: pMin, max: pMax };
    } else if (parsedNums.length === 1) {
      const badge = `€${Math.round(parsedNums[0] / 1000)}k`;
      return { badge, display: rawDisplay || `${badge} / year`, min: parsedNums[0], max: parsedNums[0] };
    }
  }

  // 3. If salaryBadge is already a clean formatted Euro badge (not "Direct ATS" or "€?")
  if (typeof j.salaryBadge === 'string' && /^€\d+k/i.test(j.salaryBadge.trim())) {
    const b = j.salaryBadge.trim();
    return { badge: b, display: rawDisplay || `${b} / year` };
  }

  // 4. The employer published no salary, so this job has no salary.
  //
  // There used to be a fourth step here that derived a figure from a hash of
  // the job id and printed it as "€68,000 - €80,000 / year (Market Scale)".
  // Nobody had ever stated that number. Worse, it also populated `min` and
  // `max`, so the "€60k+ Salary" filters were sorting real jobs by invented
  // pay. Most employers publish nothing; the honest render of nothing is
  // nothing, and the card says so.
  return { badge: '', display: '' };
}

export interface FetchJobsOptions {
  keywords?: string;
  city?: string;
  /** Viewport filter as [west, south, east, north]; the server does the culling. */
  bbox?: [number, number, number, number];
  limit?: number;
  signal?: AbortSignal;
  /**
   * Which feed to draw from. Adzuna alone, by default, and that is a speed
   * decision as much as a coverage one: crawling the verified ATS boards was
   * most of the wait on every search, for a few thousand jobs from a hardcoded
   * list of companies, while Adzuna carries tens of thousands from employers
   * that list will never contain.
   */
  source?: 'adzuna' | 'ats' | 'all';
}

/**
 * Feed responses are immutable for a few minutes, so identical queries are
 * served from memory. This is what makes panning back to a region you already
 * looked at instantaneous instead of a fresh megabyte over the wire.
 */
const CACHE_TTL_MS = 3 * 60 * 1000;
const CACHE_LIMIT = 40;
const responseCache = new Map<string, { at: number; jobs: Job[] }>();
const inFlight = new Map<string, Promise<JobFeed>>();

export interface JobFeed {
  jobs: Job[];
  /**
   * False when the backend answered from its first, fast wave and is still
   * fetching the rest. The caller is expected to ask again shortly; asking is
   * cheap, because by then the server is serving it from memory.
   */
  complete: boolean;
}

function readCache(key: string): Job[] | null {
  const hit = responseCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  // Refresh recency so the eviction below drops genuinely cold entries.
  responseCache.delete(key);
  responseCache.set(key, hit);
  return hit.jobs;
}

function writeCache(key: string, jobs: Job[]): void {
  responseCache.set(key, { at: Date.now(), jobs });
  while (responseCache.size > CACHE_LIMIT) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

export function buildJobsQuery(options: FetchJobsOptions): string {
  const params = new URLSearchParams();
  if (options.keywords?.trim()) params.append('keywords', options.keywords.trim());
  if (options.city?.trim()) params.append('city', options.city.trim());
  if (options.bbox) {
    // Round to ~10m: tiny camera jitter must not invalidate the cache.
    params.append('bbox', options.bbox.map((v) => v.toFixed(4)).join(','));
  }
  params.append('limit', String(options.limit ?? 1200));
  params.append('source', options.source ?? 'adzuna');
  return params.toString();
}

export async function fetchJobFeed(options: FetchJobsOptions = {}): Promise<JobFeed> {
  const query = buildJobsQuery(options);

  const cached = readCache(query);
  if (cached) return { jobs: cached, complete: true };

  // Two components asking for the same viewport share one request.
  const pending = inFlight.get(query);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch(`${BACKEND_URL}/api/jobs/direct-ats?${query}`, {
      signal: options.signal,
    });
    if (!res.ok) {
      throw new Error(`Job feed unavailable (HTTP ${res.status}). Check the backend connection.`);
    }
    const data = await res.json();
    const jobs = (data.jobs || []).map(mapJob);
    const complete = data.complete !== false;
    // A partial answer is deliberately not cached. Caching it would pin the map
    // to the first wave for three minutes and the deeper pages, already sitting
    // in the server's memory by then, would never be asked for.
    if (complete) writeCache(query, jobs);
    return { jobs, complete };
  })().finally(() => {
    inFlight.delete(query);
  });

  inFlight.set(query, request);
  return request;
}

/** Just the listings, for callers that have nothing useful to do with a refill. */
export async function fetchDirectAtsJobs(options: FetchJobsOptions = {}): Promise<Job[]> {
  return (await fetchJobFeed(options)).jobs;
}

/** Full record (long description and lists) for one job, fetched on demand. */
export async function fetchJobDetail(jobId: string, signal?: AbortSignal): Promise<Job | null> {
  const res = await fetch(`${BACKEND_URL}/api/jobs/detail?id=${encodeURIComponent(jobId)}`, {
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Job detail unavailable (HTTP ${res.status}).`);
  const data = await res.json();
  return data.job ? mapJob(data.job) : null;
}

/**
 * How long ago a job was posted, in the words a candidate thinks in.
 *
 * Several boards send the literal string "Recently" instead of a date, and a
 * few send nothing at all; neither is an error, so neither should read like
 * one. Anything undated says so plainly rather than guessing.
 */
function relativePostedAt(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'Date not given';
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw.trim();

  const days = Math.max(0, Math.floor((Date.now() - parsed) / 86400000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  const years = Math.round(days / 365);
  return years === 1 ? 'Over a year ago' : `${years} years ago`;
}

function mapJob(j: any): Job {
  const salaryInfo = resolveJobSalary(j);

  return {
    id: j.id,
    title: j.title,
    company: j.company,
    companyLogo: j.companyLogo || `https://avatar.vercel.sh/${j.company}.svg`,
    rating: 0,
    reviewsCount: 0,
    isSuperEmployer: false,
    isFeatured: false,
    category: j.category || 'Engineering',
    location: j.location,
    address: j.locationPrecision === 'exact' ? j.address : undefined,
    locationPrecision: j.locationPrecision || 'unknown',
    city: j.city,
    lat: typeof j.lat === 'number' ? j.lat : Number.NaN,
    lng: typeof j.lng === 'number' ? j.lng : Number.NaN,
    salaryDisplay: salaryInfo.display,
    salaryBadge: salaryInfo.badge,
    salaryMin: salaryInfo.min,
    salaryMax: salaryInfo.max,

    jobType: ({ FullTime: 'Full-time', PartTime: 'Part-time', Intern: 'Internship' } as Record<string, Job['jobType']>)[j.jobType] || j.jobType || 'Full-time',
    remoteType: j.remoteType || 'Hybrid',
    experienceLevel: 'Mid',
    visaSponsorship: j.visaSponsorship === true,
    // Empty when the employer published no photograph, which is nearly always.
    // This used to substitute two stock pictures, which meant every card in the
    // app showed the same stranger in a lab coat; the card now renders the
    // company instead.
    images: j.images || [],
    description: j.description,
    responsibilities: j.responsibilities || [],
    requirements: j.requirements || [],
    benefits: j.benefits || [],
    postedDaysAgo: Number.isFinite(Date.parse(j.postedAt)) ? Math.max(0, Math.floor((Date.now() - Date.parse(j.postedAt)) / 86400000)) : undefined,
    // Relative, because "9/12/2016" on a job card reads as a rendering bug even
    // when it is accurate. How long ago is the thing a candidate is judging.
    postedAt: relativePostedAt(j.postedAt),
    applicantCount: 0,
    applyUrl: j.applyUrl,
    atsProvider: j.atsProvider,
    isDirectApply: true,
    canApplyViaApi: j.canApplyViaApi === true,
    atsBoard: j.atsBoard,
    jobId: j.jobId,
    hasFullDescription: j.hasFullDescription !== false,
  };
}

/**
 * Submits the application over HTTP to the employer's own ATS. No browser
 * agent, and no candidate details invented here: the backend owns the real
 * profile and CV, so sending placeholders from the client would only overwrite
 * good data with bad. The backend fails closed when the ATS has no public
 * application API, and `status` says which case happened.
 */
export async function applyViaDirectAtsApi(job: Job): Promise<DirectApplyResult> {
  const payload = {
    job_id: (job as any).jobId || job.id.replace(/^(gh|ashby|sr|lever)-[^-]+-/, ''),
    board: (job as any).atsBoard || job.company.toLowerCase().replace(/[^a-z0-9]/g, ''),
    // No default provider: guessing one would aim the submission at the wrong ATS.
    provider: job.atsProvider || '',
    company: job.company,
    job_title: job.title,
  };

  const res = await fetch(`${BACKEND_URL}/api/jobs/apply-direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    return {
      success: false,
      status: 'error',
      message: detail?.detail || `The apply service returned HTTP ${res.status}. Nothing was submitted.`,
      status_code: res.status,
      applyUrl: job.applyUrl,
    };
  }

  return await res.json();
}

/* ---------------------------------------------------------------------------
   Browser applications.

   No aggregated job board accepts an anonymous POST, so the HTTP route above
   can only ever report `portal_required`. The way an application actually gets
   filed is by filling the employer's own form in a real browser, which is what
   these calls drive.

   It takes half a minute, so it cannot be one request: the run is started, and
   then polled.
--------------------------------------------------------------------------- */

export type BrowserApplyStatus =
  | 'STARTING' | 'NAVIGATING' | 'FILLING' | 'WAITING_FOR_HUMAN' | 'READY_TO_SUBMIT'
  | 'DRY_RUN_COMPLETED' | 'APPLIED' | 'SUBMITTED_UNVERIFIED'
  | 'NEEDS_CHECKPOINT' | 'FAILED' | 'SKIPPED';

export interface BrowserApplyRun {
  id: string;
  job_id: string;
  job_url: string;
  company: string;
  job_title: string;
  dry_run: boolean;
  status: BrowserApplyStatus;
  /** A sentence describing the status, written by the backend. */
  message: string;
  reason: string;
  fields_filled: number;
  ats: string;
  resume_attached: boolean;
  /** Required fields the employer's form still wants. Non-empty blocks sending. */
  missing_required: string[];
  /** What the browser has done so far, oldest first, as it happens. */
  steps: string[];
  /** Server-relative; use `browserApplyScreenshotUrl` to load it. */
  screenshot_url: string;
  /**
   * The raw failure, when there was one: a driver exception with its session
   * banner and its stack frames. `message` is the sentence; this is the
   * evidence, and the panel keeps it folded away.
   */
  detail: string;
  done: boolean;
  elapsed: number;
}

/**
 * A sentence, out of whatever the backend said.
 *
 * The server now translates its own driver failures, so on the ordinary path
 * this changes nothing. It exists because `message` is a free-text field
 * written by several code paths and one of them, for a while, was handing over
 * forty lines of `undetected_chromedriver!GetHandleVerifier [0x1011c73+4e33]`
 * as the headline a candidate reads. Anything that still arrives looking like a
 * trace gets cut back to its first clause here rather than rendered.
 */
export function readableFailure(message: string): { text: string; trace: string } {
  const raw = (message || '').trim();
  const looksLikeTrace =
    /Stacktrace:|\(Session info:|GetHandleVerifier|\[0x[0-9a-f]+/i.test(raw);
  if (!looksLikeTrace) return { text: raw, trace: '' };

  const head = raw
    .split('Stacktrace:')[0]
    .split('(Session info:')[0]
    .replace(/^Message:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
  return {
    text: head ? `${head}.` : 'The run stopped unexpectedly. Nothing was sent.',
    trace: raw,
  };
}

/**
 * Where to load a run's screenshot from, or '' when there isn't one yet.
 *
 * The page agent hands back the picture itself as a data URI, while the older
 * worker route hands back a path on the backend. Both are just an `img` src.
 */
export function browserApplyScreenshotUrl(run: BrowserApplyRun | null): string {
  const shot = run?.screenshot_url;
  if (!shot) return '';
  if (shot.startsWith('data:') || shot.startsWith('http')) return shot;
  return `${BACKEND_URL}${shot}`;
}

/* ---------------------------------------------------------------------------
   The page agent.

   The browser is driven from inside the page it has opened: the agent reads
   the live DOM, decides one action at a time, and types into the employer's
   own form. There is a single such browser at a time, so the backend keeps one
   run rather than a table of them, and this module gives it an id so the
   calling code can poll it like any other run.
--------------------------------------------------------------------------- */

const AGENT_RUN_ID = 'page-agent';

/** What the agent was asked to do, so its state can be reported in full. */
let agentJob: { id: string; url: string; company: string; title: string } | null = null;

interface AgentState {
  is_running: boolean;
  job_title: string;
  company: string;
  target_url: string;
  phase: string;
  current_step: string;
  logs: { message: string }[];
  /** Server-relative, with a frame counter on it so each new frame is a new URL. */
  screenshot_url: string;
  screenshot_seq: number;
  last_result: {
    success?: boolean;
    barrier?: boolean;
    message?: string;
    dry_run?: boolean;
    submitted?: boolean;
    awaiting_review?: boolean;
    fields_filled?: number;
    resume_attached?: boolean;
    unexpected_submit?: boolean;
    /** The backend's own word for how it ended: applied, sent_unconfirmed,
     *  blocked, not_sent, error, awaiting_review, cancelled. */
    outcome?: string;
    /** Whether anything actually left the browser. */
    sent?: boolean;
    /** The form went, but the employer's page never confirmed it. */
    sent_unconfirmed?: boolean;
    /** The raw driver error, when the run died on one. */
    detail?: string;
  } | null;
  dry_run: boolean;
  started_at: number | null;
  model: string;
  awaiting_review: boolean;
}

const PHASE_STATUS: Record<string, BrowserApplyStatus> = {
  idle: 'STARTING',
  navigating: 'NAVIGATING',
  filling_form: 'FILLING',
  autonomous_agent: 'FILLING',
  cancelled: 'SKIPPED',
};

function agentStatus(state: AgentState): BrowserApplyStatus {
  const result = state.last_result;
  if (state.is_running || !result) return PHASE_STATUS[state.phase] || 'FILLING';
  if (result.submitted) return 'APPLIED';
  if (result.success && result.dry_run) return 'DRY_RUN_COMPLETED';
  if (result.success) return 'SUBMITTED_UNVERIFIED';
  // Sent, with nothing from the employer to prove it. This used to collapse
  // into FAILED, which is the one reading that is definitely wrong: it invites
  // a second application to a company that already has the first.
  if (result.sent_unconfirmed || result.outcome === 'sent_unconfirmed') {
    return 'SUBMITTED_UNVERIFIED';
  }
  if (result.barrier) return 'NEEDS_CHECKPOINT';
  return 'FAILED';
}

function toRun(state: AgentState): BrowserApplyRun {
  const result = state.last_result;
  const done = !state.is_running && !!result;
  const status = agentStatus(state);
  return {
    id: AGENT_RUN_ID,
    job_id: agentJob?.id || '',
    job_url: agentJob?.url || state.target_url || '',
    company: state.company || agentJob?.company || '',
    job_title: state.job_title || agentJob?.title || '',
    dry_run: result?.dry_run ?? state.dry_run,
    status,
    message: (done ? result?.message : state.current_step) || 'Working…',
    // The agent path reports a barrier in words rather than a code, so there is
    // no reason code to hand over and nothing to look up an explanation with.
    reason: '',
    fields_filled: result?.fields_filled ?? 0,
    ats: state.model ? `page agent · ${state.model}` : 'page agent',
    resume_attached: !!result?.resume_attached,
    // Every required answer is the agent's to give or to leave; it does not
    // hand back a list of what it skipped, so nothing is claimed here.
    missing_required: [],
    steps: (state.logs || []).map((entry) => entry.message).filter(Boolean),
    screenshot_url: state.screenshot_url || '',
    detail: result?.detail || '',
    done,
    elapsed: state.started_at ? Math.round(Date.now() / 1000 - state.started_at) : 0,
  };
}

/**
 * Opens the employer's form in a real browser and lets the in-page agent fill
 * it from the stored profile.
 *
 * `dryRun` defaults to **false**: the agent goes all the way through and presses
 * Submit itself. It used to default to true — fill everything, then stop dead on
 * the last button and wait to be told to press it — which turned every
 * application into two rounds of attention for no added safety: the run had
 * already typed real answers into a real employer's form by then, and a human
 * skimming a screenshot catches very little the verifier does not.
 *
 * Pass `true` to get the old rehearsal, which leaves the browser parked on the
 * filled form for `submitReviewedForm` to send.
 */
export async function startBrowserApply(job: Job, dryRun = false): Promise<BrowserApplyRun> {
  const res = await fetch(`${BACKEND_URL}/api/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: job.applyUrl,
      job_id: job.id,
      company: job.company,
      job_title: job.title,
      dry_run: dryRun,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || `Could not start the browser (HTTP ${res.status}).`);
  }
  agentJob = { id: job.id, url: job.applyUrl || '', company: job.company, title: job.title };
  return await getBrowserApply(AGENT_RUN_ID);
}

/**
 * Sends a form a rehearsal run left filled and waiting.
 *
 * It continues in the browser that is already open on that form rather than
 * filling a fresh one, because the model does not fill a page identically
 * twice — a second pass would send something nobody had read.
 */
export async function submitReviewedForm(): Promise<BrowserApplyRun> {
  const res = await fetch(`${BACKEND_URL}/api/apply/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || `Could not send that form (HTTP ${res.status}).`);
  }
  return await getBrowserApply(AGENT_RUN_ID);
}

export async function getBrowserApply(_runId: string): Promise<BrowserApplyRun> {
  const res = await fetch(`${BACKEND_URL}/api/apply/state`);
  if (!res.ok) throw new Error(`Lost track of that application run (HTTP ${res.status}).`);
  return toRun(await res.json());
}

/**
 * Polls a run to completion, reporting each state change as it happens so the
 * candidate can watch rather than stare at a spinner.
 */
export async function pollBrowserApply(
  runId: string,
  onUpdate: (run: BrowserApplyRun) => void,
  // Long enough to cover the two minutes a run may legitimately spend waiting
  // on a human to answer a security check, plus the form load either side.
  { intervalMs = 1200, timeoutMs = 330000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<BrowserApplyRun> {
  const deadline = Date.now() + timeoutMs;
  let last: BrowserApplyRun | null = null;

  for (;;) {
    const run = await getBrowserApply(runId);
    // Also on a new step, not only on a phase change. Filling a form is one
    // single status for most of the run, so watching `status` alone is what
    // made a working application look like a stalled one. The step list is a
    // capped tail, so its length stops growing on a long run: compare the last
    // line as well, or the feed freezes while the agent is still working.
    const tip = run.steps?.[run.steps.length - 1];
    const lastTip = last?.steps?.[last.steps.length - 1];
    const moved =
      (run.steps?.length || 0) !== (last?.steps?.length || 0) ||
      tip !== lastTip ||
      run.message !== last?.message ||
      // A new frame of the browser. This is what makes the panel a live view
      // of the form being filled rather than a still that arrives at the end.
      run.screenshot_url !== last?.screenshot_url;
    if (!last || run.status !== last.status || moved || run.done) onUpdate(run);
    last = run;
    if (run.done) return run;
    if (Date.now() > deadline) {
      // The browser is still open and may yet finish; this only stops watching.
      throw new Error('The browser is taking unusually long. It is still open — finish it there.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * How the last attempt at a job ended, in the words the UI needs rather than
 * the backend's. Kept here beside the run types because the panel, the card
 * and the toast all have to agree on what "sent" means.
 */
export interface ApplyOutcome {
  status: BrowserApplyStatus;
  /** True only when something actually left the browser. */
  sent: boolean;
  /** One short line, safe to show: no URLs, no addresses. */
  note: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

const OUTCOME_NOTE: Partial<Record<BrowserApplyStatus, string>> = {
  APPLIED: 'Applied — their page confirmed it',
  SUBMITTED_UNVERIFIED: 'Sent, but never confirmed',
  DRY_RUN_COMPLETED: 'Filled and waiting for you',
  NEEDS_CHECKPOINT: 'Blocked by the site',
  WAITING_FOR_HUMAN: 'Needs you',
  FAILED: 'Not sent',
  SKIPPED: 'Skipped',
};

/** Reads a finished run as an outcome worth remembering. */
export function runOutcome(run: BrowserApplyRun): ApplyOutcome {
  return {
    status: run.status,
    sent: run.status === 'APPLIED' || run.status === 'SUBMITTED_UNVERIFIED',
    note: OUTCOME_NOTE[run.status] || 'Attempted',
    at: new Date().toISOString(),
  };
}
