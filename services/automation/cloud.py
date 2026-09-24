# -*- coding: utf-8 -*-
"""
Supabase, as the one place data actually lives.

Everything in this project used to be a file next to the code: the profile in
profile.json, the held documents in a folder with an index.json beside them,
the ledger in a .jsonl. That works exactly as long as the app runs on the
machine that owns the disk. Deployed, it is data loss waiting for a restart,
and with two people using it, it is also two people sharing one folder.

So: rows in Postgres, bytes in Storage, and this module is the only thing that
talks to either. Two rules it exists to enforce.

  * The service-role key never leaves the server. It bypasses row-level
    security by design, which is why the browser is given signed URLs with an
    expiry instead, and why the tables have RLS on with no policies -- the
    anon key in the web bundle can read none of them.
  * Reads degrade, writes do not. A listing that cannot reach Postgres returns
    nothing and the caller falls back to its local copy; an upload that cannot
    reach Storage raises, because the alternative is telling someone their
    passport scan was kept when it was not.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from services.automation.config import load_env


class CloudError(RuntimeError):
    """A write that did not happen. Never swallowed."""


def _url() -> str:
    load_env()
    return (os.getenv("SUPABASE_URL") or "").rstrip("/")


def _key() -> str:
    load_env()
    return (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()


def enabled() -> bool:
    return bool(_url() and _key())


def _headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    key = _key()
    head = {"apikey": key, "Authorization": "Bearer " + key}
    head.update(extra or {})
    return head


def _rest(table: str) -> str:
    return _url() + "/rest/v1/" + quote(table)


# --- rows -----------------------------------------------------------------

def select(table: str, order: str = "", limit: int = 0,
           **eq: Any) -> List[Dict[str, Any]]:
    """Rows matching every `eq`. An empty list also means "could not ask"."""
    if not enabled():
        return []
    import requests

    params: Dict[str, str] = {"select": "*"}
    for column, value in eq.items():
        params[column] = "eq." + str(value)
    if order:
        params["order"] = order
    if limit:
        params["limit"] = str(limit)
    try:
        response = requests.get(_rest(table), headers=_headers(), params=params,
                                timeout=15)
        if response.status_code != 200:
            return []
        data = response.json()
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001 - a read is allowed to fail quietly
        return []


def upsert(table: str, row: Dict[str, Any]) -> Dict[str, Any]:
    if not enabled():
        return {}
    import requests

    try:
        response = requests.post(
            _rest(table), headers=_headers({
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=representation"}),
            json=row, timeout=20)
    except Exception as error:  # noqa: BLE001
        raise CloudError("Supabase is unreachable: " + str(error)[:160])
    if response.status_code not in (200, 201):
        raise CloudError("Supabase refused the row: "
                         + str(response.status_code) + " " + response.text[:200])
    data = response.json()
    return data[0] if isinstance(data, list) and data else (data or {})


def patch(table: str, values: Dict[str, Any], **eq: Any) -> List[Dict[str, Any]]:
    if not enabled():
        return []
    import requests

    params = {c: "eq." + str(v) for c, v in eq.items()}
    try:
        response = requests.patch(
            _rest(table), headers=_headers({
                "Content-Type": "application/json",
                "Prefer": "return=representation"}),
            params=params, json=values, timeout=20)
    except Exception as error:  # noqa: BLE001
        raise CloudError("Supabase is unreachable: " + str(error)[:160])
    if response.status_code not in (200, 204):
        raise CloudError("Supabase refused the change: "
                         + str(response.status_code) + " " + response.text[:200])
    try:
        data = response.json()
    except Exception:  # noqa: BLE001
        return []
    return data if isinstance(data, list) else []


def delete(table: str, **eq: Any) -> bool:
    if not enabled():
        return False
    import requests

    params = {c: "eq." + str(v) for c, v in eq.items()}
    try:
        response = requests.delete(_rest(table), headers=_headers(), params=params,
                                   timeout=20)
    except Exception as error:  # noqa: BLE001
        raise CloudError("Supabase is unreachable: " + str(error)[:160])
    if response.status_code not in (200, 204):
        raise CloudError("Supabase refused the delete: "
                         + str(response.status_code) + " " + response.text[:200])
    return True


# --- bytes ----------------------------------------------------------------

# Private. Signed URLs only. The three older buckets in this project are public,
# and nothing identifying goes in them.
BUCKET = "candidate-documents"


def _object(bucket: str, path: str) -> str:
    return _url() + "/storage/v1/object/" + quote(bucket) + "/" + quote(path)


def upload(path: str, data: bytes, mime: str = "application/octet-stream",
           bucket: str = BUCKET) -> str:
    if not enabled():
        return ""
    import requests

    try:
        response = requests.post(
            _object(bucket, path),
            headers=_headers({"Content-Type": mime, "x-upsert": "true"}),
            data=data, timeout=120)
    except Exception as error:  # noqa: BLE001
        raise CloudError("The file did not reach Supabase: " + str(error)[:160])
    if response.status_code not in (200, 201):
        raise CloudError("Supabase refused the file: "
                         + str(response.status_code) + " " + response.text[:200])
    return path


def download(path: str, bucket: str = BUCKET) -> bytes:
    if not enabled():
        return b""
    import requests

    try:
        response = requests.get(_object(bucket, path), headers=_headers(), timeout=60)
    except Exception:  # noqa: BLE001
        return b""
    return response.content if response.status_code == 200 else b""


def remove_object(path: str, bucket: str = BUCKET) -> bool:
    if not enabled():
        return False
    import requests

    try:
        response = requests.delete(_object(bucket, path), headers=_headers(), timeout=30)
    except Exception:  # noqa: BLE001
        return False
    return response.status_code in (200, 204)


def signed_url(path: str, seconds: int = 300, bucket: str = BUCKET) -> str:
    """A link that works for `seconds` and then does not. Never a public URL."""
    if not enabled():
        return ""
    import requests

    try:
        response = requests.post(
            _url() + "/storage/v1/object/sign/" + quote(bucket) + "/" + quote(path),
            headers=_headers({"Content-Type": "application/json"}),
            json={"expiresIn": int(seconds)}, timeout=20)
    except Exception:  # noqa: BLE001
        return ""
    if response.status_code != 200:
        return ""
    signed = str((response.json() or {}).get("signedURL") or "")
    return (_url() + "/storage/v1" + signed) if signed.startswith("/") else signed
