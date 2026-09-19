# -*- coding: utf-8 -*-
"""
Does this mailbox exist?

Sending to an address nobody has emptied since 2016 is not merely useless: a
bounce is a mark against the domain doing the sending, and enough of them is
how a sending reputation dies. So nothing leaves this app before the address
has been asked about -- cheaply first, and expensively only when the cheap
answer was promising.

Three stages, in increasing cost:

  1. Shape. Free, instant, and it removes the typos and the strings that were
     never addresses: the logo filename that ended up in a mailto, the
     example.com left in a template.
  2. The domain. Has it anywhere to deliver mail at all? An MX record, or an
     A record, which RFC 5321 says to fall back to. One DNS question per
     domain, cached, and it eliminates most of the dead ones.
  3. The mailbox. Ask the domain own mail server whether it would accept a
     letter for that recipient, and stop before sending one. This is the only
     stage that proves anything, and the only one with a cost worth managing:
     one connection per domain, reused for every address on it.

Two honest limits, because a verifier that reports certainty it does not have
is worse than no verifier:

  * A catch-all domain accepts every recipient, including one this module
    invents. Those addresses come back "risky", never "valid" -- the server
    has said nothing about the mailbox, only about its own configuration.
  * The big consumer providers are not probed at all. Google and Microsoft
    answer the same way for a live mailbox and a dead one, and they treat a
    machine that asks many such questions as an attack, which is exactly the
    reputation the sending address must not acquire.
"""

from __future__ import annotations

import os
import random
import re
import smtplib
import socket
import string
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional, Tuple

try:
    import dns.resolver  # type: ignore
except Exception:  # noqa: BLE001 - without DNS the module still answers, less
    dns = None  # type: ignore

# Deliberately stricter than RFC 5322: a quoted local part is legal and never
# appears on a careers page, and every address reaching this module came off
# a web page.
SYNTAX = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@"
                    r"(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$")

# Mailboxes belonging to a function rather than a person. Not a fault -- for a
# spontaneous application they are the correct destination -- but worth
# recording, because a role address is also what a catch-all hides behind.
ROLE_LOCALS = {
    "recrutement", "recruitment", "recruiting", "bewerbung", "bewerbungen",
    "karriere", "jobs", "job", "emploi", "emplois", "career", "careers",
    "candidature", "candidatures", "talent", "hr", "rh", "personal",
    "personnel", "info", "kontakt", "contact", "office", "mail", "hello",
    "bonjour", "team", "verwaltung", "sekretariat", "empfang", "buero",
}

# Consumer mail: a private address, not a company mailbox. It can be perfectly
# valid and still be the wrong place to send an application, and none of these
# providers answers a probe truthfully.
FREE_PROVIDERS = {
    "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "outlook.fr",
    "hotmail.com", "hotmail.de", "hotmail.fr", "live.com", "live.de", "msn.com",
    "yahoo.com", "yahoo.de", "yahoo.fr", "ymail.com", "aol.com", "icloud.com",
    "me.com", "gmx.de", "gmx.net", "gmx.com", "gmx.at", "web.de", "t-online.de",
    "freenet.de", "posteo.de", "mailbox.org", "orange.fr", "wanadoo.fr",
    "free.fr", "laposte.net", "sfr.fr", "bbox.fr", "protonmail.com", "proton.me",
}

# Throwaway mail. An address here is a person who did not want to be written to.
DISPOSABLE = {
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "yopmail.com",
    "tempmail.com", "trashmail.com", "sharklasers.com", "getnada.com",
    "dispostable.com", "maildrop.cc", "temp-mail.org", "fakeinbox.com",
}

# The envelope sender used while asking. It has to be an address whose domain
# resolves -- a server asked by <> hangs up, as the first attempt at this found
# out -- and it should be the address that will actually write, because that is
# the truthful answer to "who is asking".
PROBE_FROM = (os.getenv("OUTREACH_FROM")
              or os.getenv("GMAIL_ADDRESS")
              or os.getenv("GOOGLE_LOGIN_EMAIL")
              or "")

SMTP_TIMEOUT = 10
DNS_TIMEOUT = 5

_domain_lock = threading.Lock()
_mx_cache: Dict[str, List[str]] = {}
_catchall_cache: Dict[str, Optional[bool]] = {}
# One conversation with a domain at a time. Six threads opening SMTP sessions
# to the same small mail server is the behaviour of a dictionary attack, and it
# is answered like one.
_domain_locks: Dict[str, threading.Lock] = {}


def _lock_for(domain: str) -> threading.Lock:
    with _domain_lock:
        return _domain_locks.setdefault(domain, threading.Lock())


def mx_hosts(domain: str) -> List[str]:
    """Where mail for this domain goes, best first. Empty means nowhere."""
    domain = domain.lower().strip(".")
    with _domain_lock:
        if domain in _mx_cache:
            return _mx_cache[domain]
    hosts: List[str] = []
    if dns is not None:
        try:
            answers = dns.resolver.resolve(domain, "MX", lifetime=DNS_TIMEOUT)
            hosts = [str(r.exchange).rstrip(".")
                     for r in sorted(answers, key=lambda r: r.preference)]
        except Exception:  # noqa: BLE001 - no MX is an answer, not a failure
            hosts = []
    if not hosts:
        # RFC 5321: a domain with an address record and no MX takes its own
        # mail. Plenty of small company domains are set up exactly that way.
        try:
            socket.getaddrinfo(domain, 25)
            hosts = [domain]
        except OSError:
            hosts = []
    with _domain_lock:
        _mx_cache[domain] = hosts
    return hosts


# A rejection often quotes the IP that asked. That is this machine, and it has
# no business being displayed in a dashboard or written to a shared ledger.
IP_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")

# "550" does not mean "no such mailbox". It means no, and the reason matters
# enormously: 5.1.1 is the mailbox not existing, while 5.7.1 is the server
# refusing the machine that asked. Reading the second as the first throws away
# working addresses -- which it did here, on the first real run, to a hotel
# whose info@ is plainly live.
NO_SUCH_USER = re.compile(
    r"5\.1\.[01]|user unknown|unknown user|no such user|no such recipient|"
    r"recipient (address )?rejected|mailbox (is )?unavailable|does not exist|"
    r"no mailbox|invalid recipient|address rejected|unrouteable|unknown address",
    re.IGNORECASE)
REFUSED_US = re.compile(
    r"5\.7\.|blocked|blacklist|black list|blocklist|dnsbl|rbl|spamhaus|"
    r"not allowed|not permitted|access denied|policy|reputation|"
    r"dynamic ip|client host|authentication required|spam",
    re.IGNORECASE)


def _classify(code: int, text: str) -> Tuple[str, str]:
    """
    What a rejection actually said.

    Returns (status, reason) for a non-accepting answer. The distinction being
    drawn is: did the server tell us about the mailbox, or about us?
    """
    # The enhanced status code, where there is one, is the server own summary
    # and outranks its prose. "Recipient address rejected: Access denied" reads
    # like a missing mailbox and is tagged 5.7.1, meaning: not the mailbox, you.
    if re.search(r"\b5\.1\.[01]\b", text):
        return "invalid", "the mail server says there is no such mailbox: " + text
    if re.search(r"\b[45]\.7\.\d+\b", text):
        return "unknown", "the mail server refuses this machine, so the mailbox could not be checked"
    if 400 <= code < 500:
        if REFUSED_US.search(text):
            return "unknown", "the mail server refuses this machine, so the mailbox could not be checked"
        return "risky", "the mail server would not answer yet: " + text
    if NO_SUCH_USER.search(text):
        return "invalid", "the mail server says there is no such mailbox: " + text
    if REFUSED_US.search(text):
        return "unknown", "the mail server refuses this machine, so the mailbox could not be checked"
    # A no with no reason given is still a no about something unknown.
    return "risky", "the mail server declined without saying why: " + text


def _random_local() -> str:
    return "zz" + "".join(random.choice(string.ascii_lowercase + string.digits)
                          for _ in range(12))


def _probe(host: str, domain: str, address: str) -> Tuple[str, str, Optional[bool]]:
    """
    Ask one mail server about one recipient.

    Returns (status, reason, catch_all). The catch-all question is asked once
    per domain and remembered, because the answer is about the domain.
    """
    if not PROBE_FROM:
        return "unknown", "no sending address is configured to ask from", None
    try:
        with smtplib.SMTP(host, 25, timeout=SMTP_TIMEOUT) as server:
            server.ehlo(PROBE_FROM.split("@", 1)[-1] or "localhost")
            server.mail(PROBE_FROM)

            # The real recipient goes first. Asking the invented one first
            # spends the server goodwill on a question about nobody: a mail
            # server that has just rejected an unknown recipient starts
            # tarpitting, and the next answer -- the one that matters -- comes
            # back 4xx. Measured: the same address that answers "250 Accepted"
            # when asked first answers "not allowed yet" when asked second.
            code, message = server.rcpt(address)
            raw = (message.decode("utf-8", "replace") if isinstance(message, bytes)
                   else str(message))
            text = IP_RE.sub("this machine", raw)[:120].replace("\n", " ")

            with _domain_lock:
                catch_all = _catchall_cache.get(domain)
            # Only worth asking when the answer was yes: a rejection is already
            # proof the domain does not accept everything.
            if catch_all is None and code in (250, 251):
                probe_code, _ = server.rcpt(_random_local() + "@" + domain)
                catch_all = probe_code in (250, 251)
                with _domain_lock:
                    _catchall_cache[domain] = catch_all
            elif catch_all is None:
                catch_all = False
                with _domain_lock:
                    _catchall_cache[domain] = False

        if code in (250, 251):
            if catch_all:
                return "risky", "the domain accepts every address, so this proves nothing", catch_all
            return "valid", "the mail server accepts this recipient", catch_all
        status, reason = _classify(code, text)
        return status, reason, catch_all
    except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, OSError) as exc:
        return "unknown", "the mail server did not finish the conversation (" + type(exc).__name__ + ")", None
    except Exception as exc:  # noqa: BLE001
        return "unknown", "could not ask: " + type(exc).__name__, None


def verify(address: str, allow_smtp: bool = True) -> Dict[str, object]:
    """
    One address, and as much certainty as can honestly be had about it.

    status is valid / risky / invalid / unknown, and the reason says in words
    why -- because "risky" without a reason is a shrug, and the difference
    between "catch-all domain" and "the server was busy" decides whether it is
    worth asking again tomorrow.
    """
    address = (address or "").strip().lower()
    out: Dict[str, object] = {
        "email": address, "status": "invalid", "score": 0,
        "reason": "", "role": False, "free": False, "catch_all": None,
    }
    if not address or not SYNTAX.match(address):
        out["reason"] = "not a well-formed address"
        return out

    local, domain = address.split("@", 1)
    out["role"] = local in ROLE_LOCALS or any(local.startswith(r) for r in ROLE_LOCALS)
    out["free"] = domain in FREE_PROVIDERS

    if domain in DISPOSABLE:
        out.update(status="invalid", reason="a throwaway mail service", score=0)
        return out

    hosts = mx_hosts(domain)
    if not hosts:
        out.update(status="invalid", reason="the domain has nowhere to deliver mail", score=0)
        return out

    if out["free"]:
        # An honest ceiling: the shape is right and the provider exists, and
        # that is the whole of what can be known without abusing it.
        out.update(status="risky", score=55,
                   reason="a personal mailbox at " + domain + ", which cannot be checked without abusing it")
        return out

    if not allow_smtp:
        out.update(status="risky", score=60,
                   reason="the domain accepts mail; the mailbox itself was not checked")
        return out

    with _lock_for(domain):
        status, reason, catch_all = _probe(hosts[0], domain, address)
        # Politeness, and self-preservation: a mail server seeing a burst of
        # these from one address stops answering it.
        time.sleep(0.3)

    score = {"valid": 95, "risky": 55, "unknown": 40, "invalid": 0}[status]
    if status == "valid" and out["role"]:
        score = 98  # a role mailbox that exists is the best destination there is
    out.update(status=status, reason=reason, score=score, catch_all=catch_all)
    return out


def verify_many(addresses: List[str], allow_smtp: bool = True, workers: int = 6,
                on_result: Optional[Callable[[Dict[str, object]], None]] = None,
                should_stop: Optional[Callable[[], bool]] = None) -> List[Dict[str, object]]:
    """
    A list of addresses, cheap stages first.

    Sorted, which groups a company addresses together, so the connection, the
    catch-all answer and the server patience are shared by all of them.
    """
    ordered = sorted({(a or "").strip().lower() for a in addresses if a})
    results: List[Dict[str, object]] = []

    def work(address: str) -> Dict[str, object]:
        if should_stop and should_stop():
            return {"email": address, "status": "unknown", "score": 0, "reason": "stopped"}
        return verify(address, allow_smtp=allow_smtp)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(work, ordered):
            results.append(result)
            if on_result:
                on_result(result)
            if should_stop and should_stop():
                break
    return results
