import { API_BASE } from './apiBase';
import { withUser } from './account';

const BACKEND_URL = API_BASE;

export interface EmailStatus {
  receipt_email_configured: boolean;
  receipt_email_hint: string;
  recipient: string;
  inbox_watch_configured: boolean;
}

/**
 * Whether the backend can email a receipt and watch the inbox for the
 * employer's own acknowledgement. Applications themselves are submitted over
 * HTTP to the employer's ATS by `applyViaDirectAtsApi`; there is no browser
 * agent involved any more.
 */
export async function getEmailStatus(): Promise<EmailStatus | null> {
  try {
    const res = await fetch(withUser(`${BACKEND_URL}/api/apply/email-status`));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
