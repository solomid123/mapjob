# -*- coding: utf-8 -*-
"""
The prospecting ledger.

Outreach is a pipeline with memory. A company is found, a contact is guessed,
an address is proved to exist, a letter is written, a dossier is assembled, a
message goes out -- and every one of those steps can fail, be retried next
week, or be the reason this address must never be written to again. So the
table of prospects and their stage is the feature; the integrations hang off
it.

Its own SQLite file, beside the other automation state. Nothing in here
touches a network, which is what makes it testable and what keeps a failed
API call from losing the record of what was already done.
"""

import json
import os
import queue
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DB_PATH = Path(__file__).with_name("outreach.db")

# Stages a prospect moves through, in order. Kept as plain strings because the
# dashboard counts them and a migration is cheaper than an enum.
STAGES = ("new", "verified", "letter", "dossier", "sent", "replied", "failed")
EMAIL_STATUSES = ("unknown", "guessed", "valid", "risky", "invalid")

_lock = threading.Lock()
_subscribers: List["queue.Queue[str]"] = []


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS prospects (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key    TEXT UNIQUE,
                company       TEXT NOT NULL,
                contact_name  TEXT DEFAULT '',
                role          TEXT DEFAULT '',
                email         TEXT DEFAULT '',
                email_status  TEXT DEFAULT 'unknown',
                website       TEXT DEFAULT '',
                city          TEXT DEFAULT '',
                source        TEXT DEFAULT 'manual',
                stage         TEXT DEFAULT 'new',
                notes         TEXT DEFAULT '',
                created_at    TEXT,
                updated_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                prospect_id INTEGER,
                level       TEXT DEFAULT 'info',
                phase       TEXT DEFAULT 'pipeline',
                message     TEXT DEFAULT '',
                created_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS documents (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                prospect_id INTEGER,
                subject     TEXT DEFAULT '',
                body        TEXT DEFAULT '',
                pdf_path    TEXT DEFAULT '',
                dry_run     INTEGER DEFAULT 1,
                sent_at     TEXT,
                message_id  TEXT DEFAULT '',
                created_at  TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
            CREATE INDEX IF NOT EXISTS idx_docs_prospect ON documents(prospect_id);
            """
        )
        _add_columns(conn)
        _add_document_columns(conn)


# Columns added after the first version shipped. SQLite has no "ADD COLUMN IF
# NOT EXISTS", and a migration framework for four columns on a per-machine
# ledger would be ceremony -- but dropping the table would throw away the
# user's companies, which is not a migration, it is a loss.
LATER_COLUMNS = (
    # Published by the employer, or inferred from a naming pattern. Never the
    # same thing, and the difference has to survive a restart: a guessed
    # address that gets mistaken for a published one is how a letter goes to
    # somebody who never existed.
    ("email_kind", "TEXT DEFAULT ''"),
    ("source_url", "TEXT DEFAULT ''"),
    # What the verifier said, in words, and when. "risky" without its reason is
    # a shrug, and a verdict without a date is a verdict about a mailbox that
    # may have been closed since.
    ("verify_reason", "TEXT DEFAULT ''"),
    ("verify_score", "INTEGER DEFAULT 0"),
    ("verified_at", "TEXT DEFAULT ''"),
    # A job board that prints a postal address and a telephone number alongside
    # the email. The telephone is not a fallback for a failed verification --
    # it is often the better approach for an apprenticeship, where a two-minute
    # call reaches the person a hundred emails do not.
    ("phone", "TEXT DEFAULT ''"),
    ("street", "TEXT DEFAULT ''"),
    ("postcode", "TEXT DEFAULT ''"),
    # The board's own reference. Kept so a second run over the same search
    # recognises a listing it has already read, even after the employer renames
    # the role.
    ("ref", "TEXT DEFAULT ''"),
)


def _add_columns(conn: sqlite3.Connection) -> None:
    have = {row["name"] for row in conn.execute("PRAGMA table_info(prospects)").fetchall()}
    for name, spec in LATER_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE prospects ADD COLUMN {name} {spec}")


# An application is more than one file, and the previewer has to be able to
# show each of them. `pdf_path` holds the whole pack -- letter then CV, one
# document to page through -- and these two hold the pieces that were actually
# attached to the message. Deriving the letter's name from the pack's by string
# surgery was the first attempt, and it worked in German and silently returned
# the pack in French.
DOCUMENT_COLUMNS = (
    ("letter_path", "TEXT DEFAULT ''"),
    ("cv_path", "TEXT DEFAULT ''"),
    ("language", "TEXT DEFAULT ''"),
)


def _add_document_columns(conn: sqlite3.Connection) -> None:
    have = {row["name"] for row in conn.execute("PRAGMA table_info(documents)").fetchall()}
    for name, spec in DOCUMENT_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE documents ADD COLUMN {name} {spec}")


def _dedupe_key(company: str, ident: str) -> str:
    """One prospect is one person at one company; `ident` names the person."""
    return f"{company.strip().lower()}|{(ident or '').strip().lower()}"


def _find_existing(conn: sqlite3.Connection, company: str, email: str,
                   contact: str) -> Optional[sqlite3.Row]:
    """
    Match on the address first, then on the contact name.

    Both are needed, and the first version of this got it wrong: keying on
    "email or contact name" meant the pass that finally *found* the address
    computed a different key from the pass that had only the name, and filed a
    second copy of the same person. Discovery almost always arrives in that
    order, so the duplicate was the normal case rather than the edge one.
    """
    candidates = []
    if email:
        candidates.append(_dedupe_key(company, email))
    if contact:
        candidates.append(_dedupe_key(company, contact))
    if not candidates:
        candidates.append(_dedupe_key(company, ""))
    for key in candidates:
        row = conn.execute("SELECT * FROM prospects WHERE dedupe_key=?", (key,)).fetchone()
        if row is not None:
            return row
    return None


def publish(event: Dict[str, Any]) -> None:
    """Fan one pipeline line out to every open stream, dropping slow readers."""
    payload = json.dumps(event, ensure_ascii=False)
    with _lock:
        listeners = list(_subscribers)
    for q in listeners:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass


def subscribe() -> "queue.Queue[str]":
    q: "queue.Queue[str]" = queue.Queue(maxsize=500)
    with _lock:
        _subscribers.append(q)
    return q


def unsubscribe(q: "queue.Queue[str]") -> None:
    with _lock:
        if q in _subscribers:
            _subscribers.remove(q)


def log_event(message: str, phase: str = "pipeline", level: str = "info",
              prospect_id: Optional[int] = None) -> Dict[str, Any]:
    """Write one line of the pipeline log and push it to anyone watching."""
    created = _now()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO events (prospect_id, level, phase, message, created_at)"
            " VALUES (?,?,?,?,?)",
            (prospect_id, level, phase, message, created),
        )
        event_id = cur.lastrowid
    event = {
        "id": event_id,
        "prospect_id": prospect_id,
        "level": level,
        "phase": phase,
        "message": message,
        "created_at": created,
    }
    publish(event)
    return event


def list_events(limit: int = 200) -> List[Dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def upsert_prospect(data: Dict[str, Any], source: str = "manual") -> Tuple[Dict[str, Any], bool]:
    """
    Add a prospect, or fill in the one already on file. Returns (row, created).

    An import that overwrote what it found would be destructive: discovery runs
    twice over the same company, and the second pass often knows less than the
    first (no contact name, no address). So a field is only written when it
    arrives non-empty, and a verified address is never demoted by a later guess.
    """
    company = (data.get("company") or "").strip()
    if not company:
        raise ValueError("A prospect needs a company name.")
    email = (data.get("email") or "").strip()
    contact = (data.get("contact_name") or "").strip()
    key = _dedupe_key(company, email or contact)
    now = _now()

    with connect() as conn:
        existing = _find_existing(conn, company, email, contact)
        if existing is None:
            conn.execute(
                "INSERT INTO prospects (dedupe_key, company, contact_name, role, email,"
                " email_status, website, city, source, stage, notes, email_kind,"
                " source_url, phone, street, postcode, ref, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    key, company, contact, (data.get("role") or "").strip(), email,
                    (data.get("email_status") or ("guessed" if email else "unknown")),
                    (data.get("website") or "").strip(), (data.get("city") or "").strip(),
                    source, (data.get("stage") or "new"), (data.get("notes") or "").strip(),
                    (data.get("email_kind") or ("published" if email else "")),
                    (data.get("source_url") or "").strip(),
                    (data.get("phone") or "").strip(),
                    (data.get("street") or "").strip(),
                    (data.get("postcode") or "").strip(),
                    (data.get("ref") or "").strip(),
                    now, now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM prospects WHERE dedupe_key = ?", (key,)
            ).fetchone()
            created = True
        else:
            merged = dict(existing)
            for field in ("contact_name", "role", "email", "website", "city", "notes",
                          "email_kind", "source_url", "phone", "street", "postcode",
                          "ref"):
                value = (data.get(field) or "").strip()
                if value:
                    merged[field] = value
            # A proved address outranks anything a later pass guesses about it.
            incoming_status = data.get("email_status")
            if incoming_status and merged["email_status"] not in ("valid", "invalid"):
                merged["email_status"] = incoming_status
            if data.get("stage"):
                merged["stage"] = data["stage"]
            # Re-key onto the address once one is known, so the row this pass
            # found by name is the row the next pass finds by address.
            new_key = _dedupe_key(company, merged["email"] or merged["contact_name"])
            if new_key != merged["dedupe_key"]:
                clash = conn.execute(
                    "SELECT id FROM prospects WHERE dedupe_key=? AND id<>?",
                    (new_key, merged["id"]),
                ).fetchone()
                if clash is None:
                    conn.execute(
                        "UPDATE prospects SET dedupe_key=? WHERE id=?",
                        (new_key, merged["id"]),
                    )
            conn.execute(
                "UPDATE prospects SET contact_name=?, role=?, email=?, email_status=?,"
                " website=?, city=?, notes=?, stage=?, email_kind=?, source_url=?,"
                " phone=?, street=?, postcode=?, ref=?, updated_at=? WHERE id=?",
                (
                    merged["contact_name"], merged["role"], merged["email"],
                    merged["email_status"], merged["website"], merged["city"],
                    merged["notes"], merged["stage"],
                    merged.get("email_kind") or ("published" if merged["email"] else ""),
                    merged.get("source_url") or "",
                    merged.get("phone") or "", merged.get("street") or "",
                    merged.get("postcode") or "", merged.get("ref") or "",
                    now, merged["id"],
                ),
            )
            row = conn.execute(
                "SELECT * FROM prospects WHERE id = ?", (merged["id"],)
            ).fetchone()
            created = False
    return dict(row), created


def update_prospect(prospect_id: int, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    allowed = ("company", "contact_name", "role", "email", "email_status",
               "website", "city", "stage", "notes", "email_kind", "source_url",
               "verify_reason", "verify_score", "verified_at",
               "phone", "street", "postcode", "ref")
    sets, values = [], []
    for name in allowed:
        if name in fields:
            sets.append(f"{name}=?")
            values.append(fields[name])
    if not sets:
        return get_prospect(prospect_id)
    sets.append("updated_at=?")
    values.extend([_now(), prospect_id])
    with connect() as conn:
        conn.execute(f"UPDATE prospects SET {', '.join(sets)} WHERE id=?", values)
    return get_prospect(prospect_id)


def get_prospect(prospect_id: int) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM prospects WHERE id=?", (prospect_id,)).fetchone()
    return dict(row) if row else None


def delete_prospect(prospect_id: int) -> bool:
    with connect() as conn:
        cur = conn.execute("DELETE FROM prospects WHERE id=?", (prospect_id,))
    return cur.rowcount > 0


def list_prospects(query: str = "", stage: str = "", page: int = 1,
                   page_size: int = 20) -> Dict[str, Any]:
    """Newest first, because the ones just found are the ones being worked on."""
    page = max(1, int(page or 1))
    page_size = min(100, max(1, int(page_size or 20)))
    where, params = [], []
    if query:
        like = f"%{query.strip().lower()}%"
        where.append(
            "(lower(company) LIKE ? OR lower(contact_name) LIKE ?"
            " OR lower(email) LIKE ? OR lower(city) LIKE ?)"
        )
        params.extend([like, like, like, like])
    if stage:
        where.append("stage = ?")
        params.append(stage)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    with connect() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) FROM prospects{clause}", params
        ).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM prospects{clause} ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size],
        ).fetchall()
    return {
        "items": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
    }


def record_document(prospect_id: int, subject: str, body: str, pdf_path: str = "",
                    dry_run: bool = True, sent_at: Optional[str] = None,
                    message_id: str = "", letter_path: str = "",
                    cv_path: str = "", language: str = "") -> Dict[str, Any]:
    """
    What was written to whom, kept whether or not it was sent.

    A dry run is a document too: the point of a dry run is to read the thing
    that *would* have gone out, and a preview you cannot open afterwards is
    not a preview.
    """
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO documents (prospect_id, subject, body, pdf_path, dry_run,"
            " sent_at, message_id, letter_path, cv_path, language, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (prospect_id, subject, body, pdf_path, 1 if dry_run else 0,
             sent_at, message_id, letter_path, cv_path, language, _now()),
        )
        row = conn.execute("SELECT * FROM documents WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def clear_drafts(prospect_id: int) -> int:
    """
    Throw away this prospect's previous unsent drafts.

    A dry run rewrites the letter, and the old one is of no interest: leaving
    it behind means three identical entries for the same company after three
    rehearsals, and the reviewer cannot tell which one the live run will
    actually send. Rows that were really sent are never touched -- those are
    the record of what a company received.
    """
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM documents WHERE prospect_id=? AND dry_run=1"
            " AND sent_at IS NULL", (prospect_id,))
    return int(cur.rowcount or 0)


def delete_documents(ids: List[int]) -> Dict[str, Any]:
    """
    Remove records, and report which files they were holding.

    The caller deletes the files, not this module -- this one does not touch a
    disk it does not own. The paths come back so nothing is orphaned in the
    dossiers folder after its ledger row is gone.

    Deleting the record of a real send does not license a second letter to that
    employer: the prospect's own stage still reads `sent`, and that is the check
    a campaign makes before writing. Two locks, and this only opens one.
    """
    wanted = [int(x) for x in (ids or [])][:500]
    if not wanted:
        return {"removed": 0, "paths": [], "sent_removed": 0}
    marks = ",".join("?" * len(wanted))
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id, pdf_path, letter_path, cv_path, dry_run, sent_at"
            f" FROM documents WHERE id IN ({marks})", wanted).fetchall()
        paths, sent_removed = [], 0
        for row in rows:
            for key in ("pdf_path", "letter_path", "cv_path"):
                value = (row[key] or "").strip()
                if value:
                    paths.append(value)
            if not row["dry_run"] and row["sent_at"]:
                sent_removed += 1
        cur = conn.execute(f"DELETE FROM documents WHERE id IN ({marks})", wanted)
    return {"removed": int(cur.rowcount or 0), "paths": sorted(set(paths)),
            "sent_removed": sent_removed}


def draft_document_ids() -> List[int]:
    """Every rehearsal still on file. Real sends are not drafts and not here."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id FROM documents WHERE dry_run=1 AND sent_at IS NULL"
        ).fetchall()
    return [int(r["id"]) for r in rows]


def list_documents(limit: int = 100) -> List[Dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT d.*, p.company, p.contact_name, p.email FROM documents d"
            " LEFT JOIN prospects p ON p.id = d.prospect_id"
            " ORDER BY d.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def stats() -> Dict[str, int]:
    with connect() as conn:
        def one(sql: str, params: Tuple = ()) -> int:
            return int(conn.execute(sql, params).fetchone()[0] or 0)

        by_stage = {
            row["stage"]: row["n"]
            for row in conn.execute(
                "SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage"
            ).fetchall()
        }
        return {
            "prospects": one("SELECT COUNT(*) FROM prospects"),
            "emails_sent": one("SELECT COUNT(*) FROM documents WHERE dry_run=0 AND sent_at IS NOT NULL"),
            "dry_runs": one("SELECT COUNT(*) FROM documents WHERE dry_run=1"),
            "dossiers": one("SELECT COUNT(*) FROM documents WHERE pdf_path <> ''"),
            "verified_addresses": one("SELECT COUNT(*) FROM prospects WHERE email_status='valid'"),
            "pending": one(
                "SELECT COUNT(*) FROM prospects WHERE stage IN ('new','verified','letter','dossier')"
            ),
            **{f"stage_{name}": by_stage.get(name, 0) for name in STAGES},
        }


init_db()
