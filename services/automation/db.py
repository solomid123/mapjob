# -*- coding: utf-8 -*-
"""
Database manager for the autonomous job application engine.
Maintains history of all applied jobs, checkpoints, and application recipes using SQLite.
"""

import sqlite3
import json
import time
from pathlib import Path
from typing import Dict, List, Any, Optional

DB_PATH = Path(__file__).resolve().parent / "automation_vault.db"

def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def init_db() -> None:
    """Initialize database tables for applications and recipes."""
    with get_connection() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS job_applications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_url TEXT NOT NULL UNIQUE,
            external_id TEXT,
            company TEXT,
            title TEXT,
            ats_platform TEXT,
            match_score INTEGER DEFAULT 0,
            status TEXT NOT NULL, -- 'PENDING', 'APPLIED', 'SKIPPED', 'NEEDS_CHECKPOINT', 'FAILED'
            checkpoint_reason TEXT, -- 'CAPTCHA', 'MFA', 'UNKNOWN_CUSTOM_QUESTION', 'LOGIN_REQUIRED'
            screenshot_path TEXT,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS application_recipes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL UNIQUE,
            ats_type TEXT NOT NULL,
            recipe_json TEXT NOT NULL,
            success_count INTEGER DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_apps_status ON job_applications(status);
        CREATE INDEX IF NOT EXISTS idx_apps_url ON job_applications(job_url);
        CREATE INDEX IF NOT EXISTS idx_recipes_domain ON application_recipes(domain);
        """)

def is_already_applied(job_url: str) -> bool:
    """Checks if a job URL was already successfully applied to."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM job_applications WHERE job_url = ? AND status = 'APPLIED'",
            (job_url,)
        ).fetchone()
        return row is not None

def record_application_status(
    job_url: str,
    status: str,
    company: str = "",
    title: str = "",
    ats_platform: str = "",
    external_id: str = "",
    match_score: int = 0,
    checkpoint_reason: str = "",
    screenshot_path: str = "",
    error_message: str = ""
) -> int:
    """Inserts or updates an application entry in the database."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO job_applications (
                job_url, external_id, company, title, ats_platform, match_score,
                status, checkpoint_reason, screenshot_path, error_message, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(job_url) DO UPDATE SET
                status = excluded.status,
                checkpoint_reason = excluded.checkpoint_reason,
                screenshot_path = excluded.screenshot_path,
                error_message = excluded.error_message,
                updated_at = CURRENT_TIMESTAMP
        """, (
            job_url, external_id, company, title, ats_platform, match_score,
            status, checkpoint_reason, screenshot_path, error_message
        ))
        return cursor.lastrowid or 0

def get_stats() -> Dict[str, int]:
    """Returns application counts by status."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) as cnt FROM job_applications GROUP BY status"
        ).fetchall()
        stats = {
            "APPLIED": 0,
            "NEEDS_CHECKPOINT": 0,
            "SKIPPED": 0,
            "FAILED": 0,
            "PENDING": 0
        }
        for r in rows:
            stats[r["status"]] = r["cnt"]
        return stats

def get_recipe(domain: str) -> Optional[Dict[str, Any]]:
    """Retrieves cached application recipe for a domain."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT recipe_json FROM application_recipes WHERE domain = ?",
            (domain.lower(),)
        ).fetchone()
        if row:
            try:
                return json.loads(row["recipe_json"])
            except Exception:
                return None
        return None

def save_recipe(domain: str, ats_type: str, recipe: Dict[str, Any]) -> None:
    """Saves or updates verified application recipe."""
    with get_connection() as conn:
        recipe_str = json.dumps(recipe)
        conn.execute("""
            INSERT INTO application_recipes (domain, ats_type, recipe_json, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(domain) DO UPDATE SET
                recipe_json = excluded.recipe_json,
                success_count = success_count + 1,
                updated_at = CURRENT_TIMESTAMP
        """, (domain.lower(), ats_type, recipe_str))

# Initialize on import
init_db()
