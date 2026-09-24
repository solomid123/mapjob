import { createClient } from '@supabase/supabase-js';
import { currentUser } from './account';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://mnknepjrpoetfoagzisp.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1ua25lcGpycG9ldGZvYWd6aXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3OTg0ODAsImV4cCI6MjEwNDM3NDQ4MH0.eJubTsCW_cKB74hgrGV-ZLMTxJVbunKIuY7VHZzB90Q';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface DbJob {
  id: string;
  title: string;
  company: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  salary_min?: number;
  salary_max?: number;
  salary_currency?: string;
  contract_type?: string;
  description?: string;
  redirect_url?: string;
  source?: string;
  status?: 'discovered' | 'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'archived';
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DbCandidateProfile {
  id: string;
  full_name: string;
  email: string;
  phone?: string;
  location?: string;
  target_roles?: string[];
  skills?: string[];
  bio?: string;
  cv_url?: string;
  cv_parsed_json?: any;
  cover_letter_template?: string;
  linkedin_url?: string;
  github_url?: string;
}

export interface DbInterviewSession {
  id: string;
  candidate_id?: string;
  company_name?: string;
  role_title?: string;
  language?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number;
  summary?: string;
  feedback_notes?: string;
}

export interface DbInterviewTranscript {
  id?: number;
  session_id: string;
  speaker?: 'interviewer' | 'candidate';
  text: string;
  is_final: boolean;
  timestamp_ms?: number;
}

export interface DbInterviewQA {
  id?: number;
  session_id: string;
  question: string;
  suggested_answer: string;
  model_used?: string;
  copied?: boolean;
}

// ----------------------------------------------------
// Jobs Database Operations
// ----------------------------------------------------

/**
 * A job advert is the same advert for everybody, so `jobs` is a catalogue with
 * one row per posting. A shortlist is not: it belongs to whoever made it, and
 * when the bookmark lived as a status on the advert the two accounts read one
 * pile -- her wishlist opened full of his mechanical engineering jobs.
 *
 * So the bookmark is a row in `saved_jobs`, keyed on the person and the
 * advert. The catalogue is still written, because the map needs the posting's
 * details either way; what is personal is only the fact of wanting it.
 */
const SAVED = 'saved_jobs';

export async function saveJobToSupabase(job: DbJob, user?: string): Promise<DbJob | null> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .upsert(
        {
          id: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          latitude: job.latitude,
          longitude: job.longitude,
          salary_min: job.salary_min,
          salary_max: job.salary_max,
          salary_currency: job.salary_currency || 'EUR',
          contract_type: job.contract_type,
          description: job.description,
          redirect_url: job.redirect_url,
          source: job.source || 'adzuna',
          status: job.status || 'saved',
          notes: job.notes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      )
      .select()
      .single();

    if (error) {
      console.warn('Supabase saveJob error:', error.message);
      return null;
    }

    // The bookmark itself, under the account that made it. Written after the
    // advert so a shortlist never points at a posting the map cannot show.
    const { error: mine } = await supabase
      .from(SAVED)
      .upsert(
        {
          user_id: user || currentUser(),
          job_id: job.id,
          status: job.status || 'saved',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,job_id' }
      );
    if (mine) console.warn('Supabase saveJob (mine) error:', mine.message);

    return data;
  } catch (err) {
    console.warn('Supabase saveJob exception:', err);
    return null;
  }
}

/**
 * The ids one person has bookmarked, newest first.
 *
 * Scoped by account, and scoped in the query rather than after it: a filter
 * applied to a list that has already crossed the wire is a list that was on
 * the wire. Nothing here falls back to the whole table -- an empty shortlist
 * is right, and somebody else's shortlist is not.
 */
export async function fetchSavedJobIds(user?: string): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from(SAVED)
      .select('job_id,status')
      .eq('user_id', user || currentUser())
      .in('status', ['saved', 'applied'])
      .order('updated_at', { ascending: false });

    if (error) {
      console.warn('Supabase fetchSavedJobIds error:', error.message);
      return [];
    }
    return (data || []).map((row) => String(row.job_id));
  } catch (err) {
    console.warn('Supabase fetchSavedJobIds exception:', err);
    return [];
  }
}

/**
 * What this person's bookmark on that advert has become.
 *
 * The catalogue row is left alone on purpose: archiving a job here means "take
 * it off my list", and writing that onto the shared advert would take it off
 * the other account's list too.
 */
export async function updateJobStatusInSupabase(
  jobId: string,
  status: DbJob['status'],
  user?: string
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(SAVED)
      .upsert(
        {
          user_id: user || currentUser(),
          job_id: jobId,
          status: status || 'saved',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,job_id' }
      );

    if (error) {
      console.warn('Supabase updateJobStatus error:', error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------
// Interview Sessions & Transcripts
// ----------------------------------------------------

export async function createInterviewSession(
  companyName: string = 'Interview Session',
  roleTitle: string = 'Mechanical Engineer',
  lang: string = 'en'
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('interview_sessions')
      .insert({
        company_name: companyName,
        role_title: roleTitle,
        language: lang,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.warn('createInterviewSession error:', error.message);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.warn('createInterviewSession exception:', err);
    return null;
  }
}

export async function recordTranscriptLine(
  sessionId: string,
  text: string,
  isFinal: boolean,
  speaker: 'interviewer' | 'candidate' = 'interviewer'
): Promise<void> {
  if (!sessionId || !text.trim()) return;
  try {
    await supabase.from('interview_transcripts').insert({
      session_id: sessionId,
      text: text.trim(),
      is_final: isFinal,
      speaker,
      timestamp_ms: Date.now(),
    });
  } catch (err) {
    console.warn('recordTranscriptLine error:', err);
  }
}

export async function recordInterviewQA(
  sessionId: string,
  question: string,
  answer: string,
  model: string = 'fuelix'
): Promise<void> {
  if (!sessionId || !question.trim() || !answer.trim()) return;
  try {
    await supabase.from('interview_qa').insert({
      session_id: sessionId,
      question: question.trim(),
      suggested_answer: answer.trim(),
      model_used: model,
    });
  } catch (err) {
    console.warn('recordInterviewQA error:', err);
  }
}

export async function finishInterviewSession(
  sessionId: string,
  durationSeconds: number,
  summary?: string
): Promise<void> {
  if (!sessionId) return;
  try {
    await supabase
      .from('interview_sessions')
      .update({
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
        summary: summary || null,
      })
      .eq('id', sessionId);
  } catch (err) {
    console.warn('finishInterviewSession error:', err);
  }
}

// ----------------------------------------------------
// Storage Operations
// ----------------------------------------------------

export async function uploadResumeFile(
  file: File | Blob,
  fileName: string = `resume_${Date.now()}.pdf`
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from('resumes')
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: true,
      });

    if (error) {
      console.warn('uploadResumeFile error:', error.message);
      return null;
    }

    const { data: publicData } = supabase.storage
      .from('resumes')
      .getPublicUrl(data.path);

    return publicData.publicUrl;
  } catch (err) {
    console.warn('uploadResumeFile exception:', err);
    return null;
  }
}

export async function uploadScreenSnapshot(
  blob: Blob,
  sessionId: string
): Promise<string | null> {
  try {
    const fileName = `${sessionId}_${Date.now()}.jpg`;
    const { data, error } = await supabase.storage
      .from('interview-artifacts')
      .upload(fileName, blob, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (error) {
      console.warn('uploadScreenSnapshot error:', error.message);
      return null;
    }

    const { data: publicData } = supabase.storage
      .from('interview-artifacts')
      .getPublicUrl(data.path);

    return publicData.publicUrl;
  } catch (err) {
    console.warn('uploadScreenSnapshot exception:', err);
    return null;
  }
}

// ----------------------------------------------------
// Candidate Profile
// ----------------------------------------------------

export async function getCandidateProfile(): Promise<DbCandidateProfile | null> {
  try {
    const { data, error } = await supabase
      .from('candidate_profile')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('getCandidateProfile error:', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('getCandidateProfile exception:', err);
    return null;
  }
}
