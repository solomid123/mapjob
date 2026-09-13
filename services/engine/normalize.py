# -*- coding: utf-8 -*-
"""One shape for a job, whatever it came from, and a rule for when two of them
are the same job.

Every source describes a posting differently: Greenhouse nests the location in
an object, Adzuna hands back a redirect URL, a career page gives you HTML. The
rest of the engine should never have to care. Everything entering the database
goes through normalize_job first and comes out as a CanonicalJob.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

# ---------------------------------------------------------------------------
# Text folding
# ---------------------------------------------------------------------------

def _fold(text: str) -> str:
    """Lowercase, strip accents, collapse whitespace.

    Saint-Etienne with an accent and saint etienne without one are the same
    place, and a dedupe key that disagrees with that lets the job through twice.
    """
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", stripped).strip().lower()


# Legal forms carry no identity: "Alstom" and "Alstom S.A." are one employer.
# Trailing-only, so a company genuinely called "SAS Institute" survives intact.
_LEGAL_FORMS = (
    "sa", "s a", "sas", "sasu", "sarl", "eurl", "sca", "snc",
    "gmbh", "mbh", "ag", "kg", "kgaa", "ug", "se",
    "bv", "b v", "nv", "n v", "vof", "cv",
    "ltd", "limited", "plc", "llp", "inc", "incorporated", "llc", "corp",
    "corporation", "co", "company", "spa", "srl", "ab", "as", "asa", "oy",
    "oyj", "aps", "doo", "kft", "pte",
)
_LEGAL_RE = re.compile(
    r"[\s,\.\-]+(?:" + "|".join(re.escape(f) for f in _LEGAL_FORMS) + r")$"
)
_APOSTROPHES = "[.’'ʼ]"


def normalize_company(name: str) -> str:
    """Fold a company name down to something stable enough to match on."""
    folded = _fold(name)
    folded = re.sub(_APOSTROPHES, "", folded)
    folded = re.sub(r"[^a-z0-9&\- ]+", " ", folded)
    folded = re.sub(r"\s+", " ", folded).strip()
    # Repeat: tails like "Foo Holding B.V. SA" come off one at a time.
    for _ in range(3):
        shorter = _LEGAL_RE.sub("", folded)
        if shorter == folded:
            break
        folded = shorter
    return folded.strip(" -&")


# Gender markers are legally required boilerplate in French and German posts
# and say nothing about the role. The same job syndicated to two boards
# routinely differs only by "(H/F)" versus "(F/H)".
_GENDER_MARKER = re.compile(
    r"[\(\[]?\s*\b[hfmwd](?:\s*/\s*[hfmwdx]){1,2}\b\s*[\)\]]?", re.I
)
# Trailing requisition references: "(REF-2024-118)", "#JR00918", "- 12345".
_REQ_REF = re.compile(
    r"[\(\[\-#]\s*(?:ref|req|job\s*id|jr)?[\s:\.\-]*[a-z]{0,3}\d{2,}(?:[\-/]\d+)*\s*[\)\]]?\s*$",
    re.I,
)

# Contract boilerplate that gets appended after a dash by some boards.
_SUFFIX_HINTS = (
    "cdi", "cdd", "full time", "part time", "permanent", "internship",
    "stage", "alternance", "apprenticeship", "freelance", "contract",
)


def _tail_is_boilerplate(folded_title: str) -> bool:
    """True when the text after a dash is contract boilerplate, not the role.

    Splitting on every dash would truncate real titles such as
    "Engineer - Rolling Stock", so the tail has to look like boilerplate first.
    """
    parts = re.split(r"\s+[\-\u2013\u2014|/]\s+", folded_title)
    if len(parts) < 2:
        return False
    return any(hint in parts[-1] for hint in _SUFFIX_HINTS)


def normalize_title(title: str) -> str:
    """Fold a job title, dropping syndication noise but never seniority.

    "Senior Mechanical Engineer" and "Mechanical Engineer" are different jobs
    and must not collapse into one, so no seniority word is removed here.
    """
    folded = _fold(title)
    folded = _GENDER_MARKER.sub(" ", folded)
    folded = _REQ_REF.sub(" ", folded)
    if _tail_is_boilerplate(folded):
        folded = re.split(r"\s+[\-\u2013\u2014|/]\s+", folded)[0]
    folded = re.sub(r"[^a-z0-9+#/ ]+", " ", folded)
    return re.sub(r"\s+", " ", folded).strip()


_REMOTE_WORDS = ("remote", "teletravail", "telework", "work from home", "anywhere")


def normalize_location(raw: str, city: Optional[str] = None) -> str:
    """Fold a location to a single comparable token.

    Prefers a city the source already parsed, because "Paris, Ile-de-France,
    France" and "Paris (75)" should both reduce to paris.
    """
    if city:
        folded = _fold(city)
        if folded:
            return re.sub(r"[^a-z0-9 \-]+", "", folded).strip()
    folded = _fold(raw)
    if not folded:
        return ""
    if any(word in folded for word in _REMOTE_WORDS):
        return "remote"
    # Take the leading segment: the city, before region and country.
    head = re.split(r"[,;/|]", folded)[0]
    head = re.sub(r"\(.*?\)", " ", head)        # "paris (75)"
    head = re.sub(r"\b\d{4,6}\b", " ", head)    # bare postal codes
    head = re.sub(r"[^a-z0-9 \-]+", " ", head)
    return re.sub(r"\s+", " ", head).strip()


# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------

# Campaign and referrer parameters differ per aggregator for the identical
# posting, so they must never reach the identity key.
_TRACKING_PREFIXES = ("utm_", "pk_", "mtm_", "hsa_", "gh_")
_TRACKING_KEYS = {
    "source", "src", "ref", "referrer", "referer", "campaign", "medium",
    "gclid", "fbclid", "msclkid", "trk", "trkinfo", "recommended",
    "origin", "from", "utm", "mc_cid", "mc_eid",
}


def canonical_url(url: str) -> str:
    """Strip a posting URL down to the part that identifies the posting.

    Lowercased host without www., no fragment, no tracking parameters, no
    trailing slash. Remaining query parameters are kept and sorted, because on
    plenty of ATS portals the job id lives in the query string.
    """
    if not url:
        return ""
    raw = str(url).strip()
    if not raw:
        return ""
    if "//" not in raw:
        raw = "https://" + raw.lstrip("/")
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.lower()

    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    try:
        port = parts.port
    except ValueError:
        port = None
    if port and port not in (80, 443):
        host = "%s:%d" % (host, port)

    kept = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=False)
        if k.lower() not in _TRACKING_KEYS
        and not any(k.lower().startswith(p) for p in _TRACKING_PREFIXES)
    ]
    query = urlencode(sorted(kept))

    path = re.sub(r"/+$", "", parts.path) or "/"
    scheme = "https" if parts.scheme in ("", "http", "https") else parts.scheme
    return urlunsplit((scheme, host, path, query, ""))


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

def _sha1(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()


def identity_key(company: str, title: str, location: str) -> str:
    """The key that says: this is the same opening."""
    return _sha1(
        normalize_company(company),
        normalize_title(title),
        normalize_location(location),
    )


def url_key(url: str) -> str:
    """The key that says: this is literally the same page."""
    canon = canonical_url(url)
    return _sha1(canon) if canon else ""


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------

@dataclass
class CanonicalJob:
    """A posting in the one shape the rest of the engine understands."""

    source: str                       # greenhouse | adzuna | jooble | career_page
    source_id: str                    # id within that source
    title: str
    company: str
    canonical_url: str = ""
    apply_url: str = ""

    location_raw: str = ""
    city: str = ""
    country: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    location_precision: str = ""      # exact | city | country | ""
    remote_type: str = ""             # remote | hybrid | onsite | ""

    description: str = ""
    employment_type: str = ""
    seniority: str = ""
    salary_min: Optional[float] = None
    salary_max: Optional[float] = None
    salary_currency: str = ""
    salary_display: str = ""

    ats: str = ""                     # greenhouse | workday | ... | unknown
    ats_board: str = ""
    ats_job_id: str = ""

    posted_at: Optional[str] = None   # ISO 8601
    fetched_at: str = ""
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    # Derived in __post_init__. Never assign these by hand.
    identity_key: str = ""
    url_key: str = ""

    def __post_init__(self) -> None:
        self.canonical_url = canonical_url(self.canonical_url or self.apply_url)
        if not self.apply_url:
            self.apply_url = self.canonical_url
        if not self.fetched_at:
            self.fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.identity_key = identity_key(
            self.company, self.title, self.city or self.location_raw
        )
        self.url_key = url_key(self.canonical_url)

    def is_usable(self) -> bool:
        """A record is only worth storing if we can name the job and reach it."""
        return bool(
            normalize_title(self.title)
            and normalize_company(self.company)
            and self.canonical_url
        )

    def to_row(self) -> Dict[str, Any]:
        row = asdict(self)
        row.pop("raw", None)
        return row


_REMOTE_HINTS = {"remote": "remote", "hybrid": "hybrid", "on-site": "onsite", "onsite": "onsite"}


def _infer_remote_type(*texts: str) -> str:
    blob = _fold(" ".join(t for t in texts if t))
    if "hybrid" in blob or "hybride" in blob:
        return "hybrid"
    if any(word in blob for word in _REMOTE_WORDS):
        return "remote"
    return ""


def normalize_job(raw: Dict[str, Any], source: str) -> CanonicalJob:
    """Build a CanonicalJob from whatever a source adapter produced.

    Deliberately forgiving about key names: adapters in this repo already emit
    camelCase (the shape the web client renders) alongside snake_case, and the
    engine should not lose a field because one of them was renamed.
    """
    def pick(*keys: str, default: Any = "") -> Any:
        for key in keys:
            if key in raw and raw[key] not in (None, ""):
                return raw[key]
        return default

    title = str(pick("title", "job_title", "name"))

    company_val = pick("company", "company_name", "employer", "organisation")
    if isinstance(company_val, dict):  # some feeds nest it
        company_val = company_val.get("display_name") or company_val.get("name") or ""
    company = str(company_val)

    location_val = pick("location", "location_raw", "locationName", "area", default="")
    if isinstance(location_val, dict):
        location_val = location_val.get("name") or location_val.get("display_name") or ""
    elif isinstance(location_val, list):
        location_val = ", ".join(str(x) for x in location_val)
    location_raw = str(location_val)

    url = str(pick(
        "canonical_url", "canonicalUrl", "applyUrl", "apply_url",
        "redirect_url", "url", "absolute_url",
    ))
    apply_url = str(pick("applyUrl", "apply_url", "redirect_url", default=url))

    remote = str(pick("remoteType", "remote_type", default=""))
    remote_norm = _REMOTE_HINTS.get(_fold(remote), "") or _infer_remote_type(
        title, location_raw, remote
    )

    def num(*keys: str) -> Optional[float]:
        value = pick(*keys, default=None)
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    return CanonicalJob(
        source=source,
        source_id=str(pick("id", "jobId", "job_id", "source_id", default="")),
        title=title,
        company=company,
        canonical_url=url,
        apply_url=apply_url,
        location_raw=location_raw,
        city=str(pick("city", default="")),
        country=str(pick("country", default="")),
        lat=num("lat", "latitude"),
        lng=num("lng", "lon", "longitude"),
        location_precision=str(pick("locationPrecision", "location_precision", default="")),
        remote_type=remote_norm,
        description=str(pick("description", "content", "snippet", default="")),
        employment_type=str(pick(
            "jobType", "job_type", "employment_type", "contract_time", default=""
        )),
        seniority=str(pick("seniority", default="")),
        salary_min=num("salary_min", "salaryMin"),
        salary_max=num("salary_max", "salaryMax"),
        salary_currency=str(pick("salary_currency", "currency", default="")),
        salary_display=str(pick("salaryDisplay", "salary_display", default="")),
        ats=_fold(str(pick("atsProvider", "ats_provider", "ats", default=""))),
        ats_board=str(pick("atsBoard", "ats_board", "board", default="")),
        ats_job_id=str(pick("jobId", "ats_job_id", default="")),
        posted_at=pick("postedAt", "posted_at", "created", "updated_at", default=None),
        raw=raw,
    )


# ---------------------------------------------------------------------------
# Dedupe
# ---------------------------------------------------------------------------

# Ranked by how much the record can be trusted: an ATS feed is the employer own
# data, an aggregator is a copy of it with a redirect URL bolted on.
SOURCE_TRUST = {
    "greenhouse": 100, "lever": 100, "ashby": 100, "smartrecruiters": 100,
    "workday": 95, "recruitee": 95, "personio": 95, "teamtailor": 95,
    "career_page": 90,
    "adzuna": 50, "jooble": 45,
}

# Fields that describe where a record came from rather than what the job is,
# so a merge must never copy them across.
_PROVENANCE_FIELDS = {
    "raw", "identity_key", "url_key", "source", "source_id", "fetched_at",
}


def source_rank(job: "CanonicalJob") -> int:
    return SOURCE_TRUST.get(job.source, 10)


def merge_jobs(primary: "CanonicalJob", other: "CanonicalJob") -> "CanonicalJob":
    """Fold a duplicate into the record we trust more.

    The aggregator copy is not worthless: it often carries a salary band or
    coordinates the ATS feed omitted. So the trusted record wins every conflict
    and the duplicate is only allowed to fill in blanks.
    """
    for name, value in asdict(other).items():
        if name in _PROVENANCE_FIELDS:
            continue
        if getattr(primary, name, None) in (None, "") and value not in (None, ""):
            setattr(primary, name, value)
    # A longer description is almost always the fuller one.
    if len(other.description or "") > len(primary.description or ""):
        primary.description = other.description
    seen = primary.raw.setdefault("_also_seen_in", [])
    entry = {"source": other.source, "source_id": other.source_id, "url": other.canonical_url}
    if entry not in seen:
        seen.append(entry)
    return primary


def dedupe(jobs: List["CanonicalJob"]) -> List["CanonicalJob"]:
    """Collapse duplicates across every source into one record each.

    Two keys, not one. The same posting reaches us through an ATS feed and
    through an aggregator with completely different URLs, so a single hash over
    company+title+location+url would never match them: including the URL
    guarantees a miss on exactly the case dedupe exists for. A record therefore
    matches on the same canonical URL *or* on the same company+title+location,
    and the more trusted source wins.

    The cost is that two genuinely distinct openings sharing a title, company
    and city merge into one. That is the right trade: applying twice to the
    same job is worse than applying once to one of two identical ones.
    """
    by_identity: Dict[str, "CanonicalJob"] = {}
    by_url: Dict[str, "CanonicalJob"] = {}
    order: List["CanonicalJob"] = []

    for job in sorted(jobs, key=lambda j: -source_rank(j)):
        existing = by_url.get(job.url_key) if job.url_key else None
        if existing is None:
            existing = by_identity.get(job.identity_key)

        if existing is None:
            by_identity[job.identity_key] = job
            if job.url_key:
                by_url[job.url_key] = job
            order.append(job)
            continue

        merge_jobs(existing, job)
        # Index the loser keys too, so a third copy sharing either one merges.
        if job.url_key:
            by_url.setdefault(job.url_key, existing)
        by_identity.setdefault(job.identity_key, existing)

    return order
