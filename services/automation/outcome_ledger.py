"""
A durable record of what every application run actually did.

Until now a run that worked was written to Supabase and a run that failed was
written nowhere. That is the wrong way round if you only get to keep one: a
success announces itself -- there is a confirmation page, usually an email --
whereas a failure is silent, and three weeks later there is no way to tell an
employer who was never applied to from one who was applied to twice.

So every terminal outcome lands here, one JSON object per line, appended and
never rewritten. Local, because it has to survive the database being
unreachable and the API key being rotated, which are two of the ways a run
fails in the first place.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional

LEDGER_PATH = os.path.join(os.path.dirname(__file__), "applications.jsonl")

# The whole vocabulary, so that reading the file never turns into guessing what
# some one-off string meant.
OUTCOMES = {
    # The employer's own page confirmed it.
    "applied": "Applied, confirmed by the employer's page",
    # The form went, nothing came back to prove it.
    "sent_unconfirmed": "Sent, but the page showed no confirmation",
    # Filled and left for the candidate to send.
    "awaiting_review": "Filled and waiting for your review",
    # A wall we could not get past: account, CAPTCHA, portal barrier.
    "blocked": "Blocked before the application could be sent",
    # Reached the form, did not finish it. Nothing was sent.
    "not_sent": "Not sent",
    # The run broke: browser closed, driver died, site unreachable.
    "error": "The run stopped before it finished",
    # Stopped by the candidate.
    "cancelled": "Cancelled",
}

_URL_TAIL = re.compile(r"[?#].*$")


def _tidy_url(url: str) -> str:
    """The listing's address without the tracking tail it usually arrives with."""
    return _URL_TAIL.sub("", str(url or "")).strip()


def record_outcome(
    outcome: str,
    company: str = "",
    job_title: str = "",
    url: str = "",
    job_id: Optional[str] = None,
    message: str = "",
    evidence: str = "",
    dry_run: bool = False,
    started_at: Optional[float] = None,
    extra: Optional[Dict[str, Any]] = None,
    user: str = "",
) -> Dict[str, Any]:
    """
    Writes one line for one finished run, and returns what it wrote.

    Never raises. This is called from the last few lines of a run, including
    the ones that are already handling a failure, and a bookkeeping error that
    replaced a real error would be a poor trade.
    """
    record = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "epoch": round(time.time(), 3),
        "outcome": outcome if outcome in OUTCOMES else "error",
        "sent": outcome in ("applied", "sent_unconfirmed"),
        "confirmed": outcome == "applied",
        "company": company or "",
        "job_title": job_title or "",
        "url": _tidy_url(url),
        "job_id": job_id or "",
        "message": (message or "").strip()[:400],
        "evidence": (evidence or "").strip()[:200],
        "dry_run": bool(dry_run),
        "seconds": round(time.time() - started_at, 1) if started_at else None,
        # Whose application. Two people share this file and neither should see
        # the other's history: a line written before there were accounts has no
        # name on it and belongs to the account there was then.
        "user": _owner(user),
    }
    if extra:
        record.update(extra)
    try:
        with open(LEDGER_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        print(f"[Ledger] could not record the outcome: {e}", flush=True)
    return record


def _owner(user: str = "") -> str:
    from services.automation import people
    return people.resolve(user)


def read_outcomes(limit: int = 100, job_id: str = "",
                  user: str = "") -> List[Dict[str, Any]]:
    """This account's most recent runs, newest first. A broken line is skipped.

    Scoped by account, and old lines -- written when this app had one -- answer
    for the account it had. There is no way to ask for everybody's: "did I
    already apply to this" is a question about one person."""
    from services.automation import people

    who = _owner(user)
    try:
        with open(LEDGER_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return []
    except Exception:
        return []

    out: List[Dict[str, Any]] = []
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if job_id and record.get("job_id") != job_id:
            continue
        if (str(record.get("user") or people.DEFAULT)) != who:
            continue
        out.append(record)
        if len(out) >= limit:
            break
    return out


def outcome_for_job(job_id: str, user: str = "") -> Optional[Dict[str, Any]]:
    """The latest attempt at one job, for "you already applied to this" checks."""
    found = read_outcomes(limit=1, job_id=job_id, user=user)
    return found[0] if found else None
