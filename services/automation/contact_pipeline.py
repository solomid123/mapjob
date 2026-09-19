# -*- coding: utf-8 -*-
"""
Company, person, pattern, proof.

The other two engines look for a mailbox somebody published. Most companies
publish none: they print a web form, and the person who reads applications has
an address that appears nowhere. This one goes the other way round. It finds
who that person is, works out how the company spells addresses, builds the one
that person must therefore have, and asks the mail server whether it exists.

Four stages, and the last one is not optional:

  1. Companies. The SME list, from the research API.
  2. People and convention. The same API, asked for names on the imprint and
     team pages, plus any one published address belonging to a named person.
  3. The pattern. That sample address matched against that person's name says
     how the whole domain is laid out -- evidence, not a guess. The crawler
     runs too, free, and often finds the sample the research missed. With no
     sample, the permutations in prevalence order.
  4. The proof. SMTP, catch-all question first. A guessed address that has not
     been accepted by the domain's own mail server is not a lead, it is a
     fabrication with a name on it, and it is filed as `unproved` and never as
     an address.

What this cannot do, said plainly, because the failures are the specification:
a catch-all domain accepts every guess and so proves none of them; a mail
server that refuses this machine answers nothing about anybody; and a person
whose surname is spelled two ways has two candidates and maybe neither. Each
of those comes back with the reason attached rather than a shrug.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional

from services.automation import email_patterns as patterns
from services.automation import email_verify as verifier
from services.automation import lead_discovery as research
from services.automation import site_harvest as crawler

Event = Callable[..., None]

# Two companies at a time, not four. Each one is a research call, a crawl and
# a conversation with a mail server, and the mail server is the part that
# objects to being hurried.
WORKERS = 2

# How many people to name per company. A small firm has one person worth
# writing to; asking for five invents four.
PEOPLE_PER_COMPANY = 2


def _pattern_from_site(domain: str, people: List[Dict[str, str]]) -> Dict[str, str]:
    """
    Read the company's own pages for an address that teaches the convention.

    Free, and it beats the research API at this particular job often enough to
    be worth the ten seconds: a team page with six mailto: links on it says
    everything about how the domain is laid out, and no amount of asking a
    model to summarise that page returns it more reliably than reading it.
    """
    out = {"pattern": "", "sample": "", "role_address": "", "source_url": ""}
    if not domain or crawler.is_platform(domain):
        return out
    try:
        read = crawler.read_site(domain)
    except Exception:  # noqa: BLE001 - a site that will not answer is not a failure
        return out

    addresses = [str(e) for e in (read.get("emails") or [])]
    out["role_address"] = str(read.get("best") or "")
    out["source_url"] = "https://" + domain if addresses else ""

    names = [f"{p.get('first_name','')} {p.get('last_name','')}".strip() for p in people]
    personal = [a for a in addresses if patterns.is_personal(a)]
    for address in personal:
        for name in names:
            found = patterns.learn_pattern(address, *patterns.split_name(name))
            if found:
                out["pattern"], out["sample"] = found, address
                return out
    if personal:
        # A personal address whose owner is unknown still shows the shape:
        # pierre.martin@ is first.last whoever Pierre Martin is.
        out["sample"] = personal[0]
    return out


def _shape_of(address: str) -> str:
    """
    The pattern of an address whose owner is not known.

    Weaker evidence than a matched name -- a.dupont could be f.last or the
    initials of somebody else entirely -- so it proposes rather than decides,
    and the verifier still has to agree.
    """
    local = (address or "").split("@", 1)[0]
    if "." in local:
        head, tail = local.split(".", 1)
        if len(head) == 1:
            return "f.last"
        if len(tail) == 1:
            return "firstl"
        return "first.last"
    if "_" in local:
        return "first_last"
    if "-" in local:
        return "first-last"
    return ""


def find_contact(company: str, website: str = "", city: str = "",
                 profession: str = "", say: Optional[Event] = None) -> Dict[str, object]:
    """
    One company, one person, one address that has been proved to exist.

    Returns a lead whether or not it succeeds, because "read, found nobody" is
    a result worth filing: it stops the same company being paid for twice.
    """
    talk = say or (lambda *a, **k: None)
    domain = crawler.registrable(website)
    lead: Dict[str, object] = {
        "company": company,
        "website": website,
        "city": city,
        "contact_name": "",
        "role": "",
        "email": "",
        "email_kind": "",
        "email_status": "unknown",
        "source_url": "",
        "verify_reason": "",
        "verify_score": 0,
        "notes": f"Found for: {profession}" if profession else "",
        "source": "pattern",
    }

    try:
        who = research.find_people(company, website, city, PEOPLE_PER_COMPANY)
    except Exception as exc:  # noqa: BLE001 - one unreadable company is not a failed run
        talk(f"Could not read {company}: {exc}", "warn")
        who = {"people": [], "email_domain": "", "sample_email": "", "sample_person": ""}

    people: List[Dict[str, str]] = list(who.get("people") or [])  # type: ignore[arg-type]
    mail_domain = str(who.get("email_domain") or "") or domain
    if not people:
        talk(f"{company} names nobody publicly", "warn")
        lead["verify_reason"] = "no person is named on the company's own pages"
        return lead

    person = people[0]
    full_name = f"{person['first_name']} {person['last_name']}".strip()
    lead["contact_name"] = full_name
    lead["role"] = person.get("job_title", "")
    lead["source_url"] = person.get("source_url", "")

    # The convention, in descending order of how much it is worth trusting.
    pattern = ""
    sample = str(who.get("sample_email") or "")
    sample_person = str(who.get("sample_person") or "")
    if sample and sample_person:
        pattern = patterns.learn_pattern(sample, *patterns.split_name(sample_person))

    site = _pattern_from_site(mail_domain or domain, people)
    if not pattern and site["pattern"]:
        pattern, sample = site["pattern"], site["sample"]
    if not pattern and (site["sample"] or sample):
        pattern = _shape_of(site["sample"] or sample)

    if pattern:
        talk(f"{company} writes addresses as {pattern}")

    guesses = patterns.candidates(person["first_name"], person["last_name"],
                                  mail_domain, learned=pattern)
    if not guesses:
        lead["verify_reason"] = "no address could be built: the company's mail domain is unknown"
        return lead

    verdict = verifier.pick_existing([g["email"] for g in guesses])
    status = str(verdict.get("status") or "unknown")
    proved = str(verdict.get("email") or "")

    if status == "valid" and proved:
        lead.update(
            email=proved,
            email_status="valid",
            email_kind="pattern" if not sample or proved != sample else "published",
            verify_reason=str(verdict.get("reason") or ""),
            verify_score=int(verdict.get("score") or 0),
        )
        talk(f"{company}: {full_name} is at {proved}")
        return lead

    if status == "invalid":
        # Not "unproved" -- refused. A server that rejects an invented
        # recipient and then rejects all five spellings of this name has
        # answered the question, and keeping the first guess anyway would file
        # an address already known to be wrong. The person stays, because the
        # name is still worth having; the address does not.
        lead.update(
            email="", email_status="invalid", email_kind="",
            verify_reason=str(verdict.get("reason") or ""),
            verify_score=0,
        )
        talk(f"{company}: {full_name} - " + str(verdict.get("reason")), "warn")
        if site["role_address"]:
            lead.update(email=site["role_address"], email_status="unknown",
                        email_kind="published", source_url=site["source_url"],
                        verify_reason="")
            talk(f"{company}: writing to the published address instead")
        return lead

    # Unproved, but not refused: the server would not say. The address is kept,
    # because tomorrow from a different connection the same question may get an
    # answer -- filed as a guess, with the reason, and nothing downstream may
    # treat it as a destination until the verifier has said otherwise.
    lead.update(
        email=guesses[0]["email"],
        email_status="guessed",
        email_kind="inferred",
        verify_reason=str(verdict.get("reason") or "not checked"),
        verify_score=int(verdict.get("score") or 0),
    )
    if site["role_address"]:
        # A published department address is a worse destination than the right
        # person and a better one than a guess nobody confirmed.
        lead.update(email=site["role_address"], email_status="unknown",
                    email_kind="published", source_url=site["source_url"],
                    notes=(str(lead["notes"]) + " | " if lead["notes"] else "")
                          + f"{full_name} ({lead['role']}) - guessed "
                            f"{guesses[0]['email']}, unproved")
        talk(f"{company}: {full_name} could not be proved, using the published address")
    else:
        talk(f"{company}: {full_name} - {verdict.get('reason')}", "warn")
    return lead


def run(profession: str = "", city: str = "", company: str = "", count: int = 8,
        on_event: Optional[Event] = None,
        on_lead: Optional[Callable[[Dict[str, object]], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, int]:
    """Companies, then a named person at each, then an address that exists."""
    talk = on_event or (lambda *a, **k: None)
    tally = {"companies": 0, "people": 0, "proved": 0, "guessed": 0}

    companies = research.list_companies(profession, city, company, count, on_event=talk)
    if not companies:
        return tally
    tally["companies"] = len(companies)

    def work(item: Dict[str, str]) -> Optional[Dict[str, object]]:
        if should_stop and should_stop():
            return None
        talk(f"Reading {item['company']}")
        return find_contact(item["company"], item["website"], item["city"],
                            profession, say=talk)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for lead in pool.map(work, companies):
            if not lead:
                continue
            if lead.get("contact_name"):
                tally["people"] += 1
            if lead.get("email_status") == "valid":
                tally["proved"] += 1
            elif lead.get("email"):
                tally["guessed"] += 1
            if on_lead:
                on_lead(lead)
            if should_stop and should_stop():
                break

    talk(f"{tally['companies']} companies, {tally['people']} named a person, "
         f"{tally['proved']} addresses proved, {tally['guessed']} unproved")
    return tally

