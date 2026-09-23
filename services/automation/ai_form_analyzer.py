import os
import time
import json
import re
from .llm_client import default_client
from .candidate_profile import CANDIDATE_PROFILE

class AIFormAnalyzer:
    def __init__(self, llm_client=None):
        self.llm = llm_client or default_client

    def has_api_credentials(self) -> bool:
        return self.llm.has_credentials()

    def analyze_form(self, job_title: str, job_description: str, form_fields: list) -> dict:
        """
        Uses Fuelix writer model (or rule-based fallback) to determine the best value
        for each field in form_fields.
        """
        if self.has_api_credentials():
            try:
                return self._query_fuelix_for_mapping(job_title, job_description, form_fields)
            except Exception as e:
                print(f"[AIFormAnalyzer] Fuelix API warning: {e}. Falling back to heuristic mapping.")

        return self._heuristic_mapping(job_title, job_description, form_fields)

    def generate_motivation_letter(self, job_title: str, company: str, job_description: str, max_words: int = 150) -> str:
        """
        Generates a concise, highly targeted French or English motivation letter for Badreddine Barki.
        """
        if self.has_api_credentials():
            try:
                prompt = (
                    f"Rédige une lettre ou message de motivation court et percutant en français "
                    f"(maximum {max_words} mots) pour Badreddine Barki, Ingénieur en Génie Mécanique "
                    f"(3+ ans d'expérience R&D chez SLB, spécialiste CAO 3D CATIA/SolidWorks/Creo, "
                    f"calcul de structures FEA Abaqus/Ansys, et validation V&V, résidant à Amiens Hauts-de-France).\n"
                    f"Poste: {job_title}\n"
                    f"Entreprise: {company}\n"
                    f"Description du poste: {job_description[:1000]}\n"
                    f"Ton: Professionnel, direct, prêt pour entretien."
                )
                resp = self._chat_completion(prompt, task="writer")
                if resp:
                    return resp.strip()
            except Exception as e:
                print(f"[AIFormAnalyzer] Letter generation via Fuelix warning: {e}")

        # High-quality heuristic template
        return (
            f"Madame, Monsieur,\n\n"
            f"Ingénieur en Génie Mécanique fort de plus de 3 années d'expérience en R&D industrielle "
            f"(SLB), je maîtrise la conception mécanique 3D (CATIA V5, SolidWorks, Creo), "
            f"le dimensionnement par éléments finis (Abaqus, Ansys) et le suivi technique des sous-traitants. "
            f"Résidant dans les Hauts-de-France (Amiens), je suis immédiatement mobile et disponible pour rejoindre "
            f"les équipes de {company} et mettre mon expertise au service de vos projets pour le poste de {job_title}.\n\n"
            f"Cordialement,\n"
            f"{CANDIDATE_PROFILE['full_name']}"
        )

    def answer_screening_question(self, question_text: str, job_title: str, max_words: int = 50) -> str:
        """
        Answers specific employer screening questions (e.g. work authorization, experience, software).
        """
        q_lower = question_text.lower()

        # Rule-based fast answers
        if any(w in q_lower for w in ["droit de travailler", "autorisation", "permis", "visa", "travailler en"]):
            return "Oui, je dispose de toutes les autorisations requises pour travailler immédiatement sur ce secteur sans nécessité de parrainage de visa."
        
        if any(w in q_lower for w in ["préavis", "disponibilité", "disponible"]):
            return "Je suis disponible rapidement selon les modalités convenues pour le démarrage du projet."

        if any(w in q_lower for w in ["prétention", "salaire", "rémunération"]):
            return "Selon la grille de rémunération de l'entreprise et les responsabilités du poste (fourchette 42k€ - 48k€ brut annuel)."

        if self.has_api_credentials():
            try:
                prompt = (
                    f"Réponds à cette question de sélection pour le poste '{job_title}' en te basant sur le profil de "
                    f"Badreddine Barki (Ingénieur Mécanique, 3+ ans exp R&D, expert CAO SolidWorks/CATIA/Creo, FEA Abaqus/Ansys). "
                    f"Réponse concise en français de maximum {max_words} mots.\nQuestion: {question_text}"
                )
                ans = self._chat_completion(prompt, task="writer")
                if ans:
                    return ans.strip()
            except Exception:
                pass

        return "Fort de plus de 3 ans d'expérience en conception et calcul mécanique R&D industrielle, je réponds pleinement aux exigences techniques de cette mission."

    def _chat_completion(self, user_prompt: str, task: str = "writer") -> str:
        system = "Tu es un expert en recrutement et candidature d'ingénieur. Tu fournis UNIQUEMENT le texte final demandé, sans explications préliminaires ni réflexions internes."
        content = self.llm.chat_text(system, user_prompt, task=task,
                                     temperature=0.2, max_tokens=800, timeout=30)
        if not content:
            raise RuntimeError("Fuelix unreachable")
        return self._clean_thinking_output(content).strip()

    @staticmethod
    def _clean_thinking_output(text: str) -> str:
        """Strip Kimi-K3 thinking/reasoning preamble, keeping only the final output."""
        # Common markers where the actual letter/answer starts after reasoning
        markers = [
            "\nObjet :", "\nObjet:",
            "\nMadame, Monsieur",
            "\nVersion finale :",
            "\nVersion finale:",
            "\"Madame, Monsieur",
            "\"Objet :",
        ]
        for marker in markers:
            idx = text.rfind(marker)
            if idx > 0:
                text = text[idx:].lstrip('\n"')
                break

        # Strip trailing quotes from "quoted" blocks
        text = text.strip().rstrip('"')
        return text

    def load_cv_text(self, cv_path: str = None) -> str:
        """Extracts plain text from the candidate's CV PDF."""
        if not cv_path:
            cv_path = CANDIDATE_PROFILE.get("resumes", {}).get("fr")
        if cv_path and os.path.exists(cv_path):
            try:
                import pypdf
                reader = pypdf.PdfReader(cv_path)
                text = "\n".join([p.extract_text() or "" for p in reader.pages])
                return text.strip()
            except Exception as e:
                print(f"[AIFormAnalyzer] CV text extraction notice: {e}")
        return ""

    def _query_fuelix_for_mapping(self, job_title: str, job_description: str, form_fields: list, cv_text: str = "") -> dict:
        if not cv_text:
            cv_text = self.load_cv_text()

        prompt = (
            f"Tu es un agent d'intelligence artificielle expert qui remplit automatiquement des formulaires de candidature pour Badreddine Barki.\n\n"
            f"Données structurées du candidat:\n{json.dumps(CANDIDATE_PROFILE, ensure_ascii=False)}\n\n"
            f"Contenu textuel du CV du candidat:\n{cv_text[:3500]}\n\n"
            f"Titre du poste: {job_title}\n"
            f"Description: {job_description[:500]}\n\n"
            f"Voici la liste des champs du formulaire détectés sur la page:\n"
            f"{json.dumps(form_fields, ensure_ascii=False, indent=2)}\n\n"
            f"Pour CHAQUE champ dans la liste, déduis la valeur exacte ou l'option à choisir en fonction du profil et du CV du candidat:\n"
            f"- Prénom: Badreddine\n"
            f"- Nom: Barki\n"
            f"- Email: badreddinebarki@gmail.com\n"
            f"- Code postal: 80000\n"
            f"- GSM / Téléphone: 0745768010 ou +33745768010\n"
            f"- Pays: France\n"
            f"- Genre / Sexe: Homme (man)\n"
            f"- Cycle d'études: Enseignement supérieur\n"
            f"- Type de formation / diplôme: Master ou Diplôme d'Ingénieur\n"
            f"- Établissement: Université ou ENSAM\n"
            f"- Domaine d'études: Génie Mécanique / Structures / Ingénierie (ou 'Autre' si non listé)\n"
            f"- Autre domaine d'études: Génie Mécanique et Structures\n"
            f"- Année de début de Master / cycle: 2020\n"
            f"- Langues (notes de 1 à 5): Français=5 (maternelle/excellent), Anglais=4 (courant/bon), Néerlandais=1 (notions de base)\n"
            f"- Si le champ a une liste d'options ('options'), choisis IMPÉRATIVEMENT l'option la plus proche parmi cette liste.\n\n"
            f"Retourne UNIQUEMENT un objet JSON valide où chaque clé est la propriété 'key' du champ et la valeur est la réponse string à insérer ou l'option exacte à sélectionner."
        )
        resp_text = self._chat_completion(prompt)
        match = re.search(r"\{.*\}", resp_text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except Exception:
                pass
        return self._heuristic_mapping(job_title, job_description, form_fields)

    def _heuristic_mapping(self, job_title: str, job_description: str, form_fields: list) -> dict:
        mapping = {}
        for f in form_fields:
            key = f.get("key") or f.get("id") or f.get("name") or ""
            label = (f.get("label") or f.get("placeholder") or key).lower()
            ftype = f.get("type", "text").lower()
            options = f.get("options", [])

            if any(k in label for k in ["prénom", "prenom", "firstname", "first_name", "fname"]):
                mapping[key] = CANDIDATE_PROFILE["first_name"]
            elif any(k in label for k in ["nom", "lastname", "last_name", "lname", "family"]):
                mapping[key] = CANDIDATE_PROFILE["last_name"]
            elif ftype == "email" or "email" in label or "courriel" in label or "mail" in label:
                mapping[key] = CANDIDATE_PROFILE["email"]
            elif ftype == "tel" or any(k in label for k in ["téléphone", "telephone", "phone", "mobile", "gsm"]):
                mapping[key] = CANDIDATE_PROFILE["phone_national"]
            elif any(k in label for k in ["pays", "country", "nationalité"]):
                mapping[key] = "France"
            elif any(k in label for k in ["genre", "gender", "sexe"]):
                mapping[key] = "Homme"
            elif any(k in label for k in ["adresse", "address", "rue", "street"]):
                mapping[key] = CANDIDATE_PROFILE["full_address"]
            elif any(k in label for k in ["ville", "city", "localité"]):
                mapping[key] = CANDIDATE_PROFILE["city"]
            elif any(k in label for k in ["postal", "zip", "code postal"]):
                mapping[key] = CANDIDATE_PROFILE["postal_code"]
            elif any(k in label for k in ["cycle"]):
                mapping[key] = "Enseignement supérieur"
            elif any(k in label for k in ["formation", "diplôme", "diplome"]):
                mapping[key] = "Master"
            elif any(k in label for k in ["domaine"]):
                mapping[key] = "Génie Mécanique et Structures"
            elif any(k in label for k in ["année", "annee", "debut", "début", "start"]):
                mapping[key] = "2020"
            elif any(k in label for k in ["motivation", "message", "lettre", "cover_letter"]):
                mapping[key] = self.generate_motivation_letter(job_title, "l'entreprise", job_description)

        return mapping

    def scan_form_fields(self, driver) -> list:
        """Scans page/modal for all interactive unfilled fields and returns descriptors."""
        js_script = """
        var results = [];
        var all = document.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="button"][aria-haspopup="listbox"], .MuiSelect-root');
        
        all.forEach(function(el, i) {
            if (!el.offsetParent && el.type !== 'hidden') return;
            if (el.type === 'submit' || el.type === 'button') return;
            
            var label = '';
            if (el.id) {
                var l = document.querySelector('label[for="' + el.id + '"]');
                if (l) label = l.innerText;
            }
            if (!label) {
                var grid = el.closest('.MuiGrid-container, .form-row, .row');
                if (grid) {
                    var prev = el.parentElement ? el.parentElement.previousElementSibling : null;
                    if (prev) label = prev.innerText;
                    if (!label) label = grid.innerText;
                }
            }
            if (!label) {
                var container = el.closest('.MuiFormControl-root, .form-group, .field, tr, div');
                if (container) {
                    var lbl = container.querySelector('label, .title, span');
                    if (lbl) label = lbl.innerText;
                }
            }
            if (!label) label = el.getAttribute('placeholder') || el.name || el.id || '';
            label = (label || '').replace(/\\s+/g, ' ').trim().slice(0, 100);

            var val = (el.value || el.innerText || '').trim();
            var isCustomSelect = el.classList.contains('MuiSelect-root') || el.getAttribute('aria-haspopup') === 'listbox';
            var tag = isCustomSelect ? 'custom_select' : el.tagName.toLowerCase();
            
            var options = [];
            if (el.tagName === 'SELECT') {
                for (var o = 0; o < el.options.length; o++) {
                    if (el.options[o].value) options.push(el.options[o].innerText.trim());
                }
            }

            var key = 'ai_field_' + i;
            el.setAttribute('data-ai-field-key', key);

            var isFilled = false;
            if (tag === 'custom_select') {
                isFilled = val && !val.toLowerCase().includes('choisir') && !val.toLowerCase().includes('select');
            } else if (tag === 'select') {
                isFilled = el.getAttribute('data-ai-solved') === 'true';
            } else if (el.type === 'radio' || el.type === 'checkbox') {
                isFilled = el.checked;
            } else {
                isFilled = val.length > 0;
            }

            results.push({
                key: key,
                idx: i,
                tag: tag,
                type: el.type || '',
                name: el.name || '',
                id: el.id || '',
                placeholder: el.getAttribute('placeholder') || '',
                label: label,
                current_value: val,
                is_filled: isFilled,
                options: options,
                required: el.required || el.getAttribute('aria-required') === 'true'
            });
        });
        return results;
        """
        try:
            return driver.execute_script(js_script) or []
        except Exception as e:
            print(f"[AIFormAnalyzer] Form scan error: {e}")
            return []

    def solve_form_with_ai(self, driver, job_title: str = "", job_description: str = "") -> dict:
        """
        Dynamically finds all unfilled form fields on the active page/modal,
        queries Azure Kimi-K3 using candidate profile & CV, and injects the answers.
        Runs iteratively to handle cascading fields.
        """
        import time
        from selenium.webdriver.common.keys import Keys
        cv_text = self.load_cv_text()

        for pass_idx in range(3):
            fields = self.scan_form_fields(driver)
            unfilled = [f for f in fields if not f.get("is_filled") and f.get("tag") != "radio"]
            if not unfilled:
                print(f"[AIFormAnalyzer] Pass {pass_idx+1}: All fields already filled.")
                break

            print(f"[AIFormAnalyzer] Pass {pass_idx+1}: Resolving {len(unfilled)} unfilled fields via AI...")
            answers = self.analyze_form(job_title, job_description, unfilled)
            if not answers:
                break

            for f in unfilled:
                key = f.get("key")
                val = answers.get(key)
                if not val:
                    continue

                tag = f.get("tag")
                val_str = str(val).strip()
                try:
                    el = driver.find_element("css selector", f"[data-ai-field-key='{key}']")
                    if tag == "custom_select":
                        # Click dropdown
                        driver.execute_script("arguments[0].click();", el)
                        time.sleep(1)
                        # Find matching option in listbox
                        options = driver.find_elements("css selector", "li[role='option'], .MuiMenuItem-root")
                        matched = False
                        for o in options:
                            if val_str.lower() in o.text.lower() or o.text.lower() in val_str.lower():
                                driver.execute_script("arguments[0].click();", o)
                                matched = True
                                el.setAttribute('data-ai-solved', 'true')
                                print(f"[AIFormAnalyzer] Selected custom dropdown option: '{o.text.strip()}' for '{f.get('label')}'")
                                time.sleep(1)
                                break
                        if not matched and len(options) > 1:
                            driver.execute_script("arguments[0].click();", options[1])
                            el.setAttribute('data-ai-solved', 'true')
                    elif tag == "select":
                        from selenium.webdriver.support.ui import Select
                        s = Select(el)
                        matched = False
                        for opt in s.options:
                            otxt = opt.text.strip().lower()
                            oval = (opt.get_attribute("value") or "").strip().lower()
                            if val_str.lower() == oval or val_str.lower() in otxt or otxt in val_str.lower():
                                s.select_by_visible_text(opt.text)
                                matched = True
                                print(f"[AIFormAnalyzer] Selected select option: '{opt.text.strip()}' for '{f.get('label')}'")
                                break
                        if not matched and len(s.options) > 1:
                            s.select_by_index(1)
                        driver.execute_script("""
                            arguments[0].setAttribute('data-ai-solved', 'true');
                            arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
                            arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
                        """, el)
                    else:
                        # Text, number, date, textarea, autocomplete
                        try:
                            el.send_keys(Keys.CONTROL + "a", Keys.BACKSPACE)
                        except Exception:
                            pass
                        driver.execute_script("""
                            var el = arguments[0];
                            var val = arguments[1];
                            var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ?
                                Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set : null;
                            if (setter) { setter.call(el, val); } else { el.value = val; }
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        """, el, val_str)
                        time.sleep(0.5)
                        # Also select first autocomplete option if dropdown appeared
                        suggestions = driver.find_elements("css selector", ".MuiAutocomplete-option, li[role='option']")
                        if suggestions:
                            driver.execute_script("arguments[0].click();", suggestions[0])
                        print(f"[AIFormAnalyzer] Filled '{f.get('label')}' -> {val_str}")
                except Exception as e:
                    pass

            # Handle language ratings specifically
            driver.execute_script("""
                var fr = document.getElementById('language-fr-5') || document.querySelector("input[name*='fr'][value='5']");
                if (fr) fr.click();
                var en = document.getElementById('language-en-4') || document.querySelector("input[name*='en'][value='4']");
                if (en) en.click();
                var nl = document.getElementById('language-nl-1') || document.querySelector("input[name*='nl'][value='1']");
                if (nl) nl.click();
            """)
            time.sleep(2)

        return {"status": "completed"}

