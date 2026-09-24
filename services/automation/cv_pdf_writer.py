# -*- coding: utf-8 -*-
"""
ReportLab PDF generator for tailored CVs.
Converts tailored cv.html into an authentic, pixel-perfect A4 PDF matching
Badreddine Barki's CV geometry (centered header, 2-column section rows,
right-aligned dates, elegant small bullet points, large readable typography)
with ZERO external browser dependencies.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import List, Tuple

from reportlab.lib.pagesizes import A4
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib import colors

_TAG = re.compile(r"<[^>]+>")


def _clean_text(html: str) -> str:
    # Preserve <strong>, <b>, <em>, <i>, <font>
    t = re.sub(r"</?(span|div|p|article|section|header|a)[^>]*>", "", html)
    t = t.replace("&bull;", "•").replace("&middot;", "·").replace("&amp;", "&")
    t = t.replace("&minus;", "-").replace("&ndash;", "–").replace("&mdash;", "—")
    t = t.replace("■", "").replace("●", "").replace("•", "").strip()
    return t


def html_to_reportlab_cv_pdf(html_path: Path, pdf_path: Path) -> bool:
    try:
        content = html_path.read_text(encoding="utf-8")

        # 1. Header parsing
        name_m = re.search(r'<h1 class="head__name">(.*?)</h1>', content, re.S)
        name = _clean_text(name_m.group(1)) if name_m else "Badreddine Barki"

        addr_m = re.search(r'<p class="head__address">(.*?)</p>', content, re.S)
        addr = _clean_text(addr_m.group(1)) if addr_m else "14 rue de la 2e DB, Amiens, France"

        contact_m = re.search(r'<div class="head__contact">(.*?)</div>', content, re.S)
        if contact_m:
            raw_c = contact_m.group(1)
            raw_c = re.sub(r'<a[^>]*>(.*?)</a>', r'\1', raw_c)
            c_parts = [_clean_text(p) for p in re.split(r'&bull;|•|●|&middot;', raw_c) if _clean_text(p)]
            contact_str = "  <font size='6.5' color='#555555'>&#8226;</font>  ".join(c_parts)
        else:
            contact_str = "badreddinebarki@gmail.com  <font size='6.5' color='#555555'>&#8226;</font>  +33 7 45 76 80 10  <font size='6.5' color='#555555'>&#8226;</font>  linkedin.com/in/barki-badreddine-bb2328146"

        from services.automation.fonts_setup import setup_fonts
        font_main, font_bold = setup_fonts()

        styles = getSampleStyleSheet()

        head_name_style = ParagraphStyle(
            'CVHeadName', parent=styles['Normal'],
            fontName=font_bold, fontSize=24, leading=26,
            alignment=TA_CENTER, textColor=colors.black
        )
        head_sub_style = ParagraphStyle(
            'CVHeadSub', parent=styles['Normal'],
            fontName=font_main, fontSize=9.0, leading=12.0,
            alignment=TA_CENTER, textColor=colors.HexColor('#222222')
        )
        sec_title_style = ParagraphStyle(
            'CVSecTitle', parent=styles['Normal'],
            fontName=font_bold, fontSize=9.0, leading=11.5,
            alignment=TA_LEFT, textColor=colors.black
        )
        body_text_style = ParagraphStyle(
            'CVBodyText', parent=styles['Normal'],
            fontName=font_main, fontSize=9.5, leading=12.6,
            alignment=TA_JUSTIFY, textColor=colors.HexColor('#111111')
        )
        company_style = ParagraphStyle(
            'CVCompany', parent=styles['Normal'],
            fontName=font_bold, fontSize=9.8, leading=12.4,
            textColor=colors.black
        )
        role_style = ParagraphStyle(
            'CVRole', parent=styles['Normal'],
            fontName=font_bold, fontSize=9.3, leading=12.0,
            textColor=colors.black
        )
        date_style = ParagraphStyle(
            'CVDate', parent=styles['Normal'],
            fontName=font_main, fontSize=9.0, leading=12.0,
            alignment=TA_RIGHT, textColor=colors.HexColor('#222222')
        )
        bullet_style = ParagraphStyle(
            'CVBullet', parent=styles['Normal'],
            fontName=font_main, fontSize=9.1, leading=12.2,
            leftIndent=11, firstLineIndent=-11,
            alignment=TA_JUSTIFY, textColor=colors.HexColor('#111111')
        )
        skill_head_style = ParagraphStyle(
            'CVSkillHead', parent=styles['Normal'],
            fontName=font_bold, fontSize=9.2, leading=11.8,
            textColor=colors.black
        )

        LEFT_COL_W = 108
        RIGHT_COL_W = 417

        story = [
            Paragraph(name, head_name_style),
            Spacer(1, 2),
            Paragraph(addr, head_sub_style),
            Spacer(1, 1),
            Paragraph(contact_str, head_sub_style),
            Spacer(1, 8),
        ]

        # 2. Parse all .section-row elements
        row_regex = re.compile(
            r'<div class="section-row">\s*<div class="section-title">\s*(.*?)\s*</div>\s*<div class="section-content">\s*(.*?)\s*</div>\s*(?=<div class="section-row">|<div class="cv-footer">|</body>|$)',
            re.S
        )

        rows = row_regex.findall(content)

        for title_html, content_html in rows:
            # Clean title
            title_text = title_html.replace("<br>", "<br/>").replace("<br/>", "\n")
            title_text = _TAG.sub("", title_text).strip()
            title_p = Paragraph(title_text.replace("\n", "<br/>"), sec_title_style)

            # Build right-side flowables
            right_flowables = []

            # Summary
            summary_m = re.search(r'<p class="summary">(.*?)</p>', content_html, re.S)
            if summary_m:
                sum_text = _clean_text(summary_m.group(1))
                right_flowables.append(Paragraph(sum_text, body_text_style))
                right_flowables.append(Spacer(1, 2))

            # Jobs (Experience)
            job_matches = re.findall(r'<article class="job">(.*?)</article>', content_html, re.S)
            if job_matches:
                for idx, j_html in enumerate(job_matches):
                    comp_m = re.search(r'<div class="job__company-line">(.*?)</div>', j_html, re.S)
                    comp_text = _clean_text(comp_m.group(1)) if comp_m else ""

                    role_m = re.search(r'<p class="job__role">(.*?)</p>', j_html, re.S)
                    role_text = _clean_text(role_m.group(1)) if role_m else ""

                    years_m = re.search(r'<span class="job__years">(.*?)</span>', j_html, re.S)
                    years_text = _clean_text(years_m.group(1)) if years_m else ""

                    if comp_text:
                        right_flowables.append(Paragraph(comp_text, company_style))
                        right_flowables.append(Spacer(1, 1))

                    if role_text or years_text:
                        role_label = f"<font size='6.5'>■</font>&nbsp; {role_text}"
                        r_table = Table(
                            [[Paragraph(role_label, role_style), Paragraph(years_text, date_style)]],
                            colWidths=[310, 107]
                        )
                        r_table.setStyle(TableStyle([
                            ('VALIGN', (0,0), (-1,-1), 'BASELINE'),
                            ('LEFTPADDING', (0,0), (-1,-1), 0),
                            ('RIGHTPADDING', (0,0), (-1,-1), 0),
                            ('TOPPADDING', (0,0), (-1,-1), 0),
                            ('BOTTOMPADDING', (0,0), (-1,-1), 0.5),
                        ]))
                        right_flowables.append(r_table)
                        right_flowables.append(Spacer(1, 1))

                    bullets = re.findall(r'<li>(.*?)</li>', j_html, re.S)
                    for b in bullets:
                        b_text = _clean_text(b)
                        bullet_item = f"•&nbsp; {b_text}"
                        right_flowables.append(Paragraph(bullet_item, bullet_style))
                        right_flowables.append(Spacer(1, 0.8))

                    if idx < len(job_matches) - 1:
                        right_flowables.append(Spacer(1, 2.5))

            # Education
            if "edu-item" in content_html:
                edu_chunks = content_html.split('<div class="edu-item">')[1:]
                for idx, chunk in enumerate(edu_chunks):
                    sch_m = re.search(r'<div class="edu-school">(.*?)</div>', chunk, re.S)
                    sch_text = _clean_text(sch_m.group(1)) if sch_m else ""

                    tl_m = re.search(r'<div class="edu-title-line">(.*?)</div>', chunk, re.S)
                    deg_text = ""
                    years_text = ""
                    if tl_m:
                        tl = tl_m.group(1)
                        y_m = re.search(r'<span class="edu-years">(.*?)</span>', tl, re.S)
                        years_text = _clean_text(y_m.group(1)) if y_m else ""
                        deg_raw = re.sub(r'<span class="edu-years">.*?</span>', '', tl, flags=re.S)
                        deg_text = _clean_text(deg_raw)

                    if sch_text:
                        right_flowables.append(Paragraph(sch_text, company_style))
                        right_flowables.append(Spacer(1, 1))

                    if deg_text or years_text:
                        deg_label = f"<font size='6.5'>■</font>&nbsp; {deg_text}"
                        e_table = Table(
                            [[Paragraph(deg_label, role_style), Paragraph(years_text, date_style)]],
                            colWidths=[310, 107]
                        )
                        e_table.setStyle(TableStyle([
                            ('VALIGN', (0,0), (-1,-1), 'BASELINE'),
                            ('LEFTPADDING', (0,0), (-1,-1), 0),
                            ('RIGHTPADDING', (0,0), (-1,-1), 0),
                            ('TOPPADDING', (0,0), (-1,-1), 0),
                            ('BOTTOMPADDING', (0,0), (-1,-1), 0.5),
                        ]))
                        right_flowables.append(e_table)
                        right_flowables.append(Spacer(1, 1))

                    edu_bullets = re.findall(r'<li>(.*?)</li>', chunk, re.S)
                    for eb in edu_bullets:
                        eb_text = _clean_text(eb)
                        eb_item = f"•&nbsp; {eb_text}"
                        right_flowables.append(Paragraph(eb_item, bullet_style))
                        right_flowables.append(Spacer(1, 0.8))

                    if idx < len(edu_chunks) - 1:
                        right_flowables.append(Spacer(1, 2.5))

            # Skills
            if "skillgroup" in content_html:
                skill_chunks = content_html.split('<div class="skillgroup">')[1:]
                for chunk in skill_chunks:
                    h4_m = re.search(r'<h4>(.*?)</h4>', chunk, re.S)
                    grp_title = _clean_text(h4_m.group(1)) if h4_m else ""

                    tags_m = re.search(r'<div class="tags">(.*?)</div>', chunk, re.S)
                    desc_m = re.search(r'<div class="skilldesc">(.*?)</div>', chunk, re.S)

                    tags = []
                    if tags_m:
                        tags = [_clean_text(t) for t in re.findall(r'<span>(.*?)</span>', tags_m.group(1), re.S)]
                    elif desc_m:
                        tags = [_clean_text(desc_m.group(1))]

                    tags_str = ", ".join(t for t in tags if t)

                    if grp_title:
                        right_flowables.append(Paragraph(grp_title, skill_head_style))
                        right_flowables.append(Spacer(1, 0.5))
                    if tags_str:
                        right_flowables.append(Paragraph(tags_str, body_text_style))
                        right_flowables.append(Spacer(1, 2))

            # Inline List (Languages & Certifications)
            if "inline-list" in content_html:
                items = re.findall(r'<li>\s*<span>(.*?)</span>\s*(?:<span>(.*?)</span>)?\s*</li>', content_html, re.S)
                for item_left, item_right in items:
                    left_clean = _clean_text(item_left)
                    right_clean = _clean_text(item_right) if item_right else ""
                    item_label = f"<font size='6.5'>■</font>&nbsp; {left_clean}"
                    i_table = Table(
                        [[Paragraph(item_label, body_text_style), Paragraph(right_clean, date_style)]],
                        colWidths=[310, 107]
                    )
                    i_table.setStyle(TableStyle([
                        ('VALIGN', (0,0), (-1,-1), 'BASELINE'),
                        ('LEFTPADDING', (0,0), (-1,-1), 0),
                        ('RIGHTPADDING', (0,0), (-1,-1), 0),
                        ('TOPPADDING', (0,0), (-1,-1), 0),
                        ('BOTTOMPADDING', (0,0), (-1,-1), 0.5),
                    ]))
                    right_flowables.append(i_table)
                    right_flowables.append(Spacer(1, 1))

            if not right_flowables:
                clean_raw = _clean_text(content_html)
                if clean_raw:
                    right_flowables.append(Paragraph(clean_raw, body_text_style))

            # Assemble row table with Left Title and Right Content
            row_table = Table(
                [[title_p, right_flowables]],
                colWidths=[LEFT_COL_W, RIGHT_COL_W]
            )
            row_table.setStyle(TableStyle([
                ('VALIGN', (0,0), (-1,-1), 'TOP'),
                ('LEFTPADDING', (0,0), (-1,-1), 0),
                ('RIGHTPADDING', (0,0), (-1,-1), 0),
                ('TOPPADDING', (0,0), (-1,-1), 0),
                ('BOTTOMPADDING', (0,0), (-1,-1), 2),
            ]))

            # Page break before Skills section so Page 1 has Experience & Formation, Page 2 has Skills, Languages, Certifications
            if "COMPÉTENCE" in title_text.upper() or "SKILL" in title_text.upper():
                story.append(PageBreak())

            story.append(row_table)
            story.append(Spacer(1, 2))

        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(pdf_path),
            pagesize=A4,
            leftMargin=35,
            rightMargin=35,
            topMargin=22,
            bottomMargin=22
        )

        doc.build(story)
        return pdf_path.exists() and pdf_path.stat().st_size > 2000
    except Exception:
        return False
