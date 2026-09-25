# -*- coding: utf-8 -*-
"""
ReportLab PDF generator for German Deckblatt (cover sheet).
Converts Deckblatt data/HTML into an authentic, pixel-perfect A4 PDF
matching MapJob's German dossier design with zero browser dependencies.
"""

from __future__ import annotations

import base64
import io
import re
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas as pdfcanvas
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader

from services.automation.fonts_setup import setup_fonts
from services.automation import profile_store
from services.automation import document_library as library

PAGE_W, PAGE_H = A4  # 210mm x 297mm

# Palette
INK = colors.HexColor("#144130")
GREY = colors.HexColor("#64696E")
RULE = colors.HexColor("#B4BAC3")
CARD_BG = colors.HexColor("#F9FAFC")
WHITE = colors.HexColor("#FFFFFF")


def _clean_text(s: str) -> str:
    return re.sub(r'<[^>]+>', '', s or '').strip()


def _detect_user(html_path: Optional[Path] = None, pdf_path: Optional[Path] = None,
                 user: Optional[str] = None, html_content: str = "") -> Optional[str]:
    """Resolves the candidate account (e.g. 'chaimaa' or 'badreddine') from path or HTML."""
    if user and user.strip():
        return user.strip().lower()

    paths = [p for p in (html_path, pdf_path) if p]
    for p in paths:
        for part in p.parts:
            low = part.lower()
            if low in ("chaimaa", "badreddine"):
                return low

    if html_content:
        content_low = html_content.lower()
        if "chaimaa" in content_low:
            return "chaimaa"
        if "badreddine" in content_low:
            return "badreddine"

    return None


def _find_photo_image(user: Optional[str] = None, html_content: str = "") -> Optional[ImageReader]:
    """Finds photo from inlined base64 HTML or document library."""
    if html_content:
        m = re.search(r'src="data:image/[^;]+;base64,([^"]+)"', html_content)
        if m:
            try:
                raw_bytes = base64.b64decode(m.group(1))
                return ImageReader(io.BytesIO(raw_bytes))
            except Exception:
                pass

    try:
        for row in library.all_documents(user=user, kind="photo"):
            path = library.path_of(str(row.get("id")), user=user)
            if path and path.exists() and path.stat().st_size > 500:
                return ImageReader(str(path))
    except Exception:
        pass

    return None


def generate_deckblatt_pdf(job: Optional[Dict[str, Any]] = None, pdf_path: Optional[Path] = None,
                           user: Optional[str] = None, html_content: str = "",
                           name_first: str = "", name_last: str = "",
                           where: str = "", phone: str = "", email: str = "",
                           post: str = "", extra: str = "") -> bool:
    """
    Renders an authentic A4 Deckblatt PDF directly using ReportLab canvas.
    Parses exact candidate information from HTML when available, ensuring
    photo, name, and contacts always belong to the same candidate.
    """
    if pdf_path is None:
        return False

    try:
        from services.automation import deckblatt

        job = job or {}
        user = _detect_user(pdf_path=pdf_path, user=user, html_content=html_content)

        # 1. Parse from HTML if provided
        if html_content:
            if not name_first or not name_last:
                first_m = re.search(r'<span class="first-name">(.*?)</span>', html_content, re.S)
                last_m = re.search(r'<span class="last-name">(.*?)</span>', html_content, re.S)
                if first_m:
                    name_first = _clean_text(first_m.group(1))
                if last_m:
                    name_last = _clean_text(last_m.group(1))
                if not name_first and not name_last:
                    name_m = re.search(r'<div class="candidate-name">(.*?)</div>', html_content, re.S)
                    if name_m:
                        parts = _clean_text(name_m.group(1)).split()
                        if parts:
                            name_first = parts[0]
                            name_last = " ".join(parts[1:])

            if not where or not phone or not email:
                rows = re.findall(r'<div class="contact-row">.*?<span>(.*?)</span></div>', html_content, re.S)
                for r in rows:
                    txt = _clean_text(r)
                    if "@" in txt and not email:
                        email = txt
                    elif any(c in txt for c in "+0123456789") and len(txt) < 30 and not phone:
                        phone = txt
                    elif not where:
                        where = txt

            if not post:
                post_m = re.search(r'<div class="subtitle-target">als\s+(.*?)</div>', html_content, re.S)
                if post_m:
                    post = _clean_text(post_m.group(1))

            if not extra:
                spec_m = re.search(r'<div class="subtitle-specialization">(.*?)</div>', html_content, re.S)
                if spec_m:
                    extra = _clean_text(spec_m.group(1))

        # 2. Fill missing from profile
        profile = deckblatt.sheet_profile(user)
        if not name_first and not name_last:
            whole = profile.get("full_name", "").split()
            name_first = profile.get("first_name") or (whole[0] if whole else "")
            name_last = profile.get("last_name") or " ".join(whole[1:])

        if not where:
            town = " ".join(p for p in (profile.get("postal_code"), profile.get("city")) if p).strip()
            where = profile.get("full_address") or ", ".join(
                part for part in (profile.get("address"), town, profile.get("country")) if part
            )

        if not phone:
            phone = profile.get("phone_formatted") or profile.get("phone") or ""

        if not email:
            email = profile.get("email") or ""

        if not post:
            post = deckblatt.post_line(job, user)

        if not extra:
            extra = deckblatt.specialisation(job, user)

        full_name = f"{name_first} {name_last}".strip() or profile.get("full_name") or ""

        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        c = pdfcanvas.Canvas(str(pdf_path), pagesize=A4)
        c.setTitle("Deckblatt - " + (full_name or "Bewerbung"))
        c.setAuthor(full_name)

        font_main, font_bold = setup_fonts()

        # 1. Background Card
        c.saveState()
        c.setFillColor(CARD_BG)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.9)
        c.roundRect(50 * mm, 25 * mm, 175 * mm, 254 * mm, 6 * mm, stroke=1, fill=1)
        c.restoreState()

        # 2. Photograph Circle
        cx = 50 * mm
        cy = 239 * mm
        r_outer = 22.5 * mm
        r_inner = 21.2 * mm

        c.saveState()
        c.setFillColor(WHITE)
        c.setStrokeColor(RULE)
        c.setLineWidth(1.4)
        c.circle(cx, cy, r_outer, stroke=1, fill=1)
        c.restoreState()

        img_reader = _find_photo_image(user, html_content)
        if img_reader:
            c.saveState()
            clip_path = c.beginPath()
            clip_path.circle(cx, cy, r_inner)
            c.clipPath(clip_path, stroke=0, fill=0)

            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h) if img_h else 1.0
            diam = r_inner * 2.0
            if aspect > 1.0:
                draw_h = diam * 1.15
                draw_w = draw_h * aspect
            else:
                draw_w = diam * 1.15
                draw_h = draw_w / aspect

            draw_x = cx - draw_w / 2.0
            draw_y = cy - draw_h / 2.0
            c.drawImage(img_reader, draw_x, draw_y, width=draw_w, height=draw_h, mask='auto')
            c.restoreState()

        c.saveState()
        c.setStrokeColor(RULE)
        c.setLineWidth(1.1)
        c.circle(cx, cy, r_inner, stroke=1, fill=0)
        c.restoreState()

        # 3. Candidate Name
        name_x = 78 * mm
        name_y1 = PAGE_H - (34.2 * mm + 20)
        c.saveState()
        c.setFont(font_bold, 27)
        c.setFillColor(INK)
        if name_first and name_last:
            c.drawString(name_x, name_y1, name_first.upper())
            name_y2 = name_y1 - 32.5
            c.drawString(name_x, name_y2, name_last.upper())
        else:
            c.drawString(name_x, name_y1, (full_name or "BEWERBUNG").upper())
        c.restoreState()

        # 4. Contact Details
        contacts = []
        if where:
            contacts.append(("pin", where))
        if phone:
            contacts.append(("phone", phone))
        if email:
            contacts.append(("mail", email))

        contact_x = 78 * mm
        contact_base_y = PAGE_H - (58.5 * mm + 9)
        c.setFont(font_main, 9.8)
        c.setFillColor(GREY)

        for i, (kind, text) in enumerate(contacts):
            row_y = contact_base_y - (i * 17.5)

            c.saveState()
            c.setStrokeColor(INK)
            c.setFillColor(INK)
            if kind == "pin":
                c.circle(contact_x + 1.8 * mm, row_y + 2.5 * mm, 1.2 * mm, stroke=0, fill=1)
                c.setLineWidth(0.8)
                c.line(contact_x + 1.8 * mm, row_y + 2.5 * mm, contact_x + 1.8 * mm, row_y - 0.2 * mm)
            elif kind == "phone":
                c.setLineWidth(1.0)
                p = c.beginPath()
                p.moveTo(contact_x + 0.5 * mm, row_y + 2.6 * mm)
                p.lineTo(contact_x + 1.5 * mm, row_y + 3.2 * mm)
                p.lineTo(contact_x + 2.8 * mm, row_y + 1.2 * mm)
                p.lineTo(contact_x + 2.2 * mm, row_y + 0.6 * mm)
                p.lineTo(contact_x + 0.8 * mm, row_y + 0.2 * mm)
                p.close()
                c.drawPath(p, stroke=1, fill=0)
            elif kind == "mail":
                c.setLineWidth(0.7)
                c.roundRect(contact_x, row_y - 0.2 * mm, 3.8 * mm, 2.7 * mm, 0.4 * mm, stroke=1, fill=0)
                c.line(contact_x, row_y + 2.5 * mm, contact_x + 1.9 * mm, row_y + 1.1 * mm)
                c.line(contact_x + 3.8 * mm, row_y + 2.5 * mm, contact_x + 1.9 * mm, row_y + 1.1 * mm)
            c.restoreState()

            c.drawString(contact_x + 5.5 * mm, row_y, text)

        # 5. Bottom Title Block
        title_x = 62 * mm
        bottom_anchor = 39 * mm
        max_w = 132 * mm

        def _wrap_text(text: str, font_name: str, size: float) -> list[str]:
            if not text:
                return []
            words = text.split()
            lines = []
            cur = ""
            for w in words:
                test = (cur + " " + w).strip()
                if c.stringWidth(test, font_name, size) <= max_w:
                    cur = test
                else:
                    if cur:
                        lines.append(cur)
                    cur = w
            if cur:
                lines.append(cur)
            return lines

        spec_lines = _wrap_text(extra, font_main, 11.5)
        target_lines = _wrap_text("als " + post if post else "", font_bold, 13.0)

        cur_y = bottom_anchor

        c.setFont(font_main, 11.5)
        c.setFillColor(GREY)
        for line in reversed(spec_lines):
            c.drawString(title_x, cur_y, line)
            cur_y += 16.0

        if spec_lines and target_lines:
            cur_y += 2.0 * mm

        c.setFont(font_bold, 13.0)
        c.setFillColor(GREY)
        for line in reversed(target_lines):
            c.drawString(title_x, cur_y, line)
            cur_y += 18.0

        if target_lines:
            cur_y += 4.5 * mm

        c.setFont(font_bold, 31)
        c.setFillColor(INK)
        c.drawString(title_x, cur_y, "BEWERBUNG")

        c.showPage()
        c.save()
        return pdf_path.exists() and pdf_path.stat().st_size > 1000

    except Exception:
        return False


def html_to_reportlab_deckblatt_pdf(html_path: Path, pdf_path: Path, user: Optional[str] = None) -> bool:
    """Fallback parser that extracts parameters from deckblatt.html directly."""
    try:
        content = html_path.read_text(encoding="utf-8")
        detected_user = _detect_user(html_path, pdf_path, user=user, html_content=content)
        return generate_deckblatt_pdf(job={}, pdf_path=pdf_path, user=detected_user, html_content=content)
    except Exception:
        return False
