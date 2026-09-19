import os
from pathlib import Path

# Load .env manually to avoid extra dependencies
def load_env(env_path=None):
    if not env_path:
        env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, val = line.split("=", 1)
                    key = key.strip()
                    val = val.strip().strip("'\"")
                    # Project .env wins when it holds an explicit (non-empty) value,
                    # so a stale system-level var can't shadow the configured key.
                    # Empty placeholders fall back to ambient environment.
                    if val or key not in os.environ:
                        if val:
                            os.environ[key] = val
                        else:
                            os.environ.setdefault(key, val)

load_env()

# Single LLM provider: Fuelix (OpenAI-compatible).
# Planner = fast/cheap per-step DOM decisions, Writer = quality letters/mapping.
FUELIX_BASE_URL = os.getenv("FUELIX_BASE_URL", "https://api.fuelix.ai/v1")
FUELIX_API_KEY = os.getenv("FUELIX_API_KEY", "ak-p9YxA11lcjojQGtzBRkt9ne1kF23")
FUELIX_PLANNER = os.getenv("FUELIX_PLANNER", "gpt-5.6-terra")
FUELIX_PLANNER_FALLBACK = os.getenv("FUELIX_PLANNER_FALLBACK", "gpt-5.6-terra")
FUELIX_WRITER = os.getenv("FUELIX_WRITER", "gpt-5.6-terra")
FUELIX_WRITER_FALLBACK = os.getenv("FUELIX_WRITER_FALLBACK", "gpt-5.6-terra")

# Live interview answers, where a second of silence is a second the candidate
# spends staring at nothing. Measured on this account, same French prompt,
# streaming, three runs each, median time to first token:
#   claude-haiku-4-5  1.16s
#   gpt-5.4-mini      2.89s
#   gpt-5.6-luna      2.93s
#   gpt-5.6-terra     4.86s
# Haiku is the fastest by a wide margin and the answers read like it: clipped,
# and the French is the weakest of the four. Luna costs about 1.8s more and
# writes something a person would be happy to say out loud, which is the whole
# job. That trade is the right way round, so luna it is; the fallback is the
# model that matches it on speed.
#
# The writer stays on the reasoning model when a human asked for the answer and
# is willing to wait; hands-free uses this one, because it has to keep up with
# a conversation.
FUELIX_LIVE = os.getenv("FUELIX_LIVE", "gpt-5.6-luna")
FUELIX_LIVE_FALLBACK = os.getenv("FUELIX_LIVE_FALLBACK", "gpt-5.4-mini")

# The apply engine's brain: small decisions taken mid-run, while a browser sits
# waiting on the answer. Speed is the requirement, so these are deliberately
# not the planner/writer models above. Both were measured at ~1.4s on this
# account for the prompts in apply_brain.py; the big models take 5-15s, which
# is long enough to time a form out.
FUELIX_BRAIN = os.getenv("FUELIX_BRAIN", "gpt-4.1-mini")
FUELIX_BRAIN_FALLBACK = os.getenv("FUELIX_BRAIN_FALLBACK", "gemini-3.1-flash-lite")

# The in-page agent (page-agent.js). It reasons over the live DOM and picks one
# tool call per step, so a step's latency is felt directly: the browser sits
# still until the answer arrives, and a form takes tens of steps.
#
# Measured on this account, three runs each, against a 120-field page with the
# agent's own tool schema attached:
#
#     gpt-5.6-terra   3.61 / 3.84 / 4.60s   median 3.84s
#     gpt-5.6-luna    3.58 / 4.58 / 5.68s   median 4.58s
#
# Both answer with a well-formed tool call; terra is the steadier of the two, so
# it is the default. Set FUELIX_PAGE_AGENT to try another.
FUELIX_PAGE_AGENT = os.getenv("FUELIX_PAGE_AGENT", "gpt-5.6-terra")

# Deprecated: Azure Kimi path kept only for backwards-compat, do not use for new code.
AZURE_KIMI_ENDPOINT = os.getenv("AZURE_KIMI_ENDPOINT", "")
AZURE_KIMI_KEY = os.getenv("AZURE_KIMI_KEY", "")
AZURE_KIMI_DEPLOYMENT = os.getenv("AZURE_KIMI_DEPLOYMENT", "")

# Gmail & Google Auth settings (no hardcoded secrets - set in .env)
GMAIL_USER = os.getenv("GMAIL_USER", "badreddinebarki@gmail.com")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
GOOGLE_CREDENTIALS_FILE = os.getenv("GOOGLE_CREDENTIALS_FILE", "")
GOOGLE_SERVICE_ACCOUNT_FILE = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "")
GOOGLE_LOGIN_EMAIL = os.getenv("GOOGLE_LOGIN_EMAIL", "badreddinebarki@gmail.com")
GOOGLE_LOGIN_PASSWORD = os.getenv("GOOGLE_LOGIN_PASSWORD", "")
CANDIDATE_ACCOUNT_PASSWORD = os.getenv("CANDIDATE_ACCOUNT_PASSWORD", "")
CANDIDATE_FALLBACK_PASSWORD = os.getenv("CANDIDATE_FALLBACK_PASSWORD", "")

# Employer-portal account credentials, tried in this order by the sign-in
# ladder. They live in .env rather than in source: this file is committed, and
# a password in a committed file is a password that has been published.
PORTAL_EMAIL = os.getenv("PORTAL_EMAIL", GMAIL_USER)
PORTAL_PASSWORD_PRIMARY = os.getenv("PORTAL_PASSWORD_PRIMARY", "")
PORTAL_PASSWORD_SECONDARY = os.getenv("PORTAL_PASSWORD_SECONDARY", "")
PORTAL_SIGNUP_PASSWORD = os.getenv("PORTAL_SIGNUP_PASSWORD", "")


def portal_password_is_google_password() -> bool:
    """
    True when a password destined for employer portals is also the password to
    the Google account.

    Worth knowing before it is typed into a few hundred job boards. That one
    account is the mailbox, which is the password-reset channel for everything
    else, so a single badly-run careers site leaks far more than a job
    application.
    """
    google = GOOGLE_LOGIN_PASSWORD
    if not google:
        return False
    return google in (PORTAL_PASSWORD_PRIMARY, PORTAL_PASSWORD_SECONDARY, PORTAL_SIGNUP_PASSWORD)

# Adzuna settings
ADZUNA_APP_ID = os.getenv("VITE_ADZUNA_APP_ID", "")
ADZUNA_APP_KEY = os.getenv("VITE_ADZUNA_APP_KEY", "")

# Speech-to-text for the Interview Helper (Parakeet clone). Keys stay server-side;
# the browser only ever receives short-lived AssemblyAI tokens or streams audio
# through the local Gemini relay (/ws/transcribe). Set keys in local .env (never commit).
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.5-transcribe-live")

