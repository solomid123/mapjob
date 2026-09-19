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
import shutil
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.automation import outreach_store as store

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
            "detail": "Sends as you, from your own account.",
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


@router.get("/stream")
async def stream() -> StreamingResponse:
    """
    The pipeline console, as server-sent events.

    A heartbeat every 15s because an idle SSE connection through a proxy is
    indistinguishable from a dead one, and this stream is idle most of the
    time -- that is what a pipeline log looks like between runs.
    """
    q = store.subscribe()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    payload = await asyncio.get_event_loop().run_in_executor(
                        None, q.get, True, 15.0
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
