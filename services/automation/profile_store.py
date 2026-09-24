# -*- coding: utf-8 -*-
"""
Each person's profile, editable.

Everything the app says about a candidate -- what goes in an application form,
what the interview helper answers from, who a letter is signed by, what a
tailored CV may claim -- came from a dict written into `candidate_profile.py`
by hand. Editing it meant editing Python and restarting the server, so in
practice it was never edited.

Two things changed here at once, and they are the same change. The edits are
stored per person, because this app is used by two of them and one overlay
would have Chaimaa's Ausbildung search signing Badreddine's name; and they are
stored in Postgres, because a deployed app has no folder of its own to keep
JSON in. The disk copy remains as a mirror, so the apply engine still has a
profile when the database is unreachable mid-application.

Two rules about secrets, both deliberate and both unchanged:

  * `password` and `passwords` are NOT editable here and are never returned.
    A profile page that could read them would leak them to every browser tab,
    screen share and cache. Portal passwords belong in .env.
  * The overlay holds a home address, a phone number and an employment
    history. The mirror is gitignored for the same reason the CV is, and the
    table it lives in has row-level security on with no policies, so the anon
    key shipped in the web bundle cannot read a word of it.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from services.automation import cloud, people

TABLE = "candidate_profiles"

# One file per person, beside the code, as the mirror of the table.
STORE_DIR = Path(os.getenv(
    "CANDIDATE_PROFILE_STORE_DIR",
    str(Path(__file__).resolve().parent / "profiles"),
))

# Where the single-user overlay used to live. Read once, for whoever this app
# belonged to before there were two of them.
LEGACY_PATH = Path(os.getenv(
    "CANDIDATE_PROFILE_STORE",
    str(Path(__file__).resolve().parent / "profile.json"),
))

# What the profile page is allowed to set. An allow-list, so a key added to the
# defaults tomorrow -- another secret, say -- is not writable by an HTTP request
# until someone decides it should be.
EDITABLE: tuple = (
    "first_name", "last_name", "full_name", "email", "phone", "phone_digits",
    "phone_national", "phone_formatted", "address", "postal_code", "city",
    "country", "full_address", "linkedin", "website", "github", "portfolio",
    "current_title", "headline", "summary", "years_of_experience",
    "education", "experiences", "technical_skills", "soft_skills", "languages",
    "certifications", "projects", "publications", "awards", "interests",
    "availability", "notice_period", "salary_expectation", "contract_types",
    "willing_to_relocate", "driving_licence", "work_authorisation",
    "visa_status", "date_of_birth", "nationality", "gender", "pronouns",
    "preferred_language", "cover_letter_notes", "master_cv_html",
)

# Never readable over HTTP, never writable, whatever the request says.
SECRET = ("password", "passwords")


def _path(user: str) -> Path:
    return STORE_DIR / (user + ".json")


def _read(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        # A corrupt mirror must not take the app down: the defaults are still a
        # working profile.
        return {}


def _write(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _clean(overlay: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in (overlay or {}).items() if k not in SECRET}


def load_overlay(user: Optional[str] = None) -> Dict[str, Any]:
    """
    The edits for one person, as stored. Secrets are stripped on the way out.

    Postgres first; the mirror when it cannot be reached. The legacy
    profile.json is folded in once, for the account this app had before it had
    two, so nobody's typed-in history disappears on the day it grew a second
    user.
    """
    who = people.resolve(user)
    rows = cloud.select(TABLE, user_id=who, limit=1)
    if rows:
        overlay = _clean(rows[0].get("overlay") or {})
        _write(_path(who), overlay)
        return overlay

    local = _clean(_read(_path(who)))
    if local:
        return local
    if who == people.DEFAULT:
        return _clean(_read(LEGACY_PATH))
    return {}


def save_overlay(patch: Dict[str, Any], user: Optional[str] = None) -> Dict[str, Any]:
    """
    Merge `patch` into one person's stored edits and return the new overlay.

    The row goes up first and the mirror follows, so the mirror can never be
    ahead of the database. The mirror is still written through a temporary file
    moved into place, because truncating and rewriting loses the lot if the
    process dies in between.
    """
    who = people.resolve(user)
    current = load_overlay(who)
    for key, value in (patch or {}).items():
        if key in SECRET or key not in EDITABLE:
            continue
        if value is None:
            current.pop(key, None)
        else:
            current[key] = value

    cloud.upsert(TABLE, {
        "user_id": who,
        "overlay": current,
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    })
    _write(_path(who), current)
    _CACHE.pop(who, None)
    return current


def apply_to(base: Dict[str, Any], user: Optional[str] = None) -> Dict[str, Any]:
    """
    Lay one person's edits over `base`, in place.

    In place because `CANDIDATE_PROFILE` is imported by name in nine modules:
    rebinding it here would leave every one of them holding the unedited dict.
    """
    for key, value in load_overlay(user).items():
        if key in SECRET:
            continue
        base[key] = value
    return base


def _emptied(base: Dict[str, Any]) -> Dict[str, Any]:
    """The same shape with none of the facts: every string blank, every list
    and map empty. Keys are kept so the page still knows what to ask for."""
    blank: Dict[str, Any] = {}
    for key, value in base.items():
        if isinstance(value, dict):
            blank[key] = {}
        elif isinstance(value, list):
            blank[key] = []
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            blank[key] = ""
        else:
            blank[key] = ""
    return blank


# A person's assembled profile, briefly. Letters, tailoring and the interview
# helper ask for it several times per application, and each ask is otherwise a
# round trip to Postgres in the middle of writing a paragraph. Fifteen seconds
# is short enough that an edit on the profile page shows up in the next letter,
# and a save clears it outright so it shows up in this one.
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 15.0


def forget(user: Optional[str] = None) -> None:
    """Drop the cached profile, for one person or for everybody."""
    if user is None:
        _CACHE.clear()
    else:
        _CACHE.pop(people.resolve(user), None)


def profile_for(user: Optional[str] = None) -> Dict[str, Any]:
    """
    One person's whole profile: their edits, over a base that is theirs.

    The dict in `candidate_profile.py` is not a template -- it is one person's
    name, address, phone number and work history, hardcoded years ago. Handing
    it to a second account as a starting point would not be a convenience; it
    would sign her applications with his name and post them to his address
    until every field happened to be overwritten. So anyone but the account
    that dict describes starts from the same shape with nothing in it, plus
    whatever their own row in `app_users` already knows.

    A copy, never the shared dict: two requests for two people arriving at once
    must not be able to leave one holding the other's address.
    """
    from services.automation.candidate_profile import CANDIDATE_PROFILE

    who = people.resolve(user)
    cached = _CACHE.get(who)
    if cached and (time.time() - cached[0]) < _CACHE_TTL:
        return copy.deepcopy(cached[1])

    built = _build(who, CANDIDATE_PROFILE)
    _CACHE[who] = (time.time(), copy.deepcopy(built))
    return built


def _build(who: str, CANDIDATE_PROFILE: Dict[str, Any]) -> Dict[str, Any]:
    """The assembly itself, split out so the cache above stays readable."""
    if who == people.DEFAULT:
        return apply_to(copy.deepcopy(CANDIDATE_PROFILE), who)

    person = people.get(who)
    base = _emptied(copy.deepcopy(CANDIDATE_PROFILE))
    name = str(person.get("display_name") or "").strip()
    first, _, last = name.partition(" ")
    base.update({
        "full_name": name,
        "first_name": first,
        "last_name": last,
        "country": str(person.get("country") or ""),
        "preferred_language": str(person.get("letter_language") or ""),
    })
    return apply_to(base, who)


def public_profile(base: Dict[str, Any],
                   drop: Iterable[str] = SECRET) -> Dict[str, Any]:
    """The profile as the browser may see it: everything except the secrets."""
    return {k: v for k, v in base.items() if k not in set(drop)}
