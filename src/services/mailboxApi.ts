/**
 * The mailbox an account sends from.
 *
 * Applications leave by email, so until somebody has connected a mailbox this
 * app can write letters and send none of them. There used to be exactly one,
 * named in the project's `.env`, which works on the one laptop it was set up on
 * and nowhere else: deployed, it would mean every user of the app sending out
 * of the same Google account, with the employer's reply landing in a stranger's
 * inbox. So each account connects its own, through Google's consent screen.
 *
 * Nothing here ever handles a token. The consent happens at accounts.google.com
 * in a tab of the user's own browser, the code comes back to the server, and
 * what this module can learn afterwards is an address and a few booleans. A
 * refresh token opens somebody's mail; it has no business in a web bundle.
 */

import { API_BASE } from './apiBase';
import { withUser } from './account';

const BACKEND_URL = API_BASE;

export interface MailboxStatus {
  /** The account this answer is about. */
  user: string;
  /** Whether there is a mailbox at all -- connected, or inherited from .env. */
  connected: boolean;
  /** The address letters would go out from. Empty when nothing is connected. */
  address: string;
  /** 'oauth' | 'gmail-api' | 'smtp' | 'env' | ''. How it sends. */
  how: string;
  /**
   * Whether the mailbox belongs to this account.
   *
   * False means it is borrowing the machine's: the install's own `.env` Gmail,
   * which on this laptop is the owner's. Worth saying out loud on the page,
   * because "Connected" over somebody else's address is a trap -- the letters
   * go out under a name that is not yours.
   */
  own: boolean;
  /** Whether Google still honours it, asked just now rather than assumed. */
  ok: boolean;
  /** Google's own words when it does not, so a failure is readable. */
  reason: string;
  /** False when the install has no OAuth client; the button can do nothing. */
  can_connect: boolean;
  /** Where Google is told to send the person back to. Shown when it misfires. */
  redirect_uri: string;
  since?: string;
}

export const NO_MAILBOX: MailboxStatus = {
  user: '', connected: false, address: '', how: '', own: false,
  ok: false, reason: '', can_connect: false, redirect_uri: '',
};

export async function mailboxStatus(user?: string): Promise<MailboxStatus> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/mailbox/status`, user));
  if (!res.ok) throw new Error(`Mailbox status failed (${res.status})`);
  return { ...NO_MAILBOX, ...(await res.json()) };
}

/**
 * Begin the consent, and hand back the URL to open.
 *
 * Deliberately not a redirect of this page. The workspace may have a campaign
 * running and a live log on screen; sending it to Google and back would throw
 * that away to ask a question that belongs in a tab of its own.
 */
export async function connectMailbox(user?: string): Promise<string> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/mailbox/connect`, user),
    { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `Could not start sign-in (${res.status})`);
  return String(data?.url || '');
}

/**
 * Forget the token held for this account.
 *
 * It does not revoke Google's grant -- only the user can do that, at the
 * address returned here -- and the page says so rather than letting a button
 * claim something it has not done.
 */
export async function disconnectMailbox(user?: string): Promise<{ removed: boolean; revoke_at: string }> {
  const res = await fetch(withUser(`${BACKEND_URL}/api/mailbox/disconnect`, user),
    { method: 'POST' });
  if (!res.ok) throw new Error(`Could not disconnect (${res.status})`);
  return res.json();
}

