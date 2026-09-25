# -*- coding: utf-8 -*-
"""
One CV and one letter per job, cut from the master rather than written fresh.

The master CVs in cv_master/ are the only source of fact in here. Tailoring
means choosing which of their bullets a particular employer gets to see, in
which order, under a summary and a headline angled at what they advertised --
and nothing else. The model is allowed to select, reorder and rephrase. It is
not allowed to add, and this module does not take its word for that:

  * every bullet it returns must carry an id that exists in the master;
  * every number in a rephrased bullet must already be in the bullet it came
    from, so "-15% mass" cannot quietly become "-35% mass";
  * every capitalised or digit-bearing token it uses must appear somewhere in
    the master, or in the job title it is answering -- which blocks an invented
    employer, tool or standard while still letting the summary name the role;
  * a rewrite that fails any of those is replaced by the master's own wording,
    not dropped. A failed rewrite costs polish; a dropped claim costs a job.

What survives that is rendered back into the master's own HTML -- its stylesheet
untouched, its @page A4 rules doing the layout -- and printed by the headless
Chrome this project already drives. HTML rather than LaTeX because a five
gigabyte TeX install on the VPS buys nothing here, and because an unescaped
ampersand in a company name should not be able to break an application at the
moment it is being sent.

The letter is written by the same client, in the language the employer reads,
under the same rule about invention. Both are stored per job id by documents.py.
"""

from __future__ import annotations

import html as html_lib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from services.automation import documents
from services.automation.llm_client import FuelixClient

MASTER_DIR = Path(os.getenv("CV_MASTER_DIR",
                            str(Path(__file__).resolve().parent / "cv_master")))

# The languages a master can be written in. There is no master_de.html in this
# repository and there does not need to be one: an account whose own CV is in
# German is presented in German from its profile.
MASTERS = {"en": "master_en.html", "fr": "master_fr.html", "de": "master_de.html"}


def master_path(language: str, user: str = "") -> Path:
    """
    Whose master CV to cut from.

    The files in `cv_master/` are one person's CV -- his name, his degree, his
    employers -- and they were read for whoever asked. That is not a wrong
    layout, it is a second candidate's life attached to this candidate's
    application. So a named account is looked for in `cv_master/<account>/`
    first, and an account that is not the one these files describe gets its own
    folder whether or not anything is in it: a missing master is an error the
    caller can report, and sending somebody else's CV is not.
    """
    name = MASTERS.get(language, MASTERS["en"])
    who = (user or "").strip()
    if not who:
        return MASTER_DIR / name
    own = MASTER_DIR / who / name
    if own.exists():
        return own
    from services.automation import people
    if people.resolve(who) == people.DEFAULT:
        return MASTER_DIR / name
    return own


def read_master(language: str, user: str = "") -> str:
    """
    The master this account is cut from: their file if they have one, otherwise
    their own profile rendered as one.

    A file under `cv_master/` wins where there is one, because the two in this
    repository are hand-tuned and nothing should quietly replace them. But a
    file on this machine is not something a person who signs up tomorrow can
    have. What they do have is the CV they uploaded on the settings page, which
    was read into their profile -- and that profile holds every fact this
    module is allowed to use anyway. So the fallback is not a placeholder, it
    is the same CV by another route.
    """
    path = master_path(language, user)
    if path.exists():
        return path.read_text(encoding="utf-8")

    from services.automation import master_cv, people, profile_store
    profile = profile_store.public_profile(
        profile_store.profile_for(people.resolve(user)))
    if master_cv.has_enough(profile):
        return master_cv.build(profile, language)
    raise FileNotFoundError(
        "No CV to work from yet. Upload one on the settings page and it "
        "becomes the master every tailored CV is cut from.")


# --------------------------------------------------------------------------
# Reading the master
#
# Regex over one's own HTML is usually a mistake; here the HTML is a fixed
# document in this repository, written by hand, with class names that exist
# precisely so that it can be addressed. Adding a parser dependency to read
# three known tags would be the heavier choice.
# --------------------------------------------------------------------------

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"\s+")

RE_ROLE = re.compile(r'(<p class="head__role">)(.*?)(</p>)', re.S)
RE_SUMMARY = re.compile(r'(<p class="summary">)(.*?)(</p>)', re.S)
RE_JOB = re.compile(r'<article class="job">(.*?)</article>', re.S)
RE_JOB_COMPANY = re.compile(r'<span class="job__company">(.*?)</span>\s*</span>', re.S)
RE_JOB_ROLE = re.compile(r'<p class="job__role">(.*?)</p>', re.S)
RE_JOB_YEARS = re.compile(r'<span class="job__years">(.*?)</span>', re.S)
RE_UL = re.compile(r"(<ul>)(.*?)(</ul>)", re.S)
RE_LI = re.compile(r"<li>(.*?)</li>", re.S)
RE_SKILLGROUP = re.compile(
    r'<h4>(.*?)</h4>\s*<div class="tags">(.*?)</div>', re.S)
RE_SPAN = re.compile(r"<span>(.*?)</span>", re.S)


def plain(fragment: str) -> str:
    """Tag soup to the words a human would read."""
    text = _TAG.sub(" ", fragment or "")
    return _WS.sub(" ", html_lib.unescape(text)).strip()


def inventory(master_html: str) -> Dict:
    """
    Everything in the master that tailoring is allowed to touch, with an id on
    each piece so the model can point at one instead of retyping it.
    """
    jobs: List[Dict] = []
    for index, block in enumerate(RE_JOB.findall(master_html), start=1):
        company = RE_JOB_COMPANY.search(block)
        role = RE_JOB_ROLE.search(block)
        years = RE_JOB_YEARS.search(block)
        bullets = []
        for b_index, li in enumerate(RE_LI.findall(block), start=1):
            bullets.append({
                "id": f"j{index}b{b_index}",
                "html": li.strip(),
                "text": plain(li),
            })
        jobs.append({
            "id": f"j{index}",
            "company": plain(company.group(1)) if company else "",
            "role": plain(role.group(1)) if role else "",
            "years": plain(years.group(1)) if years else "",
            "bullets": bullets,
        })

    groups = []
    for title, tags in RE_SKILLGROUP.findall(master_html):
        groups.append({
            "title": plain(title),
            "tags": [plain(t) for t in RE_SPAN.findall(tags)],
        })

    role_match = RE_ROLE.search(master_html)
    summary_match = RE_SUMMARY.search(master_html)
    return {
        "headline": plain(role_match.group(2)) if role_match else "",
        "summary": plain(summary_match.group(2)) if summary_match else "",
        "jobs": jobs,
        "skill_groups": groups,
        "plain": plain(master_html[master_html.find("<body"):]),
    }


# --------------------------------------------------------------------------
# Asking for a plan
# --------------------------------------------------------------------------

SYSTEM = (
    "You are a careful technical recruiter preparing one candidate's existing CV "
    "for one specific vacancy. You never add experience. Everything you return is "
    "either copied from the CV given to you or a closer rewording of it. If the "
    "vacancy asks for something the candidate has not done, you leave it out "
    "rather than implying it. You answer with JSON only."
)

MAX_DESCRIPTION = 4000


def _bullet_lines(inv: Dict) -> str:
    out = []
    for job in inv["jobs"]:
        out.append("[" + job["id"] + "] " + job["company"] + " - "
                   + job["role"] + " (" + job["years"] + ")")
        for bullet in job["bullets"]:
            out.append("  " + bullet["id"] + ": " + bullet["text"])
    return "\n".join(out)


def _skill_lines(inv: Dict) -> str:
    return "\n".join("  " + g["title"] + ": " + ", ".join(g["tags"])
                     for g in inv["skill_groups"])


LANGUAGE_NAMES = {"en": "English", "fr": "French"}


def _prompt(inv: Dict, job: Dict, language: str = "en") -> str:
    description = (job.get("description") or "").strip()
    if len(description) > MAX_DESCRIPTION:
        description = description[:MAX_DESCRIPTION] + " [...]"
    shape = (
        "{\n"
        '  "headline": "under 90 characters, the candidate angled at this vacancy",\n'
        '  "summary": "60-75 words, no pronoun, why this CV answers this advert",\n'
        '  "bullets": [{"id": "j1b3", "text": ""}],\n'
        '  "skills": ["exact skill tags worth keeping, most relevant first"],\n'
        '  "why": "one sentence on what you led with and why"\n'
        "}"
    )
    tongue = LANGUAGE_NAMES.get(language, "English")
    rules = (
        "RULES\n"
        "- bullets: list the ids worth showing, in the order they should be read. "
        "Leave text empty to keep the bullet exactly as written; fill it in only "
        "to shorten or re-angle that same achievement.\n"
        "- Keep at least one bullet from every job listed. A job with nothing under "
        "it reads as a gap in the career, which is a lie by layout.\n"
        "- Aim for six or seven bullets on the most recent job and two or three on "
        "the older ones: this has to stay one page.\n"
        "- Every number you write must already be in the bullet you took it from.\n"
        "- skills: copy tags exactly as spelled above. Do not invent tools. Choose "
        "the ones this vacancy actually asks for, then the strongest of the rest.\n"
        # "Il apporte plus de 3 ans d'experience" -- he brings, as if the CV were
        # written by his agent. Nobody writes a CV about themselves in the third
        # person, and the master's own summary does not either.
        "- The summary is written the way the master's is: a noun phrase about the "
        "work, with no pronoun and no verb of introduction. Never \"He is\", \"He "
        "brings\", \"Il apporte\", \"Il est\", \"Elle\". Start with the profession, as in "
        "\"" + inv["summary"][:70] + "\".\n"
        "- The summary may name the advertised role. It may not claim knowledge of "
        "this company, a qualification the CV does not list, or years of experience "
        "the CV does not show.\n"
        # A Dutch advert once came back with a Dutch headline over an English
        # summary and English bullets: the model answered in the language it was
        # read in, which is polite in conversation and wrong on a CV. The page is
        # written in one language, and that language is the master's.
        "- Write every field in " + tongue + ", whatever language the advert is in. "
        "The bullets you keep are already in " + tongue + " and the page must read "
        "as one document, not two."
    )
    return (
        "THE VACANCY\n"
        "Title: " + str(job.get("title") or "") + "\n"
        "Company: " + str(job.get("company") or "") + "\n"
        "Location: " + str(job.get("location") or "") + "\n"
        "Description:\n"
        + (description or "(none supplied - tailor on the title alone)")
        + "\n\nTHE CANDIDATE'S CV, WHICH IS THE ONLY SOURCE OF FACT\n"
        "Current headline: " + inv["headline"] + "\n"
        "Current summary: " + inv["summary"] + "\n\n"
        "Experience bullets, by id:\n" + _bullet_lines(inv)
        + "\n\nSkill tags, by group:\n" + _skill_lines(inv)
        + "\n\nRETURN THIS JSON, NOTHING ELSE\n" + shape + "\n\n" + rules
    )


# --------------------------------------------------------------------------
# Checking the plan before it becomes a PDF
# --------------------------------------------------------------------------

_WORD = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
_SENTENCE = re.compile(r"(?<=[.;:!?])\s+")

# Words that may open a clause without being a claim about anything.
_HARMLESS = {"i", "a", "the", "je", "mon", "ma", "mes", "le", "la", "les", "un",
             "une", "des", "and", "et", "for", "with", "avec", "pour"}


def _vocabulary(*sources: str) -> set:
    words = set()
    for source in sources:
        for match in _WORD.finditer(source or ""):
            words.add(match.group(0).lower().strip("'’-"))
    return words


def _new_numbers(text: str, source: str) -> List[str]:
    allowed = set(_NUMBER.findall(source or ""))
    return [n for n in _NUMBER.findall(text or "") if n not in allowed]


_YEARS = re.compile(r"(\d+(?:[.,]\d+)?)\s*(?:\+\s*)?(?:ans|années|years|yrs|Jahre)",
                    re.I)


def _overstated_years(text: str, user: str = "") -> List[str]:
    """
    "Over ten years of experience" is the oldest inflation in the trade, and it
    survives every other check here: the digits are small, the words are common,
    and nothing in the master contradicts it in so many terms. So the claim is
    read out of the sentence and compared with the profile's own figure.
    """
    try:
        declared = float(safe_profile(user or None).get("years_of_experience") or 0)
    except Exception:
        declared = 0.0
    if not declared:
        return []
    return [m.group(0) for m in _YEARS.finditer(text or "")
            if float(m.group(1).replace(",", ".")) > declared + 0.5]


def _new_terms(text: str, allowed: set) -> List[str]:
    """
    Capitalised or digit-bearing words that are nowhere in the master.

    The first word of a sentence is exempt from the capital rule -- a rewrite may
    open with a verb the master happens not to use -- but never from the digit
    rule. An employer, a tool or a standard appearing out of nowhere is exactly
    what this is here to catch.
    """
    offenders = []
    for sentence in _SENTENCE.split(text or ""):
        for position, match in enumerate(_WORD.finditer(sentence)):
            token = match.group(0)
            lowered = token.lower().strip("'’-")
            if not lowered or lowered in _HARMLESS or lowered in allowed:
                continue
            if position == 0 and token[:1].isupper() and not any(c.isdigit() for c in token):
                continue
            if token[:1].isupper() or any(c.isdigit() for c in token):
                offenders.append(token)
    return offenders


# Function words nobody writes a sentence without, chosen so that no word
# appears in two lists: a vote on these says which language a line is in without
# a dictionary, a model call or a dependency. Words shared across these
# languages ("in", "de", "en", "international") are left out precisely because
# they cannot decide anything.
_STOPWORDS = {
    "en": {"the", "and", "with", "for", "of", "to", "on", "as", "their", "its",
           "through", "into", "across", "including", "while", "which"},
    "fr": {"le", "la", "les", "des", "du", "et", "pour", "avec", "dans", "aux",
           "une", "ainsi", "sur", "leur", "ses", "afin", "chez"},
    "nl": {"het", "een", "van", "voor", "met", "bij", "naar", "om", "te", "door",
           "zijn", "aan", "waarbij", "binnen"},
    "de": {"der", "die", "das", "und", "mit", "für", "bei", "zur", "den", "dem",
           "sowie", "einer", "eines", "durch"},
}


def _wrong_language(text: str, language: str) -> str:
    """
    The language a line is written in, when it is plainly not the master's.

    A model reads a Dutch advert and answers in Dutch. That is the right instinct
    in a chat and the wrong one on a CV, where the summary it writes sits above
    eleven English bullets it did not translate and cannot: the bullets are the
    candidate's own words, and rewriting them into another language would be
    inventing a CV nobody has read.

    So this votes on function words and names the intruder. It answers only when
    another language wins outright with at least two markers of its own -- a
    borrowed job title ("Mechanisch Ingenieur") is not evidence, and a line this
    cannot read is left alone rather than thrown away on a guess.
    """
    words = {m.group(0).lower() for m in _WORD.finditer(text or "")}
    scores = {lang: len(words & markers) for lang, markers in _STOPWORDS.items()}
    mine = scores.get(language, 0)
    intruder, score = max(scores.items(), key=lambda pair: pair[1])
    if intruder != language and score >= 2 and score > mine:
        return intruder
    return ""


# "Il apporte plus de 3 ans d'expérience", printed under the candidate's own
# name. A CV is not written about someone by someone else, and the moment a
# pronoun appears the summary reads as a recruiter's note rather than the
# candidate's own page. Possessives count: "his experience" is the same voice.
_THIRD_PERSON = re.compile(
    r"\b(he|she|his|her|hers|him|himself|herself|il|elle|lui|son|sa|ses|"
    r"leur|er|sie|sein|seine|hij|zij|zijn)\b", re.I)


def _third_person(text: str) -> List[str]:
    return sorted({m.group(0).lower() for m in _THIRD_PERSON.finditer(text or "")})


def _unfamiliar(text: str, allowed: set, language: str) -> List[str]:
    """
    Words in a headline that are neither the master's nor the vacancy's.

    The stop-word vote needs a sentence, and a headline is six nouns and a pipe:
    "Mechanisch Ingenieur | CAD, FEA en ontwikkeling van industriële machines"
    carries one Dutch marker and would slip past it. But a headline is drawn from
    what the candidate already does, so nearly every word in an honest one is in
    the master or the advertised title. Words that are in neither -- and are not
    ordinary grammar in the language being written -- are the tell.
    """
    grammar = _HARMLESS | _STOPWORDS.get(language, set())
    unknown = []
    for match in _WORD.finditer(text or ""):
        word = match.group(0).lower().strip("'’-")
        if word and word not in allowed and word not in grammar:
            unknown.append(match.group(0))
    return unknown


def verify(plan: Dict, inv: Dict, job: Dict, language: str = "en",
           user: str = "") -> Tuple[Dict, Dict]:
    """
    The plan as it will actually be used, plus a note of everything corrected.

    Nothing here throws the plan away. A model that misbehaves on one bullet
    should cost that bullet its rewrite, not cost the candidate a tailored CV.
    What cannot be trusted is replaced by the master's own wording, and the
    report says which -- so the page can show it rather than imply the model
    behaved.
    """
    by_id = {b["id"]: b for j in inv["jobs"] for b in j["bullets"]}
    all_tags = [t for g in inv["skill_groups"] for t in g["tags"]]
    allowed = _vocabulary(inv["plain"], job.get("title") or "", job.get("company") or "")

    report = {"reverted": [], "unknown_ids": [], "rejected_skills": [],
              "invented": [], "topped_up": [], "off_language": [], "off_voice": []}

    clean_bullets = []
    seen = set()
    for entry in (plan.get("bullets") or []):
        if isinstance(entry, str):
            entry = {"id": entry, "text": ""}
        if not isinstance(entry, dict):
            continue
        bullet_id = str(entry.get("id") or "").strip()
        if bullet_id not in by_id:
            report["unknown_ids"].append(bullet_id)
            continue
        if bullet_id in seen:
            continue
        seen.add(bullet_id)
        source = by_id[bullet_id]
        rewrite = _WS.sub(" ", str(entry.get("text") or "")).strip()
        if rewrite and rewrite != source["text"]:
            bad_numbers = _new_numbers(rewrite, source["text"]) + _overstated_years(rewrite, user)
            bad_terms = _new_terms(rewrite, allowed)
            too_long = len(rewrite) > len(source["text"]) * 1.7 + 20
            if bad_numbers or bad_terms or too_long:
                report["reverted"].append(bullet_id)
                report["invented"].extend(bad_numbers + bad_terms)
                rewrite = ""
        clean_bullets.append({"id": bullet_id, "text": rewrite})

    # Every job keeps a voice. If the model emptied one, the master's own first
    # bullets go back under it rather than the job vanishing off the page.
    for block in inv["jobs"]:
        if not {b["id"] for b in block["bullets"]} & seen:
            for bullet in block["bullets"][:2]:
                clean_bullets.append({"id": bullet["id"], "text": ""})
                seen.add(bullet["id"])
            report["topped_up"].append(block["id"])

    lowered = {t.lower(): t for t in all_tags}
    clean_skills = []
    for tag in (plan.get("skills") or []):
        exact = lowered.get(str(tag).strip().lower())
        if exact and exact not in clean_skills:
            clean_skills.append(exact)
        elif not exact:
            report["rejected_skills"].append(str(tag))
    # A handful of tags left standing means the model misread the list, and a
    # sidebar with three skills in it is worse than the master's own.
    if len(clean_skills) < 6:
        clean_skills = []

    headline = _WS.sub(" ", str(plan.get("headline") or "")).strip()
    if headline:
        foreign = _wrong_language(headline, language)
        if not foreign and len(_unfamiliar(headline, allowed, language)) >= 2:
            foreign = "not the master's"
        pronouns = _third_person(headline)
        if pronouns:
            report["off_voice"].extend(pronouns)
        if len(headline) > 110 or _new_terms(headline, allowed) or foreign or pronouns:
            report["invented"].extend(_new_terms(headline, allowed))
            if foreign:
                report["off_language"].append("headline")
            report["reverted"].append("headline")
            headline = ""

    summary = _WS.sub(" ", str(plan.get("summary") or "")).strip()
    if summary:
        bad = (_new_terms(summary, allowed) + _new_numbers(summary, inv["plain"])
               + _overstated_years(summary, user))
        foreign = _wrong_language(summary, language)
        pronouns = _third_person(summary)
        if pronouns:
            report["off_voice"].extend(pronouns)
        if bad or foreign or pronouns or len(summary) > 900:
            report["invented"].extend(bad)
            if foreign:
                report["off_language"].append("summary")
            report["reverted"].append("summary")
            summary = ""

    return ({"headline": headline, "summary": summary, "bullets": clean_bullets,
             "skills": clean_skills, "why": str(plan.get("why") or "").strip()},
            report)


# --------------------------------------------------------------------------
# Putting the plan back into the master's own HTML
# --------------------------------------------------------------------------

RE_GROUP_FULL = re.compile(
    r'<div class="skillgroup">\s*<h4>(.*?)</h4>\s*<div class="tags">(.*?)</div>\s*</div>',
    re.S)
RE_STRONG = re.compile(r"<strong>(.*?)</strong>", re.S)


def _escape(text: str) -> str:
    return html_lib.escape(text, quote=False)


def _bullet_html(source: Dict, rewrite: str) -> str:
    """
    A rewritten bullet that still looks like the master's bullets.

    Every bullet in the master opens with a bold lead-in -- "FEA simulation
    (Ansys/Abaqus):" -- and a rewrite arrives as one flat sentence. Dropping the
    bold for the rephrased ones would make the tailoring visible as a formatting
    seam, so the lead-in is put back: the master's own if the rewrite still
    starts with it, otherwise whatever the rewrite itself puts before its colon.
    """
    if not rewrite:
        return source["html"]
    strong = RE_STRONG.search(source["html"])
    lead = plain(strong.group(1)).rstrip(":") if strong else ""
    body = rewrite
    if lead and rewrite.lower().startswith(lead.lower()):
        body = rewrite[len(lead):].lstrip(" :–-")
        return f"<strong>{_escape(lead)}:</strong> {_escape(body)}"
    head, sep, tail = rewrite.partition(":")
    if sep and len(head) <= 60 and tail.strip():
        return f"<strong>{_escape(head.strip())}:</strong> {_escape(tail.strip())}"
    return _escape(rewrite)


def render(master_html: str, plan: Dict, inv: Dict, job: Dict) -> str:
    """The master with a different selection showing. Same stylesheet, same page."""
    out = master_html
    chosen = {b["id"]: b["text"] for b in plan.get("bullets") or []}
    order = [b["id"] for b in plan.get("bullets") or []]
    by_id = {b["id"]: b for j in inv["jobs"] for b in j["bullets"]}

    if plan.get("headline"):
        out = RE_ROLE.sub(
            lambda m: m.group(1) + _escape(plan["headline"]) + m.group(3), out, count=1)
    if plan.get("summary"):
        out = RE_SUMMARY.sub(
            lambda m: m.group(1) + "\n          " + _escape(plan["summary"])
            + "\n        " + m.group(3), out, count=1)

    counter = {"n": 0}

    def rewrite_job(match):
        counter["n"] += 1
        block = match.group(0)
        job_id = "j" + str(counter["n"])
        ids = [i for i in order if i.startswith(job_id + "b") and i in by_id]
        if not ids:
            return block
        items = "\n".join(
            "            <li>" + _bullet_html(by_id[i], chosen.get(i, "")) + "</li>"
            for i in ids)
        return RE_UL.sub(lambda m: m.group(1) + "\n" + items + "\n          " + m.group(3),
                         block, count=1)

    out = RE_JOB.sub(rewrite_job, out)

    skills = plan.get("skills") or []
    if skills:
        rank = {s.lower(): n for n, s in enumerate(skills)}

        def rewrite_group(match):
            title, tags_html = match.group(1), match.group(2)
            tags = [plain(t) for t in RE_SPAN.findall(tags_html)]
            keep = sorted([t for t in tags if t.lower() in rank],
                          key=lambda t: rank[t.lower()])
            if not keep:
                # Nothing in this group answers the advert. The sidebar is
                # 62mm wide; a group kept for completeness pushes out one that
                # was asked for.
                return ""
            spans = "".join("<span>" + _escape(t) + "</span>" for t in keep)
            return ('<div class="skillgroup">\n          <h4>' + title
                    + '</h4>\n          <div class="tags">' + spans
                    + "</div>\n        </div>")

        out = RE_GROUP_FULL.sub(rewrite_group, out)

    stamp = time.strftime("%Y-%m-%d %H:%M")
    company = _escape(str(job.get("company") or "this employer"))
    note = ("<!-- Tailored from the master CV for " + company + " on " + stamp
            + ". Every line traces back to cv_master. -->\n")
    return note + out


# --------------------------------------------------------------------------
# Printing
#
# The browser that is already a dependency of this project does the layout. No
# TeX, no wkhtmltopdf, no service: the master's @page rules are CSS, and the
# thing that understands CSS is right there.
# --------------------------------------------------------------------------

_CHROME_CANDIDATES = (
    os.getenv("CHROME_PATH", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)


def chrome_binary() -> str:
    for candidate in _CHROME_CANDIDATES:
        if candidate and Path(candidate).exists():
            return candidate
    for name in ("chrome", "google-chrome", "chromium", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            executable = p.chromium.executable_path
            if executable and Path(executable).exists():
                return str(executable)
    except Exception:
        pass
    return ""


def _owner_of(pdf_path: Path) -> str:
    """
    Whose papers these are, read off where they are kept.

    Every generated document sits at documents/<account>/<job>/<file>, so the
    folder two up is the account. The fallbacks below rebuild a page from the
    profile rather than from the HTML, and without this they rebuilt it from the
    default account's: Chaimaa's cover sheet came out with her photograph -- read
    from the HTML -- under Badreddine's name and address.
    """
    try:
        rel = Path(pdf_path).resolve().relative_to(documents.ROOT.resolve())
    except (ValueError, OSError):
        return ""
    return rel.parts[0] if len(rel.parts) >= 3 else ""


def html_to_pdf(html_path: Path, pdf_path: Path, log=None) -> bool:
    """
    True if a PDF came out. Uses headless Chromium or Playwright with container-safe flags.
    Falls back gracefully to master CV (for CVs) or ReportLab (for letters) so that
    applications and attachments NEVER fail to produce an authentic A4 PDF.
    """
    chrome = chrome_binary()
    if chrome:
        profile = tempfile.mkdtemp(prefix="mapjob_print_")
        try:
            cmd = [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-pdf-header-footer",
                "--disable-extensions",
                f"--user-data-dir={profile}",
                f"--print-to-pdf={pdf_path}",
                html_path.as_uri()
            ]
            res = subprocess.run(cmd, timeout=30, capture_output=True, check=False)
            if pdf_path.exists() and pdf_path.stat().st_size > 1000:
                if log:
                    log("PDF printed via Chrome headless")
                return True
            elif log and res.stderr:
                log(f"Chrome print notice: {res.stderr.decode('utf-8', errors='replace')[:150]}")
        except Exception as exc:
            if log:
                log("PDF printing with chrome failed: " + exc.__class__.__name__)
        finally:
            shutil.rmtree(profile, ignore_errors=True)

    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
            )
            page = browser.new_page()
            page.goto(html_path.as_uri(), wait_until="domcontentloaded", timeout=25000)
            page.emulate_media(media="print")
            page.pdf(
                path=str(pdf_path),
                format="A4",
                print_background=True,
                prefer_css_page_size=True
            )
            browser.close()
            if pdf_path.exists() and pdf_path.stat().st_size > 1000:
                if log:
                    log("PDF printed via Playwright")
                return True
    except Exception as exc:
        if log:
            log("Playwright PDF failed: " + exc.__class__.__name__)

    # Generator for CV: Converts tailored cv.html into an authentic A4 PDF via ReportLab
    if "cv" in pdf_path.name.lower():
        try:
            from services.automation import cv_pdf_writer
            if cv_pdf_writer.html_to_reportlab_cv_pdf(html_path, pdf_path):
                if log:
                    log("Tailored CV printed via ReportLab engine")
                return True
        except Exception as e:
            if log:
                log(f"ReportLab CV engine failed: {e}")

        # That file is Badreddine's CV. It is a stand-in for his account only:
        # for anyone else it would be somebody else's CV sent under their name,
        # and no attachment is better than that.
        from services.automation import people
        master_cv_file = Path(__file__).resolve().parent.parent.parent / "Badreddine_Barki_CV.pdf"
        if people.resolve(_owner_of(pdf_path)) == people.DEFAULT and master_cv_file.exists():
            try:
                pdf_path.parent.mkdir(parents=True, exist_ok=True)
                pdf_path.write_bytes(master_cv_file.read_bytes())
                if log:
                    log("Master CV PDF attached as emergency fallback")
                return True
            except Exception as e:
                if log:
                    log(f"Master CV emergency copy failed: {e}")

    # Fallback for letter: If headless browser fails, generate clean A4 letter via ReportLab
    if "letter" in pdf_path.name.lower():
        try:
            from services.automation import letter_pdf_writer
            if letter_pdf_writer.html_to_reportlab_pdf(html_path, pdf_path):
                if log:
                    log("Letter printed via ReportLab fallback")
                return True
        except Exception as e:
            if log:
                log(f"ReportLab fallback failed: {e}")

    # Fallback for deckblatt: If headless browser fails, generate clean A4 Deckblatt via ReportLab
    if "deckblatt" in pdf_path.name.lower():
        try:
            from services.automation import deckblatt_pdf_writer
            if deckblatt_pdf_writer.html_to_reportlab_deckblatt_pdf(
                    html_path, pdf_path, user=_owner_of(pdf_path) or None):
                if log:
                    log("Deckblatt printed via ReportLab fallback")
                return True
        except Exception as e:
            if log:
                log(f"ReportLab Deckblatt fallback failed: {e}")

    return pdf_path.exists() and pdf_path.stat().st_size > 1000


# --------------------------------------------------------------------------
# The letter
#
# letter_writer.py writes to employers who advertised nothing; this one answers
# an advert, which is a different letter with a different opening and a subject
# line carrying a reference. It borrows that module's allow-listed view of the
# profile rather than reading the profile itself: passwords sit next to the
# address in that file, and there is exactly one safe way to read it.
# --------------------------------------------------------------------------

from services.automation.letter_writer import (  # noqa: E402  (after the helpers it wraps)
    SIGN_OFF, greeting_for, language_for, safe_profile, unlabelled, _describe,
    _strip_frame,
)

LETTER_SYSTEM = (
    "You write job application letters that sound like the applicant and nothing "
    "like a template. You use only the facts you are given about the candidate. "
    "You never claim a qualification, a tool or a length of experience that is not "
    "in those facts, and you never pretend to know the company beyond the advert."
)

LETTER_HEADINGS = {
    "en": ("Application", "Dear Hiring Manager,"),
    "fr": ("Candidature", "Madame, Monsieur,"),
    "de": ("Bewerbung", "Sehr geehrte Damen und Herren,"),
}


def _letter_prompt(job: Dict, language: str, user: str = "") -> str:
    description = (job.get("description") or "").strip()
    if len(description) > 2500:
        description = description[:2500] + " [...]"
    names = {"de": "German", "fr": "French", "en": "English"}
    return (
        "Write the body of an application for this advertised vacancy.\n"
        "Language: " + names[language] + ".\n"
        "Length: three short paragraphs, under 200 words.\n"
        "Rules:\n"
        "- Invent nothing. Only the candidate facts below exist.\n"
        "- Name the role and one or two things the advert actually asks for, and "
        "answer them with something the candidate has really done.\n"
        "- No greeting and no sign-off: those are added around your text.\n"
        "- No markdown, no bullet points, no bracketed placeholders.\n"
        "- Do not promise a salary or a start date.\n\n"
        "THE VACANCY\n"
        "Title: " + str(job.get("title") or "") + "\n"
        "Company: " + str(job.get("company") or "") + "\n"
        "Location: " + str(job.get("location") or "") + "\n"
        "Advert:\n" + (description or "(only the title is known)")
        + "\n\nTHE CANDIDATE\n" + _describe(safe_profile(user or None))
    )


def _letter_fallback(job: Dict, language: str) -> str:
    title = str(job.get("title") or "the advertised role")
    company = str(job.get("company") or "your company")
    if language == "fr":
        return ("Je vous adresse ma candidature au poste de " + title + " au sein de "
                + company + ".\n\nIngénieur mécanique, j'ai conçu et simulé des "
                "ensembles mécaniques complexes en bureau d'études, de la CAO au "
                "calcul par éléments finis jusqu'aux essais.\n\nMon CV est joint et "
                "je reste à votre disposition pour un entretien.")
    if language == "de":
        return ("hiermit bewerbe ich mich auf die Stelle als " + title + " bei "
                + company + ".\n\nAls Maschinenbauingenieur habe ich komplexe "
                "Baugruppen konstruiert, simuliert und geprüft.\n\nMeinen "
                "Lebenslauf finden Sie im Anhang.")
    return ("I am writing to apply for the " + title + " position at " + company
            + ".\n\nI am a mechanical engineer with experience in CAD design, finite "
            "element analysis and physical testing of complex assemblies.\n\nMy CV is "
            "attached and I would welcome the chance to talk.")


def _supplied_letter(job: Dict) -> Optional[Dict[str, str]]:
    """
    A letter the caller wrote, if it wrote one.

    `letter_factory` rather than `letter` so that nothing is written when the
    documents are already on disk: `tailor` returns early for an unchanged
    advert, and a letter costs a model call whose output would be thrown away.
    """
    given = job.get("letter")
    if not given and callable(job.get("letter_factory")):
        try:
            given = job["letter_factory"]()
        except Exception:
            return None
    if not isinstance(given, dict):
        return None
    if not str(given.get("body") or "").strip():
        return None
    return {"language": str(given.get("language") or "en"),
            "subject": str(given.get("subject") or ""),
            "greeting": str(given.get("greeting") or ""),
            "body": str(given.get("body") or ""),
            "sign_off": str(given.get("sign_off") or ""),
            "fallback": bool(given.get("fallback"))}


def write_letter(job: Dict, language: str, log=None, user: str = "") -> Dict[str, str]:
    """Never raises and never returns nothing: an unpolished letter still applies."""
    body = ""
    try:
        client = FuelixClient()
        if client.has_credentials():
            body = _strip_frame(
                (client.chat_text(LETTER_SYSTEM, _letter_prompt(job, language, user),
                                  task="writer", temperature=0.6, max_tokens=700,
                                  timeout=45) or "").strip(),
                str(safe_profile(user or None).get("full_name") or ""))
    except Exception:
        body = ""
    fell_back = False
    if len(body) < 120 or "[" in body[:400]:
        body = _letter_fallback(job, language)
        fell_back = True
        if log:
            log("Letter fell back to the plain version")
    heading, default_greeting = LETTER_HEADINGS[language]
    subject = heading + " - " + str(job.get("title") or "")
    greeting = greeting_for({"company": job.get("company")}, language) or default_greeting
    # Same rule as the outreach letters: a letter does not announce what kind of
    # letter it is. This one is answering an advert and has less reason to, but
    # the model has the habit and one scrubber is better than two rules.
    return {"language": language, "subject": unlabelled(subject), "greeting": greeting,
            "body": unlabelled(body), "sign_off": SIGN_OFF[language], "fallback": fell_back}


# The letter's own stylesheet, and it is the CV's.
#
# Not "in the same spirit as": the same tokens, the same font stack, the same
# hairline, the same header. The two arrive in one email and are read one after
# the other, so the letter is the CV's first page with words on it instead of
# columns.
#
# What this deliberately does not have is decoration. It used to label its own
# parts -- a little uppercase "TO", "DATE & ORIGIN", "SUBJECT" over each block,
# the subject in a grey panel with a border, the recipient behind a thick rule,
# the signature set in 18pt italic Georgia. Five typographic ideas on a page
# that needs one, none of them shared with the CV, and the serif signature
# announced a different designer halfway down. A letter is a name, an address,
# a date, a line saying what it is about, and the writing; the only ornament
# kept is the black hairline under the letterhead, because the CV has it too.
LETTER_CSS = """
  :root { --bg:#ffffff; --border:#cfcfc9; --border-strong:#b7b7b0;
          --text:#000000; --text-dim:#1a1a1a; --muted:#5a5a54;
          --font:"Century Gothic", CenturyGothic, AppleGothic, "Futura",
                 "Trebuchet MS", "Segoe UI", sans-serif; }
  @page { size: A4; margin: 16mm 14mm; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; background-color: #f5f5f7; }
  body { font-family:var(--font); color:var(--text); background:var(--bg);
         font-size:9.8pt; line-height:1.62; letter-spacing:0.01em;
         padding: 16mm 14mm; max-width: 210mm; margin: 0 auto;
         box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08); }
  @media print {
    body { padding: 0; margin: 0; max-width: none; box-shadow: none; }
  }
  strong { font-weight:700; }

  /* ---------- Letterhead ---------- */
  .head { margin-bottom:5mm; }
  .head__name { font-size:26pt; font-weight:400; line-height:1.02;
                letter-spacing:-0.01em; }
  .head__name span { font-weight:700; }
  .head__role { text-transform:uppercase; letter-spacing:0.16em; font-size:8.5pt;
                color:var(--text-dim); margin:3mm 0 4mm; padding-bottom:3.5mm;
                border-bottom:1px solid var(--text); }
  .head__contact { display:flex; flex-direction:column; gap:0.5mm; font-size:8.5pt;
                   line-height:1.35; color:var(--muted);
                   border-left:1.5pt solid var(--text); padding-left:3.5mm; margin-top:3.5mm; }
  .head__sep { width:58%; margin:5mm auto 6mm; border-bottom:1px solid var(--border); }

  /* ---------- Who it is to, and when. One line each, no labels ---------- */
  .meta { display:flex; justify-content:space-between; align-items:flex-start;
          gap:8mm; margin-top:3mm; }
  /* The rule down the left is the only thing that says "this is the addressee".
     A label would say it in words and cost a line; the CV already uses a plain
     black hairline under the letterhead, so this is the same mark turned on its
     side rather than a second idea. */
  .meta__to { border-left:1.5pt solid var(--text); padding:0.4mm 0 0.8mm 3.2mm; }
  .meta__company { font-weight:700; font-size:10pt; }
  .meta__place { font-size:8.5pt; color:var(--muted); margin-top:0.8mm; }
  .meta__date { font-size:8.5pt; color:var(--muted); white-space:nowrap;
                text-align:right; }

  /* ---------- What it is about ---------- */
  .subject { margin-top:8mm; padding-bottom:2mm; border-bottom:1px solid var(--border);
             font-weight:700; font-size:10.5pt; }

  /* ---------- The writing ---------- */
  .body { margin-top:6mm; }
  .body .greeting { margin-bottom:4.5mm; }
  .body p { margin-bottom:4mm; text-align:justify; }
  .body p:last-child { margin-bottom:0; }

  /* ---------- Sign-off ---------- */
  .sign { margin-top:8mm; }
  .sign__name { margin-top:5mm; font-size:11pt; font-weight:400; }
  .sign__name span { font-weight:700; }
"""


def _tagline(job: Dict, profile: Dict) -> str:
    """
    The line under the name, and it is the CV's headline.

    Taking it from the tailored CV rather than from the profile keeps the pair
    saying the same thing: the CV calls him a mechanical engineer for this
    advert and so does the letter's letterhead. Only the first half -- a CV
    headline lists its specialisms after a bar, which is a paragraph's worth of
    words under a name.
    """
    headline = str(job.get("headline") or profile.get("current_title") or "").strip()
    headline = re.split(r"\s*[|·—–]\s*", headline)[0].strip()
    years = str(profile.get("years_of_experience") or "").strip()
    if years and not years.lower().endswith(("exp", "experience")):
        years = years + " years exp"
    return " &middot; ".join(_escape(x).upper() for x in (headline, years) if x)


def _emphasise(escaped: str, names: List[str]) -> str:
    """
    Bold the names a recruiter scans for: the company, the employers, the schools.

    Runs on already-escaped text and only ever wraps what is there -- no word is
    added, removed or changed, which is the same rule the CV's rewriting obeys.
    A recruiter reads the first line of each paragraph and the bold words; if
    the bold words are the employer's own name and the candidate's, the letter
    survives the six seconds it gets.
    """
    seen = set()
    for name in sorted((n.strip() for n in names if n and len(n.strip()) > 3),
                       key=len, reverse=True):
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        pattern = re.compile(r"(?<![\w>])(" + re.escape(_escape(name)) + r")(?![\w<])",
                             re.IGNORECASE)
        # Once per letter. The same company bolded in every paragraph is a
        # highlighter, not typography.
        escaped = pattern.sub(r"<strong>\1</strong>", escaped, count=1)
    return escaped


def letter_html(letter: Dict[str, str], job: Dict) -> str:
    profile = safe_profile(str(job.get("user") or "") or None)
    website = re.sub(r"^https?://", "", str(profile.get("website") or "").strip()).rstrip("/")
    contacts = "".join(
        "<span>" + _escape(str(v)) + "</span>" for v in (
            profile.get("full_address") or profile.get("city"),
            profile.get("email"),
            website,
            profile.get("phone_formatted") or profile.get("phone")) if v)

    names = [str(job.get("company") or "")]
    names += [str(e.get("company") or "") for e in (profile.get("experiences") or [])]
    names += [str(e.get("school") or e.get("institution") or "")
              for e in (profile.get("education") or [])]
    paragraphs = "\n    ".join(
        "<p>" + _emphasise(_escape(p.strip()), names) + "</p>"
        for p in re.split(r"\n\s*\n", letter["body"].strip()) if p.strip())

    today = time.strftime("%d %B %Y")
    city = _escape(str(profile.get("city") or ""))
    full_name = _escape(str(profile.get("full_name") or ""))
    parts = str(profile.get("full_name") or "").split()
    name_mark = (_escape(" ".join(parts[:-1])) + " <span>" + _escape(parts[-1]) + "</span>"
                 if len(parts) > 1 else full_name)

    subj = str(letter["subject"]).strip()
    tagline_raw = _tagline(job, profile)
    role_fallback = re.split(r"\s*[|·—–]\s*", tagline_raw)[0].strip() if tagline_raw else ""
    if not role_fallback:
        role_fallback = str(profile.get("current_title") or profile.get("headline") or "").strip()
        role_fallback = re.split(r"\s*[|·—–]\s*", role_fallback)[0].strip()

    if subj.lower() in ("bewerbung", "candidature", "application"):
        if letter["language"] == "de":
            subj = f"Bewerbung als {role_fallback}" if role_fallback else "Bewerbung"
        elif letter["language"] == "fr":
            subj = f"Candidature au poste de {role_fallback}" if role_fallback else "Candidature"
        else:
            subj = f"Application - {role_fallback}" if role_fallback else "Application"

    return (
        "<!DOCTYPE html>\n<html lang=\"" + letter["language"] + "\">\n<head>\n"
        "<meta charset=\"UTF-8\" />\n<title>"
        + full_name + " - " + _escape(subj)
        + "</title>\n<style>" + LETTER_CSS + "</style>\n</head>\n<body>\n"
        "  <header class=\"head\">\n"
        "    <h1 class=\"head__name\">" + name_mark + "</h1>\n"
        "    <p class=\"head__role\">" + tagline_raw + "</p>\n"
        "    <div class=\"head__contact\">" + contacts + "</div>\n"
        "  </header>\n"
        "  <div class=\"head__sep\"></div>\n"
        "  <section class=\"meta\">\n"
        "    <div class=\"meta__to\">\n"
        "      <div class=\"meta__company\">"
        + _escape(str(job.get("company") or "")) + "</div>\n"
        "      <div class=\"meta__place\">"
        + _escape(str(job.get("location") or "")) + "</div>\n"
        "    </div>\n"
        "    <div class=\"meta__date\">" + city + (", " if city else "") + today + "</div>\n"
        "  </section>\n"
        "  <p class=\"subject\">" + _escape(subj) + "</p>\n"
        "  <div class=\"body\">\n    <p class=\"greeting\">"
        + _escape(letter["greeting"]) + "</p>\n    "
        + paragraphs + "\n  </div>\n"
        "  <div class=\"sign\">\n"
        "    <div>" + _escape(letter["sign_off"]) + "</div>\n"
        "    <div class=\"sign__name\">" + name_mark + "</div>\n"
        "  </div>\n"
        "</body>\n</html>\n"
    )


# --------------------------------------------------------------------------
# The whole job
# --------------------------------------------------------------------------

def presentable(user: str = "") -> Tuple[set, str]:
    """
    The languages this account can honestly be presented in, and its own.

    Not the languages the app can typeset -- it can typeset any of them. A
    master is either a hand-written file, which exists in one language each, or
    the person's profile, whose sentences are in whatever language they wrote
    their CV in. Heading English bullets "BERUFSERFAHRUNG" does not make them
    German, it makes a CV that looks translated and is not, so a language with
    no master behind it is not offered.
    """
    who = (user or "").strip()
    files = {lang for lang in MASTERS if master_path(lang, who).exists()}

    from services.automation import people, profile_store
    profile = profile_store.public_profile(profile_store.profile_for(people.resolve(who)))
    own = str(profile.get("preferred_language") or "").strip().lower()
    if own not in MASTERS:
        # Nobody has said. Where they live is the next best evidence, and it is
        # the same test the letters use to pick a language for an employer.
        own = language_for({"city": profile.get("city") or "",
                            "website": profile.get("website") or ""})
    if own not in MASTERS:
        own = "en"

    if files:
        # A hand-written master is a document somebody checked. It counts even
        # when it is not in the language they nominated.
        return (files | ({own} if own in files else set()) or {own},
                own if own in files else ("en" if "en" in files else sorted(files)[0]))
    return {own}, own


def detect_language(job: Dict) -> str:
    """
    Which master to cut from. The employer's own domain and city decide it, the
    same way the outreach letters do, rather than a setting nobody remembers to
    change -- but only among the languages this person actually has a CV in.

    A caller that has already chosen -- the outreach run, which wrote the letter
    first -- says so, and is obeyed where it can be. An English letter arriving
    with a French CV is two documents from two different applications, and the
    letter is the one that was written for this employer.
    """
    ok, fallback = presentable(str(job.get("user") or ""))
    asked = str(job.get("language") or "").strip().lower()
    if asked in ok:
        return asked
    language = language_for({"website": job.get("url") or "",
                             "city": job.get("location") or ""})
    return language if language in ok else fallback


def fingerprint(job: Dict, language: str) -> str:
    """
    What the documents were made from, in sixteen characters.

    The advert is only half of it. Everything the tailoring reads has to be in
    here, or editing the master CV leaves every job already on disk frozen at
    the old version: today the master gained the candidate's current employer
    and not one existing document would have shown it, while the letter beside
    it named that employer in its first paragraph.
    """
    import hashlib
    import inspect
    try:
        source = read_master(language, str(job.get("user") or ""))
    except Exception:
        source = ""
    try:
        # The templates themselves. Redesign the letter and every document
        # already on disk would otherwise stay on the old design for ever,
        # which is how two applications went out looking nothing like the pair
        # in the Tailoring pane.
        source += LETTER_CSS + inspect.getsource(letter_html) + inspect.getsource(render)
    except (OSError, TypeError):
        pass
    parts = "|".join([str(job.get("title") or ""), str(job.get("company") or ""),
                      str(job.get("description") or "")[:MAX_DESCRIPTION], language,
                      str(job.get("user") or ""),
                      hashlib.sha1(source.encode("utf-8")).hexdigest()])
    return hashlib.sha1(parts.encode("utf-8")).hexdigest()[:16]


def tailor(job: Dict, force: bool = False, log=None) -> Dict:
    """
    A CV and a letter for this one listing, on disk, with the receipts.

    Re-running on an unchanged advert returns what is already there: tailoring
    twice for the same text costs a model call and produces a different-looking
    document for no reason, and "which version did they get" should have one
    answer. Editing the profile or the master changes the fingerprint, so the
    next run is a real run.
    """
    started = time.time()
    notes: List[str] = []

    def say(message: str):
        notes.append(message)
        if log:
            log(message)

    job_id = str(job.get("job_id") or job.get("id") or "").strip()
    if not job_id:
        raise ValueError("A tailored document has to belong to a job id.")

    # Whose application this is. Everything below that reads a person --
    # the master CV, the letter, the letterhead, the folder the files land
    # in -- takes it from here, so one account can never print on top of
    # the other's identity or read the other's documents.
    user = str(job.get("user") or "")

    language = detect_language(job)

    # A CV this run is not allowed to rewrite.
    #
    # A German dossier's Lebenslauf is a fixed document. It is written once,
    # signed, and sent to every employer unchanged, and a Lebenslauf that says
    # something different to each of them is not tailoring, it is forty
    # slightly different accounts of the same life. The same is true of the
    # Zeugnisse. So the caller hands over the file, this function prints
    # nothing for it, and the letter -- the part that really is about this
    # employer -- is written as usual.
    fixed_cv = Path(str(job.get("fixed_cv") or "")) if job.get("fixed_cv") else None
    if fixed_cv is not None and not fixed_cv.exists():
        say("The fixed CV is missing from disk - tailoring one instead")
        fixed_cv = None

    mark = fingerprint(job, language)
    if fixed_cv is not None:
        # Swapping the held Lebenslauf for a new one has to rebuild the pack,
        # or every job already on disk keeps the old one for ever.
        import hashlib as _hashlib
        mark = _hashlib.sha1(
            (mark + fixed_cv.name + str(fixed_cv.stat().st_mtime_ns))
            .encode("utf-8")).hexdigest()[:16]
    existing = documents.read_meta(job_id, user)
    if existing and not force and existing.get("fingerprint") == mark \
            and existing.get("files", {}).get("cv_pdf"):
        existing["reused"] = True
        return existing

    if fixed_cv is not None:
        # No master is read and no inventory taken: there is nothing to choose
        # bullets from, because nothing is being chosen.
        master = ""
        inv = {"headline": str(job.get("headline") or ""), "summary": "", "jobs": []}
    else:
        master = read_master(language, user)
        inv = inventory(master)
        say("Read the " + language.upper() + " master: "
            + str(sum(len(j["bullets"]) for j in inv["jobs"])) + " bullets to choose from")

    plan, report, model_used = {}, {}, ""
    try:
        client = FuelixClient()
        if fixed_cv is not None:
            pass
        elif client.has_credentials():
            raw = client.chat_json(SYSTEM, _prompt(inv, job, language), task="writer",
                                   temperature=0.2, max_tokens=2000, timeout=60)
            if raw:
                model_used = client.writer
                plan, report = verify(raw, inv, job, language, user)
                say("Kept " + str(len(plan["bullets"])) + " bullets"
                    + (", reverted " + str(len(report["reverted"])) + " rewrite(s)"
                       if report["reverted"] else ""))
            else:
                say("The model returned nothing usable - sending the master as it is")
        else:
            say("No model credentials - sending the master as it is")
    except Exception as exc:
        say("Tailoring failed (" + exc.__class__.__name__ + ") - master sent unchanged")

    if fixed_cv is not None:
        # Copied rather than pointed at, so the folder is still the record of
        # what was sent even if the held document is replaced tomorrow.
        documents.write_bytes(job_id, "cv", "pdf", fixed_cv.read_bytes(), user)
        say("Lebenslauf attached unchanged")
    else:
        cv_html = render(master, plan, inv, job) if plan else master
        documents.write_text(job_id, "cv", "html", cv_html, user)
        cv_file = documents.path_for(job_id, "cv", "html", user)
        cv_pdf = documents.path_for(job_id, "cv", "pdf", user)
        if html_to_pdf(cv_file, cv_pdf, say):
            say("CV printed")
        else:
            say("CV could not be printed to PDF - the HTML is still here")

    # The letter. A caller with its own writer hands one over -- the outreach
    # run does, because its letters know the prospect, greet the contact by
    # name and are written in German for a German employer, none of which the
    # advert-reading writer here can do. Either way it is printed through the
    # same template as the CV, so the pair looks like one application.
    letter = _supplied_letter(job) or write_letter(job, language, say, user)
    # The letterhead says what the CV's headline says -- the one the tailoring
    # just chose for this advert, not a second opinion about the same candidate.
    letterhead = dict(job, headline=plan.get("headline") or inv["headline"])
    documents.write_text(job_id, "letter", "html", letter_html(letter, letterhead), user)
    if html_to_pdf(documents.path_for(job_id, "letter", "html", user),
                   documents.path_for(job_id, "letter", "pdf", user), say):
        say("Letter printed")

    meta = {
        "job_id": job_id,
        "user": user,
        "title": job.get("title") or "",
        "company": job.get("company") or "",
        "location": job.get("location") or "",
        "url": job.get("url") or "",
        "language": language,
        "master": fixed_cv.name if fixed_cv is not None else master_path(language, user).name,
        "fixed_cv": bool(fixed_cv),
        "fingerprint": mark,
        "model": model_used,
        "tailored": bool(plan),
        "headline": plan.get("headline") or inv["headline"],
        "summary": plan.get("summary") or inv["summary"],
        "why": plan.get("why") or "",
        "bullets_kept": len(plan.get("bullets") or []),
        "bullets_available": sum(len(j["bullets"]) for j in inv["jobs"]),
        "skills_kept": plan.get("skills") or [],
        "report": report,
        "letter_subject": letter["subject"],
        "letter_fallback": letter["fallback"],
        # The letter's own words, kept beside the PDF. The outreach email sends
        # this as the message body -- half of recruiters read the mail and never
        # open an attachment -- and reading it back out of the printed PDF to
        # find out what was said would be absurd.
        "letter_language": letter.get("language") or language,
        "letter_greeting": letter.get("greeting") or "",
        "letter_body": letter.get("body") or "",
        "letter_sign_off": letter.get("sign_off") or "",
        "seconds": round(time.time() - started, 1),
        "log": notes,
    }
    return documents.save_meta(job_id, meta, user)


# What a letter is called in the language it is written in. The employer reads
# the filename before the file, and "Cover_letter" on a German application is
# the first word of it in the wrong language.
LETTER_NAME = {"de": "Anschreiben", "fr": "Lettre_de_motivation", "en": "Cover_letter"}


def _candidate_slug(user: str = "") -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_",
                  str(safe_profile(user or None).get("full_name")
                      or "Candidate")).strip("_") or "Candidate"


def attachment_copy(job_id: str, kind: str = "cv", language: str = "en",
                    user: str = "") -> Optional[str]:
    """
    The same PDF under the name an employer should see on it.

    On disk these are cv.pdf and letter.pdf, one pair per job, which is how the
    folder stays readable. But the filename travels: it is what appears in the
    recruiter's inbox and in the ATS's attachment list, and "cv.pdf" from an
    anonymous applicant is a worse first impression than the file deserves. So a
    named copy sits beside the original and that is what gets attached.
    """
    source = documents.path_for(job_id, kind, "pdf", user)
    if not source.exists():
        return None
    who = _candidate_slug(user)
    what = "CV" if kind == "cv" else LETTER_NAME.get(language, "Cover_letter")
    named = source.with_name(f"{who}_{what}.pdf")
    try:
        if not named.exists() or named.stat().st_mtime < source.stat().st_mtime:
            shutil.copy2(source, named)
    except Exception:
        return str(source)
    return str(named)


def ensure_for_job(job: Dict, log=None) -> Optional[str]:
    """
    The path an apply engine should attach, or nothing.

    Nothing is not a failure worth stopping an application over: the caller
    falls back to the standard CV, which is what it used to send every time.
    """
    try:
        meta = tailor(job, log=log)
    except Exception as exc:
        if log:
            log("Tailoring skipped: " + exc.__class__.__name__)
        return None
    job_id = str(job.get("job_id") or job.get("id") or "")
    return attachment_copy(job_id, "cv", str(meta.get("language") or "en"),
                           str(job.get("user") or ""))


def cv_for_application(job_id: str, title: str = "", company: str = "", location: str = "",
                       url: str = "", description: str = "", log=None,
                       language: str = "", user: str = "") -> str:
    """
    The CV one application should carry, or "" and the standard one.

    Applying used to send the same PDF to every employer, which is the thing the
    candidate noticed first: a CV written for nobody in particular, answering an
    advert it had never read. This reads the advert against the master CV and
    prints a version that leads with the parts this employer asked about.

    It cannot fail an application. Every way this can go wrong -- no job id, no
    model credentials, no Chrome to print with, a listing with no text in it --
    returns the empty string, and the run attaches what it always attached. Both
    engines call it, so neither can drift into sending something the other would
    not.
    """
    say = log or (lambda _message: None)
    if not job_id:
        return ""

    # Some people do not have a CV that gets rewritten. A German dossier's
    # Lebenslauf is fixed, so the honest answer here is the held document
    # itself: tailoring one would produce a second, different account of the
    # same life and attach it to a form under her name.
    try:
        from services.automation import deckblatt, people

        if people.application_style(user) == "german_dossier":
            held = deckblatt.lebenslauf(user)
            if held:
                say("Attaching the Lebenslauf as it is held; it is not rewritten "
                    "for an advert.")
                return str(held)
            say("No Lebenslauf is held, so a CV is cut from the master instead.")
    except Exception:  # noqa: BLE001 - never lose an application over this
        pass

    try:
        path = ensure_for_job({"job_id": job_id, "title": title or "", "company": company or "",
                               "location": location or "", "url": url or "",
                               "description": description or "",
                               "language": language or "", "user": user or ""}, log=say)
    except Exception as exc:
        say("Tailoring skipped (" + exc.__class__.__name__ + "); sending the standard CV.")
        return ""
    if path:
        say("CV tailored for this advert: " + os.path.basename(path))
    return path or ""


def application_for(job_id: str, title: str = "", company: str = "", location: str = "",
                    url: str = "", description: str = "", language: str = "",
                    letter_factory=None, force: bool = False, log=None,
                    fixed_cv: str = "", headline: str = "", user: str = "") -> Dict:
    """
    Both documents of one application, printed from the same templates.

    The pair, not the CV alone. An employer opens two attachments side by side,
    and until now the two came from two different machines: the apply engines
    printed this module's CV and letter through Chrome, while the outreach mail
    stapled a reportlab letter to the master CV. Same candidate, two typefaces,
    two layouts -- two applications in one envelope.

    `letter_factory` lets the caller keep its own author and still get this
    module's rendering. The outreach writer knows the prospect, greets the
    contact by name and writes German to a German employer; it is called only
    when documents are actually being printed, because an unchanged advert
    returns what is on disk and a wasted letter is a wasted model call.

    Returns {} for every failure. A campaign that cannot tailor still sends.
    """
    say = log or (lambda _message: None)
    if not job_id:
        return {}
    job = {"job_id": job_id, "title": title or "", "company": company or "",
           "location": location or "", "url": url or "",
           "description": description or "", "language": language or "",
           # Whose application. Without it the letterhead, the master CV and
           # the folder all default to the first account this app ever had.
           "user": user or ""}
    if fixed_cv:
        # The CV is handed over rather than cut: see `tailor`. The headline
        # comes with it, because there is no master to read one off.
        job["fixed_cv"] = fixed_cv
        job["headline"] = headline or ""
    if letter_factory is not None:
        job["letter_factory"] = letter_factory
    try:
        meta = tailor(job, force=force, log=say)
        if meta.get("reused") and letter_factory is not None                 and not str(meta.get("letter_body") or "").strip():
            # Documents from before the letter's words were kept beside them.
            # Re-printing once is cheaper than sending an email whose body does
            # not match the letter attached to it.
            meta = tailor(job, force=True, log=say)
    except Exception as exc:
        say("Tailoring skipped (" + exc.__class__.__name__ + ")")
        return {}
    cv = attachment_copy(job_id, "cv", str(meta.get("language") or "en"), user)
    letter_language = str(meta.get("letter_language") or meta.get("language") or "en")
    letter = attachment_copy(job_id, "letter", letter_language, user)
    if not cv or not letter:
        # Half a pair is worse than none: a tailored letter beside the master CV
        # is the mismatch this whole function exists to remove.
        say("Only one of the two documents printed - falling back")
        return {}
    pack = ""
    try:
        from services.automation import dossier
        merged = dossier.merge(Path(letter), cv,
                               Path(letter).with_name(_candidate_slug(user)
                                                      + "_Application.pdf"))
        pack = str(merged) if merged else ""
    except Exception:
        pack = ""
    return {"cv": cv, "letter": letter, "pack": pack, "meta": meta,
            "language": letter_language,
            "subject": str(meta.get("letter_subject") or ""),
            "greeting": str(meta.get("letter_greeting") or ""),
            "body": str(meta.get("letter_body") or ""),
            "sign_off": str(meta.get("letter_sign_off") or "")}


def master_gaps(language: str = "en", user: str = "") -> Dict:
    """
    Where the master CV and the profile disagree about the candidate's history.

    They can drift apart, and one direction of drift matters: the profile was
    updated with a new job and the master was not, so every tailored CV goes out
    missing the role the candidate currently holds while the letter -- which is
    written from the profile -- talks about it. That is not something to fix
    silently by writing sentences into somebody's CV. It is something to say.
    """
    try:
        inv = inventory(read_master(language, user))
    except Exception:
        return {"missing": [], "readable": False}
    in_master = " ".join(j["company"].lower() for j in inv["jobs"])
    missing = []
    for entry in (safe_profile(user or None).get("experiences") or []):
        if not isinstance(entry, dict):
            continue
        company = str(entry.get("company") or "").strip()
        if company and company.lower().split()[0] not in in_master:
            missing.append({"company": company,
                            "role": str(entry.get("role") or entry.get("title") or ""),
                            "period": str(entry.get("period") or "")})
    return {"missing": missing, "readable": True,
            "master": master_path(language, user).name,
            "jobs_in_master": [j["company"] for j in inv["jobs"]]}
