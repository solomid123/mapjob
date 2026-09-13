# -*- coding: utf-8 -*-
"""Runs a browser application in the background and reports what it saw.

This is the piece that was missing. BrowserEngine could always drive a form;
nothing ever called it, because filling a form takes half a minute and an HTTP
request cannot politely sit there that long. So a run is started, given an id,
and polled.

Two rules the rest of the app depends on:

  * A run is a dry run unless the caller explicitly says otherwise. Submitting
    to a real employer is irreversible, so it is never the default and never a
    side effect of a mistyped field.
  * A run only ever reports what actually happened. If the engine could not
    verify the submission, the status says so rather than rounding up to
    success.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from .candidate_profile import CANDIDATE_PROFILE

WORKSPACE_DIR = Path(__file__).resolve().parent.parent.parent

# Terminal states. Anything else means the run is still going.
FINISHED = {
    "DRY_RUN_COMPLETED", "APPLIED", "SUBMITTED_UNVERIFIED",
    "NEEDS_CHECKPOINT", "FAILED", "SKIPPED",
}

# What each status means in words a person can act on. The engine speaks in
# enum values; the UI should not have to invent the explanation.
STATUS_TEXT = {
    "STARTING": "Opening the employer's page",
    "NAVIGATING": "Loading the application form",
    "FILLING": "Filling the form from your profile",
    # Not a failure and not a hang: the site put a security check on screen and
    # the run is holding while the candidate answers it themselves.
    "WAITING_FOR_HUMAN": "Waiting for you — the site is asking for a security check.",
    "READY_TO_SUBMIT": "Form filled. Review the screenshot before submitting.",
    "DRY_RUN_COMPLETED": "Form filled. Nothing was submitted.",
    "APPLIED": "Submitted, and the employer's page confirmed it.",
    "SUBMITTED_UNVERIFIED": "Submitted, but the page showed no confirmation. Check manually.",
    "NEEDS_CHECKPOINT": "Stopped and needs you.",
    "FAILED": "Could not complete.",
    "SKIPPED": "Already applied to this one.",
}


@dataclass
class ApplyRun:
    id: str
    job_id: str
    job_url: str
    company: str
    job_title: str
    dry_run: bool
    status: str = "STARTING"
    message: str = ""
    reason: str = ""
    fields_filled: int = 0
    screenshot: str = ""
    ats: str = ""
    resume_attached: bool = False
    # Required fields the form still wants. Non-empty means this cannot be
    # submitted as it stands, whatever else went well.
    missing_required: List[str] = field(default_factory=list)
    # What the browser did, in order, as it did it. A run takes the better part
    # of a minute, and a status word alone ("Filling the form") makes that
    # minute indistinguishable from a hang. These are the same sentences the
    # engine used to print to a console nobody could see.
    steps: List[str] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: Optional[float] = None

    def public(self) -> Dict[str, Any]:
        data = asdict(self)
        data["message"] = self.message or STATUS_TEXT.get(self.status, self.status)
        data["done"] = self.status in FINISHED
        data["elapsed"] = round((self.finished_at or time.time()) - self.started_at, 1)
        # A filesystem path is useless to a browser; hand out a URL it can load.
        data["screenshot_url"] = f"/api/apply/browser/{self.id}/screenshot" if self.screenshot else ""
        data.pop("screenshot", None)
        return data


_runs: Dict[str, ApplyRun] = {}
_lock = threading.Lock()


def get_run(run_id: str) -> Optional[ApplyRun]:
    with _lock:
        return _runs.get(run_id)


def list_runs(limit: int = 25) -> List[Dict[str, Any]]:
    with _lock:
        runs = sorted(_runs.values(), key=lambda r: -r.started_at)
    return [r.public() for r in runs[:limit]]


def screenshot_path(run_id: str) -> Optional[Path]:
    run = get_run(run_id)
    if not run or not run.screenshot:
        return None
    path = Path(run.screenshot)
    return path if path.exists() else None


def build_vault() -> Dict[str, Any]:
    """Reshape the stored profile into what BrowserEngine expects.

    The profile is flat and the engine wants it grouped, and the two disagree
    on a couple of names (`address` against `address_street`). Adapting here
    keeps the profile as the single place a real detail is written down.
    """
    profile = CANDIDATE_PROFILE or {}
    return {
        "personal": {
            "first_name": profile.get("first_name", ""),
            "last_name": profile.get("last_name", ""),
            "full_name": profile.get("full_name", ""),
            "email": profile.get("email", ""),
            "phone": profile.get("phone", ""),
            "phone_formatted": profile.get("phone_formatted", profile.get("phone", "")),
            "address_street": profile.get("address", ""),
            "city": profile.get("city", ""),
            "postal_code": profile.get("postal_code", ""),
            "country": profile.get("country", ""),
            "linkedin": profile.get("linkedin", ""),
            "website": profile.get("website", ""),
            "current_title": profile.get("current_title", ""),
            "years_of_experience": profile.get("years_of_experience", 0),
        },
        "legal": {
            "work_authorization": profile.get("work_authorization", ""),
            "requires_sponsorship": profile.get("requires_sponsorship", ""),
        },
    }


def resume_path(language: str = "en") -> Optional[Path]:
    """The CV file to upload, preferring the requested language."""
    resumes = (CANDIDATE_PROFILE or {}).get("resumes") or {}
    for key in (language, "en", "fr"):
        raw = resumes.get(key)
        if raw and Path(raw).exists():
            return Path(raw)
    return None


def _run_apply(run: ApplyRun) -> None:
    """Drive the browser in a child process and mirror its progress onto `run`.

    The engine is not called here directly. Uvicorn installs Windows' selector
    event loop policy process-wide, and a selector loop cannot spawn the browser
    subprocess, so Playwright fails on launch with a bare `NotImplementedError`.
    Overriding the policy from this thread would work by accident and change the
    server's own asyncio behaviour as a side effect; a child process gets a clean
    policy without touching anything. It also means a browser crash takes down a
    throwaway process rather than the API.

    Never raises: a crash in here must still leave the run with a status, or the
    UI polls a spinner forever.
    """
    request = {
        "job_url": run.job_url,
        "job_title": run.job_title,
        "dry_run": run.dry_run,
        # Visible on purpose. The candidate should be able to watch the form
        # being filled, and take the keyboard if the site asks for a CAPTCHA.
        "headless": False,
    }

    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "services.automation.apply_worker", json.dumps(request)],
            cwd=str(WORKSPACE_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _finish(run, "FAILED", reason=str(exc).strip() or type(exc).__name__,
                message="Could not start the browser process: %s" % exc)
        return

    last_result: Optional[Dict[str, Any]] = None
    try:
        for line in process.stdout or ():
            line = line.strip()
            if not line:
                continue
            if not line.startswith("{"):
                print("[apply %s] %s" % (run.id, line), flush=True)
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("event") == "status":
                _update(run, status=message.get("status", run.status))
            elif message.get("event") == "log":
                text = str(message.get("text", "")).strip()
                if text:
                    _append_step(run, text)
            elif message.get("event") == "result":
                last_result = message

        process.wait(timeout=30)
        stderr = (process.stderr.read() if process.stderr else "") or ""
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        _finish(run, "FAILED", reason=str(exc).strip() or type(exc).__name__,
                message="Lost contact with the browser: %s" % exc)
        return

    if stderr.strip():
        print("[apply %s] worker stderr:\n%s" % (run.id, stderr), flush=True)

    if last_result is None:
        # The worker died without reporting. Its stderr is the only evidence,
        # and saying so beats inventing a reason.
        tail = stderr.strip().splitlines()[-1] if stderr.strip() else "no output"
        _finish(run, "FAILED", reason=tail,
                message="The browser closed without finishing: %s" % tail)
        return

    _finish(
        run,
        status=last_result.get("status", "FAILED"),
        reason=last_result.get("reason", "") or last_result.get("error", ""),
        fields_filled=int(last_result.get("fields_filled") or 0),
        screenshot=last_result.get("screenshot") or "",
        ats=last_result.get("ats", ""),
        resume_attached=bool(last_result.get("resume_attached")),
        missing_required=list(last_result.get("missing_required") or []),
    )


def _append_step(run: ApplyRun, text: str) -> None:
    """Record one thing that happened. Capped: a pathological run must not
    grow the response until the panel cannot render it."""
    with _lock:
        if len(run.steps) < 120:
            run.steps.append(text)


def _update(run: ApplyRun, **changes: Any) -> None:
    with _lock:
        for key, value in changes.items():
            setattr(run, key, value)


def _finish(run: ApplyRun, status: str, **changes: Any) -> None:
    with _lock:
        run.status = status
        run.finished_at = time.time()
        for key, value in changes.items():
            setattr(run, key, value)


def start_apply(
    job_id: str,
    job_url: str,
    company: str,
    job_title: str,
    dry_run: bool = True,
) -> ApplyRun:
    """Begin an application in a background thread and return its handle.

    `dry_run` defaults to True on purpose, and the caller has to pass False in
    so that nothing reaches an employer because a parameter was forgotten.
    """
    run = ApplyRun(
        id=uuid.uuid4().hex[:12],
        job_id=job_id,
        job_url=job_url,
        company=company,
        job_title=job_title,
        dry_run=dry_run,
    )
    with _lock:
        _runs[run.id] = run
    threading.Thread(target=_run_apply, args=(run,), name="apply-%s" % run.id, daemon=True).start()
    return run
