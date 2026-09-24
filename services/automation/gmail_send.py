# -*- coding: utf-8 -*-
"""
Sending, through the mailbox the user already connected.

Two ways out exist in this repository and they are not equivalent. SMTP with
an app password works and is three lines; the Gmail API needs an OAuth dance
that is already done. The API is preferred anyway for one reason that matters
to a campaign: it returns a message id and a thread id, so a reply weeks later
can be matched to the application that caused it. An SMTP send returns nothing
and the sent copy does not reliably appear in the account's Sent folder, which
is where the user will go looking when an employer says "I never got it".

SMTP stays as the fallback, because a refresh token that has been revoked -- by
rotating the client secret, for instance, which is pending here -- should
degrade to a working send rather than to a stopped campaign.

Nothing in this module decides *whether* to send. It is handed a recipient and
an already-built message and it does exactly that, once. The caps, the pacing
and the dry-run switch live in the campaign, so there is one place to look when
asking why something went out.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Union

from services.automation.config import load_env

TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"

# Cached for the life of the process, per account. An access token lasts an
# hour and a campaign of two hundred letters would otherwise ask Google for two
# hundred of them -- but two accounts must never share the entry, or the second
# person's letters go out on the first person's token.
_access: Dict[str, Dict[str, object]] = {}


def _env(name: str) -> str:
    load_env()
    return (os.getenv(name) or "").strip()


def _whose(user: str) -> str:
    from services.automation import people
    return people.resolve(user)


def oauth_ready(user: str = "") -> bool:
    """A client to speak with, and a refresh token belonging to this account."""
    from services.automation import mailbox
    return bool(mailbox.configured() and mailbox.refresh_token(user))


def smtp_ready(user: str = "") -> bool:
    """
    The app password in `.env` is one mailbox on one machine, so it answers for
    the account that mailbox belongs to and not for everybody who signs in.
    """
    from services.automation import mailbox
    return bool(mailbox._may_use_env(user) and _env("GMAIL_USER")
                and (_env("GMAIL_APP_PASSWORD") or _env("SMTP_PASSWORD")))


def sender_address(user: str = "") -> str:
    from services.automation import mailbox
    return (mailbox.address(user)
            or (_env("SMTP_USER") or _env("SMTP_FROM") if mailbox._may_use_env(user) else ""))


def access_token(user: str = "", force: bool = False) -> str:
    """Exchange this account's refresh token, or hand back the one still in date."""
    import time

    import requests

    from services.automation import mailbox

    who = _whose(user)
    held = _access.get(who) or {}
    if not force and held.get("token") and float(held.get("expires") or 0) > time.time() + 60:
        return str(held["token"])
    token = mailbox.refresh_token(who)
    client = mailbox.client()
    if not (token and client["id"] and client["secret"]):
        return ""
    try:
        response = requests.post(TOKEN_URL, timeout=20, data={
            "client_id": client["id"],
            "client_secret": client["secret"],
            "refresh_token": token,
            "grant_type": "refresh_token",
        })
    except Exception:  # noqa: BLE001
        return ""
    if response.status_code != 200:
        return ""
    data = response.json()
    _access[who] = {"token": data.get("access_token") or "",
                    "expires": time.time() + float(data.get("expires_in") or 3600)}
    return str(_access[who]["token"])


def check(user: str = "") -> Dict[str, object]:
    """
    Can this account actually send right now?

    The dashboard used to show "Connected" because three variables existed in a
    file. That is not a connection; a revoked token sets exactly the same three
    variables. This asks Google, for the account that is asking.
    """
    from services.automation import mailbox

    state = mailbox.connected(user)
    if oauth_ready(user):
        token = access_token(user, force=True)
        if token:
            return {"ok": True, "how": "gmail-api", "address": sender_address(user),
                    "own": bool(state.get("own")),
                    "reason": "Google exchanged the refresh token"}
        if smtp_ready(user):
            return {"ok": True, "how": "smtp", "address": sender_address(user),
                    "own": bool(state.get("own")),
                    "reason": "the refresh token was refused; the app password still works"}
        return {"ok": False, "how": "", "address": sender_address(user),
                "own": bool(state.get("own")),
                "reason": "Google refused the refresh token - reconnect the mailbox"}
    if smtp_ready(user):
        return {"ok": True, "how": "smtp", "address": sender_address(user),
                "own": bool(state.get("own")),
                "reason": "app password only; no OAuth token on file"}
    return {"ok": False, "how": "", "address": "", "own": False,
            "reason": "no mailbox connected for this account"}


# A path, or a path and the filename it should arrive under.
Attachment = Union[str, Sequence[str]]


def build_message(to: str, subject: str, body: str, attachments: List[Attachment],
                  sender: str = "", reply_to: str = "",
                  display_name: str = "", user: str = "") -> EmailMessage:
    message = EmailMessage()
    from_address = sender or sender_address(user)
    message["From"] = (f"{display_name} <{from_address}>" if display_name
                       else from_address)
    message["To"] = to
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()
    if reply_to:
        message["Reply-To"] = reply_to
    message.set_content(body)

    for item in attachments or []:
        # Either a path, or a path and the name it should arrive under. The
        # second form exists because a held document is stored with its id in
        # front of its name, and an employer opening an attachment called
        # "0cdf1e6b2cd5__transcript.pdf" is reading this app's bookkeeping.
        if isinstance(item, (tuple, list)):
            path = item[0] if item else ""
            shown = item[1] if len(item) > 1 else ""
        else:
            path, shown = item, ""
        file = Path(path)
        if not path or not file.exists():
            continue
        guessed, _ = mimetypes.guess_type(file.name)
        main, _, sub = (guessed or "application/octet-stream").partition("/")
        message.add_attachment(file.read_bytes(), maintype=main,
                               subtype=sub or "octet-stream",
                               filename=str(shown or file.name))
    return message


def _send_api(message: EmailMessage, user: str = "") -> Dict[str, object]:
    import requests

    token = access_token(user)
    if not token:
        return {"sent": False, "how": "gmail-api", "reason": "no access token"}
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()
    try:
        response = requests.post(
            SEND_URL, timeout=45,
            headers={"Authorization": "Bearer " + token,
                     "Content-Type": "application/json"},
            json={"raw": raw})
    except Exception as error:  # noqa: BLE001
        return {"sent": False, "how": "gmail-api", "reason": str(error)[:200]}
    if response.status_code == 200:
        data = response.json()
        return {"sent": True, "how": "gmail-api",
                "message_id": data.get("id", ""),
                "thread_id": data.get("threadId", ""), "reason": ""}
    return {"sent": False, "how": "gmail-api",
            "reason": f"HTTP {response.status_code}: {response.text[:200]}"}


def _send_smtp(message: EmailMessage, user: str = "") -> Dict[str, object]:
    from services.automation import mailbox
    if not mailbox._may_use_env(user):
        # There is one app password on this machine and it opens one mailbox.
        # Another account borrowing it would send their letters from somebody
        # else's address, which is the thing this separation exists to stop.
        return {"sent": False, "how": "smtp",
                "reason": "no mailbox connected for this account"}
    account = _env("GMAIL_USER") or _env("SMTP_USER")
    password = _env("GMAIL_APP_PASSWORD") or _env("SMTP_PASSWORD")
    host = _env("SMTP_HOST") or "smtp.gmail.com"
    port = int(_env("SMTP_PORT") or 587)
    if not (account and password):
        return {"sent": False, "how": "smtp", "reason": "no app password"}
    try:
        with smtplib.SMTP(host, port, timeout=45) as server:
            server.starttls(context=ssl.create_default_context())
            server.login(account, password)
            server.send_message(message)
    except Exception as error:  # noqa: BLE001
        return {"sent": False, "how": "smtp", "reason": str(error)[:200]}
    return {"sent": True, "how": "smtp",
            "message_id": message["Message-ID"] or "", "thread_id": "", "reason": ""}


def send(to: str, subject: str, body: str, attachments: Optional[List[Attachment]] = None,
         reply_to: str = "", display_name: str = "", user: str = "") -> Dict[str, object]:
    """
    One message, one attempt per transport, out of the sender's own mailbox.
    Returns what happened, never a hopeful guess -- the ledger records this
    verbatim.
    """
    if not to or "@" not in to:
        return {"sent": False, "how": "", "reason": "no recipient address"}
    message = build_message(to, subject, body, attachments or [],
                            reply_to=reply_to, display_name=display_name, user=user)
    if oauth_ready(user):
        result = _send_api(message, user)
        if result["sent"]:
            return result
        if not smtp_ready(user):
            return result
        # The token failed mid-campaign. Fall through rather than lose the run,
        # and say which door it eventually went through.
        fallback = _send_smtp(message, user)
        fallback["reason"] = ("gmail api: " + str(result["reason"]) + "; "
                              + str(fallback.get("reason") or "sent over smtp"))
        return fallback
    return _send_smtp(message, user)

