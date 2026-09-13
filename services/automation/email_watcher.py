import email
import email.utils
import imaplib
import re
import time
from email.header import decode_header
from .config import GMAIL_USER, GMAIL_APP_PASSWORD

class EmailWatcher:
    """
    Monitors candidate inbox to automatically retrieve verification codes (OTP)
    and confirmation/magic links from job platforms (HelloWork, BeeHire, etc.).
    """
    def __init__(self, user: str = None, password: str = None):
        # `None` means "fall back to the configured account". An explicit empty
        # string means "no credentials" and must NOT quietly reach for the
        # owner's mailbox: `user or GMAIL_USER` would have done exactly that.
        self.user = GMAIL_USER if user is None else user
        self.password = GMAIL_APP_PASSWORD if password is None else password

    def is_configured(self) -> bool:
        return bool(self.user and self.password)

    def wait_for_otp_code(self, timeout_seconds: int = 90, poll_interval: int = 5) -> str:
        """
        Polls the inbox for a recently received 6-digit OTP verification code.
        """
        if not self.is_configured():
            print("[EmailWatcher] Gmail App Password not yet configured. Prompting user manually.")
            return None

        print(f"[EmailWatcher] Listening for incoming OTP on {self.user} (timeout: {timeout_seconds}s)...")
        start_time = time.time()

        while time.time() - start_time < timeout_seconds:
            code = self._check_latest_otp()
            if code:
                print(f"[EmailWatcher] Extracted OTP code: {code}")
                return code
            time.sleep(poll_interval)

        print("[EmailWatcher] Timeout reached waiting for OTP.")
        return None

    def wait_for_magic_link(self, domain_keyword: str = "beehire", timeout_seconds: int = 90) -> str:
        """
        Polls the inbox for a magic login or confirmation link.
        """
        if not self.is_configured():
            return None

        print(f"[EmailWatcher] Listening for magic link matching '{domain_keyword}'...")
        start_time = time.time()

        while time.time() - start_time < timeout_seconds:
            link = self._check_latest_magic_link(domain_keyword)
            if link:
                print(f"[EmailWatcher] Found magic link: {link}")
                return link
            time.sleep(5)

        return None

    def _connect_imap(self):
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(self.user, self.password)
        mail.select("inbox")
        return mail

    def _check_latest_otp(self) -> str:
        try:
            mail = self._connect_imap()
            # Search for unread or recent messages
            _, msg_ids = mail.search(None, '(UNSEEN)')
            if not msg_ids[0]:
                _, msg_ids = mail.search(None, 'ALL')

            if not msg_ids[0]:
                mail.logout()
                return None

            latest_id = msg_ids[0].split()[-1]
            _, data = mail.fetch(latest_id, '(RFC822)')
            mail.logout()

            raw_email = data[0][1]
            msg = email.message_from_bytes(raw_email)
            body = self._extract_body(msg)

            # Search for 6-digit code
            match = re.search(r"\b(\d{6})\b", body)
            if match:
                return match.group(1)

        except Exception as e:
            print(f"[EmailWatcher] Error checking inbox: {e}")

        return None

    def _check_latest_magic_link(self, keyword: str) -> str:
        try:
            mail = self._connect_imap()
            _, msg_ids = mail.search(None, 'ALL')
            if not msg_ids[0]:
                mail.logout()
                return None

            latest_id = msg_ids[0].split()[-1]
            _, data = mail.fetch(latest_id, '(RFC822)')
            mail.logout()

            raw_email = data[0][1]
            msg = email.message_from_bytes(raw_email)
            body = self._extract_body(msg)

            urls = re.findall(r'https?://[^\s<>"]+', body)
            for u in urls:
                if keyword.lower() in u.lower():
                    return u

        except Exception as e:
            print(f"[EmailWatcher] Error checking magic link: {e}")

        return None

    def _extract_body(self, msg) -> str:
        if msg.is_multipart():
            for part in msg.walk():
                ctype = part.get_content_type()
                if ctype in ["text/plain", "text/html"]:
                    payload = part.get_payload(decode=True)
                    if payload:
                        return payload.decode("utf-8", errors="ignore")
        else:
            payload = msg.get_payload(decode=True)
            if payload:
                return payload.decode("utf-8", errors="ignore")
        return ""
    # ------------------------------------------------------------------
    # Employer acknowledgement detection
    # ------------------------------------------------------------------

    CONFIRMATION_PHRASES = (
        "application received", "we received your application",
        "thank you for applying", "thanks for applying",
        "your application has been received", "application submitted",
        "candidature re", "nous avons bien re", "merci pour votre candidature",
        "bewerbung erhalten", "vielen dank f", "sollicitatie ontvangen",
    )

    def find_confirmation(self, company: str, since_epoch: float = 0.0, lookback: int = 25) -> dict:
        """Look for the employer's own acknowledgement of an application.

        Returns {"found": bool, "from": str, "subject": str, "received_at": str}.
        Only the employer can confirm receipt, so this reads the inbox rather
        than assuming anything from the fact that a form was submitted.
        """
        if not self.is_configured():
            return {"found": False, "reason": "Inbox watching needs GMAIL_USER and GMAIL_APP_PASSWORD."}

        token = (company or "").casefold().strip()
        try:
            mail = self._connect_imap()
            typ, msg_ids = mail.search(None, "ALL")
            ids = msg_ids[0].split() if msg_ids and msg_ids[0] else []
            for msg_id in reversed(ids[-lookback:]):
                _, data = mail.fetch(msg_id, "(RFC822)")
                if not data or not data[0]:
                    continue
                msg = email.message_from_bytes(data[0][1])

                received = email.utils.parsedate_to_datetime(msg.get("Date")) if msg.get("Date") else None
                if received and since_epoch and received.timestamp() < since_epoch:
                    continue  # Older than this application: cannot be its receipt.

                subject = str(self._decode(msg.get("Subject", "")))
                sender = str(self._decode(msg.get("From", "")))
                haystack = f"{subject} {sender}".casefold()
                body = self._extract_body(msg).casefold()

                mentions_company = bool(token) and (token in haystack or token in body[:4000])
                acknowledges = any(p in subject.casefold() or p in body[:4000] for p in self.CONFIRMATION_PHRASES)
                if mentions_company and acknowledges:
                    mail.logout()
                    return {
                        "found": True,
                        "from": sender,
                        "subject": subject,
                        "received_at": received.isoformat() if received else "",
                    }
            mail.logout()
        except Exception as e:
            print(f"[EmailWatcher] Error scanning for confirmation: {e}")
            return {"found": False, "reason": str(e)}

        return {"found": False}

    def wait_for_confirmation(self, company: str, since_epoch: float = 0.0,
                              timeout_seconds: int = 180, poll_interval: int = 20) -> dict:
        """Poll the inbox until the employer acknowledges, or the timeout passes."""
        deadline = time.time() + timeout_seconds
        last = {"found": False}
        while time.time() < deadline:
            last = self.find_confirmation(company, since_epoch=since_epoch)
            if last.get("found"):
                return last
            time.sleep(poll_interval)
        return last

    @staticmethod
    def _decode(raw) -> str:
        if not raw:
            return ""
        parts = decode_header(raw)
        out = []
        for text, charset in parts:
            if isinstance(text, bytes):
                out.append(text.decode(charset or "utf-8", errors="ignore"))
            else:
                out.append(text)
        return "".join(out)
