/**
 * The documents behind an application: one CV and one letter per job.
 *
 * Tailoring is a blocking call of roughly twenty seconds -- a model reads the
 * advert against the master CV, then two PDFs are printed -- so everything here
 * is written for a caller that has to show that time passing rather than
 * pretend it is instant.
 *
 * The files are served by the API, not by this app: one place decides what can
 * be read out of that folder, and it is the same place that wrote it.
 */

import { API_BASE } from './apiBase';
import { currentUser, withUser } from './account';

const BACKEND_URL = API_BASE;

/** Which of the four files exist, as paths on the API. */
export interface DocumentFiles {
  cv_html?: string;
  cv_pdf?: string;
  letter_html?: string;
  letter_pdf?: string;
}

/** What the tailoring did, kept so it can be answered for later. */
export interface TailorReport {
  reverted?: string[];
  unknown_ids?: string[];
  rejected_skills?: string[];
  invented?: string[];
  topped_up?: string[];
  /**
   * Lines the model wrote in the advert's language rather than the master's.
   * A Dutch headline over English bullets is one page in two languages, so the
   * master's own wording is used instead and named here.
   */
  off_language?: string[];
  /**
   * Pronouns the model slipped into a line that should have none. "Il apporte
   * plus de 3 ans d'experience" is a note someone wrote about the candidate;
   * a CV is written in his own voice, so that line reverts to the master's.
   */
  off_voice?: string[];
}

export interface TailoredDocument {
  job_id: string;
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  language?: string;
  master?: string;
  model?: string;
  tailored?: boolean;
  headline?: string;
  summary?: string;
  why?: string;
  bullets_kept?: number;
  bullets_available?: number;
  skills_kept?: string[];
  report?: TailorReport;
  letter_subject?: string;
  letter_fallback?: boolean;
  seconds?: number;
  created_at?: string;
  epoch?: number;
  log?: string[];
  files?: DocumentFiles;
  /** True when an unchanged advert was asked for twice and got the same file. */
  reused?: boolean;
}

/** One line of the ledger: what happened when this job was applied to. */
export interface ApplicationRecord {
  at?: string;
  epoch?: number;
  outcome?: string;
  sent?: boolean;
  confirmed?: boolean;
  company?: string;
  job_title?: string;
  url?: string;
  job_id?: string;
  message?: string;
  dry_run?: boolean;
  seconds?: number;
  engine?: string;
  model?: string;
  cost_usd?: number;
}

export interface JobForTailoring {
  job_id: string;
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  description?: string;
  force?: boolean;
}

/** An API path turned into something an iframe can open. */
export function documentUrl(path?: string): string {
  if (!path) return '';
  const full = path.startsWith('http') ? path : `${BACKEND_URL}${path}`;
  // The server writes the account into these paths; a path from an older
  // meta.json has none, and an unscoped request finds nothing rather than
  // finding the other account's file.
  return full.includes('user=') ? full : withUser(full);
}

/**
 * Whether this browser will *show* a PDF or quietly save it.
 *
 * `Content-Disposition: inline` is a request, not an instruction. Edge and
 * Chrome both have a "always download PDF files" setting, and with it on, an
 * iframe pointing at a PDF puts a file in Downloads and leaves a white
 * rectangle behind -- which is exactly what happened here: opening the Applied
 * tab saved three copies of the CV without anyone asking for one.
 *
 * `navigator.pdfViewerEnabled` is how a browser answers that question, so a
 * PDF only ever goes in a frame when the answer is yes. Anywhere else the
 * viewer shows the HTML twin, or a link the person can choose to click.
 */
export function canDisplayPdfInline(): boolean {
  if (typeof navigator === 'undefined') return false;
  const flag = (navigator as Navigator & { pdfViewerEnabled?: boolean }).pdfViewerEnabled;
  // Older browsers do not answer at all; those predate the setting and show it.
  return flag !== false;
}

export async function tailorJob(job: JobForTailoring): Promise<TailoredDocument> {
  const res = await fetch(`${BACKEND_URL}/api/tailor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Whose application. The server cuts their master CV, prints their
    // letterhead and files the pair on their own shelf; without this every
    // document was made for the account this app had before it had two.
    body: JSON.stringify({ ...job, user: currentUser() }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || `Tailoring failed (${res.status})`);
  }
  return res.json();
}

export async function fetchDocuments(jobId?: string): Promise<TailoredDocument[]> {
  const query = jobId ? `?job_id=${encodeURIComponent(jobId)}` : '';
  const res = await fetch(withUser(`${BACKEND_URL}/api/documents${query}`));
  if (!res.ok) throw new Error(`Documents unavailable (${res.status})`);
  const data = await res.json();
  return data.documents || [];
}

export async function fetchApplications(limit = 200): Promise<ApplicationRecord[]> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/applications?limit=${limit}`));
  if (!res.ok) throw new Error(`History unavailable (${res.status})`);
  const data = await res.json();
  return data.applications || [];
}

export interface MasterGaps {
  readable: boolean;
  missing: { company: string; role?: string; period?: string }[];
  master?: string;
  jobs_in_master?: string[];
}

/**
 * Whether the master CV still matches the profile. The letter is written from
 * the profile and the CV is cut from the master, so a job added to one and not
 * the other sends a letter describing work the CV does not show.
 */
export async function fetchMasterGaps(language = 'fr'): Promise<MasterGaps> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/tailor/gaps?language=${language}`));
  if (!res.ok) throw new Error(`Master unavailable (${res.status})`);
  return res.json();
}
