# -*- coding: utf-8 -*-
"""
ReportLab PDF generator for cover letters as an infallible fallback.
Produces a clean, pixel-perfect A4 PDF matching MapJob's authentic cover letter design
with horizontal rule under role, left vertical rules for sender and recipient.
"""

from __future__ import annotations

import re
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib import colors

_TAG = re.compile(r"<[^>]+>")


def _clean(html_text: str) -> str:
    text = re.sub(r"</?(div|header|section|article)[^>]*>", "", html_text)
    text = re.sub(r"<span[^>]*>(.*?)</span>", r"<b>\1</b>", text)
    text = text.replace("&bull;", "•").replace("&middot;", "·").replace("&amp;", "&")
    return text.strip()


def html_to_reportlab_pdf(html_path: Path, pdf_path: Path) -> bool:
    try:
        content = html_path.read_text(encoding="utf-8")
        
        # 1. Header: Name, Role tagline, Contact lines
        name_match = re.search(r'<h1 class="head__name">(.*?)</h1>', content, re.S)
        if name_match:
            name_raw = name_match.group(1).strip()
            name = re.sub(r'<span[^>]*>(.*?)</span>', r'<b>\1</b>', name_raw)
        else:
            name = "Badreddine <b>Barki</b>"
            
        role_match = re.search(r'<p class="head__role">(.*?)</p>', content, re.S)
        role = _clean(role_match.group(1)) if role_match else ""
        
        contact_match = re.search(r'<div class="head__contact">(.*?)</div>', content, re.S)
        contacts = []
        if contact_match:
            for span in re.findall(r'<span[^>]*>(.*?)</span>', contact_match.group(1), re.S):
                c_clean = _TAG.sub("", span).strip()
                if c_clean:
                    contacts.append(c_clean)
        if not contacts:
            contacts = [
                "14 rue de la 2e DB, Amiens, France",
                "badreddinebarki@gmail.com",
                "barkibadreddine.com",
                "+33 7 45 76 80 10"
            ]
        contact_text = "<br/>".join(contacts)
        
        # 2. Meta: Recipient & Date
        to_company_m = re.search(r'<div class="meta__company">(.*?)</div>', content, re.S)
        to_place_m = re.search(r'<div class="meta__place">(.*?)</div>', content, re.S)
        date_m = re.search(r'<div class="meta__date">(.*?)</div>', content, re.S)
        
        company = _TAG.sub("", to_company_m.group(1)).strip() if to_company_m else ""
        place = _TAG.sub("", to_place_m.group(1)).strip() if to_place_m else ""
        date_str = _TAG.sub("", date_m.group(1)).strip() if date_m else ""
        
        # 3. Subject
        subject_m = re.search(r'<p class="subject">(.*?)</p>', content, re.S)
        subject = _clean(subject_m.group(1)) if subject_m else ""
        
        # 4. Body
        body_m = re.search(r'<div class="body">(.*?)</div>\s*<div class="sign">', content, re.S)
        body_html = body_m.group(1) if body_m else ""
        paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', body_html, re.S)
        
        # 5. Sign-off
        closing_m = re.search(r'<div class="sign">\s*<div>(.*?)</div>', content, re.S)
        if not closing_m:
            closing_m = re.search(r'<div class="sign__closing">(.*?)</div>', content, re.S)
        closing = _TAG.sub("", closing_m.group(1)).strip() if closing_m else "Cordialement,"
        
        sign_name_m = re.search(r'<div class="sign__name">(.*?)</div>', content, re.S)
        if sign_name_m:
            sign_name = re.sub(r'<span[^>]*>(.*?)</span>', r'<b>\1</b>', sign_name_m.group(1).strip())
        else:
            sign_name = name

        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(pdf_path),
            pagesize=A4,
            leftMargin=38,
            rightMargin=38,
            topMargin=40,
            bottomMargin=40
        )
        
        from services.automation.fonts_setup import setup_fonts
        font_main, font_bold = setup_fonts()
        
        styles = getSampleStyleSheet()
        name_style = ParagraphStyle(
            'HeadName', parent=styles['Normal'],
            fontName=font_main, fontSize=24, leading=26,
            textColor=colors.black
        )
        role_style = ParagraphStyle(
            'HeadRole', parent=styles['Normal'],
            fontName=font_bold, fontSize=8.5, leading=11.5,
            textColor=colors.HexColor('#1a1a1a')
        )
        contact_style = ParagraphStyle(
            'HeadContact', parent=styles['Normal'],
            fontName=font_main, fontSize=8.5, leading=12.5,
            textColor=colors.HexColor('#5a5a54')
        )
        meta_left_style = ParagraphStyle(
            'MetaLeft', parent=styles['Normal'],
            fontName=font_bold, fontSize=10, leading=13,
            textColor=colors.black
        )
        meta_right_style = ParagraphStyle(
            'MetaRight', parent=styles['Normal'],
            fontName=font_main, fontSize=8.5, alignment=TA_RIGHT, leading=12,
            textColor=colors.HexColor('#5a5a54')
        )
        subject_style = ParagraphStyle(
            'SubjectStyle', parent=styles['Normal'],
            fontName=font_bold, fontSize=10.5, leading=14,
            textColor=colors.black
        )
        body_style = ParagraphStyle(
            'LetterBody', parent=styles['Normal'],
            fontName=font_main, fontSize=9.8, leading=16.0, alignment=TA_JUSTIFY,
            textColor=colors.HexColor('#000000')
        )
        sign_style = ParagraphStyle(
            'LetterSig', parent=styles['Normal'],
            fontName=font_main, fontSize=10.5, leading=14,
            textColor=colors.black
        )

        story = [
            Paragraph(name, name_style),
        ]
        if role:
            story.append(Spacer(1, 3))
            story.append(Paragraph(role, role_style))
        story.append(Spacer(1, 4))

        # Horizontal rule directly under name & role tagline (as drawn by user)
        header_rule = Table([[""]], colWidths=[519], rowHeights=[1])
        header_rule.setStyle(TableStyle([
            ('LINEBELOW', (0,0), (-1,-1), 0.75, colors.black),
            ('TOPPADDING', (0,0), (-1,-1), 0),
            ('BOTTOMPADDING', (0,0), (-1,-1), 0),
        ]))
        story.append(header_rule)
        story.append(Spacer(1, 8))

        # Sender contact table with left vertical rule
        contact_table = Table([[Paragraph(contact_text, contact_style)]], colWidths=[519])
        contact_table.setStyle(TableStyle([
            ('LINEBEFORE', (0,0), (0,0), 1.5, colors.black),
            ('LEFTPADDING', (0,0), (0,0), 8),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 0),
            ('BOTTOMPADDING', (0,0), (-1,-1), 0),
        ]))
        story.append(contact_table)
        story.append(Spacer(1, 14))

        # Meta Table: Recipient on left with 1.5pt rule, Date on right
        to_left_p = Paragraph(f"<b>{company}</b>" + (f"<br/><font color='#5a5a54'>{place}</font>" if place else ""), meta_left_style)
        meta_table_data = [
            [to_left_p, Paragraph(date_str, meta_right_style)]
        ]
        t = Table(meta_table_data, colWidths=[330, 189])
        t.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LINEBEFORE', (0,0), (0,0), 1.5, colors.black),
            ('LEFTPADDING', (0,0), (0,0), 8),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 0),
            ('BOTTOMPADDING', (0,0), (-1,-1), 0),
        ]))
        story.append(t)
        story.append(Spacer(1, 14))

        # Subject with subtle underline
        if subject:
            sub_table = Table([[Paragraph(subject, subject_style)]], colWidths=[519])
            sub_table.setStyle(TableStyle([
                ('LINEBELOW', (0,0), (-1,-1), 0.75, colors.HexColor('#cfcfc9')),
                ('LEFTPADDING', (0,0), (-1,-1), 0),
                ('RIGHTPADDING', (0,0), (-1,-1), 0),
                ('TOPPADDING', (0,0), (-1,-1), 0),
                ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ]))
            story.append(sub_table)
            story.append(Spacer(1, 12))

        # Body paragraphs
        for p in paragraphs:
            clean_p = _clean(p)
            if clean_p:
                story.append(Paragraph(clean_p, body_style))
                story.append(Spacer(1, 8))

        story.append(Spacer(1, 8))
        story.append(Paragraph(closing, body_style))
        story.append(Spacer(1, 14))
        story.append(Paragraph(sign_name, sign_style))

        doc.build(story)
        return pdf_path.exists() and pdf_path.stat().st_size > 1000
    except Exception:
        return False
