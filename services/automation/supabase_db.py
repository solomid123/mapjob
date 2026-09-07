"""
Supabase Database client for backend automation and API server.
Provides direct PostgreSQL persistence for job applications, candidates, and interview history.
"""

import os
import psycopg2
import psycopg2.extras
from typing import Dict, Any, List, Optional
from dotenv import load_dotenv

load_dotenv()

DB_HOST = os.getenv("SUPABASE_DB_HOST", "db.mnknepjrpoetfoagzisp.supabase.co")
DB_PORT = int(os.getenv("SUPABASE_DB_PORT", "5432"))
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", "Badreddine00++")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")


def get_db_connection():
    return psycopg2.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        dbname=DB_NAME,
        connect_timeout=8
    )


def save_application_record(
    company: str,
    job_title: str,
    portal_url: str,
    status: str = "applied",
    job_id: Optional[str] = None,
    form_data: Optional[Dict[str, Any]] = None,
    logs: Optional[List[str]] = None,
    error_message: Optional[str] = None
) -> Optional[str]:
    """Saves or updates a job application run in Supabase."""
    try:
        conn = get_db_connection()
        conn.autocommit = True
        cur = conn.cursor()
        
        cur.execute("""
            INSERT INTO public.job_applications (
                job_id, company, job_title, portal_url, status, 
                form_data, logs, error_message, applied_at
            ) VALUES (
                %s, %s, %s, %s, %s, 
                %s, %s, %s, now()
            ) RETURNING id;
        """, (
            job_id, company, job_title, portal_url, status,
            psycopg2.extras.Json(form_data or {}), logs or [], error_message
        ))
        
        app_id = cur.fetchone()[0]
        cur.close()
        conn.close()
        return str(app_id)
    except Exception as e:
        print(f"[Supabase] Error saving application record: {e}")
        return None


def get_candidate_details() -> Dict[str, Any]:
    """Retrieves candidate profile from Supabase."""
    try:
        conn = get_db_connection()
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM public.candidate_profile LIMIT 1;")
        row = cur.fetchone()
        cur.close()
        conn.close()
        if row:
            return dict(row)
    except Exception as e:
        print(f"[Supabase] Error fetching candidate profile: {e}")
    return {
        "full_name": "Badreddine Barki",
        "email": "badreddinebarki@gmail.com",
        "phone": "+33 6 00 00 00 00",
        "location": "France"
    }


def record_interview_qa_backend(
    session_id: str,
    question: str,
    answer: str,
    model: str = "fuelix"
) -> None:
    """Stores an interview Q&A entry into Supabase."""
    try:
        conn = get_db_connection()
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO public.interview_qa (session_id, question, suggested_answer, model_used)
            VALUES (%s, %s, %s, %s);
        """, (session_id, question, answer, model))
        cur.close()
        conn.close()
    except Exception as e:
        print(f"[Supabase] Error recording interview QA: {e}")
