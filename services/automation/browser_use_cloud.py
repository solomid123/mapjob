"""
The second apply engine: Browser Use Cloud.

Same brief, same CV, someone else's browser.

The engine already here drives Chrome on this machine. That is the right thing
when the candidate is at the keyboard -- the window is visible, a CAPTCHA can be
answered by hand, a signed-in Google profile is reused -- and the wrong thing
the rest of the time: it holds the machine hostage for the length of a run, and
its IP is a French domestic line that some boards throttle.

This one posts the task to Browser Use's cloud, which provisions a browser
behind a residential proxy and drives it with a frontier model. Nothing about
the application changes: the brief is page_agent_manager.build_agent_prompt,
the same words the local agent gets, and the CV is the same PDF. What changes is
where the browser runs and who pays for the tokens.

Two differences are real and are handled here rather than papered over:

  * The CV cannot be injected into the page before the agent arrives, because
    the DOM is on a machine this process cannot reach. The file is uploaded to
    the run's workspace instead and the brief tells the agent to attach it --
    the opposite instruction to the local one, which is why that sentence is a
    parameter of the prompt and not a constant inside it. Telling an agent a
    file is already attached when it is not is the one lie that reliably
    produces an application with no CV on it.

  * There are no screenshot frames to serve. The cloud gives a live view URL
    instead, which is a page, so the panel shows it in an iframe rather than
    fetching stills. Everything else about the run state is shaped exactly like
    the local engine's, so the client polls one endpoint and neither knows nor
    cares which engine answered. A second engine that needed a second client
    contract would have meant two panels, two pollers and two sets of bugs.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

from services.automation import config  # noqa: F401  (loads .env)
from services.automation.candidate_profile import CANDIDATE_PROFILE
from services.automation import cloud_profile
from services.automation import document_library as library
from services.automation import page_agent_manager

API_BASE = os.getenv("BROWSER_USE_API_BASE", "https://api.browser-use.com/api/v4")

# The model that drives the browser. Their default; overridable because the good
# model changes every month.
MODEL = os.getenv("BROWSER_USE_MODEL", "gpt-5.6-luna")

# Where the browser appears to be. Their default is the United States, which is
# a poor fit for an application to a French employer: the form comes back in
# English, some boards geo-block outright, and an account whose sign-ins hop
# between Amiens and Ohio gets flagged. The candidate is in France.
PROXY_COUNTRY = os.getenv("BROWSER_USE_PROXY_COUNTRY", "fr")

# A saved cloud browser profile: cookies and local storage kept between runs, so
# the sessions signed in once by hand are still signed in on the next
# application. It is the single biggest difference between this engine working
# and this engine bouncing off a login wall -- most French boards will not show
# an apply button to a stranger -- and it is also why the brief has to be told
# the truth about which browser it is in. Without it the session is empty and
# the agent falls back to the password ladder.
#
# Asked for rather than read once at import, because the account can change
# while the server is up: the credit runs out, a new key is typed into the
# settings panel, and a constant frozen at start-up would keep pointing runs at
# an id that belongs to an organisation this key is not in.
def profile_id() -> str:
    return cloud_profile.profile_id()

CV_PATH = Path(page_agent_manager.CV_PDF_PATH)

# The uploaded CV's file id, remembered between runs. Re-uploading the PDF before
# every application would be two round trips for a file that has not changed;
# the size and mtime ride along so a new CV is noticed and a stale id is never
# reused.
_CACHE_PATH = Path(__file__).resolve().parent / "browser_use_cache.json"

_TIMEOUT = 30


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def api_key() -> str:
    # One source of truth, and it is not the environment: a key saved from the
    # settings panel outranks the one the server was started with.
    return cloud_profile.api_key()


def is_configured() -> bool:
    return bool(api_key())


def workspace_id() -> str:
    """
    The workspace the run's files live in.

    Optional: with no workspace the cloud makes a fresh one per run, which works
    but re-uploads the CV every time and scatters the output. A stable one is
    better, so the id is configurable and, once discovered, remembered.
    """
    explicit = (os.getenv("BROWSER_USE_WORKSPACE_ID") or "").strip()
    if explicit:
        return explicit
    return str(_cache().get("workspace_id") or "")


def _headers() -> Dict[str, str]:
    return {"X-Browser-Use-API-Key": api_key(), "Content-Type": "application/json"}


def _cache() -> Dict[str, Any]:
    try:
        return json.loads(_CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_cache(data: Dict[str, Any]) -> None:
    try:
        _CACHE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        # A cache that cannot be written costs one upload per run. Not worth
        # failing an application over.
        pass


# ---------------------------------------------------------------------------
# The CV
# ---------------------------------------------------------------------------

def _create_workspace() -> str:
    try:
        res = requests.post(f"{API_BASE}/workspaces", headers=_headers(),
                            json={"name": "mapjob"}, timeout=_TIMEOUT)
        if res.status_code >= 400:
            return ""
        ws = str(res.json().get("id") or "")
        if ws:
            cached = _cache()
            cached["workspace_id"] = ws
            _write_cache(cached)
        return ws
    except Exception:
        return ""


def ensure_cv_uploaded(log=lambda _m: None, cv_path: Optional[Path] = None) -> Optional[Dict[str, str]]:
    """
    Put this run's CV in the cloud workspace and hand back {id, path}.

    Returns None when there is no CV on disk or the upload fails, and the caller
    goes on without it: the brief then tells the agent to stop rather than send a
    CV-less application to a form that demands one, which is a better failure
    than a silent empty attachment.
    """
    cv_path = Path(cv_path) if cv_path else CV_PATH
    if not cv_path.exists():
        log("No CV file found to attach.")
        return None
    sent = upload_file(cv_path, log=log)
    if sent:
        log("Attached resume to the run: " + cv_path.name)
    return sent


def upload_file(path: Path, log=lambda _m: None,
                mime: str = "application/pdf",
                name: str = "") -> Optional[Dict[str, str]]:
    """
    Put one file in the cloud workspace and hand back {id, path}.

    Uploads are remembered per file rather than per account. That used to be one
    cached id, which was right while every application sent the same PDF and
    became wrong the moment a CV was cut for each advert: the second job would
    have been handed the first job's file, addressed to the first job's employer,
    and nothing about the run would have looked unusual. The same reasoning now
    covers a transcript or a diploma, which unlike the CV really is the same file
    every time -- so the fingerprint means it goes up once and is reused until it
    changes on disk.
    """
    file_path = Path(path)
    if not file_path.exists():
        return None

    # The name the file goes up under, which is not the name it is stored
    # under: a held document has this app's id in front of its filename, and
    # the agent will type that name into an employer's upload field.
    shown = name or file_path.name
    stat = file_path.stat()
    fingerprint = f"{stat.st_size}:{int(stat.st_mtime)}:{shown}"
    key = str(file_path.resolve())
    cached = _cache()
    uploads = cached.get("cv_uploads") or {}
    ws = workspace_id()
    remembered = uploads.get(key) or {}
    if (ws and remembered.get("fingerprint") == fingerprint
            and remembered.get("file_id") and remembered.get("workspace") == ws):
        return {"id": remembered["file_id"], "path": remembered.get("path", "")}

    if not ws:
        ws = _create_workspace()
        if not ws:
            log("Could not open a cloud workspace for the files.")
            return None

    body = {
        "files": [{
            "name": shown,
            "contentType": mime or "application/octet-stream",
            "size": stat.st_size,
        }],
        "allowOverrides": True,
    }
    try:
        res = requests.post(f"{API_BASE}/workspaces/{ws}/files/upload",
                            headers=_headers(), json=body, timeout=_TIMEOUT)
        if res.status_code >= 400:
            log("Could not reserve space for " + shown + ".")
            return None
        item = (res.json().get("files") or [{}])[0]
        upload_url = item.get("uploadUrl")
        if not upload_url:
            return None

        # The presigned PUT is pinned to the exact byte count announced above,
        # so the file goes as one body rather than a stream.
        put = requests.put(upload_url, data=file_path.read_bytes(),
                           headers={"Content-Type": mime or "application/octet-stream"},
                           timeout=120)
        if put.status_code >= 400:
            log("The upload of " + shown + " was refused.")
            return None
    except Exception:
        log(shown + " could not be uploaded.")
        return None

    uploads[key] = {
        "fingerprint": fingerprint,
        "file_id": item.get("id", ""),
        "path": item.get("path", ""),
        "workspace": ws,
    }
    # One entry per file, and the folder grows a CV per job, so the oldest are
    # forgotten rather than kept forever against files that no longer exist.
    cached["cv_uploads"] = dict(list(uploads.items())[-40:])
    cached["workspace_id"] = ws
    _write_cache(cached)
    return {"id": item.get("id", ""), "path": item.get("path", "")}


def upload_documents(document_ids: Optional[List[str]] = None, merge: bool = False,
                     log=lambda _m: None, user: str = "") -> Dict[str, Any]:
    """
    Put the held documents this run was told to carry into the workspace.

    Returns {"ids": [...file ids...], "lines": [...one line per file...],
    "merged": bool, "notes": [...]} -- the ids go on the run, the lines go in
    the brief so the agent knows a transcript is a transcript and puts it in the
    field asking for one.

    `merge` binds the *supporting* documents into a single PDF, and deliberately
    leaves the CV out of it. On a form the CV has its own upload field; a bound
    file containing the CV, a transcript and a diploma would either be attached
    there -- making the CV four pages of somebody else's paperwork -- or not at
    all. Email is the other way round, which is why the two products fuse
    different things under the same word.
    """
    ids = [str(i) for i in (document_ids or []) if i]
    out: Dict[str, Any] = {"ids": [], "lines": [], "merged": False, "notes": []}
    if not ids:
        return out

    # Whose documents. Without this every cloud run read the default account's
    # library, so a run started from the other account would have uploaded a
    # stranger's transcript to an employer -- and the ids would have matched
    # nothing, which is the quieter half of the same bug.
    rows = library.chosen(ids, user=user)
    plan = library.attachment_plan(ids, merge=merge, lead=[],
                                   out=library.pack_for(ids, merge, "Supporting_documents", user),
                                   user=user)
    out["notes"] = list(plan.get("notes") or [])
    for note in out["notes"]:
        log(note)

    if plan.get("merged"):
        sent = upload_file(Path(plan["merged"]), log=log,
                           name="Supporting documents.pdf")
        if sent:
            out["merged"] = True
            out["ids"].append(sent["id"])
            out["lines"].append(
                '- "' + sent.get("path", "") + '" -- one PDF holding, in order: '
                + ", ".join(str(r.get("kind")) + " (" + str(r.get("title") or r.get("filename")) + ")"
                            for r in rows))
            log("Attached " + str(len(rows)) + " supporting documents as one PDF")
            return out
        # The bound file did not go up. Sending the parts is better than sending
        # nothing, and the agent is about to be told what each one is anyway.
        out["notes"].append("The bound PDF could not be uploaded, so the documents "
                            "go up one by one.")

    for row in rows:
        path = library.path_of(str(row.get("id")))
        if not path or not path.exists():
            continue
        sent = upload_file(path, log=log,
                           mime=str(row.get("mime") or "application/octet-stream"),
                           name=library.sent_as(row))
        if not sent:
            out["notes"].append(str(row.get("title") or row.get("filename"))
                                + " could not be uploaded, so it is not on this application.")
            continue
        out["ids"].append(sent["id"])
        out["lines"].append('- "' + sent.get("path", "") + '" -- '
                            + str(row.get("kind")) + ": " + str(row.get("title") or row.get("filename")))
    if out["ids"]:
        log("Attached " + str(len(out["ids"])) + " supporting document(s) to the run")
    return out


# ---------------------------------------------------------------------------
# The brief
# ---------------------------------------------------------------------------

def _browser_note(signed_in: List[str]) -> str:
    """
    What is true about the browser this run gets, which is not what is true
    about the one on the candidate's desk.

    Both versions exist because both are sometimes the case, and the cost of
    telling the agent the wrong one is high in either direction: promise it a
    signed-in session it does not have and it stalls on a login wall it was told
    to walk through; deny it the session it does have and it types a password
    into a site that would have let it straight in.

    Which is why the argument is the list of domains the profile actually holds
    cookies for, asked of their API at the top of the run, rather than "is a
    profile configured". A profile id in .env says where the sessions would be
    kept, not that any are: the first run on a new account has both, and an
    empty jar.
    """
    shared = """
- Nobody is watching this window. If something genuinely needs a person -- a CAPTCHA,
  an SMS code, a confirmation link in an inbox -- name which one and stop. Do not
  guess at it and do not click your way around it.
- On any Google page: click, never type. Account tiles, "Continue", "Allow" -- click
  those freely. The password box, a phone number and a 2-step code are off limits.
  If Google asks for any of them, the session has lapsed: stop and say so."""

    if not signed_in:
        return """THIS BROWSER IS NOT THE CANDIDATE'S OWN:
- It is a fresh, empty profile with no signed-in accounts. "Continue with Google"
  leads to a login wall rather than through one, so skip it and use the site's own
  email-and-password sign-in, or register.""" + shared

    sites = ", ".join(signed_in)
    google = ("google.com" in signed_in)
    google_line = ("""
- Prefer "Continue with Google" where it is offered -- it is one click and it puts
  no password anywhere.""" if google else """
- There is no Google session in this browser, so "Continue with Google" leads to a
  login wall rather than through one. Use the site's own sign-in instead.""")

    return f"""THIS BROWSER IS NOT THE CANDIDATE'S OWN, BUT IT IS SIGNED IN:
- It loads a saved profile that already holds live sessions for: {sites}.
  On those sites you are most likely already logged in, so check before signing in
  to anything. Anywhere else, treat it as a browser nobody has ever used.{google_line}
- Check WHOSE account it is before applying under it. The candidate is
  badreddinebarki@gmail.com. If the signed-in account is someone else's, do not
  apply as them: sign out or use the site's own email-and-password form with the
  candidate's address, and say in your final message that you found the wrong
  account.
- These sessions belong to a real person. Stay on the employer's application.
  Do not open Gmail, Drive, the LinkedIn inbox or account settings, and do not
  change anything about any of those accounts.""" + shared


def _account_note(hosts: List[str]) -> str:
    """
    What is already known about accounts on the sites this application touches.

    Without it the ladder restarts from zero every time: try a password, try the
    other, register -- and registering with an address the site already knows
    fails with "this email is in use", which reads like a dead end rather than
    like the one clue that says "you have an account here, sign in".
    """
    from services.automation import portal_accounts

    for host in hosts:
        known = portal_accounts.known_account(host)
        if not known:
            continue
        # The real password goes in here, and redact_secrets swaps it for the
        # alias that is actually bound on the way out. Writing the alias
        # directly would be guessing at it: two identically-valued passwords
        # collapse to one binding, so the name this note invented could easily
        # be one the run does not have. There is exactly one place in this
        # module that knows how a secret becomes an alias, and this is not it.
        return f"""ACCOUNT ALREADY HELD HERE:
- An account exists on {host} for {known.get('email', '')}, created on an earlier run.
- Sign in with it rather than registering again: registering with an address the
  site already knows will just be refused.
- Its password is {known.get('password', '')}.
"""
    return ""


def _documents_note(lines: List[str], merged: bool) -> str:
    """
    The held documents, named and explained, or nothing at all.

    A list of workspace paths is not enough: a form asks for "relevé de notes"
    and "copie du diplôme" in separate fields, so the agent is told what each
    file is rather than left to guess from a filename. And it is told not to
    force them in where there is nowhere for them to go -- an application with a
    transcript in the cover-letter box is worse than one without the transcript.
    """
    if not lines:
        return ""
    body = "\n".join(lines)
    if merged:
        tail = """- That single PDF is the whole supporting set, in one file, because that is
  what was asked for here. Attach it once, to the field for additional or
  supporting documents.
- Do not attach it to the CV field. The CV is the separate file named above."""
    else:
        tail = """- Attach each one to the field that asks for that kind of document: a
  transcript goes in the transcript field, a diploma in the diploma field.
- Where the form has one generic "additional documents" field, attach them all
  to it if it takes several files, and otherwise attach the ones it asks for.
- Do not attach any of them to the CV field."""
    return f"""SUPPORTING DOCUMENTS:
- These files are attached to this run, in your workspace:
{body}
{tail}
- If the form has no place for a document, leave it out and say so at the end.
  Do not paste its contents into a text box."""


def build_task(job_url: str, job_title: str, company: str, dry_run: bool,
               cv_path: str, hosts: Optional[List[str]] = None,
               document_lines: Optional[List[str]] = None,
               documents_merged: bool = False,
               signed_in: Optional[List[str]] = None) -> str:
    """
    The same application brief the local agent gets, with the two facts that are
    only true in the cloud put back: which page to open, and that the CV is a
    file the agent has to attach itself.
    """
    if cv_path:
        resume_note = f"""RESUME FILE:
- The candidate's CV is attached to this run, in your workspace at "{cv_path}".
- When the form has a CV / resume / lettre de motivation upload field, attach that exact file.
- Clicking "Browse" or "Upload" opens a native OS dialog you cannot drive: set the
  file on the <input type="file"> directly instead.
- Never invent a CV, never retype it into a text box, and never leave a required
  upload empty in silence: if the file truly cannot be attached, stop and say so."""
    else:
        resume_note = """RESUME FILE:
- No CV file reached this run. Fill everything else, and if the form requires a CV
  upload, stop and say so rather than submitting an application without one."""

    extras = _documents_note(list(document_lines or []), documents_merged)
    if extras:
        resume_note = resume_note + "\n\n" + extras

    brief = page_agent_manager.build_agent_prompt(
        job_title=job_title or "Position",
        company=company or "Employer",
        candidate=CANDIDATE_PROFILE,
        submit=not dry_run,
        resume_note=resume_note,
    )

    # The local agent is injected into the page it is already on; this one starts
    # on a blank tab and has to be told where to go. The URL leads, because
    # everything after it is meaningless until the page is open.
    return f"""Open this exact URL and complete the job application on it:
{job_url}

Stay on that application. Do not go looking for the job on other boards, and do
not apply to a different listing: if this one cannot be applied to, say why and stop.

{brief}

{_browser_note(list(signed_in) if signed_in is not None else cloud_profile.signed_in_domains())}

{_account_note(hosts or [])}
BEFORE YOU FINISH, IF YOU CREATED AN ACCOUNT:
- End your final message with this line, exactly, on its own:
  ACCOUNT_CREATED host=<the site's domain> email=<the address you registered>
- It is how the account is written down for next time. An account created and not
  reported is an account the candidate is locked out of: the next run will try to
  register again, be told the address is taken, and get no further.
- Only write that line if a registration actually went through. Signing into an
  account that already existed is not creating one."""


# ---------------------------------------------------------------------------
# Run state, in the shape the panel already understands
# ---------------------------------------------------------------------------

_LOCK = threading.Lock()
_cancelled = threading.Event()

_STATE: Dict[str, Any] = {
    "is_running": False,
    "job_title": "",
    "company": "",
    "target_url": "",
    "phase": "idle",
    "current_step": "",
    "logs": [],
    "screenshot_url": "",
    "screenshot_seq": 0,
    "last_result": None,
    "dry_run": True,
    "started_at": None,
    "model": MODEL,
    "awaiting_review": False,
    # The cloud's own live view: a page, not a picture.
    "live_url": "",
    "engine": "cloud",
    "run_id": "",
    "job_id": "",
    # Whose application this is, so the ledger line lands in their history.
    "user": "",
}

# Called once with the finished result. The server sets it so a cloud run is
# written into the same applications ledger as a local one: "which engine filled
# the form" is an implementation detail, and an application that is missing from
# the history because of it would be a trap -- the sort of gap that ends in a
# second application to an employer who already has the first.
on_finish = None


def state() -> Dict[str, Any]:
    with _LOCK:
        snapshot = dict(_STATE)
        snapshot["logs"] = list(_STATE["logs"])[-35:]
        return snapshot


def is_running() -> bool:
    return bool(_STATE.get("is_running"))


def _log(message: str) -> None:
    message = (message or "").strip()
    if not message:
        return
    with _LOCK:
        logs: List[Dict[str, str]] = _STATE["logs"]
        if logs and logs[-1].get("message") == message:
            return
        logs.append({"message": message})
        del logs[:-200]
        _STATE["current_step"] = message


def _set(**fields: Any) -> None:
    with _LOCK:
        _STATE.update(fields)


# ---------------------------------------------------------------------------
# Driving one run
# ---------------------------------------------------------------------------

def start(job_url: str, job_title: str, company: str, dry_run: bool,
          job_id: str = "", description: str = "", location: str = "",
          document_ids: Optional[List[str]] = None,
          merge_documents: bool = False, user: str = "") -> Dict[str, Any]:
    """Queue one application in the cloud and start following it."""
    if is_running():
        raise RuntimeError("A cloud application is already running.")
    if not is_configured():
        raise RuntimeError("No Browser Use API key is configured.")

    _cancelled.clear()
    with _LOCK:
        _STATE.update({
            "is_running": True,
            "job_title": job_title or "Position",
            "company": company or "Employer",
            "target_url": job_url,
            "phase": "navigating",
            "current_step": "Starting autonomous AI application engine",
            "logs": [{"message": "Starting autonomous AI application engine"}],
            "last_result": None,
            "dry_run": bool(dry_run),
            "started_at": time.time(),
            "model": MODEL,
            "live_url": "",
            "run_id": "",
            "job_id": job_id or "",
            "user": user or "",
        })

    threading.Thread(target=_run_thread,
                     args=(job_url, job_title, company, bool(dry_run),
                           job_id or "", description or "", location or "",
                           [str(i) for i in (document_ids or []) if i],
                           bool(merge_documents), user or ""),
                     name="browser-use-cloud", daemon=True).start()
    return state()


def _finish(outcome: str, message: str, **extra: Any) -> None:
    result = {
        "success": outcome in ("applied", "sent_unconfirmed", "awaiting_review"),
        "submitted": outcome == "applied",
        "sent": outcome in ("applied", "sent_unconfirmed"),
        "sent_unconfirmed": outcome == "sent_unconfirmed",
        "barrier": outcome == "blocked",
        "outcome": outcome,
        "dry_run": bool(_STATE.get("dry_run")),
        "message": message,
        "engine": "cloud",
    }
    result.update(extra)
    with _LOCK:
        _STATE["is_running"] = False
        _STATE["last_result"] = result
        _STATE["phase"] = "cancelled" if outcome == "cancelled" else "idle"
    _log(message)
    if callable(on_finish):
        try:
            on_finish(dict(result), state())
        except Exception:
            # The ledger failing to record a run must not also lose the run.
            pass


def _http_reason(res: "requests.Response") -> str:
    """One sentence for a refusal, in the candidate's terms rather than HTTP's."""
    if res.status_code in (401, 403):
        return "The Browser Use key was refused. Check BROWSER_USE_API_KEY."
    if res.status_code == 402:
        # Say where the remedy is. This message is the moment somebody finds
        # out the account is empty, and "top it up somewhere" is a worse answer
        # than the two words that name the box a new key goes in.
        return ("That Browser Use account is out of credit. Paste a key from another "
                "account under Profile -> Applying and this browser signs itself back in.")
    if res.status_code == 429:
        return "Browser Use is rate limiting this account. Try again shortly."
    text = ""
    try:
        detail = res.json()
        text = detail.get("detail") or detail.get("message") or ""
        if isinstance(text, list):
            text = "; ".join(str(t.get("msg", t)) for t in text)
    except Exception:
        pass
    return f"The cloud refused the run ({res.status_code}). {text}".strip()


def _run_thread(job_url: str, job_title: str, company: str, dry_run: bool,
                job_id: str = "", description: str = "", location: str = "",
                document_ids: Optional[List[str]] = None,
                merge_documents: bool = False, user: str = "") -> None:
    try:
        # Cut the CV before anything is uploaded, and inside the thread rather
        # than in the request that started it: the panel is already showing this
        # run's log by now, so the twenty seconds read as a step instead of a
        # button that has not responded yet.
        cv_file = ""
        try:
            from services.automation import tailor as tailor_module
            cv_file = tailor_module.cv_for_application(
                job_id, job_title, company, location, job_url, description,
                log=_log, user=user)
        except Exception:
            cv_file = ""
        cv = ensure_cv_uploaded(_log, Path(cv_file) if cv_file else None)
        # Whatever the chooser ticked: transcripts, a diploma, a work permit.
        # They go up after the CV so a failure here still leaves a run that can
        # apply with the CV alone rather than one that never started.
        extras = upload_documents(document_ids, merge_documents, _log, user=user)
        # Where the form really lives, which is rarely where the listing points.
        # This comes first because the brief itself depends on it: which sites we
        # already hold an account on is a question about those hosts.
        hosts = apply_hosts(job_url, _log)
        # And whether this browser knows the candidate at all. On a profile that
        # has never been used -- a new one, or a new account after the credit on
        # the last ran out -- the sessions signed in by hand on this machine are
        # copied up before the agent arrives, which is the difference between an
        # application and a login wall. On a profile that already has them this
        # is one GET and nothing else.
        signed_in = cloud_profile.seed_if_new(log=_log).get("domains") or []
        task = build_task(job_url, job_title, company, dry_run,
                          (cv or {}).get("path", ""), hosts,
                          extras.get("lines"), bool(extras.get("merged")),
                          signed_in=signed_in)
        task, bindings, leaked = redact_secrets(task, job_url, hosts)
        if leaked:
            # Not a warning. The whole point of the swap is that it is the thing
            # standing between a plaintext password and a vendor's logs, so its
            # failure has to stop the run rather than annotate it.
            _finish("error",
                    "Stopped: a password could not be kept out of the text sent to the "
                    "cloud. Run this one on this computer instead.",
                    detail=f"unredacted aliases: {', '.join(leaked)}")
            return

        body: Dict[str, Any] = {
            "task": task,
            "model": MODEL,
            "browserSettings": {"proxyCountryCode": PROXY_COUNTRY, "record": False},
        }
        pid = profile_id()
        if pid:
            body["browserSettings"]["profileId"] = pid
        if bindings:
            body["secretBindings"] = bindings
        ws = workspace_id()
        if ws:
            body["workspaceId"] = ws
        attached = [cv["id"]] if (cv and cv.get("id")) else []
        attached += [i for i in extras.get("ids", []) if i]
        if attached:
            body["attachedFileIds"] = attached

        res = requests.post(f"{API_BASE}/runs", headers=_headers(), json=body, timeout=_TIMEOUT)
        if res.status_code >= 400:
            _finish("error", _http_reason(res), detail=res.text[:600])
            return

        created = res.json()
        run_id = created.get("id", "")
        _set(run_id=run_id)
        if created.get("missingFileIds"):
            # The cached CV id is gone from the workspace. Say it now rather than
            # let the agent find an empty path halfway through a form.
            _log("The saved CV upload had expired")
            cached = _cache()
            cached.pop("cv_file_id", None)
            _write_cache(cached)
        _log("Opening browser window")

        _follow(run_id)
    except Exception as exc:  # noqa: BLE001 - the panel is the only reader
        _finish("error", f"The cloud run could not be started: {exc.__class__.__name__}.",
                detail=str(exc)[:600])


def _phrase_for(event: Dict[str, Any]) -> str:
    """
    The one line of an event worth showing, or nothing.

    Token counts, spawn bookkeeping and the model's private reasoning are noise
    for a progress rail two or three words wide.
    """
    kind = event.get("type", "")
    data = event.get("data") or {}

    if kind in ("browser.ready", "browser.attached"):
        return "Opening browser window"
    if kind == "workspace.ready":
        return "Mounting PageAgent core"
    if kind != "core.event":
        return ""

    part = data.get("part") or {}
    ptype = part.get("type")
    if ptype == "tool":
        # The model writes a short description of each browser action for its own
        # trace -- "Open application form", "Fill contact details". That is already
        # the phrase the rail wants, so it is used instead of a generic line.
        desc = ((part.get("state") or {}).get("input") or {}).get("description") or ""
        return f"Agent: {desc}" if desc else ""
    if ptype == "text":
        text = (part.get("text") or "").strip()
        return f"Agent: {text[:140]}" if text else ""
    return ""


def _follow(run_id: str) -> None:
    """
    Poll the run until it ends, turning its events into the same kind of log line
    the local engine writes.

    Polling rather than their SSE stream on purpose: this is a background thread
    in a synchronous server, a run lasts minutes, and a dropped stream would need
    reconnect-and-replay logic to avoid losing steps. The events endpoint is a
    cursor, so a failed poll simply asks again from the same place.
    """
    after = 0
    deadline = time.time() + 20 * 60
    quiet_since = time.time()

    while True:
        if _cancelled.is_set():
            return
        if time.time() > deadline:
            _cancel_remote(run_id)
            _finish("error", "The cloud run passed twenty minutes and was stopped.")
            return

        try:
            res = requests.get(f"{API_BASE}/runs/{run_id}/events", headers=_headers(),
                               params={"after": after, "limit": 200}, timeout=_TIMEOUT)
            if res.status_code < 400:
                for event in res.json().get("events") or []:
                    after = max(after, int(event.get("id") or 0))
                    live = (event.get("data") or {}).get("live_view_url") or ""
                    if live:
                        _set(live_url=live, phase="filling")
                    phrase = _phrase_for(event)
                    if phrase:
                        _log(phrase)
                        quiet_since = time.time()
        except Exception:
            # One failed poll is not a failed run; the cursor did not move.
            pass

        try:
            res = requests.get(f"{API_BASE}/runs/{run_id}/status",
                               headers=_headers(), timeout=_TIMEOUT)
            status = res.json().get("status") if res.status_code < 400 else None
        except Exception:
            status = None

        if status in ("completed", "failed", "cancelled", "stopped"):
            _settle(run_id, status)
            return

        # A queued run emits no events at all, so the rail would sit silent with
        # nothing to say it is alive.
        if status in ("queued", "pending") and time.time() - quiet_since > 8:
            _log("Waiting for a cloud browser")
            quiet_since = time.time()

        time.sleep(1.5)


def _cancel_remote(run_id: str) -> None:
    try:
        requests.post(f"{API_BASE}/runs/{run_id}/cancel", headers=_headers(), timeout=_TIMEOUT)
    except Exception:
        pass


def cancel() -> Dict[str, Any]:
    """Stop the run in the cloud, and stop following it here."""
    run_id = str(_STATE.get("run_id") or "")
    _cancelled.set()
    if run_id:
        _cancel_remote(run_id)
    _finish("cancelled", "Stopped before anything was sent.")
    return state()


# Words an agent uses when it did send something, and words it uses when it did
# not. Both lists are read before anything is claimed, because "the run
# completed" and "the application was sent" are different facts: an agent
# completes its task just as much by reporting that it could not apply.
_SENT_WORDS = (
    "submitted the application", "application submitted", "application was submitted",
    "successfully applied", "i applied", "application sent", "sent the application",
    "candidature envoy", "j'ai postul", "postulation envoy",
)
_NOT_SENT_WORDS = (
    "did not submit", "not submitted", "was not submitted", "without submitting",
    "stopped before", "could not apply", "unable to apply", "cannot apply",
    "no application was", "requires an account", "requires login", "blocked",
    "captcha", "n'ai pas envoy", "pas pu postuler",
)
_BARRIER_WORDS = ("captcha", "blocked", "requires an account", "requires login",
                  "sign in", "verification", "cloudflare")


_ACCOUNT_LINE = re.compile(
    r"ACCOUNT_CREATED\s+host=([A-Za-z0-9.\-]+)\s+email=([^\s`'\"*]+)", re.I)


def _harvest_account(result: str) -> str:
    """
    Write down any account the run created, and take the note out of the text.

    The marker is bookkeeping between this module and the agent; showing it to
    the candidate would be showing them the plumbing. What is stored is a
    reference -- the host, the address, and which configured password was used --
    never the password, so this file stays readable by anyone and rotating the
    value in .env rotates it here too.
    """
    from services.automation import portal_accounts
    from services.automation import config as cfg

    match = _ACCOUNT_LINE.search(result or "")
    if not match:
        return result

    host = match.group(1).lower().lstrip("*").strip(".")
    if host.startswith("www."):
        host = host[4:]
    email = match.group(2).strip().strip(".,")
    kind = "signup" if cfg.PORTAL_SIGNUP_PASSWORD else "primary"
    if host and "@" in email:
        portal_accounts.remember_account(host, email, password_kind=kind,
                                         note="created by the cloud engine")
        _log(f"Saved the account on {host}")
    return _ACCOUNT_LINE.sub("", result).strip()


_DOMAIN_LINE = re.compile(r"NEEDS_DOMAIN\s+host=([A-Za-z0-9.\-]+)", re.I)


def _harvest_domain(result: str) -> str:
    """
    Remember a host the run needed its password on and was not allowed to use.

    Some application forms are only reachable by a browser: the listing page
    hands over through script, or a login wall, and the plain redirect walk in
    `apply_hosts` never sees the domain the form ends up on. That run ends one
    field short. Written down here against the listing's host, the next attempt
    starts with the answer, so "Try again" is a different attempt rather than
    the same one repeated.

    The host is stored, nothing else. It widens where a placeholder may be
    typed on one site, which is the same decision `apply_hosts` makes from a
    redirect chain -- just informed by the run that actually got there.
    """
    match = _DOMAIN_LINE.search(result or "")
    if not match:
        return result

    host = match.group(1).lower().lstrip("*").strip(".")
    if host.startswith("www."):
        host = host[4:]
    listing = _host_of(_STATE.get("target_url") or "")
    if host and listing and host not in _NEVER_BIND:
        data = _cache()
        learned = data.setdefault("extra_hosts", {})
        known = learned.setdefault(listing, [])
        if host not in known:
            known.append(host)
            # One listing site cannot be allowed to grow an unbounded list of
            # places this app will type a password.
            learned[listing] = known[-8:]
            _write_cache(data)
        _log(f"Noted that the form lives on {host}")
    return _DOMAIN_LINE.sub("", result).strip()


def _settle(run_id: str, status: str) -> None:
    """Read the finished run and turn the agent's own words into an outcome."""
    summary: Dict[str, Any] = {}
    try:
        res = requests.get(f"{API_BASE}/runs/{run_id}", headers=_headers(), timeout=_TIMEOUT)
        if res.status_code < 400:
            summary = res.json()
    except Exception:
        pass

    result = str(summary.get("result") or summary.get("output") or "").strip()
    result = _harvest_domain(_harvest_account(result))
    error = str(summary.get("error") or "").strip()

    extra: Dict[str, Any] = {}
    cost = summary.get("totalCostUsd") or summary.get("costUsd")
    if cost is not None:
        try:
            extra["cost_usd"] = round(float(cost), 4)
        except (TypeError, ValueError):
            pass
    extra["resume_attached"] = bool(summary.get("attachedFileIds")
                                    or _cache().get("cv_file_id"))

    if status in ("cancelled", "stopped"):
        _finish("cancelled", "Stopped before anything was sent.", **extra)
        return
    if status == "failed":
        _finish("error", error or "The cloud run failed.", detail=error[:600], **extra)
        return

    lowered = result.lower()

    if _STATE.get("dry_run"):
        # A dry run in the cloud is a rehearsal only. Unlike the local engine
        # there is no browser left afterwards to press Submit in -- the cloud
        # tears the session down with the run -- so the panel must not offer a
        # review step that cannot exist.
        _finish("awaiting_review",
                (result or "Filled the form and stopped before sending.")
                + " The cloud browser closed with the run, so this one has to be"
                  " started again to actually send.",
                **extra)
        return

    if any(word in lowered for word in _NOT_SENT_WORDS):
        outcome = "blocked" if any(w in lowered for w in _BARRIER_WORDS) else "not_sent"
        _finish(outcome, result or "The run finished without sending an application.", **extra)
        return
    if any(word in lowered for word in _SENT_WORDS):
        _finish("applied", result or "Application submitted.", **extra)
        return

    # Neither phrasing. Something may well have gone out, and the one reading
    # that is definitely wrong is "failed": that invites a second application to
    # an employer who already has the first.
    _finish("sent_unconfirmed",
            result or "The run finished without saying whether anything was sent.",
            **extra)


# ---------------------------------------------------------------------------
# Credentials
# ---------------------------------------------------------------------------
#
# The brief both engines share tells the agent, in plain text, which password to
# use if a portal demands an account. On this machine that is a password sitting
# in a prompt on the candidate's own laptop. Sent to a hosted model it is a
# password in a third party's request logs, their model provider's logs, and the
# run's own event stream, which this app polls and prints -- and on this account
# the portal password is also the mailbox password, so that is the reset channel
# for everything the candidate owns.
#
# The cloud API has the right mechanism for this: a secret is registered
# out-of-band under an alias, pinned to the hosts it may be typed into, and the
# agent only ever sees the alias. So the brief is rewritten on the way out --
# every literal credential swapped for its alias -- and the run is refused
# outright if any value survives the swap. A refused application is a nuisance;
# a published password is not.

def _credentials() -> List[Dict[str, str]]:
    """The secrets the shared brief may contain, each with the alias to use."""
    from services.automation import config as cfg

    pairs = [
        ("portal_password", cfg.PORTAL_PASSWORD_PRIMARY),
        ("portal_password_alt", cfg.PORTAL_PASSWORD_SECONDARY),
        ("signup_password", cfg.PORTAL_SIGNUP_PASSWORD),
        ("account_password", CANDIDATE_PROFILE.get("password") or ""),
    ]
    for index, value in enumerate(CANDIDATE_PROFILE.get("passwords") or []):
        pairs.append((f"password_{index + 1}", value))

    seen: Dict[str, str] = {}
    out: List[Dict[str, str]] = []
    for alias, value in pairs:
        value = str(value or "")
        # A one-character "password" would turn the whole brief into aliases.
        if len(value) < 4:
            continue
        if value in seen:
            continue
        seen[value] = alias
        out.append({"alias": alias, "value": value})
    return out


def _host_of(url: str) -> str:
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


# Hosts a job password must never be bound to, however the listing got there.
# An aggregator's "apply" link is a redirect chain, and a chain can pass through
# an identity provider; a binding is permission to type, so these are the places
# where permission must never be granted no matter what the URL says.
_NEVER_BIND = (
    "google.com", "gmail.com", "googleapis.com", "microsoft.com", "microsoftonline.com",
    "live.com", "outlook.com", "office.com", "apple.com", "icloud.com",
    "facebook.com", "linkedin.com", "github.com", "amazon.com",
)


def _registrable(host: str) -> str:
    """
    The host one level up, so a binding covers the sibling subdomain an apply
    flow moves to -- `nostalentsnosemplois.x.fr` to `candidat.x.fr`.

    Deliberately crude: the last two labels, and nothing clever about public
    suffixes beyond the handful of two-part ones that actually turn up on
    European job sites. Getting this wrong in the generous direction would widen
    a binding to a whole registry, so a three-label suffix is left alone.
    """
    parts = host.split(".")
    if len(parts) < 3:
        return ""
    tail = ".".join(parts[-2:])
    if tail in ("co.uk", "org.uk", "com.br", "co.jp", "com.au", "gouv.fr", "asso.fr"):
        return ".".join(parts[-3:]) if len(parts) > 3 else ""
    return tail


_LAND_LINK = re.compile(r"""https?://[^"'\s<>]*?/land/ad/[^"'\s<>]+""")
_META_REFRESH = re.compile(
    r"""http-equiv=["']?refresh["']?[^>]*?url=([^"'>\s]+)""", re.I)


def apply_hosts(job_url: str, log=lambda _m: None) -> List[str]:
    """
    Every host the application might actually be filled in on.

    A listing URL is rarely where the form lives. Adzuna links to the board,
    the board redirects to the employer, the employer's careers page hands off
    to an ATS on a third domain -- and a password pinned to the first of those
    is a password that cannot be typed at the only place it is needed. That is
    not hypothetical: it is exactly how the first real cloud run ended, one
    field short of a submitted application.

    So the chain is walked once before the run, with the browser's own headers,
    and every host it passes through is collected. Identity providers are
    dropped; the rest are offered to the binding, which the cloud then enforces.
    """
    hosts: List[str] = []

    def add(host: str) -> None:
        host = (host or "").lower()
        if host.startswith("www."):
            host = host[4:]
        if not host or host in hosts:
            return
        if any(host == bad or host.endswith("." + bad) for bad in _NEVER_BIND):
            return
        hosts.append(host)

    add(_host_of(job_url))

    # Hosts an earlier attempt on this listing ran into and could not use. A
    # redirect chain that only a real browser can walk is invisible to the GET
    # below, so the first run on such a site ends one field short and says which
    # domain it needed; this is that answer, coming back. It means "Try again"
    # actually differs from the attempt before it.
    for learned in (_cache().get("extra_hosts") or {}).get(_host_of(job_url), []):
        add(learned)

    seen_urls = set()

    def walk(url: str, depth: int) -> None:
        """Follow one URL, its redirects, and the one link that continues the chain."""
        if depth > 2 or not url or url in seen_urls:
            return
        seen_urls.add(url)
        try:
            res = requests.get(
                url, timeout=15, allow_redirects=True,
                headers={"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                                        "Chrome/141.0 Safari/537.36"),
                         "Accept-Language": "fr-FR,fr;q=0.9"},
            )
        except Exception:
            # A listing that will not answer a plain GET may still open in a
            # real browser. One host is worse than three, and better than none.
            return

        for hop in list(res.history) + [res]:
            add(_host_of(hop.url))

        body = ""
        if "html" in (res.headers.get("Content-Type") or "").lower():
            body = res.text[:400_000]
        if not body:
            return

        # An aggregator's details page does not redirect on GET: it holds the
        # employer behind an "Apply" link, and the hand-off happens when that
        # link is pressed. So the chain has one more hop than HTTP admits, and
        # it is the hop that matters -- the employer's domain is the only place
        # the sign-up password is ever going to be needed. Two patterns cover
        # what this app's feed actually produces: the redirector link Adzuna
        # puts behind its button, and a meta refresh.
        nxt = ""
        land = _LAND_LINK.search(body)
        if land:
            nxt = land.group(0).replace("&amp;", "&")
        else:
            meta = _META_REFRESH.search(body)
            if meta:
                nxt = meta.group(1).replace("&amp;", "&")
        if nxt:
            walk(nxt, depth + 1)

    walk(job_url, 0)

    for host in list(hosts):
        add(_registrable(host))

    if len(hosts) > 1:
        log(f"Application lives on {hosts[1] if hosts[1] != hosts[0] else hosts[0]}")
    # The binding takes at most twenty.
    return hosts[:20]


def redact_secrets(task: str, job_url: str, hosts: Optional[List[str]] = None) -> tuple:
    """
    Swap every literal credential in the brief for its alias, and describe the
    bindings that make the aliases mean something.

    Returns (task, bindings, leaked_aliases). `leaked_aliases` is empty on
    success; anything in it means a value could not be removed, and the caller
    must not send the task.
    """
    allowed = [h for h in (hosts if hosts is not None else [_host_of(job_url)]) if h]
    bindings: List[Dict[str, Any]] = []
    used = []

    for item in _credentials():
        if item["value"] not in task:
            continue
        task = task.replace(item["value"], f"<secret>{item['alias']}</secret>")
        used.append(item["alias"])
        if allowed:
            bindings.append({
                "alias": item["alias"],
                "source": {"type": "inline", "value": item["value"]},
                # Pinned to the domains this application actually runs through.
                # A binding with no domain at all would be typeable anywhere the
                # agent wandered, including into a Google sign-in box.
                "allowedDomains": allowed,
            })

    if used:
        from services.automation import config as cfg
        # Which alias survived deduplication for the password used to register.
        # It is not always "signup_password": when the signup password is the
        # same string as the primary one -- which it is on this account today --
        # only the first alias is bound, and naming the other one in the brief
        # would tell the agent to type a placeholder that means nothing.
        signup_value = cfg.PORTAL_SIGNUP_PASSWORD or cfg.PORTAL_PASSWORD_PRIMARY
        signup_alias = next((i["alias"] for i in _credentials()
                             if i["value"] and i["value"] == signup_value
                             and i["alias"] in used), "")
        register_rule = (f"""
- THIS INCLUDES CHOOSING ONE. When a registration form asks you to invent a password,
  do not invent one: type <secret>{signup_alias}</secret>, and the same again into
  "confirm password". A password only this run knows is an account the candidate can
  never get back into.""" if signup_alias else "")
        where = ", ".join(allowed[:6]) or "this employer's own site"
        task += f"""

ABOUT THE PASSWORDS ABOVE:
- Each <secret>name</secret> is a placeholder. Type it exactly as written into the
  password box and the browser puts the real value in as it goes. You are not being
  shown the password and you do not need to know it.
{register_rule}
- The placeholders work on: {where}. If one is refused because of the domain you are
  on, do NOT invent a password instead, and do not just give up: end your final
  message with this line, on its own --
  NEEDS_DOMAIN host=<the domain that refused it>
  The next attempt will be allowed to use the password there, so that line is what
  turns this into a finished application rather than a wasted run.
- Never put a placeholder into a message, a cover letter, a name field or any other
  free-text box."""

    # Belt and braces: whatever the replacement thought it did, the outgoing
    # text is checked against the raw values one more time.
    leaked = [i["alias"] for i in _credentials() if i["value"] and i["value"] in task]
    return task, bindings, leaked
