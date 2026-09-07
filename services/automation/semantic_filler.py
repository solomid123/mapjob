# -*- coding: utf-8 -*-
"""
Semantic Form Filler & Question Reasoner.
Maps arbitrary DOM form fields, inputs, dropdowns, and checkboxes to the candidate profile
using fast deterministic regex tiers and Fuelix AI fallback for custom screening questions.
"""

import re
import json
from typing import Dict, Any, Optional, Tuple

FIELD_PATTERNS = {
    "first_name": [
        r"first.*name", r"prénom", r"given.*name", r"fname", r"vorname"
    ],
    "last_name": [
        r"last.*name", r"^nom$", r"nom.*famille", r"family.*name", r"surname", r"lname", r"nachname"
    ],
    "full_name": [
        r"full.*name", r"nom.*complet", r"^name$", r"^nom$"
    ],
    "email": [
        r"e-?mail", r"courriel", r"adresse.*mail"
    ],
    "phone": [
        r"phone", r"téléphone", r"telephone", r"mobile", r"portable", r"numéro", r"tel"
    ],
    "postal_code": [
        r"postal", r"zip", r"code.*postal", r"postleitzahl"
    ],
    "city": [
        r"city", r"ville", r"commune", r"ort", r"location"
    ],
    "address": [
        r"address", r"adresse", r"street", r"rue"
    ],
    "linkedin": [
        r"linkedin", r"profil.*linkedin"
    ],
    "github": [
        r"github"
    ],
    "salary": [
        r"salary", r"salaire", r"compensation", r"rémunération", r"pretension"
    ],
    "resume": [
        r"resume", r"cv", r"curriculum", r"file", r"fichier", r"document", r"pièce.*jointe"
    ]
}

def match_semantic_field(label: str, name: str = "", placeholder: str = "", field_id: str = "") -> Optional[str]:
    """Matches form input metadata to a semantic field key."""
    combined = f"{label} {name} {placeholder} {field_id}".lower().strip()

    # Priority check: File upload / CV
    if any(re.search(p, combined) for p in FIELD_PATTERNS["resume"]):
        return "resume"

    for field_key, patterns in FIELD_PATTERNS.items():
        if field_key == "resume":
            continue
        for pat in patterns:
            if re.search(pat, combined):
                return field_key

    return None

def answer_screening_question(
    question_text: str,
    candidate_vault: Dict[str, Any],
    fuelix_client: Optional[Any] = None
) -> str:
    """
    Answers common ATS screening questions deterministically, or invokes Fuelix AI as fallback.
    """
    q_lower = question_text.lower()
    pre_answered = candidate_vault.get("pre_answered_questions", {})

    # 1. Visa & Sponsorship
    if any(w in q_lower for w in ["sponsor", "visa", "parrainage"]):
        return "Non"

    # 2. Work Authorization / Permis de travail
    if any(w in q_lower for w in ["authorized", "autoris", "légalement", "right to work", "permis de travail"]):
        return "Oui"

    # 3. Driver's License / Permis de conduire
    if any(w in q_lower for w in ["permis", "driver", "licence", "permis b"]):
        return "Oui"

    # 4. Relocation / Déménagement
    if any(w in q_lower for w in ["relocat", "déménag", "mobilité"]):
        return "Oui"

    # 5. Notice Period / Préavis
    if any(w in q_lower for w in ["préavis", "notice", "disponibilité", "availability"]):
        return "1 mois"

    # 6. Experience with CAD / SolidWorks / CATIA
    if "solidworks" in q_lower:
        return "4"
    if "catia" in q_lower:
        return "3"
    if "ansys" in q_lower or "fea" in q_lower or "calcul" in q_lower:
        return "4"
    if "cad" in q_lower or "cao" in q_lower:
        return "4"

    # 7. AI Fallback for bespoke open-ended questions
    if fuelix_client:
        system_prompt = (
            "You are Badreddine Barki, a French-fluent Mechanical & Mechatronics R&D Engineer "
            "with 4 years of experience at Technip Energies. Answer the application question truthfully, "
            "concisely (1-2 sentences), professional, in the language of the question. Never hallucinate fake credentials."
        )
        user_prompt = f"Candidate Profile:\n{json.dumps(candidate_vault, ensure_ascii=False)}\n\nQuestion:\n{question_text}"
        try:
            answer = fuelix_client.query_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt + "\nReturn JSON format: {\"answer\": \"your brief text\"}"
            )
            if answer and "answer" in answer:
                return str(answer["answer"])
        except Exception:
            pass

    return "Oui"
