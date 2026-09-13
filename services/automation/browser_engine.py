# -*- coding: utf-8 -*-
"""
Playwright-based Autonomous Application Engine.
Features:
- Persistent browser session (Google/LinkedIn/Indeed cookies preserved)
- Fast semantic DOM filling (inputs, dropdowns, radio buttons, CV upload)
- Non-blocking exception detection (CAPTCHA/MFA -> capture screenshot, tag checkpoint, proceed immediately)
- Verification of submission success
"""

import base64
import os
import re
import json
import time
from pathlib import Path
from typing import Callable, Dict, Any, Optional

from playwright.sync_api import sync_playwright, BrowserContext, Page, TimeoutError as PlaywrightTimeoutError

from .ats_detector import detect_ats_from_url, detect_ats_from_html
from .semantic_filler import match_semantic_field, answer_screening_question
from .db import record_application_status, is_already_applied
from .apply_brain import ApplyBrain, SENSITIVE_PATTERN

WORKSPACE_DIR = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = Path(__file__).resolve().parent / "user_data"
COOKIES_VAULT_PATH = Path(__file__).resolve().parent / "cookies_vault.json"
SCREENSHOTS_DIR = Path(__file__).resolve().parent / "screenshots"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

# Things that are an actual wall: a challenge the candidate has to answer.
#
# Deliberately not "any iframe with recaptcha in the URL". Greenhouse, Lever and
# most other boards embed invisible reCAPTCHA v3, whose badge iframe is present
# and visible on every single page and demands nothing from anyone. Treating it
# as a blocker meant the engine stopped on the job description of every
# Greenhouse listing without ever reaching the form.
CHALLENGE_SELECTORS = [
    ("CAPTCHA", "iframe[src*='recaptcha/api2/bframe']"),   # the image-grid popup
    ("CAPTCHA", "iframe[src*='hcaptcha.com/captcha']"),
    ("CAPTCHA", "iframe[title*='challenge' i]"),
    ("CAPTCHA", ".geetest_holder"),                        # the slide-to-unlock widget
    ("CAPTCHA", ".geetest_slider"),
    ("CLOUDFLARE", "#challenge-stage"),
    ("CLOUDFLARE", "#cf-turnstile"),
    ("CLOUDFLARE", "iframe[src*='challenges.cloudflare.com']"),
]

# Interstitials that replace the page entirely rather than embedding a widget.
# SmartRecruiters serves one of these instead of the job when it decides the
# traffic looks automated, and it carries no iframe to key off -- without this
# the engine reported "no form found", which described the symptom and hid the
# cause. These phrases do not occur in job descriptions.
CHALLENGE_TEXT_PATTERN = re.compile(
    r"(verification required|slide right to secure your access|"
    r"we detected unusual activity|checking your browser before|"
    r"v[ée]rification requise|please verify you are (a )?human|"
    r"press and hold to confirm you are|enable javascript and cookies to continue)",
    re.I,
)

# An interactive checkbox widget only counts once it is actually rendered at a
# usable size; collapsed or zero-size instances are the invisible variety.
MIN_CHALLENGE_PX = 60

# How long to give a client-rendered application form to appear after the apply
# click. Generous on purpose: waiting a few extra seconds costs nothing, while
# giving up early loses the application entirely.
FORM_WAIT_MS = 20000

# How long to hold a run open while the candidate answers a challenge in the
# browser window that is already in front of them. Long enough to walk back to
# the keyboard, short enough that an unattended machine gives up.
CHALLENGE_WAIT_S = 120

# How long to wait for a page to confirm it has taken the CV. Uploads go over
# the network and several boards parse the file before showing it, so this is
# seconds rather than milliseconds.
UPLOAD_VERIFY_S = 15

# Consent banners, in the order worth trying. The named ids belong to the three
# platforms that cover most of the boards we see; the text pattern catches the
# rest. European job boards put one of these over the apply button on load.
COOKIE_DISMISS_SELECTORS = [
    "#onetrust-reject-all-handler",
    "#onetrust-accept-btn-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "button[data-testid='uc-deny-all-button']",
    "button[aria-label*='reject' i]",
    "button[aria-label*='accept cookies' i]",
]
COOKIE_BUTTON_PATTERN = re.compile(
    r"^\s*(reject all|decline|accept all cookies|accept all|accept cookies|"
    r"tout refuser|tout accepter|accepter|alles accepteren|alles afwijzen|"
    r"alle akzeptieren|akzeptieren|ablehnen|aceptar todo)\s*$",
    re.I,
)

# The button that opens the application form. A job board serves whatever
# language its office speaks, so an English-only list quietly did nothing on
# roughly half of the European listings in the feed.
#
# This list will always be incomplete -- a French SmartRecruiters page saying
# "Je suis interesse(e)" was reported as "no application form could be reached"
# purely because that phrase was not written down here. So it is now the fast
# path rather than the only path: when nothing matches, the page's clickables
# go to the brain, which reads them in any language. See _find_apply_control.
APPLY_BUTTON_PATTERN = re.compile(
    r"(apply now|apply for this job|easy apply|^\s*apply\s*$|i'?m interested|"
    r"postuler|candidater|je postule|je suis int[ée]ress[ée]|d[ée]poser ma candidature|"
    r"solliciteer|solliciteren|ik ben ge[ïi]nteresseerd|"
    r"jetzt bewerben|bewerben|ich bin interessiert|"
    r"candidatura|candidati|postularme|inscrever|sono interessato|estoy interesado)",
    re.I,
)

# Controls that look like the apply button to a loose matcher but are not.
# "Recommander un(e) ami(e)" (refer a friend) sits directly under the real one
# on SmartRecruiters and contains none of the apply words -- but the brain gets
# shown every control, so the exclusions have to be explicit somewhere.
NOT_APPLY_PATTERN = re.compile(
    r"(refer a friend|recommander|share|partager|teilen|save (this )?job|"
    r"job alert|alerte|sign in|log in|se connecter|anmelden|register|"
    r"all jobs|tous les postes|other jobs|autres postes|view all|afficher tous)",
    re.I,
)

# The employer's own "we are broken, come back later" page. It is not a
# CAPTCHA, not a login wall, and emphatically not "no form found" -- there is
# nothing wrong with the listing and nothing for the candidate to fix by hand,
# which is what every other checkpoint message implies.
FORM_UNAVAILABLE_PATTERN = re.compile(
    r"(application form is (temporarily |currently )?unavailable|"
    r"formulaire de candidature est temporairement indisponible|"
    r"probl[èe]me technique|technical (problem|issue|difficult)|"
    r"vor[üu]bergehend nicht verf[üu]gbar|"
    r"temporarily unavailable.{0,40}(try again|r[ée]essayer))",
    re.I,
)
RELOAD_BUTTON_PATTERN = re.compile(r"^\s*(recharger|reload|refresh|try again|r[ée]essayer)\s*$", re.I)

RESUME_PATTERN = re.compile(r"(resume|r[ée]sum[ée]|\bcv\b|curriculum)", re.I)
COVER_LETTER_PATTERN = re.compile(r"(cover.?letter|lettre.?de.?motivation|motivation)", re.I)

# Avatar uploads sit on the same form as the CV box and look identical to a
# selector. A PDF dropped in one of these is rejected by the page and leaves
# the real CV field empty.
PHOTO_UPLOAD_PATTERN = re.compile(
    r"(photo|avatar|profile\s*picture|profilbild|foto|image de profil)", re.I,
)

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

# A checkbox is only ticked automatically if its own text says it is a consent
# to terms or to data processing. Everything else on a form -- sponsorship
# needs, disability disclosure, marketing opt-ins, screening questions -- is an
# answer about the candidate and is theirs to give, so it is left untouched and
# reported instead.
CONSENT_PATTERN = re.compile(
    r"(consent|agree|accept|terms|conditions|privacy|policy|gdpr|rgpd|"
    r"data\s*process|personal\s*data|donn[ée]es\s*personnelles|"
    r"politique\s*de\s*confidentialit|j'accepte|acknowledge)",
    re.I,
)

# Proof that an application actually arrived.
#
# What was here before was a list of bare substrings -- "merci", "success",
# "thank you" -- tested with `in` against `page.content().lower()`, which is the
# raw HTML. Three separate ways to be wrong, and all three are common:
#
#   * "merci" matches "Merci de remplir tous les champs obligatoires" -- French
#     for "please fill in all the required fields". That is a validation error.
#     The run reported APPLIED, wrote it to the database, and the candidate was
#     told the employer had confirmed receipt of an application that was never
#     sent. Of everything in this file that was the one bug that lied.
#   * "success" matches HTML, not prose: class="alert-success", a bundle named
#     success.js, an inline SVG id. Every page has some.
#   * "thank you" matches the cookie banner's "thank you for visiting".
#
# So: whole phrases, anchored on the words that only appear once a submission
# has been accepted, tested against the text a human can actually read.
SUBMISSION_CONFIRMED = re.compile(
    r"(thank(s| you)[^.]{0,30}(for )?(your )?(application|applying|interest|submission)|"
    r"your application (has been|was|is) [^.]{0,25}(submitted|received|sent|registered)|"
    r"application (has been|was) (successfully )?(submitted|received|sent)|"
    r"we(\s|')?ve received your application|application received|you(\s|')?ve applied|"
    r"submission (successful|confirmed|complete)|successfully (submitted|applied)|"
    r"votre candidature a (bien )?[ée]t[ée] (envoy[ée]e|re[çc]ue|enregistr[ée]e|transmise|prise en compte)|"
    r"nous avons (bien )?re[çc]u votre candidature|merci (pour|de) votre candidature|"
    r"candidature (bien )?(envoy[ée]e|transmise|enregistr[ée]e)|vous avez d[ée]j[àa] postul[ée]|"
    r"bedankt voor je sollicitatie|sollicitatie (is )?ontvangen|"
    r"vielen dank f[üu]r (deine|ihre) bewerbung|bewerbung (wurde )?(erfolgreich )?(gesendet|erhalten)|"
    r"grazie per la (tua )?candidatura|gracias por tu (solicitud|candidatura))",
    re.I,
)

# Some ATSes confirm by navigation rather than by prose.
SUBMISSION_CONFIRMED_URL = re.compile(
    r"(thank[-_ ]?you|/thanks?(?:[/?#]|$)|application[-_/]?(submitted|received|complete|confirmation)|"
    r"apply[-_/]?(success|confirmed|confirmation|complete)|confirmation(?:[/?#]|$))",
    re.I,
)

class BrowserEngine:
    def __init__(
        self,
        headless: bool = False,
        on_status: Optional[Callable[[str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ):
        self.headless = headless
        self.playwright = None
        self.context: Optional[BrowserContext] = None
        # Optional throughout. Every call site has a deterministic path that
        # runs when the brain is unavailable, slow, or unsure.
        self.brain = ApplyBrain(on_log=lambda text: self._log(text))
        # Progress, reported as it happens. A run can now legitimately sit for
        # two minutes waiting on a human, and a spinner that says nothing for
        # two minutes is indistinguishable from a hang.
        self.on_status = on_status
        # A running commentary of what was actually done. Every one of these
        # lines already existed as a `print` that went to a server console
        # nobody watching the app can see, which is why a 40-second run looked
        # from the outside like a frozen spinner. The same sentence is worth
        # far more on the candidate's screen, especially the refusals: "left
        # Salary Expectation empty" is the app explaining itself.
        self.on_log = on_log

    def _report(self, status: str) -> None:
        if not self.on_status:
            return
        try:
            self.on_status(status)
        except Exception:
            pass

    def _log(self, text: str) -> None:
        """One line of what just happened, to the console and to the caller."""
        print(f"[BrowserEngine] {text}", flush=True)
        if not self.on_log:
            return
        try:
            self.on_log(text)
        except Exception:
            pass

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
            # The vault on disk is keyed by domain in some versions and a flat
            # list in others. Reading the wrong shape printed a confusing
            # "'str' object has no attribute 'get'" at the top of every single
            # run, which read like a browser failure and was neither.
            if isinstance(cookies, dict):
                cookies = [c for group in cookies.values() if isinstance(group, list) for c in group]
            formatted = []
            for c in cookies:
                if not isinstance(c, dict):
                    continue
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
        dry_run: bool = False,
        job_title: str = "",
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

            # 1. A challenge on the landing page blocks everything after it.
            blocked = self._checkpoint_if_challenged(page, job_url)
            if blocked:
                return blocked

            # 2. Clear the consent overlay, open the form, and wait for it.
            self._dismiss_cookie_banner(page)
            self._handle_initial_apply_clicks(page, job_title)
            self._wait_for_form(page)
            self._retry_unavailable_form(page)

            # A challenge often appears only once the form opens, so look again
            # rather than assuming the landing page told the whole story.
            blocked = self._checkpoint_if_challenged(page, job_url)
            if blocked:
                return blocked

            # 3. Detect ATS platform
            html = page.content()
            ats_info = detect_ats_from_html(html, job_url)
            platform = ats_info["platform"]

            # 4. Attach the CV to the resume slot, then fill the text inputs.
            self._report("FILLING")
            self._log(f"Application form open ({platform}).")
            resume_attached = self._attach_resume(page, cv_path)
            self._log(
                f"CV attached: {cv_path.name}" if resume_attached
                else "CV could not be attached to this form."
            )
            filled_count = self._fill_form_fields(page, candidate_vault, cv_path)
            # Then the labels the keyword matcher does not know, and the
            # dropdowns it could never touch.
            filled_count += self._fill_unknown_fields(page, candidate_vault)
            if resume_attached:
                filled_count += 1

            # 5. Handle consent checkboxes
            consents = self._accept_legal_checkboxes(page)
            if consents:
                self._log(f"Ticked {consents} consent box{'es' if consents != 1 else ''}.")

            # 6. If nothing was filled and no CV went anywhere, there was no form
            # on this page -- the apply flow is behind a login, a redirect, or a
            # button in a language we did not recognise. Saying "form filled" and
            # offering a submit button here would be an outright lie, and the
            # submit would click something arbitrary.
            if filled_count == 0 and not resume_attached:
                # Ask why before blaming the form. Anti-bot interstitials are
                # served late, after the apply click, so the earlier checks can
                # pass and the page still end up as a challenge by the time we
                # look for inputs. "No form found" would describe the symptom
                # and hide the cause the candidate can actually act on.
                late_challenge = self._checkpoint_if_challenged(page, job_url)
                if late_challenge:
                    return late_challenge

                # The employer's form may simply be down. Telling the candidate
                # to "carry on by hand" in that case sends them to the same
                # broken page to be told the same thing.
                if self._form_is_unavailable(page):
                    reason = "FORM_UNAVAILABLE"
                else:
                    # APEC, LinkedIn and Meteojob show a signed-out visitor a
                    # login wall where the form would be. That is a different
                    # problem with a different, permanent fix -- sign in once
                    # in the window that is already open, and the persistent
                    # browser profile carries the session into every later run.
                    # Reporting it as "no form found" hid a one-time fix behind
                    # a message that sounded like a dead end.
                    from .adzuna_client import portal_needing_login
                    try:
                        portal = portal_needing_login(page.url or "")
                    except Exception:
                        portal = None
                    if portal and self._looks_like_login(page):
                        reason = f"LOGIN_REQUIRED:{portal}"
                        self._log(f"{portal} wants you signed in before it shows the form.")
                    else:
                        reason = "NO_FORM_FOUND"

                no_form_shot = str(SCREENSHOTS_DIR / f"noform_{int(time.time())}.png")
                self._capture(page, no_form_shot)
                record_application_status(
                    job_url=job_url,
                    status="NEEDS_CHECKPOINT",
                    ats_platform=platform,
                    checkpoint_reason=reason,
                    screenshot_path=no_form_shot,
                )
                return {
                    "status": "NEEDS_CHECKPOINT",
                    "reason": reason,
                    "fields_filled": 0,
                    "resume_attached": False,
                    "screenshot": no_form_shot,
                    "ats": platform,
                    "url": job_url,
                }

            # 7. What the form still wants. Nothing below can supply it, so the
            # candidate has to, and they can only do that if they are told.
            missing = self._missing_required(page)

            # 6. Capture pre-submit state
            timestamp = int(time.time())
            pre_submit_shot = str(SCREENSHOTS_DIR / f"presubmit_{timestamp}.png")
            # Full page, not the viewport. This image is the only thing the
            # candidate gets to check before the form is sent in their name,
            # and a viewport shot showed whichever paragraph the filler had
            # scrolled to rather than the fields it had typed into.
            self._capture(page, pre_submit_shot)

            if dry_run:
                record_application_status(
                    job_url=job_url,
                    status="DRY_RUN_COMPLETED",
                    ats_platform=platform,
                    screenshot_path=pre_submit_shot
                )
                # The screenshot is the entire point of a dry run: it is the only
                # way the candidate can see what was typed into their application
                # before it goes anywhere. It was being written to the database
                # and then dropped from the return value, so the caller had
                # nothing to show.
                return {
                    "status": "DRY_RUN_COMPLETED",
                    "fields_filled": filled_count,
                    "consents_ticked": consents,
                    "resume_attached": resume_attached,
                    "missing_required": missing,
                    "screenshot": pre_submit_shot,
                    "ats": platform,
                    "url": job_url,
                }

            # 7. Refuse to send an incomplete application.
            #
            # The form would reject it anyway, but the failure would arrive as a
            # confusing "submitted, unverified" rather than a plain statement of
            # what is missing. Fail closed and say which fields.
            if missing:
                record_application_status(
                    job_url=job_url,
                    status="NEEDS_CHECKPOINT",
                    ats_platform=platform,
                    checkpoint_reason="INCOMPLETE_FORM",
                    screenshot_path=pre_submit_shot,
                )
                return {
                    "status": "NEEDS_CHECKPOINT",
                    "reason": "INCOMPLETE_FORM",
                    "missing_required": missing,
                    "fields_filled": filled_count,
                    "resume_attached": resume_attached,
                    "screenshot": pre_submit_shot,
                    "ats": platform,
                    "url": job_url,
                }

            # 8. Submit Application
            submitted = self._click_submit_button(page)
            if not submitted:
                record_application_status(
                    job_url=job_url,
                    status="NEEDS_CHECKPOINT",
                    ats_platform=platform,
                    checkpoint_reason="SUBMIT_BUTTON_NOT_FOUND",
                    screenshot_path=pre_submit_shot
                )
                return {
                    "status": "NEEDS_CHECKPOINT",
                    "reason": "SUBMIT_BUTTON_NOT_FOUND",
                    "screenshot": pre_submit_shot,
                    "fields_filled": filled_count,
                    "ats": platform,
                    "url": job_url,
                }

            # 8. Wait & verify success
            page.wait_for_timeout(3500)

            is_success, evidence = self._submission_confirmed(page)
            self._log(
                f"Employer's page confirmed it: \"{evidence}\"" if is_success
                else "Sent, but the page showed no confirmation."
            )
            result_shot = str(SCREENSHOTS_DIR / f"result_{timestamp}.png")
            self._capture(page, result_shot)

            if is_success:
                record_application_status(
                    job_url=job_url,
                    status="APPLIED",
                    ats_platform=platform,
                    screenshot_path=result_shot
                )
                return {
                    "status": "APPLIED",
                    "ats": platform,
                    "fields_filled": filled_count,
                    "screenshot": result_shot,
                    "url": job_url,
                }
            else:
                record_application_status(
                    job_url=job_url,
                    status="SUBMITTED_UNVERIFIED",
                    ats_platform=platform,
                    screenshot_path=result_shot
                )
                return {
                    "status": "SUBMITTED_UNVERIFIED",
                    "ats": platform,
                    "fields_filled": filled_count,
                    "screenshot": result_shot,
                    "url": job_url,
                }

        except Exception as e:
            err_shot = str(SCREENSHOTS_DIR / f"error_{int(time.time())}.png")
            try:
                self._capture(page, err_shot)
            except Exception:
                pass
            record_application_status(
                job_url=job_url,
                status="FAILED",
                error_message=str(e),
                screenshot_path=err_shot
            )
            return {"status": "FAILED", "error": str(e), "screenshot": err_shot, "url": job_url}
        finally:
            page.close()

    def _attach_resume(self, page: Page, cv_path: Path) -> bool:
        """Put the CV in the resume slot, and nowhere else.

        Upload inputs are usually hidden behind a styled "Attach" button, so
        this deliberately does not filter on visibility -- `set_input_files`
        works on the hidden input directly. It does not touch the cover letter
        slot: a CV filed as a cover letter reads as carelessness to the person
        opening it, which is exactly what happened before.

        Nor does it touch a slot that has said it cannot take the file. The
        previous fallback -- "attach to the first unlabelled upload" -- put a
        PDF CV into Continental's profile-photo box, and the form answered with
        a red error saying it accepts .JPG and .PNG. The page had declared that
        in `accept` before anything was attached; the engine simply was not
        reading it.

        Candidates are tried in order and each attempt is verified, because a
        form can offer two identical-looking dropzones and only one of them is
        the CV.
        """
        if not cv_path.exists():
            return False

        named, unnamed = [], []
        uploads = page.locator("input[type='file']")
        for i in range(uploads.count()):
            field = uploads.nth(i)
            try:
                if not self._accepts_file(field, cv_path):
                    continue
                description = self._field_description(page, field)
                if COVER_LETTER_PATTERN.search(description) or PHOTO_UPLOAD_PATTERN.search(description):
                    continue
                (named if RESUME_PATTERN.search(description) else unnamed).append(field)
            except Exception:
                continue

        # Slots that call themselves the CV first; then anything else that will
        # take the file, since an application form's unlabelled dropzone is the
        # resume often enough to be worth trying.
        candidates = named + unnamed

        # Pass one: the ordinary way, briefly. A slot that works usually says so
        # within a couple of seconds.
        for field in candidates:
            try:
                field.set_input_files(str(cv_path))
            except Exception:
                continue
            if self._upload_confirmed(page, cv_path, seconds=6):
                return True

        # Pass two: put the file in by force. Measured on Continental's form,
        # the first dropzone sat unchanged for 31 seconds after
        # `set_input_files` -- it is a drag-and-drop widget that never listens
        # to the underlying input, so nothing was ever going to happen.
        for field in candidates:
            if not self._attach_by_drop(page, field, cv_path):
                continue
            if self._upload_confirmed(page, cv_path, seconds=10):
                return True
        return False

    def _attach_by_drop(self, page: Page, field, cv_path: Path) -> bool:
        """Hand the file to the page the way a drag-and-drop would.

        Playwright's `set_input_files` fills the input's file list and fires
        `change`. React-controlled uploaders and drop widgets often listen for
        neither: they want a real `drop` carrying a DataTransfer, on a
        container that is not the input at all. So the file is rebuilt inside
        the page from its bytes and delivered both ways.

        This is the same technique the Selenium agent in this project already
        used; the Playwright path simply never got it.
        """
        try:
            handle = field.element_handle()
            if handle is None:
                return False
            encoded = base64.b64encode(cv_path.read_bytes()).decode("ascii")
        except Exception:
            return False

        script = """
        ([input, b64, name, mime]) => {
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes], name, { type: mime });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          try { input.files = transfer.files; } catch (e) {}
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
          // The listener is usually on a wrapper, not the input itself.
          const zone = input.closest("[class*='drop' i],[class*='upload' i],[class*='dropzone' i],label,form")
                    || input.parentElement;
          if (zone) {
            for (const type of ['dragenter', 'dragover', 'drop']) {
              zone.dispatchEvent(new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: transfer,
              }));
            }
          }
          return true;
        }
        """
        try:
            page.evaluate(script, [handle, encoded, cv_path.name, "application/pdf"])
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"[BrowserEngine] Drop injection failed: {exc}", flush=True)
            return False

    def _upload_confirmed(self, page: Page, cv_path: Path, seconds: int) -> bool:
        """Whether the page is now showing the CV as attached.

        The claim in the UI is "your CV is on this form", so the evidence has
        to be the form saying so, not the fact that a function returned without
        throwing. Comparison ignores punctuation because boards re-render the
        name with spaces or dashes in place of underscores.
        """
        needle = re.sub(r"[^a-z0-9]", "", cv_path.stem.lower())
        deadline = time.time() + seconds
        while time.time() < deadline:
            page.wait_for_timeout(700)
            try:
                body = page.locator("body").first.inner_text().lower()
            except Exception:
                continue
            if needle and needle in re.sub(r"[^a-z0-9]", "", body):
                # Let any CV parsing the upload kicked off finish rewriting the
                # form before anything else is typed into it.
                page.wait_for_timeout(1500)
                return True
        return False

    def _accepts_file(self, field, cv_path: Path) -> bool:
        """Whether this input has said it will take a file of this type.

        An `accept` list is the page stating what belongs in the box. Ignoring
        it is how a CV ends up in the profile-photo slot.
        """
        try:
            accept = (field.get_attribute("accept") or "").strip()
        except Exception:
            return True
        if not accept:
            return True

        suffix = cv_path.suffix.lower()
        for token in (part.strip().lower() for part in accept.split(",")):
            if not token or token in ("*", "*/*"):
                return True
            if token.startswith("."):
                if token == suffix:
                    return True
            elif token.endswith("/*"):
                # A "application/*" style rule; too loose to rule anything out.
                return True
            elif token in ("application/pdf", "application/octet-stream") and suffix == ".pdf":
                return True
        return False

    def _field_description(self, page: Page, field) -> str:
        """Every scrap of text identifying one field, lowercased."""
        parts = []
        for attr in ("name", "id", "aria-label", "placeholder", "data-testid"):
            try:
                parts.append(field.get_attribute(attr) or "")
            except Exception:
                pass
        try:
            field_id = field.get_attribute("id")
            if field_id:
                label = page.locator(f"label[for='{field_id}']").first
                if label.count():
                    parts.append(label.inner_text())
        except Exception:
            pass
        try:
            container = field.locator("xpath=ancestor::*[self::label or self::div][1]")
            if container.count():
                parts.append(container.first.inner_text()[:160])
        except Exception:
            pass
        return " ".join(parts).lower()

    def _missing_required(self, page: Page) -> list:
        """Required fields still empty after filling, named as the form names them.

        An application submitted with blanks in its required fields is rejected
        by the form anyway, so this is what turns "it filled 6 things" into
        something the candidate can act on.
        """
        missing = []
        fields = page.locator(
            "input[required]:visible, select[required]:visible, textarea[required]:visible, "
            "input[aria-required='true']:visible, select[aria-required='true']:visible, "
            "textarea[aria-required='true']:visible"
        )
        for i in range(min(fields.count(), 40)):
            field = fields.nth(i)
            try:
                if (field.get_attribute("type") or "").lower() in ("checkbox", "radio", "hidden"):
                    continue
                if (field.input_value() or "").strip():
                    continue
                label = self._readable_label(page, field)
                if label and label not in missing:
                    missing.append(label)
            except Exception:
                continue
        return missing

    def _readable_label(self, page: Page, field) -> str:
        """The field's own label, as a person reads it off the page."""
        try:
            field_id = field.get_attribute("id")
            if field_id:
                label = page.locator(f"label[for='{field_id}']").first
                if label.count():
                    text = label.inner_text().strip().replace("*", "").strip()
                    if text:
                        return text[:80]
        except Exception:
            pass
        for attr in ("aria-label", "placeholder", "name"):
            try:
                value = (field.get_attribute(attr) or "").strip()
                if value:
                    return value[:80]
            except Exception:
                continue
        return ""

    def _follow_trackers(self, page: Page, max_hops: int = 4) -> str:
        """Walk an aggregator's redirect chain until a real employer page.

        Done in the browser rather than with `requests` on purpose. The last
        hop of these chains is frequently `location.href = ...` inside a
        <script>, or a meta refresh with a delay, and an HTTP client sees only
        an empty page with a "click here if you are not redirected" link. The
        browser follows all of it for free -- it just has to be given a moment
        and then asked where it ended up.

        Bounded by hops and by time, because two trackers pointing at each
        other is a redirect loop, and a loop with no ceiling is a hung run.
        """
        from .adzuna_client import is_tracker, portal_needing_login

        for _ in range(max_hops):
            try:
                current = page.url or ""
            except Exception:
                break
            if not is_tracker(current):
                break

            # The chain may still be in flight; give it a beat to settle.
            try:
                page.wait_for_load_state("networkidle", timeout=6000)
            except Exception:
                page.wait_for_timeout(1500)

            try:
                moved = page.url or ""
            except Exception:
                break
            if not is_tracker(moved):
                break

            # Still on a tracker with nothing happening: these pages carry a
            # "click here if you are not redirected automatically" escape link,
            # which is the only way forward when the auto-redirect is blocked.
            if not self._click_manual_redirect(page):
                break

        try:
            final = page.url or ""
        except Exception:
            return ""

        if is_tracker(final):
            self._log("Could not get past the aggregator's redirect.")
            return final

        portal = portal_needing_login(final)
        if portal:
            self._log(f"This one goes through {portal}.")
        return final

    def _looks_like_login(self, page: Page) -> bool:
        """A sign-in wall, rather than a page that merely has a login link.

        Judged on a password field being present and visible: every site has a
        "Se connecter" in its header, so matching on wording alone would label
        half the internet a login wall.
        """
        try:
            for field in page.query_selector_all("input[type='password']"):
                if field.is_visible():
                    return True
        except Exception:
            pass
        try:
            text = page.inner_text("body", timeout=3000)
        except Exception:
            return False
        return bool(re.search(
            r"(connectez-vous pour postuler|sign in to apply|log in to apply|"
            r"vous devez [êe]tre connect[ée]|cr[ée]er un compte pour postuler|"
            r"anmelden, um sich zu bewerben)", text, re.I))

    def _click_manual_redirect(self, page: Page) -> bool:
        """Take the "click here if not redirected" escape hatch, if offered."""
        pattern = re.compile(
            r"(click here|cliquez ici|continue|continuer|proceed|acc[ée]der|"
            r"voir l'offre|see the job|go to the (job|offer|advert))", re.I)
        try:
            for link in page.query_selector_all("a[href^='http'], button")[:40]:
                text = (link.inner_text() or "").strip()
                if not text or not pattern.search(text):
                    continue
                before = page.url
                link.click(timeout=3000)
                page.wait_for_timeout(2500)
                if page.url != before:
                    return True
        except Exception:
            pass
        return False

    def _submission_confirmed(self, page: Page) -> tuple:
        """Did the employer's page actually acknowledge the application?

        Returns (confirmed, evidence). `evidence` is the exact wording that was
        matched, so a claim of success can be checked against the screenshot
        instead of taken on trust.

        Read from rendered text, not `page.content()`. HTML is full of the words
        this is looking for -- class names, script bundles, hidden templates for
        a confirmation that has not happened yet -- and matching them is how a
        rejected form came to be reported as accepted.

        Confirmation is also looked for inside iframes: Greenhouse, Lever and
        SmartRecruiters all render the form, and therefore the thank-you that
        replaces it, in an embedded document.
        """
        texts = []
        try:
            texts.append(page.inner_text("body", timeout=4000))
        except Exception:
            pass
        for frame in page.frames:
            if frame is page.main_frame:
                continue
            try:
                texts.append(frame.inner_text("body", timeout=1500))
            except Exception:
                continue

        for text in texts:
            match = SUBMISSION_CONFIRMED.search(text or "")
            if match:
                return True, " ".join(match.group(0).split())[:80]

        # No prose, but some ATSes just navigate to a confirmation route.
        try:
            url = page.url or ""
        except Exception:
            url = ""
        match = SUBMISSION_CONFIRMED_URL.search(url)
        if match:
            return True, f"redirected to {match.group(0)}"

        return False, ""

    def _capture(self, page: Page, path: str) -> None:
        """Photograph the whole form, falling back to the viewport.

        `full_page` can throw on pages with virtualised or fixed-position
        layouts, and a missing screenshot would leave the candidate approving a
        submission they cannot see. A partial picture beats none.
        """
        try:
            page.screenshot(path=path, full_page=True)
        except Exception:
            try:
                page.screenshot(path=path)
            except Exception:
                pass

    def detect_challenge(self, page: Page) -> Optional[str]:
        """The kind of challenge blocking the page, or None if nothing is.

        A challenge is never solved or bypassed here. The browser is on screen
        and the person it belongs to can answer it; a script that defeated it
        would be lying to the employer on their behalf.
        """
        for reason, selector in CHALLENGE_SELECTORS:
            try:
                element = page.locator(selector).first
                if not element.count() or not element.is_visible():
                    continue
                box = element.bounding_box()
                # An element rendered at a sliver of a pixel is a hidden hook,
                # not something anyone is being asked to click.
                if box and (box["width"] < MIN_CHALLENGE_PX or box["height"] < MIN_CHALLENGE_PX):
                    continue
                return reason
            except Exception:
                continue

        # The v2 "I'm not a robot" checkbox, which is a real interruption. Its
        # invisible sibling shares the anchor URL, so size is what separates
        # them: the real widget renders at roughly 300x70.
        try:
            anchor = page.locator("iframe[src*='recaptcha/api2/anchor']").first
            if anchor.count() and anchor.is_visible():
                box = anchor.bounding_box()
                if box and box["width"] >= MIN_CHALLENGE_PX and box["height"] >= MIN_CHALLENGE_PX:
                    return "CAPTCHA"
        except Exception:
            pass

        # A whole-page interstitial. Every frame is searched, not just the top
        # document: bot-protection pages are usually served inside an iframe, so
        # reading the main body found an empty string and the check silently
        # never fired. Bounded by length so the phrase has to be the page rather
        # than a line buried in a long job description.
        for frame in page.frames:
            try:
                text = frame.locator("body").first.inner_text()
            except Exception:
                continue
            if text and len(text) < 4000 and CHALLENGE_TEXT_PATTERN.search(text):
                return "CAPTCHA"
        return None

    def _wait_out_challenge(self, page: Page, reason: str) -> bool:
        """Hold the run while the person at the keyboard answers the challenge.

        The check is not solved, faked, or routed to a solving service. The
        browser is already visible on the candidate's screen with the challenge
        on it, so the useful thing this can do is stop racing ahead and simply
        wait for them to click it, then carry on filling the form underneath.

        That turns the dead end this used to be -- abandon the run, tell them to
        start again by hand -- into a pause. Bounded, because an unattended
        machine must not sit on an open browser forever.
        """
        deadline = time.time() + CHALLENGE_WAIT_S
        print(
            f"[BrowserEngine] {reason} on screen. Waiting up to {CHALLENGE_WAIT_S}s "
            f"for you to answer it in the browser window.",
            flush=True,
        )
        self._report("WAITING_FOR_HUMAN")
        try:
            page.bring_to_front()
        except Exception:
            pass

        while time.time() < deadline:
            page.wait_for_timeout(1500)
            try:
                if self.detect_challenge(page) is None:
                    waited = int(CHALLENGE_WAIT_S - (deadline - time.time()))
                    print(f"[BrowserEngine] Challenge cleared after {waited}s. Carrying on.", flush=True)
                    self._report("FILLING")
                    page.wait_for_timeout(1500)
                    return True
            except Exception:
                # A navigation mid-check is usually the challenge passing.
                continue
        return False

    def _checkpoint_if_challenged(self, page: Page, job_url: str) -> Optional[Dict[str, Any]]:
        """Records and returns a checkpoint result, or None to carry on."""
        reason = self.detect_challenge(page)
        if not reason:
            return None

        # Give the candidate the chance to clear it themselves before writing
        # the run off; most of these are one click or one slider.
        if self._wait_out_challenge(page, reason):
            return None

        shot = str(SCREENSHOTS_DIR / f"challenge_{int(time.time())}.png")
        # Viewport only: a challenge is on screen by definition, and what
        # matters is showing where it is.
        try:
            page.screenshot(path=shot)
        except Exception:
            shot = ""
        record_application_status(
            job_url=job_url,
            status="NEEDS_CHECKPOINT",
            checkpoint_reason=reason,
            screenshot_path=shot,
        )
        return {
            "status": "NEEDS_CHECKPOINT",
            "reason": reason,
            "screenshot": shot,
            "url": job_url,
        }

    def _wait_for_form(self, page: Page, timeout_ms: int = FORM_WAIT_MS) -> bool:
        """Wait until the application form has actually rendered.

        Apply buttons increasingly navigate to a single-page app that arrives as
        an empty body and fills itself in from JavaScript. A fixed pause after
        the click meant the engine counted the inputs on a blank document,
        concluded there was no form, and gave up on a page that was a second
        away from being perfectly fillable -- which is why this worked only when
        the network happened to be quick.
        """
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            try:
                if page.locator("input:visible, textarea:visible, input[type='file']").count():
                    # Let the rest of the form paint before reading it.
                    page.wait_for_timeout(700)
                    return True
            except Exception:
                pass
            page.wait_for_timeout(400)
        return False

    def _form_is_unavailable(self, page: Page) -> bool:
        """Whether the board is telling us its own form is broken right now."""
        for frame in page.frames:
            try:
                text = frame.locator("body").first.inner_text()
            except Exception:
                continue
            # Bounded, so the phrase has to be the page rather than a line in a
            # long job description that happens to mention technical problems.
            if text and len(text) < 3000 and FORM_UNAVAILABLE_PATTERN.search(text):
                return True
        return False

    def _retry_unavailable_form(self, page: Page) -> bool:
        """Take the page's own "Reload" offer once before giving up.

        These outages are usually momentary, and the alternative is telling the
        candidate their application failed over something that fixed itself a
        second later.
        """
        if not self._form_is_unavailable(page):
            return False

        print("[BrowserEngine] Form reported unavailable; reloading once.", flush=True)
        try:
            button = page.locator("button, a").filter(has_text=RELOAD_BUTTON_PATTERN).first
            if button.count() and button.is_visible():
                button.click(timeout=2500)
            else:
                page.reload(wait_until="domcontentloaded", timeout=25000)
        except Exception:
            try:
                page.reload(wait_until="domcontentloaded", timeout=25000)
            except Exception:
                return False

        page.wait_for_timeout(2500)
        self._wait_for_form(page)
        return not self._form_is_unavailable(page)

    def _dismiss_cookie_banner(self, page: Page) -> bool:
        """Clear the consent banner that sits on top of everything else.

        Until this is gone the apply button is behind an overlay and every click
        lands on the banner, which is why a Dutch SmartRecruiters posting filled
        nothing at all. Rejecting non-essential cookies is preferred over
        accepting them: the candidate is here to apply, not to be tracked.
        """
        for selector in COOKIE_DISMISS_SELECTORS:
            try:
                button = page.locator(selector).first
                if button.count() and button.is_visible():
                    button.click(timeout=1500)
                    page.wait_for_timeout(600)
                    return True
            except Exception:
                continue

        try:
            button = page.locator("button").filter(has_text=COOKIE_BUTTON_PATTERN).first
            if button.count() and button.is_visible():
                button.click(timeout=1500)
                page.wait_for_timeout(600)
                return True
        except Exception:
            pass
        return False

    def _handle_initial_apply_clicks(self, page: Page, job_title: str = "") -> bool:
        """Open the form when it sits behind an Apply button, modal or expander.

        Known phrasings first, because that costs nothing. Only when the page
        speaks a language nobody wrote down does this fall through to the
        brain, which reads the buttons the way a person would.
        """
        apply_buttons = page.locator("button, a").filter(has_text=APPLY_BUTTON_PATTERN)
        for i in range(min(apply_buttons.count(), 4)):
            btn = apply_buttons.nth(i)
            try:
                if not btn.is_visible():
                    continue
                text = (btn.inner_text() or "").strip()
                if NOT_APPLY_PATTERN.search(text):
                    continue
                btn.click(timeout=2500)
                page.wait_for_timeout(1500)
                print(f"[BrowserEngine] Apply control (pattern): {text[:60]!r}", flush=True)
                return True
            except Exception:
                continue

        return self._click_apply_via_brain(page, job_title)

    def _click_apply_via_brain(self, page: Page, job_title: str) -> bool:
        """Ask the model which control opens the form, then click that one.

        This is the difference between "no application form could be reached on
        that page" and an application. The page is real and the button is right
        there; the only thing missing was a phrase in the pattern list.
        """
        if not self.brain.available():
            return False

        controls = self._collect_clickables(page)
        if not controls:
            return False

        index = self.brain.choose_apply_control(controls, job_title=job_title)
        if index < 0:
            print("[BrowserEngine] Brain found no apply control on this page", flush=True)
            return False

        chosen = next((c for c in controls if c["index"] == index), None)
        if not chosen:
            return False

        try:
            element = page.locator(chosen["selector"]).nth(chosen["nth"])
            element.scroll_into_view_if_needed(timeout=2000)
            element.click(timeout=3000)
            page.wait_for_timeout(1800)
            print(f"[BrowserEngine] Apply control (brain): {chosen['text'][:60]!r}", flush=True)
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"[BrowserEngine] Brain's apply control would not click: {exc}", flush=True)
            return False

    def _collect_clickables(self, page: Page) -> list:
        """Visible buttons and links, with enough to click them again later.

        Capped and de-duplicated: a job page carries a navigation bar and a
        related-jobs list, and sending a hundred controls costs latency without
        making the choice any easier.
        """
        controls = []
        seen = set()
        for selector in ("button:visible", "a:visible", "input[type='submit']:visible"):
            try:
                elements = page.locator(selector)
                total = min(elements.count(), 60)
            except Exception:
                continue
            for i in range(total):
                try:
                    element = elements.nth(i)
                    text = (element.inner_text() or element.get_attribute("value") or "").strip()
                    text = " ".join(text.split())
                    if not text or len(text) > 90:
                        continue
                    if NOT_APPLY_PATTERN.search(text) or COOKIE_BUTTON_PATTERN.search(text):
                        continue
                    key = text.lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    controls.append({
                        "index": len(controls),
                        "tag": selector.split(":")[0],
                        "text": text,
                        "selector": selector,
                        "nth": i,
                    })
                except Exception:
                    continue
                if len(controls) >= 40:
                    break
        return controls

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

                # File inputs are handled separately, by name, before this loop.
                # Filling them here attached the CV to whichever upload slot
                # happened to be reachable first -- on Greenhouse that was the
                # cover letter, leaving Resume/CV empty.
                if inp_type == "file":
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
                    # No hardcoded "Amiens" default: a blank profile field is
                    # not evidence that the candidate lives there.
                    city = personal.get("city", "")
                    if city:
                        inp.fill(city)
                        self._commit_autocomplete(page, inp, city)
                        filled += 1
                elif field_key == "postal_code":
                    postal = personal.get("postal_code", "")
                    if postal:
                        inp.fill(postal)
                        filled += 1
                elif field_key == "address":
                    street = personal.get("address_street", "")
                    if street:
                        inp.fill(street)
                        self._commit_autocomplete(page, inp, street)
                        filled += 1
                elif field_key == "linkedin":
                    inp.fill(personal.get("linkedin", ""))
                    filled += 1
                elif field_key == "salary":
                    # Only if the candidate has actually stated a figure. This
                    # used to type a hardcoded "45000" into every salary
                    # expectation box, which is a negotiating position invented
                    # by a script and sent to an employer under their name.
                    expected = str(personal.get("salary_expectation", "") or "")
                    if expected:
                        inp.fill(expected)
                        filled += 1

            except Exception:
                continue

        return filled

    def _commit_autocomplete(self, page: Page, element, typed: str) -> None:
        """Pick the matching suggestion when a field turns out to be a lookup.

        City and address boxes on modern forms are comboboxes: the text you type
        is a query, and unless a suggestion is chosen the field submits empty.
        The Continental screenshot showed "Amiens" typed with the dropdown still
        hanging open over the rest of the form -- looking filled, holding
        nothing.

        Only a suggestion that matches what was typed is accepted. Clicking
        whatever happens to be first would let the page choose the candidate's
        city for them.
        """
        try:
            if not (element.get_attribute("aria-autocomplete")
                    or element.get_attribute("aria-controls")
                    or (element.get_attribute("role") or "") == "combobox"
                    or element.get_attribute("aria-expanded") is not None):
                return
        except Exception:
            return

        page.wait_for_timeout(900)
        wanted = typed.strip().lower()
        try:
            options = page.locator("[role='option']:visible, [role='listbox'] li:visible")
            for i in range(min(options.count(), 8)):
                option = options.nth(i)
                text = (option.inner_text() or "").strip()
                if text and wanted and text.lower().startswith(wanted[:6]):
                    option.click(timeout=1500)
                    page.wait_for_timeout(500)
                    return
        except Exception:
            pass

        # Nothing matched. Close the overlay rather than leave it covering the
        # form, so the screenshot shows the fields and a submit click cannot
        # land on a suggestion.
        try:
            page.keyboard.press("Escape")
        except Exception:
            pass

    def _fill_unknown_fields(self, page: Page, candidate_vault: Dict[str, Any]) -> int:
        """Fill what is left over, using the profile and the model to read labels.

        The keyword matcher above knows about a dozen field names in English.
        Real forms ask for "Pays", "Huidige functietitel", "Wie sind Sie auf uns
        aufmerksam geworden" and put half of them in dropdowns, which the engine
        could not touch at all -- so a form could come back "6 fields filled, 12
        still required" when the profile held most of the twelve.

        Only fields the profile actually answers get filled. Sensitive ones are
        never sent to the model in the first place, and are skipped here too, so
        a run cannot end up declaring the candidate's immigration status or pay
        expectations on their behalf.
        """
        if not self.brain.available():
            return 0

        targets = self._collect_unanswered_fields(page)
        if not targets:
            return 0

        profile = {
            **{k: v for k, v in (candidate_vault.get("personal") or {}).items() if v not in ("", None)},
            **{k: v for k, v in (candidate_vault.get("legal") or {}).items() if v not in ("", None)},
        }
        answers = self.brain.answer_fields([meta for _, meta in targets], profile)
        if not answers:
            return 0

        filled = 0
        for element, meta in targets:
            value = answers.get(meta["key"])
            if not value:
                continue
            try:
                if meta["type"] == "select":
                    element.select_option(label=value, timeout=2000)
                else:
                    element.fill(value, timeout=2000)
                    self._commit_autocomplete(page, element, value)
                filled += 1
                print(f"[BrowserEngine] Brain filled {meta['label'][:40]!r} = {value[:40]!r}", flush=True)
            except Exception:
                continue
        return filled

    def _collect_unanswered_fields(self, page: Page) -> list:
        """Visible, still-empty fields, paired with what the model needs to read them."""
        targets = []
        for selector in ("input:visible", "textarea:visible", "select:visible"):
            try:
                elements = page.locator(selector)
                total = min(elements.count(), 60)
            except Exception:
                continue
            for i in range(total):
                element = elements.nth(i)
                try:
                    kind = (element.get_attribute("type") or "text").lower()
                    if selector.startswith("select"):
                        kind = "select"
                    elif kind in ("file", "checkbox", "radio", "hidden", "submit",
                                  "button", "image", "reset", "search"):
                        continue

                    if (element.input_value() or "").strip():
                        continue

                    label = self._readable_label(page, element)
                    if not label or SENSITIVE_PATTERN.search(label):
                        continue

                    meta = {
                        "key": f"f{len(targets)}",
                        "label": label,
                        "type": kind,
                        "required": bool(
                            element.get_attribute("required") is not None
                            or element.get_attribute("aria-required") == "true"
                        ),
                    }
                    if kind == "select":
                        options = [
                            text.strip()
                            for text in element.locator("option").all_inner_texts()
                            if text.strip()
                        ]
                        # A placeholder-only dropdown has nothing to choose, and
                        # a country list of 250 is mostly latency.
                        if len(options) < 2 or len(options) > 120:
                            continue
                        meta["options"] = options

                    targets.append((element, meta))
                except Exception:
                    continue
                if len(targets) >= 25:
                    return targets
        return targets

    def _accept_legal_checkboxes(self, page: Page) -> int:
        """Tick only the consent boxes, and leave every other one alone.

        This used to check every visible checkbox on the page. On a real
        application form that also ticks "I require visa sponsorship", marketing
        opt-ins, and any screening question that happens to be a checkbox --
        answering questions about the candidate at random, in their name, with
        no record of it. A box is only ticked here if its own label says it is a
        consent to terms or data processing.
        """
        ticked = 0
        checkboxes = page.locator("input[type='checkbox']:visible")
        for i in range(checkboxes.count()):
            cb = checkboxes.nth(i)
            try:
                if cb.is_checked():
                    continue
                if not CONSENT_PATTERN.search(self._checkbox_label(page, cb)):
                    continue
                cb.check(timeout=1000)
                ticked += 1
            except Exception:
                pass
        return ticked

    def _checkbox_label(self, page: Page, checkbox) -> str:
        """Every bit of text that describes one checkbox, lowercased."""
        parts = []
        for attr in ("name", "id", "aria-label", "value"):
            try:
                parts.append(checkbox.get_attribute(attr) or "")
            except Exception:
                pass
        try:
            box_id = checkbox.get_attribute("id")
            if box_id:
                label = page.locator(f"label[for='{box_id}']").first
                if label.count():
                    parts.append(label.inner_text())
        except Exception:
            pass
        try:
            # Fall back to the enclosing label, which is how most forms without
            # an id attribute associate their text.
            parent = checkbox.locator("xpath=ancestor::label[1]")
            if parent.count():
                parts.append(parent.first.inner_text())
        except Exception:
            pass
        return " ".join(parts).lower()

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
