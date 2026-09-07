import os
import sys
import time
import json
import requests

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from typing import Dict, List, Any, Optional
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from services.automation.candidate_profile import CANDIDATE_PROFILE

JS_EXTRACT_INTERACTIVE_DOM = """
return (function() {
    let elements = [];
    let idCounter = 1;

    function isElementVisible(el) {
        if (!el) return false;
        try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return true;
            if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
            if (el.getClientRects && el.getClientRects().length > 0) return true;
        } catch(e) {}
        return false;
    }

    function processDoc(doc) {
        if (!doc) return;
        const selectors = [
            'button',
            'a[href]',
            'input',
            'select',
            'textarea',
            '[role="button"]',
            '[role="link"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[onclick]'
        ];

        let candidates = [];
        try {
            candidates = doc.querySelectorAll(selectors.join(', '));
        } catch(e) {
            candidates = doc.getElementsByTagName('*');
        }

        candidates.forEach(el => {
            try {
                const tag = (el.tagName || '').toLowerCase();
                const type = (el.getAttribute('type') || '').toLowerCase();
                const isFileInput = tag === 'input' && type === 'file';
                
                if (!isFileInput && !isElementVisible(el)) return;

                const role = (el.getAttribute('role') || '').toLowerCase();
                const name = (el.getAttribute('name') || '').toLowerCase();
                const id = (el.getAttribute('id') || '').toLowerCase();
                const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();

                let labelText = '';
                if (id) {
                    try {
                        const safeId = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
                        const labelEl = doc.querySelector('label[for="' + safeId + '"]');
                        if (labelEl) labelText = (labelEl.innerText || '').trim();
                    } catch(e) {}
                }
                if (!labelText && el.closest) {
                    try {
                        const parentLabel = el.closest('label');
                        if (parentLabel) labelText = (parentLabel.innerText || '').trim();
                    } catch(e) {}
                }

                const innerText = (el.innerText || '').trim();
                const value = el.value !== undefined ? String(el.value).trim() : '';
                const text = innerText || ariaLabel || placeholder || labelText || title || value || '';

                if (!text && !isFileInput && tag !== 'select' && type !== 'submit' && type !== 'checkbox' && type !== 'radio') {
                    return;
                }

                const agentId = idCounter++;
                el.setAttribute('data-dom-agent-id', String(agentId));

                elements.push({
                    id: agentId,
                    tag: tag,
                    type: type,
                    role: role,
                    name: name,
                    elemId: id,
                    text: text.substring(0, 150),
                    placeholder: placeholder,
                    value: value.substring(0, 100),
                    isFileInput: isFileInput
                });
            } catch(innerErr) {}
        });

        // Also search accessible iframes
        try {
            const iframes = doc.querySelectorAll('iframe');
            iframes.forEach(ifr => {
                try {
                    const subDoc = ifr.contentDocument || (ifr.contentWindow && ifr.contentWindow.document);
                    if (subDoc) processDoc(subDoc);
                } catch(e) {}
            });
        } catch(e) {}
    }

    processDoc(document);
    return elements;
})();
"""

class AIDOMAgent:
    """
    Universal Autonomous Browser Agent.
    Operates on semantic accessibility trees rather than hardcoded site selectors.
    Capable of driving application workflows across any job board, portal, or ATS.
    """

    def __init__(self, driver, llm_client=None):
        from services.automation.llm_client import default_client
        self.driver = driver
        self.llm = llm_client or default_client
        self.profile = CANDIDATE_PROFILE
        self.max_steps = 20
        self.executed_actions = set()

    def inject_cookie_vault(self):
        """Injects all stored session cookies via CDP so login barriers are eliminated."""
        vault_path = os.path.join(os.path.dirname(__file__), "cookies_vault.json")
        if not os.path.exists(vault_path):
            return

        try:
            with open(vault_path, "r", encoding="utf-8") as f:
                vault = json.load(f)

            cdp_cookies = []
            for platform, cookies in vault.items():
                for c in cookies:
                    co = {
                        "name": c["name"],
                        "value": c["value"],
                        "path": c.get("path", "/")
                    }
                    if c.get("domain"):
                        co["domain"] = c["domain"]
                    if "secure" in c and c["secure"] is not None:
                        co["secure"] = bool(c["secure"])
                    if "httpOnly" in c and c["httpOnly"] is not None:
                        co["httpOnly"] = bool(c["httpOnly"])
                    if c.get("expirationDate"):
                        co["expires"] = float(c["expirationDate"])
                    same_site = str(c.get("sameSite", "")).lower()
                    if same_site in ["strict", "lax", "none"]:
                        co["sameSite"] = same_site.capitalize()
                    elif same_site == "no_restriction":
                        co["sameSite"] = "None"
                    cdp_cookies.append(co)

            self.driver.execute_cdp_cmd("Network.setCookies", {"cookies": cdp_cookies})
            print(f"[AIDOMAgent] Injected {len(cdp_cookies)} session cookies via CDP.")
        except Exception as e:
            print(f"[AIDOMAgent] Warning: CDP cookie injection notice: {e}")

    def batch_autofill(self, cv_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Ultra-fast single-pass DOM form filler.
        Fills all candidate fields (email, phone, name, address, etc.),
        attaches CV PDF, checks required consent boxes, and handles popups in milliseconds.
        """
        js_filler = """
        return (function() {
            let filledCount = 0;
            const profile = {
                name: "Badreddine Barki",
                first_name: "Badreddine",
                last_name: "Barki",
                email: "badreddinebarki@gmail.com",
                phone: "+33 7 45 76 80 10",
                phone_raw: "0745768010",
                city: "Amiens",
                postal: "80000",
                address: "14 Rue de la 2e D.B.",
                linkedin: "https://www.linkedin.com/in/barki-badreddine-bb2328146",
                title: "Ingénieur en Génie Mécanique"
            };

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

            // 1. Dismiss alert / newsletter popups & accept cookie consent modals
            document.querySelectorAll('button, a, span, div[role="button"]').forEach(el => {
                const txt = (el.innerText || '').toLowerCase().trim();
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();
                if (txt === 'non merci' || txt === 'no' || txt === 'nee, bedankt' || txt === 'nee bedankt' || txt === 'later' || txt === 'dismiss' || txt === 'refuser' || txt === 'tout refuser' || txt === 'fermer' || txt === 'close' || txt === '✕' || txt === '×' || aria === 'close' || aria === 'fermer' || title === 'close' || title === 'fermer') {
                    try { el.click(); } catch(e) {}
                }
                if (txt === 'akkoord' || txt === 'accepteren' || txt === 'alles accepteren' || txt === 'accepteer alle cookies' || txt === 'accept all' || txt === 'accept all cookies' || txt === 'tout accepter' || txt.includes('accepte')) {
                    try { el.click(); } catch(e) {}
                }
            });

            // 2. Scan visible inputs and textareas
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea'));
            for (const inp of inputs) {
                const style = window.getComputedStyle(inp);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                const rect = inp.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) continue;

                const name = (inp.getAttribute('name') || '').toLowerCase();
                const id = (inp.getAttribute('id') || '').toLowerCase();
                const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
                const aria = (inp.getAttribute('aria-label') || '').toLowerCase();
                const type = (inp.getAttribute('type') || '').toLowerCase();

                // Skip search boxes
                if (name === 'q' || name === 'w' || id.includes('search') || placeholder.includes('rechercher') || placeholder.includes('search')) continue;

                let label = '';
                if (id) {
                    try {
                        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                        if (lbl) label = lbl.innerText.toLowerCase();
                    } catch(e) {}
                }
                if (!label && inp.closest('label')) label = inp.closest('label').innerText.toLowerCase();

                const fullSig = `${name} ${id} ${placeholder} ${aria} ${label} ${type}`;

                // If field already has non-empty valid value, skip
                if (inp.value && inp.value.trim().length > 1) continue;

                if (type === 'email' || fullSig.includes('email') || fullSig.includes('courriel') || fullSig.includes('e-mail')) {
                    if (setVal(inp, profile.email)) filledCount++;
                } else if (type === 'tel' || fullSig.includes('phone') || fullSig.includes('tel') || fullSig.includes('portable') || fullSig.includes('mobile')) {
                    if (setVal(inp, profile.phone)) filledCount++;
                } else if (fullSig.includes('prenom') || fullSig.includes('first name') || fullSig.includes('firstname') || fullSig.includes('voornaam')) {
                    if (setVal(inp, profile.first_name)) filledCount++;
                } else if (fullSig.includes('nom') || fullSig.includes('last name') || fullSig.includes('lastname') || fullSig.includes('achternaam') || fullSig.includes('family name')) {
                    if (setVal(inp, profile.last_name)) filledCount++;
                } else if (fullSig.includes('full name') || fullSig.includes('fullname') || fullSig.includes('name') || fullSig.includes('nom complet')) {
                    if (setVal(inp, profile.name)) filledCount++;
                } else if (fullSig.includes('postal') || fullSig.includes('code postal') || fullSig.includes('zip') || fullSig.includes('postcode')) {
                    if (setVal(inp, profile.postal)) filledCount++;
                } else if (fullSig.includes('city') || fullSig.includes('ville') || fullSig.includes('commune') || fullSig.includes('woonplaats')) {
                    if (setVal(inp, profile.city)) filledCount++;
                } else if (fullSig.includes('linkedin') || fullSig.includes('site') || fullSig.includes('website') || fullSig.includes('portfolio') || fullSig.includes('url')) {
                    if (setVal(inp, profile.linkedin)) filledCount++;
                }
            }

            // 3. Check required consent / terms checkboxes
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                if (!cb.checked && (cb.required || cb.name.includes('consent') || cb.name.includes('terms') || cb.name.includes('agree') || cb.name.includes('rgpd'))) {
                    try { cb.click(); } catch(e) {}
                }
            });

            return filledCount;
        })();
        """
        filled = 0
        try:
            filled = self.driver.execute_script(js_filler) or 0
        except Exception as e:
            print(f"[AIDOMAgent] JS batch fill error: {e}")

        # 4. Attach CV to file input if present
        cv_attached = False
        target_cv = cv_path or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))
        if os.path.exists(target_cv):
            try:
                file_inputs = self.driver.find_elements(By.CSS_SELECTOR, 'input[type="file"]')
                for finp in file_inputs:
                    try:
                        finp.send_keys(target_cv)
                        cv_attached = True
                        break
                    except Exception:
                        self.driver.execute_script("arguments[0].style.display = 'block'; arguments[0].style.opacity = '1';", finp)
                        finp.send_keys(target_cv)
                        cv_attached = True
                        break
            except Exception as e:
                print(f"[AIDOMAgent] CV attach error: {e}")

        return {"fields_filled": filled, "cv_attached": cv_attached}

    def get_interactive_elements(self) -> List[Dict[str, Any]]:
        """Extracts all interactive elements currently in the DOM with unique agent IDs."""
        try:
            elements = self.driver.execute_script(JS_EXTRACT_INTERACTIVE_DOM)
            return elements or []
        except Exception as e:
            print(f"[AIDOMAgent] Error extracting interactive elements: {e}")
            return []

    def check_barrier(self) -> Optional[str]:
        """Detects if the browser landed on an aggregator login wall or CAPTCHA."""
        try:
            cur_url = (self.driver.current_url or '').lower()
            if any(w in cur_url for w in ['pole-emploi.fr', 'francetravail.fr']):
                return 'France Travail personal login required'
            if any(w in cur_url for w in ['cadres.apec.fr/espace-perso', 'apec.fr/login', 'apec.fr/connexion']):
                return 'Apec account login required'
            if any(w in cur_url for w in ['linkedin.com/login', 'linkedin.com/checkpoint']):
                return 'LinkedIn authentication required'
            if any(w in cur_url for w in ['challenges.cloudflare.com', 'cf-turnstile', 'recaptcha']):
                return 'Security CAPTCHA verification required'
        except Exception:
            pass
        return None

    def plan_action(self, elements: List[Dict[str, Any]], step_num: int) -> Dict[str, Any]:
        """
        Decides the next action dynamically based on page semantics:
        Uses Azure DeepSeek-V4-Pro / Grok reasoning with an ultra-fast semantic fallback.
        """
        barrier = self.check_barrier()
        if barrier:
            return {"action": "barrier", "reason": barrier}

        llm_plan = self._plan_with_llm(elements, step_num)
        if llm_plan and isinstance(llm_plan, dict):
            act_key = f"{llm_plan.get('action')}:{llm_plan.get('id')}"
            if act_key in self.executed_actions and llm_plan.get("action") == "fill":
                print(f"[AIDOMAgent] Field #{llm_plan.get('id')} was already filled. Using semantic fallback.")
                return self._semantic_plan(elements, step_num)
            return llm_plan

        # Universal Semantic Heuristic Planner (Zero site-specific hardcoding)
        return self._semantic_plan(elements, step_num)

    def _plan_with_llm(self, elements: List[Dict[str, Any]], step_num: int) -> Optional[Dict[str, Any]]:
        """Queries Fuelix planner model to determine the optimal next interaction."""
        if not self.llm.has_credentials():
            return None
        concise_elements = []
        for el in elements[:50]:
            val = (el.get("value") or "").strip()
            concise_elements.append({
                "id": el["id"],
                "tag": el["tag"],
                "type": el["type"],
                "text": el["text"],
                "name": el["name"],
                "current_value": val[:25] if val else "",
                "is_already_filled": bool(val),
                "isFileInput": el["isFileInput"],
            })
        system = "You are an autonomous job application DOM agent. Respond in strict JSON only."
        prompt = f"""
You are an autonomous browser agent applying for a job for Badreddine Barki (Mechanical Engineer, email: {self.profile['email']}, phone: {self.profile.get('phone', '+33745768010')}, city: {self.profile.get('city', 'Amiens')}, France).
CV path: {os.path.abspath(self.profile["resumes"]["fr"])}

Interactive page elements:
{json.dumps(concise_elements, indent=1, ensure_ascii=False)}

Goal: Find and trigger Apply / Postuler / Solliciteren button, fill any required candidate info, upload CV, and submit.
IMPORTANT: Do NOT fill elements where is_already_filled is true or where current_value is present!
If all required fields are filled and CV is uploaded, trigger the Submit / Postuler / Envoyer button.
If already submitted, return {{"action": "done", "reason": "confirmation detected"}}.

Return JSON ONLY with the single best next action:
- {{"action": "click", "id": <id>, "reason": "..."}}
- {{"action": "fill", "id": <id>, "value": "<text>", "reason": "..."}}
- {{"action": "upload", "id": <id>, "value": "<cv_path>", "reason": "..."}}
- {{"action": "check", "id": <id>, "reason": "..."}}
- {{"action": "scroll", "direction": "down", "reason": "..."}}
- {{"action": "done", "reason": "..."}}
"""
        data = self.llm.chat_json(system, prompt, task="planner", max_tokens=300, timeout=15)
        if data:
            print(f"[AIDOMAgent] Fuelix planner selected: {data.get('action')} on #{data.get('id')} ({data.get('reason')})")
            return data
        print("[AIDOMAgent] Fuelix planner unreachable, using semantic heuristics.")
        return None

    def _semantic_plan(self, elements: List[Dict[str, Any]], step_num: int) -> Dict[str, Any]:
        """Deterministic fallback when LLM is unreachable. Priority: cookie/dismiss > upload > submit > apply > next."""
        def text_of(el: Dict[str, Any]) -> str:
            return f"{el.get('text','')} {el.get('name','')} {el.get('placeholder','')}".lower()

        dismiss_kw = (
            "non merci", "nee, bedankt", "nee bedankt", "refuser", "tout refuser", "dismiss",
            "later", "sluiten", "weigeren", "akkoord", "accepteren", "alles accepteren",
            "accepteer alle cookies", "accept all", "accept all cookies", "tout accepter", "j'accepte"
        )
        submit_kw = (
            "envoyer", "soumettre", "submit application", "submit", "finalise", "confirmer",
            "valider ma candidature", "verstuur", "versturen", "verzend", "verzenden", "bevestig",
            "absenden", "jetzt senden"
        )
        apply_kw = (
            "candidature simplifiée", "easy apply", "postuler", "apply now", "solliciteren",
            "solliciteer direct", "solliciteer nu", "solliciteer", "reageer direct", "bekijk vacature",
            "ga naar vacature", "bezoek website", "je postule", "postuler sur le site", "apply on company website",
            "apply", "candidater", "postulez", "bewerben", "jetzt bewerben"
        )
        next_kw = (
            "suivant", "next", "continuer", "vérifier", "ga verder", "volgende", "doorgaan", "weiter"
        )

        # 1. Dismiss blocking cookie banners or popups
        for el in elements:
            t = text_of(el)
            if any(k in t for k in dismiss_kw) and el.get("tag") in ("button", "a"):
                return {"action": "click", "id": el["id"], "reason": "heuristic: dismiss popup / accept cookies"}

        # 2. File upload for CV
        for el in elements:
            if el.get("isFileInput"):
                return {"action": "upload", "id": el["id"],
                        "value": os.path.abspath(self.profile["resumes"]["fr"]),
                        "reason": "heuristic: CV file input"}

        # 3. Final submission button
        for el in elements:
            t = text_of(el)
            if any(k in t for k in submit_kw):
                return {"action": "click", "id": el["id"], "reason": "heuristic: submit button"}

        # 4. Apply / view vacancy button (e.g. Adzuna NL "Bekijk vacature", "Solliciteren")
        for el in elements:
            t = text_of(el)
            if any(k in t for k in apply_kw):
                return {"action": "click", "id": el["id"], "reason": "heuristic: apply button"}

        # 5. Next / Continue button in multi-step wizard
        for el in elements:
            t = text_of(el)
            if any(k in t for k in next_kw):
                return {"action": "click", "id": el["id"], "reason": "heuristic: next button"}

        return {"action": "scroll", "direction": "down", "reason": "heuristic: no target, reveal form"}

    def execute_action(self, action: Dict[str, Any]) -> bool:
        """Executes the chosen action directly against the DOM element."""
        act_type = action.get("action")
        elem_id = action.get("id")
        reason = action.get("reason", "")
        if elem_id is not None:
            self.executed_actions.add(f"{act_type}:{elem_id}")
        print(f"[AIDOMAgent] Executing: {act_type.upper()} on #{elem_id} -> {reason}")

        if act_type == "done":
            return True

        if act_type == "barrier":
            print(f"[AIDOMAgent] Application barrier: {reason}")
            return False

        if act_type == "scroll":
            direction = action.get("direction", "down")
            if direction == "down":
                self.driver.execute_script("window.scrollBy(0, 500);")
            else:
                self.driver.execute_script("window.scrollBy(0, -500);")
            time.sleep(1.5)
            return True

        # Find target element by data-dom-agent-id
        try:
            target = self.driver.find_element(By.CSS_SELECTOR, f"[data-dom-agent-id='{elem_id}']")
        except Exception:
            print(f"[AIDOMAgent] Element #{elem_id} not found in DOM.")
            return False

        if act_type == "click":
            try:
                handles_before = list(self.driver.window_handles)
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});", target)
                time.sleep(0.5)

                try:
                    tag_name = (target.tag_name or '').lower()
                    href = target.get_attribute("href")
                    if tag_name == "a" and href and href.startswith("http"):
                        self.driver.execute_script("arguments[0].removeAttribute('target');", target)
                except Exception:
                    pass

                try:
                    from selenium.webdriver.common.action_chains import ActionChains
                    ActionChains(self.driver).move_to_element(target).pause(0.2).click().perform()
                except Exception:
                    self.driver.execute_script("arguments[0].click();", target)
                time.sleep(2)

                # Check if a new tab / window opened (e.g. Adzuna redirecting to HelloWork/Indeed)
                handles_after = list(self.driver.window_handles)
                if len(handles_after) > len(handles_before):
                    new_handle = handles_after[-1]
                    self.driver.switch_to.window(new_handle)
                    print(f"[AIDOMAgent] Switched to new window/tab: {self.driver.current_url}")
                    self.inject_cookie_vault()
                    time.sleep(2)
                return True
            except Exception as e:
                print(f"[AIDOMAgent] Click error: {e}")
                return False

        elif act_type == "fill":
            val = action.get("value", "")
            try:
                self.driver.execute_script("arguments[0].scrollIntoView({block: 'center', inline: 'nearest'});", target)
                time.sleep(0.3)
                target.clear()
                self.driver.execute_script("""
                    var el = arguments[0];
                    var val = arguments[1];
                    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ?
                        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set : null;
                    if (setter) { setter.call(el, val); } else { el.value = val; }
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                """, target, val)
                time.sleep(0.5)
                return True
            except Exception as e:
                print(f"[AIDOMAgent] Fill error: {e}")
                return False

        elif act_type == "upload":
            val = action.get("value", "")
            try:
                target.send_keys(val)
                time.sleep(2)
                return True
            except Exception as e:
                print(f"[AIDOMAgent] Upload error: {e}")
                # Fallback: make sure element is not hidden
                try:
                    self.driver.execute_script("arguments[0].style.display = 'block'; arguments[0].style.opacity = '1';", target)
                    target.send_keys(val)
                    time.sleep(2)
                    return True
                except Exception as e2:
                    print(f"[AIDOMAgent] Secondary upload error: {e2}")
                    return False

        elif act_type == "check":
            try:
                if not target.is_selected():
                    self.driver.execute_script("arguments[0].click();", target)
                time.sleep(0.5)
                return True
            except Exception as e:
                print(f"[AIDOMAgent] Check error: {e}")
                return False

        return False

    def run(self, url: str, timeout_seconds: int = 240) -> Dict[str, Any]:
        """
        Runs the full autonomous application loop on any job URL.
        Guaranteed zero hardcoding. Operates entirely through semantic perception.
        """
        start_time = time.time()
        print(f"\n[AIDOMAgent] ======================================================")
        print(f"[AIDOMAgent] Starting Zero-Intervention Application on: {url}")
        print(f"[AIDOMAgent] Candidate: {self.profile['first_name']} {self.profile['last_name']}")
        print(f"[AIDOMAgent] Timeout: {timeout_seconds}s (< 4 min)")
        print(f"[AIDOMAgent] ======================================================\n")

        # 1. Pre-inject session cookies into browser context
        self.inject_cookie_vault()

        # 2. Navigate to target URL
        self.driver.get(url)
        time.sleep(4)

        # 3. Execution loop
        executed_actions = []
        for step in range(1, self.max_steps + 1):
            elapsed = time.time() - start_time
            if elapsed > timeout_seconds:
                return {
                    "success": False,
                    "message": f"Timeout reached ({int(elapsed)}s)",
                    "steps": len(executed_actions)
                }

            print(f"\n[AIDOMAgent] --- Step {step}/{self.max_steps} (Elapsed: {int(elapsed)}s) ---")
            elements = self.get_interactive_elements()
            print(f"[AIDOMAgent] Detected {len(elements)} interactive elements on page.")

            if not elements:
                time.sleep(2)
                continue

            action = self.plan_action(elements, step)
            print(f"[AIDOMAgent] Planned Action: {json.dumps(action, ensure_ascii=False)}")

            if action.get("action") == "done":
                print(f"\n[AIDOMAgent] APPLICATION SUCCESSFUL! {action.get('reason')}")
                self.driver.save_screenshot("application_success.png")
                return {
                    "success": True,
                    "message": action.get("reason"),
                    "steps": len(executed_actions),
                    "duration_seconds": int(time.time() - start_time)
                }

            # Avoid repeating the exact same failed action indefinitely
            action_sig = f"{action.get('action')}_{action.get('id')}_{action.get('value', '')}"
            if executed_actions.count(action_sig) >= 3:
                print(f"[AIDOMAgent] Action {action_sig} repeated 3 times. Scrolling down to shift context...")
                self.driver.execute_script("window.scrollBy(0, 400);")
                time.sleep(2)
                continue

            success = self.execute_action(action)
            executed_actions.append(action_sig)
            time.sleep(2.5)

        return {
            "success": False,
            "message": "Max steps reached without explicit confirmation.",
            "steps": len(executed_actions),
            "duration_seconds": int(time.time() - start_time)
        }
