import os
import io
import sys
import time
import json
import base64
import queue
import logging
import threading
import tempfile
import shutil

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    import asyncio
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

from typing import Optional, Dict, Any, List
from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, Response
import urllib.request
import re
import requests
import pydantic
import uvicorn

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from services.automation.ai_dom_agent import AIDOMAgent
from services.automation.candidate_profile import CANDIDATE_PROFILE
from services.automation.page_agent_manager import PageAgentManager
from services.automation import agent_profile
from services.automation.outcome_ledger import OUTCOMES, read_outcomes, record_outcome
from services.automation.config import FUELIX_PAGE_AGENT as PAGE_AGENT_MODEL
from services.automation.chrome_launcher import launch_chrome
from services.automation.outreach_api import router as outreach_router
import undetected_chromedriver as uc

logger = logging.getLogger("api_server")

app = FastAPI(title="MapJob Automation Bridge")

# The prospecting workspace: its own module, mounted here because it needs the
# same LLM client, mailer and candidate profile the apply engine already holds.
app.include_router(outreach_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_caches() -> None:
    """Crawl the ATS boards while the server boots, not while someone waits.

    Without this the very first search of the day pays for all 33 boards. The
    crawl runs on a daemon thread, so a slow or unreachable board delays nothing
    -- the server is accepting requests the whole time, and until the crawl
    lands those requests are answered from the aggregator alone.
    """
    try:
        from services.automation.direct_ats_client import warm_job_cache
        warm_job_cache()
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not warm the ATS cache at startup: %s", e)

log_queue = queue.Queue()
active_agent_status = {
    "is_running": False,
    "last_result": None
}

current_manager_container = {"manager": None}
current_driver_container = {"driver": None}

# Set when Stop is pressed.
#
# Closing the browser is what stops a run that has one: the agent loop checks
# every tick whether the window is still there. But a run spends its first
# seconds with no browser at all -- resolving the employer's URL, waiting for
# the saved Chrome profile to come free -- and a Stop landing in that window
# used to do nothing at all: there was no driver to quit, the flags were set
# back to running by the worker a moment later, and Chrome opened on a job the
# candidate had already called off. So the worker checks this at each point
# where it is not yet holding a window.
agent_cancelled = threading.Event()


class RunCancelled(Exception):
    """Stop was pressed. Not an error: the run is simply over."""

# A finished rehearsal leaves its browser open on the filled form. That window is
# what the candidate reviews, and the same window is what sends the application
# if they approve it — filling a second browser from scratch would mean sending
# a form nobody had read.
pending_review: Dict[str, Any] = {
    "driver": None,
    "manager": None,
    "profile_dir": None,
    "profile_persistent": False,
    "job_title": "",
    "company": "",
    "url": "",
    "job_id": None,
    "notify_email": None,
    "started_at": None,
    "expires_at": None,
}
REVIEW_WINDOW_SECONDS = 15 * 60

agent_state = {
    "is_running": False,
    "dry_run": True,
    "started_at": None,
    "job_title": "",
    "company": "",
    "target_url": "",
    "phase": "idle",
    "current_step": "Ready",
    "logs": [],
    "screenshot": None,
    "screenshot_seq": 0,
    "last_result": None
}

class ApplyRequest(pydantic.BaseModel):
    url: str
    job_title: Optional[str] = ""
    company: Optional[str] = ""
    headless: Optional[bool] = False
    job_id: Optional[str] = None
    # Where the submission receipt goes; defaults to the configured candidate.
    notify_email: Optional[str] = None
    # A rehearsal by default: the agent fills the form and stops with the Submit
    # button untouched, so nothing reaches an employer unless it is asked for.
    dry_run: Optional[bool] = True

# --------------------------------------------------------------------------
# Driver failures, in the candidate's language.
#
# Selenium raises with a whole debugging apparatus attached: a `Message:`
# line, a `(Session info: chrome=...)` parenthetical, and forty frames of
# `undetected_chromedriver!GetHandleVerifier [0x1011c73+4e33]`. That is a
# stack trace for whoever wrote this file. It was being pushed verbatim into
# the run log and set as the status headline, so a candidate who closed the
# browser window got a page of hexadecimal where a sentence belonged.
#
# The raw text is not thrown away -- it goes to stdout and into the run's
# `detail`, which the panel keeps behind a disclosure -- but it is never the
# thing that speaks first.
# --------------------------------------------------------------------------

#: (needle in the raw error, sentence for the candidate). First match wins.
_DRIVER_FAILURES = (
    ("no such window",
     "The browser window was closed before the application was finished. Nothing was sent."),
    ("target window already closed",
     "The browser window was closed before the application was finished. Nothing was sent."),
    ("web view not found",
     "The browser window was closed before the application was finished. Nothing was sent."),
    ("invalid session id",
     "The browser stopped responding and the run was abandoned. Nothing was sent."),
    ("chrome not reachable",
     "The browser stopped responding and the run was abandoned. Nothing was sent."),
    ("disconnected: not connected to devtools",
     "The browser stopped responding and the run was abandoned. Nothing was sent."),
    ("cannot find chrome binary",
     "Chrome could not be found on this machine, so no browser could be opened."),
    ("this version of chromedriver only supports",
     "The browser and its driver are different versions, so the window could not be opened. "
     "Updating Chrome, or the driver, fixes this."),
    ("session not created",
     "A browser window could not be started. Another run may still be holding the profile."),
    ("err_name_not_resolved",
     "That address could not be reached -- the employer's site did not resolve."),
    ("err_connection",
     "The employer's site refused the connection, so the form never loaded."),
    ("err_internet_disconnected",
     "There is no internet connection, so the employer's page could not be loaded."),
    ("timeout", "The employer's page took too long to load, so the run was stopped."),
)


def humanize_driver_error(exc: BaseException) -> str:
    """One plain sentence describing why a run died."""
    raw = str(exc) or exc.__class__.__name__
    low = raw.lower()
    for needle, sentence in _DRIVER_FAILURES:
        if needle in low:
            return sentence
    # Unrecognised. Selenium's own first line is usually readable on its own,
    # so take it and drop everything the debugger added after it.
    head = raw.split("Stacktrace:")[0].split("(Session info:")[0]
    head = head.replace("Message:", "").strip().strip(".")
    head = re.sub(r"\s+", " ", head)
    if not head:
        return "The run stopped unexpectedly. Nothing was sent."
    if len(head) > 180:
        head = head[:177].rstrip() + "..."
    return f"The run stopped unexpectedly: {head}. Nothing was sent."


def error_detail(exc: BaseException) -> str:
    """The raw failure, for the disclosure and for the log on disk."""
    return f"{exc.__class__.__name__}: {exc}".strip()


def push_log(message: str, step: int = 0, status: str = "running", done: bool = False, success: bool = False):
    safe_msg = str(message).encode('utf-8', 'replace').decode('utf-8')
    print(f"[Engine] {safe_msg}", flush=True)
    payload = {
        "timestamp": time.strftime("%H:%M:%S"),
        "message": safe_msg,
        "step": step,
        "status": status,
        "done": done,
        "success": success
    }
    log_queue.put(payload)
    agent_state["current_step"] = safe_msg
    agent_state["logs"].append(payload)
    if len(agent_state["logs"]) > 100:
        agent_state["logs"] = agent_state["logs"][-100:]
    if done:
        # A finished rehearsal is not a submission, and should not be labelled one.
        if not success:
            agent_state["phase"] = "failed"
        else:
            agent_state["phase"] = "filled" if agent_state.get("dry_run", True) else "submitted"
        agent_state["is_running"] = False
        active_agent_status["is_running"] = False
    elif step >= 5:
        agent_state["phase"] = "autonomous_agent"
    elif step >= 3:
        agent_state["phase"] = "filling_form"
    elif step >= 1:
        agent_state["phase"] = "navigating"

def resolve_direct_portal(url: str) -> str:
    """
    If given an Adzuna aggregator URL (details or land/ad),
    resolves the genuine destination employer portal (e.g. careers.ecm-crit.com, HelloWork, Greenhouse, Lever, etc.)
    before browser launch so we don't get trapped by Adzuna newsletter/alert modals.
    """
    if not any(dom in url for dom in ["adzuna.", "adzuna/"]):
        return url
    try:
        s = requests.Session()
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        }
        r1 = s.get(url, headers=headers, timeout=10)
        land_match = re.search(r'href="([^"]*/land/ad/[^"]*)"', r1.text)
        land_url = land_match.group(1) if land_match else (url if "/land/ad/" in url else None)
        if land_url:
            if land_url.startswith('/'):
                from urllib.parse import urljoin
                land_url = urljoin(url, land_url)
            headers['Referer'] = url
            r2 = s.get(land_url, headers=headers, timeout=10)
            meta = re.search(r'<meta[^>]*http-equiv=["\']refresh["\'][^>]*content=["\']\d+;\s*url=([^"\']+)["\']', r2.text, re.I)
            if meta and meta.group(1):
                return meta.group(1)
            loc = re.search(r'location\.(?:replace|href)\s*=\s*["\'](https?://[^"\']+)["\']', r2.text)
            if loc and loc.group(1):
                return loc.group(1)
            if r2.url and "adzuna." not in r2.url:
                return r2.url
    except Exception as e:
        print(f"[Resolver] Notice: {e}")
    return url

def classify_outcome(result: Dict[str, Any], dry_run: bool) -> str:
    """
    Which of the ledger's words describes how this run ended.

    One place, so that the sentence shown on screen, the line written to the
    ledger and the state the UI moves into can never disagree about whether an
    application was sent -- which is the whole of what the candidate needs to
    know and the one thing that used to be left to whichever branch got there
    first.
    """
    if result.get("success"):
        return "awaiting_review" if dry_run else "applied"
    if result.get("sent_unconfirmed"):
        return "sent_unconfirmed"
    if result.get("barrier"):
        return "blocked"
    if result.get("browser_closed"):
        return "error"
    return "not_sent"


def log_outcome(outcome: str, *, job_title: str, company: str, url: str,
                job_id: Optional[str], message: str, evidence: str = "",
                dry_run: bool = False, started_at: Optional[float] = None,
                extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Records the run in the ledger and says so in the log, in plain words."""
    record = record_outcome(outcome, company=company, job_title=job_title, url=url,
                            job_id=job_id, message=message, evidence=evidence,
                            dry_run=dry_run, started_at=started_at, extra=extra)
    if outcome not in ("awaiting_review", "cancelled"):
        push_log(f"Tracked as: {OUTCOMES.get(outcome, outcome)}.", step=10)
    return record

def finalize_submission(job_title: str, company: str, portal_url: str, evidence: str,
                        job_id: Optional[str], notify_email: Optional[str],
                        started_at: float) -> Dict[str, Any]:
    """Record a *verified* submission and tell the candidate it happened.

    This runs only after the agent confirmed the employer's own success state,
    so nothing here can claim an application that was never sent. The employer's
    acknowledgement is a separate email that we watch for, not one we fabricate.
    """
    from services.automation import mailer
    from services.automation.email_watcher import EmailWatcher
    from services.automation.supabase_db import save_application_record

    submitted_at = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started_at))
    recipient = notify_email or CANDIDATE_PROFILE.get("email") or ""

    try:
        save_application_record(
            company=company,
            job_title=job_title,
            portal_url=portal_url,
            status="applied",
            job_id=job_id,
            logs=[entry.get("message", "") for entry in agent_state.get("logs", [])][-40:],
        )
    except Exception as e:
        push_log(f"Could not persist the application record: {e}", step=10)

    receipt = mailer.send_application_receipt(
        to_email=recipient,
        company=company,
        job_title=job_title,
        portal_url=portal_url,
        evidence=evidence,
        submitted_at=submitted_at,
    )
    if receipt.get("sent"):
        push_log(f"Receipt emailed to {recipient}.", step=10)
    else:
        push_log(receipt.get("reason", "Receipt email was not sent."), step=10)

    # The employer's acknowledgement arrives on its own schedule. Watch for it in
    # the background so the UI can show real proof instead of an assumption.
    def watch():
        try:
            watcher = EmailWatcher()
            if not watcher.is_configured():
                return
            found = watcher.wait_for_confirmation(company, since_epoch=started_at, timeout_seconds=600)
            result = agent_state.get("last_result") or {}
            result["employer_confirmation"] = found
            agent_state["last_result"] = result
            active_agent_status["last_result"] = result
        except Exception as e:
            print(f"[Confirmation] watcher stopped: {e}", flush=True)

    threading.Thread(target=watch, name="confirmation-watch", daemon=True).start()

    return {
        "receipt_email": receipt,
        "recipient": recipient,
        "submitted_at": submitted_at,
        "employer_confirmation": {"found": False, "pending": True},
    }

def run_agent_thread(target_url: str, job_title: str = "Candidate Position", company: str = "Employer",
                    headless: bool = False, job_id: Optional[str] = None,
                    notify_email: Optional[str] = None, dry_run: bool = True):
    active_agent_status["is_running"] = True
    started_at = time.time()
    push_log(f"Starting Autonomous AI Application Engine for URL: {target_url}", step=1)
    if dry_run:
        push_log("Rehearsal mode: the form gets filled, the Submit button is left for you.", step=1)

    # 1. Pre-resolve direct destination portal if this is an Adzuna aggregator wrapper
    resolved_url = resolve_direct_portal(target_url)
    if resolved_url != target_url:
        push_log(f"Resolved direct employer portal: {resolved_url}", step=1)
        target_url = resolved_url

    driver = None
    profile_dir = None
    profile_persistent = False
    keep_open = False

    def abort_if_cancelled():
        if agent_cancelled.is_set():
            raise RunCancelled()

    try:
        abort_if_cancelled()
        push_log("Configuring browser with anti-detect and session parameters...", step=2)
        options = uc.ChromeOptions()
        # ALWAYS run with visible maximized browser window so the user sees PageAgent in action
        options.add_argument("--start-maximized")
        options.add_argument("--disable-web-security")
        options.add_argument("--allow-running-insecure-content")
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")

        # The automation's own profile, so sessions signed into once are still
        # there next run. Falls back to a signed-in copy when another run holds
        # the lock, since Chrome will not share a profile directory.
        sweep_abandoned_profiles()
        profile_dir, profile_persistent = agent_profile.acquire(log=lambda m: push_log(m, step=2))
        # Waiting for the profile is the longest a run goes without a window,
        # and so the likeliest moment for someone to give up on it.
        abort_if_cancelled()
        if agent_profile.google_is_linked():
            push_log(f"Using the saved browser profile ({agent_profile.signed_in_summary()}).", step=2)
        else:
            push_log("No saved browser profile yet. Run 'python -m services.automation.link_google' "
                     "once to sign in, and sites will stop asking.", step=2)

        push_log("Opening browser window on screen...", step=2)
        driver = launch_chrome(options=options, user_data_dir=profile_dir,
                               log=lambda msg: push_log(msg, step=2))
        current_driver_container["driver"] = driver
        # Chrome takes a few seconds to come up, and a Stop that arrived during
        # them found nothing to close. Now the window is shut on the next line.
        abort_if_cancelled()
        try:
            driver.maximize_window()
        except Exception:
            pass
        try:
            driver.execute_cdp_cmd("Page.bringToFront", {})
        except Exception:
            pass

        # A profile whose Google cookies have gone missing is still marked as
        # linked, and would otherwise fail one sign-in at a time with no
        # explanation. Cheap to check here, since the browser is already open.
        if profile_persistent and agent_profile.google_is_linked() \
                and not agent_profile.google_session_present(driver):
            push_log("The saved Google sign-in has lapsed. Run "
                     "'python -m services.automation.link_google' to restore it.", step=2)

        # Inject cookie vault for recognized sites if any.
        # Once the profile carries a real Google session, the vault's Google
        # cookies are not just useless but harmful: they are an incomplete
        # export (no SID/HSID/APISID/LSID) and injecting them overwrites the
        # live values with dead ones.
        try:
            agent_dom = AIDOMAgent(driver)
            agent_dom.inject_cookie_vault(
                skip_platforms=("google", "gmail") if agent_profile.google_is_linked() else ()
            )
        except Exception:
            pass

        # Built before the navigation rather than after it, purely so the live
        # view can start. Frames are read off the manager, so until it existed
        # there was nothing to read: the panel sat on "the live view appears
        # here" through profile setup, the window opening, the page load and
        # the cookie banner -- the better part of a minute of blank box on a
        # run whose whole point is that you can watch it. It owns no state
        # until `run_agent`, so moving it up costs nothing.
        page_manager = PageAgentManager(driver, log_callback=push_log)
        current_manager_container["manager"] = page_manager
        # An empty browser window, but a real one: proof the run got that far.
        page_manager.capture_screenshot()

        abort_if_cancelled()
        push_log(f"Navigating to employer portal: {target_url}", step=3)
        driver.get(target_url)
        page_manager.capture_screenshot()
        time.sleep(2)
        page_manager.capture_screenshot()
        
        # Run autonomous agent loop
        # The agent now types every field itself rather than finishing off what
        # a second filler started, so the run is a handful of steps longer at
        # roughly four seconds each. The budget reflects that.
        res = page_manager.run_agent(job_title=job_title, company=company, candidate=CANDIDATE_PROFILE,
                                     max_wait_seconds=180, submit=not dry_run)

        success = res.get("success", False)
        barrier = res.get("barrier", False)
        msg = res.get("message", "Application completed.")

        receipt = None
        if success and dry_run:
            # Nothing was sent, so there is nothing to record or acknowledge.
            # The window stays open: it holds the filled form the candidate is
            # about to read, and it is the same window that will send it.
            keep_open = True
            pending_review.update({
                "driver": driver,
                "manager": page_manager,
                "profile_dir": profile_dir,
                "profile_persistent": profile_persistent,
                "job_title": job_title,
                "company": company,
                "url": target_url,
                "job_id": job_id,
                "notify_email": notify_email,
                "started_at": started_at,
                "expires_at": time.time() + REVIEW_WINDOW_SECONDS,
            })
            threading.Thread(target=expire_pending_review, args=(pending_review["expires_at"],),
                             name="review-expiry", daemon=True).start()
            push_log(f"✅ Form filled and left for your review: {msg}", step=10, done=True, success=True)
            log_outcome("awaiting_review", job_title=job_title, company=company, url=target_url,
                        job_id=job_id, message=msg, dry_run=True, started_at=started_at)
        elif success:
            push_log(f"🎉 Application Submitted & Verified: {msg}", step=10, success=True)
            receipt = finalize_submission(
                job_title=job_title,
                company=company,
                portal_url=target_url,
                evidence=res.get("evidence") or msg,
                job_id=job_id,
                notify_email=notify_email,
                started_at=started_at,
            )
            push_log("Application recorded and receipt processed.", step=10, done=True, success=True)
        elif barrier:
            push_log(f"⚠️ Portal Barrier: {msg}", step=10, done=True, success=False)
        elif res.get("sent_unconfirmed"):
            push_log(f"Sent, but unconfirmed: {msg}", step=10, done=True, success=False)
        else:
            push_log(f"⚠️ Application Incomplete: {msg}", step=10, done=True, success=False)

        # Every ending is written down, not just the good one. A failure that
        # leaves no record is the one that gets silently applied to twice.
        outcome = classify_outcome(res, dry_run)
        if outcome != "awaiting_review":
            log_outcome(outcome, job_title=job_title, company=company, url=target_url,
                        job_id=job_id, message=msg, evidence=res.get("evidence") or "",
                        dry_run=dry_run, started_at=started_at)

        active_agent_status["last_result"] = {
            "success": success,
            "barrier": barrier,
            "message": msg,
            "outcome": outcome,
            "sent": outcome in ("applied", "sent_unconfirmed"),
            "sent_unconfirmed": bool(res.get("sent_unconfirmed")),
            "receipt": receipt,
            "dry_run": dry_run,
            "submitted": bool(success and not dry_run),
            "awaiting_review": bool(success and dry_run),
            "fields_filled": res.get("fields_filled", 0),
            "resume_attached": bool(res.get("resume_attached")),
            "unexpected_submit": bool(res.get("unexpected_submit")),
        }
        agent_state["last_result"] = active_agent_status["last_result"]

    except RunCancelled:
        # Everything worth saying was said by the endpoint that set the flag:
        # the log line, the ledger entry and the result the panel reads. This
        # only has to unwind quietly -- the `finally` below shuts the window --
        # and to leave the state that endpoint wrote exactly as it found it.
        print("[Engine] run cancelled before the browser was in use.", flush=True)
        agent_state["phase"] = "cancelled"

    except Exception as e:
        # The sentence the candidate reads, and the trace they can open if they
        # want it. Never the other way round.
        friendly = humanize_driver_error(e)
        detail = error_detail(e)
        print(f"[Engine] run failed: {detail}", flush=True)
        push_log(friendly, step=99, done=True, success=False)
        log_outcome("error", job_title=job_title, company=company, url=target_url,
                    job_id=job_id, message=friendly, dry_run=dry_run, started_at=started_at,
                    extra={"detail": detail})
        active_agent_status["last_result"] = {
            "success": False, "message": friendly, "detail": detail, "dry_run": dry_run,
            "outcome": "error", "sent": False,
        }
        agent_state["last_result"] = active_agent_status["last_result"]
    finally:
        active_agent_status["is_running"] = False
        agent_state["is_running"] = False
        # Keep the last frame after the browser is gone: the final picture of
        # what happened is the most useful one, and it outlives the manager.
        manager = current_manager_container.get("manager")
        if manager and getattr(manager, "latest_screenshot", None):
            agent_state["screenshot"] = manager.latest_screenshot
            agent_state["screenshot_seq"] = int(getattr(manager, "screenshot_seq", 0) or 0)
        if keep_open:
            # Deliberately left running: `pending_review` owns this browser now.
            current_manager_container["manager"] = pending_review["manager"]
            current_driver_container["driver"] = pending_review["driver"]
        else:
            current_manager_container["manager"] = None
            current_driver_container["driver"] = None
            if driver:
                try:
                    # The pause is there so a finished run's last page can be
                    # read. A cancelled one has nobody reading it.
                    if not agent_cancelled.is_set():
                        time.sleep(5)
                    driver.quit()
                except Exception:
                    pass
            # Releases the lock on the persistent profile, or deletes the
            # throwaway. Never deletes the profile the user signed into.
            try:
                agent_profile.release(profile_dir, profile_persistent)
            except Exception:
                pass


PROFILE_PREFIX = "mapjob_chrome_"
# Long enough that a profile still in use is never a candidate, since a run
# holds its profile open for the whole review window.
PROFILE_STALE_SECONDS = 30 * 60


def sweep_abandoned_profiles() -> int:
    """
    Deletes Chrome profiles left behind by runs that did not finish, and
    returns the megabytes reclaimed.

    Each run gets a fresh temp profile, and the tidy-up only happens on the
    paths that end normally. A crashed browser, a closed window or a reloaded
    server all skip it, so the directories pile up unnoticed — 802 MB of them
    had accumulated here, on a disk with under 3 GB left. A dead profile is
    unusable by definition: nothing ever reopens one, so anything old enough
    not to belong to a live run is safe to drop.
    """
    root = tempfile.gettempdir()
    cutoff = time.time() - PROFILE_STALE_SECONDS
    freed = 0
    try:
        names = os.listdir(root)
    except OSError:
        return 0
    for name in names:
        if not name.startswith(PROFILE_PREFIX):
            continue
        path = os.path.join(root, name)
        try:
            if not os.path.isdir(path) or os.path.getmtime(path) > cutoff:
                continue
            size = sum(
                os.path.getsize(os.path.join(dirpath, f))
                for dirpath, _, files in os.walk(path)
                for f in files
                if os.path.exists(os.path.join(dirpath, f))
            )
        except OSError:
            continue
        # A profile Chrome still holds keeps its files locked, so Windows
        # simply refuses and the directory stays. That is the outcome we want.
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            freed += size
    mb = freed // (1024 * 1024)
    if mb:
        print(f"[Cleanup] reclaimed {mb} MB from abandoned Chrome profiles", flush=True)
    return mb


def close_pending_review(reason: str = ""):
    """Shuts the review browser and forgets it. Safe to call when there isn't one."""
    driver = pending_review.get("driver")
    profile_dir = pending_review.get("profile_dir")
    profile_persistent = bool(pending_review.get("profile_persistent"))
    pending_review.update({"driver": None, "manager": None, "profile_dir": None,
                           "profile_persistent": False, "expires_at": None})
    if current_driver_container.get("driver") is driver:
        current_driver_container["driver"] = None
        current_manager_container["manager"] = None
    if driver:
        if reason:
            print(f"[Review] closing browser: {reason}", flush=True)
        try:
            driver.quit()
        except Exception:
            pass
    try:
        agent_profile.release(profile_dir, profile_persistent)
    except Exception:
        pass


def expire_pending_review(expires_at: float):
    """
    A review window that nobody comes back to would otherwise leave Chrome
    running forever. Waits out the deadline, then closes it — unless the
    candidate has since submitted, cancelled, or started something else, in
    which case this deadline no longer refers to the open browser.
    """
    while True:
        remaining = expires_at - time.time()
        if remaining <= 0:
            break
        time.sleep(min(remaining, 15))
        if pending_review.get("expires_at") != expires_at:
            return
    if pending_review.get("expires_at") == expires_at and pending_review.get("driver"):
        push_log("Review window closed after 15 minutes with no decision. Nothing was sent.",
                 step=10, done=True, success=False)
        close_pending_review("review window expired")


def submit_pending_thread():
    """
    Sends the form the candidate just read, in the browser they read it in.

    Re-opening a second browser and filling it again would mean submitting a
    form nobody had seen — the model does not fill a page identically twice.
    """
    manager = pending_review.get("manager")
    driver = pending_review.get("driver")
    job_title = pending_review.get("job_title") or "Position"
    company = pending_review.get("company") or "Employer"
    target_url = pending_review.get("url") or ""
    started_at = pending_review.get("started_at") or time.time()
    # This deadline is no longer live: the run has been taken over here.
    pending_review["expires_at"] = None

    active_agent_status["is_running"] = True
    agent_state["is_running"] = True
    agent_state["dry_run"] = False
    agent_state["phase"] = "autonomous_agent"

    try:
        if not manager or not driver:
            push_log("That filled form is no longer open, so there is nothing to send.",
                     step=10, done=True, success=False)
            agent_state["last_result"] = {"success": False, "dry_run": False,
                                          "message": "The review browser was already closed."}
            active_agent_status["last_result"] = agent_state["last_result"]
            return

        push_log(f"Sending your application to {company}...", step=6)
        try:
            driver.execute_cdp_cmd("Page.bringToFront", {})
        except Exception:
            pass

        res = manager.submit_filled_form(job_title=job_title, company=company, max_wait_seconds=90)
        success = res.get("success", False)
        barrier = res.get("barrier", False)
        msg = res.get("message", "Submission attempt finished.")

        receipt = None
        if success:
            push_log(f"🎉 Application Submitted & Verified: {msg}", step=10, success=True)
            receipt = finalize_submission(
                job_title=job_title,
                company=company,
                portal_url=target_url,
                evidence=res.get("evidence") or msg,
                job_id=pending_review.get("job_id"),
                notify_email=pending_review.get("notify_email"),
                started_at=started_at,
            )
            push_log("Application recorded and receipt processed.", step=10, done=True, success=True)
        elif barrier:
            push_log(f"⚠️ Portal Barrier: {msg}", step=10, done=True, success=False)
        else:
            # No confirmation means no claim of one. The browser stays open so
            # the candidate can see for themselves what the page is showing.
            push_log(f"⚠️ Not sent, or not confirmed: {msg}", step=10, done=True, success=False)

        outcome = classify_outcome(res, dry_run=False)
        log_outcome(outcome, job_title=job_title, company=company, url=target_url,
                    job_id=pending_review.get("job_id"), message=msg,
                    evidence=res.get("evidence") or "", started_at=started_at)

        agent_state["last_result"] = {
            "success": success,
            "barrier": barrier,
            "message": msg,
            "receipt": receipt,
            "dry_run": False,
            "submitted": bool(success),
            "outcome": outcome,
            "sent": outcome in ("applied", "sent_unconfirmed"),
            "sent_unconfirmed": bool(res.get("sent_unconfirmed")),
        }
        active_agent_status["last_result"] = agent_state["last_result"]
    except Exception as e:
        friendly = humanize_driver_error(e)
        detail = error_detail(e)
        print(f"[Engine] submission failed: {detail}", flush=True)
        push_log(friendly, step=99, done=True, success=False)
        log_outcome("error", job_title=job_title, company=company, url=target_url,
                    job_id=pending_review.get("job_id"), message=friendly, started_at=started_at,
                    extra={"detail": detail})
        agent_state["last_result"] = {
            "success": False, "dry_run": False, "message": friendly, "detail": detail,
            "outcome": "error", "sent": False,
        }
        active_agent_status["last_result"] = agent_state["last_result"]
    finally:
        active_agent_status["is_running"] = False
        agent_state["is_running"] = False
        time.sleep(4)
        close_pending_review("submission finished")

@app.get("/")
def root():
    return {
        "status": "online",
        "service": "MapJob Automation Bridge",
        "candidate": "Badreddine Barki",
        "endpoints": {
            "web_ui": "http://localhost:5173",
            "api_status": "http://127.0.0.1:8000/api/status",
            "api_state": "http://127.0.0.1:8000/api/apply/state",
            "api_docs": "http://127.0.0.1:8000/docs",
            "cv_download": "http://127.0.0.1:8000/Badreddine_Barki_CV.pdf"
        }
    }

@app.post("/api/cancel")
def cancel_application():
    agent_cancelled.set()
    active_agent_status["is_running"] = False
    agent_state["is_running"] = False
    agent_state["phase"] = "cancelled"
    close_pending_review("cancelled by candidate")
    driver = current_driver_container.get("driver")
    if driver:
        try:
            driver.quit()
        except Exception:
            pass
        current_driver_container["driver"] = None
    current_manager_container["manager"] = None
    push_log("Application cancelled by user.", done=True, success=False)
    # An ending, not a silence. Without a result the panel cannot tell "stopped"
    # from "still thinking", so it would sit on a spinner until its own timeout
    # -- five minutes of watching something that is already over. `outcome` is
    # read by the client, which shows this as stopped rather than as failed:
    # nothing went wrong here, someone decided.
    cancelled_result = {
        "success": False,
        "submitted": False,
        "sent": False,
        "barrier": False,
        "outcome": "cancelled",
        "dry_run": agent_state.get("dry_run", True),
        "message": "Stopped before anything was sent.",
    }
    agent_state["last_result"] = cancelled_result
    active_agent_status["last_result"] = cancelled_result
    # push_log calls a finished run "failed"; this one has its own word.
    agent_state["phase"] = "cancelled"
    # Recorded like any other ending. "I stopped it myself" is a perfectly good
    # answer to "what happened with this job", and the absence of a line is not.
    record_outcome("cancelled", company=agent_state.get("company", ""),
                   job_title=agent_state.get("job_title", ""),
                   url=agent_state.get("target_url", ""),
                   job_id=agent_state.get("job_id", ""),
                   message="Stopped from the panel before it finished.",
                   started_at=agent_state.get("started_at"))
    return {"status": "cancelled"}


@app.post("/api/apply/submit")
def submit_reviewed_application():
    """
    Sends the application the candidate has just read, in the browser it is
    already open in. This is the only endpoint in the app that files anything
    with an employer, and it exists only after a rehearsal has shown the form.
    """
    if active_agent_status["is_running"]:
        raise HTTPException(status_code=400, detail="Something is already running in that browser.")
    if not pending_review.get("driver"):
        raise HTTPException(status_code=409,
                            detail="There is no filled form waiting. Run the apply again to fill one.")

    agent_state["is_running"] = True
    active_agent_status["is_running"] = True
    agent_state["phase"] = "autonomous_agent"
    agent_state["current_step"] = "Sending your application..."
    agent_state["last_result"] = None
    active_agent_status["last_result"] = None

    threading.Thread(target=submit_pending_thread, name="apply-submit", daemon=True).start()
    return {"status": "submitting", "company": pending_review.get("company")}

def latest_frame() -> Optional[str]:
    """The most recent screenshot as a data URI, or None."""
    manager = current_manager_container.get("manager")
    if manager and getattr(manager, "latest_screenshot", None):
        return manager.latest_screenshot
    return agent_state.get("screenshot")


def _as_web_frame(png: bytes) -> tuple[bytes, str]:
    """
    A frame small enough to be a frame.

    A maximised Chrome window screenshots to about four megabytes of PNG, and
    the panel asks for a new one roughly every second -- so the "live view"
    would have been four megabytes a second of localhost traffic, each frame
    arriving slowly enough to land as a slideshow. The panel renders it at
    around 700px wide, so most of those bytes are being thrown away by the
    scaler anyway.

    JPEG at 1280px wide is about fifty times smaller and indistinguishable at
    the size it is shown. Falls back to the original PNG if Pillow is not
    installed, because a heavy live view still beats none.
    """
    try:
        from PIL import Image
    except Exception:
        return png, "image/png"
    try:
        img = Image.open(io.BytesIO(png))
        if img.width > 1280:
            img = img.resize((1280, round(img.height * 1280 / img.width)), Image.LANCZOS)
        img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=72, optimize=True)
        return buf.getvalue(), "image/jpeg"
    except Exception as e:
        print(f"[Engine] frame resize failed, serving the original: {e}", flush=True)
        return png, "image/png"


@app.get("/api/apply/screenshot")
def get_apply_screenshot(seq: int = 0):
    """
    The live view of the browser.

    Kept out of the state payload on purpose: a screenshot runs to megabytes
    and the state is polled about once a second. `seq` only exists to make
    each frame a distinct URL, so the browser fetches the new one.
    """
    frame = latest_frame()
    if not frame or "," not in frame:
        raise HTTPException(status_code=404, detail="No screenshot has been captured yet.")
    try:
        png = base64.b64decode(frame.split(",", 1)[1])
    except Exception as e:
        # Logged rather than swallowed. `base64` was not imported at module
        # scope for a long time, so every single frame request raised NameError
        # in here and went out as a tidy 404 that read like "there is no
        # picture" -- which is why the live view had never once worked and
        # nothing anywhere said so. An except that turns a bug into a plausible
        # empty state is worse than no except at all.
        print(f"[Engine] frame decode failed: {e.__class__.__name__}: {e}", flush=True)
        raise HTTPException(status_code=404, detail="That screenshot could not be read.")
    body, media_type = _as_web_frame(png)
    return Response(content=body, media_type=media_type, headers={"Cache-Control": "no-store"})


@app.get("/api/applications")
def list_applications(limit: int = 50, job_id: str = ""):
    """
    What happened to every application that has been run, newest first.

    The panel only ever knows about the run it is watching, and it forgets even
    that when it closes. This is the durable answer to "did that one go
    through?" -- including, and especially, for the runs that did not.
    """
    records = read_outcomes(limit=max(1, min(limit, 500)), job_id=job_id)
    return {
        "count": len(records),
        "vocabulary": OUTCOMES,
        "applications": records,
        "sent": sum(1 for r in records if r.get("sent")),
        "confirmed": sum(1 for r in records if r.get("confirmed")),
    }


@app.get("/api/apply/state")
def get_apply_state():
    manager = current_manager_container.get("manager")
    seq = int(getattr(manager, "screenshot_seq", 0) or 0) or int(agent_state.get("screenshot_seq") or 0)
    # A URL rather than the picture itself, so polling this stays cheap.
    screenshot_url = f"/api/apply/screenshot?seq={seq}" if latest_frame() else ""

    return {
        "is_running": agent_state["is_running"],
        "job_title": agent_state["job_title"],
        "company": agent_state["company"],
        "target_url": agent_state["target_url"],
        "phase": agent_state["phase"],
        "current_step": agent_state["current_step"],
        "logs": agent_state["logs"][-35:],
        "screenshot_url": screenshot_url,
        "screenshot_seq": seq,
        "last_result": agent_state["last_result"],
        "dry_run": agent_state.get("dry_run", True),
        "started_at": agent_state.get("started_at"),
        "model": PAGE_AGENT_MODEL,
        # True while a filled form is sitting in an open browser, unsent.
        "awaiting_review": bool(pending_review.get("driver")),
    }

@app.post("/api/apply")
def start_application(req: ApplyRequest):
    if active_agent_status["is_running"]:
        raise HTTPException(status_code=400, detail="An application is already running in background.")

    # A browser left open on someone else's half-reviewed form has no claim on
    # the screen once a new run starts.
    close_pending_review("superseded by a new run")

    # Clear old logs
    while not log_queue.empty():
        try:
            log_queue.get_nowait()
        except Exception:
            break

    agent_cancelled.clear()
    active_agent_status["is_running"] = True
    active_agent_status["last_result"] = None

    agent_state["is_running"] = True
    agent_state["job_title"] = req.job_title or "Position"
    agent_state["company"] = req.company or "Employer"
    agent_state["target_url"] = req.url
    agent_state["phase"] = "navigating"
    agent_state["current_step"] = "Opening browser on employer portal..."
    agent_state["logs"] = []
    agent_state["screenshot"] = None
    agent_state["screenshot_seq"] = 0
    agent_state["last_result"] = None
    agent_state["dry_run"] = True if req.dry_run is None else bool(req.dry_run)
    agent_state["started_at"] = time.time()

    t = threading.Thread(
        target=run_agent_thread,
        args=(req.url, req.job_title or "Candidate Position", req.company or "Employer", req.headless),
        kwargs={"job_id": req.job_id, "notify_email": req.notify_email,
                "dry_run": True if req.dry_run is None else bool(req.dry_run)},
        daemon=True
    )
    t.start()

    from services.automation import mailer
    return {
        "status": "started",
        "url": req.url,
        "receipt_email_configured": mailer.is_configured(),
        "receipt_email_hint": mailer.configuration_hint(),
    }

@app.get("/api/apply/email-status")
def get_apply_email_status():
    """Whether MapJob can email a submission receipt, and to whom."""
    from services.automation import mailer
    from services.automation.email_watcher import EmailWatcher
    return {
        "receipt_email_configured": mailer.is_configured(),
        "receipt_email_hint": mailer.configuration_hint(),
        "recipient": CANDIDATE_PROFILE.get("email", ""),
        "inbox_watch_configured": EmailWatcher().is_configured(),
    }

@app.get("/api/apply/stream")
async def stream_logs(request: Request):
    async def event_generator():
        import asyncio
        while True:
            if await request.is_disconnected():
                break
            try:
                try:
                    msg = log_queue.get_nowait()
                    yield f"data: {json.dumps(msg)}\n\n"
                    if msg.get("done"):
                        break
                except queue.Empty:
                    if not active_agent_status["is_running"]:
                        break
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.5)
            except Exception:
                break
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/Badreddine_Barki_CV.pdf")
@app.get("/cv.pdf")
def get_cv():
    cv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))
    if os.path.exists(cv_path):
        return FileResponse(cv_path, media_type="application/pdf", filename="Badreddine_Barki_CV.pdf")
    raise HTTPException(status_code=404, detail="CV not found")

@app.get("/api/auto-apply/lookup")
def auto_apply_lookup(url: Optional[str] = None):
    return {
        "candidate": {
            "fullName": CANDIDATE_PROFILE.get("full_name", "Badreddine Barki"),
            "firstName": CANDIDATE_PROFILE.get("first_name", "Badreddine"),
            "lastName": CANDIDATE_PROFILE.get("last_name", "Barki"),
            "email": CANDIDATE_PROFILE.get("email", "badreddinebarki@gmail.com"),
            "phone": CANDIDATE_PROFILE.get("phone_formatted", "+33 7 45 76 80 10"),
            "city": CANDIDATE_PROFILE.get("city", "Amiens"),
            "postalCode": CANDIDATE_PROFILE.get("postal_code", "80000"),
            "address": CANDIDATE_PROFILE.get("address", "14 Rue de la 2e D.B."),
            "country": CANDIDATE_PROFILE.get("country", "France"),
            "linkedin": CANDIDATE_PROFILE.get("linkedin", "https://linkedin.com/in/badreddine-barki"),
            "portfolio": CANDIDATE_PROFILE.get("website", "https://barkibadreddine.com"),
            "jobTitle": CANDIDATE_PROFILE.get("current_title", "Ingénieur en Génie Mécanique"),
            "experienceYears": str(CANDIDATE_PROFILE.get("years_of_experience", 3)),
            "motivation": "Ingénieur en mécanique et simulation industrielle passionné par la conception et la gestion de projets techniques."
        },
        "jobTitle": "Ingénieur",
        "companyName": "",
        "cvPdfUrl": "http://127.0.0.1:8000/Badreddine_Barki_CV.pdf",
        "coverLetterPdfUrl": None
    }

@app.api_route("/api/llm-proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def llm_proxy(request: Request, path: str):
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL
    fuelix_url = f"{FUELIX_BASE_URL.rstrip('/')}/{path}"
    fuelix_key = FUELIX_API_KEY
    if not fuelix_key:
        raise HTTPException(status_code=500, detail="FUELIX_API_KEY not set in .env")
    body = await request.body()
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {fuelix_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    req = urllib.request.Request(fuelix_url, data=body if body else None, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content = resp.read()
            return Response(content=content, status_code=resp.status, media_type="application/json")
    except urllib.error.HTTPError as e:
        err_content = e.read()
        return Response(content=err_content, status_code=e.code, media_type="application/json")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class InterviewAnswerRequest(pydantic.BaseModel):
    question: str = ""
    transcript: str = ""
    lang: str = "fr"
    # What this particular interview is about, gathered before the call. An
    # answer that names the company's own product beats a generically good one,
    # and the model cannot know any of this from the transcript alone.
    job_title: str = ""
    company: str = ""
    job_description: str = ""
    notes: str = ""
    # Text pulled out of whatever the employer asked to be read beforehand.
    documents: str = ""
    # Hands-free: nobody pressed anything, the interviewer is mid-pause, and a
    # fast first word beats a better-reasoned one that lands five seconds late.
    fast: bool = False
    # What has already been said out loud in this interview, oldest first:
    # [{"question": ..., "answer": ...}]. Without it every answer opens by
    # introducing the candidate again, because to the model each request is
    # its first -- the backend holds no session state on purpose.
    answered: list[dict] = pydantic.Field(default_factory=list)

class InterviewAnalyzeRequest(pydantic.BaseModel):
    image: str = ""  # data URL (jpeg/png) screenshot of the shared tab
    question: str = ""

def _candidate_summary() -> str:
    try:
        p = CANDIDATE_PROFILE
        lines = [
            f"Name: {p.get('full_name', 'Badreddine Barki')}",
            f"Title: {p.get('current_title', '')} ({p.get('years_of_experience', '')}y)",
            f"Location: {p.get('city', '')}, {p.get('country', '')}",
            f"Email: {p.get('email', '')} | Phone: {p.get('phone_formatted', '')}",
            f"Skills: {', '.join(p.get('technical_skills', [])[:18])}",
            f"Languages: {json.dumps(p.get('languages', {}), ensure_ascii=False)}",
        ]
        for exp in p.get("experiences", [])[:3]:
            lines.append(f"- {exp.get('role', '')} @ {exp.get('company', '')} ({exp.get('period', '')}): {'; '.join(exp.get('highlights', [])[:3])}")
        for edu in p.get("education", [])[:2]:
            lines.append(f"- Edu: {edu.get('degree', '')}, {edu.get('institution', '')} ({edu.get('period', '')})")
        return "\n".join(lines)
    except Exception:
        return "Badreddine Barki, Ingenieur en Genie Mecanique, 3.5y R&D (Technip Energies, SLB), CAO CATIA/SolidWorks/Creo, FEA Abaqus/Ansys."

@app.get("/api/assembly/token")
def assembly_token():
    """Mint a short-lived AssemblyAI streaming token so the browser never sees the API key.

    This is the v3 streaming token, from streaming.assemblyai.com, which is
    what `wss://streaming.assemblyai.com/v3/ws` accepts. It used to ask the v2
    realtime endpoint for one, and the browser then presented that token to a
    v3 socket, which refused it -- so picking AssemblyAI in the engine menu
    always fell through to Google Speech without ever saying why.

    The upstream error body is passed through rather than swallowed: "status
    401" tells you to check the key, "status 402" tells you the account has no
    streaming credit, and those are different problems.
    """
    from services.automation.config import ASSEMBLYAI_API_KEY
    if not ASSEMBLYAI_API_KEY:
        return {"configured": False, "token": None, "error": "ASSEMBLYAI_API_KEY not configured in .env"}
    try:
        r = requests.get(
            "https://streaming.assemblyai.com/v3/token",
            headers={"Authorization": ASSEMBLYAI_API_KEY},
            params={"expires_in_seconds": 600},
            timeout=10,
        )
        if r.status_code == 200:
            return {"configured": True, "token": r.json().get("token")}
        detail = (r.text or "").strip()[:200]
        return {
            "configured": False,
            "token": None,
            "error": f"AssemblyAI status {r.status_code}{': ' + detail if detail else ''}",
        }
    except Exception as e:
        return {"configured": False, "token": None, "error": str(e)}

DOC_TEXT_CAP = 40000  # characters kept from one document; past this it is appendices


def _text_from_pdf(raw: bytes) -> tuple[str, int]:
    """Page text out of a PDF, preferring PyMuPDF and falling back to pypdf."""
    try:
        import fitz  # PyMuPDF

        with fitz.open(stream=raw, filetype="pdf") as doc:
            pages = [p.get_text("text") for p in doc]
        return "\n\n".join(pages), len(pages)
    except ImportError:
        pass
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(raw))
    pages = [(p.extract_text() or "") for p in reader.pages]
    return "\n\n".join(pages), len(pages)


def _text_from_docx(raw: bytes) -> str:
    import docx

    d = docx.Document(io.BytesIO(raw))
    blocks = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            blocks.append(" | ".join(c.text.strip() for c in row.cells))
    return "\n".join(b for b in blocks if b.strip())


@app.post("/api/interview/context/parse")
async def interview_context_parse(file: UploadFile = File(...)):
    """Turn a document the employer asked to be read into plain text.

    The extension decides the reader, and an unknown one is refused rather
    than guessed at: a .zip renamed to .pdf should fail here, not somewhere
    deeper. Nothing is written to disk -- the text goes back to the browser,
    which holds it for the session and sends it with each question.
    """
    name = (file.filename or "document").strip()
    ext = os.path.splitext(name)[1].lower()
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File larger than 20 MB")

    pages = 0
    try:
        if ext == ".pdf":
            text, pages = _text_from_pdf(raw)
        elif ext == ".docx":
            text = _text_from_docx(raw)
        elif ext in (".txt", ".md", ".rtf", ".csv"):
            text = raw.decode("utf-8", errors="replace")
        else:
            raise HTTPException(
                status_code=415,
                detail=f"Cannot read {ext or 'that kind of file'}. Use PDF, DOCX, TXT or MD.",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not read {name}: {e}")

    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise HTTPException(
            status_code=422,
            detail="No text in that file -- a scanned PDF needs OCR, which we do not do here.",
        )
    truncated = len(text) > DOC_TEXT_CAP
    return {
        "filename": name,
        "pages": pages,
        "chars": len(text),
        "truncated": truncated,
        "text": text[:DOC_TEXT_CAP],
    }


def _interview_brief(req: "InterviewAnswerRequest") -> str:
    """What this interview is about, as told to us before the call.

    Only the fields that were actually filled in appear: an empty heading is
    worse than no heading, because the model reads "COMPANY:" followed by
    nothing as a company with no name. Returns "" when nothing was given, so
    the caller can concatenate it unconditionally.
    """
    parts: list[str] = []
    if (req.job_title or "").strip():
        parts.append(f"ROLE: {req.job_title.strip()[:200]}")
    if (req.company or "").strip():
        parts.append(f"COMPANY: {req.company.strip()[:200]}")
    if (req.job_description or "").strip():
        parts.append(f"JOB DESCRIPTION:\n{req.job_description.strip()[:4000]}")
    if (req.notes or "").strip():
        parts.append(f"CANDIDATE NOTES:\n{req.notes.strip()[:2000]}")
    if (req.documents or "").strip():
        # The tail is usually appendices; the head is what the employer meant.
        parts.append(f"PRE-READING SENT BY THE EMPLOYER:\n{req.documents.strip()[:8000]}")
    if not parts:
        return ""
    return "THIS INTERVIEW:\n" + "\n\n".join(parts) + "\n\n"

HEURISTIC_ANSWER = (
    "Bonne question. Chez SLB puis Technip Energies, sur un sujet similaire : "
    "Situation - dimensionnement d'un assemblage sous chargement thermomecanique severe ; "
    "Tache - livrer une conception validee CAO 3D CATIA/SolidWorks avec justification FEA Abaqus/Ansys ; "
    "Action - modele parametrique, maillage converge, correlation essais et cotation GPS ISO ; "
    "Resultat - dossier valide en revue, zero reprise en industrialisation. "
    "Je peux detailler le maillage ou la DFMEA si vous voulez."
)


# One connection to Fuelix, kept open between answers. A fresh TCP+TLS
# handshake on every question is a few hundred milliseconds spent before a
# single token is asked for, and during an interview that is time the
# candidate spends silent.
_FUELIX_SESSION = requests.Session()


def _answer_prompt(req: "InterviewAnswerRequest") -> tuple[str, str, str]:
    """The question, the system prompt and the user prompt for one answer.

    Shared by the blocking and the streaming endpoint so the two can never
    drift into answering the same interview differently.
    """
    question = (req.question or req.transcript or "").strip()[-1500:]
    if not question:
        raise HTTPException(status_code=400, detail="Empty question/transcript")
    lang = "French" if req.lang == "fr" else "English"

    # The conversation so far, in the candidate's own voice. Trimmed hard: the
    # model needs to know which ground is already covered, not to re-read three
    # full answers before writing a fourth while a recruiter waits.
    history = ""
    for i, qa in enumerate(req.answered[-4:], 1):
        asked = str(qa.get("question", "")).strip()[:200]
        said = str(qa.get("answer", "")).strip()
        if not said:
            continue
        said = said[:700] + ("..." if len(said) > 700 else "")
        history += f"\nQ{i}: {asked}\nYou answered: {said}\n"

    system = (
        "You are a real-time interview copilot for Badreddine Barki, mechanical/R&D engineer. "
        f"Answer in {lang}, first person, 60-90 seconds spoken (120-170 words), STAR structure. "
        "Ground every claim in the CV below; never invent employers, degrees, or visa status. "
        "When a THIS INTERVIEW brief is present, aim the answer at that role and company and "
        "borrow their vocabulary, but never claim knowledge the brief does not contain. "
        "End with one crisp metric or result. No preamble, answer only."
    )
    if history:
        # Each request is stateless, so without this the model answers every
        # question as if it were the first and re-introduces the candidate on
        # question four.
        system += (
            " You are MID-INTERVIEW, not at the start: you have already been introduced and have "
            "already given the answers listed under ALREADY ANSWERED. Do NOT greet, do NOT thank "
            "them, do NOT state your name, your years of experience or a summary of your "
            "background again. Open directly on the substance of the question just asked. Do not "
            "reuse a project, employer example or figure that already appears there unless this "
            "question is explicitly a follow-up about it; pick a different one from the CV. If it "
            "is a follow-up, carry on from what you said instead of restating it."
        )
    already = f"ALREADY ANSWERED IN THIS INTERVIEW:\n{history}\n" if history else ""
    user = (
        f"CANDIDATE CV:\n{_candidate_summary()}\n\n{_interview_brief(req)}{already}"
        f"LIVE INTERVIEW (last words first):\n{req.transcript.strip()[-2000:]}\n\n"
        f"CURRENT QUESTION:\n{question}"
    )
    return question, system, user


@app.post("/api/interview/answer")
def interview_answer(req: InterviewAnswerRequest):
    """Generate a spoken-style interview answer from live transcript + CV via Fuelix."""
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL, FUELIX_WRITER, FUELIX_WRITER_FALLBACK
    _question, system, user = _answer_prompt(req)
    for model in [FUELIX_WRITER, FUELIX_WRITER_FALLBACK]:
        if not model or not FUELIX_API_KEY:
            continue
        try:
            r = requests.post(
                f"{FUELIX_BASE_URL.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {FUELIX_API_KEY}", "Content-Type": "application/json"},
                json={"model": model, "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ], "temperature": 0.4, "max_tokens": 450},
                timeout=45,
            )
            if r.status_code == 200:
                return {"answer": r.json()["choices"][0]["message"]["content"].strip(), "model": model}
        except Exception:
            continue
    # Offline heuristic fallback (STAR, CV-grounded)
    return {"answer": HEURISTIC_ANSWER, "model": "heuristic"}


@app.post("/api/interview/answer/stream")
def interview_answer_stream(req: InterviewAnswerRequest):
    """The same answer, token by token, as Server-Sent Events.

    An interview answer takes several seconds to write in full. Waiting for
    the last word before showing the first is the difference between reading
    along with the model and sitting in silence in front of a recruiter, so
    the hands-free teleprompter reads from here instead.
    """
    from services.automation.config import (
        FUELIX_API_KEY, FUELIX_BASE_URL, FUELIX_WRITER, FUELIX_WRITER_FALLBACK,
        FUELIX_LIVE, FUELIX_LIVE_FALLBACK,
    )
    _question, system, user = _answer_prompt(req)
    models = [FUELIX_LIVE, FUELIX_LIVE_FALLBACK] if req.fast else [FUELIX_WRITER, FUELIX_WRITER_FALLBACK]

    def sse(obj: dict) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def generate():
        for model in models:
            if not model or not FUELIX_API_KEY:
                continue
            try:
                with _FUELIX_SESSION.post(
                    f"{FUELIX_BASE_URL.rstrip('/')}/chat/completions",
                    headers={"Authorization": f"Bearer {FUELIX_API_KEY}", "Content-Type": "application/json"},
                    json={"model": model, "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ], "temperature": 0.4, "max_tokens": 450, "stream": True},
                    stream=True,
                    timeout=45,
                ) as r:
                    if r.status_code != 200:
                        continue
                    sent_any = False
                    for raw in r.iter_lines(decode_unicode=True):
                        if not raw or not raw.startswith("data:"):
                            continue
                        payload = raw[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            delta = json.loads(payload)["choices"][0].get("delta", {}).get("content")
                        except Exception:
                            continue
                        if delta:
                            if not sent_any:
                                # The model is named once, on the first token,
                                # so the UI can label the card before the end.
                                yield sse({"model": model})
                                sent_any = True
                            yield sse({"delta": delta})
                    if sent_any:
                        yield sse({"done": True})
                        return
            except Exception:
                continue
        # Every model failed or there is no key: the candidate still gets
        # something to say, exactly as the blocking endpoint would have given.
        yield sse({"model": "heuristic"})
        yield sse({"delta": HEURISTIC_ANSWER})
        yield sse({"done": True})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })

@app.post("/api/interview/analyze")
def interview_analyze(req: InterviewAnalyzeRequest):
    """Describe what's on the shared-tab screenshot to help answer (vision best-effort)."""
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL, FUELIX_WRITER
    if not req.image:
        raise HTTPException(status_code=400, detail="Empty image")
    if FUELIX_API_KEY:
        try:
            r = requests.post(
                f"{FUELIX_BASE_URL.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {FUELIX_API_KEY}", "Content-Type": "application/json"},
                json={"model": FUELIX_WRITER, "messages": [
                    {"role": "system", "content": "Describe the interview screen in 3 bullets: visible question/code/slide, speaker name if any, and what the candidate should focus on. Under 80 words."},
                    {"role": "user", "content": [
                        {"type": "text", "text": req.question or "What is on screen?"},
                        {"type": "image_url", "image_url": {"url": req.image[:200000]}},
                    ]},
                ], "temperature": 0.2, "max_tokens": 250},
                timeout=45,
            )
            if r.status_code == 200:
                return {"analysis": r.json()["choices"][0]["message"]["content"].strip()}
        except Exception:
            pass
    return {"analysis": "Vision unavailable (model/key). Read the question aloud via AI Answer instead."}

@app.get("/api/gemini/status")
def gemini_status():
    from services.automation.config import GEMINI_API_KEY, GEMINI_LIVE_MODEL
    return {"configured": bool(GEMINI_API_KEY), "model": GEMINI_LIVE_MODEL or "gemini-3.5-transcribe-live"}

class DirectApplyRequest(pydantic.BaseModel):
    job_id: str
    board: str
    provider: str = "Greenhouse"
    company: str = ""
    job_title: str = ""
    candidate: Optional[Dict[str, Any]] = None

# Below this many listings on screen, a viewport search is worth double-checking
# against the plain national feed. Set where it is because a real city view
# returns hundreds and a mis-named one returns single figures; anywhere in
# between is a quiet town, where both queries agree anyway.
ANCHOR_MIN_IN_VIEW = 25


# How many of those names to actually try. Each one is a fresh fan-out at
# Adzuna, so this is the ceiling on what a wrongly-named viewport may cost.
ANCHOR_MAX_TRIES = 2


def _viewport_anchor(bbox: str):
    """A map viewport as the (names, radius_km, country) Adzuna can search.

    Adzuna has no coordinate search, so the only way to ask it for what is on
    screen is to name the town in the middle and give a radius. Without this the
    map could only fetch a whole country in relevance order and discard whatever
    fell outside the view -- which is fine looking at a region and useless
    looking at a street, where it left nine listings out of tens of thousands.

    `names` is ordered fine-to-coarse, because there is no single administrative
    level that every country files jobs under.
    """
    from services.automation.adzuna_client import MARKETS, bbox_center_radius
    from services.automation.geocoder import reverse_place

    anchor = bbox_center_radius(bbox)
    if not anchor:
        return [], None, None
    lat, lng, radius_km = anchor
    try:
        found = reverse_place(lat, lng)
    except Exception as exc:  # noqa: BLE001
        # Never let naming the view stop the view from loading.
        logger.warning("Reverse geocode failed for %s,%s: %s", lat, lng, exc)
        return [], None, None
    if not found or not found.get("place"):
        return [], None, None
    country = (found.get("country") or "").lower()
    if country not in MARKETS:
        # Somewhere Adzuna does not cover, or somewhere we cannot attribute.
        # Searching for the name in a neighbour's market answers confidently
        # and wrongly, so this declines to anchor at all.
        return [], None, None
    names = found.get("places") or [found["place"]]
    return names[:ANCHOR_MAX_TRIES], radius_km, country


@app.get("/api/jobs/direct-ats")
def get_direct_ats_jobs(
    keywords: Optional[str] = None,
    city: Optional[str] = None,
    bbox: Optional[str] = None,
    limit: int = 1200,
    full: bool = False,
    source: str = "all",
):
    """Job listings for the map and the result column.

    source='adzuna' answers from the aggregator alone and never touches the ATS
    boards. That is not just a filter: crawling the verified boards is the
    expensive half of this endpoint, so skipping it is what takes a cold search
    from roughly twenty seconds to under three. source='ats' is the mirror
    image, and 'all' (the default) blends both as before.

    bbox='west,south,east,north' restricts results to a map viewport.
    Responses are slim by default; pass full=true for untruncated descriptions.
    """
    from services.automation.direct_ats_client import (
        fetch_all_direct_ats_jobs,
        filter_by_bbox,
        slim_job,
    )

    source = (source or "all").strip().lower()
    complete = True

    if source == "adzuna":
        from services.automation.adzuna_client import (
            countries_for_bbox,
            fetch_adzuna_feed,
        )

        # A viewport already says which markets are worth asking, so ask those
        # and spend the saved calls on depth instead of on countries that are
        # nowhere near the screen.
        countries = countries_for_bbox(bbox) if bbox and not city else None
        names, distance_km, anchor_country = (
            _viewport_anchor(bbox) if bbox and not city else ([], None, None)
        )
        # A named place lives in exactly one market, so asking the others for it
        # is a wasted call. Spending the whole budget on the one country that can
        # answer is what turns a border viewport from 100 listings into 300.
        if anchor_country:
            countries = (anchor_country,)

        if city or not names:
            jobs, complete = fetch_adzuna_feed(
                keywords=keywords or "", city=city or "", countries=countries
            )
        else:
            # Naming the middle of a viewport can go wrong in ways that do not
            # look like errors. Adzuna answers an unknown place with an empty
            # list, and the middle of Brussels is the commune of
            # Saint-Josse-ten-Noode, which it knows just well enough to return
            # five jobs for a city of a million. So the test is never "did that
            # work" but "did that beat the alternative": each candidate name and
            # the plain national feed are judged on the only thing that matters
            # here, how many real listings they put on this screen.
            jobs, complete, best = [], True, -1
            for attempt in list(names) + [""]:
                found, found_complete = fetch_adzuna_feed(
                    keywords=keywords or "",
                    city=attempt,
                    countries=countries,
                    distance_km=distance_km if attempt else None,
                )
                in_view = len(filter_by_bbox(found, bbox))
                if in_view > best:
                    jobs, complete, best = found, found_complete, in_view
                if in_view >= ANCHOR_MIN_IN_VIEW:
                    break
            logger.info("Viewport %s -> %s: %s in view.", bbox, names, best)
    else:
        jobs = fetch_all_direct_ats_jobs(
            keywords=keywords,
            city=city,
            include_aggregators=(source != "ats"),
        )

    total = len(jobs)

    if bbox:
        jobs = filter_by_bbox(jobs, bbox)

    matched = len(jobs)
    limit = max(1, min(limit, 5000))
    page = jobs[:limit]
    if not full:
        page = [slim_job(j) for j in page]

    return {
        "count": matched,
        "total": total,
        "truncated": matched > limit,
        # False while the deeper pages are still landing. The client asks again
        # shortly rather than treating a fast first paint as the whole feed.
        "complete": complete,
        "jobs": page,
    }


@app.get("/api/jobs/detail")
def get_direct_ats_job_detail(id: str):
    """Full record for one job, including the untruncated description."""
    from services.automation.direct_ats_client import get_job_by_id
    job = get_job_by_id(id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or no longer listed.")
    return {"job": job}

@app.get("/api/jobs/ats/questions")
def get_ats_questions(board: str, job_id: str, provider: str = "Greenhouse"):
    """Retrieve official application questions for an ATS job."""
    from services.automation.direct_ats_client import get_job_questions
    questions = get_job_questions(board=board, job_id=job_id, provider=provider)
    return {"questions": questions}

@app.post("/api/jobs/apply-direct")
def apply_direct_ats(req: DirectApplyRequest):
    """Try to submit the application over HTTP to the employer's own ATS.

    No browser agent is involved: it either goes over HTTP or it does not go at
    all. Today no aggregated board exposes a public application endpoint, so
    this always reports `portal_required` with the employer's form URL. It never
    emails a receipt for an application that was not actually sent.
    """
    from services.automation.direct_ats_client import submit_direct_api_application
    from services.automation.candidate_profile import CANDIDATE_PROFILE
    from services.automation.supabase_db import save_application_record, get_candidate_details
    from services.automation import mailer
    from services.automation.email_watcher import EmailWatcher

    c_info = get_candidate_details()
    c_info.update(CANDIDATE_PROFILE or {})
    if req.candidate:
        c_info.update(req.candidate)

    cv_path = (CANDIDATE_PROFILE.get("resumes") or {}).get("en") \
        or (CANDIDATE_PROFILE.get("resumes") or {}).get("fr")

    started_at = time.time()
    result = submit_direct_api_application(
        job_id=req.job_id,
        board=req.board,
        provider=req.provider,
        candidate=c_info,
        cv_path=cv_path,
    )

    company = req.company or req.board
    job_title = req.job_title or "Position"
    portal_url = result.get("applyUrl") or ""

    try:
        save_application_record(
            company=company,
            job_title=job_title,
            portal_url=portal_url,
            # "not_submitted" rather than "failed": nothing was attempted, so
            # this must not look like a rejected application in the history.
            status="applied" if result.get("success") else "not_submitted",
            job_id=req.job_id,
            form_data=result,
        )
    except Exception as e:
        print(f"[Direct ATS] Error saving to Supabase: {e}")

    if not result.get("success"):
        return result

    # Only reachable once some ATS accepts an unauthenticated submission. The
    # receipt is deliberately gated on the ATS's own success status so it can
    # never claim an application that was never sent.
    recipient = c_info.get("email") or CANDIDATE_PROFILE.get("email") or ""
    result["recipient"] = recipient
    result["receipt_email"] = mailer.send_application_receipt(
        to_email=recipient,
        company=company,
        job_title=job_title,
        portal_url=portal_url,
        evidence=result.get("evidence", ""),
        submitted_at=time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started_at)),
    )

    watcher = EmailWatcher()
    if watcher.is_configured():
        threading.Thread(
            target=lambda: watcher.wait_for_confirmation(company, since_epoch=started_at, timeout_seconds=600),
            name="direct-confirmation-watch",
            daemon=True,
        ).start()
    result["employer_confirmation"] = {"found": False, "pending": watcher.is_configured()}

    return result


# ---------------------------------------------------------------------------
# Browser applications.
#
# The HTTP route above can only ever report `portal_required`, because no board
# accepts an anonymous POST. Filling the employer's own form in a real browser
# is the mechanism that actually works, and these three endpoints are what
# connect it to the button.
#
# Filling a form takes 20-40 seconds, far longer than a request should be held
# open, so a run is started, given an id, and polled.
# ---------------------------------------------------------------------------

class BrowserApplyRequest(pydantic.BaseModel):
    job_url: str
    job_id: str = ""
    company: str = ""
    job_title: str = ""
    # Defaults to a rehearsal. Submitting to a real employer cannot be undone,
    # so the client has to ask for it explicitly, every time.
    dry_run: bool = True


@app.post("/api/apply/browser")
def start_browser_apply(req: BrowserApplyRequest):
    """Open the employer's form in a real browser and fill it from the profile.

    Returns immediately with a run id. With dry_run (the default) the run stops
    at a screenshot of the completed form and submits nothing.
    """
    from services.automation import apply_runner

    url = (req.job_url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="A job URL is required to open the application form.")

    run = apply_runner.start_apply(
        job_id=req.job_id,
        job_url=url,
        company=req.company,
        job_title=req.job_title,
        dry_run=req.dry_run,
    )
    return run.public()


@app.get("/api/apply/browser/runs")
def list_browser_applies(limit: int = 25):
    """Recent browser runs, newest first."""
    from services.automation import apply_runner
    return {"runs": apply_runner.list_runs(limit=limit)}


@app.get("/api/apply/browser/{run_id}")
def get_browser_apply(run_id: str):
    """Current state of one run. Poll this until `done` is true."""
    from services.automation import apply_runner

    run = apply_runner.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="No such application run.")
    return run.public()


@app.get("/api/apply/browser/{run_id}/screenshot")
def get_browser_apply_screenshot(run_id: str):
    """The captured form, so the candidate can read it before approving."""
    from services.automation import apply_runner

    path = apply_runner.screenshot_path(run_id)
    if not path:
        raise HTTPException(status_code=404, detail="No screenshot for this run.")
    return FileResponse(str(path), media_type="image/png")


def query_google_speech_l16(sess: requests.Session, pcm_bytes: bytes, l_code: str = "fr-FR") -> str:
    url = f"http://www.google.com/speech-api/v2/recognize?client=chromium&lang={l_code}&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"
    headers = {"Content-Type": "audio/l16; rate=16000"}
    try:
        resp = sess.post(url, headers=headers, data=pcm_bytes, timeout=2.5)
        if resp.status_code == 200:
            resp.encoding = "utf-8"
            for line in resp.text.strip().split("\n"):
                try:
                    p_data = json.loads(line)
                    results = p_data.get("result", [])
                    if results and len(results) > 0:
                        alt = results[0].get("alternative", [])
                        if alt and len(alt) > 0:
                            return alt[0].get("transcript", "").strip()
                except Exception:
                    continue
    except Exception:
        pass
    return ""

@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket, lang: str = "fr", engine: str = "google"):
    """
    High-performance real-time speech transcription relay:
    - engine="google" (default): Ultra-fast Chromium Speech v2 API with Whisper-1 fallback.
    - engine="gemini": Real-time bidirectional Gemini Live streaming via Google Bidi WebSocket.
    """
    import asyncio
    import base64
    import struct
    import math
    import io
    import wave
    from services.automation.config import GEMINI_API_KEY, GEMINI_LIVE_MODEL, FUELIX_API_KEY, FUELIX_BASE_URL

    await websocket.accept()

    # Route to Gemini Live if selected
    if engine.lower() == "gemini":
        if not GEMINI_API_KEY:
            await websocket.send_json({"error": "GEMINI_API_KEY not set in .env. Falling back to Google Speech."})
            engine = "google"
        else:
            try:
                import websockets as ws_lib
                model = GEMINI_LIVE_MODEL or "gemini-3.5-transcribe-live"
                codes = ["fr-FR"] if lang == "fr" else ["en-US"]
                vocab = ["CATIA", "SolidWorks", "Creo", "Abaqus", "Ansys", "thermomecanique",
                         "mecatronique", "cotation GPS", "tolerancement", "DFMEA",
                         "Technip Energies", "Framatome", "metrologie", "industrialisation"]
                gemini_url = (f"wss://generativelanguage.googleapis.com/ws/"
                              f"google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent"
                              f"?key={GEMINI_API_KEY}")

                async with ws_lib.connect(gemini_url, max_size=8 * 1024 * 1024) as gws:
                    await gws.send(json.dumps({"setup": {
                        "model": f"models/{model}",
                        "generationConfig": {"responseModalities": ["TEXT"]},
                        "inputAudioTranscription": {"languageCodes": codes, "customVocabulary": vocab},
                    }}))
                    try:
                        async with asyncio.timeout(15):
                            while True:
                                raw = await gws.recv()
                                hello = json.loads(raw)
                                if "setupComplete" in hello or "setup_complete" in hello:
                                    break
                    except Exception:
                        await websocket.send_json({"error": f"Gemini setup timeout for model {model}. Falling back to Google Speech."})
                        engine = "google"
                    else:
                        await websocket.send_json({"status": "live", "engine": "gemini", "model": model})

                        def extract_gemini(msg: dict):
                            sc = msg.get("serverContent") or msg.get("server_content") or {}
                            for key in ("inputTranscription", "input_transcription"):
                                node = sc.get(key)
                                if isinstance(node, dict) and node.get("text"):
                                    return node["text"], True
                            for key in ("interimInputTranscription", "interim_input_transcription"):
                                node = sc.get(key)
                                if isinstance(node, dict) and node.get("text"):
                                    return node["text"], False
                            return None

                        async def b2g():
                            try:
                                while True:
                                    data = await websocket.receive_json()
                                    if data.get("end"):
                                        return
                                    chunk = data.get("audio_data")
                                    if chunk:
                                        await gws.send(json.dumps({"realtimeInput": {
                                            "mediaChunks": [{"mimeType": "audio/pcm;rate=16000", "data": chunk}]}}))
                            except Exception:
                                return

                        async def g2b():
                            try:
                                async for raw in gws:
                                    msg = json.loads(raw)
                                    hit = extract_gemini(msg)
                                    if hit:
                                        text, final = hit
                                        await websocket.send_json({"transcript": text, "final": final, "engine": "gemini"})
                            except Exception:
                                return

                        await asyncio.wait({asyncio.create_task(b2g()), asyncio.create_task(g2b())}, return_when=asyncio.FIRST_COMPLETED)
                        return
            except Exception as e:
                await websocket.send_json({"error": f"Gemini connection error: {str(e)[:150]}. Falling back to Google Speech."})
                engine = "google"

    # Default / Primary: Google Chromium Speech API v2 + Whisper fallback
    http_session = requests.Session()
    speech_buffer = bytearray()
    speech_active = False
    silent_chunks_count = 0
    chunks_since_interim = 0
    last_transcript = ""
    last_interim = ""
    interim_inflight = False

    pref_lang = "fr-FR" if lang == "fr" else "en-US"
    fallback_lang = "en-US" if lang == "fr" else "fr-FR"

    hallucinations = {
        "you", "thank you", "thank you.", "merci", "merci.", "merci d'avoir regardé",
        "merci d'avoir regardé cette vidéo", "sous-titres réalisés par",
        "sous-titrage st'501", "bye", "bye bye", "thank you for watching", "silence",
        "foreign", "whispering", "music", "qu'est-ce que c'est que l'humanité"
    }

    async def run_interim(audio_snap: bytes, l_code: str):
        nonlocal interim_inflight, last_interim
        try:
            txt = await asyncio.to_thread(query_google_speech_l16, http_session, audio_snap, l_code)
            if txt:
                c_low = txt.lower().strip(' .,!?:;')
                if c_low not in hallucinations and c_low != last_interim.lower() and c_low != last_transcript.lower():
                    last_interim = txt
                    await websocket.send_json({
                        "transcript": txt,
                        "final": False,
                        "engine": "google"
                    })
        except Exception:
            pass
        finally:
            interim_inflight = False

    client = None
    if FUELIX_API_KEY:
        try:
            import openai
            client = openai.OpenAI(base_url=FUELIX_BASE_URL, api_key=FUELIX_API_KEY)
        except Exception:
            client = None

    await websocket.send_json({"status": "live", "engine": "google", "model": "google-chromium-v2"})

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("end"):
                break

            if data.get("type") == "set_lang" or ("lang" in data and "audio_data" not in data):
                new_l = data.get("lang", "en")
                pref_lang = "fr-FR" if new_l == "fr" else "en-US"
                fallback_lang = "en-US" if new_l == "fr" else "fr-FR"
                continue

            chunk_b64 = data.get("audio_data")
            if not chunk_b64:
                continue

            try:
                raw_chunk = base64.b64decode(chunk_b64)
            except Exception:
                continue

            count = len(raw_chunk) // 2
            if count == 0:
                continue

            try:
                shorts = struct.unpack(f"<{count}h", raw_chunk)
                rms = math.sqrt(sum(s * s for s in shorts) / count)
            except Exception:
                rms = 0

            # VAD threshold: speech active if RMS > 60 (clear tab audio)
            if rms >= 60:
                speech_active = True
                speech_buffer.extend(raw_chunk)
                silent_chunks_count = 0
                chunks_since_interim += 1

                # Interim word streaming every 2 chunks (~256ms)
                if chunks_since_interim >= 2 and len(speech_buffer) >= 6400 and not interim_inflight:
                    interim_inflight = True
                    chunks_since_interim = 0
                    snap = bytes(speech_buffer)
                    asyncio.create_task(run_interim(snap, pref_lang))

                # Continuous speech boundary (3.5s max): finalize and keep 200ms overlap
                if len(speech_buffer) >= 112000:
                    to_process = bytes(speech_buffer)
                    speech_buffer = bytearray(speech_buffer[-6400:])
                    silent_chunks_count = 0
                    chunks_since_interim = 0

                    transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, pref_lang)
                    if not transcribed_text:
                        transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, fallback_lang)
                    if transcribed_text:
                        c_low = transcribed_text.lower().strip(' .,!?:;')
                        if c_low not in hallucinations and c_low != last_transcript.lower():
                            last_transcript = transcribed_text
                            last_interim = ""
                            await websocket.send_json({
                                "transcript": transcribed_text,
                                "final": True,
                                "engine": "google"
                            })

            elif speech_active:
                silent_chunks_count += 1
                speech_buffer.extend(raw_chunk)

                # Utterance complete: 2 silent chunks (~250ms pause) with >= 0.2s audio (6400 bytes)
                if silent_chunks_count >= 2 and len(speech_buffer) >= 6400:
                    to_process = bytes(speech_buffer)
                    speech_buffer = bytearray()
                    speech_active = False
                    silent_chunks_count = 0
                    chunks_since_interim = 0
                    last_interim = ""

                    transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, pref_lang)
                    if not transcribed_text:
                        transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, fallback_lang)

                    # Secondary fallback: Fuelix Whisper
                    if not transcribed_text and client and len(to_process) >= 16000:
                        try:
                            buf = io.BytesIO()
                            with wave.open(buf, "wb") as wf:
                                wf.setnchannels(1)
                                wf.setsampwidth(2)
                                wf.setframerate(16000)
                                wf.writeframes(to_process)
                            buf.name = "chunk.wav"
                            buf.seek(0)
                            res = await asyncio.to_thread(client.audio.transcriptions.create, model="whisper-1", file=buf)
                            transcribed_text = (res.text or "").strip()
                        except Exception:
                            pass

                    if transcribed_text:
                        c_low = transcribed_text.lower().strip(' .,!?:;')
                        if c_low not in hallucinations and c_low != last_transcript.lower():
                            last_transcript = transcribed_text
                            await websocket.send_json({
                                "transcript": transcribed_text,
                                "final": True,
                                "engine": "google"
                            })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"error": f"Transcribe relay: {str(e)[:200]}"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

@app.get("/api/status")
def get_status():
    return active_agent_status

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
