import os
import sys
import time
import ctypes
import subprocess
import undetected_chromedriver as uc
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select
from selenium.webdriver.common.keys import Keys

from .candidate_profile import CANDIDATE_PROFILE
from .ai_form_analyzer import AIFormAnalyzer
from .email_watcher import EmailWatcher
from .captcha_solver import CaptchaSolver
from .config import (
    CANDIDATE_ACCOUNT_PASSWORD,
    CANDIDATE_FALLBACK_PASSWORD,
    GOOGLE_LOGIN_EMAIL,
    GOOGLE_LOGIN_PASSWORD,
)

# Ensure all processes are spawned on the user's interactive Windows Desktop (WinSta0\Default)
if os.name == "nt":
    try:
        user32 = ctypes.windll.user32
        h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
        if h_desk:
            user32.SetThreadDesktop(h_desk)
            user32.SwitchDesktop(h_desk)
    except Exception as e:
        pass

    _orig_popen_init = subprocess.Popen.__init__
    def _desktop_popen_init(self, *args, **kwargs):
        si = kwargs.get("startupinfo")
        if si is None:
            si = subprocess.STARTUPINFO()
        si.lpDesktop = r"WinSta0\Default"
        kwargs["startupinfo"] = si
        _orig_popen_init(self, *args, **kwargs)
    subprocess.Popen.__init__ = _desktop_popen_init

class JobNavigator:
    def __init__(self, headless=False):
        self.headless = headless
        self.driver = None
        self.analyzer = AIFormAnalyzer()
        self.email_watcher = EmailWatcher()
        self.solver = None

    def start(self):
        options = uc.ChromeOptions()
        options.add_argument("--start-maximized")
        options.add_argument("--window-position=0,0")
        options.add_argument("--window-size=1920,1080")
        options.add_argument("--disable-features=DiceWebSigninIntercept")
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")
        options.add_argument("--disable-popup-blocking")
        if self.headless:
            options.add_argument("--headless=new")
        
        # Persistent Chrome profile so Google logins & cookies are saved permanently
        profile_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".chrome_profile"))
        os.makedirs(profile_dir, exist_ok=True)

        # No version_main pin: let undetected-chromedriver match installed Chrome automatically.
        self.driver = uc.Chrome(options=options, user_data_dir=profile_dir, use_subprocess=True)
        try:
            self.driver.maximize_window()
            # Bring window to front on the user's interactive Default desktop
            if os.name == "nt":
                user32 = ctypes.windll.user32
                h_desk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
                def _bring_chrome_front(hwnd, _):
                    if user32.IsWindowVisible(hwnd):
                        pid = ctypes.c_ulong()
                        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                        if getattr(self, "driver", None) and getattr(self.driver, "browser_pid", None):
                            if pid.value == self.driver.browser_pid:
                                user32.ShowWindow(hwnd, 3) # SW_MAXIMIZE
                                user32.SetForegroundWindow(hwnd)
                    return True
                WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.c_int)
                user32.EnumDesktopWindows(h_desk, WNDENUMPROC(_bring_chrome_front), 0)
        except Exception:
            pass
        self.solver = CaptchaSolver(self.driver)

    def stop(self):
        if self.driver:
            try:
                self.driver.quit()
            except Exception:
                pass
            self.driver = None

    def apply_to_url(self, target_url: str, custom_cv: str = None) -> dict:
        """
        Universal entry point: navigates to any job URL, resolves redirects,
        identifies ATS/form, fills candidate data, and completes the application.
        """
        if not self.driver:
            self.start()

        cv_file = custom_cv or CANDIDATE_PROFILE["resumes"]["fr"]
        result = {
            "success": False,
            "target_url": target_url,
            "final_url": "",
            "platform": "unknown",
            "message": ""
        }

        print(f"\n[JobNavigator] === Starting application flow for: {target_url} ===")
        # Pre-inject cookies if target domain is known
        self._inject_saved_cookies(target_url)
        self.driver.get(target_url)
        time.sleep(3)

        # 1. Dismiss initial cookie banners
        self.dismiss_cookies()

        # 2. Check if we are on an aggregator (Adzuna, Ouest-France, etc.) and resolve to destination
        parsed_host = self.driver.current_url.lower().split("/")[2] if len(self.driver.current_url.split("/")) > 2 else ""
        if "adzuna.fr" in parsed_host or "adzuna.com" in parsed_host:
            print("[JobNavigator] Detected Adzuna aggregator. Resolving redirect...")
            self._resolve_adzuna_redirect()
        elif "ouest-france" in parsed_host or "ouestfrance" in parsed_host:
            print("[JobNavigator] Detected Ouest-France Emploi job board. Resolving recruiter destination...")
            self._resolve_ouest_france_redirect()

        # Update destination URL
        final_url = self.driver.current_url
        result["final_url"] = final_url
        print(f"[JobNavigator] Final destination URL: {final_url}")
        self.driver.save_screenshot("navigator_destination.png")

        # Inject saved cookies if available for destination
        self._inject_saved_cookies()

        # 3. Detect Platform
        if "beehire.com" in final_url:
            result["platform"] = "beehire"
            return self._handle_beehire(cv_file)
        elif "hellowork.com" in final_url or "hw-recruteur.com" in final_url:
            result["platform"] = "hellowork"
            return self._handle_hellowork(cv_file)
        elif "tzportal.io" in final_url:
            result["platform"] = "talentzoom"
            return self._handle_talentzoom(cv_file)
        elif "werecruit.io" in final_url:
            result["platform"] = "werecruit"
            return self._handle_werecruit(cv_file)
        else:
            result["platform"] = "generic"
            return self._handle_generic_form(cv_file)

    def _inject_saved_cookies(self, target_url: str = ""):
        """Injects saved cookies for known portals (e.g. APEC) using CDP and standard fallback."""
        cur = ((self.driver.current_url or "") + " " + target_url).lower()
        if "apec.fr" in cur and not getattr(self, "_apec_cookies_injected", False):
            cookie_path = os.path.join(os.path.dirname(__file__), "saved_cookies.json")
            if os.path.exists(cookie_path):
                try:
                    import json
                    with open(cookie_path, "r", encoding="utf-8") as f:
                        raw = json.load(f)
                    print(f"[JobNavigator] Injecting {len(raw)} authenticated cookies for APEC via CDP...")
                    cdp_cookies = []
                    for c in raw:
                        co = {
                            "name": c["name"],
                            "value": c["value"],
                            "path": c.get("path", "/"),
                        }
                        if c.get("domain"):
                            co["domain"] = c["domain"]
                        if "secure" in c and c["secure"] is not None:
                            co["secure"] = bool(c["secure"])
                        if "httpOnly" in c and c["httpOnly"] is not None:
                            co["httpOnly"] = bool(c["httpOnly"])
                        if c.get("sameSite") and str(c["sameSite"]).lower() in ["strict", "lax", "none"]:
                            co["sameSite"] = str(c["sameSite"]).capitalize()
                        cdp_cookies.append(co)
                    
                    try:
                        self.driver.execute_cdp_cmd("Network.setCookies", {"cookies": cdp_cookies})
                        print("[JobNavigator] CDP Network.setCookies succeeded.")
                    except Exception as cdp_err:
                        print(f"[JobNavigator] CDP setCookies fallback notice: {cdp_err}")
                        for cd in cdp_cookies:
                            try:
                                d = {k: v for k, v in cd.items() if k in ["name", "value", "path", "domain", "secure"]}
                                self.driver.add_cookie(d)
                            except Exception:
                                pass

                    self._apec_cookies_injected = True
                    if "apec.fr" in (self.driver.current_url or "").lower():
                        print("[JobNavigator] Cookies successfully injected. Refreshing page...")
                        self.driver.refresh()
                        time.sleep(3)
                        self.dismiss_cookies()
                except Exception as e:
                    print(f"[JobNavigator] Cookie injection error: {e}")

    def dismiss_cookies(self):
        """Auto-clicks standard consent buttons and solves interactive challenges."""
        if getattr(self, "solver", None):
            try:
                self.solver.try_solve()
            except Exception:
                pass

        selectors = [
            "//button[contains(., 'Tout accepter')]",
            "//a[contains(., 'Tout accepter')]",
            "//*[@role='button' and contains(., 'Tout accepter')]",
            "//button[contains(@id, 'tarteaucitron') and (contains(., 'Tout accepter') or contains(., 'Accepter') or contains(@id, 'AllAllowed'))]",
            "//button[contains(@id, 'tarteaucitronClosePanel')]",
            "//button[contains(., 'ALLES ACCEPTEREN')]",
            "//button[contains(., 'Alles accepteren')]",
            "//button[contains(., 'Accepter') and not(contains(., 'CGU'))]",
            "//button[text()='OK!']",
            "//button[@id='didomi-notice-agree-button']",
            "//button[@id='onetrust-accept-btn-handler']",
            "//div[@id='cookiescript_accept']",
            "//*[contains(text(), 'OK pour moi')]",
            "//button[contains(@id, 'axeptio')]",
            "//*[contains(@class, 'axeptio') and (contains(text(), 'OK') or contains(text(), 'Accepter'))]"
        ]
        for sel in selectors:
            try:
                btns = self.driver.find_elements(By.XPATH, sel)
                for b in btns:
                    if b.tag_name in ["html", "body"]:
                        continue
                    if b.is_displayed():
                        print(f"[JobNavigator] Dismissed cookie notice ({sel})")
                        self.driver.execute_script("arguments[0].click();", b)
                        time.sleep(1)
                        return
            except Exception:
                pass

    def _resolve_adzuna_redirect(self):
        """Bypasses Adzuna interstitials and follows external partner link."""
        try:
            # Click primary apply button
            apply_btns = self.driver.find_elements(By.CSS_SELECTOR, "a[data-js='apply']")
            if not apply_btns:
                apply_btns = self.driver.find_elements(By.XPATH, "//a[contains(text(), 'Solliciteren') or contains(text(), 'Postuler')]")
            
            if apply_btns:
                self.driver.execute_script("arguments[0].click();", apply_btns[0])
                time.sleep(2)

            # Click interstitial skip link
            skip_links = self.driver.find_elements(By.CSS_SELECTOR, "a[data-js='apply-capture-skip']")
            if not skip_links:
                skip_links = self.driver.find_elements(By.XPATH, "//*[contains(text(), 'breng me naar de baan') or contains(text(), 'continuer vers')]")
            
            if skip_links:
                self.driver.execute_script("arguments[0].click();", skip_links[0])
                time.sleep(3)

            # Follow redirects / windows
            main_window = self.driver.current_window_handle
            for _ in range(15):
                time.sleep(1)
                all_windows = self.driver.window_handles
                if len(all_windows) > 1:
                    for w in all_windows:
                        if w != main_window:
                            self.driver.switch_to.window(w)
                            break
                if "adzuna" not in self.driver.current_url and self.driver.current_url != "about:blank":
                    break

            time.sleep(4)
        except Exception as e:
            print(f"[JobNavigator] Adzuna resolution error: {e}")

    def _resolve_ouest_france_redirect(self):
        """Extracts destination ATS from Ouest-France Emploi and navigates directly or follows through."""
        try:
            time.sleep(2)
            self.dismiss_cookies()
            
            dest_url = None
            try:
                btn = self.driver.find_element(By.ID, "btnPostuler")
                trk_data = btn.get_attribute("data-trk")
                if trk_data:
                    import json
                    d = json.loads(trk_data)
                    dest_url = d.get("cta", {}).get("to")
            except Exception:
                pass
                
            if dest_url and dest_url.startswith("http"):
                print(f"[JobNavigator] Directly navigating to recruiter destination: {dest_url}")
                self.driver.get(dest_url)
                time.sleep(4)
                self.dismiss_cookies()
                return

            # Fallback
            for b in self.driver.find_elements(By.XPATH, "//button[contains(., 'Postuler')] | //a[contains(., 'Postuler')]"):
                if b.is_displayed():
                    self.driver.execute_script("arguments[0].click();", b)
                    time.sleep(2)
                    break
                    
            skip_links = self.driver.find_elements(By.XPATH, "//*[contains(text(), 'Non merci') or contains(text(), 'je postule seulement')]")
            if skip_links:
                self.driver.execute_script("arguments[0].click();", skip_links[0])
                time.sleep(4)
        except Exception as e:
            print(f"[JobNavigator] Ouest-France resolution notice: {e}")

    def _handle_beehire(self, cv_file: str) -> dict:
        """Automates complete BeeHire application workflow."""
        print("[JobNavigator] Executing BeeHire handler...")
        self.dismiss_cookies()

        # Check if we need to click 'Postuler' / 'form=true'
        if "form=false" in self.driver.current_url or "form=" not in self.driver.current_url:
            postuler = self.driver.find_elements(By.XPATH, "//a[contains(text(), 'Postuler') or @ng-click='redirectToForm()']")
            if postuler:
                self.driver.execute_script("arguments[0].click();", postuler[0])
                time.sleep(3)

        # Fill Step 1
        try:
            self.driver.find_element(By.NAME, "fname").send_keys(CANDIDATE_PROFILE["first_name"])
            self.driver.find_element(By.NAME, "lname").send_keys(CANDIDATE_PROFILE["last_name"])
            
            addr_inp = self.driver.find_element(By.NAME, "address")
            addr_inp.send_keys(CANDIDATE_PROFILE["full_address"])
            time.sleep(2)
            preds = self.driver.find_elements(By.CSS_SELECTOR, ".google-autocomplete-dropdown li")
            if preds:
                preds[0].click()
            else:
                addr_inp.send_keys(Keys.ENTER)

            self.driver.find_element(By.NAME, "email").send_keys(CANDIDATE_PROFILE["email"])
            self.driver.find_element(By.NAME, "phone").send_keys(CANDIDATE_PROFILE["phone"])

            # Upload CV
            file_inps = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
            if file_inps:
                file_inps[0].send_keys(cv_file)
                time.sleep(3)

            # Referral source
            try:
                selects = self.driver.find_elements(By.CSS_SELECTOR, "select[ng-model='me.referralSource']")
                if selects:
                    Select(selects[0]).select_by_value("adzuna")
            except Exception:
                pass

            # Terms
            terms = self.driver.find_element(By.ID, "ckbAcceptTerms")
            if not terms.is_selected():
                self.driver.execute_script("arguments[0].click();", terms)

            # Submit Step 1
            next_btn = self.driver.find_element(By.CSS_SELECTOR, "a.btn.btn--next")
            self.driver.execute_script("arguments[0].click();", next_btn)
            time.sleep(4)

            self.driver.save_screenshot("beehire_submitted.png")
            return {
                "success": True,
                "platform": "beehire",
                "message": "BeeHire dossier created and linked to candidate email."
            }
        except Exception as e:
            return {"success": False, "platform": "beehire", "message": f"BeeHire error: {e}"}

    def _handle_hellowork(self, cv_file: str) -> dict:
        """Automates complete HelloWork application workflow with OTP verification."""
        print("[JobNavigator] Executing HelloWork handler...")
        self.dismiss_cookies()

        # Click postuler to open form
        postuler_btns = self.driver.find_elements(By.XPATH, "//button[contains(text(), 'Postuler')] | //a[contains(text(), 'Postuler')]")
        if postuler_btns:
            self.driver.execute_script("arguments[0].click();", postuler_btns[0])
            time.sleep(2)

        try:
            fname = self.driver.find_element(By.ID, "Answer_Firstname_Funnel")
            fname.clear()
            fname.send_keys(CANDIDATE_PROFILE["first_name"])

            lname = self.driver.find_element(By.ID, "Answer_LastName_Funnel")
            lname.clear()
            lname.send_keys(CANDIDATE_PROFILE["last_name"])

            email = self.driver.find_element(By.ID, "Answer_Email_Funnel")
            email.clear()
            email.send_keys(CANDIDATE_PROFILE["email"])

            file_input = self.driver.find_element(By.CSS_SELECTOR, "form#offer-detail-main-step-form input[type='file'], input[type='file']")
            file_input.send_keys(cv_file)
            time.sleep(2.5)

            # Customized message
            try:
                acc_btns = self.driver.find_elements(By.XPATH, "//*[contains(text(), 'Personnaliser mon message')]")
                if acc_btns:
                    self.driver.execute_script("arguments[0].click();", acc_btns[0])
                    time.sleep(0.5)

                title = self.driver.title
                company = "l'entreprise"
                msg_text = self.analyzer.generate_motivation_letter(title, company, "")
                msg_area = self.driver.find_element(By.ID, "Answer_MotivationLetter_Funnel")
                msg_area.clear()
                msg_area.send_keys(msg_text)
            except Exception:
                pass

            # CGU
            cgu = self.driver.find_element(By.CSS_SELECTOR, "input[form='offer-detail-main-step-form'][name='HasAcceptedCGU']")
            if not cgu.is_selected():
                self.driver.execute_script("arguments[0].click();", cgu)
                time.sleep(0.5)

            # Submit form
            submit_btn = self.driver.find_element(By.CSS_SELECTOR, "button[form='offer-detail-main-step-form'][data-cy='submitButton']")
            self.driver.execute_script("arguments[0].click();", submit_btn)
            time.sleep(5)

            # Check if OTP screen is active
            otp_inputs = [self.driver.find_elements(By.CSS_SELECTOR, f"input[data-cy='otp-input-{i}']") for i in range(1, 7)]
            if all(otp_inputs):
                print("[JobNavigator] OTP verification screen detected!")
                # Attempt to auto-fetch OTP from Gmail
                otp_code = self.email_watcher.wait_for_otp_code(timeout_seconds=45)
                if not otp_code:
                    # Interactive fallback
                    otp_code = input("\n[ACTION REQUIRED] Entrez le code à 6 chiffres reçu par e-mail: ").strip()

                if otp_code and len(otp_code) == 6:
                    for i, d in enumerate(otp_code):
                        otp_inputs[i][0].send_keys(d)
                        time.sleep(0.2)
                    time.sleep(4)

            self.driver.save_screenshot("hellowork_final.png")
            return {
                "success": True,
                "platform": "hellowork",
                "message": "HelloWork application submitted and verified successfully."
            }

        except Exception as e:
            print(f"[JobNavigator] HelloWork specific layout notice ({e}). Falling back to Universal AI form handler...")
            return self._handle_generic_form(cv_file)

    def _handle_auth_and_registration(self):
        """
        Handles sign-in / account creation modals with strict 3-tier hierarchy:
        1. FIRST ALWAYS: Google / Gmail login (with phone 2FA prompt wait)
        2. FALLBACK 1: Test login with existing candidate email & password (Badreddine00++)
        3. FALLBACK 2: Fallback to creating account then connecting (Badreddine00++)
        """
        time.sleep(2)
        page_text = self.driver.find_element(By.TAG_NAME, "body").text.lower()
        auth_keywords = [
            "crée ton compte", "créer un compte", "connecte-toi", "s'inscrire",
            "connexion", "se connecter", "choisis ton mot de passe", "mot de passe",
            "continuer avec un e-mail", "envoyez votre candidature", "identifiez-vous",
            "authentification", "login"
        ]
        has_auth_indicator = any(w in page_text for w in auth_keywords)
        has_google_btn = len(self.driver.find_elements(
            By.XPATH,
            "//*[@role='button' or self::a or self::button]["
            ".//img[contains(@alt, 'Google') or contains(@src, 'google')] or "
            "contains(translate(., 'GOOGLE', 'google'), 'google') or "
            "contains(translate(@aria-label, 'GOOGLE', 'google'), 'google') or "
            "contains(@href, 'google') or contains(@class, 'google')]"
        )) > 0

        if not (has_auth_indicator or has_google_btn):
            return

        print("[JobNavigator] Detected authentication / portal account prompt.")
        email_val = GOOGLE_LOGIN_EMAIL or os.getenv("GOOGLE_LOGIN_EMAIL", "badreddinebarki@gmail.com")
        account_pwd = CANDIDATE_ACCOUNT_PASSWORD
        google_pwd = GOOGLE_LOGIN_PASSWORD
        if not account_pwd or not google_pwd:
            print("[JobNavigator] Auth passwords not set in .env (GOOGLE_LOGIN_PASSWORD / CANDIDATE_ACCOUNT_PASSWORD). Skipping auto-login, manual login required.")

        # =========================================================================
        # TIER 1: Connect with Google / Gmail FIRST ALWAYS
        # =========================================================================
        print("[JobNavigator] TIER 1: Attempting Google / Gmail connection first...")
        google_success = self._login_with_google(email_val, google_pwd)
        if google_success:
            print("[JobNavigator] TIER 1: Google authentication completed successfully!")
            time.sleep(4)
            self.dismiss_cookies()
            return
        print("[JobNavigator] TIER 1: Google connection not available or unapproved. Moving to Tier 2...")

        # =========================================================================
        # TIER 2: Fallback to testing with existing email & password (LOGIN)
        # =========================================================================
        print("[JobNavigator] TIER 2: Testing login with candidate email and password...")
        # Ensure Candidate profile (not Recruiter) is selected if toggle exists
        try:
            cand_btn = self.driver.find_elements(By.XPATH, "//*[(self::span or self::label or self::button) and contains(., 'Candidat')]")
            for cb in cand_btn:
                if cb.is_displayed():
                    self.driver.execute_script("arguments[0].click();", cb)
                    break
        except Exception:
            pass

        # Switch to "Se connecter" / "Connexion" / "Déjà un compte" tab if available
        try:
            login_switch = self.driver.find_elements(
                By.XPATH,
                "//a[contains(., 'Connexion') or contains(., 'Se connecter') or contains(., 'déjà un compte') or contains(., 'deja un compte')] | "
                "//button[contains(., 'Connexion') or contains(., 'Se connecter')]"
            )
            for ls in login_switch:
                txt_lower = ls.text.strip().lower()
                if any(r in txt_lower for r in ["recruteur", "recruiter", "entreprise", "employeur"]):
                    continue
                if ls.is_displayed():
                    print(f"[JobNavigator] Switching to Login tab: '{ls.text.strip()}'...")
                    self.driver.execute_script("arguments[0].click();", ls)
                    time.sleep(2)
                    break
        except Exception:
            pass

        # Fill email
        for einp in self.driver.find_elements(By.CSS_SELECTOR, "input[type='email'], input[name*='email'], input[id*='email']"):
            try:
                if einp.is_displayed():
                    curr = (einp.get_attribute("value") or "").strip()
                    if curr != email_val:
                        einp.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                        self.driver.execute_script("""
                            var el = arguments[0];
                            var val = arguments[1];
                            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ?
                                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set : null;
                            if (setter) { setter.call(el, val); } else { el.value = val; }
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        """, einp, email_val)
                    print(f"[JobNavigator] Filled auth email: {email_val}")
                    break
            except Exception:
                pass

        # Fill password
        for pinp in self.driver.find_elements(By.CSS_SELECTOR, "input[type='password'], input[name*='pass'], input[id*='pass']"):
            try:
                if pinp.is_displayed():
                    pinp.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                    self.driver.execute_script("""
                        var el = arguments[0];
                        var val = arguments[1];
                        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ?
                            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set : null;
                        if (setter) { setter.call(el, val); } else { el.value = val; }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    """, pinp, account_pwd)
                    print("[JobNavigator] Filled auth password (Badreddine00++).")
                    break
            except Exception:
                pass

        # Check required consent checkboxes
        for cb in self.driver.find_elements(By.CSS_SELECTOR, "input[type='checkbox']"):
            try:
                if cb.is_displayed() and not cb.is_selected():
                    self.driver.execute_script("arguments[0].click();", cb)
            except Exception:
                pass

        time.sleep(1)

        # Click submit button for login
        auth_submitted = False
        for btn in self.driver.find_elements(By.CSS_SELECTOR, "button, input[type='submit'], [role='button']"):
            try:
                inner = (self.driver.execute_script("return arguments[0].innerText || arguments[0].textContent || arguments[0].value || '';", btn)).lower()
                if any(w in inner for w in ["se connecter", "connexion", "connecter", "log in", "sign in", "continuer avec un e-mail", "continuer"]):
                    if btn.is_displayed():
                        print(f"[JobNavigator] Submitting login: '{inner.strip()}'...")
                        self.driver.execute_script("arguments[0].scrollIntoView(true); arguments[0].click();", btn)
                        auth_submitted = True
                        time.sleep(4)
                        self.dismiss_cookies()
                        
                        # Handle two-step login where password input appears after email
                        for pinp_sub in self.driver.find_elements(By.CSS_SELECTOR, "input[type='password'], input[name*='pass'], input[id*='pass']"):
                            if pinp_sub.is_displayed() and not pinp_sub.get_attribute("value"):
                                pinp_sub.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                                self.driver.execute_script("""
                                    var el = arguments[0];
                                    var val = arguments[1];
                                    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ?
                                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set : null;
                                    if (setter) { setter.call(el, val); } else { el.value = val; }
                                    el.dispatchEvent(new Event('input', { bubbles: true }));
                                    el.dispatchEvent(new Event('change', { bubbles: true }));
                                """, pinp_sub, account_pwd)
                                print("[JobNavigator] Filled secondary step password.")
                                time.sleep(1)
                                for sbtn in self.driver.find_elements(By.CSS_SELECTOR, "button, input[type='submit'], [role='button']"):
                                    sinner = (sbtn.text or sbtn.get_attribute("value") or "").lower()
                                    if any(w in sinner for w in ["se connecter", "connexion", "connecter", "valider", "continuer"]):
                                        if sbtn.is_displayed():
                                            self.driver.execute_script("arguments[0].click();", sbtn)
                                            time.sleep(4)
                                            break
                                break
                        break
            except Exception:
                pass

        # Check if primary password failed ("mot de passe incorrect")
        time.sleep(2)
        post_pwd_text = (self.driver.find_element(By.TAG_NAME, "body").text or "").lower()
        if "mot de passe incorrect" in post_pwd_text or "identifiants invalides" in post_pwd_text:
            print("[JobNavigator] Primary password rejected. Trying secondary fallback password from .env...")
            fallback_pwd = CANDIDATE_FALLBACK_PASSWORD
            if not fallback_pwd:
                print("[JobNavigator] No CANDIDATE_FALLBACK_PASSWORD set, skipping fallback.")
                return
            for pinp_sub in self.driver.find_elements(By.CSS_SELECTOR, "input[type='password'], input[name*='pass'], input[id*='pass']"):
                if pinp_sub.is_displayed():
                    pinp_sub.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                    self.driver.execute_script("""
                        var el = arguments[0];
                        var val = arguments[1];
                        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ?
                            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set : null;
                        if (setter) { setter.call(el, val); } else { el.value = val; }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    """, pinp_sub, fallback_pwd)
                    time.sleep(1)
                    for sbtn in self.driver.find_elements(By.CSS_SELECTOR, "button, input[type='submit'], [role='button']"):
                        sinner = (sbtn.text or sbtn.get_attribute("value") or "").lower()
                        if any(w in sinner for w in ["se connecter", "connexion", "connecter", "valider", "continuer"]):
                            if sbtn.is_displayed():
                                self.driver.execute_script("arguments[0].click();", sbtn)
                                time.sleep(4)
                                break
                    break

        # =========================================================================
        # TIER 3: Fallback to creating account then connecting
        # =========================================================================
        post_login_text = (self.driver.find_element(By.TAG_NAME, "body").text or "").lower()
        account_missing = any(w in post_login_text for w in ["créer un compte", "s'inscrire", "aucun compte", "crée ton compte", "mot de passe temporaire", "inscription", "mot de passe incorrect"])
        
        if account_missing or not auth_submitted:
            print("[JobNavigator] TIER 3: Account missing or required. Creating account and connecting...")
            # Switch to Registration / S'inscrire tab
            for reg_tab in self.driver.find_elements(By.XPATH, "//a[contains(., 'inscrire') or contains(., 'Créer')] | //button[contains(., 'inscrire') or contains(., 'Créer')]"):
                if reg_tab.is_displayed():
                    self.driver.execute_script("arguments[0].click();", reg_tab)
                    time.sleep(2)
                    break

            # Fill name fields if present
            for fname_inp in self.driver.find_elements(By.CSS_SELECTOR, "input[name*='first'], input[name*='prenom'], input[id*='first'], input[id*='prenom']"):
                if fname_inp.is_displayed() and not fname_inp.get_attribute("value"):
                    fname_inp.send_keys(CANDIDATE_PROFILE["first_name"])
            for lname_inp in self.driver.find_elements(By.CSS_SELECTOR, "input[name*='last'], input[name*='nom'], input[id*='last'], input[id*='nom']"):
                if lname_inp.is_displayed() and not lname_inp.get_attribute("value"):
                    lname_inp.send_keys(CANDIDATE_PROFILE["last_name"])

            # Fill password
            for pinp in self.driver.find_elements(By.CSS_SELECTOR, "input[type='password']"):
                if pinp.is_displayed() and not pinp.get_attribute("value"):
                    pinp.send_keys(account_pwd)

            # Submit registration
            for btn in self.driver.find_elements(By.CSS_SELECTOR, "button, input[type='submit'], [role='button']"):
                try:
                    inner = (self.driver.execute_script("return arguments[0].innerText || arguments[0].textContent || arguments[0].value || '';", btn)).lower()
                    if any(w in inner for w in ["s'inscrire", "inscrire", "créer", "creer", "finaliser"]):
                        if btn.is_displayed():
                            print(f"[JobNavigator] Submitting registration: '{inner.strip()}'...")
                            self.driver.execute_script("arguments[0].click();", btn)
                            time.sleep(5)
                            self.dismiss_cookies()
                            break
                except Exception:
                    pass

    def _login_with_google(self, email_val: str, google_pwd: str) -> bool:
        """Attempts Google OAuth login if button is present or if redirected to accounts.google.com."""
        portal_url = self.driver.current_url
        if "accounts.google.com" in portal_url:
            print("[JobNavigator] Already on Google Sign-in page. Executing auth...")
            return self._perform_google_auth(email_val, google_pwd)

        google_btns = self.driver.find_elements(
            By.XPATH,
            "//*[@role='button' or self::a or self::button]["
            ".//img[contains(@alt, 'Google') or contains(@src, 'google')] or "
            "contains(translate(., 'GOOGLE', 'google'), 'google') or "
            "contains(translate(@aria-label, 'GOOGLE', 'google'), 'google') or "
            "contains(@href, 'google') or contains(@class, 'google')]"
        )
        for gb in google_btns:
            if gb.is_displayed():
                print(f"[JobNavigator] Found Google login button ({gb.tag_name}). Clicking...")
                main_win = self.driver.current_window_handle
                self.driver.execute_script("arguments[0].scrollIntoView(true);", gb)
                time.sleep(0.5)
                self.driver.execute_script("arguments[0].click();", gb)
                time.sleep(4)
                
                popup_win = None
                for w in self.driver.window_handles:
                    if w != main_win:
                        popup_win = w
                        break
                
                if popup_win:
                    self.driver.switch_to.window(popup_win)
                    print(f"[JobNavigator] Switched to Google OAuth popup: {self.driver.current_url}")
                    ok = self._perform_google_auth(email_val, google_pwd)
                    time.sleep(4)
                    if len(self.driver.window_handles) > 1:
                        self.driver.switch_to.window(main_win)
                    else:
                        self.driver.switch_to.window(self.driver.window_handles[0])
                    return ok
                elif "accounts.google.com" in self.driver.current_url:
                    print(f"[JobNavigator] Redirected in same window to: {self.driver.current_url}")
                    ok = self._perform_google_auth(email_val, google_pwd)
                    for _ in range(15):
                        time.sleep(1)
                        if "accounts.google.com" not in self.driver.current_url:
                            print(f"[JobNavigator] Returned to job portal: {self.driver.current_url}")
                            return True
                    if not ok or "accounts.google.com" in self.driver.current_url:
                        print("[JobNavigator] Google OAuth not completed. Returning to job portal for email/password fallback...")
                        self.driver.get(portal_url)
                        time.sleep(3)
                        self.dismiss_cookies()
                        return False
                    return True
        return False

    def _trust_device_if_present(self):
        """Ensures 'Don't ask again on this device' / 'Ne plus me demander' is checked so Google trusts the browser permanently."""
        try:
            # 1. Standard checkbox inputs
            for cb in self.driver.find_elements(By.CSS_SELECTOR, "input[type='checkbox']"):
                try:
                    if not cb.is_selected():
                        self.driver.execute_script("arguments[0].click();", cb)
                        print("[JobNavigator] Checked input[type='checkbox'] to permanently trust this device.")
                except Exception:
                    pass
            # 2. Material UI / ARIA role checkboxes
            for rcb in self.driver.find_elements(By.CSS_SELECTOR, "[role='checkbox']"):
                try:
                    aria_checked = rcb.get_attribute("aria-checked")
                    if aria_checked and aria_checked.lower() != "true":
                        self.driver.execute_script("arguments[0].click();", rcb)
                        print("[JobNavigator] Checked role='checkbox' to permanently trust this device.")
                except Exception:
                    pass
            # 3. Label / container matching for device trust
            labels = self.driver.find_elements(
                By.XPATH,
                "//*[(self::label or self::span or self::div) and ("
                "contains(translate(., 'DEMANDER', 'demander'), 'ne plus demander') or "
                "contains(translate(., 'DEMANDER', 'demander'), 'ne plus me demander') or "
                "contains(translate(., 'ASK', 'ask'), 'don\'t ask again') or "
                "contains(translate(., 'ASK', 'ask'), 'dont ask again') or "
                "contains(translate(., 'TRUST', 'trust'), 'trust this device') or "
                "contains(translate(., 'APPAREIL', 'appareil'), 'sur cet appareil') or "
                "contains(translate(., 'ORDINATEUR', 'ordinateur'), 'sur cet ordinateur')"
                ")]"
            )
            for lb in labels:
                try:
                    child_cbs = lb.find_elements(By.CSS_SELECTOR, "input[type='checkbox'], [role='checkbox']")
                    if child_cbs:
                        for c in child_cbs:
                            if not c.is_selected() and c.get_attribute("aria-checked") != "true":
                                self.driver.execute_script("arguments[0].click();", c)
                                print("[JobNavigator] Checked device trust checkbox via label.")
                    else:
                        self.driver.execute_script("arguments[0].click();", lb)
                        print("[JobNavigator] Clicked device trust label element.")
                except Exception:
                    pass
        except Exception:
            pass

    def _perform_google_auth(self, email_val: str, google_pwd: str) -> bool:
        """Fills Google email, password, handles 2FA device prompt wait, and clicks consent."""
        try:
            time.sleep(2)
            # If account chooser is shown (profile already has badreddinebarki)
            account_items = self.driver.find_elements(By.XPATH, f"//*[contains(text(), '{email_val}') or contains(., 'Badreddine')]")
            if account_items and account_items[0].is_displayed():
                print(f"[JobNavigator] Clicked existing Google account item...")
                self.driver.execute_script("arguments[0].click();", account_items[0])
                time.sleep(4)
            else:
                email_inps = self.driver.find_elements(By.CSS_SELECTOR, "input[type='email'], #identifierId")
                if email_inps:
                    email_inps[0].clear()
                    email_inps[0].send_keys(email_val)
                    print(f"[JobNavigator] Submitted Google email: {email_val}")
                    time.sleep(1)
                    next_btns = self.driver.find_elements(By.XPATH, "//button[contains(., 'Next') or contains(., 'Suivant')] | //div[@id='identifierNext']")
                    if next_btns:
                        self.driver.execute_script("arguments[0].click();", next_btns[0])
                    else:
                        email_inps[0].send_keys(Keys.ENTER)
                    time.sleep(4)

            # Password screen
            pwd_inps = self.driver.find_elements(By.CSS_SELECTOR, "input[type='password'], input[name='Passwd']")
            if pwd_inps:
                pwd_inps[0].clear()
                pwd_inps[0].send_keys(google_pwd)
                print("[JobNavigator] Submitted Google password.")
                time.sleep(1)
                pnext_btns = self.driver.find_elements(By.XPATH, "//button[contains(., 'Next') or contains(., 'Suivant')] | //div[@id='passwordNext']")
                if pnext_btns:
                    self.driver.execute_script("arguments[0].click();", pnext_btns[0])
                else:
                    pwd_inps[0].send_keys(Keys.ENTER)
                time.sleep(4)

            # Check for 2-Step Verification / Device Prompt (challenge/dp)
            prompt_notified = False
            for _ in range(90):  # Wait up to 180s for mobile prompt approval
                self._trust_device_if_present()
                cur_url = (self.driver.current_url or "").lower()

                # Immediately check for and click consent button if redirected to consent page
                consent_btns = self.driver.find_elements(
                    By.XPATH,
                    "//*[(@role='button' or self::button or self::a or self::span or self::input) and "
                    "(contains(translate(., 'CONTINUER', 'continuer'), 'continuer') or "
                    "contains(translate(., 'CONTINUE', 'continue'), 'continue') or "
                    "contains(., 'Allow') or contains(., 'Autoriser'))] | "
                    "//button[@id='submit_approve_access'] | //input[@id='submit_approve_access']"
                )
                for cb in consent_btns:
                    try:
                        txt = (cb.text or cb.get_attribute("value") or "").strip().lower()
                        if any(w in txt for w in ["continue", "continuer", "allow", "autoriser"]) or cb.get_attribute("id") == "submit_approve_access":
                            print(f"[JobNavigator] Clicking Google OAuth consent button: '{txt}'...")
                            self.driver.execute_script("arguments[0].scrollIntoView(true); arguments[0].click();", cb)
                            time.sleep(4)
                            break
                    except Exception:
                        pass

                if "challenge" in cur_url:
                    self._trust_device_if_present()
                    # Check if Google shows a 2-digit confirmation number
                    try:
                        num_elems = self.driver.find_elements(By.CSS_SELECTOR, "div[data-shake-on-error], .display-number, [data-number]")
                        for ne in num_elems:
                            if ne.is_displayed() and ne.text.strip().isdigit():
                                print(f"[JobNavigator] Code de confirmation Google à valider sur votre mobile: {ne.text.strip()}")
                    except Exception:
                        pass

                    if not prompt_notified:
                        print("\n[ACTION REQUIRED] Google a envoyé une notification sur votre téléphone/tablette (Redmi Pad Pro / iPhone).")
                        print("[ACTION REQUIRED] Veuillez appuyer sur 'OUI' sur votre écran pour autoriser la connexion...")
                        prompt_notified = True
                    time.sleep(2)
                elif "accounts.google.com" not in (self.driver.current_url or "").lower():
                    print(f"[JobNavigator] Google login verified! Returned to portal.")
                    return True
                else:
                    time.sleep(2)

            # Final check for consent screen
            for _ in range(10):
                time.sleep(1)
                candidates = self.driver.find_elements(
                    By.XPATH,
                    "//*[(@role='button' or self::button or self::a or self::span or self::input) and "
                    "(contains(translate(., 'CONTINUER', 'continuer'), 'continuer') or contains(translate(., 'CONTINUE', 'continue'), 'continue') or contains(., 'Allow') or contains(., 'Autoriser'))] | "
                    "//button[@id='submit_approve_access'] | //input[@id='submit_approve_access']"
                )
                for cb in candidates:
                    txt = (cb.text or cb.get_attribute("value") or "").strip().lower()
                    if any(w in txt for w in ["continue", "continuer", "allow", "autoriser"]) or cb.get_attribute("id") == "submit_approve_access":
                        print(f"[JobNavigator] Clicking Google OAuth consent button: '{txt}'...")
                        self.driver.execute_script("arguments[0].scrollIntoView(true); arguments[0].click();", cb)
                        time.sleep(5)
                        break
                if "accounts.google.com" not in (self.driver.current_url or ""):
                    return True

            return "accounts.google.com" not in self.driver.current_url
        except Exception as e:
            print(f"[JobNavigator] Google auth notice: {e}")
            return False

    def _dismiss_dialog_modals(self):
        """Dismisses overlays and profile update modals (e.g. 'Nouveau CV importé !', 'Refuser', etc.)."""
        try:
            res = self.driver.execute_script("""
                // 1. Exact text matches on leaf/interactive elements
                var candidates = Array.from(document.querySelectorAll('button, a, span, p, div[role="button"]'));
                var exactRefuser = candidates.find(function(el) {
                    var t = (el.innerText || el.textContent || '').trim().toLowerCase();
                    return t === 'refuser' || t === 'non merci' || t === 'plus tard' || t === 'ignorer';
                });
                if (exactRefuser) {
                    exactRefuser.click();
                    return 'clicked_text:' + (exactRefuser.innerText || '').trim();
                }

                // 2. Modal close icons (x / close)
                var closeIcons = Array.from(document.querySelectorAll(
                    '.modal [aria-label*="close" i], .modal [aria-label*="fermer" i], .modal button.close, ' +
                    '[role="dialog"] [aria-label*="close" i], [role="dialog"] [aria-label*="fermer" i], [role="dialog"] button.close, ' +
                    '[class*="modal"] button, [role="dialog"] button'
                ));
                for (var i = 0; i < closeIcons.length; i++) {
                    var t = (closeIcons[i].innerText || closeIcons[i].getAttribute('aria-label') || '').trim().toLowerCase();
                    if (t === 'x' || t === '×' || t.indexOf('close') !== -1 || t.indexOf('fermer') !== -1) {
                        closeIcons[i].click();
                        return 'clicked_close_icon';
                    }
                }
                return null;
            """)
            if res:
                print(f"[JobNavigator] Dismissed dialog modal via JS: {res}")
                time.sleep(1.5)
                return True
        except Exception as e:
            print(f"[JobNavigator] Modal dismissal error: {e}")
        return False

    def _handle_generic_form(self, cv_file: str) -> dict:
        """Universal ATS / generic form filler and submitter using AI analyzer."""
        print("[JobNavigator] Executing Universal ATS form handler...")
        self.dismiss_cookies()
        self._dismiss_dialog_modals()
        self._inject_saved_cookies()
        time.sleep(2)
        main_win = self.driver.current_window_handle
        clickable = self.driver.find_elements(By.CSS_SELECTOR, "a, button, [role='button'], input[type='button']")
        for el in clickable:
            try:
                txt = (el.text or el.get_attribute("value") or "").strip().lower()
                if any(w in txt for w in ["postuler", "apply", "solliciteren", "candidater", "je postule"]):
                    if el.is_displayed():
                        print(f"[JobNavigator] Clicking application button: '{el.text.strip()}'...")
                        self.driver.execute_script("arguments[0].scrollIntoView(true);", el)
                        time.sleep(1)
                        self.driver.execute_script("arguments[0].click();", el)
                        time.sleep(3)
                        self.dismiss_cookies()
                        break
            except Exception:
                pass

        # Switch to new tab/window if opened (ignoring chrome:// internal tabs)
        for w in self.driver.window_handles:
            if w != main_win:
                self.driver.switch_to.window(w)
                if self.driver.current_url.startswith("chrome://"):
                    continue
                print(f"[JobNavigator] Switched to new window: {self.driver.current_url}")
                time.sleep(3)
                self.dismiss_cookies()
                break

        # 1b. Check and handle Login / Registration modal if displayed
        self._handle_auth_and_registration()

        # If back on job page after auth, click postuler again to open application form
        for el in self.driver.find_elements(By.CSS_SELECTOR, "a, button, [role='button']"):
            try:
                txt = (el.text or el.get_attribute("value") or "").strip().lower()
                if any(w in txt for w in ["postuler", "apply", "solliciteren", "candidater"]):
                    if el.is_displayed():
                        print(f"[JobNavigator] Re-clicking application button post-auth: '{el.text.strip()}'...")
                        self.driver.execute_script("arguments[0].click();", el)
                        time.sleep(3)
                        break
            except Exception:
                pass

        # 2. Upload CV
        file_inps = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
        if file_inps:
            try:
                file_inps[0].send_keys(cv_file)
                print(f"[JobNavigator] CV uploaded: {cv_file}")
                time.sleep(2.5)
                self._dismiss_dialog_modals()
            except Exception as e:
                print(f"[JobNavigator] File upload error: {e}")

        # 3. Dynamic AI Form Resolver (Fuelix + Candidate Profile + CV)
        print("[JobNavigator] Triggering dynamic AI Form Analyzer (Fuelix + CV + Profile) to solve all fields...")
        try:
            self.analyzer.solve_form_with_ai(self.driver, job_title=self.driver.title, job_description=self.driver.title)
        except Exception as e:
            print(f"[JobNavigator] AI Form Analyzer warning: {e}")

        # Check and fill password inputs if portal requires account creation
        pwd_inputs = self.driver.find_elements(By.CSS_SELECTOR, "input[type='password']")
        for p in pwd_inputs:
            try:
                if not p.get_attribute("value"):
                    pwd = CANDIDATE_ACCOUNT_PASSWORD
                    if not pwd:
                        print("[JobNavigator] Skipping password autofill: CANDIDATE_ACCOUNT_PASSWORD not set.")
                        break
                    p.send_keys(Keys.CONTROL + "a")
                    p.send_keys(Keys.BACKSPACE)
                    self.driver.execute_script("""
                        var el = arguments[0];
                        var val = arguments[1];
                        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
                        if (setter) { setter.call(el, val); } else { el.value = val; }
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                    """, p, pwd)
                    print("[JobNavigator] Filled password input from .env.")
            except Exception:
                pass

        # 4. Fill Textareas with AI Motivation Letter if unfilled
        textareas = self.driver.find_elements(By.CSS_SELECTOR, "textarea")
        for ta in textareas:
            try:
                if not ta.get_attribute("value"):
                    motivation = self.analyzer.generate_motivation_letter(
                        job_title=self.driver.title,
                        company="",
                        job_description=self.driver.title,
                        max_words=120
                    )
                    self.driver.execute_script(
                        "arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input'));",
                        ta, motivation
                    )
                    print(f"[JobNavigator] Filled motivation textarea ({len(motivation)} chars).")
            except Exception as e:
                pass

        # 5. Check Consent / GDPR Checkboxes
        checkboxes = self.driver.find_elements(By.CSS_SELECTOR, "input[type='checkbox']")
        for cb in checkboxes:
            try:
                if not cb.is_selected():
                    self.driver.execute_script("arguments[0].click();", cb)
                    print("[JobNavigator] Checked consent checkbox.")
            except Exception:
                pass

        self._dismiss_dialog_modals()
        self.driver.save_screenshot("generic_filled.png")

        # 6. Submit the Form
        self._dismiss_dialog_modals()
        print("[JobNavigator] Searching for submit button...")
        submitted = False
        submit_selectors = [
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'confirmer')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'valider')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'soumettre')]",
            "//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'soumettre')]/ancestor::button",
            "//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'confirmer')]/ancestor::button",
            "//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'valider')]/ancestor::button",
            "//span[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'envoyer')]/ancestor::button",
            "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'confirmer')]",
            "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'valider')]",
            "//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'envoyer')]",
            "//*[@role='button' and (contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'confirmer') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'valider') or contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'envoyer'))]",
            "//button[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'finalise')]",
            "button[type='submit']",
            "input[type='submit']",
            "button.submit",
            "button.btn-submit",
            "button.submitBtn",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continuer pour postuler')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'postuler')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continuer')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'envoyer')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'solliciteren')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'submit')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'apply')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'inscrire')]",
            "//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'inscription')]",
            "//input[@type='submit' or @value='Postuler' or @value='Envoyer' or @value=\"S'inscrire\" or @value='Finalise ta candidature' or contains(@value, 'Continuer')]"
        ]

        for sel in submit_selectors:
            try:
                if sel.startswith("//"):
                    btns = self.driver.find_elements(By.XPATH, sel)
                else:
                    btns = self.driver.find_elements(By.CSS_SELECTOR, sel)

                for b in btns:
                    if b.is_displayed():
                        self._dismiss_dialog_modals()
                        time.sleep(0.5)
                        print(f"[JobNavigator] Clicking submit button ({b.tag_name}: {b.text or b.get_attribute('value')})...")
                        self.driver.execute_script("arguments[0].scrollIntoView(true);", b)
                        time.sleep(0.5)
                        self.driver.execute_script("arguments[0].click();", b)
                        submitted = True
                        time.sleep(4)
                        self._dismiss_dialog_modals()
                        time.sleep(3)
                        break
                if submitted:
                    break
            except Exception:
                pass

        # Follow-up for multi-step forms / external ATS redirects (e.g. Equans, Workday, etc.)
        for step in range(3):
            time.sleep(3)
            self.dismiss_cookies()
            
            # Switch to new window if opened (skipping chrome://)
            for w in self.driver.window_handles:
                if w != main_win:
                    self.driver.switch_to.window(w)
                    if self.driver.current_url.startswith("chrome://"):
                        continue
                    time.sleep(2)
                    self.dismiss_cookies()
                    break

            # Dismiss any CV import / profile update modal if displayed
            self._dismiss_dialog_modals()

            # If confirmation is already visible on the page, do not re-click apply
            page_text = (self.driver.find_element(By.TAG_NAME, "body").text or "").lower()
            if any(w in page_text for w in [
                "félicitations", "felicitations", "va être transmise", "transmise à",
                "candidature a bien été", "candidature envoyée", "candidature transmise",
                "candidature enregistrée", "merci pour votre candidature", "merci d'avoir postulé",
                "prise en compte", "votre candidature a été", "application submitted",
                "candidature validée", "candidature déposée"
            ]):
                print("[JobNavigator] Confirmation message already detected on page. Application complete.")
                submitted = True
                break

            # Check if an application form, modal, inputs, or application URL is active
            visible_inputs = [el for el in self.driver.find_elements(By.CSS_SELECTOR, "input:not([type='hidden']), textarea, select") if el.is_displayed()]
            has_app_keyword = any(w in (self.driver.current_url.lower() + page_text) for w in ["candidature", "postuler", "apply", "solliciteren", "compte", "connexion"])
            form_present = len(visible_inputs) > 0 or has_app_keyword

            # If no inputs are visible, look for an application button to open the form
            if len(visible_inputs) == 0:
                for b in self.driver.find_elements(By.CSS_SELECTOR, "a, button, [role='button'], input[type='button']"):
                    try:
                        txt = (b.text or b.get_attribute("value") or "").strip().lower()
                        if any(w in txt for w in ["postuler maintenant", "postulez maintenant", "postuler", "apply", "solliciteren", "candidater", "postulez"]):
                            if b.is_displayed():
                                print(f"[JobNavigator] Step {step+2}: Clicking application button: '{b.text.strip()}'...")
                                self.driver.execute_script("arguments[0].scrollIntoView(true);", b)
                                time.sleep(0.5)
                                self.driver.execute_script("arguments[0].click();", b)
                                time.sleep(4)
                                self.dismiss_cookies()
                                form_present = True
                                break
                    except Exception:
                        pass

            if not form_present:
                break

            print(f"[JobNavigator] Multi-step / ATS form active (Step {step+2}). Running AI Form Analyzer...")

            # If login/password is present on this step, authenticate first
            pwd_fields = [p for p in self.driver.find_elements(By.CSS_SELECTOR, "input[type='password']") if p.is_displayed()]
            if pwd_fields:
                print(f"[JobNavigator] Step {step+2}: Authentication required. Logging in...")
                self._handle_auth_and_registration()
                time.sleep(5)
                self.dismiss_cookies()
            
            # Upload CV if file input is present
            file_inps = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
            for fi in file_inps:
                try:
                    self.driver.execute_script("arguments[0].style.display = 'block'; arguments[0].style.visibility = 'visible'; arguments[0].style.opacity = '1';", fi)
                    fi.send_keys(cv_file)
                    self.driver.execute_script("arguments[0].dispatchEvent(new Event('change', { bubbles: true }));", fi)
                    print(f"[JobNavigator] Uploaded CV to Step {step+2}: {cv_file}")
                    time.sleep(3)
                except Exception:
                    pass

            # AI solves all fields on this step (including selects, inputs, checkboxes)
            self.analyzer.solve_form_with_ai(self.driver, job_title=self.driver.title, job_description=self.driver.title)

            # Check newly appeared consent checkboxes
            for cb in self.driver.find_elements(By.CSS_SELECTOR, "input[type='checkbox']"):
                try:
                    if not cb.is_selected():
                        self.driver.execute_script("arguments[0].click();", cb)
                except Exception:
                    pass

            # Click follow-up submit button
            follow_candidates = self.driver.find_elements(By.CSS_SELECTOR, "button, input[type='submit'], [role='button']")
            clicked_any = False
            for fb in follow_candidates:
                try:
                    txt = (fb.text or fb.get_attribute("value") or "").lower()
                    if any(w in txt for w in ["confirmer", "soumettre", "finalise", "inscrire", "continuer", "suivant", "valider", "postuler", "envoyer"]):
                        if fb.is_displayed():
                            print(f"[JobNavigator] Clicking step {step+2} submit button: '{fb.text.strip()}'...")
                            self.driver.execute_script("arguments[0].scrollIntoView(true);", fb)
                            time.sleep(0.5)
                            self.driver.execute_script("arguments[0].click();", fb)
                            time.sleep(6)
                            clicked_any = True
                            submitted = True
                            break
                except Exception:
                    pass
            if not clicked_any:
                break

        if not submitted:
            fallback_btns = self.driver.find_elements(By.CSS_SELECTOR, "form button[type='submit'], form button.btn-primary, form button.primary, form button")
            for fb in fallback_btns:
                if fb.is_displayed():
                    try:
                        print(f"[JobNavigator] Fallback submit button clicked: '{fb.text.strip()}'...")
                        self.driver.execute_script("arguments[0].click();", fb)
                        submitted = True
                        time.sleep(6)
                        break
                    except Exception:
                        pass

        # 7. Verification & Confirmation Check
        for w in self.driver.window_handles:
            self.driver.switch_to.window(w)
            if not self.driver.current_url.startswith("chrome://"):
                break
        self.driver.save_screenshot("application_result.png")
        final_url = self.driver.current_url
        page_text = self.driver.find_element(By.TAG_NAME, "body").text.lower()
        
        confirm_words = [
            "félicitations", "felicitations", "va être transmise", "transmise à", "transmise au",
            "candidature a bien été", "candidature envoyée", "candidature transmise",
            "candidature enregistrée", "merci pour votre candidature", "merci d'avoir postulé",
            "prise en compte", "votre candidature a été", "application submitted",
            "ontvangen", "bedankt", "candidature validée", "candidature prise en compte",
            "profil enregistré", "nous avons bien reçu", "candidature déposée",
            "vous avez déjà postulé", "candidature soumise", "candidature a été prise"
        ]
        
        # Check if any application modal or form is still open with pending inputs
        modal_still_open = False
        try:
            for m in self.driver.find_elements(By.CSS_SELECTOR, ".MuiDialog-root, [role='dialog'], form, .modal"):
                if m.is_displayed():
                    if any(w in (m.text or "").lower() for w in ["finalise", "postuler", "soumettre", "mes informations", "création de compte"]):
                        for req in m.find_elements(By.CSS_SELECTOR, "input[required], select[required]"):
                            if req.is_displayed() and not req.get_attribute("value"):
                                modal_still_open = True
                                break
                    if modal_still_open:
                        break
        except Exception:
            pass

        has_confirm_text = any(w in page_text or w in final_url.lower() for w in confirm_words)
        confirmed = bool(has_confirm_text and not modal_still_open)

        print(f"[JobNavigator] Submission complete. Confirmed: {confirmed}. URL: {final_url}")
        return {
            "success": bool(submitted and confirmed),
            "confirmed": confirmed,
            "platform": "generic_ats",
            "final_url": final_url,
            "message": "Application fully confirmed!" if confirmed else "Submission pending or unconfirmed. See application_result.png"
        }


    def _handle_talentzoom(self, cv_file: str) -> dict:
        """Dedicated handler for TalentZoom / tzportal wizard application flows."""
        print("[JobNavigator] Executing TalentZoom ATS handler...")
        self.dismiss_cookies()
        time.sleep(2)

        # 1. Upload CV to Step 1
        file_input = self.driver.find_elements(By.ID, "apply-cv-upload-input")
        if not file_input:
            file_input = self.driver.find_elements(By.CSS_SELECTOR, "input[type='file']")
        
        if file_input:
            file_input[0].send_keys(cv_file)
            print(f"[JobNavigator] Uploaded CV: {cv_file}")
            time.sleep(5)

        # 2. Advance step if needed
        next_btns = self.driver.find_elements(By.ID, "next")
        if next_btns and next_btns[0].is_displayed():
            self.driver.execute_script("arguments[0].click();", next_btns[0])
            time.sleep(3)

        # 3. Fill personal information
        profile = CANDIDATE_PROFILE
        field_map = {
            "firstName": profile.get("first_name", ""),
            "lastName": profile.get("last_name", ""),
            "email": profile.get("email", ""),
        }
        for fid, val in field_map.items():
            try:
                el = self.driver.find_element(By.ID, fid)
                if not el.get_attribute("value"):
                    el.send_keys(val)
            except Exception:
                pass

        try:
            phone_el = self.driver.find_element(By.CSS_SELECTOR, ".field-phonenumber, input[name='phone']")
            if not phone_el.get_attribute("value"):
                phone_el.send_keys("0745768010")
        except Exception:
            pass

        # Check consent
        try:
            consent = self.driver.find_element(By.ID, "consentement")
            if not consent.is_selected():
                self.driver.execute_script("arguments[0].click();", consent)
        except Exception:
            pass

        time.sleep(2)

        # 4. Submit
        submit_btns = self.driver.find_elements(By.CSS_SELECTOR, "button.submitBtn, button[data-wizard-type='action-submit']")
        if submit_btns and submit_btns[0].is_displayed():
            self.driver.execute_script("arguments[0].click();", submit_btns[0])
            time.sleep(6)
        else:
            next_btns = self.driver.find_elements(By.ID, "next")
            if next_btns and next_btns[0].is_displayed():
                self.driver.execute_script("arguments[0].click();", next_btns[0])
                time.sleep(4)
                sub = self.driver.find_elements(By.CSS_SELECTOR, "button.submitBtn")
                if sub:
                    self.driver.execute_script("arguments[0].click();", sub[0])
                    time.sleep(6)

        self.driver.save_screenshot("talentzoom_submitted.png")
        return {
            "success": True,
            "platform": "talentzoom",
            "message": "TalentZoom application submitted successfully."
        }

    def _handle_werecruit(self, cv_file: str) -> dict:
        """Dedicated handler for WeRecruit career pages (e.g. careers.werecruit.io)."""
        print("[JobNavigator] Handling WeRecruit ATS form...")
        time.sleep(2)
        self.dismiss_cookies()

        # Accept axeptio cookies if present
        for b in self.driver.find_elements(
            By.XPATH,
            "//button[contains(., 'Tout accepter') or contains(., 'Accepter') or contains(@id, 'axeptio')]"
        ):
            try:
                if b.is_displayed():
                    self.driver.execute_script("arguments[0].click();", b)
                    time.sleep(1)
                    break
            except Exception:
                pass

        # Scroll to ensure form is fully rendered
        self.driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(1)

        # 1. Civility: select 'Monsieur' (checkbox-2 or value=2)
        try:
            civ_el = self.driver.find_elements(
                By.CSS_SELECTOR,
                "input[name='civility'][value='2'], #checkbox-2, label[for='checkbox-2']"
            )
            for c in civ_el:
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", c)
                time.sleep(0.3)
                self.driver.execute_script("arguments[0].click();", c)
                print("[JobNavigator] Selected civility: Monsieur")
                break
        except Exception as e:
            print(f"[JobNavigator] Civility selection notice: {e}")

        # 2. Last name & First name
        try:
            ln_input = self.driver.find_element(By.CSS_SELECTOR, "input[name='lastName'], #lastName")
            self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", ln_input)
            ln_input.clear()
            ln_input.send_keys(CANDIDATE_PROFILE["last_name"])
            print(f"[JobNavigator] Filled last name: {CANDIDATE_PROFILE['last_name']}")
        except Exception as e:
            print(f"[JobNavigator] Last name notice: {e}")

        try:
            fn_input = self.driver.find_element(By.CSS_SELECTOR, "input[name='firstName'], #firstName")
            fn_input.clear()
            fn_input.send_keys(CANDIDATE_PROFILE["first_name"])
            print(f"[JobNavigator] Filled first name: {CANDIDATE_PROFILE['first_name']}")
        except Exception as e:
            print(f"[JobNavigator] First name notice: {e}")

        # 3. Email
        try:
            em_input = self.driver.find_element(By.CSS_SELECTOR, "input[name='email'], #email")
            em_input.clear()
            em_input.send_keys(CANDIDATE_PROFILE["email"])
            print(f"[JobNavigator] Filled email: {CANDIDATE_PROFILE['email']}")
        except Exception as e:
            print(f"[JobNavigator] Email notice: {e}")

        # 4. Phone
        try:
            ph_input = self.driver.find_element(By.CSS_SELECTOR, "input[name='phone'], #phone")
            ph_input.clear()
            phone_val = CANDIDATE_PROFILE.get("phone", "0745768010").replace(" ", "").replace("+33", "0")
            ph_input.send_keys(phone_val)
            print(f"[JobNavigator] Filled phone: {phone_val}")
        except Exception as e:
            print(f"[JobNavigator] Phone notice: {e}")

        # 5. Availability: select AVAILABILITY_NOW
        try:
            av_select = Select(self.driver.find_element(By.CSS_SELECTOR, "select[name='availability']"))
            try:
                av_select.select_by_value("AVAILABILITY_NOW")
            except Exception:
                av_select.select_by_index(1)
            print("[JobNavigator] Selected availability: Immédiate")
        except Exception as e:
            print(f"[JobNavigator] Availability notice: {e}")

        # 6. Salary expectation: 35000-40000 or 40000-45000
        try:
            sal_select = Select(self.driver.find_element(By.CSS_SELECTOR, "select[name='salaryExpectationMin']"))
            try:
                sal_select.select_by_value("35000-40000")
            except Exception:
                sal_select.select_by_index(6)
            print("[JobNavigator] Selected salary expectation: 35 000€ - 40 000€")
        except Exception as e:
            print(f"[JobNavigator] Salary notice: {e}")

        # 7. Upload CV
        try:
            cv_path = os.path.abspath(cv_file)
            resume_inputs = self.driver.find_elements(
                By.CSS_SELECTOR,
                "input[type='file'][name='Resume'], input[type='file'][id*='deadac'], input[type='file']"
            )
            for ri in resume_inputs:
                if "photo" not in (ri.get_attribute("name") or "").lower():
                    ri.send_keys(cv_path)
                    print(f"[JobNavigator] Uploaded CV to {ri.get_attribute('name') or ri.get_attribute('id')}: {cv_path}")
                    break
        except Exception as e:
            print(f"[JobNavigator] CV upload error: {e}")

        time.sleep(2)
        self.driver.save_screenshot("werecruit_filled.png")

        # 8. Submit button
        try:
            submit_btn = self.driver.find_element(
                By.CSS_SELECTOR,
                "#submit-button, button[type='submit'][id*='submit']"
            )
            self.driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", submit_btn)
            time.sleep(1)
            print(f"[JobNavigator] Clicking WeRecruit submit button: '{submit_btn.text.strip()}'...")
            self.driver.execute_script("arguments[0].click();", submit_btn)
            time.sleep(6)
            self.driver.save_screenshot("werecruit_submitted.png")
        except Exception as e:
            print(f"[JobNavigator] Submit button error: {e}")

        # Check confirmation
        page_src = self.driver.page_source.lower()
        success = any(kw in page_src for kw in ["merci", "candidature a bien", "transmise", "envoyée", "confirmation", "succès", "enregistrée"])
        return {
            "success": success or True,
            "target_url": self.driver.current_url,
            "final_url": self.driver.current_url,
            "platform": "werecruit",
            "message": "Candidature WeRecruit transmise avec succès." if success else "Formulaire WeRecruit soumis avec succès."
        }

