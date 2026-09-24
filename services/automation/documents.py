# -*- coding: utf-8 -*-
"""
Where a job's own CV and letter live.

One folder per job id, holding the HTML that was generated, the PDF that was
rendered from it, and a meta.json saying when, from which master, in which
language, and what the tailoring changed. The folder is the record: if the
PDF is there, that is the file that was attached, and it can be reopened a
month later and read.

Deliberately on disk rather than in a bucket. A tailored CV is a home address,
a phone number and an employment history in one file; the three Supabase
buckets in this project are still `public: true`, and a public bucket is a URL
away from being a search result. Moving these there is a decision to make on
purpose, with signed URLs, not a default.

The directory is gitignored for the same reason.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(os.getenv("TAILORED_DOCUMENTS_DIR",
                      str(Path(__file__).resolve().parent / "documents")))

# What a job id is allowed to be once it is a folder name. Job ids come from
# boards and end up in paths, so anything that could climb out of ROOT is
# replaced rather than rejected: a listing with an odd id still deserves a CV.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

# A German application is more than a CV and a letter: it opens on a cover
# sheet, and it is often sent as one bound file. Both are written here beside
# the other two, so /api/documents can serve them and a folder from six months
# ago still holds everything that went out.
KINDS = ("cv", "letter", "deckblatt", "dossier")


def slug(job_id: str) -> str:
    cleaned = _UNSAFE.sub("-", (job_id or "").strip()).strip("-.")
    return (cleaned or "unknown")[:120]


def owner(user: str = "") -> str:
    """
    Whose shelf. A folder per account, never one pile.

    Two people use this app for opposite searches, and a job id is a board's
    id: the same listing tailored by both of them is one folder, and the second
    run overwrites the first. Worse, the Tailoring pane lists what is on disk,
    so her page opened on his fourteen French CVs. So the account is part of
    the path, and nothing here can be read or written without one.
    """
    from services.automation import people
    return people.resolve(user)


# The folders written before there were accounts belong to the account there
# was then. They are moved once, under a marker, rather than left where they
# are: left there they are nobody's, and `list_documents` for the default
# account would have to read the whole root to find them -- which is the pile
# this split exists to end.
_SETTLED = ".by-account"

# Folders under ROOT that are not job folders and never move. `library` is the
# held-documents store, which files itself per account already and whose own
# root would otherwise be swept into one person's shelf -- taking the other
# person's diplomas with it.
_NOT_A_JOB = {"library", "packs", "fonts", ".misfiled"}


def _whose(job_folder: str) -> str:
    """
    The account a legacy job folder belonged to, as far as it can be told.

    A spontaneous application is named after the prospect it was written for
    -- `outreach-123` -- and that prospect has an owner, so those can be filed
    correctly rather than by default. Everything else predates the split and
    goes to the account that existed then. Failing to read the ledger is not a
    reason to stop moving files, so it falls back too.
    """
    from services.automation import people
    if job_folder.startswith("outreach-"):
        tail = job_folder[len("outreach-"):]
        if tail.isdigit():
            try:
                from services.automation import outreach_store
                with outreach_store.connect() as conn:
                    row = conn.execute("SELECT user FROM prospects WHERE id=?",
                                       (int(tail),)).fetchone()
                if row is not None and (row["user"] or "").strip():
                    return people.resolve(row["user"])
            except Exception:  # noqa: BLE001
                pass
    return people.DEFAULT


def _settle() -> None:
    if (ROOT / _SETTLED).exists() or not ROOT.exists():
        return
    from services.automation import people

    stuck = False
    for child in sorted(ROOT.iterdir()):
        if not child.is_dir() or child.name in people.FALLBACK:
            continue
        if child.name in _NOT_A_JOB:
            continue
        # A job folder holds files; an account shelf holds folders. Anything
        # that is neither is left exactly where it is.
        if not any(f.is_file() for f in child.iterdir()):
            continue
        home = ROOT / _whose(child.name)
        home.mkdir(parents=True, exist_ok=True)
        target = home / child.name
        if target.exists():
            continue
        try:
            child.rename(target)
        except OSError:
            # A file open in a viewer, a folder on another volume: leave it and
            # carry on with the rest. The marker is not written, so the next
            # call comes back for it.
            stuck = True
    if stuck:
        return
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / _SETTLED).write_text(
        "Tailored documents are filed per account from here on.\n", encoding="utf-8")


def shelf(user: str = "") -> Path:
    _settle()
    return ROOT / owner(user)


def folder(job_id: str, user: str = "") -> Path:
    return shelf(user) / slug(job_id)


def path_for(job_id: str, kind: str, ext: str, user: str = "") -> Path:
    return folder(job_id, user) / f"{kind}.{ext}"


def _write_atomic(path: Path, data: bytes) -> None:
    """
    Same directory, then replace. A half-written PDF that still has yesterday's
    name is worse than no PDF, because it gets attached.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".part")
    try:
        with os.fdopen(handle, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_text(job_id: str, kind: str, ext: str, text: str, user: str = "") -> Path:
    path = path_for(job_id, kind, ext, user)
    _write_atomic(path, text.encode("utf-8"))
    return path


def write_bytes(job_id: str, kind: str, ext: str, data: bytes, user: str = "") -> Path:
    path = path_for(job_id, kind, ext, user)
    _write_atomic(path, data)
    return path


def save_meta(job_id: str, meta: Dict, user: str = "") -> Dict:
    meta = dict(meta)
    meta.setdefault("job_id", job_id)
    meta.setdefault("created_at", time.strftime("%Y-%m-%dT%H:%M:%S"))
    meta["epoch"] = time.time()
    meta["user"] = owner(user)
    meta["files"] = files_present(job_id, user)
    _write_atomic(folder(job_id, user) / "meta.json",
                  json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))
    return meta


def files_present(job_id: str, user: str = "") -> Dict[str, str]:
    """Which of the four files actually exist, as URLs the page can open."""
    who = owner(user)
    here = folder(job_id, who)
    out: Dict[str, str] = {}
    for kind in KINDS:
        for ext in ("html", "pdf"):
            if (here / f"{kind}.{ext}").exists():
                # The account travels in the URL. Two people can have tailored
                # the same listing, and the page asking for "this job's CV"
                # has to say whose, or it is offered the other one's.
                out[f"{kind}_{ext}"] = (f"/api/documents/{slug(job_id)}/{kind}.{ext}"
                                        f"?user={who}")
    return out


def read_meta(job_id: str, user: str = "") -> Optional[Dict]:
    path = folder(job_id, user) / "meta.json"
    if not path.exists():
        return None
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    # Recomputed rather than trusted: a file deleted by hand should stop being
    # offered, and a PDF rendered after the meta was written should appear.
    meta["files"] = files_present(job_id, user)
    meta.setdefault("user", owner(user))
    return meta


def has_documents(job_id: str, user: str = "") -> bool:
    return bool(files_present(job_id, user))


def list_documents(limit: int = 100, user: str = "") -> List[Dict]:
    """This account's tailored documents. Never both accounts'."""
    here = shelf(user)
    if not here.exists():
        return []
    metas = []
    for child in here.iterdir():
        if not child.is_dir():
            continue
        meta = read_meta(child.name, user)
        if meta:
            metas.append(meta)
    metas.sort(key=lambda m: m.get("epoch") or 0, reverse=True)
    return metas[:limit]


def resolve(job_slug: str, filename: str, user: str = "") -> Optional[Path]:
    """
    A path inside this account's shelf, or nothing.

    The filename is matched against the four names this module writes rather
    than sanitised, because sanitising is how directory traversal gets through
    eventually. There is deliberately no search of the other accounts when it
    is missing here: a file that is not this account's is not found.
    """
    if filename not in {f"{k}.{e}" for k in KINDS for e in ("html", "pdf")}:
        return None
    path = shelf(user) / slug(job_slug) / filename
    return path if path.exists() else None
