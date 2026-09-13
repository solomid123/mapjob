# -*- coding: utf-8 -*-
"""Adzuna as a source of map pins.

The verified-ATS boards give exact, apply-ready jobs, but only from companies
whose board is on a hardcoded list. Adzuna carries tens of thousands of French
postings alone -- 63,000 for "ingenieur" on the day this was written -- from
employers that will never appear on that list.

Two things are deliberately conservative here, because both have already gone
wrong in this codebase once:

  * Coordinates are marked `city`, never `exact`. Adzuna geocodes to a town or
    an arrondissement centroid, not a street. A pin that claims to be exact and
    is 4km off is worse than one that admits it is approximate, because the
    candidate plans a commute around it.

  * A salary is carried over only when Adzuna says the employer published it.
    Adzuna also predicts salaries and flags them salary_is_predicted == "1".
    Those are model output, not an offer. This app already had to tear out one
    system that invented pay figures and then sorted the "60k+" filter by them;
    letting a prediction back in through a different door would recreate it.

Every listing is a redirect through Adzuna's own tracker, so applyUrl is not
the employer's page. Resolving that is the job of adzuna_resolver.
"""

from __future__ import annotations

import html
import logging
import math
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

import requests

from .config import ADZUNA_APP_ID, ADZUNA_APP_KEY

logger = logging.getLogger(__name__)

API = "https://api.adzuna.com/v1/api/jobs/{country}/search/{page}"

# Adzuna is per-country. These are the markets this app shows on the map; each
# is one HTTP call per page, run in parallel.
COUNTRIES = ("fr", "de", "nl", "es", "it", "gb")

# Which country a search should hit, when the candidate names a city.
CITY_COUNTRY = {
    "fr": ("paris", "lyon", "marseille", "toulouse", "lille", "bordeaux", "nantes",
           "nice", "strasbourg", "amiens", "rennes", "grenoble", "montpellier", "france"),
    "de": ("berlin", "munich", "hamburg", "frankfurt", "cologne", "stuttgart",
           "dusseldorf", "germany", "deutschland"),
    "nl": ("amsterdam", "rotterdam", "the hague", "den haag", "utrecht", "eindhoven",
           "netherlands", "holland"),
    "es": ("madrid", "barcelona", "valencia", "seville", "sevilla", "bilbao", "spain"),
    "it": ("rome", "roma", "milan", "milano", "turin", "torino", "naples", "italy"),
    "gb": ("london", "manchester", "birmingham", "edinburgh", "glasgow", "bristol",
           "leeds", "uk", "united kingdom", "england", "scotland"),
}

# Roughly where each market is, so a map viewport can be answered by the one or
# two countries it actually overlaps instead of all of them. Deliberately
# generous: including a country that turns out to have nothing in view costs one
# HTTP call, while excluding one that did leaves a hole in the map with nothing
# to explain it.
#
# This is wider than COUNTRIES above, and that is the point. A viewport search
# names the town at its centre and asks the single market that town is in, so a
# market listed here costs nothing until someone actually looks at it. Belgium,
# Austria, Switzerland and Poland used to be blank on this map purely because
# they were not in the fan-out; now they are only blank if Adzuna has nothing.
COUNTRY_BOUNDS = {
    "fr": (-5.2, 41.3, 9.6, 51.1),
    "de": (5.8, 47.2, 15.1, 55.1),
    "nl": (3.3, 50.7, 7.3, 53.7),
    "es": (-9.4, 35.9, 4.4, 43.8),
    "it": (6.6, 35.4, 18.6, 47.1),
    "gb": (-8.7, 49.8, 1.8, 60.9),
    "be": (2.5, 49.4, 6.5, 51.6),
    "at": (9.4, 46.3, 17.2, 49.1),
    "ch": (5.9, 45.8, 10.6, 47.9),
    "pl": (14.1, 48.9, 24.2, 55.0),
}

# Every market this app can query at all. A place that reverse-geocodes to
# somewhere outside this set cannot be searched for: asking the German market
# for "Luxembourg" does not fail, it returns 282 German listings that are all
# somewhere else, which is worse than admitting there is nothing.
MARKETS = frozenset(COUNTRY_BOUNDS)

RESULTS_PER_PAGE = 50
PAGES = 2

# What one search is allowed to cost, in HTTP calls, however many countries it
# covers. Depth is then whatever that budget buys: six countries get two pages
# each, one country gets twelve. Holding the *cost* fixed rather than the page
# count is what makes a narrowed search complete instead of merely quick -- the
# map for a single city returns 600 listings for the same wait as 100.
PAGE_BUDGET = 12
MIN_PAGES = 2
TIMEOUT_S = 12
CACHE_TTL_S = 300

# Adzuna refuses calls rather than slowing them down, and a refused call used to
# mean a hole in the map with nothing in the response to say so.
#
# Two things were wrong. The retry only covered 429, but what Adzuna actually
# returns under load is 503 -- measured: a six-country fan-out lost 5 of 12 calls
# to 503 and quietly returned 253 jobs instead of 474. And the concurrency was
# throttled to 3 to dodge that, which did not help (the 503s happened anyway) and
# tripled the wait.
#
# So: retry anything transient, and stop paying for a limit that was not the
# problem. Retrying 5xx at six-way concurrency measured 474 jobs in 13.5s where
# three-way managed 253 in 24.2s -- nearly twice the jobs in half the time.
MAX_PARALLEL = 6
RETRY_BACKOFF_S = (0.6, 1.6)
# Transient by definition: worth asking again. A 400 or a 401 is not.
RETRY_STATUSES = (429, 500, 502, 503, 504)

_cache: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()
# Cache keys whose deeper pages are being fetched right now, so two map moves a
# second apart do not start the same twelve calls twice.
_filling: set = set()

# Every job this process has seen, by id. The search response is slimmed down,
# so opening a job needs somewhere to read the full record back from; without
# this, /api/jobs/detail 404s on every Adzuna listing because that endpoint only
# ever looked in the ATS cache.
_by_id: Dict[str, Dict[str, Any]] = {}


def available() -> bool:
    return bool(ADZUNA_APP_ID and ADZUNA_APP_KEY)


def get_cached_job(job_id: str) -> Optional[Dict[str, Any]]:
    """The full record for a job this process has already fetched."""
    return _by_id.get(str(job_id))


def countries_for_bbox(bbox: str) -> tuple:
    """The markets a 'west,south,east,north' viewport overlaps."""
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except (ValueError, AttributeError):
        return COUNTRIES
    hits = tuple(
        code
        for code, (cw, cs, ce, cn) in COUNTRY_BOUNDS.items()
        if west <= ce and east >= cw and south <= cn and north >= cs
    )
    return hits or COUNTRIES


# A viewport wider than this is not "a place" any more, so naming its centre
# and searching around it would be arbitrary: the middle of a view of western
# Europe is a field in Belgium. Above it, the national feeds are the honest
# answer; below it, the radius search is far denser.
MAX_ANCHOR_RADIUS_KM = 120
# Adzuna's own default radius is 5km. Going under it buys nothing -- every
# listing in a town shares that town's centroid regardless -- and it costs the
# neighbouring towns that are genuinely on screen.
MIN_ANCHOR_RADIUS_KM = 8


def bbox_center_radius(bbox: str) -> Optional[Tuple[float, float, int]]:
    """A viewport as (lat, lng, radius_km), or None if it is too big to name.

    The radius covers the corners, not the edges, so nothing on screen falls
    outside the circle that gets searched.
    """
    try:
        west, south, east, north = (float(v) for v in bbox.split(","))
    except (ValueError, AttributeError):
        return None
    lat = (south + north) / 2.0
    lng = (west + east) / 2.0
    half_ns = (north - south) / 2.0 * 111.0
    half_ew = (east - west) / 2.0 * 111.0 * max(0.05, math.cos(math.radians(lat)))
    radius = math.hypot(half_ns, half_ew)
    if radius > MAX_ANCHOR_RADIUS_KM:
        return None
    return lat, lng, max(MIN_ANCHOR_RADIUS_KM, int(math.ceil(radius)))


def _countries_for(city: str) -> tuple:
    """Narrow the fan-out when the candidate named somewhere specific."""
    needle = (city or "").casefold().strip()
    if not needle or needle in ("all", "any", "europe", "eu"):
        return COUNTRIES
    for code, names in CITY_COUNTRY.items():
        if any(name in needle or needle in name for name in names):
            return (code,)
    return COUNTRIES


def _fetch_page(
    country: str, page: int, keywords: str, city: str, distance_km: Optional[int] = None
) -> List[Dict[str, Any]]:
    params = {
        "app_id": ADZUNA_APP_ID,
        "app_key": ADZUNA_APP_KEY,
        "results_per_page": RESULTS_PER_PAGE,
        "content-type": "application/json",
    }
    if keywords:
        params["what"] = keywords
    if city and city.casefold() not in ("all", "any", "europe", "eu"):
        params["where"] = city
        # Only meaningful alongside a place. Adzuna's own default is 5km, which
        # is smaller than most of the cities this app shows.
        if distance_km:
            params["distance"] = int(distance_km)
    url = API.format(country=country, page=page)
    last = ""
    for attempt in range(len(RETRY_BACKOFF_S) + 1):
        try:
            response = requests.get(url, params=params, timeout=TIMEOUT_S)
            if response.status_code == 200:
                return response.json().get("results") or []
            last = "HTTP %s" % response.status_code
            if response.status_code not in RETRY_STATUSES:
                break
        except requests.RequestException as exc:
            # A read timeout is the same kind of event as a 503 here, and it
            # showed up in the same measurement. Retry it on the same terms.
            last = str(exc)
        if attempt < len(RETRY_BACKOFF_S):
            time.sleep(RETRY_BACKOFF_S[attempt])

    logger.warning("Adzuna %s p%s gave up: %s", country, page, last)
    return []


def _clean(text: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(str(text)))).strip()


def _remote_type(title: str, location: str) -> str:
    blob = ("%s %s" % (title, location)).lower()
    if "remote" in blob or "teletravail" in blob:
        return "Remote"
    if "hybrid" in blob or "hybride" in blob:
        return "Hybrid"
    return "On-site"


def _to_job(raw: Dict[str, Any], country: str) -> Optional[Dict[str, Any]]:
    """One Adzuna result as the shape the map and the job cards expect."""
    jid = str(raw.get("id") or "").strip()
    title = _clean(raw.get("title") or "")
    if not jid or not title:
        return None

    lat, lng = raw.get("latitude"), raw.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        # No coordinates means no pin, and this feed exists to put pins on a map.
        return None

    location_obj = raw.get("location") or {}
    area = location_obj.get("area") or []
    display = location_obj.get("display_name") or ""
    # Adzuna's area runs coarse-to-fine: ["France", "Ile-de-France", "Paris"].
    city_name = area[-1] if area else (display.split(",")[0] if display else "")

    company = _clean((raw.get("company") or {}).get("display_name") or "") or "Employer"

    job = {
        "id": "adzuna-%s-%s" % (country, jid),
        "jobId": jid,
        "title": title,
        "company": company,
        "companyLogo": "https://avatar.vercel.sh/%s.svg" % company,
        "category": (raw.get("category") or {}).get("label") or "Engineering",
        "location": display or city_name,
        "city": city_name,
        "lat": float(lat),
        "lng": float(lng),
        "country": country.upper(),
        # Said plainly. Adzuna geocodes to a town centroid, and the card renders
        # this differently from an address the employer actually published.
        "locationPrecision": "city",
        "description": _clean(raw.get("description") or ""),
        # Adzuna's tracker, not the employer. The apply engine resolves it.
        "applyUrl": raw.get("redirect_url") or "",
        "atsProvider": "Adzuna",
        "atsBoard": "adzuna",
        "source": "adzuna",
        # Not a direct employer ATS. The apply engine can still drive it, and
        # the card still offers "Auto apply" -- but the "Auto-apply ready"
        # filter promises a verified employer form at the other end, and this
        # is a tracking redirect that may land on an APEC login wall instead.
        # Claiming otherwise would make that filter lie.
        "isDirectApply": False,
        "canApplyViaApi": False,
        "needsRedirectResolution": True,
        "postedAt": raw.get("created") or "",
        "jobType": {"full_time": "Full-time", "part_time": "Part-time"}.get(
            raw.get("contract_time") or "", "Full-time"
        ),
        "remoteType": _remote_type(title, display),
        "images": [],
        "salaryDisplay": "",
        "salaryBadge": "",
    }

    # Only a figure the employer stated. salary_is_predicted == "1" is Adzuna's
    # own estimate and is dropped rather than shown to a candidate as an offer.
    if str(raw.get("salary_is_predicted", "0")) != "1":
        low = _annual_salary(raw.get("salary_min"))
        high = _annual_salary(raw.get("salary_max"))
        if low:
            job["salaryMin"] = low
        if high:
            job["salaryMax"] = high

    return job


# Below this, a figure is not a yearly salary. It is measured: of 140 Adzuna
# listings carrying pay, 88 were in some other unit -- "14" for a UK delivery
# driver is an hourly rate, "1628" for a French engineer is a month. Nothing in
# the response says which, and there is no field that does.
#
# 15,000 separates them cleanly and safely in both directions. No full-time
# European job pays that little per year (the French annual minimum is around
# 21,000), and no monthly or hourly rate reaches it -- a monthly figure would
# have to be 15,000 EUR/month to slip through.
#
# Everything below is dropped, not converted. Multiplying 1628 by 12 assumes
# the unit; it might be a weekly rate, or a daily contractor rate. The card
# already renders an absent salary honestly as nothing, and nothing beats a
# confident wrong number the candidate filters and negotiates against.
MIN_PLAUSIBLE_ANNUAL = 15000


def _annual_salary(value: Any) -> Optional[int]:
    """A yearly figure, or None when the unit cannot be established."""
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    return int(value) if value >= MIN_PLAUSIBLE_ANNUAL else None


def _fetch_pages(
    countries: tuple,
    page_numbers: range,
    keywords: str,
    city: str,
    on_batch: Optional[Any] = None,
    distance_km: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Every country/page pair in one bounded fan-out.

    `on_batch` is handed each page as it lands, so a long fill can publish its
    results as it goes instead of all at once at the end.
    """
    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        futures = {
            pool.submit(_fetch_page, country, page, keywords, city, distance_km): country
            for country in countries
            for page in page_numbers
        }
        for future in as_completed(futures):
            try:
                batch = [job for job in (_to_job(raw, futures[future]) for raw in future.result()) if job]
            except Exception as exc:  # noqa: BLE001
                logger.warning("Adzuna %s: %s", futures[future], exc)
                continue
            results.extend(batch)
            if on_batch and batch:
                on_batch(batch)
    return results


def _first_wave(countries: tuple, pages: int) -> int:
    """How many pages per country the opening request should ask for.

    Exactly enough to fill one parallel wave and no more, whatever the fan-out:
    six countries get one page each, one country gets six. Either way that is a
    single round trip -- about three and a half seconds and roughly 300 listings
    -- so the map paints at the same speed whether you are looking at Paris or
    at the whole continent.
    """
    return max(1, min(pages, MAX_PARALLEL // max(1, len(countries))))


def _merge(key: str, jobs: List[Dict[str, Any]], complete: bool) -> List[Dict[str, Any]]:
    """Fold a batch into the cache entry, keeping it deduplicated."""
    with _lock:
        entry = _cache.get(key)
        if not entry:
            entry = {"at": time.time(), "jobs": [], "ids": set(), "complete": False}
            _cache[key] = entry
        for job in jobs:
            if job["id"] in entry["ids"]:
                continue
            entry["ids"].add(job["id"])
            entry["jobs"].append(job)
            _by_id[job["id"]] = job
        entry["at"] = time.time()
        entry["complete"] = entry["complete"] or complete
        return list(entry["jobs"])


def _fill_deeper(
    key: str,
    countries: tuple,
    first: int,
    pages: int,
    keywords: str,
    city: str,
    distance_km: Optional[int] = None,
) -> None:
    try:
        _fetch_pages(
            countries,
            range(first + 1, pages + 1),
            keywords,
            city,
            on_batch=lambda batch: _merge(key, batch, complete=False),
            distance_km=distance_km,
        )
        _merge(key, [], complete=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Adzuna background fill failed: %s", exc)
    finally:
        with _lock:
            _filling.discard(key)


def fetch_adzuna_feed(
    keywords: str = "",
    city: str = "",
    countries: Optional[tuple] = None,
    pages: Optional[int] = None,
    distance_km: Optional[int] = None,
) -> Tuple[List[Dict[str, Any]], bool]:
    """Adzuna listings for this search, and whether that set is the full one.

    `countries` overrides the fan-out, which is how a map viewport asks only for
    the markets it can actually see. `pages` overrides the depth, which defaults
    to whatever a fixed call budget buys across that fan-out. `distance_km` is
    the radius around `city`, and is what lets a viewport be asked for directly
    rather than approximated by a national feed that is then thrown away.

    Depth is fetched in two phases, and that is the whole reason the map feels
    quick. Adzuna answers a single call in about 3.5 seconds no matter what, so
    twelve of them is eight seconds of staring at an empty map before the first
    pin lands -- and the pins that matter are all in the first page of each
    country, because Adzuna returns them in relevance order. So page one comes
    back straight away and the rest is filled in behind it, into the same cache
    entry. First paint costs one round trip; the depth arrives while the user is
    still reading what is already on screen.

    The bool is False when only the first phase has landed, so the caller can
    come back for the rest instead of assuming this is everything there is.
    """
    if not available():
        return [], True

    countries = tuple(countries) if countries else _countries_for(city)
    if pages is None:
        pages = max(MIN_PAGES, PAGE_BUDGET // max(1, len(countries)))

    key = "%s|%s|%s|%s|%s" % (
        keywords.casefold().strip(),
        city.casefold().strip(),
        ",".join(countries),
        pages,
        distance_km or 0,
    )

    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit["at"] >= CACHE_TTL_S:
            hit = None
            _cache.pop(key, None)
        if hit:
            # Either it is finished, or a fill is already running and the right
            # thing to do is serve what has landed rather than start it again.
            return list(hit["jobs"]), bool(hit["complete"])
        already_filling = key in _filling

    first = _first_wave(countries, pages)
    jobs = _merge(
        key,
        _fetch_pages(countries, range(1, first + 1), keywords, city, distance_km=distance_km),
        complete=(first >= pages),
    )

    if pages > first and not already_filling:
        with _lock:
            _filling.add(key)
        threading.Thread(
            target=_fill_deeper,
            args=(key, countries, first, pages, keywords, city, distance_km),
            daemon=True,
        ).start()
        return jobs, False

    return jobs, first >= pages


def fetch_adzuna_jobs(
    keywords: str = "",
    city: str = "",
    countries: Optional[tuple] = None,
    pages: Optional[int] = None,
    distance_km: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Just the listings. See `fetch_adzuna_feed` for what "just" is hiding."""
    return fetch_adzuna_feed(keywords, city, countries, pages, distance_km)[0]


# ---------------------------------------------------------------------------
# Redirect resolution
#
# An Adzuna apply link never points at an employer. It points at Adzuna's click
# tracker, which bounces to another tracker, which bounces to the real portal.
# Measured across fourteen French engineering listings, the chain ended at:
#
#     careers.soprasteria.fr    6     an employer's own ATS
#     r.holeest.com             6     HelloWork's tracker -- a SECOND hop
#     seiza.typeform.com        1
#     nostalentsnos...fr        1
#
# So one hop is not enough, and the last hop is often JavaScript rather than an
# HTTP 302, which is why the browser resolves this rather than `requests`.
# ---------------------------------------------------------------------------

# Hosts that are a step on the way somewhere, never a destination.
TRACKER_HOSTS = (
    "adzuna.", "r.holeest.com", "holeest.com", "click.appcast", "appcast.io",
    "jobrapido.", "trkkn.", "doubleclick.net", "go.jobs", "trk.",
)

# Portals that will not show an application form to a signed-out visitor.
# Naming them is the difference between "log in to APEC once and this works
# from now on" and a generic "no form found" that tells the candidate nothing.
LOGIN_REQUIRED_PORTALS = {
    "apec.fr": "APEC",
    "linkedin.com": "LinkedIn",
    "meteojob.com": "Meteojob",
    "hellowork.com": "HelloWork",
    "indeed.com": "Indeed",
    "monster.fr": "Monster",
}


def is_tracker(url: str) -> bool:
    return any(host in (url or "").lower() for host in TRACKER_HOSTS)


def portal_needing_login(url: str) -> Optional[str]:
    """The human name of the portal, when it is one that demands an account."""
    low = (url or "").lower()
    for host, name in LOGIN_REQUIRED_PORTALS.items():
        if host in low:
            return name
    return None
