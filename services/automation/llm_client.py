"""Single LLM entry-point for all automation. Fuelix only (OpenAI-compatible).

Planner model = fast per-step DOM decisions.
Writer model  = quality motivation letters / form mapping.
"""
import json
import re
import time
from typing import Any, Dict, List, Optional

import requests

from .config import (
    FUELIX_API_KEY,
    FUELIX_BASE_URL,
    FUELIX_PLANNER,
    FUELIX_PLANNER_FALLBACK,
    FUELIX_WRITER,
    FUELIX_WRITER_FALLBACK,
)


def _strip_code_fences(text: str) -> str:
    if "```json" in text:
        return text.split("```json", 1)[1].split("```", 1)[0].strip()
    if "```" in text:
        parts = text.split("```")
        if len(parts) >= 3:
            return parts[1].strip()
    return text.strip()


class FuelixClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        planner: Optional[str] = None,
        writer: Optional[str] = None,
    ):
        self.base_url = (base_url or FUELIX_BASE_URL).rstrip("/")
        self.api_key = api_key or FUELIX_API_KEY
        self.planner = planner or FUELIX_PLANNER
        self.planner_fallback = FUELIX_PLANNER_FALLBACK
        self.writer = writer or FUELIX_WRITER
        self.writer_fallback = FUELIX_WRITER_FALLBACK

    def has_credentials(self) -> bool:
        return bool(self.api_key and len(self.api_key.strip()) > 5)

    def _post(self, model: str, messages: List[Dict[str, str]], temperature: float,
              max_tokens: int, timeout: int = 30, retries: int = 1) -> Optional[str]:
        if not self.has_credentials():
            return None
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        last_err: Optional[str] = None
        for attempt in range(retries + 1):
            try:
                resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
                if resp.status_code == 200:
                    return resp.json()["choices"][0]["message"]["content"].strip()
                last_err = f"HTTP {resp.status_code}: {resp.text[:300]}"
                # Fallback model on 404 (unknown model) or 429/5xx
                break
            except Exception as e:  # noqa: BLE001 - surfacing as log, caller falls back
                last_err = str(e)
                time.sleep(1)
        if last_err:
            print(f"[Fuelix] {model} failed: {last_err}")
        return None

    def _chat_with_fallback(self, primary: str, fallback: str, messages: List[Dict[str, str]],
                            temperature: float, max_tokens: int, timeout: int = 30) -> Optional[str]:
        out = self._post(primary, messages, temperature, max_tokens, timeout)
        if out:
            return out
        if fallback and fallback != primary:
            print(f"[Fuelix] Trying fallback model: {fallback}")
            return self._post(fallback, messages, temperature, max_tokens, timeout)
        return None

    def chat_text(self, system: str, user: str, task: str = "planner",
                  temperature: float = 0.2, max_tokens: int = 800,
                  timeout: int = 30) -> Optional[str]:
        primary = self.writer if task == "writer" else self.planner
        fallback = self.writer_fallback if task == "writer" else self.planner_fallback
        return self._chat_with_fallback(
            primary, fallback,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            temperature, max_tokens, timeout,
        )

    def chat_json(self, system: str, user: str, task: str = "planner",
                  temperature: float = 0.1, max_tokens: int = 1200,
                  timeout: int = 30) -> Optional[Dict[str, Any]]:
        raw = self.chat_text(system, user, task=task, temperature=temperature,
                             max_tokens=max_tokens, timeout=timeout)
        if not raw:
            return None
        try:
            return json.loads(_strip_code_fences(raw))
        except Exception:
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group(0))
                except Exception:
                    pass
            print(f"[Fuelix] Non-JSON response: {raw[:300]}")
            return None


# Shared singleton for automation code
default_client = FuelixClient()
