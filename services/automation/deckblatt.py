# -*- coding: utf-8 -*-
"""
The Deckblatt: the cover sheet a German application opens with.

A German Bewerbung is not a letter with a CV stapled to it. It is a bound
dossier that opens on a cover sheet -- photograph, name, contact details, and
in large type the word BEWERBUNG with the post underneath it -- and then runs
Anschreiben, Lebenslauf, Zeugnisse. Sending the Anschreiben alone is not a
lighter application; to the person opening it, it is an incomplete one.

Of that dossier exactly two things change from one employer to the next:

  * the Anschreiben, which `letter_writer` already writes, in German, to a
    named contact where there is one; and
  * the line under BEWERBUNG -- "als <the post>" -- which is this module.

Everything else is fixed and is held in the library: the Lebenslauf, the
Zeugnisse, the certificates. That is deliberate and it is not laziness. A
Lebenslauf rewritten per advert is a CV that says something different to every
employer, and an IHK-recognised qualification does not become a different
qualification because a different company is reading about it.

The geometry here follows a cover sheet that already exists and has already
been sent: A4, a card inset from the left with the photograph sitting on its
edge, the name beside it, the title block anchored near the foot of the page.
Keeping to it means the tailored sheet is the same document, with the post
line answering the advert instead of being typed in by hand.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional

from services.automation import document_library as library
from services.automation import documents
from services.automation import profile_store
from services.automation import tailor

# What of a person may be printed on a cover sheet. An allow-list, and a second
# one rather than a reuse of `letter_writer.PROFILE_FIELDS`, because those two
# lists answer different questions: that one is "what may be shown to a language
# model", this one is "what may be typeset onto page one". Gender belongs here
# and not there -- it decides Kauffrau or Kaufmann and nothing else, and it has
# no business in a prompt. Both are allow-lists, so the day somebody adds a
# field to the profile defaults it does not silently appear on the sheet.
SHEET_FIELDS = (
    "first_name", "last_name", "full_name", "email", "phone_formatted", "phone",
    "address", "postal_code", "city", "country", "full_address",
    "current_title", "headline", "gender",
)

# The palette of the sheet this follows. Names rather than numbers at the call
# sites, so a change of colour is one edit and not a search for "#144130".
INK = "#144130"        # the name and BEWERBUNG
GREY = "#64696E"       # contact lines and the post
RULE = "#B4BAC3"       # the card border and the ring round the photograph
CARD = "#F9FAFC"

# Gendered German job titles, as adverts write them. The feminine form is only
# ever chosen when the profile says so: guessing somebody's gender from their
# first name to decide how to address them in their own application is exactly
# the kind of clever that produces a Kaufmann on a woman's cover sheet.
_PAIRS = (
    (r"Kaufmann/-?frau", "Kauffrau", "Kaufmann"),
    (r"Kauffrau/-?mann", "Kauffrau", "Kaufmann"),
    (r"\bzum/zur\b", "zur", "zum"),
    (r"\bzur/zum\b", "zur", "zum"),
    (r"/-?in\b", "in", ""),
)

# What an advert's title carries that a cover sheet must not: the legal
# gender marker, the reference number, the contract note in brackets.
_NOISE = (
    r"\(\s*[mwdfx]\s*[/|]\s*[mwdfx]\s*(?:[/|]\s*[mwdfx]\s*)?\)",  # (m/w/d)
    r"\bm\s*/\s*w\s*/\s*[dx]\b",
    r"\(\s*(?:vollzeit|teilzeit|befristet|unbefristet)[^)]*\)",
    r"\b(?:ref\.?|kennziffer|stellen-?nr\.?)\s*[:\s]\s*\S+",
    r"\bab\s+(?:sofort|\d{2}\.\d{2}\.\d{4}|\w+\s+\d{4})\b",
    r"\b(?:20\d\d)\s*/\s*(?:20\d\d)\b",
)

_STARTERS = (
    r"^ausbildung\s+(?:zum/zur|zum|zur|als)\s+",
    r"^ausbildungsplatz\s+(?:zum/zur|zum|zur|als)\s+",
    r"^ausbildung\s*[:\-–]\s*",
    r"^stellenangebot\s*[:\-–]\s*",
    r"^als\s+",
)


def sheet_profile(user: Optional[str] = None) -> Dict[str, str]:
    """The person, reduced to what may be printed. Everything else is dropped,
    including the two keys that are passwords."""
    source = profile_store.profile_for(user)
    return {key: str(source.get(key) or "").strip() for key in SHEET_FIELDS}


def _feminine(user: Optional[str]) -> Optional[bool]:
    """
    True, False, or "the record does not say" -- and the third is common.

    Nothing here infers it. A blank answer means the advert's own wording is
    kept exactly as the employer wrote it, which is never wrong, only clumsy.
    """
    said = sheet_profile(user).get("gender", "").lower()
    if said[:1] in ("f", "w"):      # female, féminin, weiblich
        return True
    if said[:1] in ("m", "h"):      # male, masculin, männlich, homme
        return False
    return None


def post_line(job: Dict[str, Any], user: Optional[str] = None) -> str:
    """
    The post, as it goes under BEWERBUNG, without the leading "als".

    Taken from the advert rather than from a setting: the sheet should name the
    job the employer advertised, in the employer's words, because that is what
    the person reading it is matching against their own vacancy list.
    """
    title = str(job.get("title") or job.get("job_title") or "").strip()
    if not title:
        # No advert -- a speculative application. Then the post is what this
        # person is looking for, which their record does know.
        title = sheet_profile(user).get("current_title", "")
    if not title:
        return ""

    for pattern in _NOISE:
        title = re.sub(pattern, " ", title, flags=re.I)
    for pattern in _STARTERS:
        title = re.sub(pattern, "", title.strip(), flags=re.I)

    she = _feminine(user)
    if she is not None:
        for pattern, female, male in _PAIRS:
            title = re.sub(pattern, female if she else male, title, flags=re.I)

    # Whatever is left after a dash at the end is usually the employer's own
    # note -- a location, a start date, a department -- and not the post.
    title = re.sub(r"\s*[–—|]\s*$", "", title)
    title = re.sub(r"\s{2,}", " ", title).strip(" ,;:-–—")
    return title


def specialisation(job: Dict[str, Any], user: Optional[str] = None) -> str:
    """
    The quieter second line: a Fachrichtung, a recognition, a qualification.

    It comes from the profile, not the advert. It says something true about the
    applicant that stays true whoever is reading -- "Fachrichtung Außenhandel -
    IHK-FOSA anerkannt" is not a claim about this vacancy -- so an advert that
    happens to omit it must not delete it from the sheet.
    """
    return sheet_profile(user).get("headline", "")


def _photo(user: Optional[str]) -> str:
    """
    The application photograph, inlined so the printed page needs no files.

    Held in the library like every other document, under the "photo" kind. When
    there is none the sheet still prints: a grey ring where the photograph goes
    is a cover sheet somebody can look at and fix, and a failed build is not.
    """
    for row in library.all_documents(user=user, kind="photo"):
        # By id, not from the row in hand. `all_documents` hands back rows the
        # browser may see, and those have had `storage_path` taken off them, so
        # there is nothing in them to find bytes with.
        path = library.path_of(str(row.get("id")), user=user)
        if not path or not path.exists():
            continue
        mime = row.get("mime") or mimetypes.guess_type(path.name)[0] or "image/jpeg"
        if not str(mime).startswith("image/"):
            continue
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        return "data:" + str(mime) + ";base64," + data
    return ""


def _escape(text: str) -> str:
    return (str(text or "").replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


# The typeface the original sheet is set in, and what to do without it. Century
# Gothic is licensed and is not in this repository; when the files are put in
# the folder below they are embedded, and when they are not the stack falls to
# the nearest geometric sans the machine has. The layout is in millimetres and
# does not move either way -- a substituted font changes the texture of the
# page, not where anything sits on it.
FONT_DIR = Path(os.getenv(
    "DECKBLATT_FONT_DIR",
    str(Path(__file__).resolve().parent / "cv_master" / "fonts"),
))
FONT_FAMILY = ("'Century Gothic', 'URW Gothic', Questrial, Futura, "
               "'Trebuchet MS', Arial, sans-serif")

_FONT_FILES = (("CenturyGothic-Regular.ttf", "normal"),
               ("CenturyGothic-Bold.ttf", "bold"))


def _fonts() -> str:
    faces = []
    for name, weight in _FONT_FILES:
        path = FONT_DIR / name
        if not path.exists():
            continue
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        faces.append(
            "@font-face{font-family:'Century Gothic';"
            "src:url('data:font/truetype;charset=utf-8;base64," + data + "')"
            " format('truetype');font-weight:" + weight + ";font-style:normal;}")
    return "".join(faces)


# The three little marks beside the contact lines, drawn rather than fetched: a
# cover sheet that needs the network to render is a cover sheet that renders
# differently on the day the network is slow.
_PIN = ('<svg width="7" height="11" viewBox="0 0 7 11" fill="none">'
        '<circle cx="3.5" cy="2.8" r="2.2" fill="' + INK + '"/>'
        '<line x1="3.5" y1="2.8" x2="3.5" y2="10" stroke="' + INK + '"'
        ' stroke-width="1.1" stroke-linecap="round"/></svg>')

_PHONE = ('<svg width="10" height="10" viewBox="-0.15 -0.15 0.3 0.3" fill="none">'
          '<path d="M -0.06,0.08 L -0.02,0.08 L 0.01,0.03 L -0.02,0.00 L 0.03,-0.05'
          ' L 0.06,-0.02 L 0.09,-0.05 L 0.09,-0.09 L 0.05,-0.11 L -0.03,-0.07 Z"'
          ' stroke="' + INK + '" stroke-width="0.025" stroke-linecap="round"'
          ' stroke-linejoin="round" fill="none"/></svg>')

_MAIL = ('<svg width="11" height="8" viewBox="-0.15 -0.10 0.30 0.20" fill="none">'
         '<rect x="-0.12" y="-0.07" width="0.24" height="0.14" rx="0.015"'
         ' stroke="' + INK + '" stroke-width="0.022"/>'
         '<path d="M -0.12,0.07 L 0,-0.01 L 0.12,0.07" stroke="' + INK + '"'
         ' stroke-width="0.02" stroke-linecap="round" stroke-linejoin="round"/></svg>')


def _lines(profile: Dict[str, str]) -> list:
    """
    The contact block: address, phone, email, each only if there is one.

    An empty row printed anyway leaves a bare icon floating beside nothing,
    which reads as a document that failed rather than as a detail withheld.
    """
    town = " ".join(p for p in (profile.get("postal_code"),
                                profile.get("city")) if p).strip()
    where = profile.get("full_address") or ", ".join(
        part for part in (profile.get("address"), town, profile.get("country"))
        if part)
    rows = []
    for icon, text in ((_PIN, where),
                       (_PHONE, profile.get("phone_formatted") or profile.get("phone")),
                       (_MAIL, profile.get("email"))):
        if text:
            rows.append('<div class="contact-row"><span class="contact-icon">'
                        + icon + "</span><span>" + _escape(text) + "</span></div>")
    return rows


_PAGE = """<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>Deckblatt</title>
<style>
__FONTS__
@page { size: 210mm 297mm; margin: 0; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  width: 210mm; height: 297mm; background: #FFFFFF;
  font-family: __FAMILY__;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  overflow: hidden; position: relative;
}
.page { position: relative; width: 210mm; height: 297mm; background: #FFFFFF; overflow: hidden; }
/* Wider than the space left to the right of it, so it runs off the page edge
   rather than stopping short of it: the card is a band, not a box. */
.card-box {
  position: absolute; left: 50mm; top: 18mm; width: 175mm; height: 254mm;
  background-color: __CARD__; border: 0.9pt solid __RULE__;
  border-radius: 6mm; pointer-events: none;
}
.photo-outer {
  position: absolute; left: 27.5mm; top: 35.5mm; width: 45mm; height: 45mm;
  border-radius: 50%; background-color: #FFFFFF; border: 1.4pt solid __RULE__;
  display: flex; align-items: center; justify-content: center; z-index: 10;
}
.photo-inner {
  position: relative; width: 42.4mm; height: 42.4mm; border-radius: 50%;
  border: 1.1pt solid __RULE__; overflow: hidden; background-color: #FFFFFF;
}
.photo-inner img {
  position: absolute; width: 49mm; left: 50%; top: 50%;
  transform: translate(calc(-50% + 2.2mm), calc(-50% + 2.2mm)); display: block;
}
.candidate-name {
  position: absolute; left: 78mm; top: 34.2mm; font-weight: bold;
  font-size: 27pt; line-height: 31pt; color: __INK__; z-index: 10;
  letter-spacing: 0.2pt;
}
.candidate-name .first-name { display: block; margin-bottom: 1.5mm; }
.candidate-name .last-name { display: block; }
.contact-details {
  position: absolute; left: 78mm; top: 58.5mm; font-size: 10pt;
  line-height: 15.5pt; color: __GREY__; z-index: 10;
}
.contact-row { display: flex; align-items: center; margin-bottom: 1.2mm; white-space: nowrap; }
.contact-row:last-child { margin-bottom: 0; }
.contact-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; margin-right: 6.5px; flex-shrink: 0;
}
.contact-icon svg { display: block; }
.bottom-title-block { position: absolute; left: 62mm; bottom: 39mm; z-index: 10; }
.title-bewerbung {
  font-size: 31pt; line-height: 37pt; font-weight: bold; color: __INK__;
  margin-bottom: 4mm; letter-spacing: 0.3pt;
}
/* A post that runs long wraps instead of sliding off the page: adverts write
   titles of six words and the sheet has to take them. */
.subtitle-target {
  font-size: 13pt; line-height: 17pt; font-weight: bold; color: __GREY__;
  margin-bottom: 1.8mm; max-width: 132mm;
}
.subtitle-specialization {
  font-size: 11.5pt; line-height: 15.5pt; color: __GREY__; max-width: 132mm;
}
</style>
</head>
<body>
<div class="page">
  <div class="card-box"></div>
  <div class="photo-outer"><div class="photo-inner">__PHOTO__</div></div>
  <div class="candidate-name">__NAME__</div>
  <div class="contact-details">__CONTACT__</div>
  <div class="bottom-title-block">__TITLE__</div>
</div>
</body>
</html>
"""


def sheet_html(job: Dict[str, Any], user: Optional[str] = None) -> str:
    """
    The whole cover sheet, as one self-contained page.

    Self-contained on purpose: the photograph is inlined, the icons are drawn,
    the fonts are embedded when they are there. The file can be opened in a
    year, printed from another machine, or attached as it stands, and it will
    be the page that was sent.
    """
    profile = sheet_profile(user)
    whole = profile.get("full_name", "").split()
    first = profile.get("first_name") or (whole[0] if whole else "")
    last = profile.get("last_name") or " ".join(whole[1:])

    name_block = ""
    if first:
        name_block += '<span class="first-name">' + _escape(first.upper()) + "</span>"
    if last:
        name_block += '<span class="last-name">' + _escape(last.upper()) + "</span>"

    photo = _photo(user)
    photo_block = ('<img src="' + photo + '" alt="">') if photo else ""

    title_block = '<div class="title-bewerbung">BEWERBUNG</div>'
    post = post_line(job, user)
    if post:
        title_block += '<div class="subtitle-target">als ' + _escape(post) + "</div>"
    extra = specialisation(job, user)
    if extra:
        title_block += ('<div class="subtitle-specialization">'
                        + _escape(extra) + "</div>")

    return (_PAGE
            .replace("__FONTS__", _fonts())
            .replace("__FAMILY__", FONT_FAMILY)
            .replace("__CARD__", CARD)
            .replace("__RULE__", RULE)
            .replace("__INK__", INK)
            .replace("__GREY__", GREY)
            .replace("__PHOTO__", photo_block)
            .replace("__NAME__", name_block)
            .replace("__CONTACT__", "".join(_lines(profile)))
            .replace("__TITLE__", title_block))


def build(job: Dict[str, Any], user: Optional[str] = None,
          job_id: str = "", log=None) -> Dict[str, Any]:
    """
    Write the sheet for one advert and print it, beside that job's other papers.

    Reports what exists rather than what was attempted. The HTML is written
    first and kept even when the print fails: a sheet that can be opened and
    printed by hand is a recoverable afternoon, and a missing file is not.
    """
    job_id = str(job_id or job.get("id") or job.get("job_id") or "speculative")
    html_path = documents.write_text(job_id, "deckblatt", "html",
                                     sheet_html(job, user), user or "")
    pdf_path = documents.path_for(job_id, "deckblatt", "pdf", user or "")
    printed = tailor.html_to_pdf(html_path, pdf_path, log=log)
    if not printed:
        try:
            from services.automation import deckblatt_pdf_writer
            printed = deckblatt_pdf_writer.generate_deckblatt_pdf(job, pdf_path, user=user)
            if printed and log:
                log("Deckblatt printed via ReportLab fallback")
        except Exception as e:
            if log:
                log(f"ReportLab Deckblatt fallback failed: {e}")
    if log and not printed:
        log("The Deckblatt was written but could not be printed")

    return {
        "job_id": job_id,
        "post": post_line(job, user),
        "html": str(html_path),
        "pdf": str(pdf_path) if printed else "",
        "photo": bool(_photo(user)),
    }


def lebenslauf(user: Optional[str] = None) -> Optional[Path]:
    """
    The CV that goes in the dossier: the held master, as it is.

    Not a tailored one. The master CV is already the document this person
    uploaded and checked, and in a German dossier it is the Lebenslauf -- a
    signed, dated page of fact that does not get rewritten because a different
    company is reading it.
    """
    row = library.master_cv(user)
    if not row:
        return None
    path = library.local_copy(row)
    return path if path and path.exists() and path.suffix.lower() == ".pdf" else None


def pack(job: Dict[str, Any], letter_pdf: str = "", document_ids: Optional[list] = None,
         user: Optional[str] = None, job_id: str = "", log=None) -> Dict[str, Any]:
    """
    The whole application as one file: Deckblatt, Anschreiben, Lebenslauf,
    Zeugnisse -- in that order, which is the only order it is read in.

    Bound rather than attached loose, and bound even when the chooser said
    separate files, because a Deckblatt on its own is not a document: it is
    page one of something. What the chooser decides is which certificates are
    in the pack, not whether the pack exists.

    Returns the bound file and the pieces it was made of. An empty "pdf" means
    the binding failed -- pypdf missing, a file that will not open -- and the
    caller should fall back to sending the pieces, which is a worse-looking
    application and still an application.
    """
    say = log or (lambda _message: None)
    job_id = str(job_id or job.get("id") or job.get("job_id") or "speculative")

    sheet = build(job, user=user, job_id=job_id, log=log)
    if not sheet.get("photo"):
        say("No application photograph is held, so the Deckblatt has an empty "
            "circle where one goes")

    pieces: list = []
    if sheet.get("pdf"):
        pieces.append(Path(sheet["pdf"]))
    else:
        say("The Deckblatt did not print, so the dossier opens on the letter")
    if letter_pdf and Path(letter_pdf).exists():
        pieces.append(Path(letter_pdf))

    cv = lebenslauf(user)
    if cv:
        pieces.append(cv)
    else:
        say("No Lebenslauf is held: upload one in Settings and it becomes the "
            "master CV the dossier carries")

    held = []
    for row in library.chosen(list(document_ids or []), user=user):
        path = library.local_copy(row)
        if path and path.exists() and path.suffix.lower() == ".pdf":
            pieces.append(path)
            held.append(str(row.get("title") or row.get("filename")))
        else:
            say(str(row.get("title") or row.get("filename"))
                + " could not be bound into the dossier and was left out")

    from services.automation import dossier as binder

    out = documents.path_for(job_id, "dossier", "pdf", user or "")
    bound = binder.bind(pieces, out) if len(pieces) > 1 else None
    if bound:
        say("Dossier bound: " + str(len(pieces)) + " documents in one file")

    return {
        "job_id": job_id,
        "pdf": str(bound) if bound else "",
        "deckblatt": sheet.get("pdf") or "",
        "post": sheet.get("post") or "",
        "lebenslauf": str(cv) if cv else "",
        "zeugnisse": held,
        "pieces": [str(p) for p in pieces],
    }
