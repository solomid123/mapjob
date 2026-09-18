"""
A memory of which employer portals we have already registered an account with.

The ladder used to start from zero on every run: try password one, try
password two, register. On the second job at the same employer that means
registering again with an email the site already knows, which fails with
"this address is already in use" -- and the ladder reads that as "registration
did not work" and gives up, having never tried the one password that would
have let it straight in.

So a sign-up leaves a note behind. The note is a *reference*, not a copy: what
is written down is which configured password was used ("signup", "primary",
"secondary"), never the password itself. The value is resolved from config at
the moment it is needed, so rotating a password in .env rotates it here too
and this file can be read by anyone without handing them anything.
"""

from __future__ import annotations

import json
import os
import time
from typing import Optional

from .config import (
    PORTAL_PASSWORD_PRIMARY,
    PORTAL_PASSWORD_SECONDARY,
    PORTAL_SIGNUP_PASSWORD,
)

REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "portal_accounts.json")

# The names that may be written to disk, and the config value each one stands
# for. A name that is not in here resolves to nothing, so a stale or hand-edited
# file can never make the agent type something unexpected.
_KINDS = {
    "primary": lambda: PORTAL_PASSWORD_PRIMARY,
    "secondary": lambda: PORTAL_PASSWORD_SECONDARY,
    "signup": lambda: PORTAL_SIGNUP_PASSWORD or PORTAL_PASSWORD_PRIMARY,
}


def _load() -> dict:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(data: dict) -> None:
    tmp = REGISTRY_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=1, sort_keys=True)
        os.replace(tmp, REGISTRY_PATH)
    except Exception:
        pass


def remember_account(host: str, email: str, password_kind: str = "signup",
                     verified: bool = False, note: str = "") -> None:
    """Records that an account now exists at `host`. Never records a password."""
    host = (host or "").lower().strip()
    if not host or password_kind not in _KINDS:
        return
    data = _load()
    previous = data.get(host) or {}
    data[host] = {
        "email": email,
        "password_kind": password_kind,
        # Once verified, always verified: a later run that skips the code step
        # should not erase the fact that the address was confirmed.
        "verified": bool(verified or previous.get("verified")),
        "created_at": previous.get("created_at") or time.strftime("%Y-%m-%d %H:%M:%S"),
        "last_seen": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": note or previous.get("note", ""),
    }
    _save(data)


def known_account(host: str) -> Optional[dict]:
    """
    The account we created at `host`, with its password resolved, or None.

    Returns None rather than a half-answer when the password it names is no
    longer configured: an account we cannot sign into is not worth jumping the
    queue for.
    """
    entry = (_load().get((host or "").lower().strip()) or {})
    if not entry:
        return None
    password = (_KINDS.get(entry.get("password_kind", "")) or (lambda: ""))()
    if not password:
        return None
    return {
        "email": entry.get("email", ""),
        "password": password,
        "password_kind": entry.get("password_kind", ""),
        "verified": bool(entry.get("verified")),
        "created_at": entry.get("created_at", ""),
    }


def forget_account(host: str) -> None:
    """Drops the note for a host, for when the account turns out not to work."""
    data = _load()
    if data.pop((host or "").lower().strip(), None) is not None:
        _save(data)
