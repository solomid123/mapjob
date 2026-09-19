# -*- coding: utf-8 -*-
"""
A name and a domain, turned into the address that person actually has.

Most companies never publish the mailbox of the person who reads
applications. They publish one address somewhere -- a sales contact, an
office manager, a partner on the imprint page -- and every other mailbox in
the building is built the same way. So the address for Anne Dupont at a firm
that prints pierre.martin@ is anne.dupont@, and the only question worth
asking is whether the mail server agrees.

Two sources of the pattern, in the order they deserve to be trusted:

  * Learned. One published address whose local part can be matched against a
    known person's name settles the question for the whole domain. This is
    evidence, and it is why the crawler runs before this module does.
  * Guessed. Failing that, the permutations in prevalence order. first.last
    is roughly two thirds of European company mail on its own; the tail after
    the sixth is long and thin, and spending SMTP attempts down there is how a
    mail server decides it is being dictionary-attacked.

Nothing here decides anything. It proposes addresses; the verifier is what
turns one of them into a fact, and an unverified guess must never be filed as
though somebody published it.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, List, Optional, Tuple

# Templates in the order they are worth trying, measured against how European
# company mail is actually laid out. The tail matters less than the ceiling:
# ten candidates against one small mail server is a dictionary attack, so the
# list that is offered to SMTP is cut long before it ends.
PATTERNS: Tuple[Tuple[str, str], ...] = (
    ("first.last", "{first}.{last}"),
    ("firstlast", "{first}{last}"),
    ("f.last", "{f}.{last}"),
    ("flast", "{f}{last}"),
    ("first", "{first}"),
    ("first_last", "{first}_{last}"),
    ("last.first", "{last}.{first}"),
    ("lastf", "{last}{f}"),
    ("firstl", "{first}{l}"),
    ("last", "{last}"),
    ("f.l", "{f}.{l}"),
    ("first-last", "{first}-{last}"),
)

PATTERN_BY_NAME: Dict[str, str] = dict(PATTERNS)

# German mail keeps the umlaut convention from typewriters: Müller is mueller
# far more often than muller, and both appear. Where they differ, both are
# offered -- one extra candidate is cheaper than missing the only address the
# person has.
UMLAUT = {"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss",
          "Ä": "ae", "Ö": "oe", "Ü": "ue"}

# Everything an address cannot contain, plus the particles that are part of a
# surname in speech and almost never part of the mailbox: "van der Berg" is
# vandenberg, vanderberg, or just berg, and guessing all three wastes the
# budget on the same person.
PARTICLES = {"van", "von", "de", "der", "den", "du", "des", "del", "della",
             "di", "da", "le", "la", "el", "al", "bin", "ben", "ter", "te"}


def _fold(text: str, german: bool = False) -> str:
    """A name as a mailbox spells it: lowercase, unaccented, letters only."""
    text = (text or "").strip().lower()
    if german:
        for char, replacement in UMLAUT.items():
            text = text.replace(char, replacement)
            text = text.replace(char.lower(), replacement)
    # NFKD splits e-acute into e plus an accent; dropping the accents leaves
    # the letter, which is what every mail admin in France has already done.
    text = "".join(c for c in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", text)


def split_name(full: str) -> Tuple[str, str]:
    """
    A full name into the two parts a pattern needs.

    Titles come attached -- "Dr. Anne Dupont", "Frau Meyer", "M. Jean Bernard
    Martin" -- and a middle name is not a surname. The last word is the
    surname unless a particle precedes it, in which case the particle joins it.
    """
    words = [w for w in re.split(r"\s+", (full or "").strip()) if w]
    words = [w for w in words
             if w.lower().strip(".") not in
             {"dr", "prof", "mr", "mrs", "ms", "m", "mme", "mlle", "herr",
              "frau", "monsieur", "madame", "dipl", "ing", "mag"}]
    if not words:
        return "", ""
    if len(words) == 1:
        return "", words[0]
    # Walk back over every particle, not just one: "van der Berg" is three
    # words of surname, and stopping at the first leaves "der Berg", which
    # folds to derberg and is nobody.
    start = len(words) - 1
    while start > 1 and words[start - 1].lower().strip(".") in PARTICLES:
        start -= 1
    return words[0], " ".join(words[start:])


def _parts(first: str, last: str, german: bool) -> Optional[Dict[str, str]]:
    f_first = _fold(first, german)
    f_last = _fold(last, german)
    if not f_last:
        return None
    if not f_first:
        # A surname with no first name fills only the templates that never ask
        # for one. Substituting the surname for the missing half produced
        # meyer.meyer@, which is not an address anybody has.
        return {"first": "", "last": f_last, "f": "", "l": f_last[0]}
    return {"first": f_first, "last": f_last, "f": f_first[0], "l": f_last[0]}


def apply_pattern(pattern: str, first: str, last: str, domain: str,
                  german: bool = False) -> str:
    """One named pattern, one address. Empty when the name cannot fill it."""
    template = PATTERN_BY_NAME.get(pattern)
    if not template or not domain:
        return ""
    parts = _parts(first, last, german)
    if not parts:
        return ""
    local = template.format(**parts)
    # An empty half leaves a template that renders to ".dupont" or "a.": a
    # shape, not an address.
    if not local or len(local) > 64 or not local[0].isalnum() or not local[-1].isalnum():
        return ""
    if not parts["first"] and ("{first}" in template or "{f}" in template):
        return ""
    return local + "@" + domain.lower().lstrip("@")


def candidates(first: str, last: str, domain: str, learned: str = "",
               limit: int = 5) -> List[Dict[str, str]]:
    """
    The addresses this person plausibly has, best first.

    Capped, and the cap is the point. Every candidate past the first is an
    SMTP question about a mailbox that probably does not exist, and a server
    asked six of those in a row stops answering -- which costs the answer
    about the one that was real. Five is the most this offers; a learned
    pattern shortens it to one.
    """
    domain = (domain or "").lower().lstrip("@").strip("/")
    if not domain or "." not in domain:
        return []

    german = domain.endswith((".de", ".at", ".ch"))
    out: List[Dict[str, str]] = []
    seen = set()

    def add(pattern: str, confidence: str) -> None:
        address = apply_pattern(pattern, first, last, domain, german)
        if address and address not in seen:
            seen.add(address)
            out.append({"email": address, "pattern": pattern,
                        "confidence": confidence})

    # A pattern read off a real address on this domain is not a guess, and it
    # is tried alone: offering the permutations behind it would spend the
    # server patience arguing with the evidence.
    if learned and learned in PATTERN_BY_NAME:
        add(learned, "learned")
        if out:
            return out

    for name, _ in PATTERNS:
        add(name, "guess")
        if len(out) >= max(1, limit):
            break

    # The German spelling of an umlaut is a convention, not a rule, so where
    # dropping it gives a different address that one is offered too.
    if german:
        plain_first, plain_last = _fold(first), _fold(last)
        if (plain_first, plain_last) != (_fold(first, True), _fold(last, True)):
            best = (learned if learned in PATTERN_BY_NAME else PATTERNS[0][0])
            address = apply_pattern(best, plain_first, plain_last, domain)
            if address and address not in seen:
                out.append({"email": address, "pattern": best,
                            "confidence": "spelling"})
    return out


def learn_pattern(email: str, first: str, last: str) -> str:
    """
    Which pattern produced this published address, if any of them did.

    Called with an address found on the site and the name of the person it
    belongs to. A match names the convention for the whole domain and turns
    every other guess about that company into a near-certainty.
    """
    email = (email or "").strip().lower()
    if "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    for german in (False, True):
        parts = _parts(first, last, german)
        if not parts:
            continue
        for name, template in PATTERNS:
            if template.format(**parts) == local:
                return name
    return ""


def infer_domain_pattern(addresses: List[str], people: List[str]) -> str:
    """
    The convention of a domain, from whatever it has published.

    Given the addresses a crawl found and the names it found alongside them,
    the first address that matches a name settles it. One match is enough:
    companies do not run two conventions, and a second opinion here costs a
    page read and changes nothing.
    """
    for address in addresses:
        for person in people:
            first, last = split_name(person)
            if not last:
                continue
            found = learn_pattern(address, first, last)
            if found:
                return found
    return ""


# A local part that is a job rather than a person. Seen on a domain, it says
# nothing about how people are named there -- info@ is info@ everywhere -- so
# the pattern learner has to skip them or it concludes that everyone at the
# company is called "contact".
ROLE_LOCALS = {
    "info", "kontakt", "contact", "office", "mail", "hello", "bonjour",
    "bewerbung", "recrutement", "jobs", "karriere", "career", "careers",
    "rh", "hr", "personal", "emploi", "empfang", "sekretariat", "team",
    "service", "sales", "vertrieb", "buchhaltung", "compta", "accueil",
}


def is_personal(email: str) -> bool:
    """Does this address name a person? Only those teach a pattern."""
    local = (email or "").split("@", 1)[0].lower()
    if not local or local in ROLE_LOCALS:
        return False
    # A dot or a hyphen between two word-ish halves is how a person is spelled.
    return bool(re.match(r"^[a-z]{1,20}[._-][a-z]{2,25}$", local)) or (
        len(local) > 4 and local not in ROLE_LOCALS and "." not in local
        and not any(role in local for role in ROLE_LOCALS))

