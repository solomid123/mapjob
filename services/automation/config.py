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

# Adzuna settings
ADZUNA_APP_ID = os.getenv("VITE_ADZUNA_APP_ID", "")
ADZUNA_APP_KEY = os.getenv("VITE_ADZUNA_APP_KEY", "")

# Speech-to-text for the Interview Helper (Parakeet clone). Keys stay server-side;
# the browser only ever receives short-lived AssemblyAI tokens or streams audio
# through the local Gemini relay (/ws/transcribe). Set keys in local .env (never commit).
ASSEMBLYAI_API_KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_LIVE_MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.5-transcribe-live")

