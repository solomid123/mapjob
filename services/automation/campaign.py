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

from services.automation import document_library as library
from services.automation import dossier, gmail_send
from services.automation import letter_writer as writer
from services.automation import people
from services.automation import outreach_store as store
from services.automation import tailor

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
    """
    Has a real message -- not a dry run -- already gone to this prospect?

    Asked of the send log, not of the documents. A document is a copy of what
    was written and the user is allowed to throw copies away; the send is an
    event in the world and deleting the copy does not undo it. Reading this off
    `documents` meant clearing out old applications quietly re-opened those
    employers for a second identical letter.
    """
    return store.has_been_sent_to(int(prospect_id))


def sent_today() -> int:
    """
    How much of today's allowance is gone.

    Counted from the send log rather than from a counter in memory, so a
    restart in the middle of an afternoon does not hand the account a fresh
    forty -- and rather than from the documents table, so neither does a
    tidy-up.
    """
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
    return store.sends_since(since)


def _reason_to_skip(row: Dict[str, Any], picked: bool = False,
                    again: bool = False) -> str:
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

    `again` lifts the last of those, and only for a picked row. A second letter
    is normally a mistake -- an employer does not read the same application
    twice -- but it is the user's mistake to make, and there are honest reasons
    for it: the first went out with the wrong CV, or the advert was reposted, or
    the documents have been re-tailored since. What must never happen is a
    blanket run quietly re-writing to everybody, so a run that names nobody
    ignores this flag entirely.
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
    if row.get("stage") == "sent" and not (picked and again):
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


def why_not(row: Dict[str, Any], picked: bool = False,
            again: bool = False) -> str:
    """
    The public form of the rule above, for a caller that has to explain itself.

    The API needs this when somebody clicks send on one row and the answer is
    no: "nobody is eligible" is true and useless when you are looking at the
    company's address on the screen.
    """
    return _reason_to_skip(row, picked=picked, again=again)


def eligible(limit: int = 500, city: str = "", source: str = "",
             ids: Optional[List[int]] = None,
             again: bool = False, user: Optional[str] = None) -> List[Dict[str, Any]]:
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
    # A second letter is only ever possible to a row the user named. The SQL
    # keeps `sent` out of every other queue, so no blanket run can reach one.
    resend = bool(again and chosen)
    # This account's rows and no others. The ids arrive from a page, and a page
    # must not be able to queue a letter to somebody on the other account's
    # list by naming their number.
    where = ["email <> ''", "COALESCE(NULLIF(user,''), ?) = ?"] + (
        [] if resend else ["stage <> 'sent'"])
    params: List[Any] = [store._DEFAULT_OWNER(), store._owner(user or "")]
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
        if _reason_to_skip(data, picked=bool(chosen), again=resend):
            continue
        if already_written_to(int(data["id"])) and not resend:
            continue
        out.append(data)
        if len(out) >= int(limit):
            break
    return out


def preview(limit: int = 500, city: str = "", source: str = "",
            ids: Optional[List[int]] = None, again: bool = False,
            user: Optional[str] = None) -> Dict[str, Any]:
    """What a run would do, without doing any of it."""
    ready = eligible(limit=limit, city=city, source=source, ids=ids, again=again,
                     user=user)
    return {
        "ready": len(ready),
        "sent_today": sent_today(),
        "remaining_today": max(0, DEFAULT_CAP - sent_today()),
        "companies": [r["company"] for r in ready[:12]],
    }


def _advert(row: Dict[str, Any], role: str = "") -> str:
    """
    What this application is about, in the words there are.

    A prospect found from a vacancy has the advert. A speculative one has no
    advert at all -- but it is not written against nothing, because the letter
    is not: it is written for `role`, at this company, in this town. The
    documents are cut against the same three things, so the pair arrives as one
    application rather than a bespoke letter stapled to a CV for nobody.
    """
    return "\n".join(line for line in (
        str(row.get("job_title") or "").strip(),
        str(role or "").strip(),
        str(row.get("role") or "").strip(),
        # Bookkeeping, but it carries the reference and the vacancy's own
        # wording; capped so a long note cannot become the advert.
        str(row.get("notes") or "").strip()[:400],
    ) if line)


def tailored_pair(row: Dict[str, Any], role: str = "",
                  on_event: Optional[Event] = None,
                  user: Optional[str] = None) -> Dict[str, Any]:
    """
    The documents the apply engines send, for this employer, or {}.

    Same templates, same typeface, same printer. Until now an emailed
    application came off a different machine from an applied-for one: this
    module's letter was drawn by reportlab and its CV was the master, unchanged,
    so the pair a recruiter opened did not look like one application and neither
    document was about them.

    The letter is still written by `letter_writer` -- it knows the prospect, it
    greets the contact by name, it writes German to a German employer, and none
    of that can be read off an advert -- but it is handed to the tailoring
    pipeline to be laid out and printed beside the CV. It is written lazily:
    documents already on disk for an unchanged advert are re-used, and a letter
    thrown away is a model call thrown away.

    The CV master exists in English and French only, so a German letter travels
    with an English CV until there is a German master. That is a known gap, not
    a decision.

    Returns {} for every failure -- no role, no model, no Chrome to print with
    -- and the caller falls back to what campaigns always sent.
    """
    prospect_id = row.get("id")
    if not prospect_id:
        return {}
    # What this application is for. A vacancy says so; a speculative one is for
    # whatever the user typed in the role box; and when that box is empty it is
    # for the work the candidate already does, which the profile knows. An empty
    # title used to abandon the whole thing and send the masters instead -- so
    # the one case this was built for, a speculative letter with no advert and
    # no role typed, was the one case that never got tailored documents.
    title = (str(row.get("job_title") or "").strip()
             or str(role or "").strip()
             or str(writer.safe_profile(user).get("current_title") or "").strip())
    # The employer's country decides the language; the applicant's own default
    # only settles the cases where the address gives nothing away. Hers is
    # German, so a company with a bare .com and no city still gets German.
    language = writer.language_for(row, people.letter_language(user))

    # For a German dossier the CV is not cut for this employer: the held
    # Lebenslauf goes as it is, and only the letter is written for them. See
    # `deckblatt.py`. Without a held one there is nothing to hand over, so the
    # tailoring cuts a CV from the master as it does for everybody else --
    # which is the right fallback, not a silent downgrade: the run log says so.
    fixed_cv, headline = "", ""
    if people.application_style(user) == "german_dossier":
        from services.automation import deckblatt

        held = deckblatt.lebenslauf(user)
        if held:
            fixed_cv = str(held)
            headline = str(writer.safe_profile(user).get("headline") or "")
        elif on_event:
            on_event("No Lebenslauf is held, so a CV was written from the master "
                     "instead", "warn", int(prospect_id))

    return tailor.application_for(
        job_id="outreach-" + str(prospect_id),
        title=title,
        company=str(row.get("company") or ""),
        location=str(row.get("city") or ""),
        url=str(row.get("website") or row.get("source_url") or ""),
        description=_advert(row, role),
        language=language,
        letter_factory=lambda: writer.write(row, role=role, language=language,
                                            user=user),
        fixed_cv=fixed_cv,
        headline=headline,
        # Whose application. The letter factory already knew; the documents
        # around it did not, so her Anschreiben was printed on his letterhead.
        user=user or "",
        log=(lambda message: on_event(message, "info", int(prospect_id))) if on_event else None)


def _signature(user: Optional[str] = None) -> str:
    """The name and the ways to reach it, under the letter in the mail body."""
    contact = writer.safe_profile(user)
    lines = [str(contact.get("full_name") or "")]
    tail = " | ".join(x for x in (str(contact.get("phone_formatted") or contact.get("phone") or ""),
                                  str(contact.get("email") or ""),
                                  str(contact.get("linkedin") or "")) if x)
    if tail:
        lines.append(tail)
    return "\n".join(x for x in lines if x)


def _pack_name(document_ids: List[str], merge: bool,
               user: Optional[str] = None) -> str:
    """
    What the bound file is called, and why it is not always the same name.

    The pack is rebuilt on every send, and the ledger keeps the path it was
    filed under. If one name served every selection, sending to a second
    employer with the transcript left out would quietly rewrite the file the
    first row points at -- the record would then show an application that was
    never sent. The choice is in the name, so a different choice is a
    different file.
    """
    import hashlib

    slug = writer.safe_profile(user).get("full_name") or "Application"
    slug = str(slug).replace(" ", "_")
    if not document_ids:
        return slug + "_Application.pdf"
    mark = hashlib.sha1(("|".join(sorted(document_ids)) + str(merge))
                        .encode("utf-8")).hexdigest()[:6]
    return slug + "_Application_" + mark + ".pdf"


def attachments_for(files: Dict[str, str], document_ids: Optional[List[str]] = None,
                    merge: bool = False,
                    on_event: Optional[Event] = None,
                    prospect_id: Optional[int] = None,
                    user: Optional[str] = None) -> Dict[str, Any]:
    """
    What actually goes on the message: the pair, plus whatever was ticked.

    Held documents come after the letter and the CV, in the order the library
    holds them, so a bound pack always reads letter, CV, transcript, diploma.
    """
    letter_pdf = files.get("letter_pdf") or ""
    cv_pdf = files.get("cv_pdf") or ""
    # A bound dossier is already the letter, the CV and whatever was ticked, in
    # the order a German employer reads them. Sending it *and* its own parts
    # would put the same letter in the envelope twice.
    pack_pdf = files.get("dossier_pdf") or ""
    if pack_pdf:
        who = str(writer.safe_profile(user).get("full_name") or "").strip()
        rows = library.chosen([str(i) for i in (document_ids or []) if i], user=user)
        return {
            "files": [pack_pdf], "merged": pack_pdf, "bound": [], "loose": [],
            "notes": [],
            # What it is called on arrival. "Bewerbungsunterlagen" is what a
            # German employer's filing system expects to see, and it says what
            # the file is before anybody opens it.
            "names": {pack_pdf: ("Bewerbungsunterlagen_" + who.replace(" ", "_")
                                 + ".pdf") if who else "Bewerbungsunterlagen.pdf"},
            "documents": [dict(r) for r in rows],
        }
    lead = [p for p in (letter_pdf, cv_pdf) if p]
    ids = [str(i) for i in (document_ids or []) if i]

    out = None
    if lead:
        from pathlib import Path as _Path

        out = _Path(lead[0]).parent / _pack_name(ids, merge, user)

    # Scoped to the sender: the ids came from a chooser that listed one
    # person's library, and the library refuses ids belonging to the other.
    plan = library.attachment_plan(ids, merge=merge, lead=lead, out=out, user=user)
    if plan.get("merged"):
        # The pack's filename carries a hash of the selection so a later send
        # cannot overwrite an earlier one's file. That is bookkeeping, and the
        # employer opening the attachment should see a document, not a build id.
        who = str(writer.safe_profile(user).get("full_name") or "").strip()
        plan.setdefault("names", {})[plan["merged"]] = (
            (who + " - Application.pdf") if who else "Application.pdf")
    if on_event:
        for note in plan.get("notes", []):
            on_event(note, "warn", prospect_id)
    return plan


def compose(row: Dict[str, Any], role: str = "",
            on_event: Optional[Event] = None,
            document_ids: Optional[List[str]] = None,
            merge: bool = False,
            user: Optional[str] = None) -> Dict[str, Any]:
    """
    Letter, PDFs, and the message body -- everything but the sending.

    The email body is the letter in plain text rather than a covering note
    pointing at an attachment. Half of recruiters read the body and never open
    anything; the PDF is for the other half and for their filing system.

    Two ways to get there. The tailored pair is the one that should happen: both
    documents printed from the same templates the apply engines use, about this
    employer. The old path -- a reportlab letter and the master CV -- is still
    here underneath, because a campaign that cannot tailor must still be able to
    write to somebody.
    """
    pair = tailored_pair(row, role=role, on_event=on_event, user=user)
    if not (pair and pair.get("body")) and on_event:
        # Said out loud, in the run log. Falling back quietly is how two
        # applications went out on the old templates without anybody knowing
        # until they were opened in the recipient's inbox.
        on_event("Could not tailor for this one - sending the standard letter "
                 "and the master CV", "warn",
                 int(row["id"]) if row.get("id") else None)
    if pair and pair.get("body"):
        letter = {"language": pair["language"], "subject": pair["subject"],
                  "greeting": pair["greeting"], "body": pair["body"],
                  "sign_off": pair["sign_off"]}
        files = {"letter_pdf": pair["letter"], "cv_pdf": pair["cv"],
                 "pack_pdf": pair.get("pack") or ""}
    else:
        letter = writer.write(row, role=role, user=user)
        files = dossier.build(row, letter, user=user or "")
    # A German application is one bound file that opens on a cover sheet. Built
    # here, after the letter exists, because the sheet's one tailored line and
    # the letter answer the same advert.
    if people.application_style(user) == "german_dossier" and files.get("letter_pdf"):
        from services.automation import deckblatt

        note = (lambda message: on_event(message, "info",
                                         int(row["id"]) if row.get("id") else None))             if on_event else None
        built = deckblatt.pack(
            {"title": str(row.get("job_title") or role or ""),
             "company": str(row.get("company") or "")},
            letter_pdf=files.get("letter_pdf") or "",
            document_ids=document_ids, user=user,
            job_id="outreach-" + str(row.get("id") or "speculative"), log=note)
        if built.get("pdf"):
            files = dict(files, dossier_pdf=built["pdf"], pack_pdf=built["pdf"])

    plan = attachments_for(files, document_ids, merge, on_event,
                           int(row["id"]) if row.get("id") else None, user=user)
    if plan.get("merged"):
        # The bound file is the pack now: it is what was sent, so it is what
        # the Documents tab should open.
        files = dict(files, pack_pdf=plan["merged"])

    body = (letter["greeting"] + "\n\n" + letter["body"] + "\n\n"
            + letter["sign_off"] + "\n" + _signature(user))
    return {"letter": letter, "files": files, "subject": letter["subject"],
            "body": body, "attachments": plan.get("files") or [],
            # What each attachment is called on arrival. Only held documents
            # have an entry: the letter and the CV are already named after the
            # candidate, and the bound pack is named by _pack_name.
            "names": plan.get("names") or {},
            "documents": plan.get("documents") or []}


def send_one(row: Dict[str, Any], role: str = "", dry_run: bool = True,
             on_event: Optional[Event] = None, picked: bool = False,
             again: bool = False, document_ids: Optional[List[str]] = None,
             merge: bool = False, user: Optional[str] = None) -> Dict[str, Any]:
    """
    One application, start to finish. Never raises.

    A failure here marks the prospect `failed` with the reason on the row, so
    the next run skips it rather than trying the same broken thing again and
    the user can see what went wrong without reading a log.
    """
    talk = on_event or (lambda *a, **k: None)
    # Whose send this is, for every store call below that does not spell it
    # out. `run` has already said so for a whole campaign; a single test send
    # comes straight off a request and would otherwise write its ledger line
    # under the default account.
    store.acting_as(user or "")
    prospect_id = int(row["id"])
    company = row.get("company") or ""

    skip = _reason_to_skip(row, picked=picked, again=again)
    if skip:
        talk(company + ": skipped - " + skip, "warn", prospect_id)
        return {"ok": False, "skipped": True, "reason": skip}

    try:
        built = compose(row, role=role, on_event=on_event,
                        document_ids=document_ids, merge=merge, user=user)
    except Exception as error:  # noqa: BLE001
        store.update_prospect(prospect_id, {"stage": "failed",
                                            "notes": (row.get("notes") or "")})
        talk(company + ": could not write the letter - " + str(error)[:120],
             "error", prospect_id)
        return {"ok": False, "reason": str(error)[:200]}

    files = built["files"]
    # Whatever the plan said: the pair, the pair plus the chosen documents, or
    # the single file they were bound into.
    attachments = list(built.get("attachments") or [])
    if not attachments:
        attachments = [p for p in (files.get("letter_pdf"), files.get("cv_pdf")) if p]
    if len(attachments) > 2:
        talk(company + ": attaching " + str(len(attachments)) + " files", "info",
             prospect_id)

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

    # Paired with the name each file should arrive under, so nothing in the
    # employer's inbox is called after this app's storage scheme.
    names = built.get("names") or {}
    result = gmail_send.send(
        to=row["email"], subject=built["subject"], body=built["body"],
        attachments=[(path, names.get(path, "")) for path in attachments],
        # Out of this account's own mailbox. Sending her application from
        # his Gmail puts his address on her reply.
        user=user or "")

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

    stamp = _now()
    # The fact first, the copy second. If recording the document failed the
    # message would still have gone, and a send that is not in the log is a
    # send the cap cannot see.
    store.record_send(prospect_id, row["email"],
                      str(result.get("message_id") or ""), stamp)
    document = store.record_document(
        prospect_id, built["subject"], built["body"],
        pdf_path=files.get("pack_pdf") or files.get("letter_pdf") or "",
        letter_path=files.get("letter_pdf") or "",
        cv_path=files.get("cv_pdf") or "",
        language=built["letter"]["language"],
        dry_run=False, sent_at=stamp, message_id=str(result.get("message_id") or ""))
    store.update_prospect(prospect_id, {"stage": "sent"})
    talk(company + ": sent to " + row["email"], "info", prospect_id)
    return {"ok": True, "dry_run": False, "document_id": document["id"],
            "message_id": result.get("message_id", "")}


def run(role: str = "", dry_run: bool = True, limit: int = 25,
        cap: int = DEFAULT_CAP, gap: float = DEFAULT_GAP,
        city: str = "", source: str = "", ids: Optional[List[int]] = None,
        on_event: Optional[Event] = None,
        should_stop: Optional[Callable[[], bool]] = None,
        again: bool = False, document_ids: Optional[List[str]] = None,
        merge: bool = False, user: Optional[str] = None) -> Dict[str, int]:
    """
    Write to everyone eligible, slowly, until the cap or the list runs out.

    `again` is only honoured for named rows: a second application to a company
    is something a person asks for one row at a time, never something a bulk
    run decides.
    """
    again = bool(again and ids)
    # Who is writing, settled once for the whole run. It decides the name at the
    # bottom of every letter, the profile the model is shown, the library the
    # ticked documents come from, and the language a letter falls back to.
    user = people.resolve(user)
    # And the ledger this run reads and writes is theirs: the same declaration
    # the API thread makes, repeated here so a caller that reaches `run`
    # directly cannot file its work under the wrong account.
    store.acting_as(user)
    talk = on_event or (lambda *a, **k: None)
    tally = {"considered": 0, "sent": 0, "drafted": 0, "failed": 0, "skipped": 0}

    queue = eligible(limit=limit, city=city, source=source, ids=ids, again=again,
                     user=user)
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
            " from " + (gmail_send.sender_address(user) or "the connected mailbox")))

    # Said once, at the top, rather than per prospect: it is the same choice for
    # the whole run, and it is the kind of thing worth seeing before forty
    # letters go out with a transcript that should not have been on them.
    picked_documents = library.chosen(document_ids, user=user)
    if picked_documents:
        talk("Each one carries " + ", ".join(str(d.get("title")) for d in picked_documents)
             + (", bound into one PDF with the letter and the CV" if merge
                else ", attached beside the letter and the CV"))

    for index, row in enumerate(plan):
        if should_stop and should_stop():
            talk("Stopped after " + str(tally["sent"] + tally["drafted"]), "warn")
            break
        tally["considered"] += 1
        talk(str(index + 1) + "/" + str(len(plan)) + " - " + str(row.get("company") or ""),
             "info", int(row["id"]))
        outcome = send_one(row, role=role, dry_run=dry_run, on_event=talk,
                           picked=bool(ids), again=again,
                           document_ids=document_ids, merge=merge, user=user)
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

