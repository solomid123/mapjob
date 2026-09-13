# -*- coding: utf-8 -*-
"""
Persistent geocoder for MapJob.

ATS boards only publish a free-text location ("Verden, Niedersachsen, Germany",
"Somerville, MA", "Sunnyvale"). Without geocoding those jobs never reach the map.
This module resolves them to real coordinates and caches every answer on disk so
the expensive lookup happens once per distinct location string, ever.

Provider order:
  1. In-process/disk cache               (instant)
  2. Mapbox Geocoding v5                 (fast, parallel-safe, needs a token)
  3. OpenStreetMap Nominatim             (no key, throttled to 1 req/s)
"""

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

import requests

logger = logging.getLogger("geocoder")

CACHE_PATH = Path(__file__).resolve().parent / "geocode_cache.json"

MAPBOX_TOKEN = os.getenv("MAPBOX_TOKEN") or os.getenv("VITE_MAPBOX_TOKEN") or ""

# Feature types Mapbox may return, mapped to how precisely we trust the point.
_PRECISION_BY_TYPE = {
    "address": "exact",
    "poi": "exact",
    "neighborhood": "district",
    "locality": "city",
    "place": "city",
    "district": "region",
    "region": "region",
    "country": "country",
}

_lock = threading.Lock()
_cache = None
_nominatim_lock = threading.Lock()
_nominatim_last_call = 0.0

# Strings that carry no geographic meaning on their own.
_NON_PLACES = {
    "", "remote", "remote - eu", "remote (europe)", "fully remote", "anywhere",
    "worldwide", "global", "multiple locations", "various", "n/a", "tbd",
    "home office", "work from home", "hybrid", "on-site", "onsite", "flexible",
}


def _load_cache():
    global _cache
    if _cache is not None:
        return _cache
    with _lock:
        if _cache is None:
            try:
                if CACHE_PATH.exists():
                    _cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
                else:
                    _cache = {}
            except (OSError, ValueError) as e:
                logger.warning(f"Could not read geocode cache: {e}")
                _cache = {}
    return _cache


def _save_cache() -> None:
    cache = _load_cache()
    try:
        with _lock:
            tmp = CACHE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            tmp.replace(CACHE_PATH)
    except OSError as e:
        logger.warning(f"Could not persist geocode cache: {e}")


_MODIFIER_SEGMENT = re.compile(
    r"^(?:fully\s+|100%\s+|partially\s+)?(?:remote|hybrid|on-?site|in\s?office|"
    r"work\s+from\s+home|home\s+office|flexible|distributed)$",
    re.I,
)


def normalize(location_str: str) -> str:
    """Reduce a raw ATS location string to a single searchable place.

    Work-arrangement words are not places: "Remote, US, Georgia" must resolve to
    Georgia, not to a street in Savannah that the employer never mentioned.
    """
    text = (location_str or "").strip()
    if not text:
        return ""
    # "Boston, MA, USA; New York, NY, USA" -> first listed office only.
    text = re.split(r"\s*[;|]\s*", text)[0]
    text = re.sub(r"\((?:remote|hybrid|on-?site|flexible)[^)]*\)", " ", text, flags=re.I)

    segments = [s.strip() for s in text.split(",")]
    segments = [s for s in segments if s and not _MODIFIER_SEGMENT.match(s)]
    text = ", ".join(segments)

    text = re.sub(r"\b(?:remote|hybrid|on-?site)\s*[-\u2013\u2014:]\s*", " ", text, flags=re.I)
    text = re.sub(r"\s+", " ", text).strip(" ,-\u2013\u2014/")
    return text


def _cache_key(text: str) -> str:
    return text.casefold()


def _query_mapbox(query: str):
    if not MAPBOX_TOKEN:
        return None
    url = (
        "https://api.mapbox.com/geocoding/v5/mapbox.places/"
        f"{requests.utils.quote(query, safe='')}.json"
    )
    params = {
        "access_token": MAPBOX_TOKEN,
        "limit": 1,
        "language": "en",
        # Never invent a pin: only accept a literal match of the place name.
        "fuzzyMatch": "false",
        "types": "address,poi,place,locality,district,region,country",
    }
    try:
        r = requests.get(url, params=params, timeout=8)
        if r.status_code == 429:  # Burst limit: back off once before giving up.
            time.sleep(1.5)
            r = requests.get(url, params=params, timeout=8)
        if r.status_code != 200:
            logger.debug(f"Mapbox geocode {r.status_code} for {query!r}")
            return None
        features = r.json().get("features") or []
        if not features:
            return None
        f = features[0]
        # Low-confidence hits are guesses; an unplaced job is better than a wrong pin.
        if float(f.get("relevance", 0)) < 0.8:
            logger.debug(f"Mapbox relevance too low for {query!r}: {f.get('relevance')}")
            return None
        lng, lat = f["center"][0], f["center"][1]
        ftype = next((t for t in f.get("place_type", []) if t in _PRECISION_BY_TYPE), "place")
        country = ""
        city = ""
        for ctx in [f] + list(f.get("context") or []):
            cid = ctx.get("id", "")
            if cid.startswith("country") and not country:
                country = (ctx.get("short_code") or "").upper()
            if cid.startswith(("place", "locality")) and not city:
                city = (ctx.get("text") or "").casefold()
        return {
            "lat": round(float(lat), 6),
            "lng": round(float(lng), 6),
            "locationPrecision": _PRECISION_BY_TYPE.get(ftype, "city"),
            "country": country or None,
            "city": city,
            "source": "mapbox",
        }
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as e:
        logger.debug(f"Mapbox geocode failed for {query!r}: {e}")
        return None


def _query_nominatim(query: str):
    global _nominatim_last_call
    try:
        with _nominatim_lock:  # Nominatim allows at most one request per second.
            wait = 1.05 - (time.time() - _nominatim_last_call)
            if wait > 0:
                time.sleep(wait)
            _nominatim_last_call = time.time()
            r = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 1, "addressdetails": 1},
                headers={"User-Agent": "MapJob/1.0 (job map geocoding)"},
                timeout=10,
            )
        if r.status_code != 200:
            return None
        results = r.json()
        if not results:
            return None
        top = results[0]
        addr = top.get("address") or {}
        kind = top.get("addresstype") or top.get("type") or "city"
        precision = {
            "house": "exact", "building": "exact", "road": "exact",
            "city": "city", "town": "city", "village": "city", "municipality": "city",
            "state": "region", "province": "region", "country": "country",
        }.get(kind, "city")
        return {
            "lat": round(float(top["lat"]), 6),
            "lng": round(float(top["lon"]), 6),
            "locationPrecision": precision,
            "country": (addr.get("country_code") or "").upper() or None,
            "city": (addr.get("city") or addr.get("town") or addr.get("village") or "").casefold(),
            "source": "nominatim",
        }
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        logger.debug(f"Nominatim geocode failed for {query!r}: {e}")
        return None


def _resolve(query: str):
    return _query_mapbox(query) or _query_nominatim(query)


def lookup_cached(location_str: str):
    """Return a previously resolved location without ever touching the network."""
    query = normalize(location_str)
    if not query or query.casefold() in _NON_PLACES:
        return None
    entry = _load_cache().get(_cache_key(query))
    if entry and entry.get("lat") is not None:
        return dict(entry)
    return None


def geocode(location_str: str, allow_network: bool = True):
    """Resolve a free-text location to coordinates, caching the result on disk."""
    query = normalize(location_str)
    if not query or query.casefold() in _NON_PLACES:
        return None

    key = _cache_key(query)
    cache = _load_cache()
    if key in cache:
        entry = cache[key]
        return dict(entry) if entry.get("lat") is not None else None

    if not allow_network:
        return None

    result = _resolve(query)
    cache[key] = result if result else {"lat": None, "lng": None}
    _save_cache()
    return dict(result) if result else None


def pending_locations(location_strings):
    """Locations that have never been looked up (cache misses are remembered)."""
    cache = _load_cache()
    out = []
    seen = set()
    for raw in location_strings:
        q = normalize(raw)
        if not q or q.casefold() in _NON_PLACES:
            continue
        k = _cache_key(q)
        if k in cache or k in seen:
            continue
        seen.add(k)
        out.append(q)
    return out


def geocode_many(location_strings, max_workers: int = 4) -> int:
    """Warm the cache for many locations in parallel. Returns how many resolved."""
    from concurrent.futures import ThreadPoolExecutor

    cache = _load_cache()
    pending = pending_locations(location_strings)
    if not pending:
        return 0

    logger.info(f"Geocoding {len(pending)} new locations...")
    resolved = 0
    # Mapbox tolerates parallel requests; Nominatim self-throttles behind its lock.
    workers = max_workers if MAPBOX_TOKEN else 2
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for query, result in zip(pending, pool.map(_resolve, pending)):
            cache[_cache_key(query)] = result if result else {"lat": None, "lng": None}
            if result:
                resolved += 1
    _save_cache()
    logger.info(f"Geocoded {resolved}/{len(pending)} new locations.")
    return resolved


# ---------------------------------------------------------------------------
# Reverse: coordinates -> the name of the town they are in.
#
# Adzuna has no coordinate search. It searches by place name plus a radius, so
# a map viewport can only be turned into a query by first asking what place is
# in the middle of it. Without this the map could only ever fetch a whole
# country's listings and throw away the ones outside the screen, which is what
# used to empty the map on the way in: at street zoom the national feed had
# nine listings anywhere near the viewport, so nine is what the map showed.
#
# Answers are cached at two decimal places, roughly a 1km square. Anything
# finer would be cache misses for no gain -- the answer wanted here is "which
# town", and that does not change across a street.
# ---------------------------------------------------------------------------


def _split_bilingual(value) -> list:
    """A bilingual place label as the separate names it is made of.

    Officially bilingual areas come back from OSM joined with a hyphen:
    "Brussel-Hoofdstad - Bruxelles-Capitale". No job board indexes that string,
    but both halves are ordinary place names that they do index -- searching
    Adzuna for the joined form returns nothing and for "Brussel-Hoofdstad"
    returns seventy-six jobs.
    """
    text = (value or "").strip()
    if not text:
        return []
    parts = [p.strip() for p in re.split(r"\s+[-/]\s+", text) if p.strip()]
    # The joined form first: where it is a real name, it is the most precise one.
    return [text] + [p for p in parts if p != text] if len(parts) > 1 else [text]


def _reverse_mapbox(lat: float, lng: float) -> Optional[Dict[str, str]]:
    if not MAPBOX_TOKEN:
        return None
    try:
        r = requests.get(
            f"https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json",
            params={
                "access_token": MAPBOX_TOKEN,
                "limit": 1,
                "language": "en",
                # A town, and specifically not "locality", which is Mapbox's
                # type for a neighbourhood: the middle of a view of Eindhoven
                # comes back as "Meerhoven", a district no job board has ever
                # heard of, and Adzuna answers an unknown place with silence
                # rather than an error. "place" is the city/town level.
                "types": "place",
            },
            timeout=6,
        )
        if r.status_code != 200:
            return None
        features = r.json().get("features") or []
        if not features:
            return None
        name = (features[0].get("text") or "").strip()
        if not name:
            return None
        country = ""
        for ctx in features[0].get("context") or []:
            if str(ctx.get("id", "")).startswith("country"):
                country = (ctx.get("short_code") or "").lower()
                break
        return {"place": name, "places": [name], "country": country}
    except (requests.RequestException, ValueError, KeyError, IndexError, TypeError) as e:
        logger.debug(f"Mapbox reverse failed for {lat},{lng}: {e}")
        return None


def _reverse_nominatim(lat: float, lng: float) -> Optional[Dict[str, str]]:
    global _nominatim_last_call
    try:
        with _nominatim_lock:  # Nominatim allows at most one request per second.
            wait = 1.05 - (time.time() - _nominatim_last_call)
            if wait > 0:
                time.sleep(wait)
            _nominatim_last_call = time.time()
            r = requests.get(
                "https://nominatim.openstreetmap.org/reverse",
                # zoom 10 is Nominatim's city/town level -- the granularity a
                # job board's location filter works at.
                #
                # No accept-language, deliberately. This name is never shown to
                # anyone; it is a query token for a national job board, and those
                # index the local name. Asking in English turns Wien into
                # "Vienna" and Koeln into "Cologne", which the Austrian and
                # German markets do not match.
                params={"lat": lat, "lon": lng, "format": "json", "zoom": 10},
                headers={"User-Agent": "MapJob/1.0 (job map geocoding)"},
                timeout=8,
            )
        if r.status_code != 200:
            return None
        payload = r.json() or {}
        addr = payload.get("address") or {}
        country = (addr.get("country_code") or "").lower()
        names = []
        for field in ("city", "town", "village", "municipality", "county", "state"):
            for name in _split_bilingual(addr.get(field)):
                if name not in names:
                    names.append(name)
        if not names:
            return None
        return {"place": names[0], "places": names, "country": country}
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        logger.debug(f"Nominatim reverse failed for {lat},{lng}: {e}")
        return None


def reverse_place(lat: float, lng: float, allow_network: bool = True):
    """Where these coordinates are, as {'place', 'places', 'country'}.

    `places` is every name for this spot from finest to coarsest -- the commune,
    then the county, then the region -- because which one a job board files
    vacancies under varies by country. Eindhoven answers to "Eindhoven", while
    the same query in the middle of Brussels lands on a commune of 27,000 people
    and it is the county name that finds the city's jobs. One lookup, several
    names to try; the caller keeps whichever returns the most.

    The country matters as much as the name. Adzuna is one API per market, and
    searching for "Eindhoven" in the German market returns nothing at all -- so
    a viewport near a border used to spend half its request budget on a country
    that could not contain the place being searched for.
    """
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None

    key = "rev:%.2f,%.2f" % (lat, lng)
    cache = _load_cache()
    if key in cache:
        # A cached miss is still an answer: the sea has no town in it, and
        # asking again every time the user drags over it costs a second each.
        hit = cache[key] or {}
        return dict(hit) if hit.get("place") else None
    if not allow_network:
        return None

    # Nominatim first, which is the opposite order to the forward lookup above.
    # Mapbox's finest administrative type is the commune, so the middle of a
    # view of Brussels comes back as "Saint-Josse-ten-Noode" -- a real place, and
    # not one any job board files vacancies under. Nominatim's zoom=10 answers
    # the question actually being asked: which town is this.
    found = _reverse_nominatim(lat, lng) or _reverse_mapbox(lat, lng)
    cache[key] = found or {"place": None}
    _save_cache()
    return dict(found) if found else None
