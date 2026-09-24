# -*- coding: utf-8 -*-
"""
The letter itself: one per employer, in their language, about them.

A spontaneous application is not a mail merge. The employer did not advertise
the job being asked for, so the only thing that makes the letter worth opening
is evidence that it was written after looking at them -- their trade, their
city, the apprenticeship or role they actually run. A letter that says "your
esteemed company" has told the reader it went to four hundred others.

So the model is given the prospect and the candidate and asked for prose, and
it is given very little licence: no invented experience, no claimed knowledge
of the firm beyond what is in the row, and no promises about availability that
the candidate has not made. What it cannot verify it must leave out, because
the cost of a flattering invention is not a worse letter, it is a candidate
who has to defend a lie in an interview.

Three languages, chosen from where the employer is rather than from a setting:
German for .de/.at/.ch and German cities, French for .fr/.be/.lu, English
otherwise. Writing to a Berlin Handwerksbetrieb in English is a decision the
reader notices.

On secrets: the candidate profile in this repository carries `password` and
`passwords` keys next to the address and the CV. `safe_profile()` is the only
way this module reads it, and it is an allow-list rather than a deny-list --
a new secret added to that file tomorrow is excluded by default rather than
silently posted to a language model.
"""

from __future__ import annotations

import re
from typing import Dict, Optional

from services.automation.candidate_profile import CANDIDATE_PROFILE
from services.automation.llm_client import FuelixClient

# Every field the letter may know about. Anything not named here -- passwords
# above all -- never reaches a prompt. An allow-list, because the failure mode
# of a deny-list is silent and permanent.
PROFILE_FIELDS = (
    "full_name", "first_name", "last_name", "email", "phone", "phone_formatted",
    "address", "postal_code", "city", "country", "full_address", "linkedin",
    "website", "current_title", "years_of_experience", "technical_skills",
    "languages", "education", "experiences",
)

GERMAN_TLDS = (".de", ".at", ".ch")
FRENCH_TLDS = (".fr", ".be", ".lu", ".mc")

GERMAN_CITIES = {
    "berlin", "hamburg", "muenchen", "münchen", "munich", "koeln", "köln",
    "cologne", "frankfurt", "stuttgart", "duesseldorf", "düsseldorf", "leipzig",
    "dortmund", "essen", "bremen", "dresden", "hannover", "nuernberg",
    "nürnberg", "osnabrueck", "osnabrück", "potsdam", "bonn", "muenster",
    "münster", "karlsruhe", "mannheim", "augsburg", "wiesbaden", "kiel",
    "wien", "vienna", "graz", "salzburg", "zuerich", "zürich", "basel", "bern",
}

# What the subject line calls it, and it does not call it anything.
#
# "Speculative application", "candidature spontanée", "Initiativbewerbung": each
# one announces, before a word of the letter is read, that nobody asked for this
# and that the same text has probably gone to forty other companies. The reader
# files it accordingly. A letter that simply says what the writer does reads as
# a person writing to them, which is what it is -- the fact that no advert
# exists is obvious from the letter and needs no label on top of it.
SUBJECTS = {
    "de": "Bewerbung",
    "fr": "Candidature",
    "en": "Application",
}

# The labels, in every form they turn up in, so nothing puts one back. The model
# reaches for them by habit -- "I am writing speculatively to enquire" -- and a
# rule in the prompt is a request, not a guarantee.
LABELS = [
    (r"\bon a (purely )?speculative basis\b", ""),
    (r"\bspeculative(ly)?\b,?\s*", ""),
    (r"\bunsolicited\b,?\s*", ""),
    (r"\bcandidature\s+spontan[ée]e?\b", "candidature"),
    (r"\bde\s+mani[èe]re\s+spontan[ée]e\b", ""),
    (r"\bspontan[ée]ment\b,?\s*", ""),
    (r"\bInitiativbewerbung\b", "Bewerbung"),
    (r"\binitiativ\b,?\s*", ""),
]


def unlabelled(text: str) -> str:
    """
    The letter with the genre word taken back out, however it got in.

    Only ever removes: no sentence is rewritten, nothing is added. What is left
    is the same letter without the announcement -- "I am writing to enquire"
    instead of "I am writing speculatively to enquire".
    """
    out = text
    for pattern, replacement in LABELS:
        out = re.sub(pattern, replacement, out, flags=re.IGNORECASE)
    # Tidy what the removals left behind: doubled spaces, a space before a
    # comma, a paragraph that now opens on the comma the word used to precede.
    # The case of the first word is left alone -- a German letter continues in
    # lower case after the greeting, and "correcting" that would be an error.
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\s+([,.;:])", r"\1", out)
    out = re.sub(r"(^|\n)[ \t]*[,;:]\s*", r"\1", out)
    return out.strip()

SIGN_OFF = {
    "de": "Mit freundlichen Grüßen",
    "fr": "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées",
    "en": "Yours sincerely",
}

GREETING = {
    "de": {"named": "Sehr geehrte{suffix} {title} {last_name},",
           "blind": "Sehr geehrte Damen und Herren,"},
    "fr": {"named": "{title} {last_name},", "blind": "Madame, Monsieur,"},
    "en": {"named": "Dear {title} {last_name},", "blind": "Dear Sir or Madam,"},
}


def safe_profile(user: Optional[str] = None) -> Dict[str, object]:
    """
    The candidate, minus everything that is not the model's business.

    Which candidate is now a question: two people use this app, and the one
    whose name goes at the bottom of the letter is the one whose profile the
    model is shown. Named accounts are read from the store; the bare call still
    answers with the account this app was written for, so the nine callers that
    have not learned to say who they mean keep working.

    The allow-list is unchanged and is still an allow-list. `password` and
    `passwords` sit in the same dict as the address and the CV, and a filter
    that named what to drop would leak the next secret somebody adds.
    """
    source: Dict[str, object]
    if user:
        from services.automation import profile_store
        source = profile_store.profile_for(user)
    else:
        source = CANDIDATE_PROFILE
    return {key: source.get(key) for key in PROFILE_FIELDS
            if source.get(key) not in (None, "", [], {})}


def _domains(prospect: Dict[str, object]) -> str:
    """Just the host parts -- an address and a website, nothing else.

    Matching ".at" against free text finds it inside "Ausbildung bei Sachat",
    so the country test is run over hostnames only.
    """
    email = str(prospect.get("email") or "")
    host = email.split("@", 1)[-1].lower() if "@" in email else ""
    site = str(prospect.get("website") or "").lower()
    site = re.sub(r"^https?://", "", site).split("/", 1)[0]
    return host + " " + site


def language_for(prospect: Dict[str, object], fallback: str = "en") -> str:
    """
    Where the employer is, not what the operator prefers.

    The fallback is the one thing the operator does decide, and only when the
    evidence runs out: an address with no country in it, written on behalf of
    someone applying for an Ausbildung, is German rather than English.
    """
    hosts = [h for h in _domains(prospect).split() if h]
    if any(h.endswith(GERMAN_TLDS) for h in hosts):
        return "de"
    if any(h.endswith(FRENCH_TLDS) for h in hosts):
        return "fr"
    if str(prospect.get("city") or "").strip().lower() in GERMAN_CITIES:
        return "de"
    # A .com firm found on the German federal job board is a German firm.
    if str(prospect.get("source") or "") == "arbeitsagentur":
        return "de"
    return fallback or "en"


def _honorific(contact_name: str, language: str) -> Dict[str, str]:
    """
    Guessing a person's gender from their first name is not something this
    does. German needs a grammatical ending, so with no stated title it uses
    the neutral plural greeting rather than assuming -- getting it wrong is a
    worse opening than not using the name at all.
    """
    name = (contact_name or "").strip()
    if not name:
        return {"kind": "blind"}
    stated = re.match(r"^(Frau|Herr|Mme|Mr|Mrs|Ms|Madame|Monsieur)\s+(.+)$", name, re.I)
    if not stated:
        return {"kind": "blind"}
    title_raw = stated.group(1).lower()
    last = stated.group(2).strip().split()[-1]
    if language == "de":
        female = title_raw.startswith(("frau", "mme", "mrs", "ms", "madame"))
        return {"kind": "named", "suffix": " Frau" if female else "r Herr",
                "title": "", "last_name": last}
    if language == "fr":
        female = title_raw.startswith(("frau", "mme", "mrs", "ms", "madame"))
        return {"kind": "named", "title": "Madame" if female else "Monsieur",
                "last_name": last}
    female = title_raw.startswith(("frau", "mme", "mrs", "ms", "madame"))
    return {"kind": "named", "title": "Ms" if female else "Mr", "last_name": last}


def greeting_for(prospect: Dict[str, object], language: str) -> str:
    who = _honorific(str(prospect.get("contact_name") or ""), language)
    if who["kind"] == "blind":
        return GREETING[language]["blind"]
    return GREETING[language]["named"].format(
        suffix=who.get("suffix", ""), title=who.get("title", ""),
        last_name=who.get("last_name", "")).replace("  ", " ").strip()


SYSTEM = ("You write job application letters that sound like one person wrote "
          "them to one employer.")


def _prompt(prospect: Dict[str, object], language: str, role: str,
            user: Optional[str] = None) -> str:
    profile = safe_profile(user)
    facts = [
        "Company: " + str(prospect.get("company") or ""),
        "City: " + str(prospect.get("city") or ""),
        "Their website: " + str(prospect.get("website") or "(unknown)"),
        "What they were found doing: " + str(prospect.get("notes") or "(nothing recorded)"),
        "Named contact: " + (str(prospect.get("contact_name")) or "(nobody named)"),
    ]
    rules = (
        "Write the body of a job application to an employer who has not advertised "
        "anything.\n"
        "Never say so. Do not write 'speculative', 'speculatively', 'unsolicited', "
        "'candidature spontanee', 'spontanement', 'Initiativbewerbung' or 'initiativ', "
        "and do not describe the letter at all. Someone writing to a company they "
        "would like to work for does not open by classifying their own letter; they "
        "say what they do and what they are asking for. Keep it warm and direct, the "
        "way a competent person writes to another, not the way a form is filled in.\n"
        "Language: " + {"de": "German", "fr": "French", "en": "English"}[language] + ".\n"
        "Length: three or four short paragraphs, under 220 words. It will be read "
        "on a phone by somebody who did not ask for it.\n"
        "Rules that matter more than style:\n"
        "- Invent nothing. Use only the candidate facts given. No qualifications, "
        "employers, dates or skills that are not listed.\n"
        "- Claim no knowledge of this company beyond the facts given above. If all "
        "that is known is their trade and city, say something true about that and "
        "nothing more. Never write that you admire them or have followed them.\n"
        "- Do not promise a start date, a salary expectation or a notice period.\n"
        "- No greeting line and no sign-off: those are added around your text.\n"
        "- Plain paragraphs separated by a blank line. No markdown, no bullets, "
        "no subject line, no placeholders in brackets."
    )
    if role:
        rules += "\n- The kind of work being asked for: " + role + "."
    return (rules + "\n\nTHE EMPLOYER:\n" + "\n".join(facts)
            + "\n\nTHE CANDIDATE:\n" + _describe(profile))


def _describe(profile: Dict[str, object]) -> str:
    lines = []
    for key, value in profile.items():
        if isinstance(value, (list, tuple)):
            lines.append(key + ": " + "; ".join(str(v) for v in value[:8]))
        elif isinstance(value, dict):
            lines.append(key + ": " + "; ".join(
                str(k) + " (" + str(v) + ")" for k, v in list(value.items())[:8]))
        else:
            lines.append(key + ": " + str(value))
    return "\n".join(lines)


# Openings and closings a model adds despite being told not to. Stripping them
# is not tidiness: the greeting is added around the body, so one left in place
# produces a letter that says "Madame, Monsieur," and then "Madame Giuliani,"
# two lines apart -- which was the first thing the first real run produced.
SALUTATION_RE = re.compile(
    r"^\s*(sehr geehrte[a-zßäöü ]*|madame|monsieur|mesdames|messieurs|dear\b[^\n,]*|"
    r"bonjour|hallo|guten tag)[^\n]{0,60}[,:]\s*", re.I)
CLOSING_RE = re.compile(
    # Loose on the stem: German sign-offs arrive as Gruessen, Grüßen, Grussen
    # and Grüssen, and a pattern that insists on the umlaut leaves the other
    # three in the letter.
    r"\n\s*(mit freundlichen gr\w+|freundliche gr\w+|"
    r"je vous prie d.agr[eé]er[^\n]*|veuillez agr[eé]er[^\n]*|"
    r"cordialement|sincerement|sincèrement|yours sincerely|yours faithfully|"
    r"kind regards|best regards|regards)\b[\s\S]*$", re.I)


def _strip_frame(body: str, full_name: str) -> str:
    """Remove any greeting or sign-off the model wrote anyway."""
    body = body.strip()
    previous = None
    while previous != body:
        previous = body
        body = SALUTATION_RE.sub("", body).strip()
    body = CLOSING_RE.sub("", body).strip()
    if full_name:
        # A trailing signature line, with or without the closing above it.
        body = re.sub(r"\n\s*" + re.escape(full_name) + r"\s*$", "", body).strip()
    return body


def _fallback_body(prospect: Dict[str, object], language: str, role: str,
                   user: Optional[str] = None) -> str:
    """
    What goes out when there is no model.

    Deliberately plain and obviously generic. It does not pretend to be
    tailored, because a template dressed up as a personal letter is the one
    outcome worse than a template.
    """
    company = str(prospect.get("company") or "")
    profile = safe_profile(user)
    name = str(profile.get("full_name") or "")
    title = role or str(profile.get("current_title") or "")
    if language == "de":
        return (f"mit großem Interesse wende ich mich an {company}. "
                f"Ich bin {name} und suche eine Position als {title}.\n\n"
                "Gerne stelle ich mich Ihnen persönlich vor. Meinen Lebenslauf "
                "finden Sie im Anhang.\n\n"
                "Über eine Rückmeldung würde ich mich sehr freuen.")
    if language == "fr":
        return (f"je me permets de vous adresser ma candidature pour "
                f"un poste de {title} au sein de {company}.\n\n"
                "Vous trouverez mon curriculum vitae en pièce jointe, et je reste "
                "à votre disposition pour un entretien.\n\n"
                "Je vous remercie de l'attention portée à ma candidature.")
    return (f"I am writing to ask whether {company} has an opening for a {title}.\n\n"
            "My CV is attached, and I would welcome the chance to talk.\n\n"
            "Thank you for your time.")


def write(prospect: Dict[str, object], role: str = "",
          language: Optional[str] = None,
          user: Optional[str] = None) -> Dict[str, str]:
    """
    One letter. Returns {language, subject, greeting, body, sign_off}.

    Never raises: a company whose letter could not be written still gets the
    plain one, because the alternative is a campaign that stops halfway with
    half its prospects marked sent.
    """
    if not language:
        from services.automation import people
        language = language_for(prospect, people.letter_language(user))
    company = str(prospect.get("company") or "")
    subject = SUBJECTS[language] + (" als " + role if role and language == "de"
                                    else (" - " + role if role else ""))

    body = ""
    try:
        client = FuelixClient()
        if client.has_credentials():
            written = client.chat_text(
                SYSTEM, _prompt(prospect, language, role, user), task="writer",
                temperature=0.7, max_tokens=700, timeout=45)
            body = _strip_frame((written or "").strip(),
                                str(safe_profile(user).get("full_name") or ""))
    except Exception:  # noqa: BLE001 - a letter is worth having even unpolished
        body = ""

    if len(body) < 120 or "[" in body[:400]:
        # Too short to be a letter, or full of bracketed placeholders the model
        # expected somebody to fill in. Either way it must not go out.
        body = _fallback_body(prospect, language, role, user)

    # Last thing before it leaves: the letter does not say what kind of letter
    # it is, whatever the model decided about that.
    body = unlabelled(body)

    return {
        "language": language,
        "subject": unlabelled(subject + (" - " + company if company and language != "de" else "")),
        "greeting": greeting_for(prospect, language),
        "body": body,
        "sign_off": SIGN_OFF[language],
    }

