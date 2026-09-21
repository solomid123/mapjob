"""
Signing the cloud browser in, without typing a password into it.

A Browser Use profile is the difference between an application and a login
wall. Most French boards will not show an apply button to a stranger, so a run
either arrives holding a session or it spends its turns on a sign-in form -- and
the only way an agent signs itself in is by being handed a password, which is
the one thing this app refuses to send to a hosted model.

The sessions already exist. The local engine has been collecting them in
cookies_vault.json since the beginning: seven sites, signed in by hand in a real
Chrome window on this machine. The question was only whether they could be moved
into the cloud profile.

WHAT THEIR API OFFERS, read off /api/v4/openapi.json on 2026-09-21:

  * There is no cookie import. The word "cookie" occurs four times in the whole
    spec and every occurrence is ProfileView.cookieDomains -- read-only, "list of
    domain URLs that have cookies stored for this profile". ProfileCreateRequest
    and ProfileUpdateRequest take a name and a userId and nothing else. No
    browser setting on a run or on a session accepts cookies or a storage state.

  * But POST /browsers starts a browser *on* a profile and hands back a cdpUrl --
    a Chrome DevTools endpoint on the real remote browser -- and a profile
    "persists cookies, local storage, and other browser state" from the sessions
    that use it. So the import is a session: start a browser on the profile,
    attach to it over CDP, write the cookies into its jar, stop it. What the
    session held, the profile keeps.

That is what this module does, and it is why it needs Playwright: attaching to
cdpUrl is the whole trick, and Playwright is already here for the local engine.

Three rules it keeps.

  * Nothing is navigated. The session opens on its blank tab, takes the cookies
    and stops. No URL is loaded -- least of all an employer's -- so a seeding run
    cannot submit anything, and it costs seconds of browser time and no proxy
    traffic.

  * Google and Gmail stay on this machine. The board cookies are what an
    application needs; the Google session is the key to the mailbox, to the
    password reset of every other account, and to the documents. Handing that to
    a third party's browser infrastructure buys one convenience -- "Continue with
    Google" -- at a price nobody asked to pay. It is one flag away
    (BROWSER_USE_SEED_GOOGLE=1) for the day that trade looks worth it, and off
    until then.

  * Expired cookies are not sent. The vault is a year of sediment and about a
    sixth of it is dead; uploading a stale session id is how an agent ends up
    half signed in, which reads to a board as a suspicious one.

And the brief the agent gets is told which domains actually landed, not which
ones were hoped for. A run promised a LinkedIn session it does not have stalls
on a login wall it was told to walk through.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests

from services.automation import config  # noqa: F401  (loads .env)

VAULT_PATH = Path(__file__).resolve().parent / "cookies_vault.json"
_CACHE_PATH = Path(__file__).resolve().parent / "browser_use_cache.json"
_ACCOUNT_PATH = Path(__file__).resolve().parent / "cloud_account.json"

# The vault's own keys, not domains: this is how the local engine filed them.
# Everything not named here is a job board and goes up; these two are the
# candidate's identity and stay here unless asked for by name.
SENSITIVE = ("google", "gmail")

_TIMEOUT = 30

# How long the seeding browser is allowed to exist, in minutes. It needs about
# fifteen seconds. One minute is the smallest thing worth asking for, and it
# means a session that somehow outlives its work stops on its own rather than
# billing quietly towards the four-hour ceiling.
_SEED_MINUTES = 1

# How long to wait for the profile to report the cookies back after the session
# stops. Persisting is their side of the transaction and it is not instant.
_CONFIRM_TRIES = 6
_CONFIRM_SLEEP = 2.5


# ---------------------------------------------------------------------------
# Their API, reached without importing the engine that also talks to it
# ---------------------------------------------------------------------------

def _api_base() -> str:
    return os.getenv("BROWSER_USE_API_BASE", "https://api.browser-use.com/api/v4")


def _account() -> Dict[str, Any]:
    """
    The account this installation is currently using, as set from the app.

    A key in .env is a key the machine was started with. This file is the key
    somebody typed into the settings panel afterwards, which is the one that
    matters: it exists precisely because the previous account ran out of credit
    mid-search, and editing .env and restarting the server is not something to
    do while looking at a job you want to apply to.
    """
    try:
        return json.loads(_ACCOUNT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_account(data: Dict[str, Any]) -> None:
    _ACCOUNT_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def api_key() -> str:
    """
    The key in force. Typed beats configured: a key saved from the settings
    panel is a deliberate, later act than the line in .env it replaces.
    """
    return str(_account().get("api_key") or "").strip() or (os.getenv("BROWSER_USE_API_KEY") or "").strip()


# The private spelling the rest of this module grew up with.
_api_key = api_key


def _headers(key: str = "") -> Dict[str, str]:
    return {"X-Browser-Use-API-Key": key or api_key(), "Content-Type": "application/json"}


def profile_id(user: str = "") -> str:
    """
    The profile a run should load.

    Stored alongside the key, and reset with it: profiles are org-scoped, so the
    id that belonged to the old account means nothing to a new one. Pointing a
    new key at an old profile id is a 404 on every run.

    Still one id for the whole installation, which is wrong the moment two
    people use it: the second candidate's applications would go out of the first
    one's signed-in sessions. Their ProfileCreateRequest.userId field exists
    precisely to key a profile to a person in our system, so the fix is a stored
    id per account *per user*. The argument is here so the callers are already
    shaped for it.
    """
    return str(_account().get("profile_id") or "").strip() or (os.getenv("BROWSER_USE_PROFILE_ID") or "").strip()


def get_profile(pid: str) -> Optional[Dict[str, Any]]:
    """The profile as their side sees it, or None if it cannot be read."""
    if not (pid and _api_key()):
        return None
    try:
        res = requests.get(f"{_api_base()}/profiles/{pid}", headers=_headers(), timeout=_TIMEOUT)
        if res.status_code >= 400:
            return None
        return res.json()
    except Exception:
        return None


# ---------------------------------------------------------------------------
# The vault
# ---------------------------------------------------------------------------

def _same_site(raw: Any) -> Optional[str]:
    """
    Chrome's export spelling into Playwright's.

    The local engine only ever passed through "Strict", "Lax" and "None", which
    a Chrome extension export never writes -- so in practice it dropped the
    attribute on every cookie and let the browser guess. Guessing wrong on a
    cross-site session cookie is how a sign-in silently does not take.
    """
    name = str(raw or "").strip().lower()
    return {
        "no_restriction": "None",
        "none": "None",
        "lax": "Lax",
        "strict": "Strict",
    }.get(name)


def vault_groups() -> Dict[str, List[Dict[str, Any]]]:
    """The vault as it sits on disk, keyed by site. Empty if unreadable."""
    try:
        raw = json.loads(VAULT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(raw, list):
        # Older shape: one flat list. File it under a single name so the rest of
        # this module never has to ask which version wrote the file.
        return {"vault": [c for c in raw if isinstance(c, dict)]}
    if not isinstance(raw, dict):
        return {}
    return {k: [c for c in v if isinstance(c, dict)]
            for k, v in raw.items() if isinstance(v, list)}


def vault_cookies(include_sensitive: bool = False,
                  groups: Optional[Iterable[str]] = None) -> List[Dict[str, Any]]:
    """
    The live cookies worth sending, in the shape Playwright takes.

    Dead ones are dropped here rather than in the browser: a cookie whose expiry
    passed in March is not a session, and sending it only makes the jar look
    like somebody else's.
    """
    wanted = set(groups) if groups else None
    now = time.time()
    out: List[Dict[str, Any]] = []
    for site, cookies in vault_groups().items():
        if wanted is not None and site not in wanted:
            continue
        if site in SENSITIVE and not include_sensitive:
            continue
        for c in cookies:
            name, value = c.get("name"), c.get("value")
            domain = str(c.get("domain") or "").strip()
            if not name or value is None or not domain:
                continue
            expires = c.get("expirationDate")
            if expires and float(expires) <= now:
                continue
            cookie: Dict[str, Any] = {
                "name": str(name),
                "value": str(value),
                "domain": domain,
                "path": str(c.get("path") or "/"),
                "httpOnly": bool(c.get("httpOnly")),
                "secure": bool(c.get("secure")),
            }
            if expires:
                cookie["expires"] = float(expires)
            same = _same_site(c.get("sameSite"))
            # SameSite=None is only legal on a secure cookie; Chrome rejects the
            # pair outright, and one rejected cookie takes the whole add_cookies
            # call down with it.
            if same and (same != "None" or cookie["secure"]):
                cookie["sameSite"] = same
            out.append(cookie)
    return out


def _registrable(host: str) -> str:
    """apec.fr out of .www.apec.fr. Crude, and enough to compare two lists."""
    bits = str(host or "").strip().lstrip(".").lower().split(".")
    if len(bits) <= 2:
        return ".".join(bits)
    if bits[-2] in ("co", "com", "org", "net", "gov", "ac") and len(bits[-1]) == 2:
        return ".".join(bits[-3:])
    return ".".join(bits[-2:])


def vault_domains(include_sensitive: bool = False) -> List[str]:
    return sorted({_registrable(c["domain"]) for c in vault_cookies(include_sensitive)})


# ---------------------------------------------------------------------------
# What is remembered, so a run does not pay a round trip to learn nothing
# ---------------------------------------------------------------------------

def _cache() -> Dict[str, Any]:
    try:
        return json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_cache(data: Dict[str, Any]) -> None:
    try:
        _CACHE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def _remember(pid: str, domains: List[str], seeded: bool = False) -> None:
    data = _cache()
    profiles = data.setdefault("profiles", {})
    entry = profiles.setdefault(pid, {})
    entry["domains"] = domains
    entry["checked_at"] = int(time.time())
    if seeded:
        entry["seeded_at"] = int(time.time())
    _write_cache(data)


def signed_in_domains(pid: str = "") -> List[str]:
    """
    Which sites the profile is believed to hold a session for, from memory
    alone. It writes a sentence in the brief; it is never worth a network call.
    """
    pid = pid or profile_id()
    if not pid:
        return []
    entry = (_cache().get("profiles") or {}).get(pid) or {}
    return [str(d) for d in (entry.get("domains") or [])]


# ---------------------------------------------------------------------------
# The import
# ---------------------------------------------------------------------------

def _start_browser(pid: str) -> Dict[str, Any]:
    body = {
        "profileId": pid,
        # No proxy for this one. Nothing is fetched, so a residential exit would
        # be billed for carrying nothing -- and the country that matters is the
        # one an application runs from, not the one that wrote the jar.
        "proxyCountryCode": None,
        "timeout": _SEED_MINUTES,
        "metadata": {"purpose": "cookie-seed", "app": "mapjob"},
    }
    res = requests.post(f"{_api_base()}/browsers", headers=_headers(),
                        json=body, timeout=_TIMEOUT)
    if res.status_code >= 400:
        if res.status_code == 402:
            raise RuntimeError("that Browser Use account is out of credit")
        raise RuntimeError(f"the cloud would not start a browser ({res.status_code}): {res.text[:300]}")
    return res.json()


def _stop_browser(session_id: str) -> None:
    if not session_id:
        return
    try:
        requests.patch(f"{_api_base()}/browsers/{session_id}", headers=_headers(),
                       json={"action": "stop"}, timeout=_TIMEOUT)
    except Exception:
        # It has a one-minute fuse of its own. Worth trying, not worth raising.
        pass


# How a result crosses back from the child process: one line nobody else writes.
_RESULT = "__CLOUD_PROFILE_RESULT__"


def _in_child(flag: str, extra: Optional[List[str]] = None,
              log=lambda _m: None, timeout: int = 300) -> Dict[str, Any]:
    """
    Do the browser half in a process of its own.

    Not architecture for its own sake. Playwright's synchronous API starts its
    driver with an asyncio subprocess, and a worker thread inside the API server
    on Windows has an event loop that cannot make one -- it fails with a bare
    NotImplementedError, which reads like a missing feature and is really a
    thread with the wrong kind of loop. Every fix that stays in-process means
    changing the event loop policy of a running web server from one of its
    worker threads, to make a browser connection that lasts fifteen seconds.

    A child process has a clean main thread and the default policy, and it costs
    a second to start. Its printed lines are forwarded so the panel still sees
    what happened; its result comes back on the marked line.
    """
    import subprocess
    import sys

    root = Path(__file__).resolve().parents[2]
    cmd = [sys.executable, "-m", "services.automation.cloud_profile", flag] + list(extra or [])
    try:
        proc = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True,
                              timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return {"status": "failed",
                "message": f"The browser step could not be started ({exc.__class__.__name__})."}

    result: Dict[str, Any] = {}
    for line in (proc.stdout or "").splitlines():
        if line.startswith(_RESULT):
            try:
                result = json.loads(line[len(_RESULT):])
            except Exception:
                result = {}
        elif line.strip():
            log(line.rstrip())
    if result:
        return result
    tail = ((proc.stderr or "").strip().splitlines() or ["no output"])[-1]
    return {"status": "failed", "message": "The browser step did not finish.", "detail": tail[:300]}


def seed(pid: str = "", include_sensitive: Optional[bool] = None,
         log=lambda _m: None) -> Dict[str, Any]:
    """Sign the cloud browser in. The browser part runs in a child process."""
    extra = ["--include-google"] if include_sensitive else []
    if pid:
        extra += ["--profile", pid]
    return _in_child("--seed-now", extra, log=log)


def harvest(pid: str = "", log=lambda _m: None) -> Dict[str, Any]:
    """Bring the cloud browser's cookies home. Child process, same reason."""
    extra = ["--profile", pid] if pid else []
    return _in_child("--harvest-now", extra, log=log)


def _inject(cdp_url: str, cookies: List[Dict[str, Any]]) -> None:
    """
    Attach to the remote browser and write the jar.

    The connection is dropped rather than the browser closed: stopping the
    session is their call to make, and it is the stop that saves the profile.
    """
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(cdp_url, timeout=60_000)
        context = browser.contexts[0] if browser.contexts else browser.new_context()
        context.add_cookies(cookies)


def _seed_here(pid: str = "", include_sensitive: Optional[bool] = None,
               log=lambda _m: None) -> Dict[str, Any]:
    """
    Put this machine's sessions into the cloud profile.

    One short browser session, no page opened, nothing submitted anywhere.
    """
    pid = pid or profile_id()
    if not _api_key():
        return {"status": "not-configured", "message": "No BROWSER_USE_API_KEY in .env."}
    if not pid:
        return {"status": "not-configured", "message": "No BROWSER_USE_PROFILE_ID in .env."}
    if include_sensitive is None:
        include_sensitive = (os.getenv("BROWSER_USE_SEED_GOOGLE") or "").strip().lower() in ("1", "true", "yes")

    cookies = vault_cookies(include_sensitive)
    if not cookies:
        return {"status": "empty-vault", "message": "No live cookies on this machine to send."}

    domains = sorted({_registrable(c["domain"]) for c in cookies})
    log(f"Signing the cloud browser in: {len(cookies)} cookies, {', '.join(domains)}")

    session = _start_browser(pid)
    session_id = str(session.get("id") or "")
    cdp = str(session.get("cdpUrl") or "")
    if not cdp:
        _stop_browser(session_id)
        return {"status": "failed", "message": "The cloud started a browser with no CDP address."}

    try:
        _inject(cdp, cookies)
    except Exception as exc:  # noqa: BLE001 - the caller only shows the sentence
        _stop_browser(session_id)
        return {"status": "failed",
                "message": "The cookies could not be written into the cloud browser: "
                           f"{exc.__class__.__name__}.",
                "detail": str(exc)[:300]}

    # The stop is the save. Everything before it lives in a browser that is
    # about to be thrown away.
    _stop_browser(session_id)

    held: List[str] = []
    for _ in range(_CONFIRM_TRIES):
        time.sleep(_CONFIRM_SLEEP)
        view = get_profile(pid)
        held = sorted({_registrable(d) for d in ((view or {}).get("cookieDomains") or [])})
        if held:
            break

    if not held:
        # Do not remember a success nobody can see. The next run tries again,
        # which is the right behaviour for a profile that may still be empty.
        return {"status": "unconfirmed",
                "message": "The cookies went in, but the profile has not reported them back yet.",
                "sent": domains}

    _remember(pid, held, seeded=True)
    log("The cloud browser is signed in to: " + ", ".join(held))
    return {"status": "seeded", "sent": domains, "domains": held}


def seed_if_new(pid: str = "", log=lambda _m: None) -> Dict[str, Any]:
    """
    Import the cookies when, and only when, the browser is new.

    "New" means the profile holds no cookies at all: one freshly made, or one on
    a fresh account after the last ran out of credit. A profile that already has
    sessions is left alone -- overwriting a jar the agent has been using, with
    cookies exported from here at some earlier date, trades a working session for
    an older one.

    Re-seeding a profile that has gone stale is a deliberate act: seed(), or the
    command line at the bottom of this file.
    """
    pid = pid or profile_id()
    if not (pid and _api_key()):
        return {"status": "not-configured", "domains": []}
    if (os.getenv("BROWSER_USE_AUTO_SEED") or "1").strip().lower() in ("0", "false", "no"):
        return {"status": "off", "domains": signed_in_domains(pid)}

    view = get_profile(pid)
    if view is None:
        # Their API did not answer. Not a reason to hold up an application, and
        # not a reason to promise the agent a signed-in browser either.
        return {"status": "unknown", "domains": signed_in_domains(pid)}

    held = sorted({_registrable(d) for d in (view.get("cookieDomains") or [])})
    if held:
        _remember(pid, held)
        return {"status": "already", "domains": held}

    log("This cloud browser is new -- there are no saved sessions on it.")
    return seed(pid, log=log)


# ---------------------------------------------------------------------------
# The other direction, which is the one with a deadline on it
# ---------------------------------------------------------------------------

def ensure_profile(name: str = "mapjob", user: str = "", log=lambda _m: None) -> str:
    """
    A profile on whichever account the key in .env belongs to.

    Profiles are org-scoped: a new account starts with none, and the id in .env
    is meaningless to it. So the first thing a new key needs is a profile of its
    own -- found by name if a previous attempt made one, created otherwise. The
    id is printed rather than written: .env is the user's file, and a script
    that edits it silently is a script nobody can audit.
    """
    pid = profile_id(user)
    if pid and get_profile(pid):
        return pid
    try:
        res = requests.get(f"{_api_base()}/profiles", headers=_headers(),
                           params={"pageSize": 100}, timeout=_TIMEOUT)
        for item in (res.json().get("items") or []) if res.status_code < 400 else []:
            if item.get("name") == name or (user and item.get("userId") == user):
                log(f"Using the profile already on this account: {item.get('id')}")
                return str(item.get("id") or "")
    except Exception:
        pass
    res = requests.post(f"{_api_base()}/profiles", headers=_headers(),
                        json={"name": name, "userId": user or "default"}, timeout=_TIMEOUT)
    if res.status_code >= 400:
        raise RuntimeError(f"the cloud would not make a profile ({res.status_code}): {res.text[:200]}")
    pid = str(res.json().get("id") or "")
    log(f"Made a profile on this account: {pid}")
    log("Put this in .env as BROWSER_USE_PROFILE_ID.")
    return pid


def _label(domain: str) -> str:
    """linkedin out of .www.linkedin.com: the vault files by site, not by host."""
    return _registrable(domain).split(".")[0] or "other"


def _export_shape(c: Dict[str, Any]) -> Dict[str, Any]:
    """
    A Playwright cookie written back in the shape the vault has always held.

    Three other modules read this file and all of them expect Chrome's export
    spelling. Saving it in Playwright's would have been tidier here and would
    have quietly emptied the local engine's jar.
    """
    out = {
        "domain": c.get("domain", ""),
        "name": c.get("name", ""),
        "value": c.get("value", ""),
        "path": c.get("path", "/"),
        "httpOnly": bool(c.get("httpOnly")),
        "secure": bool(c.get("secure")),
        "session": float(c.get("expires") or -1) <= 0,
        "hostOnly": not str(c.get("domain", "")).startswith("."),
        "storeId": None,
    }
    if float(c.get("expires") or -1) > 0:
        out["expirationDate"] = float(c["expires"])
    same = {"None": "no_restriction", "Lax": "lax", "Strict": "strict"}.get(str(c.get("sameSite") or ""))
    if same:
        out["sameSite"] = same
    return out


def _merge_into_vault(cookies: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Fold a harvested jar into the vault, newest expiry winning.

    Not "the cloud is right": the cloud profile is sometimes months behind the
    Chrome on this desk, and sometimes months ahead. A cookie with a later
    expiry is the later sign-in either way, and a session cookie -- no expiry at
    all -- never displaces a dated one.
    """
    vault = vault_groups()
    added, replaced = 0, 0
    for raw in cookies:
        c = _export_shape(raw)
        if not (c["name"] and c["domain"]):
            continue
        group = _label(c["domain"])
        bucket = vault.setdefault(group, [])
        key = (c["domain"], c["name"], c["path"])
        for i, old in enumerate(bucket):
            if (old.get("domain"), old.get("name"), old.get("path", "/")) == key:
                if float(c.get("expirationDate") or 0) >= float(old.get("expirationDate") or 0):
                    bucket[i] = c
                    replaced += 1
                break
        else:
            bucket.append(c)
            added += 1

    if VAULT_PATH.exists():
        # One step back, in case a harvest ever writes nonsense over a year of
        # sign-ins. Same directory, same gitignore rule.
        VAULT_PATH.with_suffix(".prev.json").write_text(
            VAULT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    VAULT_PATH.write_text(json.dumps(vault, indent=2), encoding="utf-8")
    return {"added": added, "replaced": replaced,
            "domains": sorted({_registrable(c["domain"]) for c in cookies if c.get("domain")})}


def _harvest_here(pid: str = "", log=lambda _m: None) -> Dict[str, Any]:
    """
    Read the cloud profile's jar back down into this machine's vault.

    The seeding direction only carries what this desk signed in by hand. The
    cloud browser has been signing itself into things ever since -- boards it
    registered on mid-application, German sites this machine has never seen --
    and none of that has ever come home. On the day the credit runs out and the
    account is replaced, everything only the cloud held is gone.

    And it is gone in the literal sense: reading a profile means starting a
    browser on it, and a browser costs credit. An account with no credit left
    answers POST /browsers with 402. So this is done while the account still
    works, not on the day it stops.
    """
    pid = pid or profile_id()
    if not (pid and _api_key()):
        return {"status": "not-configured"}

    session = _start_browser(pid)
    session_id = str(session.get("id") or "")
    cdp = str(session.get("cdpUrl") or "")
    if not cdp:
        _stop_browser(session_id)
        return {"status": "failed", "message": "The cloud started a browser with no CDP address."}

    from playwright.sync_api import sync_playwright
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(cdp, timeout=60_000)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            jar = context.cookies()
    except Exception as exc:  # noqa: BLE001
        _stop_browser(session_id)
        return {"status": "failed",
                "message": f"The cloud browser's cookies could not be read: {exc.__class__.__name__}.",
                "detail": str(exc)[:300]}
    finally:
        _stop_browser(session_id)

    if not jar:
        return {"status": "empty", "message": "That profile's browser had no cookies in it."}
    result = _merge_into_vault(jar)
    log(f"Brought home {len(jar)} cookies: {result['added']} new, {result['replaced']} refreshed.")
    return {"status": "harvested", "count": len(jar), **result}


# ---------------------------------------------------------------------------
# Changing accounts from the settings panel
# ---------------------------------------------------------------------------

# What the background seeding is doing, so a panel can say so. One installation,
# one cloud account, one seeding job at a time.
_SEED_LOCK = threading.Lock()
_SEED_STATE: Dict[str, Any] = {"running": False, "status": "", "message": "", "domains": []}


def _seed_state(**fields: Any) -> Dict[str, Any]:
    with _SEED_LOCK:
        _SEED_STATE.update(fields)
        return dict(_SEED_STATE)


def verify_key(key: str) -> Dict[str, Any]:
    """
    Does this key work, and what is on the account behind it?

    GET /profiles is the cheapest question their API answers: free, instant, and
    it fails differently for a key that is wrong (401) than for one whose
    account has no credit (which still lists profiles perfectly well -- running
    out of money does not delete anything, which is the whole reason the old
    account's cookies can still be harvested on the way out).
    """
    key = (key or "").strip()
    if not key:
        return {"ok": False, "message": "No key given."}
    try:
        res = requests.get(f"{_api_base()}/profiles", headers=_headers(key),
                           params={"pageSize": 100}, timeout=_TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Could not reach Browser Use ({exc.__class__.__name__})."}
    if res.status_code in (401, 403):
        return {"ok": False, "message": "Browser Use does not recognise that key."}
    if res.status_code >= 400:
        return {"ok": False, "message": f"Browser Use answered {res.status_code}."}
    items = res.json().get("items") or []
    return {"ok": True, "profiles": [{"id": i.get("id"), "name": i.get("name"),
                                      "domains": len(i.get("cookieDomains") or [])} for i in items]}


def adopt_key(key: str, log=lambda _m: None) -> Dict[str, Any]:
    """
    Switch the whole installation to a different Browser Use account.

    The interesting part is what is thrown away. A profile id belongs to the org
    that made it, so the moment the key changes the old id is a 404 waiting to
    happen and is dropped rather than kept "just in case". Everything else --
    which sites we are signed into, which accounts exist on which boards, the
    CV, the ledger -- was never theirs to begin with and does not move.

    Seeding runs in the background because it takes half a minute and starts a
    real browser. The panel gets an answer immediately and watches the rest.
    """
    check = verify_key(key)
    if not check.get("ok"):
        return {"ok": False, "message": check.get("message", "That key did not work.")}

    key = key.strip()
    previous = _account()
    data = dict(previous)
    data["api_key"] = key
    if key != previous.get("api_key"):
        # A new account: its profiles are not the old account's profiles.
        data.pop("profile_id", None)
    data["changed_at"] = int(time.time())
    _write_account(data)

    # Anything in this process that read the key from the environment at import
    # time -- and there is more of that than there should be -- now sees the new
    # one without a restart.
    os.environ["BROWSER_USE_API_KEY"] = key

    # A profile it can use: one already on the account if there is one, a new
    # one otherwise.
    existing = [p for p in check.get("profiles") or [] if p.get("id")]
    pid = ""
    try:
        named = next((p for p in existing if p.get("name") == "mapjob"), None)
        richest = max(existing, key=lambda p: p.get("domains") or 0) if existing else None
        chosen = named or (richest if (richest and (richest.get("domains") or 0) > 0) else None)
        pid = str(chosen["id"]) if chosen else ensure_profile(log=log)
    except Exception as exc:  # noqa: BLE001
        return {"ok": True, "key_saved": True, "profile_id": "",
                "message": f"The key works, but no profile could be made: {exc.__class__.__name__}."}

    data["profile_id"] = pid
    _write_account(data)
    os.environ["BROWSER_USE_PROFILE_ID"] = pid

    held = sorted({_registrable(d) for d in ((get_profile(pid) or {}).get("cookieDomains") or [])})
    if held:
        _remember(pid, held)
        return {"ok": True, "key_saved": True, "profile_id": pid, "domains": held,
                "message": "That account's browser is already signed in to "
                           + ", ".join(held) + "."}

    # Empty: this is the case the whole feature exists for.
    start_seeding(pid)
    return {"ok": True, "key_saved": True, "profile_id": pid, "domains": [], "seeding": True,
            "message": "Key accepted. Signing its browser in with the sessions saved here."}


def start_seeding(pid: str = "") -> Dict[str, Any]:
    """Seed in the background, so an HTTP request does not wait on a browser."""
    with _SEED_LOCK:
        if _SEED_STATE.get("running"):
            return dict(_SEED_STATE)
        _SEED_STATE.update({"running": True, "status": "working",
                            "message": "Signing the cloud browser in...", "domains": []})

    def work() -> None:
        try:
            result = seed(pid)
            _seed_state(running=False,
                        status=result.get("status", ""),
                        message=result.get("message", "") or
                        ("Signed in to " + ", ".join(result.get("domains") or []) + "."),
                        domains=result.get("domains") or [])
        except Exception as exc:  # noqa: BLE001
            _seed_state(running=False, status="failed",
                        message=f"The browser could not be signed in ({exc.__class__.__name__}).",
                        domains=[])

    threading.Thread(target=work, daemon=True).start()
    return _seed_state()


def status() -> Dict[str, Any]:
    """
    Everything the settings panel shows, and no key.

    The tail of the key is there so two accounts can be told apart at a glance;
    four characters name a key without being one.
    """
    key = api_key()
    stored = str(_account().get("api_key") or "").strip()
    pid = profile_id()
    with _SEED_LOCK:
        seeding = dict(_SEED_STATE)

    # Memory first, their API only when memory has nothing and there is no
    # seeding job in flight to answer the question in a second anyway. A panel
    # that opens to "signed into nothing" on a browser that is signed into
    # twenty sites is a panel that gets ignored.
    if pid and key and not signed_in_domains(pid) and not seeding.get("running"):
        held = sorted({_registrable(d) for d in ((get_profile(pid) or {}).get("cookieDomains") or [])})
        if held:
            _remember(pid, held)
    return {
        "configured": bool(key),
        "tail": key[-4:] if key else "",
        "source": "settings" if stored else ("env" if key else ""),
        "profile_id": pid,
        "domains": signed_in_domains(pid),
        "vault_domains": vault_domains(),
        "vault_cookies": len(vault_cookies()),
        "seeding": seeding,
        "changed_at": _account().get("changed_at") or 0,
    }


# ---------------------------------------------------------------------------
# By hand
# ---------------------------------------------------------------------------

def _report() -> None:
    now = time.time()
    print("Vault:", VAULT_PATH)
    for site, cookies in vault_groups().items():
        live = sum(1 for c in cookies
                   if not c.get("expirationDate") or float(c["expirationDate"]) > now)
        tag = "   held back: identity" if site in SENSITIVE else ""
        print(f"  {site:12s} {live:3d} live / {len(cookies):3d}{tag}")
    print("Would send:", ", ".join(vault_domains()) or "nothing")

    pid = profile_id()
    if not pid:
        print("Profile: none configured (BROWSER_USE_PROFILE_ID)")
        return
    view = get_profile(pid)
    if view is None:
        print(f"Profile {pid}: could not be read")
        return
    held = view.get("cookieDomains") or []
    print(f"Profile {pid} ({view.get('name') or 'unnamed'}): {len(held)} cookie domains")
    print("  " + (", ".join(sorted({_registrable(d) for d in held}))
                  or "nothing -- this browser is new"))


if __name__ == "__main__":
    import sys

    argv = sys.argv[1:]
    args = set(argv)
    asked_pid = argv[argv.index("--profile") + 1] if "--profile" in argv and len(argv) > argv.index("--profile") + 1 else ""

    # The two the server calls. They do the browser work here, in a process
    # whose main thread can start one, and hand the result back on one line.
    if "--seed-now" in args:
        print(_RESULT + json.dumps(_seed_here(asked_pid, include_sensitive="--include-google" in args, log=print)))
    elif "--harvest-now" in args:
        print(_RESULT + json.dumps(_harvest_here(asked_pid, log=print)))
    elif "--harvest" in args:
        # Do this while the account still has credit: reading a profile means
        # starting a browser on it, and a dead account cannot start one.
        print(json.dumps(harvest(log=print), indent=2))
    elif "--new-account" in args:
        # A new key, a new org, no profiles. Make one, fill it, print its id.
        new_pid = ensure_profile(log=print)
        print(json.dumps(seed(new_pid, include_sensitive="--include-google" in args, log=print), indent=2))
    elif "--seed" in args:
        # Deliberate, because it spends a little of the account's credit and
        # writes a real person's sessions into somebody else's browser.
        print(json.dumps(seed(include_sensitive="--include-google" in args, log=print), indent=2))
    elif "--if-new" in args:
        print(json.dumps(seed_if_new(log=print), indent=2))
    else:
        _report()
