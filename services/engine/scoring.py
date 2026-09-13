# -*- coding: utf-8 -*-
"""How relevant is this job, from 0 to 100, and why.

The score decides what the engine does next, so it has to be arguable. Every
component returns points *and* a sentence, and the sentences travel with the
score into the database. When the engine applies to something odd, the log says
which rule paid for it instead of leaving a bare number to distrust.

Bands, as specified:

    80-100  auto     apply automatically
    65-79   apply    apply, worth a tailored letter
    50-64   review   surface it, a human decides
     0-49   ignore   never queued
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .normalize import CanonicalJob, _fold, normalize_location, normalize_title

# Component ceilings. They sum to 100; changing one means changing another.
MAX_ROLE = 35
MAX_SKILLS = 25
MAX_LOCATION = 20
MAX_SENIORITY = 10
MAX_LANGUAGE = 5
MAX_FRESHNESS = 5

BAND_AUTO = 80
BAND_APPLY = 65
BAND_REVIEW = 50


@dataclass
class MatchProfile:
    """What the candidate is actually looking for.

    Separate from the identity profile (name, phone, CV) on purpose: that one
    fills forms, this one decides which forms are worth filling.
    """

    target_titles: Sequence[str] = ()      # phrases: "mechanical engineer"
    role_keywords: Sequence[str] = ()      # weaker signals: "hvac", "piping"
    skills: Sequence[str] = ()
    preferred_cities: Sequence[str] = ()
    acceptable_cities: Sequence[str] = ()
    countries: Sequence[str] = ()          # ISO-ish or plain names, folded
    remote_ok: bool = True
    years_experience: float = 0.0
    languages: Sequence[str] = ("english",)
    exclude_keywords: Sequence[str] = ()   # hard no: "security clearance"
    exclude_companies: Sequence[str] = ()
    accept_internships: bool = False
    skills_for_full_marks: int = 5

    def folded(self, name: str) -> List[str]:
        return [_fold(v) for v in getattr(self, name) if _fold(v)]


@dataclass
class Score:
    total: int
    band: str
    reasons: List[str] = field(default_factory=list)
    components: Dict[str, int] = field(default_factory=dict)
    blocked_by: Optional[str] = None

    @property
    def should_apply(self) -> bool:
        return self.band in ("auto", "apply")


def band_for(total: int) -> str:
    if total >= BAND_AUTO:
        return "auto"
    if total >= BAND_APPLY:
        return "apply"
    if total >= BAND_REVIEW:
        return "review"
    return "ignore"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tokens(text: str) -> List[str]:
    return [t for t in re.split(r"[^a-z0-9+#]+", _fold(text)) if t]


def _contains_phrase(haystack: str, phrase: str) -> bool:
    """Word-boundary containment, so a bare r does not match engineer."""
    if not phrase:
        return False
    core = re.escape(phrase).replace(r"\ ", r"[\s\-/]+")
    return re.search(r"(?<![a-z0-9])" + core + r"(?![a-z0-9])", haystack) is not None


def _phrase_overlap(target: str, title: str) -> float:
    """Fraction of the target phrase words present in the title."""
    want = set(_tokens(target))
    if not want:
        return 0.0
    return len(want & set(_tokens(title))) / len(want)


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

def score_role(job: CanonicalJob, profile: MatchProfile) -> Tuple[int, str]:
    """Does the title name the job we want?

    A whole target phrase in the title is the only route to full marks. Partial
    word overlap is capped well below it, because Engineer appearing in
    "Sales Engineer" is not the same signal as "Mechanical Engineer" appearing
    in "Senior Mechanical Engineer".
    """
    title = normalize_title(job.title)
    if not title:
        return 0, "no title to match against"

    targets = profile.folded("target_titles")
    for target in targets:
        if _contains_phrase(title, target):
            return MAX_ROLE, "title matches target role: %s" % target

    best_ratio, best_target = 0.0, ""
    for target in targets:
        ratio = _phrase_overlap(target, title)
        if ratio > best_ratio:
            best_ratio, best_target = ratio, target

    partial_cap = 22  # deliberately short of MAX_ROLE: a partial title is a maybe
    if best_ratio >= 0.5:
        points = int(round(partial_cap * best_ratio))
        return points, "title partially overlaps %s (%d%%)" % (
            best_target, round(best_ratio * 100)
        )

    hits = [k for k in profile.folded("role_keywords") if _contains_phrase(title, k)]
    if hits:
        return min(14, 6 + 4 * (len(hits) - 1)), "title carries role keywords: %s" % ", ".join(hits[:3])

    return 0, "title does not match any target role"


def score_skills(job: CanonicalJob, profile: MatchProfile) -> Tuple[int, str]:
    """How much of the posting the candidate can already do."""
    skills = profile.folded("skills")
    if not skills:
        return MAX_SKILLS // 2, "no skills configured, scored neutral"

    if not (job.description or "").strip():
        # Absence of evidence: a feed that ships titles only would otherwise
        # score every one of its jobs to zero and vanish from the queue.
        return MAX_SKILLS // 3, "no description to match skills against"

    blob = _fold(job.title + " " + job.description)
    hits = [s for s in skills if _contains_phrase(blob, s)]
    if not hits:
        return 0, "none of the configured skills appear in the posting"
    target = max(1, profile.skills_for_full_marks)
    points = int(round(MAX_SKILLS * min(1.0, len(hits) / target)))
    return points, "%d skill match(es): %s" % (len(hits), ", ".join(hits[:5]))


def score_location(job: CanonicalJob, profile: MatchProfile) -> Tuple[int, str]:
    """Can this job actually be taken from where the candidate lives?"""
    city = normalize_location(job.location_raw, job.city)
    remote = job.remote_type == "remote" or city == "remote"

    if remote:
        if profile.remote_ok:
            return MAX_LOCATION, "remote, and remote is acceptable"
        return 4, "remote, but remote was not requested"

    preferred = profile.folded("preferred_cities")
    acceptable = profile.folded("acceptable_cities")

    if city and any(city == c or _contains_phrase(city, c) for c in preferred):
        return MAX_LOCATION, "in a preferred city (%s)" % city
    if city and any(city == c or _contains_phrase(city, c) for c in acceptable):
        return 14, "in an acceptable city (%s)" % city

    countries = profile.folded("countries")
    if countries and _fold(job.country) in countries:
        return 9, "elsewhere in an acceptable country (%s)" % job.country
    if job.remote_type == "hybrid" and profile.remote_ok:
        return 8, "hybrid, so presence may be negotiable"
    if not city and not job.country:
        # Unproven, not disproven. A missing location must not read as a bad
        # one, or every sparse feed would score itself out of the queue.
        return 6, "location unknown, scored as unproven rather than wrong"
    return 0, "location is outside the search area: %s" % (job.location_raw or city)


_YEARS_RE = re.compile(
    r"(\d{1,2})\s*(?:\+|plus)?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?|ans|jahre|jaar)\b", re.I
)
_SENIOR_WORDS = ("senior", "lead", "principal", "staff", "head of", "director", "chief", "expert")
_JUNIOR_WORDS = ("junior", "graduate", "entry level", "trainee", "debutant")
INTERN_WORDS = ("intern", "internship", "stage", "stagiaire", "apprentice", "alternance", "werkstudent")


def required_years(text: str) -> Optional[int]:
    """Smallest year figure the posting asks for, if it asks for one.

    Smallest, not largest: a posting saying 3-5 years is open to three, and
    scoring against five would reject roles that would happily interview us.
    """
    matches = [int(m) for m in _YEARS_RE.findall(text or "")]
    plausible = [m for m in matches if 0 < m <= 40]
    return min(plausible) if plausible else None


def score_seniority(job: CanonicalJob, profile: MatchProfile) -> Tuple[int, str]:
    title = _fold(job.title)
    years = profile.years_experience
    needed = required_years(job.description or "")

    if needed is not None:
        if years >= needed:
            return MAX_SENIORITY, "asks for %d years, candidate has %g" % (needed, years)
        gap = needed - years
        if gap <= 1:
            return 7, "asks for %d years, candidate has %g (close enough to try)" % (needed, years)
        if gap <= 3:
            return 3, "asks for %d years, candidate has %g" % (needed, years)
        return 0, "asks for %d years, candidate has %g" % (needed, years)

    if any(w in title for w in _SENIOR_WORDS):
        if years >= 5:
            return MAX_SENIORITY, "senior title, and the experience backs it"
        return 2, "senior title with only %g years of experience" % years
    if any(w in title for w in _JUNIOR_WORDS):
        if years <= 3:
            return MAX_SENIORITY, "junior title matches the experience level"
        return 4, "junior title for %g years of experience" % years
    return 6, "no explicit seniority requirement"


_LANG_PATTERNS = {
    "french": (r"\bfrench\b", r"\bfrancais\b", r"\bfranzosisch\b"),
    "german": (r"\bgerman\b", r"\bdeutsch\b", r"\ballemand\b"),
    "dutch": (r"\bdutch\b", r"\bnederlands\b", r"\bneerlandais\b"),
    "english": (r"\benglish\b", r"\banglais\b", r"\benglisch\b"),
    "spanish": (r"\bspanish\b", r"\bespagnol\b", r"\bespanol\b"),
    "italian": (r"\bitalian\b", r"\bitalien\b", r"\bitaliano\b"),
}
_FLUENCY = r"(fluent|native|bilingual|proficient|courant|c1|c2|mother\s*tongue|maitrise)"


def score_language(job: CanonicalJob, profile: MatchProfile) -> Tuple[int, str]:
    """Only a fluency *demand* counts against us.

    A posting mentioning German is not a posting requiring German. Penalising
    every mention would quietly delete a whole country from the search.
    """
    blob = _fold(job.description or "")
    if not blob:
        return MAX_LANGUAGE, "no language requirement stated"

    spoken = set(profile.folded("languages"))
    demanded = []
    for lang, patterns in _LANG_PATTERNS.items():
        for pattern in patterns:
            for match in re.finditer(pattern, blob):
                window = blob[max(0, match.start() - 60): match.end() + 60]
                if re.search(_FLUENCY, window):
                    demanded.append(lang)
                    break
            if lang in demanded:
                break

    missing = [lang for lang in demanded if lang not in spoken]
    if not demanded:
        return MAX_LANGUAGE, "no fluency requirement detected"
    if not missing:
        return MAX_LANGUAGE, "required language(s) covered: %s" % ", ".join(demanded)
    return 0, "requires fluent %s" % ", ".join(missing)


def _parse_date(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def score_freshness(job: CanonicalJob, now: Optional[datetime] = None) -> Tuple[int, str]:
    """Old postings are often already filled."""
    posted = _parse_date(job.posted_at)
    if posted is None:
        return 2, "posting date unknown"
    age = ((now or datetime.now(timezone.utc)) - posted).days
    if age <= 3:
        return MAX_FRESHNESS, "posted %d day(s) ago" % max(age, 0)
    if age <= 7:
        return 4, "posted this week"
    if age <= 14:
        return 3, "posted within two weeks"
    if age <= 30:
        return 2, "posted within a month"
    return 0, "posted %d days ago" % age


# ---------------------------------------------------------------------------
# Hard blockers
# ---------------------------------------------------------------------------

def find_blocker(job: CanonicalJob, profile: MatchProfile) -> Optional[str]:
    """Reasons to never queue this, regardless of how well it scores.

    Kept separate from the point system on purpose. A job needing a security
    clearance we cannot get is not a low-scoring job, it is a non-job, and
    letting a strong title and a perfect location outvote that is how an
    automated applier ends up embarrassing its owner.
    """
    haystack = _fold(job.title + " " + (job.description or ""))
    company = _fold(job.company)

    for word in profile.folded("exclude_companies"):
        if word and word in company:
            return "excluded company: %s" % job.company

    for word in profile.folded("exclude_keywords"):
        if word and _contains_phrase(haystack, word):
            return "excluded keyword: %s" % word

    if not profile.accept_internships:
        title = _fold(job.title)
        if any(_contains_phrase(title, w) for w in INTERN_WORDS):
            return "internship or apprenticeship, which was not requested"

    if not job.canonical_url:
        return "no reachable URL, so it cannot be applied to"

    return None


# ---------------------------------------------------------------------------
# The score
# ---------------------------------------------------------------------------

# Components that veto the top bands when they score nothing at all. Not hard
# blockers: the job still appears for review, it just never applies itself.
_CAP_RULES = (
    ("location", "the location does not qualify"),
    ("role", "the title does not match a target role"),
)

def score_job(
    job: CanonicalJob,
    profile: MatchProfile,
    now: Optional[datetime] = None,
) -> Score:
    """Score one job and record why.

    A blocked job returns 0 rather than its component total: the number that
    reaches the queue should mean what it says, and a blocked job with an
    honest-looking 74 next to it invites someone to override the block.
    """
    blocker = find_blocker(job, profile)
    if blocker:
        return Score(total=0, band="ignore", reasons=["blocked: " + blocker],
                     components={}, blocked_by=blocker)

    parts = {
        "role": score_role(job, profile),
        "skills": score_skills(job, profile),
        "location": score_location(job, profile),
        "seniority": score_seniority(job, profile),
        "language": score_language(job, profile),
        "freshness": score_freshness(job, now),
    }

    components = {name: points for name, (points, _) in parts.items()}
    reasons = ["%s %+d: %s" % (name, points, why) for name, (points, why) in parts.items()]
    total = max(0, min(100, sum(components.values())))

    # Some dimensions cannot be bought off with points elsewhere. A perfect
    # skills match does not make a job in Tokyo commutable, and a flawless
    # location does not make a Pastry Chef post worth applying to. Without this
    # cap, five strong components outvote the one that disqualifies the job and
    # the engine auto-applies to something plainly wrong.
    for name, note in _CAP_RULES:
        if components.get(name) == 0:
            total = min(total, BAND_APPLY - 1)
            reasons.append("capped below auto-apply: %s" % note)

    return Score(total=total, band=band_for(total), reasons=reasons, components=components)


def score_all(
    jobs: Iterable[CanonicalJob],
    profile: MatchProfile,
    now: Optional[datetime] = None,
) -> List[Tuple[CanonicalJob, Score]]:
    """Score a batch, best first."""
    scored = [(job, score_job(job, profile, now)) for job in jobs]
    scored.sort(key=lambda pair: -pair[1].total)
    return scored
