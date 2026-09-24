# -*- coding: utf-8 -*-
"""
The candidate's own documents, kept once and attached from anywhere.

A CV and a cover letter are written per application, and this project already
does that. Everything else an employer asks for is not written, it is held: a
degree certificate, a transcript of records, a residence permit, a driving
licence, a reference letter, an Arbeitszeugnis. Those are the same file every
time, and until now there was nowhere to put them, so they were attached by
hand or forgotten -- and an application missing the transcript it asked for is
not a slower application, it is a rejected one.

So: one library per person, and two products that read from it. The email
campaign attaches them beside the tailored pair; the cloud agent uploads them
alongside the CV and is told what each one is, so it can put the transcript in
the field marked transcript rather than in the first upload box it finds.

Where they live, and why it changed. They were a folder on this machine with an
index.json beside it, which is one restart away from being nothing and, with
two people using the app, one folder holding both their passports. They are now
rows in Postgres and bytes in a *private* Supabase bucket -- signed URLs only,
never the public buckets this project still has lying around. The disk keeps a
cache, because binding PDFs and attaching them to mail needs real files, and
because a send should not fail when the network hiccups.

Two invariants worth stating outright:

  * A stored name is never the name the browser sent. `../../.env` is a
    filename, not a path, and this module is the place that knows the
    difference.
  * Every lookup is scoped by person. An id alone never reaches a file: a
    document belongs to somebody, and asking for it as somebody else is a
    404, not a download.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from services.automation import cloud, documents as tailored, people

ROOT = Path(os.getenv("DOCUMENT_LIBRARY_DIR", str(tailored.ROOT / "library")))
TABLE = "held_documents"

# What may be held. Everything here can be emailed; only the PDFs can be bound
# into one file, which is why `mergeable` is a property of the row rather than
# an assumption of the sender.
SUFFIXES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".txt": "text/plain",
}

# The kinds an employer actually asks for, in the words they ask in. Free text
# would be more flexible and less useful: the cloud agent matches these against
# the labels on a form, and "other" is where a one-off goes.
#
# `master_cv` is not one of them. A master CV is held in this same library so a
# deployment has the file, but it is the source the tailoring step cuts from,
# not an extra attachment, so it never appears in the chooser.
KINDS = (
    "transcript", "diploma", "certificate", "reference", "identity",
    # A German application opens with a Deckblatt carrying a photograph, so the
    # photo is a held document like any other rather than a file somebody has
    # to remember the path of. It is also the one kind that is never attached
    # on its own: it is printed into the cover sheet.
    "photo",
    "permit", "licence", "portfolio", "other",
)
MASTER_CV = "master_cv"
ALL_KINDS = KINDS + (MASTER_CV,)

MAX_BYTES = 20 * 1024 * 1024
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _clean_name(filename: str) -> str:
    """A filename, reduced to something that cannot be a path."""
    base = os.path.basename((filename or "").replace("\\", "/")).strip()
    base = _UNSAFE.sub("-", base).strip("-.")
    return (base or "document")[:100]


def _who(user: Optional[str]) -> str:
    return people.resolve(user)


def _folder(user: str) -> Path:
    return ROOT / user


def _index(user: str) -> Path:
    return _folder(user) / "index.json"


# --- the local mirror ------------------------------------------------------
#
# Not the source of truth any more. It is what the app reads when Postgres
# cannot be reached, and where the bytes sit while a PDF is being bound.

def _read_mirror(user: str) -> List[Dict[str, Any]]:
    try:
        data = json.loads(_index(user).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except Exception:
        return []
    rows = data.get("documents") if isinstance(data, dict) else data
    return [r for r in (rows or []) if isinstance(r, dict)]


def _write_mirror(user: str, rows: List[Dict[str, Any]]) -> None:
    folder = _folder(user)
    folder.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(folder), suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            json.dump({"documents": rows}, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, _index(user))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _mirror(user: str, row: Dict[str, Any]) -> None:
    rows = [r for r in _read_mirror(user) if r.get("id") != row.get("id")]
    rows.append(row)
    rows.sort(key=lambda r: r.get("added_at") or "")
    _write_mirror(user, rows)


def _unmirror(user: str, document_id: str) -> None:
    _write_mirror(user, [r for r in _read_mirror(user) if r.get("id") != document_id])


def _cache_path(row: Dict[str, Any]) -> Optional[Path]:
    """
    Where this document sits on this machine, whether or not it is here yet.

    Nothing when the row does not say where the bytes are. That happens for a
    row that has been through `_public`, which strips `storage_path` on the way
    to the browser: joining an empty name onto the folder used to hand back the
    account's own directory, and the caller then opened a directory as a file.
    An unreadable photograph is a cover sheet with a hole in it.
    """
    user = str(row.get("user_id") or people.DEFAULT)
    stored = os.path.basename(str(row.get("storage_path") or row.get("stored") or ""))
    return (_folder(user) / stored) if stored else None


def local_copy(row: Dict[str, Any]) -> Optional[Path]:
    """
    The file, on this machine, fetched from the bucket if it is not here.

    Everything downstream -- pypdf binding a pack, the mailer reading bytes,
    the cloud agent uploading a form attachment -- needs a real path. This is
    the only place that turns a row into one.
    """
    path = _cache_path(row)
    if path is not None and path.exists() and path.stat().st_size > 0:
        return path
    remote = str(row.get("storage_path") or "")
    if not remote or path is None:
        return None
    raw = cloud.download(remote)
    if not raw:
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".part")
    with os.fdopen(handle, "wb") as fh:
        fh.write(raw)
    os.replace(tmp, path)
    return path


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    """
    A row as the browser may see it.

    `storage_path` stays behind. The browser asks for a document by id, and a
    page that knows where the bytes are is a page that will eventually be asked
    to fetch them itself -- with a key it must never have.
    """
    out = {k: v for k, v in row.items() if k not in ("storage_path", "stored")}
    here = _cache_path(row)
    out["missing"] = not ((here is not None and here.exists())
                          or bool(row.get("storage_path")))
    return out


def _rows(user: str) -> List[Dict[str, Any]]:
    """Everything held by one person, newest last, from Postgres or the mirror."""
    rows = cloud.select(TABLE, order="added_at", user_id=user)
    if rows:
        # The mirror follows the database rather than the other way round, so a
        # document added from another machine shows up here too.
        for row in rows:
            _mirror(user, row)
        return rows
    return _read_mirror(user)


def all_documents(user: Optional[str] = None, kind: str = "") -> List[Dict[str, Any]]:
    """
    What the chooser offers.

    The master CV is excluded unless it is asked for by name: it is the source
    a tailored CV is cut from, and offering it as a fourth attachment beside
    the tailored one is how an employer ends up with two different CVs.
    """
    who = _who(user)
    rows = _rows(who)
    if kind:
        rows = [r for r in rows if str(r.get("kind")) == kind]
    else:
        rows = [r for r in rows if str(r.get("kind")) != MASTER_CV]
    return [_public(r) for r in rows]


def get(document_id: str, user: Optional[str] = None) -> Optional[Dict[str, Any]]:
    who = _who(user)
    for row in _rows(who):
        if str(row.get("id")) == str(document_id):
            return row
    return None


def path_of(document_id: str, user: Optional[str] = None) -> Optional[Path]:
    row = get(document_id, user)
    return local_copy(row) if row else None


def _pages(path: Path) -> int:
    if path.suffix.lower() != ".pdf":
        return 0
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(path)).pages)
    except Exception:
        return 0


def add(raw: bytes, filename: str, title: str = "", kind: str = "other",
        attach_by_default: bool = False,
        user: Optional[str] = None) -> Dict[str, Any]:
    """
    Keep a file for one person and return its row.

    The same file uploaded twice is two rows, deliberately: a transcript and a
    corrected transcript have the same name, and silently treating the second
    as the first is how the wrong one gets sent for a year. A master CV is the
    exception -- there is only ever one, so a new one replaces it.
    """
    who = _who(user)
    name = _clean_name(filename)
    suffix = Path(name).suffix.lower()
    if suffix not in SUFFIXES:
        raise ValueError("A " + (suffix or "file of that kind")
                         + " cannot be held here. Use PDF, DOCX, an image, or text.")
    if not raw:
        raise ValueError("That file is empty")
    if len(raw) > MAX_BYTES:
        raise ValueError("That file is over 20 MB")

    document_id = uuid.uuid4().hex[:12]
    stored = document_id + "__" + name
    remote = who + "/" + stored

    path = _folder(who) / stored
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".part")
    with os.fdopen(handle, "wb") as fh:
        fh.write(raw)
    os.replace(tmp, path)

    # Into the bucket before the row exists, so a row never points at nothing.
    # A failure here raises: saying a document was kept when it was not is the
    # one outcome this cannot have.
    cloud.upload(remote, raw, SUFFIXES[suffix])

    row = {
        "id": document_id,
        "user_id": who,
        "title": (title or Path(name).stem.replace("_", " ").replace("-", " ")).strip()[:120],
        "kind": kind if kind in ALL_KINDS else "other",
        "filename": name,
        "storage_path": remote,
        "mime": SUFFIXES[suffix],
        "bytes": len(raw),
        "pages": _pages(path),
        "mergeable": suffix == ".pdf",
        "sha256": hashlib.sha256(raw).hexdigest()[:16],
        # Ticked for you in the chooser. A residence permit belongs on every
        # German application; a portfolio belongs on three a year.
        "attach_by_default": bool(attach_by_default),
        "added_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }
    if kind == MASTER_CV:
        for old in [r for r in _rows(who) if str(r.get("kind")) == MASTER_CV]:
            remove(str(old.get("id")), user=who)
    cloud.upsert(TABLE, row)
    _mirror(who, row)
    return _public(row)


# What a person may change about a document after uploading it. Not the file,
# not its size, not where it lives: those are facts about what was uploaded.
FIELDS = ("title", "kind", "attach_by_default")


def update(document_id: str, patch: Dict[str, Any],
           user: Optional[str] = None) -> Optional[Dict[str, Any]]:
    who = _who(user)
    row = get(document_id, who)
    if not row:
        return None
    values: Dict[str, Any] = {}
    for key, value in (patch or {}).items():
        if key not in FIELDS:
            continue
        if key == "kind":
            values[key] = value if value in ALL_KINDS else "other"
        elif key == "attach_by_default":
            values[key] = bool(value)
        else:
            values[key] = str(value)[:120]
    if not values:
        return _public(row)
    row.update(values)
    cloud.patch(TABLE, values, id=document_id, user_id=who)
    _mirror(who, row)
    return _public(row)


def remove(document_id: str, user: Optional[str] = None) -> bool:
    """Forget the row, then the bytes. The other order leaves a row pointing at
    nothing, which reads as a document that failed to attach."""
    who = _who(user)
    row = get(document_id, who)
    if not row:
        return False
    cloud.delete(TABLE, id=document_id, user_id=who)
    _unmirror(who, document_id)
    if row.get("storage_path"):
        cloud.remove_object(str(row["storage_path"]))
    try:
        _cache_path(row).unlink()
    except OSError:
        pass
    return True


def master_cv(user: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """The file a tailored CV is cut from, for this person, or nothing yet."""
    for row in _rows(_who(user)):
        if str(row.get("kind")) == MASTER_CV:
            return row
    return None


def chosen(ids: Optional[List[str]], user: Optional[str] = None) -> List[Dict[str, Any]]:
    """The rows for these ids, in the order they are held rather than the order
    they were ticked: a bound PDF should come out the same way every time."""
    wanted = {str(i) for i in (ids or []) if i}
    if not wanted:
        return []
    return [r for r in _rows(_who(user)) if str(r.get("id")) in wanted]


def defaults(user: Optional[str] = None) -> List[str]:
    return [str(r.get("id")) for r in _rows(_who(user))
            if r.get("attach_by_default") and str(r.get("kind")) != MASTER_CV]


def describe(rows: List[Dict[str, Any]]) -> str:
    """One line per document, for an agent that has to match them to fields."""
    return "\n".join(
        "- " + str(r.get("filename")) + " -- " + str(r.get("kind"))
        + ": " + str(r.get("title")) for r in rows)


def sent_as(row: Dict[str, Any]) -> str:
    """
    The name a held document should arrive under.

    The title, because that is what the person who uploaded it calls it and
    what an employer filing it will want to read -- falling back to the name
    the file came in with, and never to the name it is stored under, which
    carries an id this app invented.
    """
    original = str(row.get("filename") or "document")
    suffix = Path(original).suffix
    title = str(row.get("title") or "").strip()
    if not title:
        return original
    # Spaces are fine in an attachment name; slashes and colons are not.
    clean = re.sub(r"[\/:*?\"<>|]+", " ", title).strip()
    clean = re.sub(r"\s{2,}", " ", clean)[:80].strip(" .")
    if not clean:
        return original
    return clean + suffix if not clean.lower().endswith(suffix.lower()) else clean


def pack_for(ids: Optional[List[str]], merge: bool, stem: str = "Documents",
             user: Optional[str] = None) -> Path:
    """
    Where a bound set of held documents is written, named after the choice.

    The selection is in the filename on purpose. A pack rebuilt under one fixed
    name would be rewritten by the next application that ticked a different box,
    and anything already sent -- or already queued for upload -- would then point
    at a file whose contents had changed behind it.
    """
    wanted = sorted(str(i) for i in (ids or []) if i)
    mark = hashlib.sha1(("|".join(wanted) + str(bool(merge))).encode("utf-8")).hexdigest()[:6]
    return (_folder(_who(user)) / "packs"
            / (_clean_name(stem).rsplit(".", 1)[0] + "_" + mark + ".pdf"))


def _bind(paths: List[Path], out: Path) -> Optional[Path]:
    try:
        from pypdf import PdfWriter
    except ImportError:
        return None
    writer = PdfWriter()
    try:
        for path in paths:
            writer.append(str(path))
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "wb") as handle:
            writer.write(handle)
        return out
    except Exception:  # noqa: BLE001 - one unreadable PDF must not lose the send
        return None
    finally:
        try:
            writer.close()
        except Exception:
            pass


def attachment_plan(ids: Optional[List[str]] = None, merge: bool = False,
                    lead: Optional[List[str]] = None,
                    out: Optional[Path] = None,
                    user: Optional[str] = None) -> Dict[str, Any]:
    """
    What to attach, given what was ticked and how.

    `lead` is the pair this application already produced -- the letter and the
    tailored CV, in that order -- and the held documents follow it. `merge`
    binds them into one PDF, which is what some employers ask for outright and
    what most filing systems prefer.

    Never returns nothing: a merge that cannot be done falls back to separate
    files and says so in `notes`, because an application that arrives as four
    attachments is fine and an application that arrives empty is not.
    """
    who = _who(user)
    lead_paths = [Path(p) for p in (lead or []) if p and Path(p).exists()]
    rows = chosen(ids, who)

    extras: List[Path] = []
    notes: List[str] = []
    # What each file should be called when it arrives. A held document is stored
    # with its id in front of its name so two of them cannot collide, and that
    # is this app's bookkeeping: an employer should see "Transcript of
    # records.pdf".
    names: Dict[str, str] = {}
    for row in rows:
        path = local_copy(row)
        if path and path.exists():
            extras.append(path)
            names[str(path)] = sent_as(row)
        else:
            notes.append(str(row.get("title") or row.get("filename"))
                         + " is in the list but its file could not be fetched, "
                           "so it was not attached.")

    everything = lead_paths + extras
    if not merge or len(everything) < 2:
        return {"files": [str(p) for p in everything], "merged": "",
                "bound": [], "loose": [p.name for p in everything], "notes": notes,
                "names": names, "documents": [_public(r) for r in rows]}

    bindable = [p for p in everything if p.suffix.lower() == ".pdf"]
    loose = [p for p in everything if p.suffix.lower() != ".pdf"]
    if len(bindable) < 2:
        notes.append("There was nothing to bind: only one of the files is a PDF.")
        return {"files": [str(p) for p in everything], "merged": "",
                "bound": [], "loose": [p.name for p in everything], "notes": notes,
                "names": names, "documents": [_public(r) for r in rows]}

    target = Path(out) if out else pack_for(ids, merge, "Documents", who)
    bound = _bind(bindable, target)
    if not bound:
        notes.append("The files could not be bound into one PDF, so they were "
                     "attached separately.")
        return {"files": [str(p) for p in everything], "merged": "",
                "bound": [], "loose": [p.name for p in everything], "notes": notes,
                "names": names, "documents": [_public(r) for r in rows]}

    if loose:
        notes.append("Bound the PDFs into one file; "
                     + ", ".join(p.name for p in loose)
                     + " went alongside it, because only PDFs can be bound.")
    return {"files": [str(bound)] + [str(p) for p in loose], "merged": str(bound),
            "bound": [p.name for p in bindable], "loose": [p.name for p in loose],
            "notes": notes, "names": names, "documents": [_public(r) for r in rows]}
