# -*- coding: utf-8 -*-
"""
Each person's own mailbox.

Until now there was one: three variables in `.env` naming one Google account,
and every letter this app sent -- whoever it was from, whoever wrote it -- left
through it. On one laptop with one user that is a shortcut. With two accounts
it is already wrong: her Bewerbung goes out over his Gmail, and the employer
replies to him. Deployed, it is not a shortcut at all, it is every user of the
app sharing one mailbox, which is not a product anybody can ship.

So a mailbox is a thing an account connects, once, through Google's own consent
screen, and what comes back is stored against that account. One OAuth client
(the app's), many refresh tokens (theirs).

On secrets, plainly:

  * A refresh token is a key to somebody's mail. It is written to Postgres and
    to a gitignored file on disk, and it is never returned by any endpoint, put
    in any log line, or sent to the browser. The page is told an address and a
    boolean.
  * `.env`'s mailbox is the machine's, not everyone's. It answers for the
    default account only, so that this laptop keeps working exactly as it did,
    and a second account gets "connect your mailbox" instead of quietly
    borrowing the first one's. `MAILBOX_SHARED=1` puts the old behaviour back
    for a single-user deployment that wants it.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from services.automation import cloud, people
from services.automation.config import load_env

TABLE = "mailboxes"

# The mirror. Postgres is the record; this is what a laptop with no network
# reads, and where a local-only install keeps everything.
STORE = Path(os.getenv("MAILBOX_STORE",
                       str(Path(__file__).resolve().parent / "mailboxes.json")))

SCOPES = ("https://www.googleapis.com/auth/gmail.send "
          "https://www.googleapis.com/auth/userinfo.email")

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"


def _env(name: str) -> str:
    load_env()
    return (os.getenv(name) or "").strip()


def client() -> Dict[str, str]:
    """The app's own OAuth client. One for the whole install, not one per user."""
    return {"id": _env("GOOGLE_OAUTH_CLIENT_ID"),
            "secret": _env("GOOGLE_OAUTH_CLIENT_SECRET")}


def configured() -> bool:
    c = client()
    return bool(c["id"] and c["secret"])


def redirect_uri(custom: str = "") -> str:
    """
    Where Google sends the person back to. Must match a URI registered on the
    OAuth client, character for character, or Google refuses before the user
    sees anything.
    """
    if custom:
        return custom
    return (_env("GOOGLE_OAUTH_REDIRECT_URI")
            or "https://billions.eu.cc/api/mailbox/callback")


# --- the local mirror ------------------------------------------------------

def _read_all() -> Dict[str, Any]:
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _write_all(rows: Dict[str, Any]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".part")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STORE)
    try:
        # Nobody else on the machine needs read access to a stack of refresh
        # tokens. Best effort: on Windows this is close to a no-op, and a
        # failure here must not stop somebody connecting their mail.
        os.chmod(STORE, 0o600)
    except OSError:
        pass


# --- reading ---------------------------------------------------------------

def _row(user: str) -> Dict[str, Any]:
    who = people.resolve(user)
    rows = cloud.select(TABLE, user_id=who)
    if rows:
        row = dict(rows[0])
        mirror = _read_all()
        mirror[who] = row
        _write_all(mirror)
        return row
    return dict(_read_all().get(who) or {})


def address(user: str = "") -> str:
    """The address this account sends from, connected or inherited from .env."""
    row = _row(user)
    if row.get("address"):
        return str(row["address"])
    return _env("GMAIL_USER") if _may_use_env(user) else ""


def connected(user: str = "") -> Dict[str, Any]:
    """
    What the page is allowed to know: whether there is a mailbox, whose it is,
    and how it got there. Never the token.
    """
    who = people.resolve(user)
    row = _row(who)
    if row.get("refresh_token"):
        return {"connected": True, "address": str(row.get("address") or ""),
                "how": "oauth", "own": True,
                "since": str(row.get("connected_at") or "")}
    if _may_use_env(who) and _env("GOOGLE_OAUTH_REFRESH_TOKEN"):
        return {"connected": True, "address": _env("GMAIL_USER"),
                "how": "env", "own": False, "since": ""}
    if _may_use_env(who) and _env("GMAIL_APP_PASSWORD"):
        return {"connected": True, "address": _env("GMAIL_USER"),
                "how": "smtp", "own": False, "since": ""}
    return {"connected": False, "address": "", "how": "", "own": False, "since": ""}


def _may_use_env(user: str) -> bool:
    """
    Whether this account may fall back to the mailbox in `.env`.

    The default account may, because on this machine that mailbox is theirs and
    has been all along. Everybody else connects their own: a second person's
    letters leaving through the first person's Gmail is the same mistake as a
    second person's name on the first person's letterhead, one layer down.
    """
    if _env("MAILBOX_SHARED") in ("1", "true", "yes"):
        return True
    return people.resolve(user) == people.DEFAULT


def refresh_token(user: str = "") -> str:
    """Server-side only. Never returned by an endpoint, never logged."""
    row = _row(user)
    token = str(row.get("refresh_token") or "")
    if token:
        return token
    return _env("GOOGLE_OAUTH_REFRESH_TOKEN") if _may_use_env(user) else ""


# --- connecting ------------------------------------------------------------

def auth_url(state: str, uri: str = "") -> str:
    """
    The consent screen. `access_type=offline` with `prompt=consent` because the
    thing worth having is the refresh token, and Google only returns one on a
    fresh consent -- a second connection without it comes back with an access
    token that dies in an hour.
    """
    from urllib.parse import urlencode

    target_uri = redirect_uri(uri)
    return AUTH_URL + "?" + urlencode({
        "client_id": client()["id"],
        "redirect_uri": target_uri,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "include_granted_scopes": "true",
        "prompt": "consent",
        "state": state,
    })


def exchange(code: str, uri: str = "") -> Dict[str, Any]:
    """Code for tokens, plus the address it belongs to. Raises with a reason."""
    import requests

    c = client()
    target_uri = redirect_uri(uri)
    response = requests.post(TOKEN_URL, timeout=25, data={
        "code": code, "client_id": c["id"], "client_secret": c["secret"],
        "redirect_uri": target_uri, "grant_type": "authorization_code"})
    if response.status_code != 200:
        # Google's body here can contain the client secret's error context but
        # never the secret; still, only the error code is passed on.
        raise RuntimeError("Google refused the code: "
                           + str(response.json().get("error", response.status_code)))
    data = response.json()
    token = str(data.get("refresh_token") or "")
    if not token:
        raise RuntimeError("Google returned no refresh token. Remove this app at "
                           "myaccount.google.com/permissions and connect again.")
    who = ""
    try:
        info = requests.get(USERINFO_URL, timeout=15, headers={
            "Authorization": "Bearer " + str(data.get("access_token") or "")})
        if info.status_code == 200:
            who = str(info.json().get("email") or "")
    except Exception:  # noqa: BLE001 - an address is nice, not required
        pass
    return {"refresh_token": token, "address": who}


def save(user: str, address_: str, token: str) -> Dict[str, Any]:
    who = people.resolve(user)
    row = {"user_id": who, "address": address_, "refresh_token": token,
           "connected_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        cloud.upsert(TABLE, row)
    except Exception:  # noqa: BLE001 - the mirror is enough to send with
        pass
    mirror = _read_all()
    mirror[who] = row
    _write_all(mirror)
    return connected(who)


def forget(user: str = "") -> bool:
    """
    Disconnect. Deletes what is held here; it does not revoke Google's grant,
    which is the user's to withdraw at myaccount.google.com/permissions, and
    the page says so rather than implying this button did it.
    """
    who = people.resolve(user)
    try:
        cloud.delete(TABLE, user_id=who)
    except Exception:  # noqa: BLE001
        pass
    mirror = _read_all()
    existed = who in mirror
    mirror.pop(who, None)
    _write_all(mirror)
    return existed
