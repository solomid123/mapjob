/**
 * Who is signed in.
 *
 * This app has two accounts, not two roles: Badreddine applies for mechanical
 * engineering posts in France, Chaimaa for Ausbildung places in Germany. They
 * share nothing -- not a CV, not a transcript, not a letter language, not a
 * list of saved jobs. Sending the wrong one is not a cosmetic mix-up; it signs
 * her application with his name, or writes to a Handwerksbetrieb in French.
 *
 * So this is a sign-in, not a switch. Until somebody signs in there is no
 * account and the app does not open: `signedIn()` returns an empty string and
 * the gate is all there is to see. Once they do, the whole app is theirs --
 * every request carries their name and the server decides what that name may
 * reach, and everything this browser remembers is filed under it by `userKey`,
 * so neither of them can see the other's saved jobs, attachments or drafts by
 * reloading the page.
 *
 * Signing out forgets who it was and nothing else: the things filed under a
 * name stay where they are, waiting for that name to come back.
 *
 * What is kept here is the name and nothing else -- no profile, no document,
 * no list. It lives in localStorage because it is a fact about this browser;
 * it is not a credential and the server trusts it for nothing it would not
 * hand the other account anyway.
 *
 * There is a password on the door now, checked by the server, and it is worth
 * saying exactly how far it reaches: it decides whether this page opens, and
 * nothing else. Every API route still answers for whatever account it is asked
 * about, so the lock separates two people who share a machine and does not
 * defend the data from anyone who can reach the service. Real authentication
 * -- a session the server issues and every route insists on -- is a deployment
 * away; `signInWithPassword` is the seam it will fit into.
 */

import { API_BASE } from './apiBase';
import * as React from 'react';

const BACKEND_URL = API_BASE;

/** Who is signed in on this browser. Absent means nobody, which is a state. */
const KEY = 'mapjob.account';

/** The account this app had before it had two, and the owner of its leftovers. */
export const DEFAULT_USER = 'badreddine';

export interface Person {
  id: string;
  display_name: string;
  /** What they are looking for, in their own words. Shown, never parsed. */
  focus: string;
  /** The language a covering letter or an email is written in. */
  letter_language: string;
  /** The language the interview helper listens and answers in. */
  interview_language: string;
  country: string;
  /**
   * What an application from this person is: 'pair' -- a letter and a CV -- or
   * 'german_dossier', one bound file that opens on a Deckblatt and carries the
   * Anschreiben, the Lebenslauf and the certificates behind it.
   */
  application_style?: string;
}

/** Fired on the window when the signed-in account changes. */
export const USER_CHANGED = 'mapjob:user';

/** The signed-in account, or the empty string when nobody is. */
export function signedIn(): string {
  try {
    return (localStorage.getItem(KEY) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Whose data a request is for.
 *
 * The app only renders behind the gate, so in practice this is the signed-in
 * account. The fallback covers the stray request still in flight across a sign
 * out: the server needs a name to scope by, and answering for the default
 * account, on a page nobody will see again, beats answering for whoever asks.
 */
export function currentUser(): string {
  return signedIn() || DEFAULT_USER;
}

function announce(who: string): void {
  window.dispatchEvent(new CustomEvent(USER_CHANGED, { detail: who }));
}

/**
 * Whether the app is opening because somebody just signed in, as opposed to
 * because a signed-in browser reloaded the page.
 *
 * The app lands on the new-search questions after a sign-in and on your own
 * results after a reload, and those two look identical from inside <App>: both
 * are a fresh mount with a name in storage. So the door leaves a note.
 *
 * sessionStorage, not local: the note must not outlive the tab and turn the
 * next morning's reload into a sign-in. `taken` covers the same mount asking
 * twice -- StrictMode runs initialisers twice in development, and the second
 * call must give the same answer as the first or the page half-lands.
 */
const FRESH_KEY = 'mapjob.signin.fresh';
let taken: string | null = null;

export function takeFreshSignIn(): boolean {
  const who = signedIn();
  if (!who) return false;
  try {
    if (sessionStorage.getItem(FRESH_KEY) === who) {
      sessionStorage.removeItem(FRESH_KEY);
      taken = who;
      return true;
    }
  } catch {
    /* Storage off: a reload simply behaves like a reload. */
  }
  return taken === who;
}

export function signIn(id: string): void {
  const next = (id || '').trim();
  if (!next || next === signedIn()) return;
  try {
    localStorage.setItem(KEY, next);
    sessionStorage.setItem(FRESH_KEY, next);
  } catch {
    /* Storage off: the sign-in still holds for this page's lifetime. */
  }
  taken = null;
  announce(next);
}

/**
 * Check a password with the server, and sign in if it is right.
 *
 * The check is the server's because an answer the browser knows is an answer
 * anybody can read. It is worth being plain about the size of this lock: it
 * guards the front door of the page and nothing behind it -- every API route
 * still answers for whatever account it is asked about -- so it keeps two
 * people who share a machine out of each other's things, and is not a defence
 * against anyone who can reach the service itself.
 */
export async function signInWithPassword(
  id: string, password: string,
): Promise<{ ok: boolean; reason: string }> {
  let data: { ok?: boolean; reason?: string; user?: string };
  try {
    const res = await fetch(`${BACKEND_URL}/api/people/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: id, password }),
    });
    data = await res.json();
  } catch {
    // Refused rather than waved through. The password is only worth anything
    // while the thing that checks it is the thing that holds the data, and
    // letting the browser decide when the server is quiet would mean the lock
    // opens for anybody who unplugs it.
    return { ok: false, reason: 'The service on port 8000 is not answering, so the password cannot be checked.' };
  }
  if (!data?.ok) return { ok: false, reason: data?.reason || 'That is not the password.' };
  // The name the server settled on, not the one that was asked for. An id it
  // does not recognise resolves to the default account, and signing in under
  // the name as typed would leave this browser filing one person's saved jobs
  // and drafts under a name that exists nowhere else.
  signIn(data.user || id);
  return { ok: true, reason: '' };
}

export function signOut(): void {
  if (!signedIn()) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Nothing to forget. */
  }
  announce('');
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(USER_CHANGED, onChange);
  // Another tab of the same app signing in or out counts too.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(USER_CHANGED, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The signed-in account, empty when nobody is, re-read whenever it changes. */
export function useSignedIn(): string {
  const [who, setWho] = React.useState(signedIn);
  React.useEffect(() => subscribe(() => setWho(signedIn())), []);
  return who;
}

/** The account a page works under. Kept for the many callers that read it. */
export function useCurrentUser(): [string, (id: string) => void] {
  const [user, setUser] = React.useState(currentUser);
  React.useEffect(() => subscribe(() => setUser(currentUser())), []);
  return [user, signIn];
}

/**
 * The name of a remembered thing, filed under the account that owns it.
 *
 * Saved jobs, applied jobs, the last tick list of attachments, a search brief:
 * all of it used to be stored under one flat key per browser, which made two
 * accounts on one machine one pile. Her Ausbildung shortlist would open on his
 * map, and his attachment ids would be offered for her application.
 *
 * The keys this app wrote before it had accounts belong to the account it had
 * then, so the first time that person asks for one it is adopted under their
 * name -- copied, not moved, because a half-done migration that has already
 * eaten the original is worse than a duplicate nobody reads.
 */
const adopted = new Set<string>();

export function userKey(base: string): string {
  const who = currentUser();
  const key = base + '::' + who;
  if (who === DEFAULT_USER && !adopted.has(base)) {
    adopted.add(base);
    try {
      const legacy = localStorage.getItem(base);
      if (legacy !== null && localStorage.getItem(key) === null) {
        localStorage.setItem(key, legacy);
      }
    } catch {
      /* Storage off: there is nothing to adopt and nowhere to put it. */
    }
  }
  return key;
}

/** Add the account to a URL, whether or not it already has a query. */
export function withUser(url: string, user?: string): string {
  const who = user || currentUser();
  return url + (url.includes('?') ? '&' : '?') + 'user=' + encodeURIComponent(who);
}

let known: Promise<{ people: Person[]; default: string }> | null = null;

/**
 * The accounts the server knows about.
 *
 * Asked once per page: this list changes when someone edits the database, not
 * while the app is open, and every card that shows a name should not cost a
 * round trip. A server that cannot be reached yields the two known accounts
 * rather than an empty list, because an empty list is a sign-in page with
 * nobody to sign in as.
 */
export function fetchPeople(): Promise<{ people: Person[]; default: string }> {
  if (!known) {
    known = fetch(`${BACKEND_URL}/api/people`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .catch(() => ({
        people: [
          {
            id: 'badreddine', display_name: 'Badreddine Barki',
            focus: 'Mechanical engineering roles',
            letter_language: 'fr', interview_language: 'en', country: 'France',
            application_style: 'pair',
          },
          {
            id: 'chaimaa', display_name: 'Chaimaa Barki',
            focus: 'Ausbildung places in Germany',
            letter_language: 'de', interview_language: 'de', country: 'Germany',
            application_style: 'german_dossier',
          },
        ],
        default: DEFAULT_USER,
      }));
  }
  return known;
}

/** The person using the app now, once the list has arrived. */
export function usePerson(): Person | null {
  const [user] = useCurrentUser();
  const [people, setPeople] = React.useState<Person[]>([]);
  React.useEffect(() => { void fetchPeople().then((r) => setPeople(r.people)); }, []);
  return people.find((p) => p.id === user) || null;
}
