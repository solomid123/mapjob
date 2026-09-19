# -*- coding: utf-8 -*-
"""
Asking somebody else's mail server, from somebody else's machine.

The SMTP probe in email_verify works, and from this connection it is refused
about a third of the time. That refusal is not about the mailbox: it is about
the machine asking. A residential address with no reverse DNS, greeting a
stranger's mail server in the name of a domain it plainly does not belong to,
gets 4xx and 5.7.x and learns nothing. Azure cannot fix it either -- outbound
port 25 is blocked in the fabric, above anything a firewall rule can reach.

So the question gets asked by a machine built for asking: warmed IPs, reverse
DNS, SPF, and a reputation maintained by somebody whose business it is. This
module is that client. Everything else -- the pattern logic, the crawl, the
decision about what counts as proof -- stays here, because those are judgements
and this is only a transport.

Two things it does that a naive client would not:

  * It caches. Every call costs money, and the same address arrives again every
    time a company is re-read. A result is kept for CACHE_DAYS and re-served
    free; only `valid` and `invalid` are worth keeping that long, since they
    are facts about a mailbox rather than about a moment.
  * It stops early on a catch-all. A domain that accepts everything will call
    every candidate valid, so the first such answer ends the walk and the
    remaining guesses are never billed -- and never believed.

The vocabulary is deliberately the same as email_verify's, so that a caller
cannot tell which one answered except by reading the reason.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

from services.automation.config import load_env

ENDPOINT = "https://client.myemailverifier.com/verifier/validate_single/{email}/{key}"

# The default urllib user agent is answered with 403 by the WAF in front of the
# service, which looks exactly like a bad key until you read the body.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
}

TIMEOUT = 45

# A verdict about a mailbox does not go stale quickly; a verdict about a moment
# does. Only the two definite ones are cached this long -- see _worth_keeping.
CACHE_DAYS = 90

CACHE_PATH = Path(__file__).with_name("verify_cache.db")

_cache_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def api_key() -> str:
    """Read per call, not at import: .env may not be loaded when this lands."""
    load_env()
    return (os.getenv("MYEMAILVERIFIER_API_KEY") or "").strip()


def available() -> bool:
    return bool(api_key())


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(str(CACHE_PATH), check_same_thread=False)
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS verdicts ("
            " email TEXT PRIMARY KEY, payload TEXT NOT NULL, asked_at REAL NOT NULL)"
        )
        _conn.commit()
    return _conn


def _worth_keeping(status: str) -> bool:
    """
    Which answers are facts and which are weather.

    `valid` and `invalid` are statements about a mailbox and stay true for
    months. `unknown` and `risky` are statements about a particular attempt --
    a greylist, a timeout, a domain that happened to be accepting everything --
    and caching those would turn one bad minute into a permanent verdict.
    """
    return status in ("valid", "invalid")


def cached(address: str) -> Optional[Dict[str, object]]:
    cutoff = time.time() - CACHE_DAYS * 86400
    with _cache_lock:
        row = _db().execute(
            "SELECT payload FROM verdicts WHERE email = ? AND asked_at > ?",
            (address, cutoff),
        ).fetchone()
    if not row:
        return None
    try:
        out = json.loads(row[0])
    except Exception:  # noqa: BLE001 - a corrupt row is a cache miss
        return None
    out["reason"] = str(out.get("reason") or "") + " (remembered from an earlier check)"
    return out


def _remember(address: str, verdict: Dict[str, object]) -> None:
    if not _worth_keeping(str(verdict.get("status") or "")):
        return
    with _cache_lock:
        _db().execute(
            "INSERT OR REPLACE INTO verdicts (email, payload, asked_at) VALUES (?, ?, ?)",
            (address, json.dumps(verdict), time.time()),
        )
        _db().commit()


def _truthy(value: object) -> bool:
    return str(value).strip().lower() in ("true", "1", "yes")


def _read(payload: Dict[str, object], *names: str) -> str:
    """
    Field lookup that survives the vendor renaming things.

    Their documentation and their responses have disagreed about casing before,
    so every key is folded and several spellings are accepted. A verifier that
    breaks silently because a header changed case is worse than one that is
    honestly absent.
    """
    folded = {str(k).strip().lower().replace("-", "_"): v for k, v in payload.items()}
    for name in names:
        value = folded.get(name.lower())
        if value not in (None, ""):
            return str(value).strip()
    return ""


def _interpret(address: str, payload: Dict[str, object]) -> Dict[str, object]:
    """Their vocabulary into ours, keeping every hedge they made."""
    status = _read(payload, "status", "result", "state").lower()
    sub = _read(payload, "substatus", "sub_status", "diagnosis", "message")
    catch_all = _truthy(_read(payload, "catch_all", "catchall", "accept_all")) \
        or status in ("catch-all", "catchall", "accept-all", "acceptall", "catch_all")
    role = _truthy(_read(payload, "role_based", "rolebased", "role"))
    free = _truthy(_read(payload, "free_domain", "freedomain", "free"))
    greylisted = _truthy(_read(payload, "greylisted", "greylist"))

    out: Dict[str, object] = {
        "email": address, "status": "unknown", "score": 40, "reason": "",
        "role": role, "free": free, "catch_all": catch_all or None,
    }

    if catch_all:
        # The one answer that matters most for constructed addresses: the
        # domain would accept anything, so an acceptance proves nothing.
        out.update(status="risky", score=35,
                   reason="the domain accepts every address, so this proves nothing")
    elif status == "valid":
        out.update(status="valid", score=98 if role else 95,
                   reason="the verification service confirmed this mailbox exists")
    elif status == "invalid":
        out.update(status="invalid", score=0,
                   reason="the verification service says there is no such mailbox"
                          + (": " + sub if sub else ""))
    elif greylisted or status in ("greylisted", "unknown", "", "error"):
        out.update(status="unknown", score=40,
                   reason="the mail server would not give a straight answer"
                          + (": " + sub if sub else ""))
    else:
        out.update(status="risky", score=50,
                   reason="the verification service answered " + (status or "nothing")
                          + (": " + sub if sub else ""))
    return out


def failed(verdict: Dict[str, object]) -> bool:
    """
    Did the service fail to answer, as opposed to answering "I do not know"?

    The difference decides whether the caller falls back to its own SMTP probe.
    A rejected key is not a fact about the mailbox and must not be filed as one.
    """
    return bool(verdict.get("_service_error"))


def check(address: str, use_cache: bool = True) -> Dict[str, object]:
    """
    One address. Returns the same shape email_verify.verify does.

    A transport failure comes back `unknown` and is never cached: the address
    has not been judged, and pretending otherwise would bake a network hiccup
    into the ledger as a fact about somebody's mailbox.
    """
    address = (address or "").strip().lower()
    if not address:
        return {"email": "", "status": "invalid", "score": 0,
                "reason": "not an address", "role": False, "free": False,
                "catch_all": None}

    if use_cache:
        remembered = cached(address)
        if remembered:
            return remembered

    key = api_key()
    if not key:
        return {"email": address, "status": "unknown", "score": 40,
                "reason": "no verification service is configured",
                "role": False, "free": False, "catch_all": None,
                "_service_error": True}

    url = ENDPOINT.format(email=urllib.parse.quote(address), key=urllib.parse.quote(key))
    request = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = json.loads(exc.read().decode("utf-8", "replace")).get("message", "")
        except Exception:  # noqa: BLE001 - an unparseable error body is still an error
            pass
        if exc.code in (401, 403):
            # Said plainly, because the alternative is silent degradation:
            # every address coming back unknown and nobody knowing why.
            return {"email": address, "status": "unknown", "score": 40,
                    "reason": "the verification service rejected the API key"
                              + (" (" + detail + ")" if detail else ""),
                    "role": False, "free": False, "catch_all": None,
                "_service_error": True}
        if exc.code == 429:
            return {"email": address, "status": "unknown", "score": 40,
                    "reason": "the verification service is rate limiting this account",
                    "role": False, "free": False, "catch_all": None,
                "_service_error": True}
        return {"email": address, "status": "unknown", "score": 40,
                "reason": "the verification service answered HTTP " + str(exc.code)
                          + (": " + detail if detail else ""),
                "role": False, "free": False, "catch_all": None,
                "_service_error": True}
    except Exception as exc:  # noqa: BLE001
        return {"email": address, "status": "unknown", "score": 40,
                "reason": "could not reach the verification service ("
                          + type(exc).__name__ + ")",
                "role": False, "free": False, "catch_all": None,
                "_service_error": True}

    try:
        payload = json.loads(body)
    except Exception:  # noqa: BLE001
        return {"email": address, "status": "unknown", "score": 40,
                "reason": "the verification service answered something that was not JSON",
                "role": False, "free": False, "catch_all": None,
                "_service_error": True}
    if not isinstance(payload, dict):
        payload = {"status": str(payload)}

    verdict = _interpret(address, payload)
    _remember(address, verdict)
    return verdict


def pick(candidates: List[str]) -> Dict[str, object]:
    """
    Several spellings of one person's address; which one exists.

    Walks them in the order given -- which is confidence order, the learned
    pattern first -- and stops at the first acceptance. Three things end the
    walk early, and two of them save money:

      * a catch-all domain, which would call every one of them valid;
      * a rejected key or an unreachable service, because the second question
        will fail exactly like the first;
      * an acceptance, which is the answer.
    """
    tried: List[str] = []
    for address in candidates:
        verdict = check(address)
        tried.append(address)
        status = str(verdict.get("status"))
        reason = str(verdict.get("reason") or "")

        if status == "valid":
            return {"email": address, "status": "valid",
                    "score": int(verdict.get("score") or 95),
                    "reason": reason, "tried": len(tried), "catch_all": False}

        if verdict.get("catch_all"):
            return {"email": "", "status": "risky", "score": 35,
                    "reason": "the domain accepts every address, so no guess can be proved",
                    "tried": len(tried), "catch_all": True}

        if verdict.get("_service_error"):
            return {"email": "", "status": "unknown", "score": 0,
                    "reason": reason, "tried": len(tried), "catch_all": None,
                    "_service_error": True}

    if not tried:
        return {"email": "", "status": "unknown", "score": 0,
                "reason": "there was nothing to check", "tried": [], "catch_all": None}

    return {"email": "", "status": "invalid", "score": 0,
            "reason": "the verification service rejected every spelling of that name",
            "tried": len(tried), "catch_all": False}

