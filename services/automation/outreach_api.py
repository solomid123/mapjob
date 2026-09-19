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
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from services.automation import arbeitsagentur as agentur
from services.automation import campaign as sender
from services.automation import contact_pipeline as contacts
from services.automation import dossier
from services.automation import gmail_send
from services.automation import lead_discovery as discovery
from services.automation import outreach_store as store
from services.automation import site_harvest as harvester
from services.automation import email_verify as verifier

router = APIRouter(prefix="/api/outreach", tags=["outreach"])


def _has(*names: str) -> bool:
    """True when any of these is set to something non-empty in the environment."""
    return any((os.getenv(name) or "").strip() for name in names)


def _pdf_ready() -> bool:
    try:
        import pypdf  # noqa: F401
        import reportlab  # noqa: F401
    except ImportError:
        return False
    return True


# The Gmail check costs a round trip to Google, and the overview is polled.
# Cached for a minute: long enough that a dashboard refresh is free, short
# enough that reconnecting the mailbox shows up while the user is still
# looking at the screen.
_gmail_cache: Dict[str, Any] = {"at": 0.0, "value": None}
GMAIL_CHECK_SECONDS = 60


def _gmail_state(force: bool = False) -> Dict[str, Any]:
    now = time.time()
    if (not force and _gmail_cache["value"] is not None
            and now - float(_gmail_cache["at"]) < GMAIL_CHECK_SECONDS):
        return dict(_gmail_cache["value"])
    try:
        value = gmail_send.check()
    except Exception as exc:  # noqa: BLE001 - the dashboard must still render
        value = {"ok": False, "how": "", "address": "", "reason": str(exc)[:160]}
    _gmail_cache.update({"at": now, "value": value})
    return dict(value)


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
            "ready": _pdf_ready(),
            "env": "reportlab + pypdf",
            "label": "PDF dossier",
            "detail": "Typesets the letter and merges it with the CV.",
        },
        "gmail": {
            # Asked of Google, not of the filesystem. Three variables existing
            # in `.env` is what a revoked token looks like too, and a dashboard
            # that says "Connected" because a file has three lines in it is
            # telling the user something it has not checked.
            "ready": bool(_gmail_state()["ok"]),
            "env": "GOOGLE_OAUTH_REFRESH_TOKEN",
            "label": "Gmail (OAuth2)",
            # A refresh token is not a key you can copy out of a console: it is
            # what the first consent returns. So this row points at the script
            # that performs that consent rather than at a field to paste into.
            "detail": str(_gmail_state()["reason"] or
                          "Sends as you, from your own account. "
                          "Run scripts/gmail_oauth_setup.py once to grant it."),
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


class AgenturIn(BaseModel):
    """
    The German federal job board.

    `was` and `wo` are its own two search fields, passed through unchanged so
    that a search which works on the website works here. `skip_agencies` drops
    listings the board marks as Arbeitnehmerueberlassung: half of any result
    set is one staffing firm advertising the same role in nine districts, and
    a letter to them is not an application to an employer.
    """
    was: str = ""
    wo: str = ""
    umkreis: int = 25
    count: int = 25
    skip_agencies: bool = True
    # How fresh a listing has to be, in days. Zero means the board decides,
    # which in practice means vacancies from two years ago -- so the page
    # sends a real number and this stays zero only for a caller that asks for
    # it. See `arbeitsagentur.run`: the board applies its own coarse window and
    # the adapter checks the printed date itself, because the board ignores a
    # window it does not recognise without saying so.
    published_within: int = 0
    # arbeit, ausbildung, praktikum, selbstaendigkeit, or "" for whatever the
    # board returns by default. Not a keyword: an apprenticeship search is a
    # different search area on the board, not the word "Ausbildung" typed into
    # the same box.
    offer_type: str = ""


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


def _run_contacts(spec: DiscoverIn) -> None:
    """
    The pattern engine: companies, the people in them, the address proved.

    Every lead is filed with how its address was arrived at, because the whole
    pipeline turns on that distinction. `published` was printed by the
    employer. `pattern` was constructed from a person's name and then accepted
    by the employer's own mail server. `inferred` was constructed and not
    accepted -- a hypothesis with a name attached, which nothing downstream
    may send to.
    """
    label = spec.company or spec.profession
    store.log_event("Finding people at companies hiring " + label
                    + (" in " + spec.city if spec.city else ""), phase="contacts")
    tally = {"created": 0}

    def keep(lead: Dict[str, Any]) -> None:
        row, was_new = store.upsert_prospect(lead, source="pattern")
        tally["created"] += 1 if was_new else 0
        store.update_prospect(row["id"], {
            "email_kind": lead.get("email_kind", ""),
            "verify_reason": lead.get("verify_reason", ""),
            "verify_score": int(lead.get("verify_score") or 0),
            "email_status": lead.get("email_status", "unknown"),
            # A proved address is the only one that may skip ahead; a guess
            # waits at `new` where the operator can see it has not been checked.
            "stage": "verified" if lead.get("email_status") == "valid" else "new",
        })
        who = lead.get("contact_name") or ""
        store.log_event(
            ("Added " if was_new else "Updated ") + str(lead.get("company"))
            + (" - " + who if who else "")
            + (" - " + str(lead.get("email")) if lead.get("email") else " - no address"),
            phase="contacts", prospect_id=row["id"],
        )

    try:
        result = contacts.run(
            profession=spec.profession, city=spec.city, company=spec.company,
            count=spec.count,
            on_event=lambda msg, level="info": store.log_event(
                msg, phase="contacts", level=level),
            on_lead=keep,
            should_stop=lambda: bool(_discovery["cancel"]),
        )
        store.log_event(
            "Finished: " + str(result["proved"]) + " addresses proved, "
            + str(result["guessed"]) + " unproved, " + str(tally["created"]) + " new",
            phase="contacts",
        )
    except Exception as exc:  # noqa: BLE001 - the console is where this belongs
        _discovery["error"] = str(exc)
        store.log_event("Search failed: " + str(exc), phase="contacts", level="error")
    finally:
        _discovery["running"] = False
        _discovery["cancel"] = False


@router.post("/contacts")
def post_contacts(body: DiscoverIn) -> Dict[str, Any]:
    if not discovery.is_configured():
        raise HTTPException(400, "Set PARALLEL_API_KEY in .env to search for people.")
    if not (body.profession.strip() or body.company.strip()):
        raise HTTPException(400, "Give a role to search for, or a company to search within.")
    if _discovery["running"]:
        raise HTTPException(409, "Already searching for " + str(_discovery["label"]) + ".")

    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": body.company or body.profession,
        "error": "",
        "engine": "people",
        "cancel": False,
    })
    threading.Thread(target=_run_contacts, args=(body,), daemon=True).start()
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


def _run_agentur(spec: AgenturIn) -> None:
    """
    Read the board, file each employer, and say what was actually obtained.

    Addresses arrive `published` and `unknown`: the employer printed them in
    its own advertisement, which is the best evidence short of the mail server
    agreeing, and they go to the verifier like every other address.
    """
    store.log_event("Reading the job board for " + (spec.was or "everything")
                    + (" in " + spec.wo if spec.wo else "")
                    + (" - " + spec.offer_type if spec.offer_type else "")
                    + (" - published in the last " + str(spec.published_within)
                       + " days" if spec.published_within else ""),
                    phase="agentur")
    tally = {"created": 0}

    def keep(lead: Dict[str, Any]) -> None:
        row, was_new = store.upsert_prospect(lead, source="arbeitsagentur")
        tally["created"] += 1 if was_new else 0
        store.log_event(
            ("Added " if was_new else "Updated ") + str(lead.get("company"))
            + (" - " + str(lead.get("contact_name")) if lead.get("contact_name") else "")
            + (" - " + str(lead.get("email")) if lead.get("email")
               else (" - tel " + str(lead.get("phone")) if lead.get("phone")
                     else " - no contact printed")),
            phase="agentur", prospect_id=row["id"],
        )

    try:
        result = agentur.run(
            was=spec.was, wo=spec.wo, umkreis=spec.umkreis, count=spec.count,
            skip_agencies=spec.skip_agencies,
            published_within=spec.published_within, offer_type=spec.offer_type,
            on_event=lambda msg, level="info": store.log_event(
                msg, phase="agentur", level=level),
            on_lead=keep,
            should_stop=lambda: bool(_discovery["cancel"]),
        )
        store.log_event(
            "Finished: " + str(result["kept"]) + " employers, "
            + str(result["emails"]) + " with an address, "
            + str(result["phones"]) + " with a telephone number, "
            + str(tally["created"]) + " new"
            + (", " + str(result.get("stale") or 0) + " listings too old"
               if result.get("stale") else ""),
            phase="agentur",
        )
    except Exception as exc:  # noqa: BLE001 - the console is where this belongs
        _discovery["error"] = str(exc)
        store.log_event("Board search failed: " + str(exc), phase="agentur", level="error")
    finally:
        _discovery["running"] = False
        _discovery["cancel"] = False


@router.post("/agentur")
def post_agentur(body: AgenturIn) -> Dict[str, Any]:
    if not body.was.strip():
        raise HTTPException(400, "Give the board something to search for.")
    if _discovery["running"]:
        raise HTTPException(409, "Already searching for " + str(_discovery["label"]) + ".")

    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": body.was,
        "error": "",
        "engine": "agentur",
        "cancel": False,
    })
    threading.Thread(target=_run_agentur, args=(body,), daemon=True).start()
    return {"started": True, "label": _discovery["label"]}


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


class VerifyIn(BaseModel):
    ids: List[int] = []
    limit: int = 100
    # SMTP is the only stage that proves anything and the only one that can get
    # this machine refused by a mail server, so it is a choice, not a default
    # buried in a constant.
    smtp: bool = True


def _run_verify(spec: VerifyIn) -> None:
    def say(message: str, level: str = "info", pid: Optional[int] = None) -> None:
        store.log_event(message, phase="verify", level=level, prospect_id=pid)

    try:
        if spec.ids:
            rows = [r for r in (store.get_prospect(i) for i in spec.ids) if r]
        else:
            page = store.list_prospects(page=1, page_size=max(1, min(spec.limit, 200)))
            rows = [r for r in page["items"]
                    if r.get("email") and r.get("email_status") in ("", "unknown", "guessed")]
        by_address: Dict[str, List[Dict[str, Any]]] = {}
        for row in rows:
            if row.get("email"):
                by_address.setdefault(row["email"].strip().lower(), []).append(row)
        if not by_address:
            say("Nothing to check: every address on file already has a verdict.")
            return

        say("Checking " + str(len(by_address)) + " address"
            + ("es" if len(by_address) != 1 else ""))
        counts = {"valid": 0, "risky": 0, "invalid": 0, "unknown": 0}

        def record(result: Dict[str, Any]) -> None:
            status = str(result["status"])
            counts[status] = counts.get(status, 0) + 1
            for row in by_address.get(str(result["email"]), []):
                fields = {
                    "email_status": status,
                    "verify_reason": str(result.get("reason") or ""),
                    "verify_score": int(result.get("score") or 0),
                    "verified_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                # A proved address earns the next stage. A rejected one is
                # taken out of the pipeline rather than deleted: the company is
                # still real, and the record of a dead address is what stops it
                # being found and written to again next week.
                if status == "valid" and row.get("stage") == "new":
                    fields["stage"] = "verified"
                elif status == "invalid":
                    fields["stage"] = "failed"
                store.update_prospect(row["id"], fields)
                say(row["company"] + " - " + status + ": " + str(result.get("reason") or ""),
                    level="warn" if status in ("invalid", "unknown") else "info",
                    pid=row["id"])

        verifier.verify_many(
            list(by_address.keys()), allow_smtp=spec.smtp,
            on_result=record, should_stop=lambda: bool(_discovery["cancel"]),
        )
        say(str(counts.get("valid", 0)) + " proved, " + str(counts.get("risky", 0))
            + " unprovable, " + str(counts.get("invalid", 0)) + " dead, "
            + str(counts.get("unknown", 0)) + " refused us")
        if counts.get("unknown", 0) > counts.get("valid", 0) and counts.get("unknown", 0) > 2:
            # Worth saying out loud rather than leaving as a pattern in a log:
            # it means the probing, not the addresses, is the problem.
            say("Most servers refused this machine. Probing from a home connection "
                "gets throttled; these are not bad addresses.", level="warn")
    except Exception as exc:  # noqa: BLE001
        _discovery["error"] = str(exc)
        say("Verification failed: " + str(exc), "error")
    finally:
        _discovery["running"] = False
        _discovery["cancel"] = False


@router.post("/verify")
def post_verify(body: VerifyIn) -> Dict[str, Any]:
    """
    Prove the addresses before anything is written to them.

    Syntax, then the domain, then the mailbox itself -- and the verdict is
    stored with the reason, because "risky" is only useful when it says
    whether it means a catch-all domain or a server having a bad morning.
    """
    if _discovery["running"]:
        raise HTTPException(409, "Already busy with " + str(_discovery["label"]) + ".")
    _discovery.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "label": "address check",
        "error": "",
        "engine": "verify",
        "cancel": False,
    })
    threading.Thread(target=_run_verify, args=(body,), daemon=True).start()
    return {"started": True}


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


# ---------------------------------------------------------------- the campaign

class CampaignIn(BaseModel):
    """
    One bulk run of spontaneous applications.

    `dry_run` defaults to True and the UI has to say otherwise on purpose. The
    cap and the gap are here rather than buried in the module because the right
    numbers depend on the mailbox: an account that has been sending for years
    survives more than one that sent its first cold letter this morning.
    """
    role: str = ""
    dry_run: bool = True
    limit: int = 25
    cap: int = sender.DEFAULT_CAP
    gap: float = sender.DEFAULT_GAP
    city: str = ""
    source: str = ""
    # The rows the user pointed at: one send button, or a set of ticked boxes.
    # Empty means "whoever is eligible", which is what the panel's own button
    # has always meant. A picked row is still checked against every rule -- the
    # checkbox chooses the order of the queue, not the safety of it.
    ids: List[int] = []


# Separate from `_discovery`: finding companies and writing to them are
# different runs, and a search in progress is no reason to refuse a send.
_campaign: Dict[str, Any] = {
    "running": False, "started_at": "", "dry_run": True, "error": "",
    "cancel": False, "done": 0, "total": 0, "sent": 0, "drafted": 0,
    "failed": 0, "skipped": 0,
}


def _run_campaign(spec: CampaignIn) -> None:
    def say(message: str, level: str = "info", pid: Optional[int] = None) -> None:
        store.log_event(message, phase="campaign", level=level, prospect_id=pid)
        # The Pipeline tab wants a bar, not a log. Counting the "n/m" lines the
        # runner emits is enough to drive one without threading a second
        # callback through every layer.
        head = message.split(" - ", 1)[0]
        if "/" in head and head.replace("/", "").isdigit():
            done, total = head.split("/", 1)
            _campaign["done"] = int(done)
            _campaign["total"] = int(total)

    try:
        tally = sender.run(
            role=spec.role, dry_run=spec.dry_run, limit=spec.limit,
            cap=spec.cap, gap=spec.gap, city=spec.city, source=spec.source,
            ids=list(spec.ids or []),
            on_event=say, should_stop=lambda: bool(_campaign["cancel"]),
        )
        _campaign.update({k: tally.get(k, 0) for k in
                          ("sent", "drafted", "failed", "skipped")})
    except Exception as exc:  # noqa: BLE001
        _campaign["error"] = str(exc)
        store.log_event("The campaign stopped: " + str(exc),
                        phase="campaign", level="error")
    finally:
        _campaign["running"] = False
        _campaign["cancel"] = False


@router.get("/campaign/preview")
def get_campaign_preview(limit: int = 500, city: str = "",
                         source: str = "") -> Dict[str, Any]:
    """Who would be written to, and how much of today's allowance is left."""
    data = sender.preview(limit=limit, city=city, source=source)
    data["mailbox"] = _gmail_state()
    data["cap"] = sender.DEFAULT_CAP
    return data


def _why_nobody(picked: List[int]) -> str:
    """
    Why the run has nothing to do, said about the rows the user chose.

    "Nobody is eligible" is a fair answer for the panel's own button, which
    asks about the whole ledger. It is a useless answer for somebody who just
    clicked send on one company and can see its address on the screen -- so
    when rows were picked, each one gets its own sentence.
    """
    if not picked:
        return ("Nobody is eligible. Only prospects with a published or proved "
                "email address are written to, and every one of those has "
                "already had a letter.")
    reasons = []
    for pid in picked[:8]:
        row = store.get_prospect(int(pid))
        if not row:
            continue
        why = sender.why_not(row, picked=True)
        if not why and sender.already_written_to(int(pid)):
            why = "already written to"
        reasons.append(str(row.get("company") or pid) + ": " + (why or "not eligible"))
    if len(picked) > 8:
        reasons.append("and " + str(len(picked) - 8) + " more")
    return ("Nothing to send. " + "; ".join(reasons)) if reasons else (
        "Those prospects are no longer on file.")


@router.post("/campaign")
def post_campaign(body: CampaignIn) -> Dict[str, Any]:
    if _campaign["running"]:
        raise HTTPException(409, "A campaign is already running.")
    if not body.dry_run:
        state = _gmail_state(force=True)
        if not state["ok"]:
            raise HTTPException(400, "Cannot send: " + str(state["reason"]))
    picked = list(body.ids or [])
    ready = sender.eligible(limit=body.limit, city=body.city, source=body.source,
                            ids=picked)
    if not ready:
        raise HTTPException(400, _why_nobody(picked))

    _campaign.update({
        "running": True,
        "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dry_run": bool(body.dry_run), "error": "", "cancel": False,
        "done": 0, "total": len(ready),
        "sent": 0, "drafted": 0, "failed": 0, "skipped": 0,
    })
    threading.Thread(target=_run_campaign, args=(body,), daemon=True).start()
    return {"started": True, "total": len(ready), "dry_run": bool(body.dry_run)}


@router.post("/campaign/cancel")
def post_campaign_cancel() -> Dict[str, Any]:
    """Stop after the letter in hand. Nothing half-sent is left behind."""
    if not _campaign["running"]:
        return {"stopping": False}
    _campaign["cancel"] = True
    store.log_event("Stopping after the application in hand",
                    phase="campaign", level="warn")
    return {"stopping": True}


@router.get("/campaign/status")
def get_campaign_status() -> Dict[str, Any]:
    return dict(_campaign)


class TestSendIn(BaseModel):
    role: str = ""


@router.post("/campaign/test")
def post_campaign_test(body: TestSendIn) -> Dict[str, Any]:
    """
    One real message, addressed to the mailbox it is sent from.

    There is no way to find out whether sending works except by sending, and
    the alternative to this route is finding out on a stranger: arming the live
    switch and picking a real employer to be the experiment. If the token is
    stale, or the attachment is empty, or the letter renders in the wrong
    language, that company is who discovers it, and there is no unsending.

    So the first real send goes to the user. It is the same code path as every
    other send -- the same letter writer, the same PDFs, the same Gmail call --
    with the recipient set to the connected account, and what lands in their
    inbox is exactly what an employer would have received.

    Repeatable on purpose: the previous test's documents are cleared and the
    stage reset, because the two guards that stop an employer being written to
    twice would otherwise stop the second test too. It still counts against the
    day's allowance, because it is a real message and pretending otherwise
    would make the cap a lie.
    """
    if _campaign["running"]:
        raise HTTPException(409, "A campaign is already running.")
    state = _gmail_state(force=True)
    if not state["ok"]:
        raise HTTPException(400, "Cannot send: " + str(state["reason"]))
    address = str(state.get("address") or "").strip()
    if not address:
        raise HTTPException(400, "The connected mailbox has no address to send to.")

    row, _ = store.upsert_prospect({
        "company": "Test - my own mailbox",
        "contact_name": "",
        "email": address,
        "email_status": "valid",
        "email_kind": "published",
        "notes": "A rehearsal target. Sends here go to you, not to an employer.",
    }, source="test")
    prospect_id = int(row["id"])
    with store.connect() as conn:
        conn.execute("DELETE FROM documents WHERE prospect_id=?", (prospect_id,))
    store.update_prospect(prospect_id, {"stage": "new"})

    def say(message: str, level: str = "info", pid: Optional[int] = None) -> None:
        store.log_event(message, phase="campaign", level=level, prospect_id=pid)

    say("Sending one real application to " + address + " - this is the test")
    fresh = store.get_prospect(prospect_id) or dict(row)
    outcome = sender.send_one(dict(fresh), role=body.role, dry_run=False,
                              on_event=say, picked=True)
    if not outcome.get("ok"):
        raise HTTPException(502, "The test did not send: "
                            + str(outcome.get("reason") or "unknown reason"))
    say("The test arrived at " + address + ". Open it and check the two PDFs.")
    return {"sent": True, "to": address,
            "document_id": outcome.get("document_id"),
            "message_id": outcome.get("message_id", ""),
            "sent_today": sender.sent_today()}


@router.get("/documents/{document_id}/pdf")
def get_document_pdf(document_id: int, part: str = "pack") -> FileResponse:
    """
    The PDF behind a document row, for the previewer.

    Only paths this application wrote into the ledger are served, and only
    after checking they are still where they were: a route that took a path
    from the query string would be a file-read endpoint on the user's disk.
    """
    with store.connect() as conn:
        row = conn.execute("SELECT * FROM documents WHERE id=?",
                           (document_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "No such document.")
    columns = row.keys()
    chosen = {"letter": "letter_path", "cv": "cv_path"}.get(part, "pdf_path")
    path = ((row[chosen] if chosen in columns else "") or "").strip()
    if not path:
        # Rows written before the pieces were recorded separately have only the
        # pack. Showing the whole application is a better answer than a 404.
        path = (row["pdf_path"] or "").strip()
    if not path:
        raise HTTPException(404, "That application has no PDF on file.")
    if not os.path.exists(path):
        raise HTTPException(404, "The PDF has been moved or deleted.")
    # `inline`, not `attachment`: this is read in an iframe on the Documents
    # tab. FileResponse's `filename` argument would set the other one and the
    # previewer would become a download button.
    return FileResponse(
        path, media_type="application/pdf",
        headers={"Content-Disposition":
                 'inline; filename="' + os.path.basename(path) + '"'})


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


class ProspectIds(BaseModel):
    ids: List[int] = []


@router.post("/prospects/remove")
def remove_prospects(body: ProspectIds) -> Dict[str, Any]:
    """
    Drop a ticked set in one request.

    One DELETE per row would work and would also mean thirty round trips and a
    table that repaints thirty times; worse, a failure halfway leaves the user
    guessing which half went. A row that was already gone is not an error here
    -- the user asked for it to be absent, and it is.

    Only the prospect goes. Its documents stay: they are the record of what an
    employer was actually sent, and that record does not become untrue because
    the lead was tidied away.
    """
    gone, names = 0, []
    for pid in list(body.ids or [])[:500]:
        row = store.get_prospect(int(pid))
        if row is None:
            continue
        if store.delete_prospect(int(pid)):
            gone += 1
            names.append(str(row.get("company") or ""))
    if gone:
        store.log_event(
            "Removed " + str(gone) + " prospect" + ("s" if gone != 1 else "")
            + ": " + ", ".join(n for n in names[:6] if n)
            + (" and more" if len(names) > 6 else ""),
            phase="prospects", level="warn")
    return {"removed": gone}


@router.get("/events")
def get_events(limit: int = 200) -> Dict[str, Any]:
    return {"events": store.list_events(limit=limit)}


@router.get("/documents")
def get_documents(limit: int = 100) -> Dict[str, Any]:
    return {"documents": store.list_documents(limit=limit)}


def _erase_generated_files(paths: List[str]) -> int:
    """
    Delete the PDFs this app generated, and nothing else on the disk.

    The fence matters more than it looks. A document row's `cv_path` is not a
    copy -- it points straight at the candidate's real CV wherever they keep it,
    because the dossier builder attaches the original. Deleting "the files
    belonging to this document" without checking where they are would delete the
    user's actual CV the first time somebody tidied up a draft, and every letter
    after that would go out with no CV attached.

    So: only paths that resolve inside the dossiers folder are removed. The
    letter and the merged pack live there and are regenerable. Anything else
    named by the row is somebody's own file and is left alone.
    """
    root = os.path.realpath(str(dossier.OUT_DIR))
    gone = 0
    for raw in paths:
        candidate = (raw or "").strip()
        if not candidate:
            continue
        try:
            full = os.path.realpath(candidate)
            if os.path.commonpath([root, full]) != root:
                continue
        except (OSError, ValueError):
            # Different drive, or a path the OS will not resolve. Not ours.
            continue
        try:
            os.remove(full)
            gone += 1
        except FileNotFoundError:
            pass
        except OSError:
            # Open in the previewer, or read-only. The row still goes; a file
            # left behind is untidy, a half-failed delete is confusing.
            pass
    return gone


class DocumentIds(BaseModel):
    ids: List[int] = []


@router.delete("/documents/{document_id}")
def remove_document(document_id: int) -> Dict[str, Any]:
    return remove_documents(DocumentIds(ids=[document_id]))


@router.post("/documents/remove")
def remove_documents(body: DocumentIds) -> Dict[str, Any]:
    """
    Throw away applications, and say what was thrown away.

    A draft is a rehearsal and deleting it costs nothing. A real send is not:
    it is the only copy of what an employer actually received, down to the
    wording and the PDF, and once it is gone there is no way to answer "what
    did I write to them?" -- Gmail's Sent folder has the message but this is
    where the pieces are indexed. So the count of really-sent records goes back
    in the reply and the interface says it out loud before asking.

    Deleting is safe to offer because the fact of sending is kept somewhere
    else. The `sends` table records that a message left and nothing in this
    application removes a row from it, so throwing away the copy does not give
    back a day's allowance and does not re-open that employer for a second
    identical letter. The prospect, stage included, is untouched as well.
    """
    found = store.delete_documents(list(body.ids or []))
    files = _erase_generated_files(found.get("paths") or [])
    if found["removed"]:
        sent = int(found.get("sent_removed") or 0)
        store.log_event(
            "Deleted " + str(found["removed"]) + " application"
            + ("s" if found["removed"] != 1 else "")
            + (" (" + str(sent) + " really sent)" if sent else " (drafts)"),
            phase="documents", level="warn" if sent else "info")
    return {"removed": found["removed"], "sent_removed": found.get("sent_removed", 0),
            "files_removed": files}


@router.post("/documents/remove-drafts")
def remove_draft_documents() -> Dict[str, Any]:
    """Clear the rehearsals in one go. Real sends are not drafts and stay."""
    return remove_documents(DocumentIds(ids=store.draft_document_ids()))


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
