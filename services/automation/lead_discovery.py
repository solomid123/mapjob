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


def _list_schema() -> Dict:
    """Stage one asks a wide, shallow question: who, and where."""
    return {
        "output_schema": {
            "type": "json",
            "json_schema": {
                "type": "object",
                "properties": {
                    "employers": {
                        "type": "array",
                        "description": "One entry per employer.",
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
            f"List up to {count} real employers"
            + (f" in or near {city}" if city else "")
            + f" that employ people in the role: {profession}."
        )
        lines.append(
            "Employers with their own careers pages only. Exclude job boards, "
            "aggregators, staffing agencies and recruitment consultancies, unless the "
            "role itself is a role at such a firm."
        )
    if profession and company:
        lines.append(f"Prefer locations that hire for the role: {profession}.")
    lines.append("For each one give its name, its careers page URL, and its city.")
    return "\n".join(lines)


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
    return {
        "contact_name": _field(content.get("contact_name"), 5),
        "role": _field(content.get("contact_role"), 8),
        "email": email,
        "phone": _field(content.get("phone"), 6),
        "website": _clean(content.get("careers_url")) or website,
    }


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
    count = max(1, min(int(count or 8), 20))

    def say(message: str, level: str = "info") -> None:
        if on_event:
            on_event(message, level)

    if not (profession or company):
        raise ValueError("Give a role to search for, or a company to search within.")

    say("Looking for employers" + (f" around {city}" if city else ""))
    content = _run_task(_list_prompt(profession, city, company, count), _list_schema(), PROCESSOR)

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
            "notes": f"Found for: {profession}" if profession else "",
        }
        say(f"Reading {item['company']}")
        try:
            lead.update({k: v for k, v in enrich(
                item["company"], item["website"], item["city"], profession
            ).items() if v and k != "phone"})
        except Exception as exc:  # noqa: BLE001 - one unreadable site is not a failed search
            say(f"Could not read {item['company']}: {exc}", "warn")
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
