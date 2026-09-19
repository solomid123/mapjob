"""
Lead discovery: turn "this job, in this city" into employers and the people
who hire for them.

The job seeker's question is not "which companies exist" -- a directory
answers that -- it is "who reads applications for this role, here, and at what
address". That is a research task with citations, which is what Parallel's
task API does: a prompt, a schema to fill, and a source URL behind every
field it fills in.

Two rules the prompt is built around, both learned from how this goes wrong:

  * Named company means that company only. Asking for "Lidl in Osnabrueck"
    and getting Aldi, Netto and Penny is not a helpful widening of the search;
    it is the wrong list. When a company is named, the results are filtered
    against its name afterwards as well, because a prompt is a request and a
    filter is a guarantee.

  * An invented address is worse than a missing one. A plausible-looking
    guess costs a bounce, a reputation hit and a job application that was
    never read. The schema lets every field come back empty, the prompt says
    so, and the verifier stage exists precisely to promote guesses.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional

from services.automation import site_harvest
from services.automation.config import load_env

load_env()

import os  # noqa: E402  - after load_env, so .env wins over the ambient shell

API_ROOT = "https://api.parallel.ai/v1/tasks/runs"
# `base` reads several pages per answer, which is what a list of employers
# needs; `lite` is a single lookup and tends to return one good row and then
# thin repeats. Override per-machine if the bill says otherwise.
PROCESSOR = os.getenv("PARALLEL_PROCESSOR", "base")
# One company, one page: a light processor reads it in about fifteen seconds.
CONTACT_PROCESSOR = os.getenv("PARALLEL_CONTACT_PROCESSOR", "lite")
# Finding the people takes more reading than finding the mailbox: the name of
# whoever runs HR is on the imprint, or the team page, or a press release, and
# a single-lookup processor gives up after the first of those.
PEOPLE_PROCESSOR = os.getenv("PARALLEL_PEOPLE_PROCESSOR", "base")
POLL_SECONDS = 5
TIMEOUT_SECONDS = int(os.getenv("PARALLEL_TIMEOUT", "420"))

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")
DENIAL = re.compile(
    r"^(no|none|not|there (is|are) (no|none)|nothing|unable|could not|cannot|does not)",
    re.IGNORECASE,
)
PLACEHOLDER = re.compile(
    r"^(n/?a|none|null|unknown|not (found|available|listed|public)|-{1,}|tbd)$",
    re.IGNORECASE,
)

Event = Callable[[str, str], None]


def is_configured() -> bool:
    return bool(os.getenv("PARALLEL_API_KEY", "").strip())


def _clean(value: object) -> str:
    """Empty is a legitimate answer; a word meaning "empty" is not."""
    text = str(value or "").strip()
    if not text or PLACEHOLDER.match(text):
        return ""
    return text


def _field(value: object, max_words: int) -> str:
    """
    A short fact, or nothing.

    Told a field may be empty, a research model will often fill it with a
    sentence saying so -- "No person responsible for applications is named." --
    which is a true statement and a useless value: it lands in the table as if
    it were a contact, and a letter addressed to it would open with "Dear No
    person responsible". A name is a name. Anything that reads like prose, or
    that begins by denying itself, is the model saying empty in words.
    """
    text = _clean(value).strip(" .;,")
    if not text:
        return ""
    if DENIAL.match(text):
        return ""
    if len(text.split()) > max_words:
        return ""
    return text


def _list_schema(count: int = 8) -> Dict:
    """
    Stage one asks a wide, shallow question: who, and where.

    The count lives in the array's description rather than in `minItems`,
    which Parallel rejects outright ("Unsupported keyword"). A description is
    weaker than a constraint, which is why the prompt repeats it.
    """
    return {
        "output_schema": {
            "type": "json",
            "json_schema": {
                "type": "object",
                "properties": {
                    "employers": {
                        "type": "array",
                        "description": f"Exactly {count} entries, one per employer, "
                                       "all different companies.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "company": {"type": "string", "description": "Legal or trading name of the employer."},
                                "website": {"type": "string", "description": "The employer's own careers page, or its website."},
                                "city": {"type": "string", "description": "City of the relevant branch or office."},
                            },
                            "required": ["company", "website", "city"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["employers"],
                "additionalProperties": False,
            },
        }
    }


def _contact_schema() -> Dict:
    """
    Stage two asks a narrow, deep question about one company at a time.

    Splitting the two is the whole trick. Asked for ten employers and their HR
    contacts in one task, the research spreads itself across ten companies and
    comes back with ten names and no addresses -- which is what the first
    version of this did. Asked about one company, with its careers URL already
    in hand, it reads the page and finds what is printed on it.
    """
    return {
        "output_schema": {
            "type": "json",
            "json_schema": {
                "type": "object",
                "properties": {
                    "contact_name": {"type": "string", "description": "Named person handling applications or HR. Empty if the company names none."},
                    "contact_role": {"type": "string", "description": "That person's job title as published."},
                    "email": {"type": "string", "description": "Application or HR email address, copied exactly as published. Empty if none is published."},
                    "phone": {"type": "string", "description": "HR phone number as published, if any."},
                    "careers_url": {"type": "string", "description": "URL of the page these details were read from."},
                },
                "required": ["contact_name", "contact_role", "email", "phone", "careers_url"],
                "additionalProperties": False,
            },
        }
    }


def _list_prompt(profession: str, city: str, company: str, count: int) -> str:
    lines: List[str] = []
    if company:
        lines.append(
            f"List up to {count} locations, branches, subsidiaries or regional offices of "
            f"the company {company}" + (f" in or near {city}" if city else "") + "."
        )
        lines.append(
            f"Only {company} itself and companies belonging to the {company} group. "
            "Do not include competitors, comparison sites, job boards, staffing agencies "
            "or any other employer, however similar or nearby."
        )
    else:
        lines.append(
            f"List {count} different small or medium companies"
            + (f" in or near {city}" if city else "")
            + f" that employ people in the role: {profession}."
        )
        # "Up to N" is how this asked at first, and the honest reading of "up to
        # eight" is one. A research model that has found a good first answer
        # stops there unless the count is a requirement, so it is stated as one,
        # twice, and the schema says it a third time.
        lines.append(
            f"Return exactly {count} entries, each a different company. Keep looking "
            f"until there are {count}; a shorter list is a wrong answer."
        )
        # Size, not fame. Asked plainly for employers hiring mechanical
        # engineers near Paris, the research returns Safran, Thales, Airbus,
        # Renault, Alstom and Naval Group: a correct answer to the question and
        # a useless one to this app, because not one of those six publishes an
        # address a person can write to. All six route applicants into an ATS
        # form, and two of them block this crawler outright. The companies that
        # read an unsolicited letter are the design offices and subcontractors
        # nobody lists, so those are what is asked for, by headcount.
        lines.append(
            "Size matters more than fame here. Every company must be an independent "
            "small or medium business, roughly 10 to 500 employees: a design office, "
            "a subcontractor, a machine builder, a specialist manufacturer, a family "
            "engineering firm. Do not list large listed groups, subsidiaries of one, "
            "or any company with more than a thousand employees."
        )
        lines.append(
            "These companies will receive an unsolicited application by email, so "
            "prefer ones that print an email address on their website rather than "
            "ones offering only a web form."
        )
        lines.append(
            "Exclude job boards, aggregators, staffing agencies and recruitment "
            "consultancies, unless the role itself is a role at such a firm."
        )
    if profession and company:
        lines.append(f"Prefer locations that hire for the role: {profession}.")
    lines.append("For each one give its name, its own website, and its city.")
    return "\n".join(lines)


def _people_schema() -> Dict:
    """
    Stage two, the other way round: the people, not the mailbox.

    Most companies never publish the mailbox of the person who reads
    applications, and every one of them publishes that person's name --
    on the imprint, the team page, the press release, the trade register.
    A name plus the house convention is an address; a missing mailbox is
    nothing. So this asks for what is actually there.
    """
    return {
        "output_schema": {
            "type": "json",
            "json_schema": {
                "type": "object",
                "properties": {
                    "email_domain": {
                        "type": "string",
                        "description": "The domain in the company's own staff email "
                                       "addresses, e.g. example-gmbh.de. Empty if none is seen.",
                    },
                    "sample_email": {
                        "type": "string",
                        "description": "Any one staff email address published anywhere, "
                                       "copied exactly, belonging to a named person rather "
                                       "than to a department. Empty if none is published.",
                    },
                    "sample_email_person": {
                        "type": "string",
                        "description": "The full name of the person that sample address "
                                       "belongs to. Empty if unknown.",
                    },
                    "people": {
                        "type": "array",
                        "description": "The people at this company who would read a "
                                       "speculative application: head of HR, recruiter, "
                                       "managing director, technical or engineering "
                                       "manager, owner.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "first_name": {"type": "string", "description": "Given name only."},
                                "last_name": {"type": "string", "description": "Family name only, including any particle such as van or von."},
                                "job_title": {"type": "string", "description": "Their title as published."},
                                "source_url": {"type": "string", "description": "Page their name was read from."},
                            },
                            "required": ["first_name", "last_name", "job_title", "source_url"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["email_domain", "sample_email", "sample_email_person", "people"],
                "additionalProperties": False,
            },
        }
    }


def _people_prompt(company: str, website: str, city: str, count: int) -> str:
    lines = [
        f"Find the people at {company}"
        + (f" ({website})" if website else "")
        + (f", location {city}" if city else "")
        + " who would read a speculative job application.",
        f"Name up to {count} of them, best first: the head of HR or the recruiter "
        "if the company has one, otherwise the managing director, the owner, or the "
        "technical or engineering manager.",
        "Read the imprint, the legal notice, the team or about page, the contact "
        "page and any press release. Give each person's given name and family name "
        "separately, and the page the name was read from.",
        "Also report the domain the company's own staff email addresses use, and one "
        "published address belonging to a named person, copied character for "
        "character, together with whose it is. A department address such as info@ "
        "or contact@ is not a person and does not count.",
        "Do not invent an email address and do not construct one from a name. "
        "Where something is not published, return an empty string. Do not write a "
        "sentence explaining that it is missing.",
    ]
    return "\n".join(lines)


def find_people(company: str, website: str = "", city: str = "",
                count: int = 3) -> Dict[str, object]:
    """Who to write to at one company, and how that company spells addresses."""
    content = _run_task(
        _people_prompt(company, website, city, count),
        _people_schema(),
        PEOPLE_PROCESSOR,
    )
    people: List[Dict[str, str]] = []
    for row in content.get("people") or []:
        if not isinstance(row, dict):
            continue
        first = _field(row.get("first_name"), 2)
        last = _field(row.get("last_name"), 3)
        if not last:
            continue
        people.append({
            "first_name": first,
            "last_name": last,
            "job_title": _field(row.get("job_title"), 8),
            "source_url": _clean(row.get("source_url")),
        })

    sample = _field(content.get("sample_email"), 1).lower()
    if sample and not EMAIL_RE.match(sample):
        sample = ""
    domain = _field(content.get("email_domain"), 1).lower().lstrip("@").strip("/")
    if sample and "@" in sample:
        # The address is the evidence; the field naming the domain is a claim
        # about it. Where they disagree, believe the address.
        domain = sample.split("@", 1)[1]
    return {
        "people": people[:count],
        "email_domain": domain,
        "sample_email": sample,
        "sample_person": _field(content.get("sample_email_person"), 5),
    }


def _contact_prompt(company: str, website: str, city: str, profession: str) -> str:
    lines = [
        f"On the official website of {company}"
        + (f" ({website})" if website else "")
        + (f", location {city}" if city else "")
        + ", find how an applicant is asked to apply.",
        "Look at the careers, jobs, contact and imprint pages. Give the named person "
        "responsible for applications or HR if the company names one, that person's job "
        "title, and the application email address exactly as it is printed.",
    ]
    if profession:
        lines.append(f"The application would be for a role such as: {profession}.")
    lines.append(
        "Copy the email address character for character from the page. Do not invent one, "
        "do not construct one from a person's name, and leave it empty if the company "
        "publishes only a web form."
    )
    lines.append(
        "Where something is not published, return an empty string for that field. "
        "Do not write a sentence explaining that it is missing."
    )
    return "\n".join(lines)


def _request(url: str, payload: Optional[Dict] = None, method: str = "GET") -> Dict:
    key = os.getenv("PARALLEL_API_KEY", "").strip()
    if not key:
        raise RuntimeError("PARALLEL_API_KEY is not set")
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"x-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        if exc.code in (401, 403):
            raise RuntimeError("Parallel rejected the API key") from exc
        raise RuntimeError(f"Parallel returned HTTP {exc.code}: {detail}") from exc


def _belongs_to(company_name: str, target: str) -> bool:
    """
    Is this row actually the company that was asked for?

    Compared on the distinctive word rather than the whole string, because the
    legal name of a branch carries freight the query never had: "Lidl" has to
    match "Lidl Dienstleistung GmbH & Co. KG", while "Aldi Sued" must not.
    """
    def core(text: str) -> str:
        text = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
        noise = {
            "gmbh", "ag", "kg", "co", "se", "mbh", "ohg", "ug", "sarl", "sas",
            "bv", "nv", "ltd", "plc", "inc", "deutschland", "group", "gruppe",
            "holding", "international", "germany", "und", "and", "the",
        }
        return " ".join(w for w in text.split() if w and w not in noise)

    target_core = core(target)
    name_core = core(company_name)
    if not target_core or not name_core:
        return False
    head = target_core.split()[0]
    return head in name_core.split() or target_core in name_core


def _run_task(prompt: str, spec: Dict, processor: str) -> Dict:
    """Submit one research task and wait for it. Returns the parsed content."""
    run = _request(API_ROOT, {"input": prompt, "processor": processor, "task_spec": spec}, "POST")
    run_id = run.get("run_id", "")
    if not run_id:
        raise RuntimeError("Parallel accepted the task but returned no run id")

    deadline = time.time() + TIMEOUT_SECONDS
    status = run.get("status", "queued")
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        state = _request(f"{API_ROOT}/{run_id}")
        status = state.get("status", status)
        if not state.get("is_active", True):
            break
    else:
        raise RuntimeError("The search ran past its time limit and was left running")

    if status != "completed":
        raise RuntimeError(f"The search ended as {status}")

    result = _request(f"{API_ROOT}/{run_id}/result")
    content = (result.get("output") or {}).get("content")
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            content = {}
    return content or {}


def enrich(company: str, website: str = "", city: str = "", profession: str = "") -> Dict[str, str]:
    """Read one company's own pages for the person and the address."""
    content = _run_task(
        _contact_prompt(company, website, city, profession),
        _contact_schema(),
        CONTACT_PROCESSOR,
    )
    email = _field(content.get("email"), 1).lower()
    if email and not EMAIL_RE.match(email):
        email = ""
    source = _clean(content.get("careers_url")) or website
    return {
        "contact_name": _field(content.get("contact_name"), 5),
        "role": _field(content.get("contact_role"), 8),
        "email": email,
        "phone": _field(content.get("phone"), 6),
        "website": source,
        "source_url": source if email else "",
    }


def crawl_for_address(website: str) -> Dict[str, str]:
    """
    Second opinion on where to write, from the site itself.

    The research stage reads what a search index knows about a company; the
    crawler reads the company's own careers and contact pages. They disagree
    often enough to be worth both: asked about Dassault Aviation the research
    came back empty, and thirty seconds of crawling its careers page found
    emploi@dassault-aviation.com printed on it.

    Free, so it costs nothing to try on every company the research left
    without an address. Sites behind a bot wall answer 403 to anything that is
    not a real browser -- safran-group.com and alten.fr both do -- and those
    stay empty until the browser fallback exists.
    """
    domain = site_harvest.registrable(website)
    # A Kompass or Societe.com listing is a page about the company, and reading
    # it harvests the directory's own switchboard address as though the
    # employer had printed it.
    if not domain or site_harvest.is_platform(domain):
        return {}
    try:
        read = site_harvest.read_site(domain)
    except Exception:  # noqa: BLE001 - a site that will not answer is not a failure
        return {}
    best = str(read.get("best") or "")
    if not best:
        return {}
    return {"email": best, "source_url": "https://" + domain}


def list_companies(profession: str = "", city: str = "", company: str = "",
                   count: int = 8, on_event: Optional[Event] = None) -> List[Dict[str, str]]:
    """
    Stage one on its own: who is out there, and where.

    Split out because two pipelines want it and neither wants the other's
    second stage. One asks the same API for a mailbox; the other asks for the
    people and builds the mailbox from a naming pattern.
    """
    profession, city, company = profession.strip(), city.strip(), company.strip()
    count = max(1, min(int(count or 8), 20))

    def say(message: str, level: str = "info") -> None:
        if on_event:
            on_event(message, level)

    if not (profession or company):
        raise ValueError("Give a role to search for, or a company to search within.")

    say("Looking for employers" + (f" around {city}" if city else ""))
    content = _run_task(
        _list_prompt(profession, city, company, count), _list_schema(count), PROCESSOR
    )

    found: List[Dict[str, str]] = []
    dropped = 0
    for row in content.get("employers") or []:
        if not isinstance(row, dict):
            continue
        name = _clean(row.get("company"))
        if not name:
            continue
        # The prompt asks for one company; this is what makes it true.
        if company and not _belongs_to(name, company):
            dropped += 1
            continue
        found.append({
            "company": name,
            "website": _clean(row.get("website")),
            "city": _clean(row.get("city")) or city,
        })

    if dropped:
        say(f"Discarded {dropped} result{'s' if dropped > 1 else ''} that were not {company}")
    if not found:
        say("No employers matched that search", "warn")
        return []
    say(f"{len(found)} employer{'s' if len(found) != 1 else ''} to read")
    return found


def discover(
    profession: str = "",
    city: str = "",
    company: str = "",
    count: int = 8,
    on_event: Optional[Event] = None,
    on_lead: Optional[Callable[[Dict[str, str]], None]] = None,
) -> List[Dict[str, str]]:
    """
    Find employers for a role in a place, then find out who to write to.

    Blocking and slow on purpose: stage one takes a couple of minutes and each
    company is then read separately, a few at a time. The caller runs this on a
    thread and narrates it through the pipeline console -- a progress line is
    what makes three minutes tolerable, and a spinner is what makes it feel
    broken. `on_lead` fires per employer as it is finished, so the table fills
    in while the search is still going rather than all at once at the end.
    """
    profession, city, company = profession.strip(), city.strip(), company.strip()

    def say(message: str, level: str = "info") -> None:
        if on_event:
            on_event(message, level)

    found = list_companies(profession, city, company, count, on_event=on_event)
    if not found:
        return []

    leads: List[Dict[str, str]] = []

    def work(item: Dict[str, str]) -> Dict[str, str]:
        lead = {
            "company": item["company"],
            "contact_name": "",
            "role": "",
            "email": "",
            "website": item["website"],
            "city": item["city"],
            "source": "parallel",
            "source_url": "",
            "email_kind": "",
            "notes": f"Found for: {profession}" if profession else "",
            # What the row is for. These companies were not found through an
            # advertisement, so there is no vacancy to quote and the trade that
            # was searched is the honest answer -- the same column the board's
            # own job titles land in, answering the same question.
            "job_title": profession or "",
        }
        say(f"Reading {item['company']}")
        try:
            lead.update({k: v for k, v in enrich(
                item["company"], item["website"], item["city"], profession
            ).items() if v and k != "phone"})
        except Exception as exc:  # noqa: BLE001 - one unreadable site is not a failed search
            say(f"Could not read {item['company']}: {exc}", "warn")

        # A company with no address is a row that cannot be written to, which
        # is the one outcome this whole search exists to avoid. Before giving
        # up on it, read the site directly -- it is free, it takes seconds, and
        # it looks at pages rather than at what was written about them.
        if not lead["email"]:
            found = crawl_for_address(lead["website"] or item["website"])
            if found:
                lead.update(found)
                say(f"Found {found['email']} on the site of {item['company']}")
            else:
                say(f"{item['company']} publishes no application address", "warn")
        if lead["email"]:
            lead["email_kind"] = "published"
        return lead

    # Four at a time: enough to keep a ten-company search inside a few minutes,
    # few enough not to look like a scrape to anyone's rate limiter.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for lead in pool.map(work, found):
            leads.append(lead)
            if on_lead:
                on_lead(lead)

    with_address = sum(1 for lead in leads if lead["email"])
    say(f"Read {len(leads)} employer{'s' if len(leads) != 1 else ''}, "
        f"{with_address} with a published address")
    return leads
