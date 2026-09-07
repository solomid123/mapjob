-- Migration: 20260907000000_init_mapjob_database.sql
-- Description: Core schema for MapJob & Interview Copilot (Tables, RLS, Indexes, Buckets)

-- 1. JOBS TABLE (Live Map Marker & Job Feed Data)
CREATE TABLE IF NOT EXISTS public.jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    salary_min NUMERIC,
    salary_max NUMERIC,
    salary_currency TEXT DEFAULT 'EUR',
    contract_type TEXT,
    description TEXT,
    redirect_url TEXT,
    source TEXT DEFAULT 'adzuna',
    status TEXT DEFAULT 'discovered', -- discovered, saved, applied, interviewing, rejected, archived
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON public.jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_location ON public.jobs(latitude, longitude);

-- 2. CANDIDATE PROFILE TABLE (Personal Info, CV parsing, skills)
CREATE TABLE IF NOT EXISTS public.candidate_profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL DEFAULT 'Badreddine Barki',
    email TEXT NOT NULL DEFAULT 'badreddinebarki@gmail.com',
    phone TEXT,
    location TEXT DEFAULT 'France',
    target_roles TEXT[] DEFAULT ARRAY['Ingénieur Mécanique', 'Calcul / Simulation', 'Conception Mécanique'],
    skills TEXT[] DEFAULT ARRAY['CATIA V5', 'SolidWorks', 'Creo', 'Abaqus', 'Ansys', 'DFMEA', 'Cotation GPS'],
    bio TEXT,
    cv_url TEXT,
    cv_parsed_json JSONB DEFAULT '{}'::jsonb,
    cover_letter_template TEXT,
    linkedin_url TEXT,
    github_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed default candidate if not exists
INSERT INTO public.candidate_profile (full_name, email, phone, location)
VALUES ('Badreddine Barki', 'badreddinebarki@gmail.com', '+33 6 00 00 00 00', 'France')
ON CONFLICT DO NOTHING;

-- 3. JOB APPLICATIONS TABLE (1-Click Autonomous Fast Apply Runs)
CREATE TABLE IF NOT EXISTS public.job_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id TEXT REFERENCES public.jobs(id) ON DELETE SET NULL,
    candidate_id UUID REFERENCES public.candidate_profile(id) ON DELETE CASCADE,
    company TEXT NOT NULL,
    job_title TEXT NOT NULL,
    portal_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, in_progress, applied, failed, action_required
    cv_used_url TEXT,
    cover_letter_used TEXT,
    form_data JSONB DEFAULT '{}'::jsonb,
    logs TEXT[] DEFAULT ARRAY[]::text[],
    error_message TEXT,
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_applications_job ON public.job_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON public.job_applications(status);

-- 4. INTERVIEW SESSIONS TABLE (Interview Copilot History)
CREATE TABLE IF NOT EXISTS public.interview_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES public.candidate_profile(id) ON DELETE CASCADE,
    company_name TEXT DEFAULT 'Interview Session',
    role_title TEXT DEFAULT 'Mechanical Engineer',
    language TEXT DEFAULT 'en',
    started_at TIMESTAMPTZ DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER DEFAULT 0,
    summary TEXT,
    feedback_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. INTERVIEW TRANSCRIPTS TABLE (Realtime Stream Persistence)
CREATE TABLE IF NOT EXISTS public.interview_transcripts (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    speaker TEXT DEFAULT 'interviewer',
    text TEXT NOT NULL,
    is_final BOOLEAN DEFAULT true,
    timestamp_ms BIGINT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_session ON public.interview_transcripts(session_id);

-- 6. INTERVIEW QA (Copilot AI Answers) TABLE
CREATE TABLE IF NOT EXISTS public.interview_qa (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    suggested_answer TEXT NOT NULL,
    model_used TEXT DEFAULT 'fuelix',
    copied BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qa_session ON public.interview_qa(session_id);

-- 7. INTERVIEW SCREEN ANALYSES TABLE (Vision OCR & Diagram Analyses)
CREATE TABLE IF NOT EXISTS public.interview_screen_analyses (
    id BIGSERIAL PRIMARY KEY,
    session_id UUID REFERENCES public.interview_sessions(id) ON DELETE CASCADE,
    image_url TEXT,
    question_context TEXT,
    analysis_text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. ENABLE ROW LEVEL SECURITY (RLS) ON ALL TABLES
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidate_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_qa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interview_screen_analyses ENABLE ROW LEVEL SECURITY;

-- 9. PERMISSIVE POLICIES FOR CLIENT / API ACCESS
DROP POLICY IF EXISTS "Allow anon full access on jobs" ON public.jobs;
CREATE POLICY "Allow anon full access on jobs" ON public.jobs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on candidate_profile" ON public.candidate_profile;
CREATE POLICY "Allow anon full access on candidate_profile" ON public.candidate_profile FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on job_applications" ON public.job_applications;
CREATE POLICY "Allow anon full access on job_applications" ON public.job_applications FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on interview_sessions" ON public.interview_sessions;
CREATE POLICY "Allow anon full access on interview_sessions" ON public.interview_sessions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on interview_transcripts" ON public.interview_transcripts;
CREATE POLICY "Allow anon full access on interview_transcripts" ON public.interview_transcripts FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on interview_qa" ON public.interview_qa;
CREATE POLICY "Allow anon full access on interview_qa" ON public.interview_qa FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon full access on interview_screen_analyses" ON public.interview_screen_analyses;
CREATE POLICY "Allow anon full access on interview_screen_analyses" ON public.interview_screen_analyses FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 10. STORAGE BUCKETS (Resumes, Interview Artifacts, Job Documents)
INSERT INTO storage.buckets (id, name, public)
VALUES 
    ('resumes', 'resumes', true),
    ('interview-artifacts', 'interview-artifacts', true),
    ('job-attachments', 'job-attachments', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage object policies
DROP POLICY IF EXISTS "Public Storage Upload & Read" ON storage.objects;
CREATE POLICY "Public Storage Upload & Read" ON storage.objects 
FOR ALL TO anon, authenticated 
USING (bucket_id IN ('resumes', 'interview-artifacts', 'job-attachments')) 
WITH CHECK (bucket_id IN ('resumes', 'interview-artifacts', 'job-attachments'));
