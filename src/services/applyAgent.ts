const BACKEND_URL = import.meta.env.VITE_API_BASE_URL || (typeof window !== 'undefined' ? `http://${window.location.hostname || 'localhost'}:8000` : 'http://localhost:8000');

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
    const res = await fetch(`${BACKEND_URL}/api/apply/email-status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
