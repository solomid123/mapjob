# -*- coding: utf-8 -*-
"""Run the discovery pipeline from the command line and look at what it did.

    python -m services.engine.cli --top 20
    python -m services.engine.cli --dupes 10
    python -m services.engine.cli --explain 3
    python -m services.engine.cli --profile my_profile.json --band auto

Read-only. It fetches job feeds, normalizes, dedupes and scores, and prints the
result. Nothing here contacts an employer or submits anything.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

from .normalize import CanonicalJob, dedupe, normalize_job
from .scoring import MatchProfile, Score, score_all

SNAPSHOT = Path(__file__).resolve().parent / ".feed_snapshot.json"
DEFAULT_PROFILE = Path(__file__).resolve().parent / "match_profile.json"


def _out(text: str = "") -> None:
    """Print without exploding on a console that cannot encode the character.

    Job titles arrive with accents and dashes from half of Europe, and a
    UnicodeEncodeError in a reporting tool would be an absurd way to lose a run.
    """
    encoding = sys.stdout.encoding or "utf-8"
    sys.stdout.write(text.encode(encoding, "replace").decode(encoding) + "\n")


def load_feed(refresh: bool = False) -> List[Dict[str, Any]]:
    """Job dicts from the live ATS boards, cached on disk between runs.

    The upstream cache is in-process with a five minute TTL, so without a
    snapshot every invocation would spend a minute and a half refetching the
    same 6,800 postings just to print a table.
    """
    if SNAPSHOT.exists() and not refresh:
        age_min = (time.time() - SNAPSHOT.stat().st_mtime) / 60
        with SNAPSHOT.open(encoding="utf-8") as handle:
            jobs = json.load(handle)
        _out("feed: %d jobs from snapshot (%.0f min old, --refresh to refetch)"
             % (len(jobs), age_min))
        return jobs

    _out("feed: fetching every ATS board, this takes a minute or two...")
    from services.automation import direct_ats_client as dac

    jobs = dac.get_all_cached_jobs()
    SNAPSHOT.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")
    _out("feed: %d jobs fetched and snapshotted" % len(jobs))
    return jobs


def load_profile(path: Path) -> MatchProfile:
    """The candidate criteria, from JSON, falling back to a worked example."""
    if not path.exists():
        _out("profile: %s not found, using the built-in example" % path.name)
        return MatchProfile(
            target_titles=("software engineer", "backend engineer", "data engineer"),
            role_keywords=("python", "distributed systems", "kubernetes"),
            skills=("python", "go", "kubernetes", "aws", "sql", "docker", "terraform"),
            preferred_cities=("paris",),
            acceptable_cities=("amsterdam", "berlin", "london"),
            countries=("fr", "nl", "de"),
            years_experience=3,
            languages=("english",),
            exclude_keywords=("security clearance",),
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    known = MatchProfile.__dataclass_fields__
    unknown = [k for k in data if k not in known]
    if unknown:
        # Loudly, because a typo in a profile key would otherwise silently
        # widen the search rather than narrow it.
        _out("profile: ignoring unknown key(s): %s" % ", ".join(unknown))
    _out("profile: %s" % path.name)
    return MatchProfile(**{k: v for k, v in data.items() if k in known})


def run_pipeline(raw_jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalize, drop the unusable, dedupe. Returns the stats as well."""
    started = time.time()
    normalized = [
        normalize_job(job, (job.get("atsProvider") or job.get("source") or "unknown").lower())
        for job in raw_jobs
    ]
    usable = [job for job in normalized if job.is_usable()]
    unique = dedupe(usable)
    return {
        "jobs": unique,
        "raw": len(raw_jobs),
        "usable": len(usable),
        "unique": len(unique),
        "dropped": len(normalized) - len(usable),
        "merged": len(usable) - len(unique),
        "seconds": time.time() - started,
    }


def print_pipeline(stats: Dict[str, Any]) -> None:
    _out()
    _out("pipeline")
    _out("  fetched      %6d" % stats["raw"])
    _out("  unusable     %6d  (no title, company or URL)" % stats["dropped"])
    _out("  duplicates   %6d  merged into another record" % stats["merged"])
    _out("  unique       %6d" % stats["unique"])
    _out("  took         %6.2fs" % stats["seconds"])

    by_source: Dict[str, int] = {}
    for job in stats["jobs"]:
        by_source[job.source] = by_source.get(job.source, 0) + 1
    _out("  sources      " + ", ".join(
        "%s %d" % pair for pair in sorted(by_source.items(), key=lambda p: -p[1])))


def print_dupes(jobs: List[CanonicalJob], limit: int) -> None:
    """Show what got merged, so the dedupe rule can be argued with."""
    merged = [job for job in jobs if job.raw.get("_also_seen_in")]
    _out()
    _out("merged records (%d total, showing %d)" % (len(merged), min(limit, len(merged))))
    if not merged:
        _out("  none -- every posting in this feed was unique")
        return
    for job in merged[:limit]:
        _out("  %s -- %s (%s)" % (job.company, job.title, job.city or job.location_raw))
        _out("     kept  %-14s %s" % (job.source, job.canonical_url))
        for other in job.raw["_also_seen_in"]:
            _out("     also  %-14s %s" % (other["source"], other["url"]))


def print_ranked(ranked: List, limit: int, band: str = "") -> None:
    rows = [pair for pair in ranked if not band or pair[1].band == band]
    _out()
    _out("ranked (%d shown%s)" % (min(limit, len(rows)), ", band=" + band if band else ""))
    _out("   #  score band    title                                    company          location")
    for index, (job, score) in enumerate(rows[:limit]):
        _out("  %2d  %5d %-7s %-40.40s %-16.16s %s"
             % (index, score.total, score.band, job.title, job.company,
                job.city or job.location_raw))


def print_bands(ranked: List) -> None:
    counts: Dict[str, int] = {"auto": 0, "apply": 0, "review": 0, "ignore": 0}
    for _, score in ranked:
        counts[score.band] = counts.get(score.band, 0) + 1
    total = max(1, len(ranked))
    _out()
    _out("bands")
    for band in ("auto", "apply", "review", "ignore"):
        count = counts[band]
        bar = "#" * int(round(40 * count / total))
        _out("  %-7s %6d  %5.1f%%  %s" % (band, count, 100 * count / total, bar))


def print_explain(job: CanonicalJob, score: Score) -> None:
    _out()
    _out("=" * 78)
    _out("%s" % job.title)
    _out("%s -- %s" % (job.company, job.city or job.location_raw or "location unknown"))
    _out(job.canonical_url)
    _out("-" * 78)
    _out("score %d / 100   band %s" % (score.total, score.band))
    if score.blocked_by:
        _out("BLOCKED: %s" % score.blocked_by)
    for reason in score.reasons:
        _out("   %s" % reason)
    _out("-" * 78)
    _out("source %s   ats %s   remote %s   posted %s"
         % (job.source, job.ats or "?", job.remote_type or "?", job.posted_at or "?"))
    _out("identity key %s" % job.identity_key[:16])
    also = job.raw.get("_also_seen_in") or []
    if also:
        _out("also seen in: %s" % ", ".join(o["source"] for o in also))
    _out("=" * 78)


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m services.engine.cli",
        description="Fetch, normalize, dedupe and score jobs. Submits nothing.",
    )
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE,
                        help="JSON MatchProfile (default: services/engine/match_profile.json)")
    parser.add_argument("--refresh", action="store_true",
                        help="refetch the feeds instead of using the disk snapshot")
    parser.add_argument("--top", type=int, default=15, help="how many ranked rows to print")
    parser.add_argument("--band", choices=("auto", "apply", "review", "ignore"), default="",
                        help="only show one band")
    parser.add_argument("--dupes", type=int, default=0, metavar="N",
                        help="show N merged records and where each copy came from")
    parser.add_argument("--explain", type=int, default=None, metavar="INDEX",
                        help="full score breakdown for one row of the ranked table")
    parser.add_argument("--json", type=Path, default=None, metavar="PATH",
                        help="write the scored results to a JSON file")
    args = parser.parse_args(argv)

    profile = load_profile(args.profile)
    stats = run_pipeline(load_feed(refresh=args.refresh))
    print_pipeline(stats)

    if args.dupes:
        print_dupes(stats["jobs"], args.dupes)

    ranked = score_all(stats["jobs"], profile)
    print_bands(ranked)
    print_ranked(ranked, args.top, args.band)

    if args.explain is not None:
        rows = [pair for pair in ranked if not args.band or pair[1].band == args.band]
        if 0 <= args.explain < len(rows):
            print_explain(*rows[args.explain])
        else:
            _out("\n--explain %d is out of range (0..%d)" % (args.explain, len(rows) - 1))

    if args.json:
        payload = [
            {**job.to_row(), "score": score.total, "band": score.band,
             "reasons": score.reasons, "blocked_by": score.blocked_by}
            for job, score in ranked
        ]
        args.json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        _out("\nwrote %d scored jobs to %s" % (len(payload), args.json))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
