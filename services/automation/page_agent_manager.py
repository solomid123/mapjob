import os
import sys
import time
import base64
import json
import re
from typing import Callable, Optional

from .config import (
    FUELIX_API_KEY,
    FUELIX_BASE_URL,
    FUELIX_PAGE_AGENT as PAGE_AGENT_MODEL,
    PORTAL_EMAIL,
    PORTAL_PASSWORD_PRIMARY,
    PORTAL_PASSWORD_SECONDARY,
    PORTAL_SIGNUP_PASSWORD,
    portal_password_is_google_password,
)

# Set once the shared-password warning has been given, so it is said clearly
# the first time it matters rather than on every job.
_WARNED_SHARED_PASSWORD = False

PAGE_AGENT_JS_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "MapJOB_browser-extension", "page-agent.js"))
CV_PDF_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))

def load_page_agent_script() -> str:
    with open(PAGE_AGENT_JS_PATH, "r", encoding="utf-8") as f:
        return f.read()

# The agent draws its own control panel into the page and shows the brief it was
# given inside it. Everything it adds is tagged, so it can be told apart from the
# employer's page. It has to be: the brief quotes phrases like "Connectez-vous
# pour postuler" as examples of sign-in walls, and a check that reads the whole
# document reads those back as if the employer had said them, which is how a
# straightforward form came to be reported as a login barrier.
AGENT_UI_SELECTOR = (
    '[data-page-agent-ignore],[data-browser-use-ignore],[id^="page-agent-runtime"]'
)

# Hides the agent's own furniture, reads the page, then puts it back. Hiding
# rather than cloning keeps innerText's "only what is visible" meaning, which is
# the whole point of reading innerText instead of textContent.
PAGE_TEXT_JS = """
        function __bojPageText(limit) {
            const ours = Array.from(document.querySelectorAll(%r));
            const restore = ours.map((el) => [el, el.style.display]);
            for (const el of ours) el.style.display = "none";
            let out = "";
            try {
                out = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, limit || 10000);
            } finally {
                for (const [el, display] of restore) el.style.display = display;
            }
            return out;
        }
        function __bojIsOurs(el) {
            try { return !!(el && el.closest && el.closest(%r)); } catch (e) { return false; }
        }
""" % (AGENT_UI_SELECTOR, AGENT_UI_SELECTOR)


def load_cv_data_url() -> str:
    if os.path.exists(CV_PDF_PATH):
        with open(CV_PDF_PATH, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")
            return f"data:application/pdf;base64,{encoded}"
    return ""

def access_brief(company: str) -> str:
    """
    The part of the mission that deals with accounts, written for the agent to
    reason about rather than for a state machine to execute.

    This used to be withheld. The brief said "if the page needs a sign-in, stop"
    and a separate Python ladder took over, which meant the one component that
    could actually read the page was forbidden from acting on what it saw --
    it halted at walls it was perfectly capable of walking through. The ladder
    is still there, but as a fallback for when the agent reports it could not
    get in, not as the first responder.

    The two constraints kept are the two that code cannot recover from:
    passwords must only ever go into password fields, and the Google account
    password must never be typed at all. See the rules below for why.
    """
    if not PORTAL_PASSWORD_PRIMARY:
        return (
            "ACCOUNT ACCESS:\n"
            "No account credentials are configured. If this site turns out to require an account, "
            'call done(success=false, "sign-in required") and stop.'
        )

    signup = (
        f"   c. Still stuck? Create an account: {PORTAL_EMAIL} with the password "
        f"{PORTAL_SIGNUP_PASSWORD}. Registering often ends on a \"your account is ready, please "
        f"sign in\" page rather than signing you in -- if so, log in with that same password.\n"
        if PORTAL_SIGNUP_PASSWORD else ""
    )
    second = (
        f"      If it is rejected, try ONCE more with {PORTAL_PASSWORD_SECONDARY}. Never a third "
        f"time: many portals lock an account after three failures.\n"
        if PORTAL_PASSWORD_SECONDARY else ""
    )

    return f"""ACCOUNT ACCESS -- decide this yourself, do not stop and ask:

1. First look at whether you need an account at all. Most portals let you apply straight from the
   form. If there is a form you can fill without signing in, fill it. Every sign-in avoided is a
   password not handed to a site that never needed it.

2. Only if the site actually blocks you -- a login wall, a required account, a form that will not
   submit without one -- work down this list, in this order:
   a. "Continue with Google" / "Se connecter avec Google", if the page offers it. This browser is
      ALREADY signed into Google as {PORTAL_EMAIL}, so it usually completes with no typing at all.
      Prefer it: it is the only option that puts no password on {company}'s servers.
      Clicking it takes you to accounts.google.com. That is the flow working, not a wrong turn --
      keep going there: click the {PORTAL_EMAIL} tile in the account chooser, accept any
      "share your profile" consent screen, and Google will send you back to {company} signed in.
      Screens with no form on them are steps to click through, not reasons to stop.
   b. If Google is not offered or does not complete, sign in with {PORTAL_EMAIL} and the password
      {PORTAL_PASSWORD_PRIMARY}.
{second}{signup}
3. WHERE PASSWORDS MAY GO: only ever into a field the page presents as a password input, on a
   sign-in or registration form. Never into a name, message, cover-letter, search or "anything else
   we should know" box. A password typed into a free-text field gets emailed to a stranger.

4. ON A GOOGLE PAGE: click freely, type no password. Account tiles, "Continue", "Allow", "Stay
   signed in" -- click all of those, that is how the session gets used. But the password box is
   off limits: the browser's saved session is what signs you in, so if Google asks for a password,
   a phone number or a 2-step code, the session has lapsed and nothing you type will fix it. Leave
   Google and use option (b) instead. That account is the candidate's mailbox and a failed
   automated login can get it locked.

5. If the site emails a verification code, you cannot read email. Call
   done(success=false, "needs email code") and it will be fetched and handed to you.
"""


def build_agent_prompt(job_title: str, company: str, candidate: dict, submit: bool = False) -> str:
    """The agent's brief. `submit=False` is a rehearsal and is the default.

    A rehearsal fills the form and stops in front of the Submit button, so the
    candidate reads what is about to be sent in their name before it is sent.
    An application cannot be recalled, and the model does occasionally get a
    field wrong, so the approval is the whole safeguard -- it must be a separate,
    deliberate second click, never something a first click can trigger.
    """
    first_name = candidate.get("first_name", "Badreddine")
    last_name = candidate.get("last_name", "Barki")
    email = candidate.get("email", "badreddinebarki@gmail.com")
    phone = candidate.get("phone", "+33745768010")
    address = candidate.get("full_address", "14 Rue de la 2e D.B., 80000 Amiens, France")
    city = candidate.get("city", "Amiens")
    postal = candidate.get("postal_code", "80000")
    linkedin = candidate.get("linkedin", "https://www.linkedin.com/in/barki-badreddine-bb2328146")

    if submit:
        ending = (
            "7. SEND IT. Once every required field is filled, click the final button that files the "
            'application ("Submit", "Postuler", "Envoyer ma candidature", "Send application").\n'
            '8. When the page confirms it was received, call done(success=true, "submitted application").'
        )
    else:
        ending = (
            "7. DO NOT FILE THE APPLICATION. This is a rehearsal: the candidate reads the finished form "
            "and sends it themselves.\n"
            "   Note the difference carefully, because the same word is used for both. A button that "
            'OPENS or ADVANCES the application ("Postulez à cette offre", "Apply for this job", '
            '"Next", "Continue", "Suivant", "Sign in") is exactly what you should click. The one you '
            "must not click is the FINAL button on the completed form, the one that files it. If you "
            "cannot tell which kind a button is, treat it as final and stop.\n"
            "8. When every required field is filled and the only thing left is to send it, stop and "
            'call done(success=true, "form filled, ready for review").'
        )

    # The ask_user tool blocks on a human typing into the agent's own panel.
    # Nobody is watching that panel during a run, so a single call to it stalls
    # the whole application until the timeout and produces nothing.
    no_questions = (
        "9. NEVER call ask_user. There is nobody reading the chat panel, so asking means waiting "
        "forever. You have everything you need above: decide, and act. If one field genuinely cannot "
        "be answered from the profile, leave that one empty, keep going, and name it in your done() "
        "message."
    )

    prompt = f"""Get this application for "{job_title}" at "{company}" all the way to the end. You are on the
page now. Whatever stands between here and a completed form -- an Apply button, a cookie banner, a
multi-step wizard, a sign-in wall, a registration form -- is part of your job, not a reason to stop.

{access_brief(company)}

CANDIDATE PROFILE:
- First Name / Prénom / Voornaam: {first_name}
- Last Name / Nom / Achternaam: {last_name}
- Email / E-mailadres: {email}
- Phone / Telefoonnummer: 0033745768010 (IMPORTANT: Always use pure digits: 0033745768010 or 0745768010. Never include "+" or spaces in phone fields, as European/Dutch forms like BAM/Phenom reject "+" and spaces).
- Address / Location / Woonplaats / Ville: {address}
- City / Woonplaats: {city}
- Postal Code / Postcode: {postal}
- Country / Land: France / Frankrijk
- Gender / Geslacht: Man / Male / Geef ik liever niet aan
- LinkedIn URL: {linkedin}

CANDIDATE WORK EXPERIENCE HISTORY:
1. Title: Research and Development Mechanical Engineer | Company: SLB GROUP | Location: Abbeville, France | Dates: 03/2022 - 07/2025
2. Title: R&D Mechanical Engineer Intern | Company: Sigma | Location: Clermont-Ferrand, France | Dates: 03/2021 - 09/2021
3. Title: Mechanical Engineering Intern | Company: OCP Group | Location: Morocco | Dates: 06/2017 - 08/2017

RESUME FILE:
- Badreddine_Barki_CV.pdf is already attached programmatically into the resume/CV slot on this page.
- Do NOT click "Browse" or "Upload" file buttons.

NON-NEGOTIABLE RULES:
1. NAVIGATE FREELY WITHIN THIS APPLICATION. Click whatever is needed to move forward: the
   Apply button, cookie consent, "Next"/"Suivant", a sign-in or registration link. Getting
   from a job advert to a submitted form is the task, and it routinely crosses more than one
   site -- a job board handing off to the employer, the employer handing off to Google or
   LinkedIn to sign you in and back again. A different domain in the address bar is not a
   wrong turn if you got there by clicking your way forward. What you must NOT do is wander:
   no other job listings, no search results, no homepage, no unrelated links.
2. Fill EVERY visible REQUIRED field (marked with * or "Required"). Answer questions truthfully based on the candidate profile.
3. For dropdowns/selects or radio choices: pick the most appropriate option.
4. WORK AUTHORIZATION: Candidate holds a valid work permit for FRANCE and Moroccan citizenship.
   - "Authorized to work in France / French work permit?": YES.
   - Sponsorship required outside France/Morocco: YES.
5. Salary expectation: 40000 EUR (or "40000" / "40K").
6. Notice period: Available immediately / 1 month.
{ending}
{no_questions}
"""
    return prompt

def build_login_prompt(email: str, password: str, company: str) -> str:
    """
    The brief for one sign-in attempt with one password.

    One password per attempt, never a list. Given three at once the agent will
    work through them on a single form, and a portal that locks an account
    after three bad tries locks it in about ten seconds.
    """
    return f"""Sign in to the {company} careers portal that is on this page. Do not fill in any job
application yet -- signing in is the whole task.

CREDENTIALS (use exactly these, do not invent variations):
- Email: {email}
- Password: {password}

RULES:
1. Find the sign-in form. If only a "Sign in" / "Se connecter" / "Inloggen" link or button is
   visible, click it first to open the form.
2. Type the email into the email field and the password into the password field, then submit that
   form once.
3. Use this password ONCE. If it is rejected, do NOT retype it, do NOT try a variation, and do NOT
   look for another password. Call done(success=false, "password rejected") immediately.
4. Never type the password into anything that is not the password field of a sign-in form. If the
   page has no password field, call done(success=false, "no sign-in form").
5. Do NOT create an account, and do NOT click "Forgot password" or any password reset link.
6. Never call ask_user -- nobody is reading the chat panel.
7. When you can see you are signed in (an account menu, a name, a "my applications" area, or the
   application form itself), call done(success=true, "signed in").
"""


def build_google_prompt(company: str) -> str:
    """
    The brief for "Continue with Google", which relies on an existing session
    rather than a password.

    No Google password is given here on purpose. Driving a real Google login
    from an automated browser trips their abuse detection, and the account this
    would risk is the one holding the mailbox everything else resets through.
    """
    return f"""Sign in to the {company} careers portal using the existing Google session in this browser.

RULES:
1. Find and click the "Continue with Google" / "Sign in with Google" / "Se connecter avec Google"
   button.
2. Google may show an account chooser. Pick the badreddinebarki@gmail.com account.
3. If Google shows a consent screen asking to share the profile with this employer, accept it.
4. If Google asks for a PASSWORD, a phone number, a 2-step verification code, or says the browser
   is not secure, STOP. Call done(success=false, "google session expired"). Do not type anything
   into a Google password field.
5. Never call ask_user.
6. When you are back on the employer's site and signed in, call done(success=true, "signed in with
   google").
"""


def build_oauth_continue_prompt() -> str:
    """
    The brief for a page that belongs to the identity provider, not the employer.

    Needed because the agent lives inside the page: clicking "Continue with
    Google" navigates away, which kills it, and the manager remounts it on
    whatever loaded next. What loaded next is Google's account chooser, and the
    brief it was being handed there was the application brief -- fill in the
    form, attach the CV. There is no form on an account chooser, so the agent
    looked around, found nothing to fill, and reported "this is not the
    application page". It was right about the page and wrong about the job, one
    click from being signed in.

    So the sign-in screens get a brief of their own: you are passing through,
    here is the account, here is the way back.
    """
    return f"""You are part-way through signing in to an employer's job site, and this page belongs to
the sign-in provider (Google or similar), not to the employer. There is no application form here
and there is not meant to be. Your only job on this page is to get through it and back to the
employer's site.

THIS IS NOT A DEAD END. Do not call done(success=false) because there is no form here -- the form
is on the other side of this page.

WHAT TO DO:
1. If you see a list of accounts to choose from, click the one for {PORTAL_EMAIL}.
2. If you see "Use another account" or "Add account", ignore it -- pick the existing
   {PORTAL_EMAIL} account instead.
3. If you see a consent screen asking to share the name, email or profile with the employer's site,
   accept it ("Continue", "Allow", "Autoriser", "Continuer").
4. If a "Stay signed in?" or "Keep me signed in" question appears, answer yes.
5. Keep going through as many of these screens as it takes. Each one is progress.

WHERE TO STOP:
6. When the browser is back on the employer's site, call done(success=true, "signed in") -- the
   application brief will be handed back to you there.
7. If this page asks for a PASSWORD, a phone number, a 2-step verification code, or says the
   browser is not secure, the saved session has lapsed and you cannot fix it here. Type nothing.
   Call done(success=false, "google session expired"). This account is the candidate's mailbox and
   a failed automated login can get it locked.
8. Never call ask_user -- nobody is reading the chat panel.
"""


def build_signup_prompt(email: str, password: str, company: str) -> str:
    """The brief for creating a fresh candidate account on the employer's portal."""
    return f"""Create a new candidate account on the {company} careers portal on this page. Do not fill
in the job application yet -- creating the account is the whole task.

ACCOUNT DETAILS:
- Email: {email}
- Password: {password}
- Confirm password: the same password again
- First name: Badreddine
- Last name: Barki

RULES:
1. Find the "Create account" / "Register" / "S'inscrire" / "Registreren" form, clicking a link to
   open it if needed.
2. Fill every required field. Tick the terms/privacy consent box if there is one, since the account
   cannot be created without it.
3. Do NOT tick marketing, newsletter or "share my profile with partners" boxes. Those are optional
   and are not needed to apply.
4. Use exactly the password above. Never invent a different one.
5. Submit the registration form once.
6. Never call ask_user.
7. If the site then asks for a code or a link sent by email, call done(success=true, "verification
   needed") and stop -- the code will be fetched separately.
8. Otherwise, when the account exists and you are signed in, call done(success=true, "account
   created").
"""


def build_verification_prompt(code: str) -> str:
    """The brief for entering a one-time code that was read out of the mailbox."""
    return f"""A verification code was emailed to the candidate and read from their mailbox.

The code is: {code}

RULES:
1. Find the field asking for the verification / confirmation / security code on this page.
2. Type {code} into it and submit the form once.
3. If the code is rejected, call done(success=false, "code rejected"). Do not guess another code.
4. Never call ask_user.
5. When the account is verified, call done(success=true, "verified").
"""


def build_submit_prompt(job_title: str, company: str) -> str:
    """
    The brief for sending a form the candidate has already read and approved.

    Deliberately not the filling brief with a submit rule bolted on: run that
    again and the model rewrites the cover letter and re-answers the dropdowns,
    so what gets sent is not what was approved. The approval only means anything
    if the words on the screen are the words that go.
    """
    return f"""The application form for "{job_title}" at "{company}" on this page is ALREADY FILLED IN.
The candidate has read it and approved it exactly as it stands.

YOUR ONLY JOB IS TO SEND IT.

1. DO NOT retype, rewrite, clear, translate or "improve" any field. Every answer on this page was
   approved as written. Changing one means sending something the candidate never agreed to.
2. The one edit you may make: tick a required consent or terms checkbox if it is not already ticked.
3. Find the button that files the application - "Submit", "Submit application", "Send application",
   "Postuler", "Envoyer ma candidature", "Soumettre" - and click it.
4. If a confirmation dialog asks you to confirm sending, confirm it.
5. When the page shows the application was received, call done(success=true, "submitted").
6. If you cannot find a button that sends it, call done(success=false, "no submit button found").
   Do not go looking for another form and do not start filling anything in.
"""


class PageAgentManager:
    def __init__(self, driver, log_callback: Optional[Callable[[str, int, str, bool, bool], None]] = None):
        self.driver = driver
        self.log_callback = log_callback or (lambda msg, step=0, status="running", done=False, success=False: None)
        self.page_agent_script = load_page_agent_script()
        self.cv_data_url = load_cv_data_url()
        self.latest_screenshot = None
        # Bumped on every captured frame, so a viewer can tell a new picture
        # from the one it is already showing without shipping the picture.
        self.screenshot_seq = 0
        # Whether a CV actually made it onto the form. Reported to the candidate,
        # because an application with no CV on it is usually a wasted one.
        self.cv_attached = False
        # The brief currently in flight. Kept on the manager because the agent
        # itself is a script inside the page: when the page changes, the agent
        # dies with it and only this side of the wire still remembers the task.
        self.active_prompt = ""
        self.active_label = ""
        self.remounts = 0
        # A login wall can appear part-way through a form, not just at the door.
        # Capped, because a site that keeps demanding a sign-in after a
        # successful one is a site the ladder cannot get into.
        self.signin_recoveries = 0
        # Counted apart from remounts: crossing an identity provider is the
        # flow working, not a redirect loop.
        self.oauth_hops = 0
        # The application brief, parked while the agent is off on a sign-in
        # provider's pages, and handed back when it returns.
        self.detour_prompt = None

    def capture_screenshot(self, hide_agent_ui: bool = False) -> Optional[str]:
        """
        Captures the live screen as a base64 PNG data URI.

        `hide_agent_ui` tucks the agent's own panel away for the shot. The panel
        sits over the middle of the form, and the picture the candidate reads
        before approving an application should show the form, not the robot
        standing in front of it. The panel stays put in the real window.
        """
        hidden = False
        if hide_agent_ui:
            try:
                # display, not visibility: a child that sets its own
                # visibility stays on screen through a hidden parent, which is
                # how the agent's task box survived the first attempt at this.
                self.driver.execute_script(
                    "for (const el of document.querySelectorAll(arguments[0])) "
                    "{ el.dataset.bojHidden = el.style.display; el.style.display = 'none'; }",
                    AGENT_UI_SELECTOR,
                )
                hidden = True
                time.sleep(0.15)
            except Exception:
                pass
        try:
            b64 = self.driver.get_screenshot_as_base64()
            if b64:
                self.latest_screenshot = f"data:image/png;base64,{b64}"
                self.screenshot_seq += 1
        except Exception:
            pass
        finally:
            if hidden:
                try:
                    self.driver.execute_script(
                        "for (const el of document.querySelectorAll(arguments[0])) "
                        "{ el.style.display = el.dataset.bojHidden || ''; delete el.dataset.bojHidden; }",
                        AGENT_UI_SELECTOR,
                    )
                except Exception:
                    pass
        return self.latest_screenshot

    def enforce_single_tab(self):
        """
        Enforce that all navigations and link clicks stay in the current tab.
        Closes any stray tabs opened by the browser or page scripts.
        """
        try:
            handles = self.driver.window_handles
            if len(handles) > 1:
                main_handle = handles[0]
                target_url = None
                for h in handles[1:]:
                    try:
                        self.driver.switch_to.window(h)
                        u = self.driver.current_url
                        if u and "about:blank" not in u:
                            target_url = u
                        self.driver.close()
                    except Exception:
                        pass
                self.driver.switch_to.window(main_handle)
                if target_url:
                    # Note this is itself a fresh document load, which is one of
                    # the ways the in-page agent gets wiped mid-run.
                    self.driver.get(target_url)
                    self.wait_for_page_ready()

            tab_guard_script = """
            try {
                window.open = function(url) {
                    if (url) { window.location.href = url; }
                    return window;
                };
                function stripTargets() {
                    document.querySelectorAll('a[target], form[target]').forEach(el => {
                        el.removeAttribute('target');
                    });
                }
                stripTargets();
                if (!window.__boj_tab_guard_active) {
                    window.__boj_tab_guard_active = true;
                    new MutationObserver(stripTargets).observe(document.documentElement || document.body, { childList: true, subtree: true });
                }
            } catch (e) {}
            """
            self.driver.execute_script(tab_guard_script)
        except Exception:
            pass

    def wait_for_page_ready(self, timeout: float = 12.0) -> bool:
        """Waits for the document to finish loading. False if it never settles."""
        end = time.time() + timeout
        while time.time() < end:
            try:
                if self.driver.execute_script("return document.readyState;") == "complete":
                    return True
            except Exception:
                pass
            time.sleep(0.4)
        return False

    def dismiss_cookie_overlays(self) -> Optional[str]:
        """Auto-dismisses cookie banners and GDPR popups."""
        try:
            return self.driver.execute_script("""
                let clicked = null;
                // Direct OneTrust handler click
                const otBtn = document.querySelector('#onetrust-accept-btn-handler, #accept-recommended-btn-handler, #onetrust-reject-all-handler');
                if (otBtn) {
                    try {
                        otBtn.click();
                        clicked = 'onetrust-accept';
                    } catch(e) {}
                }

                document.querySelectorAll('button, a, [role="button"]').forEach(el => {
                    const t = (el.innerText || el.textContent || '').trim().toLowerCase();
                    if (
                        t.includes('accepter tous les cookies') ||
                        t.includes('alle cookies toestaan') ||
                        t.includes('accepteer alle cookies') ||
                        t === 'tout accepter' ||
                        t === 'accept all' ||
                        t === 'accept all cookies' ||
                        t === 'accept cookies' ||
                        t === 'akkoord' ||
                        t === 'j\\'accepte' ||
                        t === 'accepter' ||
                        t === 'alles accepteren'
                    ) {
                        try {
                            el.click();
                            clicked = t;
                        } catch(e) {}
                    }
                });

                // Remove residual backdrop overlays if any
                document.querySelectorAll('#onetrust-consent-sdk, .onetrust-pc-dark-filter, #onetrust-banner-sdk').forEach(el => {
                    try { el.style.display = 'none'; } catch(e) {}
                });

                return clicked;
            """)
        except Exception:
            return None

    def advance_to_application_form(self) -> bool:
        """
        If on an employer landing or job description page with fewer than 3 visible form fields,
        finds and clicks the primary 'Postuler' / 'Apply now' button to reveal the application form.
        """
        try:
            visible_count = self.driver.execute_script("""
                return Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')).filter(el => {
                    const s = window.getComputedStyle(el);
                    return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetWidth > 0 && el.offsetHeight > 0;
                }).length;
            """)
            if visible_count < 3:
                clicked = self.driver.execute_script(r"""
                    // Matched on word STEMS, not whole phrases. The previous list
                    // wanted the button to begin with "postuler", so
                    // "Postulez a cette offre des maintenant !" -- a different
                    // conjugation of the same verb -- did not match and the job
                    // was abandoned as having no form. Every language inflects,
                    // and every site writes its own marketing copy around the
                    // verb, so an exact-phrase list can only ever lose.
                    const GO = ['postul', 'candidat', 'apply', 'sollicit', 'bewerb',
                                'aplicar', 'candidatar', 'candidatura', 'ansok', 'soeg'];

                    // Wording that contains the verb but leads somewhere else:
                    // an open application unconnected to this job, an email
                    // alert, or a help page about applying.
                    const NO = ['spontan', 'ouverte', 'open application', 'how to apply',
                                'comment postuler', 'alerte', 'alert', 'newsletter',
                                'partager', 'share', 'sauvegarder', 'save this',
                                'imprimer', 'print', 'signaler', 'report'];

                    const flat = s => (s || '').normalize('NFD')
                        .replace(/\p{M}/gu, '')   // des -> des, a -> a
                        .replace(/\s+/g, ' ').trim().toLowerCase();

                    const buried = el => !!el.closest('nav, header, footer, [role="navigation"], [role="contentinfo"]');

                    let best = null, bestScore = -1;
                    for (const el of document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
                        const t = flat(el.innerText || el.value || el.textContent || el.getAttribute('aria-label'));
                        if (!t || t.length > 80) continue;
                        if (!GO.some(g => t.includes(g))) continue;
                        if (NO.some(n => t.includes(n))) continue;

                        const r = el.getBoundingClientRect();
                        const s = window.getComputedStyle(el);
                        if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') continue;

                        // Prefer the big call-to-action in the page body over a
                        // small link tucked into the chrome around it.
                        let score = Math.min(r.width * r.height, 40000);
                        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 12000;
                        if (buried(el)) score -= 25000;
                        if (t.length < 40) score += 4000;

                        if (score > bestScore) { bestScore = score; best = el; var bestText = t; }
                    }
                    if (!best) return null;
                    try {
                        best.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        best.click();
                        return flat(best.innerText || best.value || best.textContent || best.getAttribute('aria-label'));
                    } catch(e) { return null; }
                """)
                if clicked:
                    self.log_callback(f"Clicked application button: '{clicked}' - loading form...", step=3)
                    time.sleep(2.5)
                    self.enforce_single_tab()
                    # That click usually leaves the job board for the employer's
                    # own site, and filling a page that is still arriving fills
                    # nothing.
                    self.wait_for_page_ready()
                    return True
        except Exception:
            pass
        return False

    def batch_autofill(self, candidate: dict) -> list:
        """
        High-speed, visible DOM autofill.
        Sets candidate details (Name, Email, Phone, Location, City, LinkedIn),
        checks consent boxes, and attaches CV so the user directly sees the form populate.

        PARKED -- deliberately not called during an agent run, and it should not
        be wired back in without replacing the agent rather than joining it.

        Two fillers on one form do not share the work, they fight over it. This
        one matches fields by name/label guesswork and writes values directly;
        the agent reads a numbered snapshot of the page and acts on those
        numbers a beat later. Every value this writes fires input/change events,
        React re-renders, and the numbers the agent is holding stop pointing at
        the fields it chose. It also overwrote answers the agent had already
        reasoned about -- a tailored cover letter replaced by a stock line,
        a considered dropdown reset.

        Kept because it is still the right tool when there is no agent: it is
        instant, free, and needs no model. Left unused while the agent is the
        one filling.
        """
        first_name = candidate.get("first_name", "Badreddine")
        last_name = candidate.get("last_name", "Barki")
        full_name = f"{first_name} {last_name}"
        email = candidate.get("email", "badreddinebarki@gmail.com")
        phone = candidate.get("phone", "+33 7 45 76 80 10")
        address = candidate.get("full_address", "14 Rue de la 2e D.B.")
        city = candidate.get("city", "Amiens")
        postal = candidate.get("postal_code", "80000")
        linkedin = candidate.get("linkedin", "https://www.linkedin.com/in/barki-badreddine-bb2328146")

        fill_script = r"""
        const data = arguments[0];
        const results = [];

        function setVal(el, val) {
            if (!el || !val) return false;
            try {
                el.focus();
                const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
                return true;
            } catch(e) {
                try { el.value = val; return true; } catch(e2) { return false; }
            }
        }

        function sanitizePhone(raw, el) {
            let p = String(raw || '').replace(/[\s\-\(\)\.]/g, '');
            if (p.startsWith('+33')) {
                p = '0033' + p.slice(3);
            } else if (p.startsWith('+')) {
                p = '00' + p.slice(1);
            }
            if (el && el.maxLength && el.maxLength === 10 && p.startsWith('0033')) {
                p = '0' + p.slice(4);
            }
            return p;
        }

        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'));
        for (const inp of inputs) {
            const name = (inp.getAttribute('name') || '').toLowerCase();
            const id = (inp.getAttribute('id') || '').toLowerCase();
            const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
            const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
            const type = (inp.getAttribute('type') || '').toLowerCase();

            if (name === 'q' || name === 'w' || id.includes('search') || placeholder.includes('rechercher')) continue;

            let label = '';
            if (id) {
                try {
                    const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                    if (lbl) label = (lbl.innerText || '').toLowerCase();
                } catch(e) {}
            }
            if (!label && inp.closest('label')) label = (inp.closest('label').innerText || '').toLowerCase();

            const sig = `${name} ${id} ${placeholder} ${aria} ${label} ${type}`;

            if (type === 'email' || sig.includes('email') || sig.includes('courriel') || sig.includes('e-mail')) {
                if (setVal(inp, data.email)) results.push(`Email: ${data.email}`);
            } else if (type === 'tel' || sig.includes('phone') || sig.includes('tel') || sig.includes('portable') || sig.includes('mobile') || sig.includes('telefoon')) {
                const cleanPhone = sanitizePhone(data.phone, inp);
                if (setVal(inp, cleanPhone)) results.push(`Phone: ${cleanPhone}`);
            } else if (sig.includes('prenom') || sig.includes('first_name') || sig.includes('firstname') || sig.includes('voornaam')) {
                if (setVal(inp, data.first_name)) results.push(`First Name: ${data.first_name}`);
            } else if (sig.includes('last_name') || sig.includes('lastname') || sig.includes('family_name') || sig.includes('achternaam') || sig.includes(' nom ')) {
                if (setVal(inp, data.last_name)) results.push(`Last Name: ${data.last_name}`);
            } else if (sig.includes('full_name') || sig.includes('fullname') || sig.includes('nom complet') || sig.includes('name')) {
                if (setVal(inp, data.full_name)) results.push(`Full Name: ${data.full_name}`);
            } else if (sig.includes('postal') || sig.includes('code postal') || sig.includes('zip') || sig.includes('postcode')) {
                if (setVal(inp, data.postal)) results.push(`Postal: ${data.postal}`);
            } else if (sig.includes('city') || sig.includes('ville') || sig.includes('commune') || sig.includes('woonplaats')) {
                if (setVal(inp, data.city)) results.push(`City: ${data.city}`);
            } else if (sig.includes('location') || sig.includes('address') || sig.includes('adresse')) {
                if (setVal(inp, data.address)) results.push(`Address: ${data.address}`);
            } else if (sig.includes('linkedin') || sig.includes('profil linkedin') || sig.includes('url')) {
                if (setVal(inp, data.linkedin)) results.push(`LinkedIn: ${data.linkedin}`);
            } else if (type === 'password' || sig.includes('password') || sig.includes('mot de passe') || sig.includes('wachtwoord') || sig.includes('passcode')) {
                if (setVal(inp, data.password)) results.push(`Password autofilled`);
            }
        }

        // If password was filled, attempt to click the login / sign-in button automatically
        if (results.some(r => r.includes('Password'))) {
            const submitLogin = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).find(b => {
                const t = (b.innerText || b.value || b.getAttribute('aria-label') || '').toLowerCase();
                return t.includes('se connecter') || t.includes('connexion') || t.includes('sign in') || t.includes('inloggen') || t.includes('log in') || t.includes('valider');
            });
            if (submitLogin) {
                try {
                    submitLogin.click();
                    results.push('Submitted portal login form');
                } catch(e) {}
            }
        }

        // Auto-select dropdowns for Gender and Country if present
        document.querySelectorAll('select').forEach(sel => {
            const sName = ((sel.name||'') + ' ' + (sel.id||'') + ' ' + (sel.getAttribute('aria-label')||'')).toLowerCase();
            if (sName.includes('gender') || sName.includes('geslacht') || sName.includes('sexe') || sName.includes('civilit')) {
                for (const opt of Array.from(sel.options)) {
                    const ot = opt.text.toLowerCase();
                    if (ot === 'man' || ot === 'homme' || ot === 'male' || ot.includes('liever niet')) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        results.push(`Gender: ${opt.text}`);
                        break;
                    }
                }
            } else if (sName.includes('country') || sName.includes('land') || sName.includes('pays')) {
                for (const opt of Array.from(sel.options)) {
                    const ot = opt.text.toLowerCase();
                    if (ot === 'frankrijk' || ot === 'france' || ot.includes('france') || ot.includes('frankrijk')) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        results.push(`Country: ${opt.text}`);
                        break;
                    }
                }
            }
        });

        // Check required consent & terms checkboxes
        document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            if (!cb.checked && (cb.required || (cb.name && (cb.name.includes('consent') || cb.name.includes('terms') || cb.name.includes('rgpd'))))) {
                try {
                    cb.click();
                    results.push(`Checked consent agreement`);
                } catch(e) {}
            }
        });

        return results;
        """
        try:
            # No fallback password. A default here is a password committed to
            # the repository, and this filler is parked anyway.
            password = candidate.get("password", "")
            filled = self.driver.execute_script(fill_script, {
                "first_name": first_name,
                "last_name": last_name,
                "full_name": full_name,
                "email": email,
                "password": password,
                "phone": phone,
                "address": address,
                "city": city,
                "postal": postal,
                "linkedin": linkedin
            })
            return filled or []
        except Exception:
            return []

    def inject_cv_file(self) -> bool:
        """
        Attaches Badreddine_Barki_CV.pdf into resume file inputs.
        Uses native Selenium CDP send_keys with unhidden input (which triggers real XHR upload in Phenom, Workday, etc.),
        and falls back to synthetic DataTransfer.
        """
        cv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))
        if not os.path.exists(cv_path):
            return False

        attached = False

        # 1. Native Selenium send_keys on all <input type="file">
        try:
            from selenium.webdriver.common.by import By
            file_inputs = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
            for fi in file_inputs:
                try:
                    # Check if already has file
                    files_len = self.driver.execute_script("return arguments[0].files ? arguments[0].files.length : 0;", fi)
                    if files_len and files_len > 0:
                        attached = True
                        continue

                    # Unhide input so Selenium can interact
                    self.driver.execute_script("""
                        arguments[0].style.display = 'block';
                        arguments[0].style.visibility = 'visible';
                        arguments[0].style.opacity = '1';
                        arguments[0].style.position = 'static';
                        arguments[0].style.width = '120px';
                        arguments[0].style.height = '35px';
                    """, fi)
                    fi.send_keys(cv_path)
                    self.driver.execute_script("""
                        arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
                        arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
                    """, fi)
                    attached = True
                except Exception:
                    pass
        except Exception:
            pass

        # 2. Check iframes if not yet attached
        if not attached:
            try:
                from selenium.webdriver.common.by import By
                iframes = self.driver.find_elements(By.TAG_NAME, "iframe")
                for iframe in iframes:
                    try:
                        self.driver.switch_to.frame(iframe)
                        sub_inputs = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
                        for fi in sub_inputs:
                            self.driver.execute_script("""
                                arguments[0].style.display = 'block';
                                arguments[0].style.visibility = 'visible';
                                arguments[0].style.opacity = '1';
                            """, fi)
                            fi.send_keys(cv_path)
                            self.driver.execute_script("""
                                arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
                                arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
                            """, fi)
                            attached = True
                        self.driver.switch_to.default_content()
                        if attached:
                            break
                    except Exception:
                        self.driver.switch_to.default_content()
            except Exception:
                pass

        # 3. Fallback: synthetic DataTransfer if native send_keys was blocked
        if not attached and self.cv_data_url:
            try:
                injector_script = """
                const dataUrl = arguments[0];
                try {
                    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
                    if (!fileInputs.length) return false;

                    let target = fileInputs.find(el => {
                        const desc = ((el.name||'') + ' ' + (el.id||'') + ' ' + (el.getAttribute('aria-label')||'')).toLowerCase();
                        return /resume|cv|curriculum/i.test(desc);
                    }) || fileInputs[0];

                    if (target.files && target.files.length > 0) return true;

                    const arr = dataUrl.split(',');
                    const mime = arr[0].match(/:(.*?);/)[1];
                    const bstr = atob(arr[1]);
                    let n = bstr.length;
                    const u8arr = new Uint8Array(n);
                    while (n--) u8arr[n] = bstr.charCodeAt(n);
                    const file = new File([u8arr], "Badreddine_Barki_CV.pdf", { type: mime });
                    const dt = new DataTransfer();
                    dt.items.add(file);

                    try {
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
                        if (setter) setter.call(target, dt.files);
                        else target.files = dt.files;
                    } catch(e) {
                        target.files = dt.files;
                    }

                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    return true;
                } catch(e) {
                    return false;
                }
                """
                res = bool(self.driver.execute_script(injector_script, self.cv_data_url))
                if res:
                    attached = True
            except Exception:
                pass

        if attached:
            self.cv_attached = True
        return attached

    def verify_submission(self) -> dict:
        """
        Strict corroboration logic from MapJOB_browser-extension/background.js.
        Zero false-positive guarantee:
        1. Checks post-submit confirmation message or URL.
        2. Detects external portal login barriers (e.g. APEC account required).
        3. Probes if submit button or application form is still open.
        """
        verify_script = PAGE_TEXT_JS + r"""
        const OK =/thank(s| you) for (your )?(application|applying)|your application (has been|was|has) .{0,25}(submitted|received|sent)|application (has been|was) (successfully )?(submitted|received|sent)|submission (successful|confirmed|complete)|successfully (submitted|applied)|we'?ve received your application|application received|you'?ve applied|already applied|vous avez (d[ée]j[àa] )?postul[ée]?( [àa] cette offre)?|candidature.{0,25}envoy[ée]e|demande.{0,25}envoy[ée]e|votre candidature a (bien )?[ée]t[ée] (envoy[ée]e|re[çc]ue|enregistr[ée]e|transmise)|merci (pour|de) votre candidature|sollicitatie ontvangen|bedankt voor je sollicitatie/i;
        const URL_OK = /thank[-_ ]?you(?:[/?#.&_-]|$)|\/thanks?(?:[/?#.&_-]|$)|application[-_/]?(?:submitted|received|complete|sent)(?:[/?#.&_-]|$)|submission[-_/]?(?:successful|confirmed|complete)(?:[/?#.&_-]|$)|apply[-_/]?(?:success|confirmed|confirmation|complete)(?:[/?#.&_-]|$)/i;
        
        // The employer's page only — the agent's own panel is hidden while this
        // reads, so its brief cannot be mistaken for the site's own words.
        let text = "";
        try { text = __bojPageText(10000); } catch(e) {}

        const m = text.match(OK);
        if (m) return { submitted: true, match: m[0] };
        
        try {
            const um = String(location.href || "").match(URL_OK);
            if (um) return { submitted: true, match: 'url:' + um[0] };
        } catch(e) {}
        
        // Barrier detection: candidate login wall
        const lowText = text.toLowerCase();
        const BARRIER_RE = /connectez[- ]vous pour postuler|se connecter pour postuler|connexion requise|créer un compte pour postuler|créez un compte pour postuler|identifiez-vous pour postuler|votre compte apec|veuillez vous connecter/i;
        const bm = lowText.match(BARRIER_RE);
        if (bm) {
            return { submitted: false, barrier: true, match: bm[0] };
        }

        // Check if submit button is still standing
        const SUBMIT_RE = /submit( application)?|send( my)? application|envoyer( ma)? candidature|envoyer$|^envoyer|soumettre|confirmer ma candidature/i;
        const els = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
        for (const el of els) {
            if (__bojIsOurs(el)) continue;
            const label = String(el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
            if (!label || label.length > 80) continue;
            if (!SUBMIT_RE.test(label)) continue;
            if (el.disabled) continue;
            const st = window.getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            return { submitted: false, submitStillVisible: true, match: label };
        }

        return { submitted: false, match: "" };
        """
        try:
            res = self.driver.execute_script(verify_script) or {}
            if res.get("submitted"):
                return {
                    "success": True,
                    "message": f"Verified submission: {res.get('match')}",
                    # The employer's own words that prove the submission landed.
                    "evidence": str(res.get("match") or "").strip(),
                }
            if res.get("barrier"):
                # Quote the page, so a wrong call here can be seen for what it is
                # rather than looking like a verdict out of nowhere.
                said = str(res.get("match") or "").strip()
                detail = f' The page says: "{said}".' if said else ""
                return {"success": False, "barrier": True,
                        "message": f"This portal wants you signed in to a candidate account before it will "
                                   f"take an application.{detail}"}
            if res.get("submitStillVisible"):
                return {"success": False, "message": f"Application form remains open (Submit button '{res.get('match')}' still standing)."}
            return {"success": False, "message": "Application cycle concluded without confirmation evidence."}
        except Exception as e:
            return {"success": False, "message": str(e)}

    def rehearsal_verdict(self) -> dict:
        """
        What a no-submit run leaves behind: a form the candidate can read.

        `verify_submission` only knows how to recognise a *sent* application, so
        on a rehearsal it always reports failure — the submit button is meant to
        still be standing. This looks at the other half of the picture: how much
        of the form now holds an answer, and what the button that would send it
        is called.
        """
        script = PAGE_TEXT_JS + r"""
        const fields = Array.from(document.querySelectorAll('input, textarea, select'));
        let filled = 0;
        for (const el of fields) {
            if (__bojIsOurs(el)) continue;
            const t = String(el.type || '').toLowerCase();
            if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset') continue;
            if (t === 'checkbox' || t === 'radio') { if (el.checked) filled++; continue; }
            if (el.value && String(el.value).trim()) filled++;
        }
        const SUBMIT_RE = /submit( application)?|send( my)? application|envoyer( ma)? candidature|soumettre|confirmer ma candidature|postuler|apply now|verstuur|solliciteer/i;
        let button = "";
        for (const el of document.querySelectorAll('button, input[type="submit"], [role="button"]')) {
            if (__bojIsOurs(el)) continue;
            const label = String(el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            if (!label || label.length > 80 || !SUBMIT_RE.test(label)) continue;
            if (el.disabled) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            button = label;
            break;
        }
        return { filled: filled, button: button };
        """
        try:
            res = self.driver.execute_script(script) or {}
        except Exception as e:
            if self.browser_is_gone():
                return {"success": False, "browser_closed": True,
                        "message": "The browser window was closed, so the form could not be read "
                                   "back. Nothing was sent."}
            return {"success": False, "message": f"Could not read the form back: {e}"}

        filled = int(res.get("filled") or 0)
        button = str(res.get("button") or "").strip()
        note = self.agent_done_note()

        if filled == 0:
            return {
                "success": False,
                "fields_filled": 0,
                "message": ("Nothing on this page could be filled in — it may not be the application "
                            f"form. {note}").strip(),
            }

        # An application with a couple of stray fields is not an application,
        # with or without a CV on it. Offering it for review invites a click on
        # Submit that sends an employer almost nothing, so it is reported as
        # the miss it is. The agent refusing on purpose -- "this form is for a
        # different role" -- lands here too, which is right: there is nothing
        # to approve either way.
        if filled < 3:
            return {
                "success": False,
                "fields_filled": filled,
                "resume_attached": bool(self.cv_attached),
                "reason": "NO_FORM_FOUND",
                "message": (
                    f"Only {filled} field{'' if filled == 1 else 's'} could be filled, so this does "
                    f"not look like a completed application. Nothing was sent. {note}"
                ).strip(),
            }

        tail = f' Press "{button}" there when you are happy with it.' if button else ""
        return {
            "success": True,
            "awaiting_review": True,
            "fields_filled": filled,
            "resume_attached": bool(self.cv_attached),
            "message": (
                f"{filled} field{'' if filled == 1 else 's'} filled and nothing sent. "
                f"The browser window is open on the form.{tail} {note}"
            ).strip(),
        }

    def start_agent_task(self, prompt_text: str, label: str) -> bool:
        """
        Hands the agent a brief and lets it loose on the page.

        Mounts the runtime if this page has not had it yet, and resets the
        step log so a second task on the same page starts from a clean sheet.
        """
        # Mount the agent runtime if this page has not had it yet.
        is_loaded = False
        try:
            is_loaded = self.driver.execute_script("return typeof window.PageAgent !== 'undefined';")
        except Exception:
            pass

        if not is_loaded:
            self.log_callback("Mounting PageAgent core into employer portal...", step=5)
            self.driver.execute_script(self.page_agent_script)
            time.sleep(1)

        # The model config arrives as an argument, not baked into this string.
        # `execute_script` sends the source text over the wire and Chrome keeps it
        # in the page; an argument is passed as a value instead, so the API key
        # never becomes part of a script the site could read back.
        launch_script = """
        const promptText = arguments[0];
        const llm = arguments[1];
        window.__BOJ_STEPS = [];
        window.__BOJ_AGENT_FINISHED = false;
        window.__BOJ_AGENT_RESULT = null;
        window.__BOJ_ASKED = null;

        try {
            if (!window.__boj_agent_instance) {
                window.__boj_agent_instance = new window.PageAgent({
                    model: llm.model,
                    baseURL: llm.baseURL,
                    apiKey: llm.apiKey,
                    language: "en-US",
                    maxSteps: 40
                });

                window.__boj_agent_instance.addEventListener("activity", (e) => {
                    const act = e.detail;
                    if (!act) return;
                    let desc = "";
                    if (act.type === "thinking") {
                        desc = "Thinking...";
                    } else if (act.type === "executing") {
                        const tool = act.tool || "";
                        let argSummary = "";
                        if (act.input) {
                            if (act.input.index !== undefined) argSummary += `[${act.input.index}] `;
                            if (act.input.text) argSummary += `"${act.input.text}" `;
                            if (act.input.question) argSummary += `"${act.input.question}" `;
                        }
                        // ask_user waits forever on a panel nobody is reading.
                        // Recording the question lets the run end and put it to
                        // the candidate instead of silently stalling.
                        if (tool === "ask_user" && act.input && act.input.question) {
                            window.__BOJ_ASKED = String(act.input.question);
                        }
                        desc = `Action: ${tool} ${argSummary}`.trim();
                    } else if (act.type === "executed") {
                        desc = `Result: ${act.tool || ""} (${String(act.output || "").slice(0, 60)})`;
                    } else if (act.type === "error") {
                        desc = `Notice: ${String(act.message || "").slice(0, 80)}`;
                    }
                    if (desc) window.__BOJ_STEPS.push(desc);
                });
            }

            Promise.resolve(window.__boj_agent_instance.execute(promptText))
                .then((res) => {
                    window.__BOJ_AGENT_FINISHED = true;
                    window.__BOJ_AGENT_RESULT = res;
                })
                .catch((err) => {
                    window.__BOJ_AGENT_FINISHED = true;
                    window.__BOJ_AGENT_RESULT = { error: String(err && err.message ? err.message : err) };
                });

            return { started: true };
        } catch(e) {
            window.__BOJ_AGENT_FINISHED = true;
            window.__BOJ_AGENT_RESULT = { error: e.message };
            return { started: false, error: e.message };
        }
        """

        self.log_callback(f"{label} ({PAGE_AGENT_MODEL})...", step=5)
        # Remembered so the same brief can be handed to the agent again on the
        # next page, since the page it was given to will not survive the trip.
        self.active_prompt = prompt_text
        self.active_label = label
        init_res = self.driver.execute_script(
            launch_script,
            prompt_text,
            {"model": PAGE_AGENT_MODEL, "baseURL": FUELIX_BASE_URL, "apiKey": FUELIX_API_KEY},
        )
        if not init_res or not init_res.get("started"):
            err_msg = (init_res or {}).get("error", "PageAgent setup notice")
            self.log_callback(f"Agent note: {err_msg}", step=5)
        return bool(init_res and init_res.get("started"))

    MAX_REMOUNTS = 3

    # Hosts that are a step in a sign-in, not a destination. Landing on one is
    # a sign the flow is working, so these hops get their own budget rather
    # than eating the redirect-loop allowance: a single OAuth round trip is
    # routinely three documents (employer -> chooser -> consent -> back), which
    # on its own exhausted MAX_REMOUNTS.
    # Entries with a slash are host+path, for providers that serve their sign-in
    # screens from the same host as an ordinary site: www.linkedin.com is both
    # the feed and the OAuth screen, and treating the whole host as an identity
    # provider would send the agent through a sign-in brief on a job listing.
    IDENTITY_HOSTS = (
        "accounts.google.com",
        "accounts.youtube.com",
        "login.microsoftonline.com",
        "login.live.com",
        "appleid.apple.com",
        "linkedin.com/oauth",
        "linkedin.com/uas",
        "linkedin.com/checkpoint",
        "facebook.com/login",
        "facebook.com/dialog",
        "github.com/login",
    )
    MAX_OAUTH_HOPS = 6

    def current_url(self) -> str:
        try:
            return self.driver.current_url or ""
        except Exception:
            return ""

    def on_identity_provider(self, url: str) -> bool:
        """Whether this URL is a sign-in provider's page rather than the employer's."""
        low = (url or "").strip().lower()
        if "://" not in low:
            return False
        body = low.split("://", 1)[1]
        if body.startswith("www."):
            body = body[4:]
        host = body.split("/", 1)[0].split("?", 1)[0].split(":", 1)[0]
        for marker in self.IDENTITY_HOSTS:
            if "/" in marker:
                if body.startswith(marker):
                    return True
            elif host == marker:
                return True
        return False

    # One rescue per run. A site still demanding a sign-in after the ladder
    # succeeded is not going to yield to a second lap of the same steps.
    MAX_SIGNIN_RECOVERIES = 1

    def agent_lost_its_page(self) -> Optional[str]:
        """
        The URL of a settled page that no longer has the agent on it, else None.

        A missing agent only means something once the document has finished
        loading: mid-navigation every page looks empty, and treating that as an
        answer would fire on the gap between two states rather than on a change.
        """
        try:
            state = self.driver.execute_script("""
                return {
                    ready: document.readyState,
                    mounted: typeof window.PageAgent !== "undefined" && !!window.__boj_agent_instance,
                    url: location.href
                };
            """)
        except Exception:
            # Mid-navigation the script cannot run at all. That is not a verdict.
            return None
        if not state or state.get("mounted") or state.get("ready") != "complete":
            return None
        return str(state.get("url") or "")

    def resume_after_navigation(self) -> bool:
        """
        Puts the agent back on its feet after the page changed underneath it.

        The agent runs *inside* the page, so a new document wipes it out
        completely — instance, step log, finished flag, all of it. A real
        application almost always crosses at least one document: the job board
        hands off to the employer's own site, which is exactly the moment this
        matters. Before this existed the run went quiet at the handover and sat
        there until the clock ran out, which is indistinguishable from the agent
        never having been called at all.

        Returns True when a fresh page was found and the brief re-issued, so the
        caller can reset its step counter — the new page's log starts at zero.
        """
        url = self.agent_lost_its_page()
        if url is None or not self.active_prompt:
            return False

        # An identity provider is a different kind of new page. Re-issuing the
        # application brief here is what stalled the Google sign-in: the agent
        # was remounted on Google's account chooser holding a brief that told it
        # to fill in an application form, found no form, and correctly concluded
        # this was not the application page -- one click away from being signed
        # in. It gets a brief about the page it is actually looking at.
        if self.on_identity_provider(url):
            if self.oauth_hops >= self.MAX_OAUTH_HOPS:
                # Said once, not on every tick for the rest of the run.
                if self.oauth_hops == self.MAX_OAUTH_HOPS:
                    self.oauth_hops += 1
                    self.log_callback(
                        "The sign-in provider kept sending the browser round in circles, "
                        "so it was left there.", step=5)
                return False
            self.oauth_hops += 1
            # Set aside rather than overwritten: start_agent_task replaces
            # active_prompt, and the application brief is the thing that has to
            # come back when this detour ends.
            if self.detour_prompt is None:
                self.detour_prompt = (self.active_prompt, self.active_label)
                self.log_callback("Sign-in page — choosing the account and coming back.", step=5)
            # No CV injection and no cookie-banner clicking on an identity
            # provider: nothing here is an application form, and the only thing
            # wanted from this page is to get through it.
            self.start_agent_task(build_oauth_continue_prompt(), "Completing sign-in")
            return True

        # Back on the employer's site. The brief set aside at the start of the
        # detour is the one that belongs here, not the sign-in brief that was
        # last in flight.
        if self.detour_prompt is not None:
            self.active_prompt, self.active_label = self.detour_prompt
            self.detour_prompt = None
            self.log_callback("Back on the employer's site — picking the application back up.", step=5)

        if self.remounts >= self.MAX_REMOUNTS:
            # A redirect chain that never settles is a dead end, not something to
            # keep paying for. Say so once and stop re-arming.
            if self.remounts == self.MAX_REMOUNTS:
                self.remounts += 1
                self.log_callback(
                    "The site kept redirecting, so the agent was not restarted again.", step=5
                )
            return False

        self.remounts += 1
        host = url.split("/")[2] if "://" in url else url
        self.log_callback(f"New page loaded ({host}) — putting the agent back on it.", step=5)

        # The new document is a stranger: its own cookie wall, its own file
        # input. The CV goes back on because the attachment did not survive the
        # navigation; the text fields are left alone for the agent.
        self.dismiss_cookie_overlays()
        self.inject_cv_file()

        self.start_agent_task(self.active_prompt, self.active_label)
        return True

    def scrub_leaked_passwords(self) -> int:
        """
        Wipes any password that has ended up somewhere it does not belong.

        The brief tells the agent to type passwords only into password fields.
        That is an instruction, and instructions are followed most of the time,
        which is not the standard this particular mistake deserves: a password
        left in a cover-letter box is a password emailed to a stranger and
        stored in an applicant-tracking system forever. So it is also checked
        every tick, in code.

        The values are compared here rather than in the page, so the passwords
        are never handed to the document's own JavaScript.
        """
        secrets = [p for p in (PORTAL_PASSWORD_PRIMARY, PORTAL_PASSWORD_SECONDARY,
                               PORTAL_SIGNUP_PASSWORD) if p]
        if not secrets:
            return 0
        try:
            fields = self.driver.execute_script("""
                const out = [];
                document.querySelectorAll('input, textarea').forEach((el, i) => {
                    el.setAttribute('data-mapjob-idx', i);
                    if (el.type === 'password' || el.type === 'hidden') return;
                    if (el.value) out.push({idx: i, value: el.value});
                });
                return out;
            """) or []
        except Exception:
            return 0

        wiped = 0
        for field in fields:
            value = str(field.get("value") or "")
            if not any(secret in value for secret in secrets):
                continue
            try:
                self.driver.execute_script("""
                    const el = document.querySelector('[data-mapjob-idx="' + arguments[0] + '"]');
                    if (!el) return;
                    el.value = '';
                    el.dispatchEvent(new Event('input', {bubbles: true}));
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                """, field.get("idx"))
                wiped += 1
            except Exception:
                pass
        if wiped:
            self.log_callback(
                "Cleared a password that had been typed into a field that is not a password box. "
                "It was removed before the form could be sent.", step=6)
        return wiped

    def hit_signin_wall(self) -> bool:
        """
        Whether the agent stopped because the page demanded an account.

        Read from its parting words rather than from the DOM: the agent is the
        one that saw the wall, and by the time this is asked the page may have
        scrolled, re-rendered, or redirected.
        """
        note = (self.agent_done_note() or "").lower()
        if any(phrase in note for phrase in
               ("sign-in required", "sign in required", "signin required",
                "login required", "log-in required", "account required",
                "requires an account", "needs an account", "must be logged in",
                "must log in", "connexion requise")):
            return True
        # Corroborated against the page for the cases where the agent worded it
        # some other way.
        state = self.page_access_state()
        return bool(state.get("wall") and not state.get("signed_in"))

    def agent_done_note(self) -> str:
        """
        What the agent said when it stopped, in its own words.

        It often knows more about the outcome than the page does — "this is a
        generic advice page, not the application form" is a verdict no count of
        filled inputs will produce — so its parting message is worth repeating
        to the candidate rather than discarding.
        """
        try:
            steps = self.driver.execute_script("return window.__BOJ_STEPS || [];") or []
        except Exception:
            return ""
        for line in reversed(steps):
            text = str(line)
            if text.startswith("Action: done"):
                note = text[len("Action: done"):].strip().strip('"').strip()
                # The stock success line adds nothing the verdict does not say.
                if note and note.lower() not in ("form filled, ready for review",
                                                 "submitted application", "task completed"):
                    return f"The agent noted: “{note}”."
                return ""
        return ""

    def pending_question(self) -> Optional[str]:
        """
        The question the agent stopped to ask, if it asked one.

        Its ask_user tool waits on someone typing into the panel it drew on the
        page. During a run nobody is looking at that panel, so the call never
        returns and the application stalls until the timeout with no explanation.
        Reading the question out lets the run end and put it to the candidate.
        """
        try:
            asked = self.driver.execute_script("return window.__BOJ_ASKED || null;")
        except Exception:
            return None
        return str(asked).strip() if asked else None

    def browser_is_gone(self) -> bool:
        """True once the window has been closed and the session is dead."""
        try:
            self.driver.execute_script("return 1;")
            return False
        except Exception as e:
            msg = str(e).lower()
            return ("invalid session id" in msg or "no such window" in msg
                    or "target window already closed" in msg or "browser has closed" in msg
                    or "disconnected" in msg)

    def stream_agent_steps(self, seen: int) -> int:
        """Pushes any new agent activity into the run log. Returns the new count."""
        try:
            steps = self.driver.execute_script("return window.__BOJ_STEPS || [];") or []
        except Exception:
            return seen
        for i in range(seen, len(steps)):
            self.log_callback(f"Agent: {steps[i]}", step=6)
        return len(steps)

    # ---------------------------------------------------------------- access

    def page_access_state(self) -> dict:
        """
        What this page is: an application form, a sign-in wall, or neither.

        Read from the page rather than asked of the model, because it is
        checked repeatedly and a wrong answer here either skips a needed
        sign-in or types a password into a page that never asked for one.
        """
        try:
            return self.driver.execute_script(PAGE_TEXT_JS + """
                const text = __bojPageText(6000).toLowerCase();
                const ok = (el) => {
                    if (__bojIsOurs(el)) return false;
                    const s = window.getComputedStyle(el);
                    return s.display !== "none" && s.visibility !== "hidden"
                        && el.offsetWidth > 0 && el.offsetHeight > 0;
                };
                const fields = Array.from(document.querySelectorAll(
                    'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select'
                )).filter(ok);
                const passwords = fields.filter((e) => e.type === "password");
                const uploads = Array.from(document.querySelectorAll('input[type=file]'))
                    .filter((e) => !__bojIsOurs(e));

                const walls = ["connectez-vous pour postuler", "se connecter pour postuler",
                    "log in to apply", "sign in to apply", "login to apply",
                    "inloggen om te solliciteren", "log in om te solliciteren",
                    "please sign in", "veuillez vous connecter", "create an account to apply",
                    "anmelden um sich zu bewerben"];
                const wall = walls.find((p) => text.includes(p)) || null;

                const inWords = ["log out", "logout", "sign out", "se déconnecter", "déconnexion",
                    "uitloggen", "mijn account", "my account", "mon compte", "my applications",
                    "mes candidatures", "abmelden"];
                const signedIn = inWords.some((p) => text.includes(p));

                const has = (words) => Array.from(document.querySelectorAll('a,button,[role=button]'))
                    .filter(ok)
                    .some((el) => {
                        const t = (el.innerText || el.value || el.textContent || "").trim().toLowerCase();
                        return words.some((w) => t.includes(w));
                    });

                return {
                    fields: fields.length,
                    password_fields: passwords.length,
                    uploads: uploads.length,
                    wall: wall,
                    signed_in: signedIn,
                    has_signin: has(["sign in", "log in", "login", "se connecter", "connexion",
                                     "inloggen", "anmelden"]),
                    has_signup: has(["create an account", "create account", "register", "sign up",
                                     "s'inscrire", "inscription", "registreren", "registrieren"]),
                    has_google: has(["with google", "avec google", "met google", "mit google"]),
                };
            """) or {}
        except Exception:
            return {}

    def can_apply_without_account(self) -> bool:
        """
        True when the application form is right there and nothing is gating it.

        This is the first question asked of any portal, because most of them
        never need an account and every sign-in avoided is a password not sent
        to a site that did not require one.
        """
        state = self.page_access_state()
        if not state:
            return False
        if state.get("wall"):
            return False
        # A form with real inputs and somewhere to put a CV is an application
        # form. A lone search box or newsletter field is not.
        enough_fields = int(state.get("fields") or 0) >= 4
        return bool(enough_fields and not state.get("password_fields"))

    def looks_signed_in(self) -> bool:
        state = self.page_access_state()
        return bool(state.get("signed_in")) or self.can_apply_without_account()

    def run_auth_task(self, prompt_text: str, label: str, max_wait_seconds: int = 70) -> dict:
        """
        Runs one sign-in/registration brief and reports how it ended.

        Unlike a form fill, a navigation here is the expected outcome: pressing
        a sign-in button reloads onto the signed-in page and takes the agent
        with it. So the page changing is treated as the attempt finishing, and
        the verdict comes from reading the page afterwards rather than from the
        agent, which by then no longer exists to be asked.
        """
        if self.browser_is_gone():
            return {"success": False, "message": "browser closed"}

        self.start_agent_task(prompt_text, label)
        # This brief is finished with; nothing should re-issue it on a new page.
        self.active_prompt = ""
        start = time.time()
        seen = 0

        while time.time() - start < max_wait_seconds:
            time.sleep(1.5)
            if self.browser_is_gone():
                return {"success": False, "message": "browser closed"}
            self.capture_screenshot()
            seen = self.stream_agent_steps(seen)

            question = self.pending_question()
            if question:
                return {"success": False, "message": f"agent asked: {question}"}

            if self.agent_lost_its_page() is not None:
                self.wait_for_page_ready()
                time.sleep(1.5)
                return {"success": self.looks_signed_in(), "navigated": True,
                        "message": "page changed after the attempt"}

            try:
                if self.driver.execute_script("return window.__BOJ_AGENT_FINISHED;"):
                    time.sleep(2)
                    self.stream_agent_steps(seen)
                    result = self.driver.execute_script("return window.__BOJ_AGENT_RESULT;") or {}
                    note = self.agent_done_note()
                    return {"success": self.looks_signed_in(),
                            "agent_result": result, "message": note or "attempt finished"}
            except Exception:
                pass

        return {"success": self.looks_signed_in(), "message": "attempt timed out"}

    def fetch_emailed_code(self, timeout_seconds: int = 120) -> Optional[str]:
        """Reads a one-time code out of the candidate's mailbox over IMAP."""
        try:
            from services.automation.email_watcher import EmailWatcher
            watcher = EmailWatcher()
            if not watcher.is_configured():
                self.log_callback("No mailbox access configured, so the emailed code cannot be "
                                  "read automatically.", step=4)
                return None
            self.log_callback("Waiting for the verification email...", step=4)
            code = watcher.wait_for_otp_code(timeout_seconds=timeout_seconds)
            if code:
                self.log_callback("Verification code received from your mailbox.", step=4)
                return code
        except Exception as e:
            self.log_callback(f"Could not read the verification email: {e}", step=4)
        return None

    def save_session_cookies(self, label: str) -> int:
        """
        Files this site's cookies in the vault so the next run arrives signed in.

        Every run gets a throwaway Chrome profile, so without this a sign-in is
        spent the moment the window closes and the whole ladder runs again on
        the next job at the same employer. Saving them is what turns "sign in
        once" into something that is actually true.
        """
        vault_path = os.path.join(os.path.dirname(__file__), "cookies_vault.json")
        try:
            cookies = self.driver.get_cookies() or []
            if not cookies:
                return 0
            vault = {}
            if os.path.exists(vault_path):
                with open(vault_path, "r", encoding="utf-8") as f:
                    vault = json.load(f)
            vault[label] = cookies
            tmp = vault_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(vault, f, indent=1)
            os.replace(tmp, vault_path)
            return len(cookies)
        except Exception as e:
            self.log_callback(f"Could not save the session for next time: {e}", step=4)
            return 0

    def ensure_access(self, company: str, max_wait_seconds: int = 300) -> dict:
        """
        Gets as far as an application form, signing in only if the site insists.

        The rungs, in order: apply with no account, password one, password two,
        Continue with Google, register, then log in with the account just
        registered.

        The order is deliberate. Applying without an account is tried first
        because most portals allow it and it leaves no password anywhere. Only
        then does it sign in, one password per attempt and no more than two, so
        a portal that locks accounts after three failures never gets the
        chance. Google comes before registration because it needs no password
        at all, and a brand new account comes last because it is the only step
        that leaves something permanent behind on the employer's systems --
        followed by a login, because registering often ends on "your account is
        ready, please sign in" rather than on a session.

        Every rung re-reads the page before it runs and gets its own slice of
        the remaining time. Reading once at the top meant a rung was judged
        against a page three attempts out of date, and letting the first rung
        spend the whole budget meant the later ones were never reached.
        """
        deadline = time.time() + max_wait_seconds

        if self.can_apply_without_account():
            self.log_callback("This site lets you apply without an account.", step=3)
            return {"success": True, "method": "no_account"}

        state = self.page_access_state()
        if self.looks_signed_in():
            self.log_callback("Already signed in on this site from a saved session.", step=3)
            return {"success": True, "method": "existing_session"}

        if not (state.get("wall") or state.get("password_fields")
                or state.get("has_signin") or state.get("has_signup")):
            # No form and no sign-in either: this is not the application page,
            # and no password should be typed anywhere on it.
            return {"success": False, "reason": "NO_FORM_FOUND",
                    "message": "No application form and no sign-in were found on this page."}

        if state.get("wall"):
            self.log_callback(f"This site requires an account: “{state['wall']}”.", step=3)

        email = PORTAL_EMAIL
        attempts = [p for p in (PORTAL_PASSWORD_PRIMARY, PORTAL_PASSWORD_SECONDARY) if p]

        # Said once per process, at the moment it stops being theoretical.
        global _WARNED_SHARED_PASSWORD
        if attempts and not _WARNED_SHARED_PASSWORD and portal_password_is_google_password():
            _WARNED_SHARED_PASSWORD = True
            self.log_callback(
                "Heads up: the portal password is also your Google account password, and it is "
                "about to be typed into employer sites. A breach at any one of them would reach "
                "your mailbox. Setting PORTAL_PASSWORD_PRIMARY in .env to something else fixes it.",
                step=3)

        # The rungs, in order. Built as a list rather than a run of ifs so that
        # every one of them is guaranteed its turn: the old shape read the page
        # once at the top and then let whichever rung ran first spend the whole
        # budget, which is why a portal that took two slow password attempts
        # never reached Google or registration at all.
        rungs = [(f"password_{i}",
                  f"Signing in as {email} (attempt {i} of {len(attempts)})...",
                  lambda p=password: build_login_prompt(email, p, company),
                  None)
                 for i, password in enumerate(attempts, start=1)]

        rungs.append(("google",
                      "Trying the Google sign-in button...",
                      lambda: build_google_prompt(company),
                      # Only worth a turn if the page actually offers it, and
                      # that is re-checked at the time: a failed password often
                      # reveals a fuller sign-in page than the one first shown.
                      lambda s: s.get("has_google")))

        if PORTAL_SIGNUP_PASSWORD:
            rungs.append(("new_account",
                          f"Creating a candidate account on {company}...",
                          lambda: build_signup_prompt(email, PORTAL_SIGNUP_PASSWORD, company),
                          None))
            # Registering frequently leaves you on a "your account is ready,
            # please log in" page rather than signed in, so the ladder closes
            # the loop and logs in with the password it just set.
            rungs.append(("post_signup_login",
                          "Logging in with the account that was just created...",
                          lambda: build_login_prompt(email, PORTAL_SIGNUP_PASSWORD, company),
                          None))

        for index, (method, announcement, make_prompt, precondition) in enumerate(rungs):
            remaining = deadline - time.time()
            if remaining <= 10:
                self.log_callback("Ran out of time before every sign-in option had been tried.",
                                  step=3)
                break

            # Re-read the page. State from three attempts ago describes a page
            # that is no longer on screen.
            state = self.page_access_state()
            if self.looks_signed_in():
                self.log_callback("Signed in.", step=3)
                self.save_session_cookies(self._site_label())
                return {"success": True, "method": method}
            if precondition and not precondition(state):
                continue

            # An even split of what is left, so a slow rung cannot starve the
            # ones behind it.
            share = max(35.0, remaining / max(1, len(rungs) - index))

            self.log_callback(announcement, step=3)
            res = self.run_auth_task(make_prompt(), f"{announcement.rstrip('.')} ({company})",
                                     max_wait_seconds=int(min(share, remaining)))

            note = str(res.get("message") or "").lower()
            if "verification" in note or "code" in note or "confirm your email" in note:
                code = self.fetch_emailed_code()
                if code:
                    res = self.run_auth_task(build_verification_prompt(code),
                                             "Entering the emailed verification code",
                                             max_wait_seconds=60)

            if res.get("success") or self.looks_signed_in():
                self.log_callback("Signed in." if method.startswith("password")
                                  else f"Success via {method.replace('_', ' ')}.", step=3)
                if self.save_session_cookies(self._site_label()):
                    self.log_callback(f"Saved this session, so future {company} jobs skip the "
                                      f"sign-in.", step=3)
                return {"success": True, "method": method}

            self.log_callback({
                "google": "The Google session did not carry through.",
                "new_account": "Could not complete registration.",
                "post_signup_login": "The new account did not let us in.",
            }.get(method, "That password was not accepted."), step=3)

        return {"success": False, "reason": f"LOGIN_REQUIRED:{company}",
                "message": (f"{company} needs an account and none of the sign-in attempts worked. "
                            f"The browser is open on their sign-in page — one manual sign-in there "
                            f"is remembered for every future job at this employer.")}

    def _site_label(self) -> str:
        """A vault key for the current site, e.g. 'portal:tue.varbi.com'."""
        try:
            host = self.driver.execute_script("return location.hostname;") or "unknown"
        except Exception:
            host = "unknown"
        return f"portal:{host}"

    def submit_filled_form(self, job_title: str, company: str, max_wait_seconds: int = 90) -> dict:
        """
        Sends the form the candidate has already read, without rewriting it.

        Nothing is autofilled and nothing is re-answered here. The approval was
        given for the words currently on the page, so those are the words that
        go, and the only outcome that counts as success is the employer's own
        page saying it received the application.
        """
        if self.browser_is_gone():
            return {"success": False, "browser_closed": True,
                    "message": "The browser window holding your reviewed form was closed, so there "
                               "was nothing left to send. Nothing was submitted."}

        self.enforce_single_tab()
        self.start_agent_task(build_submit_prompt(job_title, company),
                              f"Sending your approved application to {company}")

        start_time = time.time()
        seen = 0
        while time.time() - start_time < max_wait_seconds:
            time.sleep(1.5)
            if self.browser_is_gone():
                return {"success": False, "browser_closed": True,
                        "message": "The browser window was closed before the application was sent. "
                                   "Nothing was submitted."}
            self.enforce_single_tab()
            self.capture_screenshot()
            seen = self.stream_agent_steps(seen)

            verification = self.verify_submission()
            if verification.get("success") or verification.get("barrier"):
                return verification

            # The click took the page somewhere and the agent went down with the
            # old document. Deliberately NOT remounted: the brief says "press
            # send", and handing that to a page we have already sent from is how
            # an employer gets the same application twice. An unverified send is
            # a far smaller problem than a duplicate one, so it stops here and
            # says exactly what it does and does not know.
            if self.agent_lost_its_page() is not None:
                time.sleep(2)
                settled = self.verify_submission()
                if settled.get("success") or settled.get("barrier"):
                    return settled
                self.capture_screenshot(hide_agent_ui=True)
                return {
                    "success": False,
                    "unverified": True,
                    "message": (
                        "The send button was pressed and the page moved on, but nothing on the "
                        "new page confirms the application was received. Nothing was sent twice. "
                        "Check the open browser window before trying again."
                    ),
                }

            try:
                if self.driver.execute_script("return window.__BOJ_AGENT_FINISHED;"):
                    # A redirect to the confirmation page can lag the click.
                    time.sleep(3)
                    self.stream_agent_steps(seen)
                    self.capture_screenshot(hide_agent_ui=True)
                    return self.verify_submission()
            except Exception:
                pass

        self.capture_screenshot(hide_agent_ui=True)
        final = self.verify_submission()
        if not final.get("success"):
            final["message"] = f"Time ran out before any confirmation appeared. {final.get('message', '')}".strip()
        return final

    def run_agent(self, job_title: str, company: str, candidate: dict, max_wait_seconds: int = 120,
                  submit: bool = False) -> dict:
        """
        Orchestrates the full visible application flow:
        1. Tab enforcement & preflight cookie dismissal.
        2. Form advancement (clicks 'Postuler' if form not yet on screen).
        3. Instant visible autofill (First Name, Email, Phone, Address, LinkedIn, Consent).
        4. Synthetic CV injection.
        5. PageAgent execution (Fuelix) for dynamic questions & multi-step forms.
        6. Strict verification to eliminate false positives.

        `submit` is false by default: the run stops with the form filled and the
        Submit button untouched, which is the state the candidate reviews.
        """
        self.remounts = 0
        if self.browser_is_gone():
            return {"success": False, "browser_closed": True,
                    "message": "The browser window closed before the form could be opened. "
                               "Nothing was sent."}
        self.enforce_single_tab()

        # Check expired vacancy
        try:
            page_text = (self.driver.execute_script(
                PAGE_TEXT_JS + "return __bojPageText(10000).toLowerCase();") or "")
            expired_phrases = [
                "vacature is verlopen", "job has expired", "this job is no longer available",
                "position has been filled", "cette offre n'est plus disponible", "offre expirée",
                "404 not found", "page introuvable"
            ]
            if any(phrase in page_text for phrase in expired_phrases):
                self.log_callback("Notice: This job listing has expired or was removed by the employer.", step=3)
                return {"success": False, "message": "This job listing has expired or was closed by the employer."}
        except Exception:
            pass

        # Step 1: Dismiss cookie banners
        cookie_text = self.dismiss_cookie_overlays()
        if cookie_text:
            self.log_callback(f"Dismissed cookie consent banner ('{cookie_text}').", step=3)
            time.sleep(1)

        # Step 2: Advance to application form if needed
        self.advance_to_application_form()

        # Step 2b: no longer runs the sign-in ladder up front.
        #
        # It used to, and the effect was that the component least able to read
        # the page went first. The ladder decides from counts of fields and a
        # list of wall phrases; the agent can see that the form is behind a
        # "Créer un compte" tab, that the Google button is the one in the
        # modal, that the second attempt failed for a different reason than the
        # first. It now carries the account logic itself (see access_brief) and
        # the ladder is held back for the case where it reports it could not get
        # in -- see hit_signin_wall() in the monitoring loop below.

        # Step 3: Attach the CV. This is the one thing the driver still does to
        # the form itself, because a file input cannot be filled by typing --
        # the bytes have to be put there from outside the page.
        #
        # It does NOT fill any text fields. The agent owns those now. Both used
        # to write to the same form, which is not merely duplicated work: the
        # agent picks elements by index from a snapshot it took a moment
        # earlier, so a second writer changing values underneath it re-renders
        # the page and shifts those indices, and the agent's next action lands
        # on the wrong field.
        attached = self.inject_cv_file()
        if attached:
            self.log_callback("Attached resume: Badreddine_Barki_CV.pdf", step=4)

        self.capture_screenshot()

        prompt_text = build_agent_prompt(job_title, company, candidate, submit=submit)
        self.start_agent_task(prompt_text, f"Starting autonomous page control for {job_title}")

        start_time = time.time()
        last_step_count = 0
        # A page change buys the run a fresh budget, because the work restarts
        # on the new page. The hard stop keeps a redirect chain from turning
        # that into an open tab.
        deadline = start_time + max_wait_seconds
        hard_deadline = start_time + max_wait_seconds * 2

        # How many ticks the run will sit on a sign-in provider's page after the
        # agent says it is through, waiting for the redirect back to land. Five
        # ticks is roughly twenty-five seconds, which is generous for an OAuth
        # hand-back and short enough not to spend the whole budget on one that
        # is never coming.
        identity_finishes = 0
        MAX_IDENTITY_FINISHES = 5

        # Step monitoring and corroboration loop
        while time.time() < deadline:
            time.sleep(1.5)

            # 0a. Nothing below can work on a closed window, and grinding on to
            #     the timeout only to report a Selenium error helps nobody.
            if self.browser_is_gone():
                return {"success": False, "browser_closed": True,
                        "message": "The browser window was closed, so the application was stopped. "
                                   "Nothing was sent."}

            self.enforce_single_tab()
            # Only while there is still no CV on the page. Once it has landed
            # this stops touching the form entirely, so the agent is the only
            # thing moving. Late-appearing upload steps are still covered.
            if not self.cv_attached:
                self.inject_cv_file()
            # Runs on every tick, so a stray password is gone long before any
            # Submit button can be reached.
            self.scrub_leaked_passwords()
            self.capture_screenshot()

            # 0b. The agent stopped to ask something. It will wait forever, so
            #     the run ends here and the question goes to the candidate.
            question = self.pending_question()
            if question:
                self.log_callback(f"The agent stopped to ask: {question}", step=6)
                self.capture_screenshot(hide_agent_ui=True)
                verdict = self.rehearsal_verdict()
                verdict["question"] = question
                verdict["message"] = (
                    f"The agent needs an answer before it can finish: “{question}” "
                    f"{verdict.get('message', '')}".strip()
                )
                return verdict

            # 0c. The job board may have handed off to the employer's own site,
            #     taking the agent down with the old document.
            if self.resume_after_navigation():
                last_step_count = 0
                deadline = min(time.time() + max_wait_seconds, hard_deadline)
                continue

            # 1. Stream live steps
            last_step_count = self.stream_agent_steps(last_step_count)

            # 2. Check strict confirmation on page
            verification = self.verify_submission()
            if verification.get("success"):
                return self._label_submission(verification, submit)

            # Nothing writes to the form here. A second filler running on every
            # tick was overwriting the agent's own answers mid-run and moving
            # the elements it was aiming at.

            # 3. Check if PageAgent reported completion
            try:
                finished = self.driver.execute_script("return window.__BOJ_AGENT_FINISHED;")
                if finished:
                    # Give any pending post-submit redirect or confirmation 3s to render
                    time.sleep(3)

                    # An agent that stops on a sign-in provider's page has not
                    # finished an application, whatever it says: there is no
                    # form on an account chooser to have filled. Judging the run
                    # here is what ended it with "nothing on this page could be
                    # filled in" while the browser sat one click from being
                    # signed in.
                    if self.on_identity_provider(self.current_url()):
                        note = (self.agent_done_note() or "").lower()
                        if "session expired" in note or "session has lapsed" in note:
                            self.capture_screenshot(hide_agent_ui=True)
                            return {
                                "success": False, "barrier": True,
                                "reason": "GOOGLE_SESSION_EXPIRED",
                                "message": (
                                    "The saved Google sign-in has lapsed, so this site could not be "
                                    "entered with it. Run 'python -m services.automation.link_google' "
                                    "once to sign in again."),
                            }
                        identity_finishes += 1
                        if identity_finishes <= MAX_IDENTITY_FINISHES:
                            # It believes it got through and the redirect back to
                            # the employer is still in the air. The top of the
                            # loop remounts the agent when it lands.
                            time.sleep(2)
                            continue
                        self.capture_screenshot(hide_agent_ui=True)
                        return {
                            "success": False, "barrier": True,
                            "reason": f"LOGIN_REQUIRED:{company}",
                            "message": ("The sign-in never came back to the employer's site, so the "
                                        "application was not reached."),
                        }

                    final_check = self.verify_submission()
                    if final_check.get("success") or final_check.get("barrier") or submit:
                        return self._label_submission(final_check, submit)
                    # The agent walked into a login wall part-way through the
                    # form. Rule 10 of its brief tells it to stop rather than
                    # guess a password, and that used to end the run with two
                    # fields filled and "sign-in required" as the explanation.
                    # The ladder exists for exactly this; run it and carry on.
                    # It asked for the emailed code, which is the one thing it
                    # has no way of getting. Fetch it and hand it back rather
                    # than ending a run that is otherwise going fine.
                    note = (self.agent_done_note() or "").lower()
                    if ("email code" in note or "verification code" in note
                            or "confirmation code" in note) and self.signin_recoveries < self.MAX_SIGNIN_RECOVERIES:
                        self.signin_recoveries += 1
                        self.log_callback("The site wants an emailed code. Reading it from your "
                                          "mailbox...", step=3)
                        code = self.fetch_emailed_code()
                        if code:
                            saved_prompt, saved_label = self.active_prompt, self.active_label
                            self.run_auth_task(build_verification_prompt(code),
                                               "Entering the emailed verification code",
                                               max_wait_seconds=60)
                            self.start_agent_task(saved_prompt, saved_label)
                            last_step_count = 0
                            deadline = min(time.time() + max_wait_seconds, hard_deadline)
                            continue
                        self.log_callback("No code arrived in the mailbox.", step=3)

                    if self.hit_signin_wall() and self.signin_recoveries < self.MAX_SIGNIN_RECOVERIES:
                        self.signin_recoveries += 1
                        self.log_callback("The form asked for an account part-way through. "
                                          "Signing in, then picking up where it stopped.", step=3)
                        saved_prompt, saved_label = self.active_prompt, self.active_label
                        access = self.ensure_access(company)
                        if not access.get("success"):
                            self.capture_screenshot(hide_agent_ui=True)
                            return {"success": False, "barrier": True,
                                    "reason": access.get("reason", f"LOGIN_REQUIRED:{company}"),
                                    "message": access.get("message", "This site needs an account.")}
                        self.advance_to_application_form()
                        self.cv_attached = False   # a new form needs the CV again
                        self.inject_cv_file()
                        self.start_agent_task(saved_prompt, saved_label)
                        last_step_count = 0
                        deadline = min(time.time() + max_wait_seconds, hard_deadline)
                        continue

                    # A rehearsal ends here on purpose: the agent stopped because
                    # the form is full, and the only thing left was to send it.
                    # The last shot is the one that gets read, so take it clean.
                    self.capture_screenshot(hide_agent_ui=True)
                    return self.rehearsal_verdict()
            except Exception:
                pass

        # Out of time. On a rehearsal that is not necessarily a failure — the
        # form may well be filled — so report what is actually on the page.
        timed_out = self.verify_submission()
        if submit or timed_out.get("success") or timed_out.get("barrier"):
            return self._label_submission(timed_out, submit)
        self.capture_screenshot(hide_agent_ui=True)
        verdict = self.rehearsal_verdict()
        verdict["message"] = f"Time ran out. {verdict.get('message', '')}".strip()
        return verdict

    @staticmethod
    def _label_submission(result: dict, submit: bool) -> dict:
        """
        A rehearsal that ends in a confirmed submission means the agent sent
        something it was told not to send. That is worth saying out loud rather
        than reporting as a clean success.
        """
        if result.get("success") and not submit:
            result = dict(result)
            result["unexpected_submit"] = True
            result["message"] = (
                "This was meant to be a rehearsal, but the page now confirms a submitted "
                f"application. {result.get('message', '')}"
            ).strip()
        return result

