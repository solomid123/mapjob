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


def _find_photo_image(user: Optional[str] = None, html_content: str = "") -> Optional[ImageReader]:
    """Finds photo from document library or inlined base64 HTML."""
    try:
        for row in library.all_documents(user=user, kind="photo"):
            path = library.path_of(str(row.get("id")), user=user)
            if path and path.exists() and path.stat().st_size > 500:
                return ImageReader(str(path))
    except Exception:
        pass

    if html_content:
        m = re.search(r'src="data:image/[^;]+;base64,([^"]+)"', html_content)
        if m:
            try:
                raw_bytes = base64.b64decode(m.group(1))
                return ImageReader(io.BytesIO(raw_bytes))
            except Exception:
                pass

    return None


def generate_deckblatt_pdf(job: Dict[str, Any], pdf_path: Path, user: Optional[str] = None,
                           html_content: str = "") -> bool:
    """
    Renders an authentic A4 Deckblatt PDF directly using ReportLab canvas.
    """
    try:
        from services.automation import deckblatt

        profile = deckblatt.sheet_profile(user)
        post = deckblatt.post_line(job, user)
        extra = deckblatt.specialisation(job, user)

        # Name formatting
        whole = profile.get("full_name", "").split()
        first = profile.get("first_name") or (whole[0] if whole else "")
        last = profile.get("last_name") or " ".join(whole[1:])

        # Contact lines
        town = " ".join(p for p in (profile.get("postal_code"), profile.get("city")) if p).strip()
        where = profile.get("full_address") or ", ".join(
            part for part in (profile.get("address"), town, profile.get("country")) if part
        )
        phone = profile.get("phone_formatted") or profile.get("phone") or ""
        email = profile.get("email") or ""

        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        c = pdfcanvas.Canvas(str(pdf_path), pagesize=A4)
        c.setTitle("Deckblatt - " + (profile.get("full_name") or "Bewerbung"))
        c.setAuthor(profile.get("full_name") or "")

        font_main, font_bold = setup_fonts()

        # 1. Background Card
        # In CSS: left: 50mm, top: 18mm, width: 175mm, height: 254mm, radius: 6mm
        # In ReportLab: y = 297 - 18 - 254 = 25mm
        c.saveState()
        c.setFillColor(CARD_BG)
        c.setStrokeColor(RULE)
        c.setLineWidth(0.9)
        c.roundRect(50 * mm, 25 * mm, 175 * mm, 254 * mm, 6 * mm, stroke=1, fill=1)
        c.restoreState()

        # 2. Photograph Circle
        # In CSS: center cx = 50mm, cy = 297 - 58 = 239mm
        # outer radius = 22.5mm, inner radius = 21.2mm
        cx = 50 * mm
        cy = 239 * mm
        r_outer = 22.5 * mm
        r_inner = 21.2 * mm

        # Outer white circle covering card border
        c.saveState()
        c.setFillColor(WHITE)
        c.setStrokeColor(RULE)
        c.setLineWidth(1.4)
        c.circle(cx, cy, r_outer, stroke=1, fill=1)
        c.restoreState()

        # Photo image if available
        img_reader = _find_photo_image(user, html_content)
        if img_reader:
            c.saveState()
            clip_path = c.beginPath()
            clip_path.circle(cx, cy, r_inner)
            c.clipPath(clip_path, stroke=0, fill=0)

            # Draw image centered at (cx, cy)
            # Make sure it fills the circle nicely
            img_w, img_h = img_reader.getSize()
            aspect = img_w / float(img_h) if img_h else 1.0
            diam = r_inner * 2.0
            if aspect > 1.0:
                draw_h = diam * 1.15
                draw_w = draw_h * aspect
            else:
                draw_w = diam * 1.15
                draw_h = draw_w / aspect

            # Offset slightly to center face if needed
            draw_x = cx - draw_w / 2.0
            draw_y = cy - draw_h / 2.0
            c.drawImage(img_reader, draw_x, draw_y, width=draw_w, height=draw_h, mask='auto')
            c.restoreState()

        # Inner ring stroke
        c.saveState()
        c.setStrokeColor(RULE)
        c.setLineWidth(1.1)
        c.circle(cx, cy, r_inner, stroke=1, fill=0)
        c.restoreState()

        # 3. Candidate Name
        # In CSS: left: 78mm, top: 34.2mm. font-weight: bold, font-size: 27pt, line-height: 31pt, color: INK
        name_x = 78 * mm
        name_y1 = PAGE_H - (34.2 * mm + 20)  # baseline of first name
        c.saveState()
        c.setFont(font_bold, 27)
        c.setFillColor(INK)
        if first and last:
            c.drawString(name_x, name_y1, first.upper())
            name_y2 = name_y1 - 32.5  # 31pt leading + margin
            c.drawString(name_x, name_y2, last.upper())
        else:
            full = (profile.get("full_name") or first or last).upper()
            c.drawString(name_x, name_y1, full)
        c.restoreState()

        # 4. Contact Details
        # In CSS: left: 78mm, top: 58.5mm, font-size: 10pt, line-height: 15.5pt, color: GREY
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

            # Draw vector icon at contact_x
            c.saveState()
            c.setStrokeColor(INK)
            c.setFillColor(INK)
            if kind == "pin":
                # Pin: circle + point
                c.circle(contact_x + 1.8 * mm, row_y + 2.5 * mm, 1.2 * mm, stroke=0, fill=1)
                c.setLineWidth(0.8)
                c.line(contact_x + 1.8 * mm, row_y + 2.5 * mm, contact_x + 1.8 * mm, row_y - 0.2 * mm)
            elif kind == "phone":
                # Phone: neat handset representation
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
                # Envelope
                c.setLineWidth(0.7)
                c.roundRect(contact_x, row_y - 0.2 * mm, 3.8 * mm, 2.7 * mm, 0.4 * mm, stroke=1, fill=0)
                c.line(contact_x, row_y + 2.5 * mm, contact_x + 1.9 * mm, row_y + 1.1 * mm)
                c.line(contact_x + 3.8 * mm, row_y + 2.5 * mm, contact_x + 1.9 * mm, row_y + 1.1 * mm)
            c.restoreState()

            # Draw text
            c.drawString(contact_x + 5.5 * mm, row_y, text)

        # 5. Bottom Title Block
        # In CSS: left: 62mm, bottom: 39mm.
        # .title-bewerbung: 31pt bold, color: INK, margin-bottom: 4mm
        # .subtitle-target: 13pt bold, color: GREY, margin-bottom: 1.8mm, max-width: 132mm
        # .subtitle-specialization: 11.5pt, color: GREY, max-width: 132mm
        title_x = 62 * mm
        bottom_anchor = 39 * mm

        # Calculate heights upwards from bottom_anchor
        # Wrap subtitles if needed (max width 132mm = ~374pt)
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

        # Draw from bottom up
        cur_y = bottom_anchor

        # Specialisation lines (bottom-most)
        c.setFont(font_main, 11.5)
        c.setFillColor(GREY)
        for line in reversed(spec_lines):
            c.drawString(title_x, cur_y, line)
            cur_y += 16.0  # leading

        if spec_lines and target_lines:
            cur_y += 2.0 * mm

        # Target post lines
        c.setFont(font_bold, 13.0)
        c.setFillColor(GREY)
        for line in reversed(target_lines):
            c.drawString(title_x, cur_y, line)
            cur_y += 18.0

        if target_lines:
            cur_y += 4.5 * mm

        # BEWERBUNG title
        c.setFont(font_bold, 31)
        c.setFillColor(INK)
        c.drawString(title_x, cur_y, "BEWERBUNG")

        c.showPage()
        c.save()
        return pdf_path.exists() and pdf_path.stat().st_size > 1000

    except Exception as exc:
        return False


def html_to_reportlab_deckblatt_pdf(html_path: Path, pdf_path: Path, user: Optional[str] = None) -> bool:
    """Fallback parser that extracts parameters from deckblatt.html if needed."""
    try:
        content = html_path.read_text(encoding="utf-8")
        from services.automation import deckblatt

        # Extract post if in HTML
        post_m = re.search(r'<div class="subtitle-target">als\s+(.*?)</div>', content, re.S)
        post = post_m.group(1).strip() if post_m else ""

        # Extract specialisation if in HTML
        spec_m = re.search(r'<div class="subtitle-specialization">(.*?)</div>', content, re.S)
        spec = spec_m.group(1).strip() if spec_m else ""

        job_info = {"title": post}
        return generate_deckblatt_pdf(job_info, pdf_path, user=user, html_content=content)
    except Exception:
        return False
