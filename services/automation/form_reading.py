"""
Reading an employer's form in whatever language it was written in.

The agent is a language model, so it "knows" Dutch in the sense that it can
translate it. That turned out not to be the problem. The problem is that the
snapshot it works from is a flat list of elements -- `[42]<input type=text>`
-- and on a great many forms the words that say what a box is for are not in
the element at all. They are in a `<label for>` two nodes away, or a `<span>`
above it, or an `aria-labelledby` pointing somewhere else entirely. On an
English page the model papers over that with priors: a text box near the top,
beside something that looks like a name, is the name box. Those priors are
learned mostly from English forms, and on a Dutch one they quietly stop
working -- which is how "Tussenvoegsel" (the *infix* in "van der Berg") ends
up holding a surname, and how the box actually wanted for a first name gets
skipped.

So the labels are resolved here, in code, the way a browser resolves them --
and handed to the agent as a numbered list of what this page is asking for,
written in the page's own words with the answer beside each one. Following a
list needs no priors.
"""

from __future__ import annotations

import re

# --------------------------------------------------------------- languages

LANGUAGE_NAMES = {
    "nl": "Dutch", "fr": "French", "de": "German", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "en": "English",
}

# Words common enough to be near-certain in one language and rare in the
# others, used when the markup does not declare a language or declares the
# wrong one -- which is routine. Plenty of Dutch career sites ship
# `<html lang="en">` because the template came that way.
_SNIFF = {
    "nl": (" een ", " het ", " van ", " voor ", " jouw ", " bij ", " werken ", "vacature",
           "solliciteer", "sollicitatie", "bedrijf", "ervaring", "wij zijn", " jij "),
    "fr": (" le ", " la ", " les ", " des ", " vous ", " votre ", " nous ", "postuler",
           "candidature", "entreprise", "recherche", "offre"),
    "de": (" der ", " die ", " das ", " und ", " fur ", " ihre ", " wir ", "bewerbung",
           "bewerben", "stelle", "unternehmen", "mitarbeiter"),
    "es": (" el ", " los ", " las ", " para ", " con ", "empresa", "empleo",
           "solicitud", "puesto", "experiencia"),
    "it": (" il ", " lo ", " gli ", " per ", " con ", "azienda", "lavoro",
           "candidatura", "esperienza"),
}


def sniff_language(declared: str, text: str) -> str:
    """
    The language the page is actually written in.

    The declared `lang` attribute is taken seriously only when the text does
    not contradict it, because a wrong declaration is worse than none: it
    would tell the agent to expect English labels on a Dutch form, which is
    exactly the failure this module exists to stop.
    """
    declared = (declared or "").strip().lower().split("-")[0]
    body = f" {(text or '').lower()} "
    scores = {code: sum(body.count(w) for w in words) for code, words in _SNIFF.items()}
    best, best_score = max(scores.items(), key=lambda kv: kv[1]) if scores else ("", 0)
    if best_score >= 3:
        return best
    if declared in LANGUAGE_NAMES:
        return declared
    return "en"


# Words on buttons, by language. The "never click" list matters as much as the
# forward one: "Wissen", "Annuleren" and "Verwijderen" all sit next to the
# button that actually moves the application on, and clicking one of them
# throws away everything typed so far.
_ACTIONS = {
    "nl": {
        "apply": "Solliciteer / Solliciteren / Direct solliciteren",
        "next": "Volgende / Verder / Doorgaan",
        "send": "Versturen / Verzenden / Sollicitatie versturen",
        "signin": "Inloggen / Aanmelden",
        "signup": "Registreren / Account aanmaken",
        "required": "Verplicht (marks a field you must fill)",
        "avoid": "Wissen (clears the form), Annuleren (cancels), Verwijderen (deletes), "
                 "Terug (goes back), Opslaan als concept (saves a draft instead of sending)",
    },
    "fr": {
        "apply": "Postuler / Je postule / Postuler a cette offre",
        "next": "Suivant / Continuer / Etape suivante",
        "send": "Envoyer / Envoyer ma candidature / Soumettre",
        "signin": "Se connecter / Connexion",
        "signup": "S'inscrire / Creer un compte",
        "required": "Obligatoire / Champ requis",
        "avoid": "Effacer (clears), Annuler (cancels), Supprimer (deletes), Retour (goes back), "
                 "Enregistrer comme brouillon (saves a draft instead of sending)",
    },
    "de": {
        "apply": "Bewerben / Jetzt bewerben",
        "next": "Weiter / Naechster Schritt",
        "send": "Absenden / Bewerbung absenden / Senden",
        "signin": "Anmelden / Einloggen",
        "signup": "Registrieren / Konto erstellen",
        "required": "Pflichtfeld",
        "avoid": "Loeschen (deletes), Abbrechen (cancels), Zurueck (goes back), "
                 "Als Entwurf speichern (saves a draft instead of sending)",
    },
    "es": {
        "apply": "Inscribirse / Aplicar / Enviar candidatura",
        "next": "Siguiente / Continuar",
        "send": "Enviar / Enviar solicitud",
        "signin": "Iniciar sesion / Acceder",
        "signup": "Registrarse / Crear cuenta",
        "required": "Obligatorio / Campo requerido",
        "avoid": "Borrar (clears), Cancelar (cancels), Eliminar (deletes), Volver (goes back)",
    },
    "it": {
        "apply": "Candidati / Invia candidatura",
        "next": "Avanti / Continua",
        "send": "Invia / Invia candidatura",
        "signin": "Accedi",
        "signup": "Registrati / Crea un account",
        "required": "Obbligatorio",
        "avoid": "Cancella (clears), Annulla (cancels), Elimina (deletes), Indietro (goes back)",
    },
}


def language_brief(code: str) -> str:
    """The page's language, named, with the buttons that matter in it."""
    if code not in _ACTIONS:
        return ""
    words = _ACTIONS[code]
    name = LANGUAGE_NAMES.get(code, code)
    return f"""PAGE LANGUAGE: {name.upper()}. Every label, button and error message on this page is
in {name}. A form in a language you were not expecting is where applications get filled in wrong,
so read the actual words rather than guessing from position or from what the English version of
this form would look like. If a label is one you do not recognise, translate it before you type --
never type into a box you cannot name.

{name} words you will meet:
- Opens the application: {words['apply']}
- Moves to the next step: {words['next']}
- Sends the finished application: {words['send']}
- Sign in: {words['signin']}     Create an account: {words['signup']}
- {words['required']}
- NEVER click these: {words['avoid']}
"""


# ------------------------------------------------------------ field reading

# Resolves a control's label the way a browser does when it builds the
# accessibility tree, then falls back to the text a person would read as
# belonging to it.
FIELD_READ_JS = r"""
const __bojFieldOk = (el) => {
    try {
        if (el.closest('[data-page-agent-ignore],[data-browser-use-ignore],[id^="page-agent-runtime"]')) return false;
        const t = String(el.type || '').toLowerCase();
        if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
};
const __bojClean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90);
const __bojLabel = (el) => {
    // 1. aria-labelledby, which wins in the accessibility tree and is what the
    //    big enterprise ATSs actually use.
    const ref = el.getAttribute && el.getAttribute('aria-labelledby');
    if (ref) {
        const parts = ref.split(/\s+/).map((id) => {
            const n = document.getElementById(id);
            return n ? (n.innerText || n.textContent) : '';
        }).filter(Boolean);
        if (parts.length) return __bojClean(parts.join(' '));
    }
    // 2. <label for="id">
    if (el.id) {
        try {
            const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
            if (lab) { const t = __bojClean(lab.innerText || lab.textContent); if (t) return t; }
        } catch (e) {}
    }
    // 3. A label wrapped around the control.
    const wrap = el.closest && el.closest('label');
    if (wrap) { const t = __bojClean(wrap.innerText || wrap.textContent); if (t) return t; }
    // 4. What the control says about itself.
    for (const attr of ['aria-label', 'placeholder', 'title']) {
        const v = el.getAttribute && el.getAttribute(attr);
        if (v && v.trim()) return __bojClean(v);
    }
    // 5. The nearest text in its own row. Walks up at most three levels, so a
    //    whole fieldset of prose cannot be mistaken for one field's label.
    let node = el.parentElement, hops = 0;
    while (node && hops < 3) {
        const own = __bojClean(
            Array.from(node.childNodes)
                .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !n.matches('input,textarea,select')))
                .map((n) => n.innerText || n.textContent || '')
                .join(' ')
        );
        if (own && own.length <= 90) return own;
        node = node.parentElement; hops += 1;
    }
    // 6. Last resort: the name the developer gave it.
    return __bojClean((el.getAttribute && (el.getAttribute('name') || el.getAttribute('id'))) || '')
        .replace(/[_\-.]+/g, ' ');
};
"""


def read_fields_script(limit: int = 45) -> str:
    """JS returning the visible controls on the page with their labels resolved."""
    return FIELD_READ_JS + """
    const out = [];
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    for (const el of controls) {
        if (!__bojFieldOk(el)) continue;
        const tag = el.tagName.toLowerCase();
        const type = String(el.type || tag).toLowerCase();
        let options = [];
        if (tag === 'select') {
            options = Array.from(el.options || []).slice(0, 14)
                .map((o) => __bojClean(o.label || o.text)).filter(Boolean);
        }
        out.push({
            label: __bojLabel(el),
            type: type,
            tag: tag,
            required: !!(el.required || el.getAttribute('aria-required') === 'true'),
            filled: !!(el.value && String(el.value).trim()),
            options: options,
        });
        if (out.length >= LIMIT) break;
    }
    let text = '';
    try { text = (document.body.innerText || '').slice(0, 4000); } catch (e) {}
    return {
        lang: (document.documentElement.getAttribute('lang') || ''),
        text: text,
        fields: out,
    };
    """.replace("LIMIT", str(int(limit)))


# What each label means and what belongs in it. Ordered, first match wins, so
# the traps come before the general rules they would otherwise be swallowed by:
# "Tussenvoegsel" has to be caught before anything matching "naam", and a
# search box has to be caught before anything at all.
_MEANINGS = [
    ("infix", r"tussenvoegsel|middle name|infix|deuxieme prenom|zweiter vorname",
     "LEAVE THIS EMPTY. It is the Dutch name infix -- the 'van der' in 'van der Berg' -- and this "
     "candidate has none. The surname does NOT go here."),
    ("search", r"^(zoek|search|recherch|such|busca|cerca)\w*\b|zoekterm|^filter",
     "NOT part of the application -- this is the site's search box. Never type into it."),
    ("first", r"voornaam|first ?name|given name|pr[eé]nom|vorname|nombre$|forename",
     "{first_name}"),
    ("last", r"achternaam|last ?name|surname|family name|nom de famille|^nom(?! complet)\b|"
             r"nachname|apellido|cognome",
     "{last_name}"),
    ("full", r"volledige naam|full ?name|nom complet|\bnaam\b|^name\b|vollst[aä]ndiger name|"
             r"nombre completo",
     "{full_name}"),
    ("email", r"e-?mail|correo|courriel",
     "{email}"),
    ("phone", r"telefoon|t[eé]l[eé]phone|phone|mobiel|gsm|handy|m[oó]vil|telefono|portable|nummer",
     "{phone} -- digits only, no '+' and no spaces: many European forms reject those."),
    ("postal", r"postcode|post ?code|zip|code postal|plz|^cap\b",
     "{postal}"),
    ("city", r"woonplaats|^plaats|city|ville|stad|^ort\b|ciudad|citt[aà]|localit",
     "{city}"),
    ("address", r"adres|address|straat|^rue\b|street|stra[sß]e|^via\b|domicile",
     "{address}"),
    ("country", r"^land\b|country|pays|pa[ií]s|paese",
     "{country}"),
    ("linkedin", r"linkedin",
     "{linkedin}"),
    ("birth", r"geboortedatum|date of birth|geburtsdatum|date de naissance|fecha de nacimiento",
     "The profile has no date of birth. Leave it empty; if the form refuses to move on without "
     "one, say so in your done() message rather than inventing a date."),
    ("motivation", r"motivat|cover ?letter|lettre de|anschreiben|waarom|why do you|toelichting|"
                   r"bericht|message|comment|opmerking|carta de presentaci",
     "A short, specific paragraph on why this candidate suits this job, drawn from the experience "
     "listed below. Write it in the language of this page."),
    ("salary", r"salari|salaire|gehalt|sueldo|bruto|compensation|wage|loon",
     "40000 EUR per year (write just 40000 if the box only takes digits)."),
    ("start", r"beschikbaar|startdatum|availab|disponibil|notice|opzegtermijn|eintritt|k[uü]ndigungs",
     "Available immediately (at most one month's notice)."),
    ("upload", r"cv|resume|curriculum|bijlage|upload|lebenslauf|attach",
     "The CV is ALREADY attached to this form programmatically. Do not click browse or upload."),
    ("marketing", r"nieuwsbrief|newsletter|marketing|aanbiedingen|partners|promotional|werbung",
     "Leave this unticked. It is optional and is not needed to apply."),
    ("consent", r"akkoord|voorwaarden|privacy|terms|consent|conditions|einverstanden|gdpr|avg|"
                r"toestemming|d[ée]clare",
     "Tick it. The form will not submit without the privacy or terms box."),
    ("source", r"hoe (heb|ben) je|how did you (hear|find)|comment avez-vous|woher (kennen|haben)|"
               r"bron|source",
     "Pick any sensible option, such as the company website or Internet."),
    ("gender", r"geslacht|gender|sexe|geschlecht|g[eé]nero",
     "{gender}"),
    ("nationality", r"nationalit|staatsangeh|nacionalidad",
     "Moroccan"),
    ("permit", r"werkvergunning|work (permit|authori)|autorisation de travail|arbeitserlaubnis|"
               r"visa|sponsor|eligib",
     "Holds a valid work permit for France. Needs sponsorship for countries other than France "
     "and Morocco."),
    ("experience", r"jaren ervaring|years of experience|ann[eé]es d.exp[eé]rience|berufserfahrung",
     "3 years"),
    ("reference", r"vacaturenummer|referentie|reference (number|code)|kenmerk|req(uisition)? id",
     "Leave whatever the page already put there."),
]

_COMPILED = [(key, re.compile(pattern, re.I), answer) for key, pattern, answer in _MEANINGS]


def field_answer(label: str, values: dict) -> str:
    """What belongs in the box with this label, or '' when nothing is certain."""
    text = (label or "").strip()
    if not text:
        return ""
    for _key, pattern, answer in _COMPILED:
        if pattern.search(text):
            try:
                return answer.format(**values)
            except Exception:
                return answer
    return ""


def form_plan(fields: list, values: dict, min_fields: int = 3) -> str:
    """
    The page's own questions, numbered, with the answer beside each one.

    Returns '' when there is no form worth describing -- a job advert with a
    newsletter box at the bottom is not an application, and a made-up plan for
    one would send the agent typing into a mailing list.
    """
    real = [f for f in (fields or []) if f.get("type") not in ("checkbox", "radio")
            or (f.get("label") or "").strip()]
    if len(real) < min_fields:
        return ""

    lines = []
    unknown = 0
    for i, field in enumerate(fields[:40], start=1):
        label = (field.get("label") or "").strip() or "(no label on the page)"
        kind = field.get("tag") if field.get("tag") == "select" else field.get("type")
        marks = []
        if field.get("required"):
            marks.append("required")
        if field.get("filled"):
            marks.append("already filled")
        mark = f", {', '.join(marks)}" if marks else ""
        answer = field_answer(label, values)
        if not answer:
            unknown += 1
            answer = ("Work out from the label what this is asking and answer it truthfully from "
                      "the profile. If the profile genuinely does not cover it, leave it empty.")
        options = field.get("options") or []
        extra = f"\n      Options offered: {'; '.join(options)}" if options else ""
        lines.append(f'{i:>3}. "{label}" ({kind}{mark}) -> {answer}{extra}')

    return f"""THIS FORM, FIELD BY FIELD. The quoted words are the page's own label for each box,
read straight out of the page in the order they appear. Match on the label text, not on position:

{chr(10).join(lines)}

Anything on the page that is not in this list is not part of the application -- site search,
newsletter boxes, cookie settings -- so do not type into it. If a field in this list is not
visible, it is on a later step of the form; fill what you can see and move on.
"""
