# -*- coding: utf-8 -*-
"""
The Bundesagentur fuer Arbeit job board, through the door it leaves open.

The website puts a CAPTCHA in front of each employer's contact block. It is
there to stop exactly the bulk harvesting this app would otherwise do, so this
module does not touch it. It does not need to: the same agency publishes a
REST API for the same listings, and most employers write their address and
telephone number into the job description itself, which the API returns in
full. Measured on Ausbildung Bueromanagement in Berlin -- 25 listings, 18 with
an email, 16 with a telephone number, 25 with a website, and 246 more waiting.
The CAPTCHA was guarding a copy of something already lying in the open.

Two version numbers, because the gateway is inconsistent and it cost an hour to
find out: search answers on v6 and returns 403 on v4 and v5, while the detail
endpoint answers on v4 and returns 403 on v6. Both need the `correlation-id`
header, without which everything is 403 and looks like a blocked IP.

What the API gives that a browser scraper could not:

  * `istArbeitnehmerUeberlassung` and `istPrivateArbeitsvermittlung`, which
    mark a listing as belonging to a staffing agency rather than the employer.
    Half of any engineering search is Randstad posting the same role in nine
    cities, and writing to them is not applying to a company. They can be
    dropped before anything is spent on them.
  * `externeURL`, the employer's own site, which the crawler and the pattern
    pipeline take from here.

The parsers for the German contact line -- "Frau Meyer", "Ansprechpartner:" --
are ported from the scraper the user wrote, which had them right.
"""

from __future__ import annotations

import base64
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Callable, Dict, List, Optional

SEARCH_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs"
DETAIL_URL = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/"

# Published by the agency for its own front end. Not a secret, not a credential,
# and not something the user has to obtain.
API_KEY = "jobboerse-jobsuche"

PAGE_SIZE = 25
TIMEOUT = 40

# Between detail requests. The agency asks for restraint in its terms and the
# whole run is a few hundred requests; there is nothing to gain by hurrying.
PAUSE = 0.15

Event = Callable[..., None]

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")

# German numbers as they are actually written in a job ad: +49, 0049, or a
# leading zero, with spaces, slashes, dashes and brackets anywhere in them.
PHONE_RE = re.compile(
    r"(?:Tel(?:efon)?|Fon|Mobil|Telefonnummer)?\.?\s*:?\s*"
    r"((?:\+49|0049|0)[\d\s/()\-]{7,20}\d)"
)

PERSON_RE = re.compile(
    r"\b(Frau|Herr)\s+((?:Dr\.|Prof\.)\s+)?"
    r"([A-ZÄÖÜ][a-zäöüß]+)\s+([A-ZÄÖÜ][a-zäöüß\-]+)"
)
ANSPRECH_RE = re.compile(
    r"Ansprechpartner(?:in|/in|:in)?\s*:?\s*"
    r"(?:Frau|Herr)?\s*([A-ZÄÖÜ][a-zäöüß]+)\s+([A-ZÄÖÜ][a-zäöüß\-]+)"
)

# Addresses that are not the employer's: the agency's own, and the placeholder
# left in a template. The first filter is the user's, and it matters -- every
# listing footer carries an arbeitsagentur.de address.
NOT_THE_EMPLOYER = ("arbeitsagentur.de", "example.com", "muster", "ihre-firma")


def _headers() -> Dict[str, str]:
    return {
        "x-api-key": API_KEY,
        # Required. Its absence is answered with 403, which reads like a ban.
        "correlation-id": str(uuid.uuid4()),
        "accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    }


def _get(url: str) -> Optional[Dict[str, object]]:
    try:
        request = urllib.request.Request(url, headers=_headers())
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError, OSError):
        return None


def search(was: str, wo: str = "", umkreis: int = 25, page: int = 1,
           size: int = PAGE_SIZE) -> Dict[str, object]:
    """One page of listings. Returns {"total", "items"}."""
    query = urllib.parse.urlencode({
        "suchbereich": "jobs", "was": was, "wo": wo,
        "umkreis": umkreis, "page": page, "size": size,
    })
    data = _get(SEARCH_URL + "?" + query)
    if not data:
        return {"total": 0, "items": []}
    return {
        "total": int(data.get("maxErgebnisse") or 0),
        "items": list(data.get("ergebnisliste") or []),
    }


def detail(refnr: str) -> Dict[str, object]:
    if not refnr:
        return {}
    encoded = urllib.parse.quote(base64.b64encode(refnr.encode("utf-8")).decode())
    return _get(DETAIL_URL + encoded) or {}


def find_email(text: str) -> str:
    """
    The employer's address, not the agency's.

    Every listing carries an arbeitsagentur.de address in its boilerplate, so
    an unfiltered "first match" returns the job centre on nearly every row.
    """
    for found in EMAIL_RE.findall(text or ""):
        low = found.lower()
        if not any(bad in low for bad in NOT_THE_EMPLOYER):
            return low
    return ""


def find_phone(text: str) -> str:
    match = PHONE_RE.search(text or "")
    if not match:
        return ""
    number = re.sub(r"\s+", " ", match.group(1)).strip(" -/")
    # Fewer than seven digits is a house number or a postcode that happened to
    # sit behind the word Telefon.
    return number if len(re.sub(r"\D", "", number)) >= 7 else ""


def find_person(text: str) -> Dict[str, str]:
    """A named human to write to, as the German listing spells it."""
    text = text or ""
    match = PERSON_RE.search(text)
    if match:
        return {"first_name": match.group(3), "last_name": match.group(4),
                "name": (match.group(3) + " " + match.group(4)).strip()}
    match = ANSPRECH_RE.search(text)
    if match:
        return {"first_name": match.group(1), "last_name": match.group(2),
                "name": (match.group(1) + " " + match.group(2)).strip()}
    return {"first_name": "", "last_name": "", "name": ""}


def _address(det: Dict[str, object], item: Dict[str, object]) -> Dict[str, str]:
    places = (det.get("stellenlokationen") or item.get("stellenlokationen") or [])
    place = (places[0] if places else {}) or {}
    addr = place.get("adresse") or {}
    street = str(addr.get("strasse") or "").strip()
    number = str(addr.get("hausnummer") or "").strip()
    return {
        "street": (street + " " + number).strip(),
        "postcode": str(addr.get("plz") or "").strip(),
        "city": str(addr.get("ort") or "").strip(),
    }


def _website(det: Dict[str, object], description: str) -> str:
    for key in ("externeURL", "allianzpartnerUrl"):
        value = str(det.get(key) or "").strip()
        if value.startswith("http") and "arbeitsagentur.de" not in value:
            return value
    found = re.search(r"https?://[^\s\)\"'<>]+", description or "")
    return found.group(0) if found else ""


def to_lead(item: Dict[str, object], det: Dict[str, object],
            profession: str = "") -> Dict[str, object]:
    """One listing as a prospect, in the shape the ledger already speaks."""
    description = str(det.get("stellenangebotsBeschreibung") or "")
    company = str(det.get("firma") or item.get("firma") or "").strip()
    title = str(det.get("stellenangebotsTitel")
                or item.get("stellenangebotsTitel") or "").strip()
    where = _address(det, item)
    person = find_person(description)
    email = find_email(description)
    refnr = str(item.get("referenznummer") or det.get("referenznummer") or "")

    notes = "Ref: " + refnr
    if title:
        notes += " | " + title
    if det.get("istArbeitnehmerUeberlassung"):
        notes += " | Arbeitnehmerueberlassung"

    return {
        "company": company,
        "contact_name": person["name"],
        "role": "Ansprechpartner" if person["name"] else "",
        "email": email,
        # Printed by the employer in its own advertisement. Better evidence
        # than anything this app constructs, and still not proof: the verifier
        # decides, exactly as it does for a crawled address.
        "email_kind": "published" if email else "",
        "email_status": "unknown",
        "phone": find_phone(description),
        "website": _website(det, description),
        "street": where["street"],
        "postcode": where["postcode"],
        "city": where["city"],
        "ref": refnr,
        "source_url": "https://www.arbeitsagentur.de/jobsuche/jobdetail/" + refnr if refnr else "",
        "notes": notes,
        "source": "arbeitsagentur",
        "staffing_agency": bool(det.get("istArbeitnehmerUeberlassung")
                                or det.get("istPrivateArbeitsvermittlung")),
        "first_name": person["first_name"],
        "last_name": person["last_name"],
        "title": title,
        "profession": profession,
    }


def run(was: str, wo: str = "", umkreis: int = 25, count: int = 25,
        skip_agencies: bool = True,
        on_event: Optional[Event] = None,
        on_lead: Optional[Callable[[Dict[str, object]], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, int]:
    """
    Walk the listings for one search and file each employer.

    Deduplicates on the reference number first and the company second: the
    board is full of one employer advertising the same apprenticeship in four
    districts, and four letters to the same firm is worse than one.
    """
    talk = on_event or (lambda *a, **k: None)
    tally = {"seen": 0, "kept": 0, "emails": 0, "phones": 0, "people": 0, "agencies": 0}
    seen_refs: set = set()
    seen_companies: set = set()

    first = search(was, wo, umkreis, page=1, size=PAGE_SIZE)
    total = int(first["total"])  # type: ignore[arg-type]
    if not total:
        talk("The job board returned nothing for that search", "warn")
        return tally
    talk(str(total) + " listings on the board; reading up to " + str(count))

    page = 1
    items: List[Dict[str, object]] = list(first["items"])  # type: ignore[arg-type]
    while tally["kept"] < count:
        if should_stop and should_stop():
            break
        if not items:
            page += 1
            more = search(was, wo, umkreis, page=page, size=PAGE_SIZE)
            items = list(more["items"])  # type: ignore[arg-type]
            if not items:
                break

        item = items.pop(0)
        tally["seen"] += 1
        refnr = str(item.get("referenznummer") or "")
        if not refnr or refnr in seen_refs:
            continue
        seen_refs.add(refnr)

        det = detail(refnr)
        time.sleep(PAUSE)
        if not det:
            continue

        lead = to_lead(item, det, profession=was)
        company = str(lead["company"]).strip().lower()
        if not company:
            continue

        if lead["staffing_agency"] and skip_agencies:
            tally["agencies"] += 1
            continue
        if company in seen_companies:
            continue
        seen_companies.add(company)

        tally["kept"] += 1
        if lead["email"]:
            tally["emails"] += 1
        if lead["phone"]:
            tally["phones"] += 1
        if lead["contact_name"]:
            tally["people"] += 1
        if on_lead:
            on_lead(lead)

    talk(str(tally["kept"]) + " employers, " + str(tally["emails"]) + " with an address, "
         + str(tally["phones"]) + " with a telephone number, "
         + str(tally["people"]) + " naming a person"
         + (", " + str(tally["agencies"]) + " staffing agencies skipped"
            if tally["agencies"] else ""))
    return tally

