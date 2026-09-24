"""
The candidate, as the rest of the app knows him.

What is written below is the starting point, not the last word: anything edited
on the profile page is stored beside this file and laid over these values at
import time (see the bottom of the file). Editing here still works and is what
a fresh checkout gets.

`password` and `passwords` are the exception. They are read from here by the
apply engines and are deliberately not editable from the page and not sent to
any browser -- see `profile_store.SECRET`.
"""

import os

CANDIDATE_PROFILE = {
    "first_name": "Badreddine",
    "last_name": "Barki",
    "full_name": "Badreddine Barki",
    "email": "badreddinebarki@gmail.com",
    "password": "Open_up_for_Badr00@@",
    "passwords": [
        "Open_up_for_Badr00@@",
        "Open_up_for_Badr00",
        "Badreddine00++"
    ],
    "phone": "0033745768010",
    "phone_digits": "0033745768010",
    "phone_national": "0745768010",
    "phone_formatted": "+33 7 45 76 80 10",
    "address": "14 Rue de la 2e D.B.",
    "postal_code": "80000",
    "city": "Amiens",
    "country": "France",
    "full_address": "14 Rue de la 2e D.B., 80000 Amiens, France",
    "linkedin": "https://www.linkedin.com/in/barki-badreddine-bb2328146",
    "website": "https://barkibadreddine.com",
    "current_title": "Ingénieur en Génie Mécanique",
    "years_of_experience": 3.5,
    "education": [
        {
            "degree": "Master en Génie Mécanique (Matériaux, Structures, Fiabilité et Machines)",
            "institution": "École Universitaire de Physique et d'Ingénierie, Université Clermont Auvergne",
            "location": "Clermont-Ferrand, France",
            "period": "2020 - 2022"
        },
        {
            "degree": "Diplôme d'Ingénieur en Industrialisation des Produits et Procédés",
            "institution": "École Nationale Supérieure d'Arts et Métiers (ENSAM)",
            "location": "Meknès, Maroc",
            "period": "2015 - 2020"
        }
    ],
    "experiences": [
        {
            "role": "Ingénieur de Recherche et Développement Mécanique",
            "company": "SLB GROUP",
            "location": "Abbeville, France",
            "period": "Mars 2022 - Juillet 2025",
            "highlights": [
                "Conception CAO 3D (SolidWorks, CATIA V5, Creo), cotation fonctionnelle GPS",
                "Modélisation FEA Abaqus & automatisation Python/C++ sur +100 configurations",
                "Essais physiques, corrélation métrologie optique DIC et validation V&V",
                "Analyse de défaillances DFMEA/RCA et qualification fournisseurs"
            ]
        },
        {
            "role": "Ingénieur d'Études R&D en Simulation & Capteurs (Stage fin d'études)",
            "company": "Sigma",
            "location": "Clermont-Ferrand, France",
            "period": "Mars 2021 - Septembre 2021",
            "highlights": [
                "Simulation multiphysique COMSOL/Ansys thermomécanique",
                "Traitement de signaux dynamiques et analyse vibratoire Python/MATLAB",
                "Surveillance de Santé des Structures (SHM) par capteurs de déformation"
            ]
        }
    ],
    "technical_skills": [
        "Conception mécanique 3D", "SolidWorks", "CATIA V5", "PTC Creo", "Siemens NX",
        "Calcul de structures", "Éléments Finis (FEA)", "Abaqus", "Ansys", "COMSOL Multiphysics",
        "Cotation fonctionnelle (GPS)", "Tolérancement", "Plans de fabrication", "DfM/DfAM",
        "Métrologie optique (DIC)", "Instrumentation d'essais", "Validation V&V",
        "DFMEA", "RCA (Root Cause Analysis)", "Python (NumPy, SciPy)", "MATLAB", "C/C++"
    ],
    "languages": {
        "Français": "C1 (Courant / Professionnel - TCF)",
        "Anglais": "C2 (Bilingue - EF SET 74/100)",
        "Arabe": "Maternelle"
    },
    "resumes": {
        "fr": os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf")),
        "en": os.getenv("CANDIDATE_CV_EN", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))),
    }
}


# The edits from the profile page, laid over the defaults above. In place, so
# that `from ... import CANDIDATE_PROFILE` anywhere else sees them too.
try:
    from services.automation import profile_store as _profile_store
    _profile_store.apply_to(CANDIDATE_PROFILE)
except Exception:
    # An unreadable overlay leaves the defaults standing, which is a working
    # profile. Failing here would take the apply engine down with it.
    pass


def reload_profile() -> dict:
    """Re-read the overlay after the profile page has written to it."""
    from services.automation import profile_store as store
    return store.apply_to(CANDIDATE_PROFILE)
