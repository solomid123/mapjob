/**
 * The candidate's held documents: transcripts, diplomas, permits, references.
 *
 * Not the tailored pair. A CV and a covering letter are written per advert and
 * live in `tailorApi`; these are the files that are the same every time and
 * that an employer asks for by name -- and an application missing the transcript
 * it asked for is not a slower application, it is a rejected one.
 *
 * Everything here addresses a document by its id, and every call says which of
 * the two accounts is asking. The server never sends the name it stored a file
 * under and never accepts a path, because a path in a request is a request to
 * read any file on the machine -- and it checks the owner as well as the id,
 * because an id alone would let one account open the other's passport scan by
 * guessing twelve hex characters.
 */

import { API_BASE } from './apiBase';
import { userKey, withUser } from './account';

const BACKEND_URL = API_BASE;

export interface HeldDocument {
  id: string;
  title: string;
  /** transcript, diploma, certificate, reference, identity, photo, permit, licence, portfolio, other. */
  kind: string;
  filename: string;
  mime: string;
  bytes: number;
  pages: number;
  /** Whether it can be bound into a single PDF with the rest. Only PDFs can. */
  mergeable: boolean;
  added_at: number;
  /** Ticked in the chooser before anyone chooses anything. */
  attach_by_default: boolean;
  /** The row is held but the file under it has gone. */
  missing?: boolean;
}

export interface DocumentLibrary {
  documents: HeldDocument[];
  kinds: string[];
  accepts: string[];
  max_bytes: number;
  /**
   * The CV everything else is cut from, if one has been uploaded. Held in the
   * same library but kept out of `documents`: it is not a thing you tick to
   * attach, it is the thing a tailored CV is made of.
   */
  master_cv?: HeldDocument | null;
}

async function reason(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.detail || fallback;
  } catch {
    return fallback;
  }
}

export async function fetchDocuments(user?: string): Promise<DocumentLibrary> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/library`, user));
  if (!res.ok) throw new Error(`Documents unavailable (${res.status})`);
  return res.json();
}

export async function uploadDocument(
  file: File,
  opts: { title?: string; kind?: string; attachByDefault?: boolean; user?: string } = {},
): Promise<HeldDocument> {
  const query = new URLSearchParams({
    title: opts.title || '',
    kind: opts.kind || 'other',
    attach_by_default: String(!!opts.attachByDefault),
  });
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(withUser(`${BACKEND_URL}/api/library?${query.toString()}`, opts.user), {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await reason(res, `That file was not kept (${res.status}).`));
  return (await res.json()).document;
}

export async function editDocument(
  id: string,
  patch: { title?: string; kind?: string; attach_by_default?: boolean },
  user?: string,
): Promise<HeldDocument> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/library/${id}`, user), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await reason(res, `Could not change that (${res.status}).`));
  return (await res.json()).document;
}

export async function deleteDocument(id: string, user?: string): Promise<void> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/library/${id}`, user), { method: 'DELETE' });
  if (!res.ok) throw new Error(await reason(res, `Could not remove that (${res.status}).`));
}

/** Where the file itself can be opened. By id, so no path ever leaves the page. */
export function documentUrl(id: string, user?: string): string {
  return withUser(`${BACKEND_URL}/api/library/${id}/file`, user);
}

/** What the sender was told to attach, and how. */
export interface AttachmentChoice {
  documentIds: string[];
  /** One bound PDF rather than several files. */
  merge: boolean;
}

export const NO_ATTACHMENTS: AttachmentChoice = { documentIds: [], merge: false };

const REMEMBERED = 'mapjob.attachments';

/**
 * The last choice, so the second application of the afternoon does not ask the
 * same question again from scratch. Remembered, never obeyed: the chooser still
 * opens, and what it opens with is only a suggestion.
 */
export function rememberedChoice(): AttachmentChoice | null {
  try {
    const raw = localStorage.getItem(userKey(REMEMBERED));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.documentIds)) return null;
    return { documentIds: parsed.documentIds.map(String), merge: !!parsed.merge };
  } catch {
    return null;
  }
}

export function rememberChoice(choice: AttachmentChoice): void {
  try {
    localStorage.setItem(userKey(REMEMBERED), JSON.stringify(choice));
  } catch {
    /* A browser with storage switched off still applies; it just asks fresh. */
  }
}

export function prettyKind(kind: string): string {
  const said: Record<string, string> = {
    transcript: 'Transcript',
    diploma: 'Diploma',
    certificate: 'Certificate',
    reference: 'Reference',
    identity: 'Identity',
    photo: 'Application photo',
    permit: 'Permit',
    licence: 'Licence',
    portfolio: 'Portfolio',
    other: 'Other',
  };
  return said[kind] || kind;
}

export function prettySize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
