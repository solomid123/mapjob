import os
import sys
import time
import base64
import json
import re
from typing import Callable, Optional

PAGE_AGENT_JS_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "MapJOB_browser-extension", "page-agent.js"))
CV_PDF_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))

def load_page_agent_script() -> str:
    with open(PAGE_AGENT_JS_PATH, "r", encoding="utf-8") as f:
        return f.read()

def load_cv_data_url() -> str:
    if os.path.exists(CV_PDF_PATH):
        with open(CV_PDF_PATH, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")
            return f"data:application/pdf;base64,{encoded}"
    return ""

def build_agent_prompt(job_title: str, company: str, candidate: dict) -> str:
    first_name = candidate.get("first_name", "Badreddine")
    last_name = candidate.get("last_name", "Barki")
    email = candidate.get("email", "badreddinebarki@gmail.com")
    phone = candidate.get("phone", "+33745768010")
    address = candidate.get("full_address", "14 Rue de la 2e D.B., 80000 Amiens, France")
    city = candidate.get("city", "Amiens")
    postal = candidate.get("postal_code", "80000")
    linkedin = candidate.get("linkedin", "https://www.linkedin.com/in/barki-badreddine-bb2328146")

    prompt = f"""Fill out the job application form ALREADY on this page for the position "{job_title}" at "{company}".

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

ACCOUNT CREATION & PORTAL SIGN-IN CREDENTIALS:
- Email: {email}
- Passwords to try in order:
  1) Open_up_for_Badr00@@
  2) Open_up_for_Badr00
  3) Badreddine00++
If a sign-in or account creation page/modal appears ("Se connecter", "Connectez-vous pour postuler", "Sign In", "Create Account"):
enter Email "{email}" and password 1) to sign in or register, then proceed to the application form.

CANDIDATE WORK EXPERIENCE HISTORY:
1. Title: Research and Development Mechanical Engineer | Company: SLB GROUP | Location: Abbeville, France | Dates: 03/2022 - 07/2025
2. Title: R&D Mechanical Engineer Intern | Company: Sigma | Location: Clermont-Ferrand, France | Dates: 03/2021 - 09/2021
3. Title: Mechanical Engineering Intern | Company: OCP Group | Location: Morocco | Dates: 06/2017 - 08/2017

RESUME FILE:
- Badreddine_Barki_CV.pdf is already attached programmatically into the resume/CV slot on this page.
- Do NOT click "Browse" or "Upload" file buttons.

NON-NEGOTIABLE RULES:
1. STAY ON THIS APPLICATION PAGE. Never navigate to other job listings, search results, or homepages. Keep all actions within this application form.
2. Fill EVERY visible REQUIRED field (marked with * or "Required"). Answer questions truthfully based on the candidate profile.
3. For dropdowns/selects or radio choices: pick the most appropriate option.
4. WORK AUTHORIZATION: Candidate holds a valid work permit for FRANCE and Moroccan citizenship.
   - "Authorized to work in France / French work permit?": YES.
   - Sponsorship required outside France/Morocco: YES.
5. Salary expectation: 40000 EUR (or "40000" / "40K").
6. Notice period: Available immediately / 1 month.
7. SUBMIT APPLICATION: When all required fields are filled and the final "Submit" / "Postuler" / "Envoyer ma candidature" button is visible, CLICK IT!
8. When submission is confirmed or completed, call done(success=true, "submitted application").
"""
    return prompt

class PageAgentManager:
    def __init__(self, driver, log_callback: Optional[Callable[[str, int, str, bool, bool], None]] = None):
        self.driver = driver
        self.log_callback = log_callback or (lambda msg, step=0, status="running", done=False, success=False: None)
        self.page_agent_script = load_page_agent_script()
        self.cv_data_url = load_cv_data_url()
        self.latest_screenshot = None

    def capture_screenshot(self) -> Optional[str]:
        """Captures live screen as base64 PNG data URI."""
        try:
            b64 = self.driver.get_screenshot_as_base64()
            if b64:
                self.latest_screenshot = f"data:image/png;base64,{b64}"
                return self.latest_screenshot
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
                    self.driver.get(target_url)

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
                clicked = self.driver.execute_script("""
                    const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
                    for (const el of btns) {
                        const t = (el.innerText || el.value || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                        if (
                            t === 'postuler' ||
                            t === 'postuler maintenant' ||
                            t === 'je postule' ||
                            t === 'candidater' ||
                            t === 'apply' ||
                            t === 'apply now' ||
                            t === 'apply online' ||
                            t === 'solliciteer' ||
                            t === 'solliciteren' ||
                            t.startsWith('postuler') ||
                            t.startsWith('je postule')
                        ) {
                            try {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                el.click();
                                return t;
                            } catch(e) {}
                        }
                    }
                    return null;
                """)
                if clicked:
                    self.log_callback(f"Clicked application button: '{clicked}' - loading form...", step=3)
                    time.sleep(2.5)
                    self.enforce_single_tab()
                    return True
        except Exception:
            pass
        return False

    def batch_autofill(self, candidate: dict) -> list:
        """
        High-speed, visible DOM autofill.
        Sets candidate details (Name, Email, Phone, Location, City, LinkedIn),
        checks consent boxes, and attaches CV so the user directly sees the form populate.
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
            password = candidate.get("password", "Open_up_for_Badr00@@")
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

        return attached

    def verify_submission(self) -> dict:
        """
        Strict corroboration logic from MapJOB_browser-extension/background.js.
        Zero false-positive guarantee:
        1. Checks post-submit confirmation message or URL.
        2. Detects external portal login barriers (e.g. APEC account required).
        3. Probes if submit button or application form is still open.
        """
        verify_script = r"""
        const OK = /thank(s| you) for (your )?(application|applying)|your application (has been|was|has) .{0,25}(submitted|received|sent)|application (has been|was) (successfully )?(submitted|received|sent)|submission (successful|confirmed|complete)|successfully (submitted|applied)|we'?ve received your application|application received|you'?ve applied|already applied|vous avez (d[ée]j[àa] )?postul[ée]?( [àa] cette offre)?|candidature.{0,25}envoy[ée]e|demande.{0,25}envoy[ée]e|votre candidature a (bien )?[ée]t[ée] (envoy[ée]e|re[çc]ue|enregistr[ée]e|transmise)|merci (pour|de) votre candidature|sollicitatie ontvangen|bedankt voor je sollicitatie/i;
        const URL_OK = /thank[-_ ]?you(?:[/?#.&_-]|$)|\/thanks?(?:[/?#.&_-]|$)|application[-_/]?(?:submitted|received|complete|sent)(?:[/?#.&_-]|$)|submission[-_/]?(?:successful|confirmed|complete)(?:[/?#.&_-]|$)|apply[-_/]?(?:success|confirmed|confirmation|complete)(?:[/?#.&_-]|$)/i;
        
        let text = "";
        try { text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 10000); } catch(e) {}
        
        const m = text.match(OK);
        if (m) return { submitted: true, match: m[0] };
        
        try {
            const um = String(location.href || "").match(URL_OK);
            if (um) return { submitted: true, match: 'url:' + um[0] };
        } catch(e) {}
        
        // Barrier detection: candidate login wall
        const lowText = text.toLowerCase();
        const BARRIER_RE = /connectez[- ]vous pour postuler|se connecter pour postuler|connexion requise|créer un compte pour postuler|créez un compte pour postuler|identifiez-vous pour postuler|votre compte apec|veuillez vous connecter/i;
        if (BARRIER_RE.test(lowText)) {
            return { submitted: false, barrier: true, match: "Login required on employer portal" };
        }

        // Check if submit button is still standing
        const SUBMIT_RE = /submit( application)?|send( my)? application|envoyer( ma)? candidature|envoyer$|^envoyer|soumettre|confirmer ma candidature/i;
        const els = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
        for (const el of els) {
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
                return {"success": True, "message": f"Verified submission: {res.get('match')}"}
            if res.get("barrier"):
                return {"success": False, "barrier": True, "message": "⚠️ Portal requires candidate account login (e.g. APEC / France Travail)."}
            if res.get("submitStillVisible"):
                return {"success": False, "message": f"Application form remains open (Submit button '{res.get('match')}' still standing)."}
            return {"success": False, "message": "Application cycle concluded without confirmation evidence."}
        except Exception as e:
            return {"success": False, "message": str(e)}

    def run_agent(self, job_title: str, company: str, candidate: dict, max_wait_seconds: int = 120) -> dict:
        """
        Orchestrates the full visible application flow:
        1. Tab enforcement & preflight cookie dismissal.
        2. Form advancement (clicks 'Postuler' if form not yet on screen).
        3. Instant visible autofill (First Name, Email, Phone, Address, LinkedIn, Consent).
        4. Synthetic CV injection.
        5. PageAgent execution (gpt-5.6-terra via Fuelix) for dynamic questions & multi-step forms.
        6. Strict verification to eliminate false positives.
        """
        self.enforce_single_tab()

        # Check expired vacancy
        try:
            page_text = self.driver.execute_script("return document.body ? document.body.innerText.toLowerCase() : '';")
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

        # Step 3: Fast visible autofill
        filled_fields = self.batch_autofill(candidate)
        if filled_fields:
            for f_info in filled_fields[:5]:
                self.log_callback(f"Autofilled {f_info}", step=4)

        # Step 4: Attach CV
        attached = self.inject_cv_file()
        if attached:
            self.log_callback("Attached resume: Badreddine_Barki_CV.pdf", step=4)

        self.capture_screenshot()

        # Step 5: Mount & run PageAgent
        is_loaded = False
        try:
            is_loaded = self.driver.execute_script("return typeof window.PageAgent !== 'undefined';")
        except Exception:
            pass

        if not is_loaded:
            self.log_callback("Mounting PageAgent core into employer portal...", step=5)
            self.driver.execute_script(self.page_agent_script)
            time.sleep(1)

        prompt_text = build_agent_prompt(job_title, company, candidate)

        launch_script = """
        const promptText = arguments[0];
        window.__BOJ_STEPS = [];
        window.__BOJ_AGENT_FINISHED = false;
        window.__BOJ_AGENT_RESULT = null;

        try {
            if (!window.__boj_agent_instance) {
                window.__boj_agent_instance = new window.PageAgent({
                    model: "gpt-5.6-terra",
                    baseURL: "https://api.fuelix.ai/v1",
                    apiKey: "ak-p9YxA11lcjojQGtzBRkt9ne1kF23",
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

        self.log_callback(f"Starting autonomous page control for {job_title}...", step=5)
        init_res = self.driver.execute_script(launch_script, prompt_text)
        if not init_res or not init_res.get("started"):
            err_msg = init_res.get("error", "PageAgent setup notice")
            self.log_callback(f"Agent note: {err_msg}", step=5)

        start_time = time.time()
        last_step_count = 0

        # Step monitoring and corroboration loop
        while time.time() - start_time < max_wait_seconds:
            time.sleep(1.5)
            self.enforce_single_tab()
            self.inject_cv_file()
            self.capture_screenshot()

            # 1. Stream live steps
            try:
                steps = self.driver.execute_script("return window.__BOJ_STEPS || [];")
                if len(steps) > last_step_count:
                    for i in range(last_step_count, len(steps)):
                        self.log_callback(f"Agent: {steps[i]}", step=6)
                    last_step_count = len(steps)
            except Exception:
                pass

            # 2. Check strict confirmation on page
            verification = self.verify_submission()
            if verification.get("success"):
                return verification
            # Run assist autofill on newly rendered form/login steps
            try:
                self.batch_autofill(candidate)
            except Exception:
                pass

            # 3. Check if PageAgent reported completion
            try:
                finished = self.driver.execute_script("return window.__BOJ_AGENT_FINISHED;")
                if finished:
                    # Give any pending post-submit redirect or confirmation 3s to render
                    time.sleep(3)
                    final_check = self.verify_submission()
                    return final_check
            except Exception:
                pass

        # Conclude with final verification check
        return self.verify_submission()

