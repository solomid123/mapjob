# -*- coding: utf-8 -*-
"""
The bulk run: who gets written to, in what order, and when it stops.

This is the part that can do real damage, so most of it is refusals.

Who is eligible, and it depends on who is asking.

When nobody is named -- "write to whoever is ready" -- the app is choosing, so
it chooses conservatively: only addresses the employer published or the
verifier proved. An address built from a naming pattern is a hypothesis, and a
hypothesis sent to a mail server is a bounce, and enough bounces is a suspended
mailbox.

When the caller names the rows, the user is choosing, and the user is looking
at the company and the address and the `guess` badge beside it. Refusing there
would be refusing to do the thing that was just asked, about a fact already on
the screen. So a named row fails on four things only: no address, a malformed
one, one the verifier proved does not exist, and one that has already had a
letter. The last two are not caution, they are arithmetic -- a mailbox the
server denies is a guaranteed bounce, and a second copy of the same
spontaneous application is not read twice.

How often. A cold consumer Gmail account is not a mailing platform. Google's
published ceiling is around five hundred recipients a day; the practical one
before the account is flagged is far lower, so the default cap is forty a day
and the default gap is forty seconds with jitter. Both are arguments, but the
defaults are the honest numbers rather than the ones that make a demo look
fast. The mailbox at risk is the one the user reads their own mail in.

Whether it sends at all. `dry_run` is True unless the caller says otherwise.
A dry run does everything except the last step: it writes the letter, builds
the PDF and files the document, so what is reviewed in the Documents tab is
the actual artefact and not a mock-up of it.

Twice is worse than never. Before each send the ledger is asked whether this
prospect has already had a real message, and the second one is skipped. An
employer who receives the same spontaneous application twice does not read it
twice.
"""

from __future__ import annotations

import random
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional

from services.automation import dossier, gmail_send
from services.automation import letter_writer as writer
from services.automation import outreach_store as store

# The addresses that may be written to. Everything else waits for the verifier.
SENDABLE_STATUS = ("valid", "unknown")
SENDABLE_KIND = ("published", "")

DEFAULT_CAP = 40
DEFAULT_GAP = 40.0
JITTER = 0.35

Event = Callable[..., None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def already_written_to(prospect_id: int) -> bool:
    """Has a real message -- not a dry run -- already gone to this prospect?"""
    with store.connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM documents WHERE prospect_id=? AND dry_run=0"
            " AND sent_at IS NOT NULL LIMIT 1", (prospect_id,)).fetchone()
    return row is not None


def sent_today() -> int:
    """
    How much of today's allowance is gone.

    Counted from the ledger rather than from a counter in memory, so a restart
    in the middle of an afternoon does not hand the account a fresh forty.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    with store.connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM documents WHERE dry_run=0 AND sent_at IS NOT NULL"
            " AND sent_at >= ?", (since,)).fetchone()[0]
    return int(count or 0)


def _reason_to_skip(row: Dict[str, Any], picked: bool = False) -> str:
    """
    Why this prospect is not written to, in words a person can act on.

    Two standards, because two different things are being asked.

    A blanket run -- "write to whoever is ready" -- names nobody, so the app
    chooses, and it chooses conservatively: published or proved addresses only.
    An address this app built out of somebody's name is a hypothesis, and a
    hypothesis sent to a mail server is a bounce.

    A picked row is the other case. The user is looking at the company, the
    address and the `guess` badge next to it, and has clicked send on that one.
    There is nothing left for the app to decide: refusing would be refusing to
    do the thing that was just explicitly asked for, about an address the user
    can see. So a pick only fails on the four facts the user cannot see or
    cannot argue with -- no address, a malformed one, one the verifier proved
    does not exist, and one that has already had a letter.
    """
    email = (row.get("email") or "").strip()
    if not email or "@" not in email or "." not in email.split("@")[-1]:
        return "no email address"
    status = (row.get("email_status") or "unknown").strip()
    kind = (row.get("email_kind") or "").strip()
    if status == "invalid":
        # Not caution, arithmetic: the verifier asked the mail server and it
        # said no such mailbox. This one is a bounce with no upside.
        return "the address was proved not to exist"
    if row.get("stage") == "sent":
        return "already sent"
    if picked:
        return ""
    if status == "risky":
        return "the address is risky - the domain accepts everything"
    if status == "guessed" or kind == "inferred":
        return "the address is a guess, not a published one"
    if status not in SENDABLE_STATUS or kind not in SENDABLE_KIND:
        return "address status " + (status or "unknown")
    return ""


def why_not(row: Dict[str, Any], picked: bool = False) -> str:
    """
    The public form of the rule above, for a caller that has to explain itself.

    The API needs this when somebody clicks send on one row and the answer is
    no: "nobody is eligible" is true and useless when you are looking at the
    company's address on the screen.
    """
    return _reason_to_skip(row, picked=picked)


def eligible(limit: int = 500, city: str = "", source: str = "",
             ids: Optional[List[int]] = None) -> List[Dict[str, Any]]:
    """
    The queue, oldest first.

    Oldest first because a prospect found a week ago and never written to is
    the one that is going stale; newest-first would keep re-serving today's
    discoveries while last week's rot.

    `limit` counts prospects that come out, not rows that go in. The first
    version passed it straight to SQL, so asking for two eligible prospects
    read the two oldest rows, found both ineligible, and reported that there
    was nobody to write to while twelve people waited behind them.

    `ids` names the rows the user pointed at -- one row's send button, or a set
    of ticked boxes -- and switches the eligibility rule to the one for a
    deliberate choice. See `_reason_to_skip`.
    """
    chosen = [int(x) for x in (ids or [])][:500]
    where = ["email <> ''", "stage <> 'sent'"]
    params: List[Any] = []
    if chosen:
        where.append("id IN (" + ",".join("?" * len(chosen)) + ")")
        params.extend(chosen)
    if city:
        where.append("lower(city) = ?")
        params.append(city.strip().lower())
    if source:
        where.append("source = ?")
        params.append(source)
    with store.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM prospects WHERE " + " AND ".join(where)
            + " ORDER BY id ASC", params).fetchall()
    out = []
    for row in rows:
        data = dict(row)
        if _reason_to_skip(data, picked=bool(chosen)):
            continue
        if already_written_to(int(data["id"])):
            continue
        out.append(data)
        if len(out) >= int(limit):
            break
    return out


def preview(limit: int = 500, city: str = "", source: str = "",
            ids: Optional[List[int]] = None) -> Dict[str, Any]:
    """What a run would do, without doing any of it."""
    ready = eligible(limit=limit, city=city, source=source, ids=ids)
    return {
        "ready": len(ready),
        "sent_today": sent_today(),
        "remaining_today": max(0, DEFAULT_CAP - sent_today()),
        "companies": [r["company"] for r in ready[:12]],
    }


def compose(row: Dict[str, Any], role: str = "") -> Dict[str, Any]:
    """
    Letter, PDFs, and the message body -- everything but the sending.

    The email body is the letter in plain text rather than a covering note
    pointing at an attachment. Half of recruiters read the body and never open
    anything; the PDF is for the other half and for their filing system.
    """
    letter = writer.write(row, role=role)
    files = dossier.build(row, letter)
    body = (letter["greeting"] + "\n\n" + letter["body"] + "\n\n"
            + letter["sign_off"] + "\n" + str(writer.safe_profile().get("full_name") or ""))
    contact = writer.safe_profile()
    tail = " | ".join(x for x in (str(contact.get("phone_formatted") or contact.get("phone") or ""),
                                  str(contact.get("email") or ""),
                                  str(contact.get("linkedin") or "")) if x)
    if tail:
        body += "\n" + tail
    return {"letter": letter, "files": files, "subject": letter["subject"], "body": body}


def send_one(row: Dict[str, Any], role: str = "", dry_run: bool = True,
             on_event: Optional[Event] = None, picked: bool = False) -> Dict[str, Any]:
    """
    One application, start to finish. Never raises.

    A failure here marks the prospect `failed` with the reason on the row, so
    the next run skips it rather than trying the same broken thing again and
    the user can see what went wrong without reading a log.
    """
    talk = on_event or (lambda *a, **k: None)
    prospect_id = int(row["id"])
    company = row.get("company") or ""

    skip = _reason_to_skip(row, picked=picked)
    if skip:
        talk(company + ": skipped - " + skip, "warn", prospect_id)
        return {"ok": False, "skipped": True, "reason": skip}

    try:
        built = compose(row, role=role)
    except Exception as error:  # noqa: BLE001
        store.update_prospect(prospect_id, {"stage": "failed",
                                            "notes": (row.get("notes") or "")})
        talk(company + ": could not write the letter - " + str(error)[:120],
             "error", prospect_id)
        return {"ok": False, "reason": str(error)[:200]}

    files = built["files"]
    attachments = [p for p in (files.get("letter_pdf"), files.get("cv_pdf")) if p]

    if dry_run:
        store.clear_drafts(prospect_id)
        document = store.record_document(
            prospect_id, built["subject"], built["body"],
            pdf_path=files.get("pack_pdf") or files.get("letter_pdf") or "",
            letter_path=files.get("letter_pdf") or "",
            cv_path=files.get("cv_pdf") or "",
            language=built["letter"]["language"], dry_run=True)
        store.update_prospect(prospect_id, {"stage": "dossier"})
        talk(company + ": letter ready (dry run) - " + built["letter"]["language"],
             "info", prospect_id)
        return {"ok": True, "dry_run": True, "document_id": document["id"]}

    result = gmail_send.send(
        to=row["email"], subject=built["subject"], body=built["body"],
        attachments=attachments)

    if not result.get("sent"):
        store.record_document(prospect_id, built["subject"], built["body"],
                              pdf_path=files.get("pack_pdf") or "",
                              letter_path=files.get("letter_pdf") or "",
                              cv_path=files.get("cv_pdf") or "",
                              language=built["letter"]["language"], dry_run=True)
        store.update_prospect(prospect_id, {"stage": "failed"})
        talk(company + ": not sent - " + str(result.get("reason"))[:140],
             "error", prospect_id)
        return {"ok": False, "reason": str(result.get("reason"))[:200]}

    document = store.record_document(
        prospect_id, built["subject"], built["body"],
        pdf_path=files.get("pack_pdf") or files.get("letter_pdf") or "",
        letter_path=files.get("letter_pdf") or "",
        cv_path=files.get("cv_pdf") or "",
        language=built["letter"]["language"],
        dry_run=False, sent_at=_now(), message_id=str(result.get("message_id") or ""))
    store.update_prospect(prospect_id, {"stage": "sent"})
    talk(company + ": sent to " + row["email"], "info", prospect_id)
    return {"ok": True, "dry_run": False, "document_id": document["id"],
            "message_id": result.get("message_id", "")}


def run(role: str = "", dry_run: bool = True, limit: int = 25,
        cap: int = DEFAULT_CAP, gap: float = DEFAULT_GAP,
        city: str = "", source: str = "", ids: Optional[List[int]] = None,
        on_event: Optional[Event] = None,
        should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, int]:
    """
    Write to everyone eligible, slowly, until the cap or the list runs out.
    """
    talk = on_event or (lambda *a, **k: None)
    tally = {"considered": 0, "sent": 0, "drafted": 0, "failed": 0, "skipped": 0}

    queue = eligible(limit=limit, city=city, source=source, ids=ids)
    if not queue:
        talk("Nobody to write to: no prospect has a published or proved address "
             "that has not been written to already", "warn")
        return tally

    allowance = max(0, cap - sent_today()) if not dry_run else len(queue)
    if not dry_run and allowance <= 0:
        talk("Today's cap of " + str(cap) + " is already used. Nothing sent.", "warn")
        return tally

    plan = queue[:allowance]
    talk(("Drafting " if dry_run else "Sending ") + str(len(plan)) + " application"
         + ("s" if len(plan) != 1 else "")
         + (" (dry run - nothing leaves the mailbox)" if dry_run else
            " from " + (gmail_send.sender_address() or "the connected mailbox")))

    for index, row in enumerate(plan):
        if should_stop and should_stop():
            talk("Stopped after " + str(tally["sent"] + tally["drafted"]), "warn")
            break
        tally["considered"] += 1
        talk(str(index + 1) + "/" + str(len(plan)) + " - " + str(row.get("company") or ""),
             "info", int(row["id"]))
        outcome = send_one(row, role=role, dry_run=dry_run, on_event=talk,
                           picked=bool(ids))
        if outcome.get("skipped"):
            tally["skipped"] += 1
        elif not outcome.get("ok"):
            tally["failed"] += 1
        elif dry_run:
            tally["drafted"] += 1
        else:
            tally["sent"] += 1

        # Pace only real sends, and not after the last one: a dry run has
        # nothing to pace, and waiting forty seconds to finish is forty
        # seconds of a progress bar that has nothing left to do.
        if not dry_run and index < len(plan) - 1:
            wait = max(1.0, gap * (1 + random.uniform(-JITTER, JITTER)))
            deadline = time.time() + wait
            while time.time() < deadline:
                if should_stop and should_stop():
                    break
                time.sleep(0.25)

    talk(("Drafted " + str(tally["drafted"]) if dry_run
          else "Sent " + str(tally["sent"]))
         + (", " + str(tally["failed"]) + " failed" if tally["failed"] else "")
         + (", " + str(tally["skipped"]) + " skipped" if tally["skipped"] else ""))
    return tally

