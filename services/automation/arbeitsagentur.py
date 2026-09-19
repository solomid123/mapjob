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
from datetime import date
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

# How many listings a search will open looking for `count` employers that
# actually printed an address. Around one in three does, so twelve tries per
# wanted result finds them without walking a whole city -- and the point of
# having a bound at all is that a search for twenty addresses in a town that
# has six should stop and say so, not read four hundred listings at one
# detail request each.
MAX_READ_FACTOR = 12

Event = Callable[..., None]

# What kind of offer the board is being asked for. `angebotsart` is its own
# parameter, but it is not enough on its own: apprenticeships live in a
# different search area, and asking for angebotsart=4 inside suchbereich=jobs
# returns nothing at all rather than an error. Typing "Ausbildung-Kaufmann/-frau
# Bueromanagement" into the search box therefore did not search apprenticeships
# -- it searched ordinary jobs for a word, and returned ordinary jobs.
OFFER_TYPES: Dict[str, Dict[str, object]] = {
    "arbeit":          {"suchbereich": "jobs",       "angebotsart": 1},
    "ausbildung":      {"suchbereich": "ausbildung", "angebotsart": 4},
    "praktikum":       {"suchbereich": "jobs",       "angebotsart": 34},
    "selbstaendigkeit": {"suchbereich": "jobs",      "angebotsart": 2},
}

# The only windows the board actually applies. It does not reject the others:
# `veroeffentlichtseit=30` comes back HTTP 200 with every listing it has,
# including ones from two years ago, which is exactly how a search asking for
# the last month quietly turns into a search asking for everything.
BOARD_WINDOWS = (1, 7, 14, 28)


def _board_window(days: int) -> int:
    """
    The widest window the board honours that is still no wider than asked for.

    Rounded *up* to an accepted value rather than down, because the caller's
    own cut-off is applied afterwards anyway: asking the board for 14 and then
    keeping only the last 10 days loses nothing, while asking it for 7 would
    throw away the rows between day 7 and day 10 before anyone could see them.
    Above 28 there is nothing to ask for, so the board is left unfiltered and
    the date check below does all the work.
    """
    if days <= 0:
        return 0
    for allowed in BOARD_WINDOWS:
        if allowed >= days:
            return allowed
    return 0


def posted_on(item: Dict[str, object], det: Optional[Dict[str, object]] = None) -> str:
    """
    The day this listing went up, as an ISO date, or "" when it does not say.

    Read off the search result rather than the detail payload, so a listing
    that is too old can be dropped before it costs a second request.
    """
    for source in (item or {}, det or {}):
        window = source.get("veroeffentlichungszeitraum") or {}
        if isinstance(window, dict) and window.get("von"):
            return str(window["von"])[:10]
        if source.get("datumErsteVeroeffentlichung"):
            return str(source["datumErsteVeroeffentlichung"])[:10]
        if source.get("aktuelleVeroeffentlichungsdatum"):
            return str(source["aktuelleVeroeffentlichungsdatum"])[:10]
    return ""


def age_in_days(posted: str) -> int:
    """How old the listing is, or -1 when the board did not print a date."""
    if not posted:
        return -1
    try:
        day = date.fromisoformat(posted[:10])
    except ValueError:
        return -1
    return max(0, (date.today() - day).days)

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


# Why the last request failed, for the caller that has to explain itself.
# Not raised: a failed detail request should skip one listing rather than end
# a search, and threading a result type through every call site to say so
# would be more machinery than this needs. But swallowing the reason entirely
# is what made a rejected request and an empty result look identical, and a
# board search that says "returned nothing" when the board actually said 400
# sends you looking for the wrong problem.
LAST_ERROR = ""


def _get(url: str) -> Optional[Dict[str, object]]:
    global LAST_ERROR
    try:
        request = urllib.request.Request(url, headers=_headers())
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            LAST_ERROR = ""
            return json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        LAST_ERROR = "the board answered HTTP " + str(error.code)
        if error.code == 400:
            LAST_ERROR += " (it rejected the search terms)"
        elif error.code in (401, 403):
            LAST_ERROR += " (it refused this client)"
        elif error.code == 429:
            LAST_ERROR += " (too many requests - slow down)"
    except urllib.error.URLError as error:
        LAST_ERROR = "could not reach the board: " + str(error.reason)[:80]
    except (ValueError, OSError) as error:
        LAST_ERROR = "unreadable answer from the board: " + str(error)[:80]
    return None


def search(was: str, wo: str = "", umkreis: int = 25, page: int = 1,
           size: int = PAGE_SIZE, published_within: int = 0,
           offer_type: str = "") -> Dict[str, object]:
    """One page of listings. Returns {"total", "items"}."""
    kind = OFFER_TYPES.get((offer_type or "").strip().lower(), {})
    params: Dict[str, object] = {
        "suchbereich": kind.get("suchbereich", "jobs"), "was": was, "wo": wo,
        "umkreis": umkreis, "page": page, "size": size,
    }
    if kind.get("angebotsart"):
        params["angebotsart"] = kind["angebotsart"]
    window = _board_window(int(published_within or 0))
    if window:
        params["veroeffentlichtseit"] = window
    # An empty parameter is not the same as an absent one. Sending `wo=` is a
    # 400 from the gateway, not a nationwide search -- so leaving the City box
    # blank did not widen the search, it broke the request, and the run
    # reported that the board had returned nothing. Anything empty is dropped.
    query = urllib.parse.urlencode(
        {k: v for k, v in params.items() if str(v).strip() not in ("", "None")})
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

    posted = posted_on(item, det)

    notes = "Ref: " + refnr
    if title:
        notes += " | " + title
    if posted:
        notes += " | Published " + posted
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
        # The day the employer put it up. A spontaneous application to a
        # vacancy advertised eight months ago is a letter about a job that was
        # filled in the spring, so this travels with the prospect and gets
        # shown next to the company rather than being thrown away after the
        # search that filtered on it.
        "posted_at": posted,
        # The vacancy, as a field of its own rather than a fragment of the
        # notes. A search returns the neighbours of what was asked for, and the
        # title is the only thing on the row that says which of the two a
        # company is -- so it has to be sortable, searchable and on screen, not
        # buried in a sentence.
        "job_title": title,
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
        skip_agencies: bool = True, published_within: int = 0,
        offer_type: str = "", require_email: bool = True,
        on_event: Optional[Event] = None,
        on_lead: Optional[Callable[[Dict[str, object]], None]] = None,
        should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, int]:
    """
    Walk the listings for one search and file each employer.

    Deduplicates on the reference number first and the company second: the
    board is full of one employer advertising the same apprenticeship in four
    districts, and four letters to the same firm is worse than one.

    `published_within` is counted here as well as asked of the board, and the
    two are not redundant. The board rounds the request to one of its four
    windows and ignores anything else without saying so, so "the last ten days"
    becomes "everything" on a parameter it does not recognise. The date on each
    listing is the thing that can be checked, and it is checked before the
    detail request is spent, so a stale row costs nothing but a comparison.

    `require_email` decides what `count` counts. With it on, an employer that
    printed no address is not a find and does not use up one of the twenty that
    were asked for: this application writes letters, so a row with nothing to
    write to is a row that can only be deleted. That means reading much deeper
    into the board than `count` suggests -- most listings print no address at
    all -- so `MAX_READ_FACTOR` bounds how far the search will chase before it
    gives up and says how far it got.
    """
    talk = on_event or (lambda *a, **k: None)
    tally = {"seen": 0, "kept": 0, "emails": 0, "phones": 0, "people": 0,
             "agencies": 0, "stale": 0, "no_email": 0}
    seen_refs: set = set()
    seen_companies: set = set()
    days = max(0, int(published_within or 0))
    ceiling = max(count * MAX_READ_FACTOR, 60) if require_email else 10 ** 9

    def fetch(page_number: int) -> Dict[str, object]:
        return search(was, wo, umkreis, page=page_number, size=PAGE_SIZE,
                      published_within=days, offer_type=offer_type)

    first = fetch(1)
    total = int(first["total"])  # type: ignore[arg-type]
    if not total:
        # "Nothing found" and "the request was refused" are different problems
        # with different fixes, and telling them apart is the difference
        # between rewording a search and finding out the board said 400.
        talk("The job board returned nothing for that search"
             + (" - " + LAST_ERROR if LAST_ERROR else ""),
             "error" if LAST_ERROR else "warn")
        return tally
    # The board counted its own window, which is the nearest one it has and not
    # always the one that was asked for, so the total is reported as the
    # board's and the cut-off as ours. Saying "18 listings in the last 10 days"
    # when the board was asked for 14 is a small lie that makes the next number
    # look wrong.
    board = _board_window(days)
    talk(str(total) + " listings on the board"
         + (" from the last " + str(board) + " days" if board else "")
         + "; reading up to " + str(count)
         + (" published within " + str(days) + " day"
            + ("s" if days != 1 else "") if days else ""))

    page = 1
    items: List[Dict[str, object]] = list(first["items"])  # type: ignore[arg-type]
    while tally["kept"] < count and tally["seen"] < ceiling:
        if should_stop and should_stop():
            break
        if not items:
            page += 1
            more = fetch(page)
            items = list(more["items"])  # type: ignore[arg-type]
            if not items:
                break

        item = items.pop(0)
        tally["seen"] += 1
        refnr = str(item.get("referenznummer") or "")
        if not refnr or refnr in seen_refs:
            continue
        seen_refs.add(refnr)

        # Before the detail request, not after: an eight-month-old listing is
        # not worth a round trip, and the date is already in hand.
        if days:
            age = age_in_days(posted_on(item))
            if age < 0 or age > days:
                tally["stale"] += 1
                continue

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

        # No address, no prospect. This application's one action is to send a
        # letter, so an employer that printed nothing to send to arrives as a
        # row whose only available button is delete -- and a table of those
        # buries the ones that can actually be written to. Counted, so the
        # console can say how many were passed over rather than leaving a
        # search for twenty that returned five looking broken.
        if require_email and not lead["email"]:
            tally["no_email"] += 1
            continue

        tally["kept"] += 1
        if lead["email"]:
            tally["emails"] += 1
        if lead["phone"]:
            tally["phones"] += 1
        if lead["contact_name"]:
            tally["people"] += 1
        if on_lead:
            on_lead(lead)

    talk(str(tally["kept"]) + " employers with an address, from "
         + str(tally["seen"]) + " listings read"
         + (" - " + str(tally["people"]) + " naming a person"
            if tally["people"] else "")
         # Counted separately, because between them these three are the answer
         # to "why did a search for twenty come back with six".
         + (", " + str(tally["no_email"]) + " printed no address"
            if tally["no_email"] else "")
         + (", " + str(tally["agencies"]) + " staffing agencies skipped"
            if tally["agencies"] else "")
         + (", " + str(tally["stale"]) + " too old or undated"
            if tally["stale"] else ""))
    if require_email and tally["kept"] < count and tally["seen"] >= ceiling:
        talk("Stopped after reading " + str(tally["seen"]) + " listings: this search "
             "does not have " + str(count) + " employers printing an address. Widen "
             "the window, the city or the kind of offer.", "warn")
    return tally

