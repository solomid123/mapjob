# -*- coding: utf-8 -*-
"""
Who this app is working for.

Until now there was one candidate, written into a Python dict, and every module
simply knew it. That was never true: this app is used by two people with
opposite searches. Badreddine is looking for mechanical engineering work, in
France, applying in French and English. Chaimaa is looking for an Ausbildung in
Germany, where the letter, the interview and very often the form are in German.
Treating them as one person does not merely mix up two profiles; it sends a
French letter to a German Handwerksbetrieb, which is not an application.

So a person is a first-class thing here, and everything that used to be global
-- the profile, the held documents, the language a letter is written in, the
language the interview helper speaks -- hangs off one. The row lives in
Postgres so a deployment has it; this module is the only place that decides
what to do when the database is unreachable, which is to fall back to the two
accounts below rather than to no accounts at all.

The id is a short slug, never an email address: it goes in URLs and in storage
paths, and an email in a storage path is an email in a bucket listing.
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

from services.automation import cloud

# The accounts, as they are without a database. Not a cache of the table: the
# table is seeded from this, and this is what the app runs on if Postgres is
# down mid-application.
FALLBACK: Dict[str, Dict[str, Any]] = {
    "badreddine": {
        "id": "badreddine",
        "display_name": "Badreddine Barki",
        "focus": "Mechanical engineering roles",
        # The language a cover letter is written in when the advert does not
        # decide it: French at home, English abroad.
        "letter_language": "fr",
        "interview_language": "en",
        "country": "France",
        # A letter and a CV, which is what an employer in France or the UK
        # expects to open.
        "application_style": "pair",
    },
    "chaimaa": {
        "id": "chaimaa",
        "display_name": "Chaimaa Barki",
        "focus": "Ausbildung places in Germany",
        # German, throughout. An Ausbildung application in English is read as a
        # candidate who cannot follow the Berufsschule.
        "letter_language": "de",
        "interview_language": "de",
        "country": "Germany",
        # A German application is a bound dossier that opens on a cover sheet:
        # Deckblatt, Anschreiben, Lebenslauf, Zeugnisse, in that order and in
        # one file. Of it, only the Anschreiben and the post named on the
        # Deckblatt are written for the employer; the Lebenslauf and the
        # certificates are the same documents every time, as they have to be.
        "application_style": "german_dossier",
    },
}

DEFAULT = "badreddine"

_SLUG = re.compile(r"[^a-z0-9_-]+")


def slug(name: str) -> str:
    return _SLUG.sub("", (name or "").strip().lower())[:40]


# The accounts, briefly, with the moment they were read.
#
# There are two of them and they change when somebody edits the database, which
# is to say almost never -- but `get` calls `resolve`, `resolve` calls this, and
# every letter, form field and interview answer calls `get`. That was two
# Postgres round trips, about a second, in front of every answer the interview
# helper writes while a recruiter waits. A minute is short enough that adding an
# account shows up on the next page load and long enough that a live interview
# never pays for it twice.
_CACHE: List[Dict[str, Any]] = []
_CACHE_AT = 0.0
_CACHE_TTL = 60.0


def forget() -> None:
    """Drop the cached accounts, for a write that has just changed one."""
    global _CACHE, _CACHE_AT
    _CACHE, _CACHE_AT = [], 0.0


def all_people() -> List[Dict[str, Any]]:
    """
    The accounts, the stored row over the built-in one for each.

    Same rule as `get`: a table that predates a column must not answer for it.
    """
    global _CACHE, _CACHE_AT
    if _CACHE and (time.time() - _CACHE_AT) < _CACHE_TTL:
        return [dict(p) for p in _CACHE]
    rows = cloud.select("app_users", order="id")
    if not rows:
        # Not cached: the database being down for a moment must not fix the
        # fallback list in place for the next minute of a working app.
        return [dict(FALLBACK[k]) for k in sorted(FALLBACK)]
    merged = []
    for row in rows:
        base = dict(FALLBACK.get(str(row.get("id"))) or {})
        base.update({k: v for k, v in row.items() if v not in (None, "")})
        merged.append(base)
    _CACHE, _CACHE_AT = [dict(p) for p in merged], time.time()
    return merged


def resolve(name: Optional[str]) -> str:
    """
    The id a request is about.

    Unknown names fall back rather than raising: a stale tab asking for a user
    that was renamed should show somebody's profile, not a 404 where the page
    used to be. It is the same reason the id is validated at all -- it becomes a
    folder name and a storage prefix further down.
    """
    wanted = slug(name or "")
    if not wanted:
        return DEFAULT
    known = {str(p.get("id")) for p in all_people()}
    return wanted if wanted in known else DEFAULT


def get(user_id: Optional[str] = None) -> Dict[str, Any]:
    """
    One person, with the row laid over the defaults rather than replacing them.

    A column added to the code today does not exist in a table created last
    week, and a row read from that table would otherwise answer "nothing" for
    it -- which is how Chaimaa's application style silently became the wrong
    one the moment the database came back up. The row wins wherever it has
    something to say, and is quiet where it has not.
    """
    who = resolve(user_id)
    base = dict(FALLBACK.get(who) or {})
    for person in all_people():
        if str(person.get("id")) == who:
            base.update({k: v for k, v in person.items() if v not in (None, "")})
            return base
    return base or dict(FALLBACK[DEFAULT])


def letter_language(user_id: Optional[str] = None) -> str:
    return str(get(user_id).get("letter_language") or "en")


def interview_language(user_id: Optional[str] = None) -> str:
    return str(get(user_id).get("interview_language") or "en")


def application_style(user_id: Optional[str] = None) -> str:
    """"pair" or "german_dossier" -- what an application from this person is.

    Read from the person and not from the advert's country: somebody applying
    from a German dossier sends the same dossier to the Swiss branch, and
    somebody who sends a letter and a CV does not start attaching Deckblätter
    because one vacancy happens to be in Hamburg.
    """
    return str(get(user_id).get("application_style") or "pair")


# --- the door's lock -------------------------------------------------------
#
# Each account has a password. Be clear about what it is and what it is not.
#
# What it is: a lock on the front door of the app, so that picking a name off a
# list is no longer enough to open somebody's profile, documents and drafts on
# a shared machine. The check happens here, on the server, so the answer is not
# sitting in a JavaScript bundle for anyone who opens the dev tools.
#
# What it is not: authentication. Nothing downstream is protected by it. Every
# API route in this app still answers for whatever `user=` it is handed, so a
# person who can reach port 8000 can read either account's data without ever
# passing this check. Making that false is a session token and a check on every
# route -- real work, deliberately not pretended at here. This function is the
# seam that work will go through, and until it is done this lock keeps two
# people who trust each other out of each other's things, and nothing more.
#
# The default is "1234", which is to say there is no secret in this repository
# and none of the below is hiding one. A deployment sets a real password per
# account in `.env`:
#
#     MAPJOB_PASSWORD_CHAIMAA=something-long
#     MAPJOB_PASSWORD_CHAIMAA=sha256:9f86d0818...   # or the digest, not the word
#
# `MAPJOB_PASSWORD` sets one for every account that has no line of its own.

DEFAULT_PASSWORD = "1234"


def _password_for(user_id: str) -> str:
    import os

    from services.automation.config import load_env

    load_env()
    slot = "MAPJOB_PASSWORD_" + slug(user_id).upper().replace("-", "_")
    return ((os.getenv(slot) or "").strip()
            or (os.getenv("MAPJOB_PASSWORD") or "").strip()
            or DEFAULT_PASSWORD)


def password_ok(user_id: Optional[str], password: Optional[str]) -> bool:
    """
    Whether this is the account's password.

    `compare_digest` rather than `==` because the obvious comparison returns
    early at the first wrong character, and the time it takes is a measurement
    of how much of the password is right. The cost of not leaking that is one
    function call.
    """
    import hashlib
    import hmac

    who = resolve(user_id)
    given = password or ""
    expected = _password_for(who)
    if expected.lower().startswith("sha256:"):
        digest = hashlib.sha256(given.encode("utf-8")).hexdigest()
        return hmac.compare_digest(digest, expected.split(":", 1)[1].strip().lower())
    return hmac.compare_digest(given, expected)


def password_is_default(user_id: Optional[str] = None) -> bool:
    """For a deployment check that wants to say so out loud before it ships."""
    return _password_for(resolve(user_id)) == DEFAULT_PASSWORD
