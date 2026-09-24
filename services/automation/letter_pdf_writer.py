# -*- coding: utf-8 -*-
"""
ReportLab PDF generator for cover letters as an infallible fallback.
Produces a clean, pixel-perfect A4 PDF matching Badreddine Barki's header identity.
"""

from __future__ import annotations

import re
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib import colors

_TAG = re.compile(r"<[^>]+>")


def _clean(html_text: str) -> str:
    # Keep simple inline formatting like <strong> or <b> for ReportLab
    text = re.sub(r"</?(span|div|header|section|article)[^>]*>", "", html_text)
    return text.strip()


def html_to_reportlab_pdf(html_path: Path, pdf_path: Path) -> bool:
    try:
        content = html_path.read_text(encoding="utf-8")
        
        # Extract title / name
        name_match = re.search(r'<h1 class="head__name">(.*?)</h1>', content, re.S)
        name = _TAG.sub("", name_match.group(1)).strip() if name_match else "Badreddine Barki"
        
        address_match = re.search(r'<p class="head__address">(.*?)</p>', content, re.S)
        address = _TAG.sub("", address_match.group(1)).strip() if address_match else "14 rue de la 2e DB, Amiens, France"
        
        contact_match = re.search(r'<div class="head__contact">(.*?)</div>', content, re.S)
        contact = _TAG.sub("", contact_match.group(1)).strip() if contact_match else "badreddinebarki@gmail.com • +33 7 45 76 80 10"
        contact = contact.replace("&bull;", "•").replace("&middot;", "•")
        
        # Meta recipient & date
        to_company_m = re.search(r'<div class="meta__company">(.*?)</div>', content, re.S)
        to_place_m = re.search(r'<div class="meta__place">(.*?)</div>', content, re.S)
        date_m = re.search(r'<div class="meta__date">(.*?)</div>', content, re.S)
        
        company = _TAG.sub("", to_company_m.group(1)).strip() if to_company_m else ""
        place = _TAG.sub("", to_place_m.group(1)).strip() if to_place_m else ""
        date_str = _TAG.sub("", date_m.group(1)).strip() if date_m else ""
        
        # Subject
        subject_m = re.search(r'<p class="subject">(.*?)</p>', content, re.S)
        subject = _TAG.sub("", subject_m.group(1)).strip() if subject_m else ""
        
        # Body paragraphs
        body_m = re.search(r'<div class="body">(.*?)</div>\s*<div class="sign">', content, re.S)
        body_html = body_m.group(1) if body_m else ""
        paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', body_html, re.S)
        
        # Sign-off
        closing_m = re.search(r'<div class="sign__closing">(.*?)</div>', content, re.S)
        closing = _TAG.sub("", closing_m.group(1)).strip() if closing_m else "Cordialement,"
        
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(pdf_path),
            pagesize=A4,
            leftMargin=42,
            rightMargin=42,
            topMargin=36,
            bottomMargin=36
        )
        
        styles = getSampleStyleSheet()
        title_style = ParagraphStyle(
            'HeadTitle', parent=styles['Normal'],
            fontName='Helvetica-Bold', fontSize=22, alignment=TA_CENTER, leading=26,
            textColor=colors.black
        )
        sub_style = ParagraphStyle(
            'HeadSub', parent=styles['Normal'],
            fontName='Helvetica', fontSize=8.5, alignment=TA_CENTER, leading=12,
            textColor=colors.HexColor('#222222')
        )
        meta_left_style = ParagraphStyle(
            'MetaLeft', parent=styles['Normal'],
            fontName='Helvetica-Bold', fontSize=9.5, leading=13,
            textColor=colors.black
        )
        meta_left_sub = ParagraphStyle(
            'MetaLeftSub', parent=styles['Normal'],
            fontName='Helvetica', fontSize=8.5, leading=12,
            textColor=colors.HexColor('#444444')
        )
        meta_right_style = ParagraphStyle(
            'MetaRight', parent=styles['Normal'],
            fontName='Helvetica', fontSize=8.5, alignment=TA_RIGHT, leading=12,
            textColor=colors.HexColor('#444444')
        )
        subject_style = ParagraphStyle(
            'SubjectStyle', parent=styles['Normal'],
            fontName='Helvetica-Bold', fontSize=10, leading=14,
            textColor=colors.black
        )
        body_style = ParagraphStyle(
            'LetterBody', parent=styles['Normal'],
            fontName='Helvetica', fontSize=9.2, leading=14.5, alignment=TA_JUSTIFY,
            textColor=colors.HexColor('#111111')
        )
        sig_style = ParagraphStyle(
            'LetterSig', parent=styles['Normal'],
            fontName='Helvetica-Bold', fontSize=10, leading=14,
            textColor=colors.black
        )
        
        story = [
            Paragraph(name, title_style),
            Spacer(1, 4),
            Paragraph(f"{address}<br/>{contact}", sub_style),
            Spacer(1, 18),
        ]
        
        # Meta Table
        to_text = f"<b>{company}</b>" + (f"<br/>{place}" if place else "")
        meta_table_data = [
            [Paragraph(to_text, meta_left_style), Paragraph(date_str, meta_right_style)]
        ]
        t = Table(meta_table_data, colWidths=[320, 190])
        t.setStyle(TableStyle([
            ('VALIGN', (0,0), (-1,-1), 'TOP'),
            ('LINELEFT', (0,0), (0,0), 1.5, colors.black),
            ('LEFTPADDING', (0,0), (0,0), 8),
            ('RIGHTPADDING', (0,0), (-1,-1), 0),
            ('TOPPADDING', (0,0), (-1,-1), 0),
            ('BOTTOMPADDING', (0,0), (-1,-1), 0),
        ]))
        story.append(t)
        story.append(Spacer(1, 14))
        
        if subject:
            story.append(Paragraph(subject, subject_style))
            story.append(Spacer(1, 10))
            
        for p in paragraphs:
            clean_p = _clean(p)
            if clean_p:
                story.append(Paragraph(clean_p, body_style))
                story.append(Spacer(1, 8))
                
        story.append(Spacer(1, 8))
        story.append(Paragraph(closing, body_style))
        story.append(Spacer(1, 14))
        story.append(Paragraph(name, sig_style))
        
        doc.build(story)
        return pdf_path.exists() and pdf_path.stat().st_size > 1000
    except Exception:
        return False
