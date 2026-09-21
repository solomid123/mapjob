/**
 * The candidate record, read and written by the profile page.
 *
 * One record stands behind everything the app says about the person: what goes
 * into an application form, what the interview helper answers from, who a
 * letter is signed by, and what a tailored CV is allowed to claim. It used to
 * be a Python dict that only an editor could change, which is why this exists.
 *
 * The server never sends `password` or `passwords` and refuses to store them,
 * so there is nothing here to guard: this module cannot leak what it is never
 * given. Portal passwords stay in .env.
 */

import { API_BASE } from './apiBase';
import { withUser } from './account';

const BACKEND_URL = API_BASE;

/** One job, as the CV tells it. */
export interface ProfileExperience {
  /** What the record calls the job. `title` is the older spelling of the same thing. */
  role?: string;
  title?: string;
  company?: string;
  location?: string;
  period?: string;
  highlights?: string[];
}

export interface ProfileEducation {
  degree?: string;
  institution?: string;
  location?: string;
  period?: string;
  note?: string;
}

/**
 * Deliberately open: the server holds the list of fields it will accept, and
 * pinning a second copy of it here means every new field has to be added in
 * two places before it can be typed into.
 */
export interface CandidateProfile {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  phone_formatted?: string;
  address?: string;
  postal_code?: string;
  city?: string;
  country?: string;
  full_address?: string;
  linkedin?: string;
  website?: string;
  current_title?: string;
  headline?: string;
  summary?: string;
  years_of_experience?: number;
  education?: ProfileEducation[];
  experiences?: ProfileExperience[];
  technical_skills?: string[];
  languages?: Record<string, string>;
  availability?: string;
  notice_period?: string;
  salary_expectation?: string;
  willing_to_relocate?: string;
  driving_licence?: string;
  work_authorisation?: string;
  cover_letter_notes?: string;
  [key: string]: unknown;
}

export interface ProfileResponse {
  /** Whose record this is: the account the server resolved the request to. */
  user?: string;
  person?: {
    id: string;
    display_name: string;
    focus: string;
    letter_language: string;
    interview_language: string;
    country: string;
  };
  profile: CandidateProfile;
  /** What the server will accept a write for. */
  editable: string[];
  /** Which fields have been edited away from the defaults. */
  stored: string[];
}

export async function fetchProfile(user?: string): Promise<ProfileResponse> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/profile`, user));
  if (!res.ok) throw new Error(`Profile unavailable (${res.status})`);
  return res.json();
}

/**
 * Save the fields that changed.
 *
 * A patch rather than the whole record: two tabs open on this page should not
 * mean the second one silently reverts the first one's other sections. The
 * server answers with what it stored and what it refused, and the page says so
 * rather than pretending everything landed.
 */
export async function saveProfile(patch: CandidateProfile, user?: string): Promise<{
  profile: CandidateProfile;
  saved: string[];
  refused: string[];
}> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/profile`, user), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Could not save (${res.status})`);
  return res.json();
}

/** What a CV was read to contain. A proposal: nothing is stored until a save. */
export interface ProfileImport {
  filename: string;
  pages: number;
  chars: number;
  /** 'model' when the whole CV was mapped, 'patterns' when only the contact block was. */
  source: 'model' | 'patterns' | 'none';
  fields: CandidateProfile;
  found: string[];
  /** Keys the reader offered that the record will not hold. */
  refused: string[];
  notes: string[];
  /**
   * The uploaded file, kept as this account's master CV. Every tailored CV is
   * cut from it from here on, and uploading another one replaces it.
   */
  master_cv?: { id: string; title: string; filename: string; pages: number } | null;
}

/**
 * Read a CV and get back the fields it states.
 *
 * The server does not save any of it, which is the point: an extraction that
 * misreads a two-column layout would otherwise overwrite an employment history
 * that somebody typed in by hand. The page fills its boxes and the save is
 * still a deliberate act.
 */
export async function importProfileFromCv(file: File, user?: string): Promise<ProfileImport> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(withUser(`${BACKEND_URL}/api/profile/import`, user), {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    // FastAPI puts the reason in `detail`, and the reason is the useful part:
    // "that is not a PDF inside" beats "415".
    let detail = '';
    try {
      detail = (await res.json())?.detail || '';
    } catch {
      detail = '';
    }
    throw new Error(detail || `The CV could not be read (${res.status})`);
  }
  return res.json();
}
