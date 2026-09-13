# -*- coding: utf-8 -*-
"""Runs one browser application, in its own process, and reports on stdout.

Why a separate process rather than a thread.

Uvicorn installs Windows' selector event loop policy. `asyncio.new_event_loop()`
honours the process-wide policy, so the loop Playwright builds for itself is a
selector loop too, and a selector loop on Windows cannot spawn a subprocess: the
browser launch dies with a bare `NotImplementedError`. The policy is global, so
a thread cannot opt out of it without breaking the server's own loop.

A child process gets the default policy and launches the browser normally. It
also means a browser crash takes down a throwaway process instead of the API.

Protocol: one JSON object per line on stdout.
  {"event": "status", "status": "..."}     the coarse phase, for the spinner
  {"event": "log", "text": "..."}          one thing that just happened
  {"event": "result", ...}                 the engine's return value, once
Anything not parseable as JSON is log noise and the parent ignores it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Run as a script (`python -m` sets this up, but a bare path invocation needs it).
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))


def emit(payload: dict) -> None:
    """One JSON line, flushed, so the parent sees progress as it happens."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    from services.automation.apply_runner import build_vault, resume_path
    from services.automation.browser_engine import BrowserEngine

    request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)

    cv = resume_path()
    if cv is None:
        emit({"event": "result", "status": "FAILED", "reason": "NO_CV",
              "error": "No CV file was found on disk, so there was nothing to attach."})
        return 1

    emit({"event": "status", "status": "NAVIGATING"})

    engine = BrowserEngine(
        headless=bool(request.get("headless")),
        on_status=lambda status: emit({"event": "status", "status": status}),
        on_log=lambda text: emit({"event": "log", "text": text}),
    )
    try:
        result = engine.apply_job(
            job_url=request["job_url"],
            candidate_vault=build_vault(),
            cv_path=cv,
            dry_run=bool(request.get("dry_run", True)),
            # Context for the brain: which of several controls on a page opens
            # the form for *this* job rather than a related listing.
            job_title=request.get("job_title", ""),
        )
        result["event"] = "result"
        emit(result)
        # In visible mode, keep Chromium open for inspection or manual interaction until user closes the window or timeout (3 mins)
        if not bool(request.get("headless")):
            import time
            poll_start = time.time()
            max_wait = 180
            while time.time() - poll_start < max_wait:
                try:
                    if not engine.context or not engine.context.pages or all(p.is_closed() for p in engine.context.pages):
                        break
                    time.sleep(1)
                except Exception:
                    break
        return 0
    except Exception as exc:  # noqa: BLE001 - reported, not swallowed
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"event": "result", "status": "FAILED",
              "error": str(exc).strip() or type(exc).__name__})
        if not bool(request.get("headless")):
            import time
            poll_start = time.time()
            while time.time() - poll_start < 60:
                try:
                    if not engine.context or not engine.context.pages or all(p.is_closed() for p in engine.context.pages):
                        break
                    time.sleep(1)
                except Exception:
                    break
        return 1
    finally:
        try:
            engine.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
