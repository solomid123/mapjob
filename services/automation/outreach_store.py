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

import contextvars
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

            /*
             * Every message that actually left, and the one table nothing in
             * the app deletes.
             *
             * The daily cap and the "have we already written to them?" check
             * used to be counted off `documents`, which was fine until
             * documents became deletable. Then clearing out old applications
             * silently reset the day's allowance and re-opened employers for a
             * second letter -- a cap you can clear by tidying up is not a cap,
             * and the account it protects is the user's own mailbox.
             *
             * So the fact of sending is recorded apart from the copy of what
             * was sent. Deleting the letter throws away the letter. It does not
             * make the letter un-received.
             */
            CREATE TABLE IF NOT EXISTS sends (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                prospect_id INTEGER,
                to_email    TEXT DEFAULT '',
                message_id  TEXT DEFAULT '',
                sent_at     TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
            CREATE INDEX IF NOT EXISTS idx_docs_prospect ON documents(prospect_id);
            CREATE INDEX IF NOT EXISTS idx_sends_at ON sends(sent_at);
            CREATE INDEX IF NOT EXISTS idx_sends_prospect ON sends(prospect_id);
            """
        )
        _add_columns(conn)
        _add_event_columns(conn)
        _add_document_columns(conn)
        _backfill_sends(conn)
        _backfill_job_titles(conn)
        _seed_from_file(conn)


def _backfill_sends(conn: sqlite3.Connection) -> None:
    """
    Seed the send log from the documents that predate it.

    Runs once: on a ledger that already has real sends on file but an empty
    `sends` table, those sends are history and forgetting them would hand a
    warm mailbox a fresh allowance the first time the app restarts.
    """
    if conn.execute("SELECT 1 FROM sends LIMIT 1").fetchone() is not None:
        return
    conn.execute(
        "INSERT INTO sends (prospect_id, to_email, message_id, sent_at)"
        " SELECT prospect_id, '', COALESCE(message_id, ''), sent_at FROM documents"
        " WHERE dry_run=0 AND sent_at IS NOT NULL")


def _backfill_job_titles(conn: sqlite3.Connection) -> None:
    """
    Recover the vacancy of board prospects filed before it had a column.

    Both engines always knew it -- they wrote it into the free-text notes, the
    board as `Ref: 12345 | Kaufmann/-frau Bueromanagement | Published ...` and
    the website sweeps as `Found for: <trade>`. So the alternative to reading
    it back out is a table where every row found before today says nothing
    about the job, which would make the new column look broken on the only
    data the user currently has.

    Nothing is inferred: only a field that was already the title is taken, and
    the notes' own keywords are excluded, because a wrong title is worse than
    an empty one -- it is the line that decides whether a company is worth
    writing to.
    """
    rows = conn.execute(
        "SELECT id, notes FROM prospects WHERE COALESCE(job_title,'') = ''"
        " AND (notes LIKE 'Ref: %|%' OR notes LIKE 'Found for: %')").fetchall()
    for row in rows:
        notes = str(row["notes"] or "")
        if notes.startswith("Found for: "):
            title = notes[len("Found for: "):].split("|")[0].strip()
        else:
            parts = [p.strip() for p in notes.split("|")]
            titles = [p for p in parts[1:]
                      if p and not p.startswith("Published")
                      and p != "Arbeitnehmerueberlassung"]
            title = titles[0] if titles else ""
        if title:
            conn.execute("UPDATE prospects SET job_title=? WHERE id=?",
                         (title, row["id"]))


def record_send(prospect_id: Optional[int], to_email: str, message_id: str,
                sent_at: str) -> None:
    """Write the fact of a send. Nothing in this module ever removes one."""
    with connect() as conn:
        conn.execute(
            "INSERT INTO sends (prospect_id, to_email, message_id, sent_at)"
            " VALUES (?,?,?,?)",
            (prospect_id, (to_email or "").strip(), (message_id or "").strip(), sent_at))


def sends_since(iso_timestamp: str) -> int:
    with connect() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM sends WHERE sent_at >= ?",
            (iso_timestamp,)).fetchone()[0] or 0)


def has_been_sent_to(prospect_id: int) -> bool:
    with connect() as conn:
        return conn.execute("SELECT 1 FROM sends WHERE prospect_id=? LIMIT 1",
                            (prospect_id,)).fetchone() is not None


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
    # The day the listing the prospect came from was published, as the board
    # printed it. Not the day this app found it: a search run today can return
    # a vacancy advertised last autumn, and the difference decides whether a
    # spontaneous application is timely or is about a job filled in the spring.
    # Empty for prospects that did not come from a dated listing.
    ("posted_at", "TEXT DEFAULT ''"),
    # The vacancy this employer advertised, in the board's own words. Not
    # `role`, which is the contact person's job title ("Ansprechpartner") --
    # these are two different people's jobs and putting them in one column
    # would make both unreadable.
    #
    # It earns its place because a search for one thing returns neighbours of
    # it: ask the board for an office apprenticeship and it will also offer
    # warehouse and retail. Without the title on the row, the only way to see
    # that a company has nothing to do with what was asked is to open the
    # listing, and the cheapest moment to notice is before writing to them.
    ("job_title", "TEXT DEFAULT ''"),
    # Whose prospect. Two people use this app for opposite searches -- French
    # engineering offices and German Handwerksbetriebe -- and one pile of
    # companies is not a shared address book, it is her writing to his
    # employers. Rows written before there were accounts have '' and belong to
    # the account there was then, which is what `_owner` answers with.
    ("user", "TEXT DEFAULT ''"),
)


# Whose ledger a call is about, when the call itself does not say.
#
# A prospecting run is one long thread -- search, verify, write, send -- making
# dozens of calls in here, and threading an account name through every one of
# them is how one gets missed. So the run says once who it is for and the
# context carries it. An explicit `user` argument always wins; a caller that
# says nothing, in a thread that said nothing, gets the default account, which
# is what this app did when it had one.
_ACTING: "contextvars.ContextVar[str]" = contextvars.ContextVar(
    "outreach_account", default="")


def acting_as(user: str = "") -> None:
    """Declare whose run this thread is. Called once, at the top of a run."""
    from services.automation import people

    _ACTING.set(people.resolve(user))


def _owner(user: str = "") -> str:
    from services.automation import people

    return people.resolve(user or _ACTING.get(""))


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


EVENT_COLUMNS = (("user", "TEXT DEFAULT ''"),)


def _add_event_columns(conn: sqlite3.Connection) -> None:
    have = {row["name"] for row in conn.execute("PRAGMA table_info(events)").fetchall()}
    for name, spec in EVENT_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE events ADD COLUMN {name} {spec}")


def _add_document_columns(conn: sqlite3.Connection) -> None:
    have = {row["name"] for row in conn.execute("PRAGMA table_info(documents)").fetchall()}
    for name, spec in DOCUMENT_COLUMNS:
        if name not in have:
            conn.execute(f"ALTER TABLE documents ADD COLUMN {name} {spec}")


def _dedupe_key(company: str, ident: str, user: str = "") -> str:
    """
    One prospect is one person at one company, for one account.

    The account is part of the key because the same employer can legitimately
    be on both lists: a company in Casablanca may advertise an Ausbildung and
    an engineering post, and the second account to find it must get its own
    row rather than silently adopt the first one's contact, stage and sent
    history. The default account's keys are left in the old shape so that
    everything already on file is still found by it.
    """
    who = _owner(user)
    from services.automation import people

    head = "" if who == people.DEFAULT else who + "::"
    return f"{head}{company.strip().lower()}|{(ident or '').strip().lower()}"


def _find_existing(conn: sqlite3.Connection, company: str, email: str,
                   contact: str, user: str = "") -> Optional[sqlite3.Row]:
    """
    Match on the address first, then on the contact name.

    Both are needed, and the first version of this got it wrong: keying on
    "email or contact name" meant the pass that finally *found* the address
    computed a different key from the pass that had only the name, and filed a
    second copy of the same person. Discovery almost always arrives in that
    order, so the duplicate was the normal case rather than the edge one.
    """
    who = _owner(user)
    candidates = []
    if email:
        candidates.append(_dedupe_key(company, email, who))
    if contact:
        candidates.append(_dedupe_key(company, contact, who))
    if not candidates:
        candidates.append(_dedupe_key(company, "", who))
    for key in candidates:
        row = conn.execute(
            "SELECT * FROM prospects WHERE dedupe_key=?"
            " AND COALESCE(NULLIF(user,''), ?) = ?",
            (key, _DEFAULT_OWNER(), who),
        ).fetchone()
        if row is not None:
            return row
    return None


def _DEFAULT_OWNER() -> str:
    from services.automation import people
    return people.DEFAULT


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
              prospect_id: Optional[int] = None, user: str = "") -> Dict[str, Any]:
    """Write one line of the pipeline log and push it to anyone watching."""
    created = _now()
    who = _owner(user)
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO events (prospect_id, level, phase, message, created_at, user)"
            " VALUES (?,?,?,?,?,?)",
            (prospect_id, level, phase, message, created, who),
        )
        event_id = cur.lastrowid
    event = {
        "id": event_id,
        "prospect_id": prospect_id,
        "level": level,
        "phase": phase,
        "message": message,
        "created_at": created,
        # The live log is one stream; the line says whose run wrote it so a
        # page watching it can drop what is not theirs.
        "user": who,
    }
    publish(event)
    return event


def list_events(limit: int = 200, user: str = "") -> List[Dict[str, Any]]:
    who = _owner(user)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE COALESCE(NULLIF(user,''), ?) = ?"
            " ORDER BY id DESC LIMIT ?",
            (_DEFAULT_OWNER(), who, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def upsert_prospect(data: Dict[str, Any], source: str = "manual",
                    user: str = "") -> Tuple[Dict[str, Any], bool]:
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
    who = _owner(user)
    key = _dedupe_key(company, email or contact, who)
    now = _now()

    with connect() as conn:
        existing = _find_existing(conn, company, email, contact, who)
        if existing is None:
            conn.execute(
                "INSERT INTO prospects (dedupe_key, company, contact_name, role, email,"
                " email_status, website, city, source, stage, notes, email_kind,"
                " source_url, phone, street, postcode, ref, posted_at, job_title,"
                " user, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
                    (data.get("posted_at") or "").strip(),
                    (data.get("job_title") or "").strip(),
                    who,
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
                          "ref", "posted_at", "job_title"):
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
            new_key = _dedupe_key(company, merged["email"] or merged["contact_name"], who)
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
                " phone=?, street=?, postcode=?, ref=?, posted_at=?, job_title=?,"
                " updated_at=? WHERE id=?",
                (
                    merged["contact_name"], merged["role"], merged["email"],
                    merged["email_status"], merged["website"], merged["city"],
                    merged["notes"], merged["stage"],
                    merged.get("email_kind") or ("published" if merged["email"] else ""),
                    merged.get("source_url") or "",
                    merged.get("phone") or "", merged.get("street") or "",
                    merged.get("postcode") or "", merged.get("ref") or "",
                    merged.get("posted_at") or "",
                    merged.get("job_title") or "",
                    now, merged["id"],
                ),
            )
            row = conn.execute(
                "SELECT * FROM prospects WHERE id = ?", (merged["id"],)
            ).fetchone()
            created = False
    return dict(row), created


def update_prospect(prospect_id: int, fields: Dict[str, Any],
                    user: str = "") -> Optional[Dict[str, Any]]:
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
        return get_prospect(prospect_id, user)
    if get_prospect(prospect_id, user) is None:
        # Not this account's row. Nothing is said about whether it exists.
        return None
    sets.append("updated_at=?")
    values.extend([_now(), prospect_id])
    with connect() as conn:
        conn.execute(f"UPDATE prospects SET {', '.join(sets)} WHERE id=?", values)
    return get_prospect(prospect_id, user)


def get_prospect(prospect_id: int, user: str = "") -> Optional[Dict[str, Any]]:
    """One row, if it belongs to this account. Otherwise nothing at all."""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM prospects WHERE id=?"
            " AND COALESCE(NULLIF(user,''), ?) = ?",
            (prospect_id, _DEFAULT_OWNER(), _owner(user)),
        ).fetchone()
    return dict(row) if row else None


def delete_prospect(prospect_id: int, user: str = "") -> bool:
    with connect() as conn:
        cur = conn.execute(
            "DELETE FROM prospects WHERE id=?"
            " AND COALESCE(NULLIF(user,''), ?) = ?",
            (prospect_id, _DEFAULT_OWNER(), _owner(user)),
        )
    return cur.rowcount > 0


def list_prospects(query: str = "", stage: str = "", page: int = 1,
                   page_size: int = 20, user: str = "") -> Dict[str, Any]:
    """
    This account's prospects, newest first: the ones just found are the ones
    being worked on.

    Never both accounts'. The prospecting table is a list of strangers this
    person intends to write to, and the other account's list is somebody
    else's correspondence.
    """
    page = max(1, int(page or 1))
    page_size = min(100, max(1, int(page_size or 20)))
    where = ["COALESCE(NULLIF(user,''), ?) = ?"]
    params: List[Any] = [_DEFAULT_OWNER(), _owner(user)]
    if query:
        like = f"%{query.strip().lower()}%"
        # The vacancy is in here too: with a ledger built from several searches,
        # "was this lot the office apprenticeships or the warehouse ones" is a
        # question about the job, and answering it by eye means paging.
        where.append(
            "(lower(company) LIKE ? OR lower(contact_name) LIKE ?"
            " OR lower(email) LIKE ? OR lower(city) LIKE ?"
            " OR lower(job_title) LIKE ?)"
        )
        params.extend([like, like, like, like, like])
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


def get_document(document_id: int, user: str = "") -> Optional[Dict[str, Any]]:
    """
    One application, if it is this account's.

    A document belongs to whoever its prospect belongs to. Asking by number is
    how the previewer opens a PDF, and a number is easy to guess, so the answer
    for somebody else's application is the same as for one that never existed.
    """
    with connect() as conn:
        row = conn.execute(
            "SELECT d.* FROM documents d JOIN prospects p ON p.id = d.prospect_id"
            " WHERE d.id = ? AND COALESCE(NULLIF(p.user,''), ?) = ?",
            (int(document_id), _DEFAULT_OWNER(), _owner(user)),
        ).fetchone()
    return dict(row) if row is not None else None


def delete_documents(ids: List[int], user: str = "") -> Dict[str, Any]:
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
    # Only this account's applications, whichever numbers were asked for. The
    # ids come off a page as plain integers, and the other account's letters
    # are not this page's to delete -- nor its PDFs to unlink from disk.
    mine = (" AND id IN (SELECT d.id FROM documents d"
            " JOIN prospects p ON p.id = d.prospect_id"
            " WHERE COALESCE(NULLIF(p.user,''), ?) = ?)")
    who = [_DEFAULT_OWNER(), _owner(user)]
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id, pdf_path, letter_path, cv_path, dry_run, sent_at"
            f" FROM documents WHERE id IN ({marks})" + mine,
            wanted + who).fetchall()
        paths, sent_removed = [], 0
        for row in rows:
            for key in ("pdf_path", "letter_path", "cv_path"):
                value = (row[key] or "").strip()
                if value:
                    paths.append(value)
            if not row["dry_run"] and row["sent_at"]:
                sent_removed += 1
        cur = conn.execute(
            f"DELETE FROM documents WHERE id IN ({marks})" + mine,
            wanted + who)
    return {"removed": int(cur.rowcount or 0), "paths": sorted(set(paths)),
            "sent_removed": sent_removed}


def draft_document_ids(user: str = "") -> List[int]:
    """
    This account's rehearsals. Real sends are not drafts and not here.

    "Clear the drafts" is a button on one person's page, and it clears that
    person's drafts: the other account's unsent letters are not rubbish just
    because somebody else tidied up.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT d.id FROM documents d JOIN prospects p ON p.id = d.prospect_id"
            " WHERE d.dry_run=1 AND d.sent_at IS NULL"
            " AND COALESCE(NULLIF(p.user,''), ?) = ?",
            (_DEFAULT_OWNER(), _owner(user)),
        ).fetchall()
    return [int(r["id"]) for r in rows]


def list_documents(limit: int = 100, user: str = "") -> List[Dict[str, Any]]:
    """
    The letters this account has written.

    A document belongs to whoever its prospect belongs to. One whose prospect
    has been deleted belongs to nobody and is shown to neither of them, which
    is why this joins rather than left-joins.
    """
    with connect() as conn:
        rows = conn.execute(
            "SELECT d.*, p.company, p.contact_name, p.email FROM documents d"
            " JOIN prospects p ON p.id = d.prospect_id"
            " WHERE COALESCE(NULLIF(p.user,''), ?) = ?"
            " ORDER BY d.id DESC LIMIT ?",
            (_DEFAULT_OWNER(), _owner(user), limit),
        ).fetchall()
    return [dict(r) for r in rows]


def stats(user: str = "") -> Dict[str, int]:
    """
    The dashboard numbers, for one account.

    Counting both people's rows under one heading is how a page that had never
    run a search opened on somebody else's fourteen prospects.
    """
    mine = " COALESCE(NULLIF(p.user,''), ?) = ? "
    who: Tuple = (_DEFAULT_OWNER(), _owner(user))
    with connect() as conn:
        def one(sql: str, params: Tuple = ()) -> int:
            return int(conn.execute(sql, params).fetchone()[0] or 0)

        by_stage = {
            row["stage"]: row["n"]
            for row in conn.execute(
                "SELECT p.stage AS stage, COUNT(*) AS n FROM prospects p"
                " WHERE" + mine + "GROUP BY p.stage", who
            ).fetchall()
        }
        docs = ("SELECT COUNT(*) FROM documents d JOIN prospects p"
                " ON p.id = d.prospect_id WHERE" + mine + "AND ")
        return {
            "prospects": one("SELECT COUNT(*) FROM prospects p WHERE" + mine, who),
            "emails_sent": one(docs + "d.dry_run=0 AND d.sent_at IS NOT NULL", who),
            "dry_runs": one(docs + "d.dry_run=1", who),
            "dossiers": one(docs + "d.pdf_path <> ''", who),
            "verified_addresses": one(
                "SELECT COUNT(*) FROM prospects p WHERE" + mine
                + "AND p.email_status='valid'", who),
            "pending": one(
                "SELECT COUNT(*) FROM prospects p WHERE" + mine
                + "AND p.stage IN ('new','verified','letter','dossier')", who),
            **{f"stage_{name}": by_stage.get(name, 0) for name in STAGES},
        }


def dump_backup(user: str = "") -> Dict[str, Any]:
    """Export all prospects, sends, and mailboxes for this account."""
    who = (_DEFAULT_OWNER(), _owner(user))
    with connect() as conn:
        prospect_rows = conn.execute(
            "SELECT * FROM prospects WHERE COALESCE(NULLIF(user,''), ?) = ?", who
        ).fetchall()
        sends_rows = conn.execute("SELECT * FROM sends").fetchall()

    prospects = [dict(r) for r in prospect_rows]
    sends = [dict(r) for r in sends_rows]

    mailboxes = {}
    try:
        from services.automation import mailbox
        if mailbox.STORE.exists():
            mailboxes = json.loads(mailbox.STORE.read_text(encoding="utf-8"))
    except Exception:
        pass

    return {
        "version": 1,
        "user": _owner(user),
        "exported_at": _now(),
        "prospects": prospects,
        "sends": sends,
        "mailboxes": mailboxes,
    }


def restore_backup(data: Dict[str, Any], user: str = "") -> Dict[str, int]:
    """
    Restore prospects, sends, and mailboxes from a backup dict.
    Upserts prospects and inserts missing sends.
    """
    target_user = _owner(user or data.get("user") or "")
    prospects = data.get("prospects") or []
    sends = data.get("sends") or []
    mailboxes = data.get("mailboxes") or {}

    p_restored = 0
    s_restored = 0

    with connect() as conn:
        for p in prospects:
            key = p.get("dedupe_key")
            if not key:
                key = f"{p.get('company', '').lower()}::{p.get('email', '').lower()}::{target_user}"

            existing = conn.execute(
                "SELECT id FROM prospects WHERE dedupe_key = ? OR (lower(company)=? AND lower(email)=? AND COALESCE(NULLIF(user,''), ?)=?)",
                (key, str(p.get("company", "")).lower(), str(p.get("email", "")).lower(), _DEFAULT_OWNER(), target_user)
            ).fetchone()

            if existing:
                conn.execute(
                    "UPDATE prospects SET stage=?, notes=?, role=?, job_title=?, email_status=?, website=?, city=? WHERE id=?",
                    (p.get("stage", "new"), p.get("notes", ""), p.get("role", ""), p.get("job_title", ""),
                     p.get("email_status", "unknown"), p.get("website", ""), p.get("city", ""), existing[0])
                )
            else:
                conn.execute(
                    "INSERT INTO prospects (dedupe_key, company, contact_name, role, job_title, email, email_status, website, city, source, stage, notes, user, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (key, p.get("company", ""), p.get("contact_name", ""), p.get("role", ""), p.get("job_title", ""),
                     p.get("email", ""), p.get("email_status", "unknown"), p.get("website", ""), p.get("city", ""),
                     p.get("source", "manual"), p.get("stage", "new"), p.get("notes", ""), target_user,
                     p.get("created_at") or _now(), p.get("updated_at") or _now())
                )
                p_restored += 1

        for s in sends:
            to_email = s.get("to_email", "")
            sent_at = s.get("sent_at", "")
            msg_id = s.get("message_id", "")
            if to_email and sent_at:
                exists = conn.execute(
                    "SELECT 1 FROM sends WHERE to_email = ? AND sent_at = ?", (to_email, sent_at)
                ).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO sends (prospect_id, to_email, message_id, sent_at) VALUES (?, ?, ?, ?)",
                        (s.get("prospect_id"), to_email, msg_id, sent_at)
                    )
                    s_restored += 1

    if mailboxes and isinstance(mailboxes, dict):
        try:
            from services.automation import mailbox
            cur = {}
            if mailbox.STORE.exists():
                try:
                    cur = json.loads(mailbox.STORE.read_text(encoding="utf-8"))
                except Exception:
                    cur = {}
            cur.update(mailboxes)
            mailbox.STORE.parent.mkdir(parents=True, exist_ok=True)
            mailbox.STORE.write_text(json.dumps(cur, indent=2), encoding="utf-8")
        except Exception:
            pass

    return {"prospects_restored": p_restored, "sends_restored": s_restored}


def _seed_from_file(conn: sqlite3.Connection) -> None:
    """If database is empty on fresh container deployment, seed from outreach_seed.json."""
    try:
        count = conn.execute("SELECT COUNT(*) FROM prospects").fetchone()[0]
        if count > 0:
            return
        seed_file = Path(__file__).resolve().parent / "outreach_seed.json"
        if seed_file.exists():
            data = json.loads(seed_file.read_text(encoding="utf-8"))
            restore_backup(data)
    except Exception:
        pass


init_db()
