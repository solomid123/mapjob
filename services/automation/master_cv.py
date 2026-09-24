# -*- coding: utf-8 -*-
"""
A master CV built from the person's own profile.

Until now the master was two hand-written files in `cv_master/` -- one man's
name, one man's degree, one man's employers -- and everything downstream cut
from them. That works on this machine and nowhere else. A person who signs up
tomorrow, uploads their CV on the settings page and asks for a tailored one is
told "No master CV at C:/Users/.../cv_master/<them>/master_en.html", which is
not a missing feature, it is the product not working.

Their CV is already in the app. The upload is read into a profile -- name,
title, summary, jobs with their bullets, degrees, skills, languages -- and that
profile is the fact source the tailoring is allowed to use. So this module
renders that profile into the same document the hand-written masters are, with
the same class names, so the reader in `tailor` cannot tell the difference and
nothing downstream changes.

Two things it deliberately does not do:

  * It does not write anything new. Every line here comes from a field the
    person filled in or a CV they uploaded; nothing is invented, embellished or
    translated. The headings are translated -- the words around their words.
  * It does not overwrite the files in `cv_master/`. Where a hand-written
    master exists it stays the master; this is what happens when there is none.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, Iterable, List

# The CV's design, kept as a stylesheet of its own rather than lifted out of
# somebody's personal document at runtime.
CSS_PATH = Path(os.getenv("CV_MASTER_DIR",
                          str(Path(__file__).resolve().parent / "cv_master"))) / "master.css"

# The headings, and only the headings. The candidate's own sentences are
# printed in the language they wrote them in: a CV that translates itself is a
# CV claiming a fluency nobody checked.
WORDS = {
    "en": {"summary": "Professional summary", "experience": "Experience",
           "education": "Education", "skills": "Technical skills",
           "core": "Core", "languages": "Languages",
           "certs": "Certifications", "soft": "Strengths"},
    "fr": {"summary": "Résumé professionnel", "experience": "Expérience professionnelle",
           "education": "Formation", "skills": "Compétences techniques",
           "core": "Compétences clés", "languages": "Langues",
           "certs": "Certifications", "soft": "Compétences comportementales"},
    "de": {"summary": "Profil", "experience": "Berufserfahrung",
           "education": "Ausbildung", "skills": "Kenntnisse",
           "core": "Schwerpunkte", "languages": "Sprachen",
           "certs": "Zertifikate", "soft": "Stärken"},
}


def _escape(text: Any) -> str:
    return (str(text if text is not None else "")
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _text(row: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value not in (None, "", [], {}):
            return str(value).strip()
    return ""


def _listed(value: Any) -> List[str]:
    if isinstance(value, dict):
        return [str(v) for v in value.values() if v]
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if v]
    return [str(value)] if value else []


def _tags(items: Iterable[str]) -> str:
    return "".join("<span>" + _escape(i) + "</span>" for i in items)


def _skill_groups(profile: Dict[str, Any], words: Dict[str, str]) -> str:
    """
    The sidebar's skill blocks.

    A profile holds skills either as one flat list -- which is what reading a
    CV produces -- or already grouped, which is what somebody who has edited
    their profile by hand ends up with. Both render; a flat list becomes one
    group rather than fifteen headings with one tag under each.
    """
    skills = profile.get("technical_skills")
    groups: List[tuple] = []
    if isinstance(skills, dict):
        groups = [(str(k), _listed(v)) for k, v in skills.items() if v]
    elif skills:
        groups = [(words["core"], _listed(skills))]
    out = []
    for title, items in groups:
        if not items:
            continue
        out.append('        <div class="skillgroup">\n'
                   "          <h4>" + _escape(title) + "</h4>\n"
                   '          <div class="tags">' + _tags(items) + "</div>\n"
                   "        </div>")
    return "\n".join(out)


def _languages(profile: Dict[str, Any]) -> str:
    spoken = profile.get("languages")
    rows: List[tuple] = []
    if isinstance(spoken, dict):
        rows = [(str(k), str(v)) for k, v in spoken.items() if k]
    else:
        for item in _listed(spoken):
            name, _, level = item.partition(":")
            rows.append((name.strip(), level.strip()))
    return "\n".join(
        "          <li><span>" + _escape(name) + "</span><strong>"
        + _escape(level) + "</strong></li>" for name, level in rows if name)


def _certs(profile: Dict[str, Any]) -> str:
    out = []
    for item in (profile.get("certifications") or []):
        if isinstance(item, dict):
            name = _text(item, "name", "title", "label")
            when = _text(item, "year", "date", "period")
        else:
            name, when = str(item), ""
        if not name:
            continue
        out.append("          <li><span>" + _escape(name) + "</span><em>"
                   + _escape(when) + "</em></li>")
    return "\n".join(out)


def _jobs(profile: Dict[str, Any]) -> str:
    out = []
    for job in (profile.get("experiences") or []):
        if not isinstance(job, dict):
            continue
        company = _text(job, "company", "employer")
        role = _text(job, "role", "title", "position")
        place = _text(job, "location", "city")
        years = _text(job, "period", "dates", "years")
        bullets = [b for b in _listed(job.get("highlights") or job.get("bullets")) if b.strip()]
        if not (company or role):
            continue
        # The place span is printed even when it is empty: the reader in
        # `tailor` finds a company by the two closing tags around it, and a job
        # with no town would otherwise be a job it cannot see at all.
        out.append(
            '        <article class="job">\n'
            '          <div class="job__head">\n'
            '            <span class="job__company">' + _escape(company)
            + ' <span class="job__place">'
            + (("&mdash; " + _escape(place)) if place else "") + "</span></span>\n"
            '            <span class="job__years">' + _escape(years) + "</span>\n"
            "          </div>\n"
            '          <p class="job__role">' + _escape(role) + "</p>\n"
            "          <ul>\n"
            + "\n".join("            <li>" + _escape(b) + "</li>" for b in bullets)
            + "\n          </ul>\n"
            "        </article>")
    return "\n".join(out)


def _education(profile: Dict[str, Any]) -> str:
    out = []
    for row in (profile.get("education") or []):
        if not isinstance(row, dict):
            continue
        degree = _text(row, "degree", "qualification", "title")
        org = _text(row, "institution", "school", "university")
        place = _text(row, "location", "city")
        period = _text(row, "period", "dates", "years")
        note = _text(row, "note", "details", "description")
        if not (degree or org):
            continue
        out.append(
            '        <div class="edu">\n'
            '          <p class="edu__deg">' + _escape(degree) + "</p>\n"
            '          <p class="edu__org">' + _escape(org)
            + ((" &mdash; " + _escape(place)) if place else "") + "</p>\n"
            '          <p class="edu__meta">' + _escape(period) + "</p>\n"
            + ('          <p class="edu__note">' + _escape(note) + "</p>\n" if note else "")
            + "        </div>")
    return "\n".join(out)


def _block(title: str, body: str) -> str:
    if not body.strip():
        return ""
    return ('      <section class="block">\n'
            '        <h2 class="block__title">' + _escape(title) + "</h2>\n"
            + body + "\n      </section>\n")


def has_enough(profile: Dict[str, Any]) -> bool:
    """
    Whether there is a CV in here at all.

    A name and an email address is an account, not a curriculum vitae.
    Rendering that produces a letterhead with nothing underneath it, which is a
    worse thing to send than an honest "upload your CV first".
    """
    return bool(profile.get("full_name")) and bool(
        (profile.get("experiences") or []) or (profile.get("education") or []))


def build(profile: Dict[str, Any], language: str = "en") -> str:
    """The profile as a master CV, in the markup the hand-written ones use."""
    words = WORDS.get(language, WORDS["en"])
    name = str(profile.get("full_name") or "").strip()
    parts = name.split()
    masthead = (_escape(" ".join(parts[:-1])) + " <span>" + _escape(parts[-1]) + "</span>"
                if len(parts) > 1 else _escape(name))
    role = _text(profile, "headline", "current_title")

    contacts = [profile.get("full_address") or profile.get("city"),
                profile.get("email"),
                profile.get("phone_formatted") or profile.get("phone"),
                profile.get("website"), profile.get("linkedin")]
    contact_html = "".join("      <span>" + _escape(c) + "</span>\n"
                           for c in contacts if c)

    main = (_block(words["summary"],
                   '        <p class="summary">' + _escape(profile.get("summary") or "")
                   + "</p>") if profile.get("summary") else "")
    main += _block(words["experience"], _jobs(profile))
    main += _block(words["education"], _education(profile))

    side = _block(words["skills"], _skill_groups(profile, words))
    langs = _languages(profile)
    if langs:
        side += _block(words["languages"],
                       '        <ul class="kv">\n' + langs + "\n        </ul>")
    certs = _certs(profile)
    if certs:
        side += _block(words["certs"],
                       '        <ul class="certs">\n' + certs + "\n        </ul>")
    soft = _listed(profile.get("soft_skills"))
    if soft:
        side += _block(words["soft"], '        <div class="tags">' + _tags(soft) + "</div>")

    return ("<!DOCTYPE html>\n<html lang=\"" + _escape(language) + "\">\n<head>\n"
            "<meta charset=\"UTF-8\" />\n<title>" + _escape(name) + " &mdash; CV</title>\n"
            "<style>" + CSS_PATH.read_text(encoding="utf-8") + "</style>\n</head>\n<body>\n\n"
            '  <header class="head">\n'
            '    <h1 class="head__name">' + masthead + "</h1>\n"
            '    <p class="head__role">' + _escape(role) + "</p>\n"
            '    <div class="head__contact">\n' + contact_html + "    </div>\n"
            "  </header>\n\n"
            '  <div class="grid">\n    <main>\n' + main + "    </main>\n\n"
            '    <aside class="side">\n' + side + "    </aside>\n  </div>\n\n"
            "</body>\n</html>\n")
