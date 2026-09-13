# -*- coding: utf-8 -*-
"""
Outgoing mail for MapJob.

Only one party can tell a candidate "your application was received": the
employer. What MapJob can honestly send is a *receipt* — a record of what was
submitted, where, and when, written only after the agent verified the
submission on the employer's own confirmation page.

Configuration (.env):
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM
Gmail is used automatically when GMAIL_USER / GMAIL_APP_PASSWORD are set.
"""

import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, formatdate

from .config import GMAIL_APP_PASSWORD, GMAIL_USER

logger = logging.getLogger("mailer")

SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or 587)
SMTP_USER = os.getenv("SMTP_USER") or GMAIL_USER or ""
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD") or GMAIL_APP_PASSWORD or ""
SMTP_FROM = os.getenv("SMTP_FROM") or SMTP_USER


def is_configured() -> bool:
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD)


def configuration_hint() -> str:
    if is_configured():
        return ""
    missing = [
        name
        for name, value in (
            ("SMTP_HOST", SMTP_HOST),
            ("SMTP_USER (or GMAIL_USER)", SMTP_USER),
            ("SMTP_PASSWORD (or GMAIL_APP_PASSWORD)", SMTP_PASSWORD),
        )
        if not value
    ]
    return "Receipt email not sent: missing " + ", ".join(missing) + " in .env."


def send_email(to_email: str, subject: str, body_text: str, body_html: str = "") -> dict:
    """Send one message. Returns what actually happened - never a hopeful guess."""
    if not to_email:
        return {"sent": False, "reason": "No recipient address for the receipt."}
    if not is_configured():
        return {"sent": False, "reason": configuration_hint()}

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("MapJob", SMTP_FROM))
    msg["To"] = to_email
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body_text)
    if body_html:
        msg.add_alternative(body_html, subtype="html")

    try:
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ssl.create_default_context(), timeout=20) as s:
                s.login(SMTP_USER, SMTP_PASSWORD)
                s.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                s.ehlo()
                s.starttls(context=ssl.create_default_context())
                s.login(SMTP_USER, SMTP_PASSWORD)
                s.send_message(msg)
        logger.info(f"Receipt email sent to {to_email}")
        return {"sent": True, "to": to_email}
    except (smtplib.SMTPException, OSError) as e:
        logger.warning(f"Could not send receipt email to {to_email}: {e}")
        return {"sent": False, "reason": f"SMTP error: {e}"}


def _esc(value: str) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def send_application_receipt(
    to_email: str,
    company: str,
    job_title: str,
    portal_url: str,
    evidence: str = "",
    submitted_at: str = "",
) -> dict:
    """Confirm to the candidate that a submission was completed and verified."""
    subject = f"Application sent: {job_title} at {company}"
    lines = [
        f"Your application for {job_title} at {company} was submitted.",
        "",
        f"Employer portal: {portal_url}" if portal_url else "",
        f"Submitted: {submitted_at}" if submitted_at else "",
        f"Verified by: {evidence}" if evidence else "",
        "",
        "This is MapJob's own record of the submission. The employer sends its",
        "own acknowledgement separately, usually within a few minutes; if it does",
        "not arrive, check the portal's candidate area before applying again.",
    ]
    text = "\n".join(line for line in lines if line != "" or True).strip()

    html = f"""<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;">
  <h2 style="margin:0 0 12px;font-size:18px;">Application sent</h2>
  <p style="margin:0 0 16px;font-size:14px;">
    Your application for <strong>{_esc(job_title)}</strong> at
    <strong>{_esc(company)}</strong> was submitted.
  </p>
  <table style="font-size:13px;border-collapse:collapse;">
    {'<tr><td style="padding:4px 12px 4px 0;color:#717171;">Portal</td><td><a href="' + _esc(portal_url) + '">' + _esc(portal_url) + '</a></td></tr>' if portal_url else ''}
    {'<tr><td style="padding:4px 12px 4px 0;color:#717171;">Submitted</td><td>' + _esc(submitted_at) + '</td></tr>' if submitted_at else ''}
    {'<tr><td style="padding:4px 12px 4px 0;color:#717171;">Verified by</td><td>' + _esc(evidence) + '</td></tr>' if evidence else ''}
  </table>
  <p style="margin:16px 0 0;font-size:12px;color:#717171;">
    This is MapJob's own record of the submission. The employer sends its own
    acknowledgement separately.
  </p>
</body></html>"""

    return send_email(to_email, subject, text, html)
