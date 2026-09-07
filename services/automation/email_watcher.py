import email
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
        self.user = user or GMAIL_USER
        self.password = password or GMAIL_APP_PASSWORD

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
