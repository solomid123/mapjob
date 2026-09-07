# -*- coding: utf-8 -*-
"""
Playwright-based Autonomous Application Engine.
Features:
- Persistent browser session (Google/LinkedIn/Indeed cookies preserved)
- Fast semantic DOM filling (inputs, dropdowns, radio buttons, CV upload)
- Non-blocking exception detection (CAPTCHA/MFA -> capture screenshot, tag checkpoint, proceed immediately)
- Verification of submission success
"""

import os
import re
import json
import time
from pathlib import Path
from typing import Dict, Any, Optional

from playwright.sync_api import sync_playwright, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError

from .ats_detector import detect_ats_from_url, detect_ats_from_html
from .semantic_filler import match_semantic_field, answer_screening_question
from .db import record_application_status, is_already_applied

WORKSPACE_DIR = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = Path(__file__).resolve().parent / "user_data"
COOKIES_VAULT_PATH = Path(__file__).resolve().parent / "cookies_vault.json"
SCREENSHOTS_DIR = Path(__file__).resolve().parent / "screenshots"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

CAPTCHA_SELECTORS = [
    "iframe[src*='captcha']",
    "iframe[src*='recaptcha']",
    "iframe[src*='turnstile']",
    "iframe[src*='cloudflare']",
    ".g-recaptcha",
    "#cf-turnstile",
    "#challenge-stage"
]

SUBMIT_PATTERNS = [
    r"envoyer.*candidature",
    r"submit.*application",
    r"^postuler$",
    r"^envoyer$",
    r"^submit$",
    r"candidater",
    r"confirm.*application",
    r"^apply$"
]

SUCCESS_INDICATORS = [
    "merci",
    "candidature a bien été",
    "application.*submitted",
    "thank you",
    "application received",
    "succès",
    "success",
    "reçu votre candidature"
]

class BrowserEngine:
    def __init__(self, headless: bool = False):
        self.headless = headless
        self.playwright = None
        self.context: Optional[BrowserContext] = None

    def start(self) -> None:
        """Starts Playwright with a persistent user data directory."""
        if not self.playwright:
            self.playwright = sync_playwright().start()
            
            # Persistent context keeps cookies, localStorage and auth sessions active
            self.context = self.playwright.chromium.launch_persistent_context(
                user_data_dir=str(USER_DATA_DIR),
                headless=self.headless,
                viewport={"width": 1280, "height": 880},
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-infobars"
                ]
            )

            # Inject session cookies if available
            self._inject_vault_cookies()

    def _inject_vault_cookies(self) -> None:
        """Injects saved cookies from vault into browser context."""
        if not self.context or not COOKIES_VAULT_PATH.exists():
            return
        try:
            with open(COOKIES_VAULT_PATH, "r", encoding="utf-8") as f:
                cookies = json.load(f)
            formatted = []
            for c in cookies:
                cookie_dict = {
                    "name": c.get("name"),
                    "value": c.get("value"),
                    "domain": c.get("domain", "").lstrip("."),
                    "path": c.get("path", "/")
                }
                if "sameSite" in c and c["sameSite"] in ("Strict", "Lax", "None"):
                    cookie_dict["sameSite"] = c["sameSite"]
                formatted.append(cookie_dict)
            if formatted:
                self.context.add_cookies(formatted)
        except Exception as e:
            print(f"[BrowserEngine] Cookie injection notice: {e}", flush=True)

    def close(self) -> None:
        """Closes browser context."""
        if self.context:
            self.context.close()
            self.context = None
        if self.playwright:
            self.playwright.stop()
            self.playwright = None

    def apply_job(
        self,
        job_url: str,
        candidate_vault: Dict[str, Any],
        cv_path: Path,
        dry_run: bool = False
    ) -> Dict[str, Any]:
        """
        Executes end-to-end application workflow on the given job URL.
        """
        if is_already_applied(job_url):
            return {"status": "SKIPPED", "reason": "ALREADY_APPLIED", "url": job_url}

        self.start()
        page = self.context.new_page()

        try:
            print(f"[BrowserEngine] Navigating to: {job_url}", flush=True)
            page.goto(job_url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_timeout(2000)

            # 1. Check for CAPTCHA / Cloudflare challenge (non-blocking exception)
            for sel in CAPTCHA_SELECTORS:
                if page.locator(sel).first.is_visible():
                    screenshot_path = str(SCREENSHOTS_DIR / f"captcha_{int(time.time())}.png")
                    page.screenshot(path=screenshot_path)
                    record_application_status(
                        job_url=job_url,
                        status="NEEDS_CHECKPOINT",
                        checkpoint_reason="CAPTCHA",
                        screenshot_path=screenshot_path
                    )
                    return {
                        "status": "NEEDS_CHECKPOINT",
                        "reason": "CAPTCHA",
                        "screenshot": screenshot_path,
                        "url": job_url
                    }

            # 2. Look for initial "Postuler" / "Apply" button if form is not yet visible
            self._handle_initial_apply_clicks(page)

            # 3. Detect ATS platform
            html = page.content()
            ats_info = detect_ats_from_html(html, job_url)
            platform = ats_info["platform"]

            # 4. Fill form inputs semantically
            filled_count = self._fill_form_fields(page, candidate_vault, cv_path)

            # 5. Handle consent checkboxes
            self._accept_legal_checkboxes(page)

            # 6. Capture pre-submit state
            timestamp = int(time.time())
            pre_submit_shot = str(SCREENSHOTS_DIR / f"presubmit_{timestamp}.png")
            page.screenshot(path=pre_submit_shot)

            if dry_run:
                record_application_status(
                    job_url=job_url,
                    status="DRY_RUN_COMPLETED",
                    ats_platform=platform,
                    screenshot_path=pre_submit_shot
                )
                return {"status": "DRY_RUN_COMPLETED", "fields_filled": filled_count, "url": job_url}

            # 7. Submit Application
            submitted = self._click_submit_button(page)
            if not submitted:
                record_application_status(
                    job_url=job_url,
                    status="NEEDS_CHECKPOINT",
                    ats_platform=platform,
                    checkpoint_reason="SUBMIT_BUTTON_NOT_FOUND",
                    screenshot_path=pre_submit_shot
                )
                return {"status": "NEEDS_CHECKPOINT", "reason": "SUBMIT_BUTTON_NOT_FOUND", "url": job_url}

            # 8. Wait & verify success
            page.wait_for_timeout(3500)
            page_content_after = page.content().lower()

            is_success = any(ind in page_content_after for ind in SUCCESS_INDICATORS)
            result_shot = str(SCREENSHOTS_DIR / f"result_{timestamp}.png")
            page.screenshot(path=result_shot)

            if is_success:
                record_application_status(
                    job_url=job_url,
                    status="APPLIED",
                    ats_platform=platform,
                    screenshot_path=result_shot
                )
                return {"status": "APPLIED", "ats": platform, "url": job_url}
            else:
                record_application_status(
                    job_url=job_url,
                    status="SUBMITTED_UNVERIFIED",
                    ats_platform=platform,
                    screenshot_path=result_shot
                )
                return {"status": "SUBMITTED_UNVERIFIED", "ats": platform, "url": job_url}

        except Exception as e:
            err_shot = str(SCREENSHOTS_DIR / f"error_{int(time.time())}.png")
            try:
                page.screenshot(path=err_shot)
            except Exception:
                pass
            record_application_status(
                job_url=job_url,
                status="FAILED",
                error_message=str(e),
                screenshot_path=err_shot
            )
            return {"status": "FAILED", "error": str(e), "url": job_url}
        finally:
            page.close()

    def _handle_initial_apply_clicks(self, page: Page) -> None:
        """Clicks intermediate 'Postuler' / 'Apply now' buttons if form is behind a modal or expander."""
        apply_buttons = page.locator("button, a").filter(has_text=re.compile(r"(postuler|candidater|apply now|easy apply|postuler directement)", re.I))
        count = apply_buttons.count()
        for i in range(min(count, 3)):
            btn = apply_buttons.nth(i)
            if btn.is_visible():
                try:
                    btn.click(timeout=1500)
                    page.wait_for_timeout(1000)
                    break
                except Exception:
                    pass

    def _fill_form_fields(self, page: Page, candidate_vault: Dict[str, Any], cv_path: Path) -> int:
        """Iterates over visible form inputs and fills them using candidate profile."""
        filled = 0
        personal = candidate_vault.get("personal", {})
        legal = candidate_vault.get("legal", {})

        inputs = page.locator("input:visible, textarea:visible")
        count = inputs.count()

        for i in range(count):
            inp = inputs.nth(i)
            try:
                inp_type = (inp.get_attribute("type") or "text").lower()
                inp_name = (inp.get_attribute("name") or "").lower()
                inp_id = (inp.get_attribute("id") or "").lower()
                placeholder = (inp.get_attribute("placeholder") or "").lower()
                aria_label = (inp.get_attribute("aria-label") or "").lower()

                # Find associated label text if present
                label_text = ""
                if inp_id:
                    lbl = page.locator(f"label[for='{inp_id}']").first
                    if lbl.is_visible():
                        label_text = lbl.inner_text().strip().lower()

                # 1. File Upload (CV)
                if inp_type == "file":
                    if cv_path.exists():
                        inp.set_input_files(str(cv_path))
                        filled += 1
                        continue

                # 2. Text / Tel / Email fields
                field_key = match_semantic_field(
                    label=f"{label_text} {aria_label}",
                    name=inp_name,
                    placeholder=placeholder,
                    field_id=inp_id
                )

                if field_key == "first_name":
                    inp.fill(personal.get("first_name", ""))
                    filled += 1
                elif field_key == "last_name":
                    inp.fill(personal.get("last_name", ""))
                    filled += 1
                elif field_key == "full_name":
                    inp.fill(personal.get("full_name", ""))
                    filled += 1
                elif field_key == "email":
                    inp.fill(personal.get("email", ""))
                    filled += 1
                elif field_key == "phone":
                    inp.fill(personal.get("phone_formatted", personal.get("phone", "")))
                    filled += 1
                elif field_key == "city":
                    inp.fill(personal.get("city", "Amiens"))
                    filled += 1
                elif field_key == "postal_code":
                    inp.fill(personal.get("postal_code", "80000"))
                    filled += 1
                elif field_key == "address":
                    inp.fill(personal.get("address_street", ""))
                    filled += 1
                elif field_key == "linkedin":
                    inp.fill(personal.get("linkedin", ""))
                    filled += 1
                elif field_key == "salary":
                    inp.fill("45000")
                    filled += 1

            except Exception:
                continue

        return filled

    def _accept_legal_checkboxes(self, page: Page) -> None:
        """Checks required privacy/terms/consent checkboxes."""
        checkboxes = page.locator("input[type='checkbox']:visible")
        count = checkboxes.count()
        for i in range(count):
            cb = checkboxes.nth(i)
            try:
                if not cb.is_checked():
                    cb.check(timeout=1000)
            except Exception:
                pass

    def _click_submit_button(self, page: Page) -> bool:
        """Finds and clicks the primary application submission button."""
        for pat in SUBMIT_PATTERNS:
            buttons = page.locator("button, input[type='submit']").filter(has_text=re.compile(pat, re.I))
            count = buttons.count()
            for i in range(count):
                btn = buttons.nth(i)
                if btn.is_visible():
                    try:
                        btn.click(timeout=2500)
                        return True
                    except Exception:
                        pass
        return False
