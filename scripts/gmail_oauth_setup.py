"""
One-time Gmail consent, run on this machine.

A refresh token is not something Google hands you on a page: it is what
comes back the first time you approve an app, and only then -- Google
returns it once, with the first authorisation, and never again unless the
grant is revoked or consent is forced. So it cannot be copied out of the
Cloud Console the way a key can. It has to be earned by an actual consent
round trip, which is what this script is.

You supply the two halves that DO live in the console -- the OAuth client
id and secret -- and this opens the Google consent screen in your browser,
catches the redirect on 127.0.0.1, trades the code for tokens and writes
the refresh token straight into .env. It is never printed, not here and
not on the page: the workspace only ever reports that it is set.

    python scripts/gmail_oauth_setup.py

Scope: gmail.send only. This grant can send mail as you. It cannot read
your inbox, and it is not the Google account password -- revoke it any
time at https://myaccount.google.com/permissions and this stops working
while your account is untouched.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import secrets
import socket
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
SCOPE = "https://www.googleapis.com/auth/gmail.send"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"

DONE_PAGE = (
    "<!doctype html><meta charset=utf-8><title>mapjob</title>"
    "<body style=\"font:16px -apple-system,Segoe UI,sans-serif;"
    "background:#0b0d10;color:#f5f5f7;display:grid;place-items:center;height:100vh;margin:0\">"
    "<div style=\"text-align:center\"><p style=\"font-size:20px;font-weight:600\">Gmail connected.</p>"
    "<p style=\"opacity:.6\">You can close this tab and go back to the outreach workspace.</p></div>"
)


def read_env() -> dict:
    values = {}
    if ENV_PATH.exists():
        for line in io.open(ENV_PATH, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            values[key.strip()] = val.strip()
    return values


def write_env(key: str, value: str) -> None:
    """Replace the line if it exists, append it if it does not. Never echoed."""
    lines = io.open(ENV_PATH, encoding="utf-8").read().splitlines() if ENV_PATH.exists() else []
    out, replaced = [], False
    for line in lines:
        if line.split("=", 1)[0].strip() == key and not line.strip().startswith("#"):
            out.append(f"{key}={value}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"{key}={value}")
    io.open(ENV_PATH, "w", encoding="utf-8").write("\n".join(out).rstrip("\n") + "\n")


def free_port(preferred: int = 8765) -> int:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


class Catcher(http.server.BaseHTTPRequestHandler):
    """The loopback listener. It wants one request and then it is done."""

    result: dict = {}
    state: str = ""

    def do_GET(self):  # noqa: N802 - the stdlib names it
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if query.get("state", [""])[0] != Catcher.state:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"state mismatch")
            return
        Catcher.result = {
            "code": query.get("code", [""])[0],
            "error": query.get("error", [""])[0],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(DONE_PAGE.encode("utf-8"))

    def log_message(self, *_args):
        pass


def post_form(url: str, fields: dict) -> dict:
    body = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    env = read_env()
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID") or env.get("GOOGLE_OAUTH_CLIENT_ID", "")
    client_secret = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET") or env.get("GOOGLE_OAUTH_CLIENT_SECRET", "")

    if not client_id or not client_secret:
        print("Missing the OAuth client. In .env, set:")
        print("  GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com")
        print("  GOOGLE_OAUTH_CLIENT_SECRET=...")
        print()
        print("Both come from https://console.cloud.google.com/apis/credentials")
        print("-> Create credentials -> OAuth client ID -> Application type: Web application")
        print("-> Authorised redirect URI: http://127.0.0.1:8765/")
        print("Enable the Gmail API first, and add your own address as a test user")
        print("on the OAuth consent screen if the app is left in Testing.")
        return 1

    port = free_port()
    redirect_uri = f"http://127.0.0.1:{port}/"
    Catcher.state = secrets.token_urlsafe(24)

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        # offline + consent is the whole point: without both, Google returns an
        # access token that dies in an hour and no refresh token at all.
        "access_type": "offline",
        "prompt": "consent",
        "state": Catcher.state,
    }
    url = AUTH_URL + "?" + urllib.parse.urlencode(params)

    server = http.server.HTTPServer(("127.0.0.1", port), Catcher)
    threading.Thread(target=server.handle_request, daemon=True).start()

    print(f"Listening on {redirect_uri}")
    print("Opening the Google consent screen. Approve it with the account you send from.")
    print("If no browser opens, paste this into one:")
    print(url)
    webbrowser.open(url)

    for _ in range(600):  # ten minutes is a generous consent screen
        if Catcher.result:
            break
        threading.Event().wait(1.0)
    server.server_close()

    if not Catcher.result:
        print("Timed out waiting for consent. Nothing was written.")
        return 1
    if Catcher.result.get("error"):
        print("Google refused: " + Catcher.result["error"])
        return 1

    tokens = post_form(TOKEN_URL, {
        "code": Catcher.result["code"],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    })

    refresh = tokens.get("refresh_token", "")
    if not refresh:
        print("Google returned no refresh token. That happens when the grant already")
        print("exists: revoke it at https://myaccount.google.com/permissions and rerun.")
        return 1

    write_env("GOOGLE_OAUTH_REFRESH_TOKEN", refresh)
    print()
    print(f"Refresh token written to .env ({len(refresh)} characters, not shown).")
    print("Restart the API server and Gmail turns green in the outreach dashboard.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
