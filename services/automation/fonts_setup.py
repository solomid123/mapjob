# -*- coding: utf-8 -*-
"""
Registers authentic fonts (Century Gothic) for ReportLab PDF generators.
"""

from pathlib import Path
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_REGISTERED = False
_FONT_FAMILY = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"

def setup_fonts() -> tuple[str, str]:
    global _REGISTERED, _FONT_FAMILY, _FONT_BOLD
    if _REGISTERED:
        return _FONT_FAMILY, _FONT_BOLD

    fonts_dir = Path(__file__).resolve().parent / "fonts"
    gothic = fonts_dir / "CenturyGothic.ttf"
    gothic_b = fonts_dir / "CenturyGothic-Bold.ttf"

    if gothic.exists() and gothic_b.exists():
        try:
            pdfmetrics.registerFont(TTFont("CenturyGothic", str(gothic)))
            pdfmetrics.registerFont(TTFont("CenturyGothic-Bold", str(gothic_b)))
            _FONT_FAMILY = "CenturyGothic"
            _FONT_BOLD = "CenturyGothic-Bold"
            _REGISTERED = True
            return _FONT_FAMILY, _FONT_BOLD
        except Exception:
            pass

    # Windows fallback
    win_gothic = Path("C:/Windows/Fonts/GOTHIC.TTF")
    win_gothic_b = Path("C:/Windows/Fonts/GOTHICB.TTF")
    if win_gothic.exists() and win_gothic_b.exists():
        try:
            pdfmetrics.registerFont(TTFont("CenturyGothic", str(win_gothic)))
            pdfmetrics.registerFont(TTFont("CenturyGothic-Bold", str(win_gothic_b)))
            _FONT_FAMILY = "CenturyGothic"
            _FONT_BOLD = "CenturyGothic-Bold"
            _REGISTERED = True
            return _FONT_FAMILY, _FONT_BOLD
        except Exception:
            pass

    _REGISTERED = True
    return _FONT_FAMILY, _FONT_BOLD
