# -*- coding: utf-8 -*-
"""A small, fast LLM for the two things a regex cannot do.

Two jobs, both narrow.

  1. Find the control that opens the application form when the pattern list
     does not recognise it. Boards write that button in whatever language the
     office speaks -- "Je suis interesse(e)", "Ik ben geinteresseerd", "Jetzt
     bewerben" -- and one missing phrase means the whole run is reported as
     "no application form could be reached" when the form was one click away.

  2. Map the candidate's own stored facts onto fields whose labels the
     semantic matcher does not know, including dropdowns, which the engine
     could not fill at all.

What it is forbidden to do matters more than what it does.

It never invents a fact about the candidate. It is handed the profile and told
to return null for anything the profile does not answer, because a value that
is not in the profile is a sentence a machine made up and sent to an employer
under a real person's name. Whole categories never reach it at all (see
SENSITIVE_PATTERN): sponsorship, work authorisation, salary, notice period,
disability, criminal record, demographics. Those answers carry legal or
contractual weight, a wrong one is a misrepresentation on a job application,
and no amount of model quality makes guessing at them acceptable. They stay
empty and get reported to the candidate to answer.

Every call is time-boxed and every failure is survivable. The brain improves a
run; it is never load-bearing. If Fuelix is slow or down the engine carries on
down the deterministic path exactly as it did before.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Dict, List, Optional

import requests

from .config import (
    FUELIX_API_KEY,
    FUELIX_BASE_URL,
    FUELIX_BRAIN,
    FUELIX_BRAIN_FALLBACK,
)

# A browser is idle while these run, so the budget is small. A slow answer is
# worth less than an early one plus the deterministic fallback.
TIMEOUT_S = 18

# Questions the model is never shown, let alone allowed to answer. Each of
# these is a statement the candidate makes to an employer that can be held
# against them: immigration status, pay expectations, a declared disability, a
# criminal record. If the profile does not answer it deterministically, the
# honest output is a blank and a note to the candidate.
SENSITIVE_PATTERN = re.compile(
    r"(sponsor|visa|work\s*(permit|authoriz|authoris)|right\s*to\s*work|legally\s*(able|entitled)|"
    r"disab|veteran|ethnic|\brace\b|gender|sexual|pronoun|"
    r"criminal|conviction|felony|background\s*check|drug\s*test|security\s*clearance|"
    r"salary|compensation|desired\s*pay|expected\s*pay|remuneration|pretention|"
    r"notice\s*period|preavis|"
    r"date\s*of\s*birth|birth\s*date|social\s*security|nationalit)",
    re.I,
)

# Free text long enough to be an essay is a different kind of answer: it is the
# candidate's voice, not a fact lookup. Left alone here.
MAX_VALUE_CHARS = 120


def _grounded(value: Any) -> Optional[str]:
    """A usable answer, or None. Everything doubtful becomes None."""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text or len(text) > MAX_VALUE_CHARS:
        return None
    # Models sometimes say "unknown" or "N/A" in words instead of returning
    # null. Typed into a form, those read as a real answer from the candidate.
    if text.lower() in {
        "null", "none", "n/a", "na", "unknown", "not specified", "not provided",
        "not available", "-", "--", "tbd", "undefined",
    }:
        return None
    return text


class ApplyBrain:
    """Fast, optional, and never trusted with a fact it was not given."""

    def __init__(
        self,
        model: str = "",
        fallback: str = "",
        on_log: Optional[Any] = None,
    ) -> None:
        self.base_url = FUELIX_BASE_URL.rstrip("/")
        self.api_key = FUELIX_API_KEY
        self.model = model or FUELIX_BRAIN
        self.fallback = fallback or FUELIX_BRAIN_FALLBACK
        # Refusals are the most useful thing this class produces, and they used
        # to go only to a server console. A candidate who can see "left Salary
        # Expectation empty -- not in your profile" knows both what happened and
        # what to do about it.
        self.on_log = on_log

    def _log(self, text: str) -> None:
        print(f"[brain] {text}", flush=True)
        if not self.on_log:
            return
        try:
            self.on_log(text)
        except Exception:
            pass

    def available(self) -> bool:
        return bool(self.api_key and len(self.api_key.strip()) > 5)

    # -- transport ---------------------------------------------------------

    def _ask(self, system: str, user: str, max_tokens: int = 900) -> Optional[Dict[str, Any]]:
        """One JSON answer, or None. Never raises: the caller has a fallback."""
        if not self.available():
            return None
        for model in (self.model, self.fallback):
            if not model:
                continue
            try:
                response = requests.post(
                    f"{self.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": model,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                        "temperature": 0,
                        "max_tokens": max_tokens,
                    },
                    timeout=TIMEOUT_S,
                )
                if response.status_code != 200:
                    print(f"[brain] {model} HTTP {response.status_code}", flush=True)
                    continue
                content = response.json()["choices"][0]["message"]["content"]
                parsed = _parse_json(content)
                if parsed is not None:
                    return parsed
                print(f"[brain] {model} returned non-JSON", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[brain] {model} failed: {exc}", flush=True)
        return None

    # -- 1. which control opens the form -----------------------------------

    def choose_apply_control(
        self,
        controls: List[Dict[str, Any]],
        job_title: str = "",
    ) -> int:
        """Index of the control that opens the application form, or -1.

        Uses Fuelix AI to identify the correct apply button across any language
        and layout, evaluating both control text and href targets.
        """
        if not controls:
            return -1

        listing = "\n".join(
            f"{item['index']} | <{item.get('tag', '?')}> | \"{item.get('text', '')[:90]}\" | href=\"{item.get('href', '')[:120]}\""
            for item in controls
        )
        system = (
            "You are looking at interactive buttons and links on an employer job page.\n"
            "Pick the ONE control that starts, opens, or navigates to the application form for this job.\n"
            "Common apply phrasing in various languages includes:\n"
            "- Dutch: Online solliciteren, Solliciteer direct, Direct solliciteren, Solliciteren, Ik wil solliciteren\n"
            "- French: Postuler, Candidater, Déposer ma candidature, Je postule, Je suis intéressé(e)\n"
            "- English: Apply now, Apply for this job, Apply online, Easy Apply, Start application\n"
            "- German: Jetzt bewerben, Bewerben, Online bewerben\n"
            "- Italian/Spanish: Candidati, Postularme, Inscribirme\n"
            "- Or links whose href contains '/solliciteren', '/apply', '/candidature', etc.\n"
            "NEVER pick: submit / verzenden / envoyer (only pick controls that OPEN the form), "
            "refer a friend / recommander un(e) ami(e), share, save, job alerts, cookie or consent banners, login/register, or navigation bars.\n"
            "If none of them opens the application form, answer -1.\n"
            'Reply with JSON only: {"index": <number>, "reason": "<short explanation>"}'
        )
        user = f"Job: {job_title or 'unknown'}\n\nControls:\n{listing}"

        answer = self._ask(system, user, max_tokens=150)
        if not answer:
            return -1
        try:
            index = int(answer.get("index", -1))
        except (TypeError, ValueError):
            return -1

        if any(item["index"] == index for item in controls):
            reason = answer.get("reason", "")
            if reason:
                self._log(f"Fuelix AI chose apply control #{index} ('{controls[index].get('text', '')[:40]}'): {reason}")
            return index
        return -1

    def decide_next_step(
        self,
        page_url: str,
        page_title: str,
        job_title: str,
        has_form_fields: bool,
        interactive_controls: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Asks Fuelix AI Brain to decide the next action in the application workflow."""
        if not self.available() or not interactive_controls:
            return {"action": "fill" if has_form_fields else "unknown"}

        listing = "\n".join(
            f"{item['index']} | <{item.get('tag', '?')}> | \"{item.get('text', '')[:90]}\" | href=\"{item.get('href', '')[:100]}\""
            for item in interactive_controls[:40]
        )
        system = (
            "You are an expert autonomous job application AI agent driving a browser.\n"
            "Analyze the current page and decide the optimal next step to reach and submit the application.\n"
            "Valid actions:\n"
            '- "click_apply": click the apply button to reach/open the application form (specify "index")\n'
            '- "fill_form": the application form is already open and ready for filling\n'
            '- "next_step": click a next/continue button on a multi-step form (specify "index")\n'
            '- "submit": the form is fully completed and ready for submission (specify "index")\n'
            '- "already_applied": the page indicates this job was already applied to\n'
            'Reply with JSON only: {"action": "<action>", "index": <number_or_null>, "reason": "<explanation>"}'
        )
        user = (
            f"Page URL: {page_url}\n"
            f"Page Title: {page_title}\n"
            f"Job Title: {job_title}\n"
            f"Has Form Fields on page: {has_form_fields}\n\n"
            f"Controls:\n{listing}"
        )
        answer = self._ask(system, user, max_tokens=180)
        return answer or {"action": "fill" if has_form_fields else "unknown"}

    # -- 2. answers to fields the matcher did not recognise -----------------

    def answer_fields(
        self,
        fields: List[Dict[str, Any]],
        profile: Dict[str, Any],
    ) -> Dict[str, str]:
        """Profile-backed answers, keyed by field key. Unanswerable ones are absent.

        Sensitive fields are removed before the request is built, so the model
        never sees them and cannot answer them even if it wanted to.
        """
        askable = []
        withheld = []
        for f in fields:
            (withheld if SENSITIVE_PATTERN.search(f.get("label", "")) else askable).append(f)

        # Worth saying out loud. These fields are left blank by design, not
        # missed, and without a line here the candidate sees an empty
        # "Salary Expectation" and reasonably concludes the thing is broken.
        if withheld:
            labels = ", ".join(str(f.get("label", ""))[:32] for f in withheld[:4])
            more = f" (+{len(withheld) - 4} more)" if len(withheld) > 4 else ""
            self._log(f"Not answering for you: {labels}{more} - these are yours to state")

        if not askable:
            return {}

        system = (
            "You are completing a job application form for ONE real candidate, "
            "using ONLY the facts in the profile you are given.\n"
            "Return null for any field the profile does not answer. Never guess, "
            "never approximate, never fill a plausible-sounding placeholder: an "
            "invented answer is sent to an employer as a statement by this person.\n"
            "For a 'select' field the value MUST be copied exactly from that "
            "field's options list, or be null.\n"
            "Answer in the language of the field label.\n"
            'Reply with JSON only: {"answers": [{"key": "...", "value": "..." or null}]}'
        )
        user = json.dumps({"profile": profile, "fields": askable}, ensure_ascii=False)

        answer = self._ask(system, user, max_tokens=1400)
        if not answer:
            return {}

        by_key = {f["key"]: f for f in askable}
        results: Dict[str, str] = {}
        for item in answer.get("answers") or []:
            if not isinstance(item, dict):
                continue
            key = str(item.get("key", ""))
            field = by_key.get(key)
            if not field:
                continue
            value = _grounded(item.get("value"))
            if value is None:
                continue
            options = field.get("options") or []
            if options:
                # A dropdown can only hold one of its own options. Match
                # loosely, then hand back the page's exact spelling, because
                # selecting by an approximation silently selects nothing.
                exact = _match_option(value, options)
                if exact is None:
                    continue
                value = exact

            # The model's own restraint is not the safeguard. This is.
            if not traceable_to_profile(value, profile):
                self._log(
                    f"Left {field.get('label', key)[:40]} empty - "
                    f"\"{value[:40]}\" is not in your profile"
                )
                continue

            results[key] = value
        return results


def _normalise(text: Any) -> str:
    """Letters and digits only, lowercased, accents folded.

    Accents are decomposed rather than deleted, so "Ingenieur" still matches a
    profile that says "Ingenieur" with the accents on. Stripping the accented
    character outright turned it into "ingnieur" and made a correct answer
    untraceable.
    """
    folded = unicodedata.normalize("NFKD", str(text))
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]", "", folded.lower())


def traceable_to_profile(value: str, profile: Dict[str, Any]) -> bool:
    """Whether this answer can be traced back to something the candidate stated.

    The prompt tells the model to return null when the profile has no answer,
    and the models tested here do comply. That is not good enough to rely on. A
    language model's job is to produce a plausible continuation, and "Renault"
    is a very plausible continuation of "Most Recent Employer" for a French
    mechanical engineer. Plausible is precisely the failure mode: it is a
    fabricated employment claim, on a real job application, in someone's name,
    and it would read as perfectly normal in a screenshot.

    So the answer is checked rather than trusted. A value survives only if some
    profile field contains it, or is contained in it, once formatting is
    stripped -- which allows "France" for a "Pays" dropdown rendered as
    "France (FR)", and "+33 7 45 76 80 10" for a phone stored as
    "0033745768010", while rejecting anything the candidate never said.

    The cost of this is real and worth stating: it also rejects correct
    inferences, like deriving a country from a city. That is the right trade.
    An empty field is visible, and the candidate fixes it in ten seconds; an
    invented one is invisible, and they find out in an interview.
    """
    target = _normalise(value)
    if len(target) < 2:
        return False

    sources = [_normalise(raw) for raw in profile.values()]
    sources = [s for s in sources if len(s) >= 2]

    if any(target == source for source in sources):
        return True

    # Below three characters, only an exact match counts. "No" as an answer to
    # "Do you require sponsorship?" is two letters that will turn up inside
    # some profile field sooner or later, and it is a legally material claim.
    if len(target) < 3:
        return False

    for source in sources:
        # Overlap has to be most of the longer string, in whichever direction.
        # Plain containment let "LinkedIn" pass as an answer to "How did you
        # hear about us?" -- because those eight letters sit inside the
        # candidate's LinkedIn profile URL. So did "B2" as a claimed English
        # level, hiding in the same URL's id. Both would have been typed onto
        # an application as statements the candidate never made.
        if target in source or source in target:
            if min(len(target), len(source)) >= 0.5 * max(len(target), len(source)):
                return True
    return False


def _match_option(value: str, options: List[str]) -> Optional[str]:
    """The option the model meant, in the page's own spelling, or None."""
    wanted = value.strip().lower()
    for option in options:
        if option.strip().lower() == wanted:
            return option
    for option in options:
        text = option.strip().lower()
        if text and (text in wanted or wanted in text):
            return option
    return None


def _parse_json(raw: str) -> Optional[Dict[str, Any]]:
    """Parse a reply, tolerating the code fences some models insist on."""
    text = (raw or "").strip()
    if text.startswith("```"):
        parts = text.split("```")
        if len(parts) >= 2:
            text = parts[1]
            if text.lstrip().lower().startswith("json"):
                text = text.lstrip()[4:]
    text = text.strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        return None
