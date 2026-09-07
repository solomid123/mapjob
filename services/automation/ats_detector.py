# -*- coding: utf-8 -*-
"""
ATS & Portal Fingerprinter.
Analyzes job URLs, HTML content, meta tags, and script bundles to detect
the exact ATS engine and extract structured IDs for direct API or specialized adapters.
"""

import re
from urllib.parse import urlparse, parse_qs
from typing import Dict, Any, Optional

ATS_PATTERNS = {
    "greenhouse": [
        r"boards\.greenhouse\.io/([^/]+)/jobs/(\d+)",
        r"greenhouse\.io/embed/job\?for=([^&]+)&token=(\d+)",
        r"job-board\.greenhouse\.io/([^/]+)/jobs/(\d+)"
    ],
    "lever": [
        r"jobs\.lever\.co/([^/]+)/([a-f0-9\-]+)",
        r"lever\.co/([^/]+)/([a-f0-9\-]+)"
    ],
    "ashby": [
        r"jobs\.ashbyhq\.com/([^/]+)/([a-f0-9\-]+)"
    ],
    "workday": [
        r"([^/]+)\.myworkdayjobs\.com/(?:[a-zA-Z\-]+/)?([^/]+)/job/[^/]+/([^/?#]+)",
        r"myworkdayjobs\.com",
        r"workday\.com"
    ],
    "smartrecruiters": [
        r"smartrecruiters\.com/([^/]+)/(\d+)",
        r"jobs\.smartrecruiters\.com/([^/]+)/(\d+)"
    ],
    "icims": [
        r"icims\.com/jobs/(\d+)"
    ],
    "taleo": [
        r"taleo\.net",
        r"oraclecloud\.com"
    ],
    "linkedin": [
        r"linkedin\.com/jobs/view/(\d+)"
    ],
    "indeed": [
        r"indeed\.[a-z]+/viewjob\?jk=([a-f0-9]+)",
        r"indeed\.[a-z]+/rc/clk\?jk=([a-f0-9]+)"
    ],
    "meteojob": [
        r"meteojob\.com/jobs/(\d+)"
    ],
    "nicoka": [
        r"nicoka\.com/public/jobs/([a-zA-Z0-9\-]+)"
    ],
    "apec": [
        r"apec\.fr/candidat/recherche-emploi\.html/detail-offre/([0-9A-Z]+)"
    ]
}

def detect_ats_from_url(url: str) -> Dict[str, Any]:
    """
    Detects ATS platform and tokens directly from URL without network requests.
    Returns: {
        'platform': str,
        'is_api_supported': bool,
        'organization': str,
        'job_id': str,
        'raw_url': str
    }
    """
    clean_url = url.strip()
    parsed = urlparse(clean_url)
    domain = parsed.netloc.lower()

    # 1. Greenhouse check
    if "greenhouse" in domain or "gh_jid" in clean_url:
        for pat in ATS_PATTERNS["greenhouse"]:
            m = re.search(pat, clean_url)
            if m:
                return {
                    "platform": "greenhouse",
                    "is_api_supported": True,
                    "organization": m.group(1),
                    "job_id": m.group(2),
                    "raw_url": clean_url
                }
        # Check query param embed format (e.g. company.com/jobs?gh_jid=12345)
        qs = parse_qs(parsed.query)
        if "gh_jid" in qs:
            return {
                "platform": "greenhouse",
                "is_api_supported": True,
                "organization": "",
                "job_id": qs["gh_jid"][0],
                "raw_url": clean_url
            }

    # 2. Lever check
    if "lever.co" in domain:
        for pat in ATS_PATTERNS["lever"]:
            m = re.search(pat, clean_url)
            if m:
                return {
                    "platform": "lever",
                    "is_api_supported": True,
                    "organization": m.group(1),
                    "job_id": m.group(2),
                    "raw_url": clean_url
                }

    # 3. Ashby check
    if "ashbyhq.com" in domain:
        for pat in ATS_PATTERNS["ashby"]:
            m = re.search(pat, clean_url)
            if m:
                return {
                    "platform": "ashby",
                    "is_api_supported": True,
                    "organization": m.group(1),
                    "job_id": m.group(2),
                    "raw_url": clean_url
                }

    # 4. Workday check
    if "myworkdayjobs.com" in domain or "workday" in domain:
        for pat in ATS_PATTERNS["workday"]:
            m = re.search(pat, clean_url)
            if m and len(m.groups()) >= 3:
                return {
                    "platform": "workday",
                    "is_api_supported": False,
                    "organization": m.group(1),
                    "job_id": m.group(3),
                    "raw_url": clean_url
                }
        return {
            "platform": "workday",
            "is_api_supported": False,
            "organization": "",
            "job_id": "",
            "raw_url": clean_url
        }

    # 5. SmartRecruiters check
    if "smartrecruiters.com" in domain:
        for pat in ATS_PATTERNS["smartrecruiters"]:
            m = re.search(pat, clean_url)
            if m:
                return {
                    "platform": "smartrecruiters",
                    "is_api_supported": True,
                    "organization": m.group(1),
                    "job_id": m.group(2),
                    "raw_url": clean_url
                }

    # 6. Specific Job Boards & Custom ATS
    for platform in ["linkedin", "indeed", "meteojob", "nicoka", "apec", "icims", "taleo"]:
        for pat in ATS_PATTERNS.get(platform, []):
            m = re.search(pat, clean_url)
            if m:
                return {
                    "platform": platform,
                    "is_api_supported": False,
                    "organization": "",
                    "job_id": m.group(1) if m.groups() else "",
                    "raw_url": clean_url
                }

    # Fallback to generic web portal
    return {
        "platform": "generic",
        "is_api_supported": False,
        "organization": "",
        "job_id": "",
        "raw_url": clean_url
    }

def detect_ats_from_html(html: str, url: str) -> Dict[str, Any]:
    """
    Inspects HTML page content for embedded ATS iframes, form actions, or data attributes.
    Useful when a company hosts a Greenhouse/Lever/Workday form on their own domain (e.g. acme.com/careers).
    """
    html_lower = html.lower()

    if "boards.greenhouse.io" in html_lower or "greenhouse.io/embed" in html_lower:
        gh_match = re.search(r"greenhouse\.io/(?:embed/job\?for=([^&\"']+)|([^/\"']+)/jobs/(\d+))", html)
        if gh_match:
            org = gh_match.group(1) or gh_match.group(2) or ""
            job_id = gh_match.group(3) if len(gh_match.groups()) >= 3 else ""
            return {
                "platform": "greenhouse",
                "is_api_supported": bool(org and job_id),
                "organization": org,
                "job_id": job_id,
                "raw_url": url
            }

    if "jobs.lever.co" in html_lower:
        lever_match = re.search(r"jobs\.lever\.co/([^/\"']+)/([a-f0-9\-]+)", html)
        if lever_match:
            return {
                "platform": "lever",
                "is_api_supported": True,
                "organization": lever_match.group(1),
                "job_id": lever_match.group(2),
                "raw_url": url
            }

    if "myworkdayjobs.com" in html_lower:
        return {
            "platform": "workday",
            "is_api_supported": False,
            "organization": "",
            "job_id": "",
            "raw_url": url
        }

    return detect_ats_from_url(url)
