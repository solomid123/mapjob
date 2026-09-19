# -*- coding: utf-8 -*-
"""
The paperwork: a cover letter as a PDF, and the pack it travels in.

An email body is read on a phone and forgotten. What survives inside a company
is the attachment somebody saves to a folder, so the letter exists twice: once
as plain text in the message, and once as a typeset page with the candidate's
address on it that a hiring manager can print.

The layout follows DIN 5008 for German letters, because German recruiters read
hundreds of these and a letter with the address block in the wrong place is
recognisably foreign before a word of it is read. French and English letters
use the same geometry -- it is a perfectly ordinary business layout elsewhere --
with the date line and sender block adjusted.

Rendering is reportlab rather than LaTeX. xelatex is installed on this machine
and would set a prettier page, but it shells out, needs a writable temp tree,
and takes a second or two per letter; over a two-hundred-employer campaign that
is a compile farm to produce a one-page letter. reportlab's built-in fonts are
WinAnsi-encoded, which covers every character German and French need.

Two files come out of each prospect:

  * the letter alone, which is what gets attached next to the CV, because an
    employer asking for "Lebenslauf und Anschreiben" wants two documents; and
  * the letter with the CV merged after it, which is what the Documents tab
    previews, because a reviewer wants to page through the whole application
    without opening two things.

Both live under `dossiers/`, named after the company and the date, so the
folder can be read by a human without opening anything.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from pathlib import Path
from typing import Dict, Optional

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas

from services.automation.candidate_profile import CANDIDATE_PROFILE
from services.automation.letter_writer import safe_profile

OUT_DIR = Path(__file__).with_name("dossiers")

PAGE_W, PAGE_H = A4

# DIN 5008 Form B, in millimetres from the left edge and the top.
LEFT = 25 * mm
RIGHT = PAGE_W - 20 * mm
ADDRESS_TOP = PAGE_H - 45 * mm      # where the recipient block begins
SUBJECT_TOP = PAGE_H - 98.46 * mm   # the norm's own measurement
BOTTOM = 25 * mm

BODY_FONT = "Helvetica"
BOLD_FONT = "Helvetica-Bold"
BODY_SIZE = 10.5
LEADING = 14.5

MONTHS_DE = ("Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
             "August", "September", "Oktober", "November", "Dezember")
MONTHS_FR = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet",
             "août", "septembre", "octobre", "novembre", "décembre")
MONTHS_EN = ("January", "February", "March", "April", "May", "June", "July",
             "August", "September", "October", "November", "December")


def _date_line(language: str, city: str, when: Optional[date] = None) -> str:
    when = when or date.today()
    if language == "de":
        return f"{city}, {when.day}. {MONTHS_DE[when.month - 1]} {when.year}"
    if language == "fr":
        return f"{city}, le {when.day} {MONTHS_FR[when.month - 1]} {when.year}"
    return f"{city}, {when.day} {MONTHS_EN[when.month - 1]} {when.year}"


def _safe_text(text: str) -> str:
    """
    Keep what WinAnsi can set, transliterate the rest.

    The built-in fonts cover Latin-1, which is every character German and
    French need. A model occasionally returns a typographic dash or a curly
    quote from outside it, and an unmapped glyph renders as a black box in the
    middle of a job application -- worse than the plain character it replaced.
    """
    swaps = {"’": "'", "‘": "'", "“": '"', "”": '"',
             "–": "-", "—": "-", "…": "...", " ": " ",
             " ": " ", "•": "-"}
    for bad, good in swaps.items():
        text = text.replace(bad, good)
    out = []
    for char in text:
        try:
            char.encode("cp1252")
            out.append(char)
        except UnicodeEncodeError:
            folded = unicodedata.normalize("NFKD", char)
            out.append("".join(c for c in folded if not unicodedata.combining(c)))
    return "".join(out)


def _wrap(canvas: pdfcanvas.Canvas, text: str, width: float,
          font: str = BODY_FONT, size: float = BODY_SIZE) -> list:
    """Greedy wrap against the real string widths of the chosen font."""
    lines = []
    for paragraph in text.split("\n"):
        if not paragraph.strip():
            lines.append("")
            continue
        line = ""
        for word in paragraph.split():
            trial = (line + " " + word).strip()
            if canvas.stringWidth(trial, font, size) <= width or not line:
                line = trial
            else:
                lines.append(line)
                line = word
        lines.append(line)
    return lines


def _slug(text: str, limit: int = 40) -> str:
    text = _safe_text(text or "").lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return (text[:limit] or "prospect").strip("_")


def _recipient_block(prospect: Dict[str, object]) -> list:
    """Whom the envelope would be addressed to, in postal order."""
    lines = []
    company = str(prospect.get("company") or "").strip()
    contact = str(prospect.get("contact_name") or "").strip()
    if company:
        lines.append(company)
    if contact:
        lines.append(contact if re.match(r"^(Frau|Herr|M\.|Mme)\b", contact)
                     else "z. Hd. " + contact if str(prospect.get("language")) == "de"
                     else contact)
    street = str(prospect.get("street") or "").strip()
    if street:
        lines.append(street)
    where = " ".join(x for x in (str(prospect.get("postcode") or "").strip(),
                                 str(prospect.get("city") or "").strip()) if x)
    if where:
        lines.append(where)
    if not street and not where:
        # No postal address on file. Say so rather than print a half-address:
        # a letter with a company name and nothing under it reads as unfinished.
        email = str(prospect.get("email") or "").strip()
        if email:
            lines.append(email)
    return lines


def render_letter(prospect: Dict[str, object], letter: Dict[str, str],
                  path: Path) -> Path:
    """One page, DIN 5008 geometry, no decoration."""
    profile = safe_profile()
    language = letter.get("language", "en")
    canvas = pdfcanvas.Canvas(str(path), pagesize=A4)
    canvas.setTitle(_safe_text(letter.get("subject", "")))
    canvas.setAuthor(_safe_text(str(profile.get("full_name") or "")))

    # Sender, small, above the recipient block -- the line that shows through a
    # window envelope above the address.
    sender_bits = [str(profile.get("full_name") or ""),
                   str(profile.get("address") or ""),
                   " ".join(x for x in (str(profile.get("postal_code") or ""),
                                        str(profile.get("city") or "")) if x)]
    canvas.setFont(BODY_FONT, 7.5)
    canvas.drawString(LEFT, ADDRESS_TOP + 12,
                      _safe_text(" · ".join(b for b in sender_bits if b)))

    canvas.setFont(BODY_FONT, BODY_SIZE)
    y = ADDRESS_TOP
    for line in _recipient_block({**prospect, "language": language}):
        canvas.drawString(LEFT, y, _safe_text(line))
        y -= LEADING

    # Contact details of the sender, right-hand column, where a German reader
    # looks for them.
    y_right = ADDRESS_TOP + 12
    canvas.setFont(BODY_FONT, 9)
    for line in (str(profile.get("email") or ""),
                 str(profile.get("phone_formatted") or profile.get("phone") or ""),
                 str(profile.get("linkedin") or "")):
        if line:
            text = _safe_text(line)
            canvas.drawRightString(RIGHT, y_right, text)
            y_right -= 12

    canvas.setFont(BODY_FONT, BODY_SIZE)
    canvas.drawRightString(RIGHT, SUBJECT_TOP + 22,
                           _safe_text(_date_line(language,
                                                 str(profile.get("city") or ""))))

    canvas.setFont(BOLD_FONT, BODY_SIZE)
    subject = _safe_text(letter.get("subject", ""))
    for line in _wrap(canvas, subject, RIGHT - LEFT, BOLD_FONT, BODY_SIZE):
        canvas.drawString(LEFT, SUBJECT_TOP, line)
        break  # a subject that needs two lines is a subject that needs cutting

    y = SUBJECT_TOP - 2 * LEADING
    canvas.setFont(BODY_FONT, BODY_SIZE)
    canvas.drawString(LEFT, y, _safe_text(letter.get("greeting", "")))
    y -= 2 * LEADING

    body = _safe_text(letter.get("body", ""))
    for line in _wrap(canvas, body, RIGHT - LEFT):
        if y < BOTTOM + 4 * LEADING:
            canvas.showPage()
            canvas.setFont(BODY_FONT, BODY_SIZE)
            y = PAGE_H - 30 * mm
        canvas.drawString(LEFT, y, line)
        y -= LEADING

    y -= LEADING
    canvas.drawString(LEFT, y, _safe_text(letter.get("sign_off", "")))
    y -= 2 * LEADING
    canvas.setFont(BOLD_FONT, BODY_SIZE)
    canvas.drawString(LEFT, y, _safe_text(str(profile.get("full_name") or "")))

    y -= 2.4 * LEADING
    canvas.setFont(BODY_FONT, 8.5)
    canvas.drawString(LEFT, y, _safe_text(
        {"de": "Anlagen: Lebenslauf",
         "fr": "Pièce jointe : curriculum vitae",
         "en": "Enclosure: curriculum vitae"}[language]))

    canvas.save()
    return path


def cv_path(language: str) -> str:
    """
    The CV to send.

    There is no German CV in the profile -- only `fr` and `en` -- so a German
    letter travels with the English one rather than with nothing. That is a gap
    worth filling, and it is better to know about it than to have the campaign
    quietly attach a French CV to a Berlin application.
    """
    resumes = CANDIDATE_PROFILE.get("resumes") or {}
    for key in (language, "en", "fr"):
        found = resumes.get(key)
        if found and Path(found).exists():
            return str(found)
    for found in resumes.values():
        if found and Path(found).exists():
            return str(found)
    return ""


def merge(letter_pdf: Path, cv_pdf: str, out: Path) -> Optional[Path]:
    """Letter first, CV after. Returns None if the merge is not possible."""
    try:
        from pypdf import PdfWriter
    except ImportError:
        return None
    try:
        writer = PdfWriter()
        writer.append(str(letter_pdf))
        if cv_pdf and Path(cv_pdf).exists():
            writer.append(cv_pdf)
        with open(out, "wb") as handle:
            writer.write(handle)
        writer.close()
        return out
    except Exception:  # noqa: BLE001 - a broken CV file must not stop the letter
        return None


def build(prospect: Dict[str, object], letter: Dict[str, str],
          out_dir: Optional[Path] = None) -> Dict[str, str]:
    """
    Everything on disk for one application.

    Returns {letter_pdf, cv_pdf, pack_pdf}. `pack_pdf` may be empty; the other
    two are what the message attaches.
    """
    directory = Path(out_dir or OUT_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    stem = f"{date.today():%Y%m%d}_{_slug(str(prospect.get('company') or ''))}"
    language = letter.get("language", "en")

    name = {"de": "Anschreiben", "fr": "Lettre_de_motivation",
            "en": "Cover_letter"}[language]
    letter_pdf = directory / f"{stem}_{name}.pdf"
    render_letter(prospect, letter, letter_pdf)

    cv = cv_path(language)
    pack = merge(letter_pdf, cv, directory / f"{stem}_Bewerbung.pdf")

    return {"letter_pdf": str(letter_pdf), "cv_pdf": cv,
            "pack_pdf": str(pack) if pack else ""}

