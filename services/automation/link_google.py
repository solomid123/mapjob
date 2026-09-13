# -*- coding: utf-8 -*-
"""
One-time sign-in for the automation browser.

Run this once:

    python -m services.automation.link_google

It opens the automation's own Chrome profile at the Google sign-in page and
waits while you sign in by hand. Nothing here types a password, reads one, or
stores one -- the credentials go from your keyboard into Google's page, and
what is left behind afterwards is an ordinary Chrome session in an ordinary
Chrome profile. Every later run opens against that same profile, so it is
already signed in.

While the window is open you can also sign into any job boards you use
regularly. Those sessions persist the same way.
"""

import sys
import time

import undetected_chromedriver as uc

from services.automation.chrome_launcher import launch_chrome
from services.automation import agent_profile as prof

SIGN_IN_BUDGET = 10 * 60      # how long to wait for the human to finish
EXTRA_PORTAL_BUDGET = 20 * 60  # how long the window stays open afterwards


def _probe(driver) -> dict:
    try:
        return driver.execute_script(prof.google_probe_script()) or {}
    except Exception:
        return {}


def _window_closed(driver) -> bool:
    try:
        return not driver.window_handles
    except Exception:
        return True


def main() -> int:
    if prof.google_is_linked():
        print(f"This profile is already {prof.signed_in_summary()}.", flush=True)
        print("Continuing anyway will just refresh it.\n", flush=True)

    profile_dir, persistent = prof.acquire()
    if not persistent:
        print("The automation profile is locked by a run that is still going.", flush=True)
        print("Let it finish (or stop the API server) and try again.", flush=True)
        return 1

    print(f"Profile: {profile_dir}\n", flush=True)

    options = uc.ChromeOptions()
    options.add_argument("--start-maximized")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")

    driver = None
    try:
        driver = launch_chrome(options=options, user_data_dir=profile_dir)
        driver.get("https://accounts.google.com/")

        print("A Chrome window is open. Sign into Google in it.", flush=True)
        print("Waiting...\n", flush=True)

        # Watches the cookie jar rather than the page. The sign-in flow is
        # several screens long and its markup gives no dependable "done"
        # signal -- the account-chooser tiles carry `data-email` attributes
        # that read as a signed-in avatar to any selector loose enough to
        # match the real one. The auth cookies appear exactly once, when
        # Google considers the session established.
        deadline = time.time() + SIGN_IN_BUDGET
        announced = False
        while time.time() < deadline:
            if _window_closed(driver):
                print("The window was closed before sign-in finished. Nothing was saved.", flush=True)
                return 1
            if prof.google_session_present(driver):
                break
            if not announced and time.time() > deadline - SIGN_IN_BUDGET + 60:
                announced = True
                print("(still waiting -- take your time)", flush=True)
            time.sleep(3)
        else:
            print("Timed out waiting for sign-in. Nothing was saved.", flush=True)
            return 1

        print("Session cookies received. Verifying...", flush=True)

        # Confirmed on a plain google.com page rather than trusting the cookies
        # alone: a half-finished session is worse than none, because it looks
        # linked and is not.
        driver.get("https://www.google.com/")
        time.sleep(2)
        confirm = _probe(driver)
        if not confirm.get("avatar"):
            print("Google still reports this browser as signed out. Nothing was saved.", flush=True)
            print("If a 2-step prompt is still on screen, finish it and run this again.", flush=True)
            return 1

        account = confirm.get("email") or "signed in"
        prof.write_state(google_signed_in_at=time.time(), google_account=account)
        print(f"Linked: {account}", flush=True)
        print("Future runs will open with this session already active.\n", flush=True)

        print("You can now sign into any job boards you use, in the same window.", flush=True)
        print("Close the browser window when you are done.", flush=True)
        portal_deadline = time.time() + EXTRA_PORTAL_BUDGET
        while time.time() < portal_deadline and not _window_closed(driver):
            time.sleep(3)
        print("Saved.", flush=True)
        return 0

    finally:
        if driver:
            try:
                # A clean quit is what flushes the cookie database to disk.
                driver.quit()
            except Exception:
                pass
        time.sleep(1)
        prof.release(profile_dir, persistent)


if __name__ == "__main__":
    sys.exit(main())
