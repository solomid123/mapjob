"""
The fast lane: read company websites directly.

Research-by-model is accurate and costs two minutes and real money per
company. For volume that is the wrong instrument. What an employer publishes
for applicants is almost always on one of a handful of predictable pages --
/kontakt, /karriere, /recrutement, /contact, /impressum -- and it is published
precisely so that applicants use it. Fetching those pages and reading the
addresses off them takes a second or two per company and costs nothing.

So this module is the volume engine and Parallel is the scalpel: harvest a
city, then spend a deep lookup only on the companies that came back empty or
that matter.

Where the domains come from: OpenStreetMap. Employers with premises tag them
with a `website`, and Overpass will hand over every one of them in a city as
open data, which is a better source than scraping a search engine and an
honest one.

What this deliberately does not do:

  * It does not guess addresses. Everything here was printed by the employer
    on its own site. Pattern-guessing is a separate stage, and it must be
    followed by verification before anything is sent.
  * It does not crawl a site. It asks for a short list of likely pages, a few
    seconds apart, with a user agent that says what it is, and it obeys
    robots.txt. A job applicant reading a careers page is the traffic this is
    meant to look like, because that is what it is.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import socket
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, Iterable, List, Optional, Tuple
from urllib.robotparser import RobotFileParser

USER_AGENT = "MapJobOutreach/1.0 (job application research; contact via site owner)"
OVERPASS = "https://overpass-api.de/api/interpreter"

PAGE_TIMEOUT = 4
MAX_PAGES_PER_SITE = 9
MAX_ATTEMPTS_PER_SITE = 10
MAX_BYTES = 400_000

# Where employers put the thing an applicant needs, in the three languages
# this app is used in. Ordered: the best answer first, so a site that has a
# careers page is read there before its generic contact form.
CANDIDATE_PATHS = (
    "/karriere", "/jobs", "/stellenangebote", "/bewerbung",
    "/recrutement", "/carriere", "/carrieres", "/emploi", "/nous-rejoindre",
    "/careers", "/career", "/join-us",
    "/kontakt", "/contact", "/contactez-nous", "/impressum", "/mentions-legales",
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}")
LINK_RE = re.compile(r'href=["\']([^"\'#?]+)', re.IGNORECASE)
TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)

# An address whose local part says "we read applications here".
HIRING_WORDS = (
    "recrutement", "recruitment", "recruiting", "bewerbung", "bewerbungen",
    "karriere", "personal", "hr", "rh", "jobs", "job", "emploi", "emplois",
    "career", "careers", "candidature", "candidatures", "talent", "people",
    "ausbildung", "praktikum", "stellen",
)
GENERIC_WORDS = ("kontakt", "contact", "info", "office", "mail", "hello", "bonjour", "buero")
# Addresses that are never a destination for an application.
JUNK_WORDS = (
    "noreply", "no-reply", "donotreply", "newsletter", "abuse", "postmaster",
    "webmaster", "datenschutz", "privacy", "dsgvo", "presse", "press", "media",
    "support", "sentry", "example", "domain", "sentry.io", "wixpress",
)
JUNK_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js")

# Addresses printed on a page to show what an address looks like. They read as
# perfectly good leads -- name@capgemini.com is on the company's own domain and
# scored 35 until this existed -- and a letter to one is a letter to nobody.
# Matched whole, not as a substring: "info" contains no placeholder, but
# "prenom.nom" is one.
PLACEHOLDER_LOCALS = {
    "name", "nom", "prenom", "vorname", "nachname", "firstname", "lastname",
    "yourname", "your.name", "you", "user", "username", "email", "e-mail",
    "mailadresse", "adresse", "address", "beispiel", "exemple", "example",
    "sample", "test", "foo", "bar", "abc", "xxx", "muster", "mustermann",
    "max.mustermann", "erika.mustermann", "john.doe", "jane.doe", "jean.dupont",
    "prenom.nom", "vorname.nachname", "firstname.lastname", "first.last",
    "nom.prenom", "ihrname", "votrenom",
}
# Domains that only ever appear in an illustration or a tracking snippet.
PLACEHOLDER_DOMAINS = {
    "example.com", "example.org", "example.net", "exemple.fr", "beispiel.de",
    "domain.com", "yourdomain.com", "yourcompany.com", "email.com", "mail.com",
    "test.com", "sentry.io", "wixpress.com", "localhost",
}

Event = Callable[..., None]


# What a page title says before it says the company: "Startseite - X",
# "Home | X", "Willkommen bei X".
TITLE_NOISE = re.compile(
    r"^\s*(startseite|home|homepage|willkommen( bei)?|accueil|bienvenue( chez| sur)?|"
    r"welcome( to)?)\s*[-|:–•]?\s*", re.IGNORECASE)


def _name_from_domain(domain: str) -> str:
    """orpy-ingenierie.fr -> Orpy Ingenierie. Never wrong, occasionally ugly."""
    label = (domain or "").split(".")[0]
    words = [w for w in re.split(r"[-_]+", label) if w]
    return " ".join(w if w.isupper() else w.capitalize() for w in words)[:70]


def _title_is_the_name(head: str, domain: str) -> bool:
    """
    Does this title segment name the company, or describe what it sells?

    A title is written for search engines, so a third of them open with the
    trade rather than the firm: "Bureau d'etudes mecaniques et calculs" is the
    whole of what orpy-ingenierie.fr puts in its <title>, and filed under that
    name the row is unrecognisable. The domain is the one place the company's
    own name is guaranteed to be, so a title that does not echo it has to earn
    its place by being short enough to be a name rather than a sentence.
    """
    label = re.sub(r"[^a-z0-9]", "", (domain or "").split(".")[0].lower())
    flat = re.sub(r"[^a-z0-9]", "", head.lower())
    if label and flat and (label in flat or flat in label):
        return True
    if label and any(len(w) > 3 and w in label
                     for w in re.split(r"[^a-z0-9]+", head.lower())):
        return True
    return len(head.split()) <= 3


def _company_from_title(title: str, domain: str = "") -> str:
    """
    A usable company name out of a page title.

    A title is a marketing sentence -- "Leue Apotheken - Ihre vor Ort
    Apotheken in Osnabrueck und Bad Iburg" -- and a ledger row needs the first
    two words of it, not the slogan. Cut at the first separator, drop the
    "Startseite" prefix, and never let it run past a line in a table.
    """
    text = TITLE_NOISE.sub("", title or "").strip()
    head = re.split(r"\s+[-|–•]\s+|\s*\|\s*", text)[0].strip(" -–|:")
    # A first segment of two characters is a separator accident, not a name.
    if len(head) < 3:
        head = text
    head = head[:70].strip()
    if domain and head and not _title_is_the_name(head, domain):
        return _name_from_domain(domain)
    return head or _name_from_domain(domain)


def _fetch(url: str, timeout: int = PAGE_TIMEOUT) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "de,fr;q=0.9,en;q=0.8",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type", "")
        if "html" not in ctype and "text" not in ctype:
            return ""
        raw = resp.read(MAX_BYTES)
    charset = "utf-8"
    match = re.search(r"charset=([\w-]+)", ctype)
    if match:
        charset = match.group(1)
    return raw.decode(charset, "replace")


def registrable(url_or_host: str) -> str:
    """Bare host, lowercased, without www. Two URLs on one site are one lead."""
    text = (url_or_host or "").strip()
    if not text:
        return ""
    if "//" not in text:
        text = "http://" + text
    host = urllib.parse.urlparse(text).netloc.lower()
    host = host.split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def _resolves(host: str) -> bool:
    """
    Does this host exist at all?

    Guessing jobs.<domain> costs a five-second timeout when it does not exist
    and a millisecond of DNS when it does not resolve. Asking DNS first turned
    a ninety-second read into a twenty-second one.
    """
    try:
        socket.getaddrinfo(host, None)
        return True
    except OSError:
        return False


def _same_org(url: str, domain: str) -> bool:
    """
    jobs.lidl.de is Lidl.

    Careers live on a subdomain often enough that treating one as a different
    company loses exactly the page this module is looking for.
    """
    host = registrable(url)
    return bool(host) and (host == domain or host.endswith("." + domain))


def _robots(base: str) -> Optional[RobotFileParser]:
    parser = RobotFileParser()
    parser.set_url(base + "/robots.txt")
    try:
        parser.parse(_fetch(base + "/robots.txt", timeout=5).splitlines())
        return parser
    except Exception:  # noqa: BLE001 - no robots.txt is permission, not refusal
        return None


def _score(email: str, domain: str) -> int:
    """
    How likely is this address to be read by someone who hires?

    An application to info@ is read, eventually, by whoever reads info@. An
    application to bewerbung@ is read by the person whose job that is. The
    ranking matters more than it looks: it decides which single address a
    letter is sent to.
    """
    local = email.split("@", 1)[0].lower()
    host = email.split("@", 1)[1].lower()
    if any(word in local for word in JUNK_WORDS):
        return -1
    if local in PLACEHOLDER_LOCALS:
        return -1
    bare = host[4:] if host.startswith("www.") else host
    if bare in PLACEHOLDER_DOMAINS or bare.endswith(".example"):
        return -1
    score = 0
    if any(word == local or local.startswith(word) or local.endswith(word) for word in HIRING_WORDS):
        score += 100
    elif any(word in local for word in HIRING_WORDS):
        score += 70
    elif any(word in local for word in GENERIC_WORDS):
        score += 40
    elif "." in local or "-" in local:
        score += 30  # looks like a person: first.last@
    else:
        score += 10
    if domain and (host == domain or host.endswith("." + domain)):
        score += 25  # an address on the company's own domain, not its agency's
    return score


def _emails_from(html: str, domain: str) -> List[Tuple[int, str]]:
    seen: Dict[str, int] = {}
    for raw in EMAIL_RE.findall(html or ""):
        email = raw.strip(" .,;:'\"<>()").lower()
        if email.endswith(JUNK_SUFFIX) or len(email) > 90:
            continue
        score = _score(email, domain)
        if score < 0:
            continue
        seen[email] = max(seen.get(email, 0), score)
    return sorted(((v, k) for k, v in seen.items()), reverse=True)


def read_site(domain: str, polite_seconds: float = 0.25) -> Dict[str, object]:
    """
    Read one company's published addresses.

    Homepage first, because its links say which of the candidate paths this
    site actually has -- a guessed /karriere on a site that calls it /jobs is
    a 404 and a wasted second.
    """
    domain = registrable(domain)
    if not domain:
        return {"domain": "", "emails": [], "pages": 0, "name": ""}

    base = "https://" + domain
    robots = _robots(base)

    def allowed(url: str) -> bool:
        return True if robots is None else robots.can_fetch(USER_AGENT, url)

    found: Dict[str, int] = {}
    title = ""
    pages = 0

    def absorb(html: str) -> None:
        for score, email in _emails_from(html, domain):
            found[email] = max(found.get(email, 0), score)

    try:
        home = _fetch(base) if allowed(base) else ""
    except Exception:  # noqa: BLE001 - a site that will not answer is not an error
        try:
            base = "http://" + domain
            home = _fetch(base) if allowed(base) else ""
        except Exception:  # noqa: BLE001
            return {"domain": domain, "emails": [], "pages": 0, "name": ""}

    pages += 1
    absorb(home)
    match = TITLE_RE.search(home or "")
    if match:
        title = _company_from_title(
            re.sub(r"\s+", " ", re.sub("<[^>]+>", "", match.group(1))).strip(), domain)

    # Every link the homepage actually offers first, and only then the guesses.
    #
    # The other way round -- guess /karriere, guess /jobs, guess /bewerbung,
    # then look at the links -- is what this did, and on a French site it spent
    # the whole ten-attempt budget on German 404s and never opened the
    # /contact page the homepage had been linking all along. A link is
    # evidence that the page exists; a guess is a hope that it does, and
    # evidence goes first.
    hrefs = {urllib.parse.urljoin(base, h) for h in LINK_RE.findall(home or "")}
    same_site = [h for h in hrefs if _same_org(h, domain)]
    wanted: List[str] = []
    guesses: List[str] = []
    for path in CANDIDATE_PATHS:
        token = path.strip("/")
        # Shortest first: /contact is the contact page, /contact/team/anne is a
        # page on it, and the budget is small enough to care.
        matches = sorted((h for h in same_site if token in h.lower()), key=len)
        for href in matches[:2]:
            if href not in wanted:
                wanted.append(href)
        guesses.append(base + path)
    wanted.extend(guess for guess in guesses if guess not in wanted)
    # Careers often live on their own subdomain and are linked from nowhere the
    # homepage parser can see, so the likely ones are tried directly.
    for sub in ("jobs", "karriere", "carriere", "recrutement", "careers", "emploi"):
        host = f"{sub}.{domain}"
        guess = f"https://{host}/"
        if guess not in wanted and _resolves(host):
            wanted.append(guess)

    attempts = 0
    for url in wanted:
        # Attempts, not successes: a guessed path that 404s still cost a
        # request, and counting only the hits is how a "read nine pages" budget
        # turns into forty requests against one small company's server.
        if pages >= MAX_PAGES_PER_SITE or attempts >= MAX_ATTEMPTS_PER_SITE:
            break
        if not allowed(url):
            continue
        time.sleep(polite_seconds)
        attempts += 1
        try:
            absorb(_fetch(url))
            pages += 1
        except Exception:  # noqa: BLE001 - a 404 on a guessed path is expected
            continue
        # Enough. An address whose name is "bewerbung" is the destination; a
        # second opinion about it does not exist, and the next page is a page
        # somebody's server served for nothing.
        if any(score >= 100 for score in found.values()):
            break

    ranked = sorted(((score, email) for email, score in found.items()), reverse=True)
    return {
        "domain": domain,
        "emails": [email for _, email in ranked],
        "best": ranked[0][1] if ranked else "",
        "best_score": ranked[0][0] if ranked else 0,
        "pages": pages,
        "name": title,
    }


# ---------------------------------------------------------------------------
# Where the domains come from
# ---------------------------------------------------------------------------

# Employers, as OpenStreetMap tags them. Not "every node with a website": a
# bus stop and a postbox have websites too, and a letter to either is a letter
# thrown away.
OSM_FILTERS = (
    '["office"]',
    '["shop"]',
    '["craft"]',
    '["healthcare"]',
    '["industrial"]',
    '["man_made"="works"]',
    '["building"="industrial"]',
    '["amenity"~"^(school|college|university|kindergarten|hospital|clinic|doctors|'
    'dentist|pharmacy|veterinary|bank|restaurant|cafe|hotel|nursing_home|'
    'social_facility|driving_school|car_rental|car_wash|fuel)$"]',
    '["tourism"~"^(hotel|guest_house|apartment)$"]',
    '["leisure"~"^(fitness_centre|sports_centre)$"]',
)

# Overpass is donated infrastructure. One instance is a single point of
# failure and also somebody else's electricity bill, so: a generous timeout, a
# second mirror, and no retry storm.
OVERPASS_MIRRORS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

# Platforms that host a page about a company rather than being the company. A
# careers page is never at facebook.com, and reading one would be reading
# Facebook, not the employer.
PLATFORM_HOSTS = {
    "facebook.com", "m.facebook.com", "instagram.com", "twitter.com", "x.com",
    "linkedin.com", "de.linkedin.com", "fr.linkedin.com", "youtube.com",
    "google.com", "business.site", "sites.google.com", "wixsite.com",
    "jimdo.com", "jimdofree.com", "wordpress.com", "blogspot.com",
    "tripadvisor.com", "tripadvisor.de", "tripadvisor.fr", "yelp.com",
    "booking.com", "airbnb.com", "amazon.de", "amazon.fr", "ebay.de",
    # Business directories. The research stage hands one of these back when it
    # cannot find a company's own site, and crawling it harvests the
    # directory's own switchboard address as if it were the employer's.
    "kompass.com", "fr.kompass.com", "de.kompass.com", "societe.com",
    "pagesjaunes.fr", "verif.com", "infogreffe.fr", "europages.fr",
    "europages.co.uk", "wlw.de", "firmenwissen.de", "northdata.de",
    "dnb.com", "bloomberg.com", "crunchbase.com", "glassdoor.com",
    "indeed.com", "indeed.fr", "stepstone.de", "welcometothejungle.com",
}


def is_platform(url_or_host: str) -> bool:
    """A page about a company, rather than the company's own site."""
    host = registrable(url_or_host)
    if not host:
        return True
    return host in PLATFORM_HOSTS or any(
        host.endswith("." + known) for known in PLATFORM_HOSTS
    )


def _overpass(query: str, timeout: int = 180) -> Dict[str, object]:
    body = urllib.parse.urlencode({"data": query}).encode()
    last: Optional[Exception] = None
    for host in OVERPASS_MIRRORS:
        req = urllib.request.Request(host, data=body, headers={
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001 - try the mirror, then give up
            last = exc
    raise RuntimeError(f"OpenStreetMap did not answer: {last}")


def domains_from_osm(city: str, keyword: str = "", limit: int = 400,
                     on_event: Optional[Event] = None) -> List[Dict[str, str]]:
    """
    Every employer in a city that publishes a website, as open data.

    The keyword, when given, is matched against the name and the tags -- so
    "Pflege" finds the care homes and "Bau" the builders. Left empty it
    returns the whole city, which is the point: a thousand employers from one
    query, none of them scraped out of a search engine.
    """
    city = (city or "").strip()
    if not city:
        return []
    say = on_event or (lambda *a, **k: None)

    parts = "\n  ".join('nwr(area.a)' + f + '["website"];' for f in OSM_FILTERS)

    def ask(area: str) -> List[Dict[str, object]]:
        query = (
            "[out:json][timeout:150];\n"
            + area + "->.a;\n"
            "(\n  " + parts + "\n);\n"
            "out tags center 3000;"
        )
        data = _overpass(query)
        # Overpass answers a timeout with 200 OK, an empty element list and a
        # sentence. Without reading it, a query that was too big for the server
        # is indistinguishable from a city with no employers -- which is what
        # "paris" reported, in lower case, on the first real use of this.
        remark = str(data.get("remark") or "")
        if remark and not data.get("elements"):
            raise RuntimeError("OpenStreetMap could not finish that query: " + remark[:160])
        return list(data.get("elements") or [])

    say("Asking OpenStreetMap for employers in " + city)
    # Case-insensitive from the start: a city is typed the way it is spoken,
    # and OSM holds exactly one capitalisation of it.
    name = 'area["name"~"^' + re.escape(city) + '$",i]'
    elements = ask(name + '["boundary"="administrative"]')
    if not elements:
        # Some places are not administrative boundaries at all -- a district, a
        # quarter, a municipality tagged as a place. Ask again without that.
        elements = ask(name)

    needle = keyword.strip().lower()
    seen: Dict[str, Dict[str, str]] = {}
    for el in elements:
        tags = el.get("tags") or {}
        domain = registrable(tags.get("website") or tags.get("contact:website") or "")
        if not domain or domain in PLATFORM_HOSTS or domain in seen:
            continue
        if any(domain.endswith("." + p) for p in PLATFORM_HOSTS):
            continue
        if needle:
            hay = " ".join(str(v) for v in tags.values()).lower()
            if needle not in hay:
                continue
        seen[domain] = {
            "domain": domain,
            "name": (tags.get("name") or "").strip(),
            "city": (tags.get("addr:city") or city).strip(),
            # An address OSM already holds is an address nobody has to fetch.
            "email": (tags.get("email") or tags.get("contact:email") or "").strip().lower(),
        }
        if len(seen) >= limit:
            break
    plural = "s" if len(seen) != 1 else ""
    say(str(len(seen)) + " employer" + plural + " with a website in " + city)
    return list(seen.values())


def parse_domains(text: str) -> List[Dict[str, str]]:
    """A pasted list: one domain or URL per line, commas and spaces tolerated."""
    out: Dict[str, Dict[str, str]] = {}
    for token in re.split(r"[\s,;]+", text or ""):
        domain = registrable(token)
        if domain and "." in domain and domain not in out:
            out[domain] = {"domain": domain, "name": "", "city": "", "email": ""}
    return list(out.values())


# ---------------------------------------------------------------------------
# The orchestrator
# ---------------------------------------------------------------------------

# Eight at a time against eight different servers, never eight against one:
# each worker takes a whole site, so no single employer ever sees more than one
# request at a time from this program.
WORKERS = 8


def harvest(targets: Iterable[Dict[str, str]],
            on_lead: Optional[Callable[[Dict[str, str]], None]] = None,
            on_event: Optional[Event] = None,
            should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, int]:
    """
    Read a list of company sites and hand back the ones that published an
    address a letter can go to.

    Companies that publish nothing are counted too, because "read, found
    nothing" is a result: it is the list the deep engine should be spent on,
    and without it the same dead sites get read again tomorrow.
    """
    say = on_event or (lambda *a, **k: None)
    targets = [t for t in targets if t.get("domain")]
    total = len(targets)
    tally = {"read": 0, "found": 0, "hiring": 0}
    if not total:
        return tally

    say("Reading " + str(total) + (" companies" if total != 1 else " company"))

    def work(target: Dict[str, str]) -> Optional[Dict[str, str]]:
        if should_stop and should_stop():
            return None
        result = read_site(target["domain"])
        best = str(result.get("best") or "")
        score = int(result.get("best_score") or 0)
        # An address OSM already published is free and already public; the site
        # is still read first, because /karriere beats the switchboard.
        if not best and target.get("email"):
            best, score = target["email"], _score(target["email"], target["domain"])
        if not best:
            return None
        return {
            "company": target.get("name") or str(result.get("name") or "") or target["domain"],
            "website": "https://" + target["domain"],
            "city": target.get("city", ""),
            "email": best,
            # Where it was read. An address without a page behind it is a claim;
            # with one, anybody can check it in a second, including next month
            # when the mailbox has been closed.
            "source_url": "https://" + target["domain"],
            "email_kind": "published",
            "_score": score,
            "_others": [e for e in (result.get("emails") or []) if e != best][:4],
        }

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for lead in pool.map(work, targets):
            tally["read"] += 1
            if should_stop and should_stop():
                break
            if not lead:
                continue
            tally["found"] += 1
            if lead.pop("_score", 0) >= 100:
                tally["hiring"] += 1
            others = lead.pop("_others", [])
            if others:
                lead["notes"] = "Also published: " + ", ".join(others)
            if on_lead:
                on_lead(lead)

    say(
        "Read " + str(tally["read"]) + ": " + str(tally["found"])
        + " published an address, " + str(tally["hiring"]) + " of them a hiring one"
    )
    return tally
