# -*- coding: utf-8 -*-
"""
The automation browser's own Chrome profile: one directory on disk that
survives between runs.

Why this exists
---------------
Chrome keeps its cookies in the profile directory, not in the window. Every
run used to open against `tempfile.mkdtemp(...)` -- a factory-fresh profile
that had never seen any site -- and delete it afterwards, so no session could
possibly outlive a single application. The workaround was `cookies_vault.json`:
cookies lifted out of a real browser and replayed through CDP. That never
authenticated with Google, because the export kept only the `Secure` half of
each auth cookie family (`SSID` and `SAPISID` are there, `SID`, `HSID`,
`APISID` and `LSID` are not) and covered no `accounts.google.com` cookies at
all, which is exactly where a "Continue with Google" button lands.

A persistent profile removes the whole problem. Sign in by hand once, and
after that Google is looking at its own cookies in its own browser, rotating
`SIDTS`/`SIDCC` on their normal schedule instead of decaying towards an expiry
cliff. Employer portals get the same treatment for free.

Concurrency
-----------
Chrome takes an exclusive lock on a profile directory, so two runs cannot share
one. A second run therefore waits a short while, and if the profile is still
busy it proceeds on an empty throwaway with no saved sessions.

It does NOT get a copy of the profile, though that was the obvious design and
was tried first. Chrome binds Google sessions to a key kept in the profile --
the `Device Bound Sessions` database next to the cookie store -- so a clone
presents valid-looking cookies it cannot prove ownership of. That is the exact
signature of a stolen session, and Google's answer is to revoke it. Measured
here: after one cloned profile touched google.com, the original profile still
held all five auth cookies and was signed out anyway. Cloning does not
duplicate a session, it destroys one.
"""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional, Tuple

LOCAL_APP_DATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "MapJob"
AGENT_PROFILE_DIR = LOCAL_APP_DATA / "agent_profile"

# Kept beside the profile rather than inside it. Chrome rewrites its own
# directory wholesale and has been known to prune files it does not recognise.
LOCK_PATH = LOCAL_APP_DATA / "agent_profile.lock"
STATE_PATH = LOCAL_APP_DATA / "agent_profile.json"

TEMP_PREFIX = "mapjob_chrome_"


def _say(log: Optional[Callable[[str], None]], message: str) -> None:
    if log:
        try:
            log(message)
        except Exception:
            pass
    print(f"[Profile] {message}", flush=True)


def _process_alive(pid: int) -> bool:
    """
    True when `pid` belongs to a running process.

    Deliberately not `os.kill(pid, 0)`: on Windows that call does not probe,
    it opens the process and terminates it with the signal number as the exit
    code. The idiom is harmless on POSIX and lethal here.
    """
    try:
        import psutil
        return psutil.pid_exists(pid)
    except Exception:
        return True  # unknowable, so assume held rather than stealing the lock


def _read_lock() -> Optional[dict]:
    try:
        return json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def profile_exists() -> bool:
    return (AGENT_PROFILE_DIR / "Default" / "Network" / "Cookies").exists()


def read_state() -> dict:
    try:
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_state(**fields) -> None:
    state = read_state()
    state.update(fields)
    LOCAL_APP_DATA.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def google_is_linked() -> bool:
    """Whether a human has completed the one-time Google sign-in in this profile."""
    return bool(read_state().get("google_signed_in_at")) and profile_exists()


def signed_in_summary() -> str:
    state = read_state()
    when = state.get("google_signed_in_at")
    if not when or not profile_exists():
        return "not linked"
    days = (time.time() - float(when)) / 86400.0
    return f"linked as {state.get('google_account', 'unknown')} ({days:.0f} days ago)"


def acquire(log=None, wait_seconds: float = 20.0) -> Tuple[str, bool]:
    """
    Returns `(profile_directory, is_persistent)` for a run to launch against.

    The persistent profile whenever it is free, waiting briefly for a run that
    is on its way out. Otherwise an empty throwaway, and the caller is told
    plainly that this run starts logged out of everything -- which is worth
    saying, because the alternative fix, handing it a copy of the real profile,
    gets the Google session revoked.
    """
    LOCAL_APP_DATA.mkdir(parents=True, exist_ok=True)

    deadline = time.time() + max(0.0, wait_seconds)
    warned = False
    while True:
        holder = _read_lock()
        if not holder:
            break
        if not _process_alive(int(holder.get("pid", -1))):
            _say(log, "Clearing a lock left by a run that did not shut down.")
            break
        if time.time() >= deadline:
            _say(log, "Another run is using the saved browser profile, so this one "
                      "starts signed out. Sites needing an account will ask for one.")
            return tempfile.mkdtemp(prefix=TEMP_PREFIX), False
        if not warned:
            warned = True
            _say(log, "Waiting for the saved browser profile to come free...")
        time.sleep(1.0)

    AGENT_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        LOCK_PATH.write_text(json.dumps({"pid": os.getpid(), "at": time.time()}), encoding="utf-8")
    except Exception:
        pass
    return str(AGENT_PROFILE_DIR), True


def release(profile_dir: Optional[str], persistent: bool) -> None:
    """Frees the lock, or deletes the throwaway. Never deletes the real profile."""
    if persistent:
        try:
            LOCK_PATH.unlink()
        except Exception:
            pass
        return
    if profile_dir and os.path.exists(profile_dir) and os.path.basename(profile_dir).startswith(TEMP_PREFIX):
        shutil.rmtree(profile_dir, ignore_errors=True)


# The cookies Google sets for an authenticated session, and does not set for an
# anonymous one. Checking these beats reading the page: the sign-in screens are
# localised, restyled often, and the account-chooser tiles carry `data-email`
# attributes that look exactly like a signed-in avatar to a selector.
GOOGLE_AUTH_COOKIES = {"SID", "HSID", "SSID", "APISID", "SAPISID"}


def google_cookie_names(driver) -> set:
    """Every google.com cookie the browser currently holds, by name."""
    try:
        result = driver.execute_cdp_cmd("Network.getAllCookies", {}) or {}
    except Exception:
        return set()
    return {
        c.get("name")
        for c in result.get("cookies", [])
        if "google.com" in (c.get("domain") or "")
    }


def google_session_present(driver) -> bool:
    """True when this browser holds a complete Google auth cookie family."""
    return GOOGLE_AUTH_COOKIES.issubset(google_cookie_names(driver))


def google_probe_script() -> str:
    """
    Reads the signed-in state off a loaded www.google.com page.

    Only the sign-out link counts as proof. It is rendered by the account menu
    and has no equivalent anywhere in the signed-out flow.
    """
    return r"""
      const html = document.documentElement.innerHTML;
      const q = s => !!document.querySelector(s);
      const email = (html.match(/[a-z0-9._%+-]+@gmail\.com/i) || [null])[0];
      return {
        avatar: q('a[href*="SignOutOptions"]') || q('a[aria-label*="Google Account"]'),
        email: email,
        signin_button: /(^|>)\s*(Sign in|Se connecter|Inloggen|Anmelden)\s*</i.test(html),
      };
    """
