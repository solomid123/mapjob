# -*- coding: utf-8 -*-
"""
HTTP surface for the prospecting workspace.

Mounted on the existing automation bridge rather than run as its own service:
the dashboard needs the same LLM client, the same mailer and the same
candidate profile the apply engine already has open.
"""

import asyncio
import json
import os
import queue
import threading
import time
from datetime import datetime, timezone
import shutil
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.automation import lead_discovery as discovery
from services.automation import outreach_store as store
from services.automation import site_harvest as harvester

router = APIRouter(prefix="/api/outreach", tags=["outreach"])


def _has(*names: str) -> bool:
    """True when any of these is set to something non-empty in the environment."""
    return any((os.getenv(name) or "").strip() for name in names)


def capabilities() -> Dict[str, Any]:
    """
    What this install can actually do right now.

    Booleans only, never values: this endpoint is read by a web page, and a
    dashboard that renders the first six characters of a key to look helpful
    has published the key. Each entry names the variable to set in `.env` so
    the page can say what is missing without ever saying what is there.
    """
    return {
        "discovery": {
            "ready": _has("PARALLEL_API_KEY"),
            "env": "PARALLEL_API_KEY",
            "label": "Lead discovery",
            "detail": "Finds companies, HR contacts and careers addresses.",
        },
        "verification": {
            "ready": _has(
                "MYEMAILVERIFIER_API_KEY",
                "QUICKEMAILVERIFICATION_API_KEY",
                "EASYEMAIL_API_KEY",
            ),
            "env": "MYEMAILVERIFIER_API_KEY",
            "label": "Address verification",
            "detail": "Proves a mailbox exists before anything is sent to it.",
        },
        "writer": {
            "ready": _has("FUELIX_API_KEY", "OPENAI_API_KEY", "KIMI_API_KEY"),
            "env": "FUELIX_API_KEY",
            "label": "Letter writer",
            "detail": "Writes the cover letter for each prospect.",
        },
        "dossier": {
            "ready": bool(shutil.which("xelatex") or shutil.which("pdflatex")),
            "env": "xelatex on PATH",
            "label": "PDF dossier",
            "detail": "Typesets the letter and merges the application PDF.",
        },
        "gmail": {
            "ready": _has("GOOGLE_OAUTH_REFRESH_TOKEN"),
            "env": "GOOGLE_OAUTH_REFRESH_TOKEN",
            "label": "Gmail (OAuth2)",
            # A refresh token is not a key you can copy out of a console: it is
            # what the first consent returns. So this row points at the script
            # that performs that consent rather than at a field to paste into.
            "detail": "Sends as you, from your own account. "
                      "Run scripts/gmail_oauth_setup.py once to grant it.",
        },
        "smtp": {
            "ready": _has("GMAIL_APP_PASSWORD", "SMTP_PASSWORD"),
            "env": "GMAIL_APP_PASSWORD",
            "label": "SMTP fallback",
            "detail": "Sends over SMTP when OAuth is not connected.",
        },
    }


class ProspectIn(BaseModel):
    company: str
    contact_name: str = ""
    role: str = ""
    email: str = ""
    email_status: str = ""
    website: str = ""
    city: str = ""
    notes: str = ""
    stage: str = ""


class ProspectPatch(BaseModel):
    company: Optional[str] = None
    contact_name: Optional[str] = None
    role: Optional[str] = None
    email: Optional[str] = None
    email_status: Optional[str] = None
    website: Optional[str] = None
    city: Optional[str] = None
    stage: Optional[str] = None
    notes: Optional[str] = None


class DiscoverIn(BaseModel):
    profession: str = ""
    city: str = ""
    company: str = ""
    count: int = 8


class HarvestIn(BaseModel):
    """
    The wide engine: a city, or a pasted list of domains.

    `keyword` narrows a city by what its employers are tagged as -- "Pflege",
    "Bau", "Hotel" -- and is left empty to take the city whole.
    """
    city: str = ""
    keyword: str = ""
    domains: str = ""
    limit: int = 120


# One search at a time. Not a queue: a second search started by an impatient
# second click is the same search, and the honest answer to it is "that is
# already running" rather than two runs and two bills.
#
# `cancel` exists because the wide engine can be given a whole city: five
# hundred companies is twenty minutes, and a run you cannot call off is a run
# nobody dares start.
_discovery: Dict[str, Any] = {
    "running": False, "started_at": "", "label": "", "error": "",
    "engine": "", "cancel": False,
}


def _run_discovery(spec: DiscoverIn) -> None:
    label = spec.company or spec.profession
    store.log_event(f"Searching for {label}" + (f" in {spec.city}" if spec.city else ""),
                    phase="discovery")
    tally = {"found": 0, "created": 0}

    def keep(lead: Dict[str, Any]) -> None:
        # Published, not yet proved. "guessed" is reserved for addresses this
        # app invents from a name pattern; one printed on a company's own
        # careers page is better evidence than that, and still not proof, so it
        # waits for the verifier like everything else.
        lead["email_status"] = "unknown"
        row, was_new = store.upsert_prospect(lead, source="parallel")
        tally["found"] += 1
        tally["created"] += 1 if was_new else 0
        who = row.get("contact_name") or ""
        store.log_event(
            ("Added " if was_new else "Updated ") + row["company"]
            + (f" - {who}" if who else "")
            + (f" - {row['email']}" if row.get("email") else " - no address published"),
            phase="discovery", prospect_id=row["id"],
        )

    try:
        discovery.discover(
            profession=spec.profession,
            city=spec.city,
            company=spec.company,
            count=spec.count,
            on_event=lambda msg, level="info": store.log_event(msg, phase="discovery", level=level),
            on_lead=keep,
        )
        store.log_event(
            f"Search finished: {tally['found']} employer"
            f"{'s' if tally['found'] != 1 else ''}, {tally['created']} new",
            phase="discovery",
        )
    except Exception as exc:  # noqa: BLE001 - the console is where this belongs
        _discovery["error"] = str(exc)
        store.log_event(f"Search failed: {exc}", phase="discovery", level="error")
    finally:
        _discovery["running"] = False


@router.post("/discover")
def post_discover(body: DiscoverIn) -> Dict[str, Any]:
    if not discovery.is_configured():
        raise HTTPException(400, "Set PARALLEL_API_KEY in .env to search for leads.")
    if not (body.profession.strip() or body.company.strip()):
        raise HTTPException(400, "Give a role to search for, or a company to search within.")
    if _discovery["running"]:
        raise HTTPException(409, f"Already searching for {_discovery['label']}.")

    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": body.company or body.profession,
        "error": "",
        "engine": "deep",
        "cancel": False,
    })
    threading.Thread(target=_run_discovery, args=(body,), daemon=True).start()
    return {"started": True, "label": _discovery["label"]}


def _run_harvest(spec: HarvestIn) -> None:
    tally = {"created": 0}

    def say(message: str, level: str = "info") -> None:
        store.log_event(message, phase="harvest", level=level)

    def keep(lead: Dict[str, Any]) -> None:
        # Published on the employer's own site, and still unproved: a printed
        # address can be a mailbox nobody has emptied since 2016. The verifier
        # is the stage that decides, not this one.
        lead["email_status"] = "unknown"
        row, was_new = store.upsert_prospect(lead, source="harvest")
        tally["created"] += 1 if was_new else 0
        store.log_event(
            ("Added " if was_new else "Updated ") + row["company"] + " - " + row["email"],
            phase="harvest", prospect_id=row["id"],
        )

    try:
        if spec.domains.strip():
            targets = harvester.parse_domains(spec.domains)
        else:
            targets = harvester.domains_from_osm(
                spec.city, spec.keyword, limit=max(1, min(spec.limit, 800)), on_event=say
            )
        if not targets:
            say("Nothing to read: no employer in that city publishes a website.", "warn")
        else:
            result = harvester.harvest(
                targets, on_lead=keep, on_event=say,
                should_stop=lambda: bool(_discovery["cancel"]),
            )
            if _discovery["cancel"]:
                say("Stopped. " + str(tally["created"]) + " new so far.", "warn")
            else:
                say(str(tally["created"]) + " new of " + str(result["found"]) + " addresses")
    except Exception as exc:  # noqa: BLE001 - the console is where this belongs
        _discovery["error"] = str(exc)
        say("Harvest failed: " + str(exc), "error")
    finally:
        _discovery["running"] = False
        _discovery["cancel"] = False


@router.post("/harvest")
def post_harvest(body: HarvestIn) -> Dict[str, Any]:
    """
    Read a city's employers, or a pasted list of domains, straight off their
    own websites. No key, no model, no per-company cost.
    """
    if not (body.city.strip() or body.domains.strip()):
        raise HTTPException(400, "Give a city to read, or paste a list of company sites.")
    if _discovery["running"]:
        raise HTTPException(409, "Already searching for " + str(_discovery["label"]) + ".")

    label = body.city.strip() or "pasted list"
    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": label,
        "error": "",
        "engine": "fast",
        "cancel": False,
    })
    threading.Thread(target=_run_harvest, args=(body,), daemon=True).start()
    return {"started": True, "label": label}


@router.post("/discover/cancel")
def post_cancel() -> Dict[str, Any]:
    """
    Call off the run in flight.

    It stops between companies, not mid-request: a half-read page is not worth
    the special case, and the longest wait this costs is one site.
    """
    if not _discovery["running"]:
        return {"stopping": False}
    _discovery["cancel"] = True
    store.log_event("Stopping after the company in hand", phase="harvest", level="warn")
    return {"stopping": True}


def _run_enrich(prospect_id: int) -> None:
    row = store.get_prospect(prospect_id)
    if row is None:
        _discovery["running"] = False
        return
    try:
        store.log_event(f"Reading {row['company']}", phase="discovery", prospect_id=prospect_id)
        found = discovery.enrich(
            row["company"], row.get("website", ""), row.get("city", ""), row.get("notes", "")
        )
        fields = {k: v for k, v in found.items() if v and k != "phone"}
        if fields.get("email") and not row.get("email"):
            fields["email_status"] = "unknown"
        if not fields:
            store.log_event(f"{row['company']} publishes no contact details",
                            phase="discovery", level="warn", prospect_id=prospect_id)
        else:
            updated = store.update_prospect(prospect_id, fields) or row
            who = updated.get("contact_name") or ""
            store.log_event(
                "Updated " + updated["company"] + (f" - {who}" if who else "")
                + (f" - {updated['email']}" if updated.get("email") else ""),
                phase="discovery", prospect_id=prospect_id,
            )
    except Exception as exc:  # noqa: BLE001
        _discovery["error"] = str(exc)
        store.log_event(f"Could not read {row['company']}: {exc}",
                        phase="discovery", level="error", prospect_id=prospect_id)
    finally:
        _discovery["running"] = False


@router.post("/prospects/{prospect_id}/enrich")
def post_enrich(prospect_id: int) -> Dict[str, Any]:
    """
    Read one company's site for the person and the address.

    The same work stage two of a search does, aimed at a row that already
    exists -- a prospect typed in by hand, or one a search found before this
    stage existed, or one whose careers page has changed since.
    """
    if not discovery.is_configured():
        raise HTTPException(400, "Set PARALLEL_API_KEY in .env to look up contacts.")
    if _discovery["running"]:
        raise HTTPException(409, f"Already searching for {_discovery['label']}.")
    row = store.get_prospect(prospect_id)
    if row is None:
        raise HTTPException(404, "No such prospect.")

    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": row["company"],
        "error": "",
    })
    threading.Thread(target=_run_enrich, args=(prospect_id,), daemon=True).start()
    return {"started": True, "label": row["company"]}


@router.get("/discover/status")
def get_discover_status() -> Dict[str, Any]:
    return dict(_discovery)


@router.get("/overview")
def overview() -> Dict[str, Any]:
    return {"stats": store.stats(), "capabilities": capabilities()}


@router.get("/prospects")
def get_prospects(query: str = "", stage: str = "", page: int = 1,
                  page_size: int = 20) -> Dict[str, Any]:
    return store.list_prospects(query=query, stage=stage, page=page, page_size=page_size)


@router.post("/prospects")
def post_prospect(body: ProspectIn) -> Dict[str, Any]:
    try:
        row, created = store.upsert_prospect(body.model_dump(), source="manual")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    store.log_event(
        ("Added " if created else "Updated ") + row["company"],
        phase="prospects",
        prospect_id=row["id"],
    )
    return {"prospect": row, "created": created}


@router.patch("/prospects/{prospect_id}")
def patch_prospect(prospect_id: int, body: ProspectPatch) -> Dict[str, Any]:
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    row = store.update_prospect(prospect_id, fields)
    if row is None:
        raise HTTPException(status_code=404, detail="No such prospect.")
    return {"prospect": row}


@router.delete("/prospects/{prospect_id}")
def remove_prospect(prospect_id: int) -> Dict[str, Any]:
    row = store.get_prospect(prospect_id)
    if row is None:
        raise HTTPException(status_code=404, detail="No such prospect.")
    store.delete_prospect(prospect_id)
    store.log_event("Removed " + row["company"], phase="prospects", level="warn")
    return {"removed": True}


@router.get("/events")
def get_events(limit: int = 200) -> Dict[str, Any]:
    return {"events": store.list_events(limit=limit)}


@router.get("/documents")
def get_documents(limit: int = 100) -> Dict[str, Any]:
    return {"documents": store.list_documents(limit=limit)}


# Set when the process is going down, so open streams end instead of holding
# the shutdown open.
#
# It is not enough by itself: uvicorn waits for active requests to finish
# BEFORE it runs shutdown handlers, so a stream waiting on this flag waits on a
# flag that is waiting on the stream -- which is exactly how a reload hung the
# API twice while this was being built. Hence the hard lifetime below. The
# stream ends every half minute and the browser reconnects, which is what
# `retry` is for; a dev server that cannot restart while a log tail is open is
# worse than a reconnect nobody sees.
_closing = threading.Event()

# One stream lives at most this long, then hangs up and is replaced.
STREAM_SECONDS = 30


@router.on_event("shutdown")
async def _release_streams() -> None:
    _closing.set()


@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """
    The pipeline console, as server-sent events.

    A heartbeat every two seconds, because an idle SSE connection through a
    proxy is indistinguishable from a dead one -- and because the gap between
    beats is also how long a hung-up browser, or a server on its way down,
    goes unnoticed. This stream is idle most of the time; that is what a
    pipeline log looks like between runs.

    Ending a stream is cheap: `retry: 3000` means the browser reconnects by
    itself, and the page reloads the backlog when it does. Holding one open
    is what is expensive -- a reload that waits forever for a log tail to
    hang up is a dev server that cannot be restarted.
    """
    q = store.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            hang_up_at = time.monotonic() + STREAM_SECONDS
            while not _closing.is_set() and time.monotonic() < hang_up_at:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.get_event_loop().run_in_executor(
                        None, q.get, True, 2.0
                    )
                    yield f"data: {payload}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            store.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
