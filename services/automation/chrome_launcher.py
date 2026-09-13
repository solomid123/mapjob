"""
Opening the Chrome window that the page agent drives.

undetected_chromedriver picks a driver by guessing the installed Chrome's
version. When the guess is wrong by even one major version, Chrome starts and
immediately exits, and Selenium reports "cannot connect to chrome" — which from
the outside looks exactly like the browser never opening at all. So the version
is read off this machine and handed over, with a second attempt that takes the
number out of Chrome's own complaint if the first one was still wrong.
"""

import re
import shutil
import subprocess
import sys
from typing import Optional

import undetected_chromedriver as uc


def installed_chrome_major() -> Optional[int]:
    """The major version of the Chrome installed here, or None if unreadable."""
    if sys.platform == "win32":
        try:
            import winreg
            for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    with winreg.OpenKey(root, r"Software\Google\Chrome\BLBeacon") as key:
                        version, _ = winreg.QueryValueEx(key, "version")
                        return int(str(version).split(".")[0])
                except OSError:
                    continue
        except Exception:
            pass

    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        path = shutil.which(name)
        if not path:
            continue
        try:
            out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout
            match = re.search(r"(\d+)\.\d+", out or "")
            if match:
                return int(match.group(1))
        except Exception:
            continue
    return None


def _version_from_error(message: str) -> Optional[int]:
    """The number Chrome itself reports in a version-mismatch error."""
    match = re.search(r"Current browser version is (\d+)", message or "")
    return int(match.group(1)) if match else None


def launch_chrome(options=None, user_data_dir=None, log=None, **kwargs):
    """
    Starts undetected Chrome against the version actually installed.

    `log` is an optional one-argument callable used to explain a retry, so a
    version mismatch shows up in the run's own log rather than only in stderr.
    """
    def say(message: str):
        if log:
            try:
                log(message)
            except Exception:
                pass
        print(f"[Chrome] {message}", flush=True)

    attempt = dict(kwargs)
    if options is not None:
        attempt["options"] = options
    if user_data_dir is not None:
        attempt["user_data_dir"] = user_data_dir

    major = attempt.pop("version_main", None) or installed_chrome_major()
    if major:
        attempt["version_main"] = major

    try:
        return uc.Chrome(**attempt)
    except Exception as first_error:
        wanted = _version_from_error(str(first_error))
        if not wanted or wanted == attempt.get("version_main"):
            raise
        say(f"Driver was built for another Chrome; fetching the one for Chrome {wanted}.")
        attempt["version_main"] = wanted
        return uc.Chrome(**attempt)
