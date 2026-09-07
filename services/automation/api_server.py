import os
import sys
import time
import json
import queue
import threading
import tempfile
import shutil

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    import asyncio
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass

from typing import Optional
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, Response
import urllib.request
import re
import requests
import pydantic
import uvicorn

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
from services.automation.ai_dom_agent import AIDOMAgent
from services.automation.candidate_profile import CANDIDATE_PROFILE
from services.automation.page_agent_manager import PageAgentManager
import undetected_chromedriver as uc

app = FastAPI(title="MapJob Automation Bridge")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

log_queue = queue.Queue()
active_agent_status = {
    "is_running": False,
    "last_result": None
}

current_manager_container = {"manager": None}
current_driver_container = {"driver": None}

agent_state = {
    "is_running": False,
    "job_title": "",
    "company": "",
    "target_url": "",
    "phase": "idle",
    "current_step": "Ready",
    "logs": [],
    "screenshot": None,
    "last_result": None
}

class ApplyRequest(pydantic.BaseModel):
    url: str
    job_title: Optional[str] = ""
    company: Optional[str] = ""
    headless: Optional[bool] = False

def push_log(message: str, step: int = 0, status: str = "running", done: bool = False, success: bool = False):
    safe_msg = str(message).encode('utf-8', 'replace').decode('utf-8')
    print(f"[Engine] {safe_msg}", flush=True)
    payload = {
        "timestamp": time.strftime("%H:%M:%S"),
        "message": safe_msg,
        "step": step,
        "status": status,
        "done": done,
        "success": success
    }
    log_queue.put(payload)
    agent_state["current_step"] = safe_msg
    agent_state["logs"].append(payload)
    if len(agent_state["logs"]) > 100:
        agent_state["logs"] = agent_state["logs"][-100:]
    if done:
        agent_state["phase"] = "submitted" if success else "failed"
        agent_state["is_running"] = False
        active_agent_status["is_running"] = False
    elif step >= 5:
        agent_state["phase"] = "autonomous_agent"
    elif step >= 3:
        agent_state["phase"] = "filling_form"
    elif step >= 1:
        agent_state["phase"] = "navigating"

def resolve_direct_portal(url: str) -> str:
    """
    If given an Adzuna aggregator URL (details or land/ad),
    resolves the genuine destination employer portal (e.g. careers.ecm-crit.com, HelloWork, Greenhouse, Lever, etc.)
    before browser launch so we don't get trapped by Adzuna newsletter/alert modals.
    """
    if not any(dom in url for dom in ["adzuna.", "adzuna/"]):
        return url
    try:
        s = requests.Session()
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        }
        r1 = s.get(url, headers=headers, timeout=10)
        land_match = re.search(r'href="([^"]*/land/ad/[^"]*)"', r1.text)
        land_url = land_match.group(1) if land_match else (url if "/land/ad/" in url else None)
        if land_url:
            if land_url.startswith('/'):
                from urllib.parse import urljoin
                land_url = urljoin(url, land_url)
            headers['Referer'] = url
            r2 = s.get(land_url, headers=headers, timeout=10)
            meta = re.search(r'<meta[^>]*http-equiv=["\']refresh["\'][^>]*content=["\']\d+;\s*url=([^"\']+)["\']', r2.text, re.I)
            if meta and meta.group(1):
                return meta.group(1)
            loc = re.search(r'location\.(?:replace|href)\s*=\s*["\'](https?://[^"\']+)["\']', r2.text)
            if loc and loc.group(1):
                return loc.group(1)
            if r2.url and "adzuna." not in r2.url:
                return r2.url
    except Exception as e:
        print(f"[Resolver] Notice: {e}")
    return url

def run_agent_thread(target_url: str, job_title: str = "Candidate Position", company: str = "Employer", headless: bool = False):
    active_agent_status["is_running"] = True
    push_log(f"Starting Autonomous AI Application Engine for URL: {target_url}", step=1)
    
    # 1. Pre-resolve direct destination portal if this is an Adzuna aggregator wrapper
    resolved_url = resolve_direct_portal(target_url)
    if resolved_url != target_url:
        push_log(f"Resolved direct employer portal: {resolved_url}", step=1)
        target_url = resolved_url

    driver = None
    profile_dir = None
    try:
        push_log("Configuring browser with anti-detect and session parameters...", step=2)
        options = uc.ChromeOptions()
        # ALWAYS run with visible maximized browser window so the user sees PageAgent in action
        options.add_argument("--start-maximized")
        options.add_argument("--disable-web-security")
        options.add_argument("--allow-running-insecure-content")
        options.add_argument("--no-first-run")
        options.add_argument("--no-default-browser-check")

        # Isolated temporary profile to avoid lock conflicts from any previous background Chrome process
        profile_dir = tempfile.mkdtemp(prefix="mapjob_chrome_")

        push_log("Opening browser window on screen...", step=2)
        driver = uc.Chrome(options=options, user_data_dir=profile_dir)
        current_driver_container["driver"] = driver
        try:
            driver.maximize_window()
        except Exception:
            pass
        try:
            driver.execute_cdp_cmd("Page.bringToFront", {})
        except Exception:
            pass
        
        # Inject cookie vault for recognized sites if any
        try:
            agent_dom = AIDOMAgent(driver)
            agent_dom.inject_cookie_vault()
        except Exception:
            pass

        push_log(f"Navigating to employer portal: {target_url}", step=3)
        driver.get(target_url)
        time.sleep(2)

        # Initialize PageAgentManager (MapJOB_browser-extension architecture powered by Fuelix)
        page_manager = PageAgentManager(driver, log_callback=push_log)
        current_manager_container["manager"] = page_manager
        
        # Run autonomous agent loop
        res = page_manager.run_agent(job_title=job_title, company=company, candidate=CANDIDATE_PROFILE)
        
        success = res.get("success", False)
        barrier = res.get("barrier", False)
        msg = res.get("message", "Application completed.")
        
        if success:
            push_log(f"🎉 Application Submitted & Verified: {msg}", step=10, done=True, success=True)
        elif barrier:
            push_log(f"⚠️ Portal Barrier: {msg}", step=10, done=True, success=False)
        else:
            push_log(f"⚠️ Application Incomplete: {msg}", step=10, done=True, success=False)

        active_agent_status["last_result"] = {"success": success, "barrier": barrier, "message": msg}
        agent_state["last_result"] = active_agent_status["last_result"]

    except Exception as e:
        push_log(f"Automation execution notice: {e}", step=99, done=True, success=False)
        active_agent_status["last_result"] = {"success": False, "message": str(e)}
        agent_state["last_result"] = active_agent_status["last_result"]
    finally:
        active_agent_status["is_running"] = False
        agent_state["is_running"] = False
        current_manager_container["manager"] = None
        current_driver_container["driver"] = None
        if driver:
            try:
                time.sleep(5)
                driver.quit()
            except Exception:
                pass
        if profile_dir and os.path.exists(profile_dir):
            try:
                shutil.rmtree(profile_dir, ignore_errors=True)
            except Exception:
                pass

@app.get("/")
def root():
    return {
        "status": "online",
        "service": "MapJob Automation Bridge",
        "candidate": "Badreddine Barki",
        "endpoints": {
            "web_ui": "http://localhost:5173",
            "api_status": "http://127.0.0.1:8000/api/status",
            "api_state": "http://127.0.0.1:8000/api/apply/state",
            "api_docs": "http://127.0.0.1:8000/docs",
            "cv_download": "http://127.0.0.1:8000/Badreddine_Barki_CV.pdf"
        }
    }

@app.post("/api/cancel")
def cancel_application():
    active_agent_status["is_running"] = False
    agent_state["is_running"] = False
    agent_state["phase"] = "cancelled"
    driver = current_driver_container.get("driver")
    if driver:
        try:
            driver.quit()
        except Exception:
            pass
        current_driver_container["driver"] = None
    current_manager_container["manager"] = None
    push_log("Application cancelled by user.", done=True, success=False)
    return {"status": "cancelled"}

@app.get("/api/apply/state")
def get_apply_state():
    manager = current_manager_container.get("manager")
    screenshot = None
    if manager and hasattr(manager, "latest_screenshot") and manager.latest_screenshot:
        screenshot = manager.latest_screenshot
    elif agent_state.get("screenshot"):
        screenshot = agent_state.get("screenshot")

    return {
        "is_running": agent_state["is_running"],
        "job_title": agent_state["job_title"],
        "company": agent_state["company"],
        "target_url": agent_state["target_url"],
        "phase": agent_state["phase"],
        "current_step": agent_state["current_step"],
        "logs": agent_state["logs"][-35:],
        "screenshot": screenshot,
        "last_result": agent_state["last_result"]
    }

@app.post("/api/apply")
def start_application(req: ApplyRequest):
    if active_agent_status["is_running"]:
        raise HTTPException(status_code=400, detail="An application is already running in background.")
    
    # Clear old logs
    while not log_queue.empty():
        try:
            log_queue.get_nowait()
        except Exception:
            break

    active_agent_status["is_running"] = True
    active_agent_status["last_result"] = None

    agent_state["is_running"] = True
    agent_state["job_title"] = req.job_title or "Position"
    agent_state["company"] = req.company or "Employer"
    agent_state["target_url"] = req.url
    agent_state["phase"] = "navigating"
    agent_state["current_step"] = "Opening browser on employer portal..."
    agent_state["logs"] = []
    agent_state["screenshot"] = None
    agent_state["last_result"] = None

    t = threading.Thread(
        target=run_agent_thread,
        args=(req.url, req.job_title or "Candidate Position", req.company or "Employer", req.headless),
        daemon=True
    )
    t.start()
    return {"status": "started", "url": req.url}

@app.get("/api/apply/stream")
async def stream_logs(request: Request):
    async def event_generator():
        import asyncio
        while True:
            if await request.is_disconnected():
                break
            try:
                try:
                    msg = log_queue.get_nowait()
                    yield f"data: {json.dumps(msg)}\n\n"
                    if msg.get("done"):
                        break
                except queue.Empty:
                    if not active_agent_status["is_running"]:
                        break
                    yield ": keep-alive\n\n"
                await asyncio.sleep(0.5)
            except Exception:
                break
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/Badreddine_Barki_CV.pdf")
@app.get("/cv.pdf")
def get_cv():
    cv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "Badreddine_Barki_CV.pdf"))
    if os.path.exists(cv_path):
        return FileResponse(cv_path, media_type="application/pdf", filename="Badreddine_Barki_CV.pdf")
    raise HTTPException(status_code=404, detail="CV not found")

@app.get("/api/auto-apply/lookup")
def auto_apply_lookup(url: Optional[str] = None):
    return {
        "candidate": {
            "fullName": CANDIDATE_PROFILE.get("full_name", "Badreddine Barki"),
            "firstName": CANDIDATE_PROFILE.get("first_name", "Badreddine"),
            "lastName": CANDIDATE_PROFILE.get("last_name", "Barki"),
            "email": CANDIDATE_PROFILE.get("email", "badreddinebarki@gmail.com"),
            "phone": CANDIDATE_PROFILE.get("phone_formatted", "+33 7 45 76 80 10"),
            "city": CANDIDATE_PROFILE.get("city", "Amiens"),
            "postalCode": CANDIDATE_PROFILE.get("postal_code", "80000"),
            "address": CANDIDATE_PROFILE.get("address", "14 Rue de la 2e D.B."),
            "country": CANDIDATE_PROFILE.get("country", "France"),
            "linkedin": CANDIDATE_PROFILE.get("linkedin", "https://linkedin.com/in/badreddine-barki"),
            "portfolio": CANDIDATE_PROFILE.get("website", "https://barkibadreddine.com"),
            "jobTitle": CANDIDATE_PROFILE.get("current_title", "Ingénieur en Génie Mécanique"),
            "experienceYears": str(CANDIDATE_PROFILE.get("years_of_experience", 3)),
            "motivation": "Ingénieur en mécanique et simulation industrielle passionné par la conception et la gestion de projets techniques."
        },
        "jobTitle": "Ingénieur",
        "companyName": "",
        "cvPdfUrl": "http://127.0.0.1:8000/Badreddine_Barki_CV.pdf",
        "coverLetterPdfUrl": None
    }

@app.api_route("/api/llm-proxy/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def llm_proxy(request: Request, path: str):
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL
    fuelix_url = f"{FUELIX_BASE_URL.rstrip('/')}/{path}"
    fuelix_key = FUELIX_API_KEY
    if not fuelix_key:
        raise HTTPException(status_code=500, detail="FUELIX_API_KEY not set in .env")
    body = await request.body()
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {fuelix_key}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    req = urllib.request.Request(fuelix_url, data=body if body else None, headers=headers, method=request.method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            content = resp.read()
            return Response(content=content, status_code=resp.status, media_type="application/json")
    except urllib.error.HTTPError as e:
        err_content = e.read()
        return Response(content=err_content, status_code=e.code, media_type="application/json")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class InterviewAnswerRequest(pydantic.BaseModel):
    question: str = ""
    transcript: str = ""
    lang: str = "fr"

class InterviewAnalyzeRequest(pydantic.BaseModel):
    image: str = ""  # data URL (jpeg/png) screenshot of the shared tab
    question: str = ""

def _candidate_summary() -> str:
    try:
        p = CANDIDATE_PROFILE
        lines = [
            f"Name: {p.get('full_name', 'Badreddine Barki')}",
            f"Title: {p.get('current_title', '')} ({p.get('years_of_experience', '')}y)",
            f"Location: {p.get('city', '')}, {p.get('country', '')}",
            f"Email: {p.get('email', '')} | Phone: {p.get('phone_formatted', '')}",
            f"Skills: {', '.join(p.get('technical_skills', [])[:18])}",
            f"Languages: {json.dumps(p.get('languages', {}), ensure_ascii=False)}",
        ]
        for exp in p.get("experiences", [])[:3]:
            lines.append(f"- {exp.get('role', '')} @ {exp.get('company', '')} ({exp.get('period', '')}): {'; '.join(exp.get('highlights', [])[:3])}")
        for edu in p.get("education", [])[:2]:
            lines.append(f"- Edu: {edu.get('degree', '')}, {edu.get('institution', '')} ({edu.get('period', '')})")
        return "\n".join(lines)
    except Exception:
        return "Badreddine Barki, Ingenieur en Genie Mecanique, 3.5y R&D (Technip Energies, SLB), CAO CATIA/SolidWorks/Creo, FEA Abaqus/Ansys."

@app.get("/api/assembly/token")
def assembly_token():
    """Mint a short-lived AssemblyAI realtime token so the browser never sees the API key."""
    from services.automation.config import ASSEMBLYAI_API_KEY
    if not ASSEMBLYAI_API_KEY:
        raise HTTPException(status_code=500, detail="ASSEMBLYAI_API_KEY not set in .env")
    try:
        r = requests.post(
            "https://api.assemblyai.com/v2/realtime/token",
            headers={"Authorization": ASSEMBLYAI_API_KEY, "Content-Type": "application/json"},
            json={"expires_in_seconds": 600},
            timeout=15,
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"AssemblyAI token error: {r.text[:300]}")
        return {"token": r.json().get("token")}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@app.post("/api/interview/answer")
def interview_answer(req: InterviewAnswerRequest):
    """Generate a spoken-style interview answer from live transcript + CV via Fuelix."""
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL, FUELIX_WRITER, FUELIX_WRITER_FALLBACK
    question = (req.question or req.transcript or "").strip()[-1500:]
    if not question:
        raise HTTPException(status_code=400, detail="Empty question/transcript")
    lang = "French" if req.lang == "fr" else "English"
    system = (
        "You are a real-time interview copilot for Badreddine Barki, mechanical/R&D engineer. "
        f"Answer in {lang}, first person, 60-90 seconds spoken (120-170 words), STAR structure. "
        "Ground every claim in the CV below; never invent employers, degrees, or visa status. "
        "End with one crisp metric or result. No preamble, answer only."
    )
    user = f"CANDIDATE CV:\n{_candidate_summary()}\n\nLIVE INTERVIEW (last words first):\n{req.transcript.strip()[-2000:]}\n\nCURRENT QUESTION:\n{question}"
    for model in [FUELIX_WRITER, FUELIX_WRITER_FALLBACK]:
        if not model or not FUELIX_API_KEY:
            continue
        try:
            r = requests.post(
                f"{FUELIX_BASE_URL.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {FUELIX_API_KEY}", "Content-Type": "application/json"},
                json={"model": model, "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ], "temperature": 0.4, "max_tokens": 450},
                timeout=45,
            )
            if r.status_code == 200:
                return {"answer": r.json()["choices"][0]["message"]["content"].strip(), "model": model}
        except Exception:
            continue
    # Offline heuristic fallback (STAR, CV-grounded)
    return {"answer": (
        "Bonne question. Chez SLB puis Technip Energies, sur un sujet similaire : "
        "Situation - dimensionnement d'un assemblage sous chargement thermomecanique severe ; "
        "Tache - livrer une conception validee CAO 3D CATIA/SolidWorks avec justification FEA Abaqus/Ansys ; "
        "Action - modele parametrique, maillage converge, correlation essais et cotation GPS ISO ; "
        "Resultat - dossier valide en revue, zero reprise en industrialisation. "
        "Je peux detailler le maillage ou la DFMEA si vous voulez."
    ), "model": "heuristic"}

@app.post("/api/interview/analyze")
def interview_analyze(req: InterviewAnalyzeRequest):
    """Describe what's on the shared-tab screenshot to help answer (vision best-effort)."""
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL, FUELIX_WRITER
    if not req.image:
        raise HTTPException(status_code=400, detail="Empty image")
    if FUELIX_API_KEY:
        try:
            r = requests.post(
                f"{FUELIX_BASE_URL.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {FUELIX_API_KEY}", "Content-Type": "application/json"},
                json={"model": FUELIX_WRITER, "messages": [
                    {"role": "system", "content": "Describe the interview screen in 3 bullets: visible question/code/slide, speaker name if any, and what the candidate should focus on. Under 80 words."},
                    {"role": "user", "content": [
                        {"type": "text", "text": req.question or "What is on screen?"},
                        {"type": "image_url", "image_url": {"url": req.image[:200000]}},
                    ]},
                ], "temperature": 0.2, "max_tokens": 250},
                timeout=45,
            )
            if r.status_code == 200:
                return {"analysis": r.json()["choices"][0]["message"]["content"].strip()}
        except Exception:
            pass
    return {"analysis": "Vision unavailable (model/key). Read the question aloud via AI Answer instead."}

@app.get("/api/gemini/status")
def gemini_status():
    from services.automation.config import GEMINI_API_KEY, GEMINI_LIVE_MODEL
    return {"configured": bool(GEMINI_API_KEY), "model": GEMINI_LIVE_MODEL or "gemini-3.5-transcribe-live"}

@app.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket, lang: str = "fr"):
    """
    Realtime audio transcription relay:
    Streams 16kHz PCM audio chunks from browser (tab audio or mic) and
    transcribes using Fuelix Whisper-1 (with SpeechRecognition fallback),
    or Gemini Live if configured.
    """
    import asyncio
    import io
    import wave
    import struct
    import math
    import base64
    import openai
    import speech_recognition as sr
    from services.automation.config import FUELIX_API_KEY, FUELIX_BASE_URL, GEMINI_API_KEY, GEMINI_LIVE_MODEL

    await websocket.accept()
    # Direct Ultra-Low Latency Streaming Speech Relay (Raw L16 + Connection Pooling)
    await websocket.send_json({"status": "live", "engine": "live", "model": "google-live-v2"})

    http_session = requests.Session()

    def query_google_speech_l16(sess: requests.Session, pcm_bytes: bytes, l_code: str) -> str:
        url = f"http://www.google.com/speech-api/v2/recognize?client=chromium&lang={l_code}&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw"
        headers = {"Content-Type": "audio/l16; rate=16000"}
        try:
            resp = sess.post(url, headers=headers, data=pcm_bytes, timeout=2.5)
            if resp.status_code == 200:
                resp.encoding = "utf-8"
                for line in resp.text.strip().split("\n"):
                    try:
                        p_data = json.loads(line)
                        results = p_data.get("result", [])
                        if results and len(results) > 0:
                            alt = results[0].get("alternative", [])
                            if alt and len(alt) > 0:
                                return alt[0].get("transcript", "").strip()
                    except Exception:
                        continue
        except Exception:
            pass
        return ""

    speech_buffer = bytearray()
    speech_active = False
    silent_chunks_count = 0
    chunks_since_interim = 0
    last_transcript = ""
    last_interim = ""
    interim_inflight = False

    pref_lang = "fr-FR" if lang == "fr" else "en-US"
    fallback_lang = "en-US" if lang == "fr" else "fr-FR"

    hallucinations = {
        "you", "thank you", "thank you.", "merci", "merci.", "merci d'avoir regardé",
        "merci d'avoir regardé cette vidéo", "sous-titres réalisés par",
        "sous-titrage st'501", "bye", "bye bye", "thank you for watching", "silence",
        "foreign", "whispering", "music", "qu'est-ce que c'est que l'humanité"
    }

    async def run_interim(audio_snap: bytes, l_code: str):
        nonlocal interim_inflight, last_interim
        try:
            txt = await asyncio.to_thread(query_google_speech_l16, http_session, audio_snap, l_code)
            if txt:
                c_low = txt.lower().strip(' .,!?:;')
                if c_low not in hallucinations and c_low != last_interim.lower() and c_low != last_transcript.lower():
                    last_interim = txt
                    await websocket.send_json({
                        "transcript": txt,
                        "final": False,
                        "engine": "live"
                    })
        except Exception:
            pass
        finally:
            interim_inflight = False

    client = None
    if FUELIX_API_KEY:
        try:
            client = openai.OpenAI(base_url=FUELIX_BASE_URL, api_key=FUELIX_API_KEY)
        except Exception:
            client = None

    # Sensitive VAD threshold for digital tab audio & browser mic
    VAD_RMS_THRESHOLD = 30

    try:
        while True:
            data = await websocket.receive_json()
            if data.get("end"):
                break

            if data.get("type") == "set_lang" or ("lang" in data and "audio_data" not in data):
                new_l = data.get("lang", "en")
                pref_lang = "fr-FR" if new_l == "fr" else "en-US"
                fallback_lang = "en-US" if new_l == "fr" else "fr-FR"
                continue

            chunk_b64 = data.get("audio_data")
            if not chunk_b64:
                continue

            try:
                raw_chunk = base64.b64decode(chunk_b64)
            except Exception:
                continue

            count = len(raw_chunk) // 2
            if count == 0:
                continue

            # Compute RMS of current chunk
            try:
                shorts = struct.unpack(f"<{count}h", raw_chunk)
                rms = math.sqrt(sum(s * s for s in shorts) / count)
            except Exception:
                rms = 0

            # VAD: speech active if RMS > VAD_RMS_THRESHOLD (captures clear tab sound without clipping)
            if rms >= VAD_RMS_THRESHOLD:
                speech_active = True
                speech_buffer.extend(raw_chunk)
                silent_chunks_count = 0
                chunks_since_interim += 1

                # Real-time interim streaming every ~380ms while speaking
                if chunks_since_interim >= 3 and len(speech_buffer) >= 9600 and not interim_inflight:
                    interim_inflight = True
                    chunks_since_interim = 0
                    snap = bytes(speech_buffer)
                    asyncio.create_task(run_interim(snap, pref_lang))

                # Continuous speech boundary (6.0s max per utterance): finalize smoothly with 500ms acoustic overlap
                if len(speech_buffer) >= 192000:
                    to_process = bytes(speech_buffer)
                    speech_buffer = bytearray(speech_buffer[-16000:])
                    silent_chunks_count = 0
                    chunks_since_interim = 0

                    transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, pref_lang)
                    if not transcribed_text:
                        transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, fallback_lang)
                    if transcribed_text:
                        c_low = transcribed_text.lower().strip(' .,!?:;')
                        if c_low not in hallucinations and c_low != last_transcript.lower():
                            last_transcript = transcribed_text
                            last_interim = ""
                            await websocket.send_json({
                                "transcript": transcribed_text,
                                "final": True,
                                "engine": "live"
                            })

            elif speech_active:
                silent_chunks_count += 1
                speech_buffer.extend(raw_chunk)

                # Utterance complete: natural conversational pause of ~380ms (3 silent chunks) with >= 0.3s audio (9600 bytes)
                if silent_chunks_count >= 3 and len(speech_buffer) >= 9600:
                    to_process = bytes(speech_buffer)
                    speech_buffer = bytearray()
                    speech_active = False
                    silent_chunks_count = 0
                    chunks_since_interim = 0
                    last_interim = ""

                    transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, pref_lang)
                    if not transcribed_text:
                        transcribed_text = await asyncio.to_thread(query_google_speech_l16, http_session, to_process, fallback_lang)

                    # Secondary fallback: Fuelix Whisper (if Google couldn't parse the acoustic)
                    if not transcribed_text and client and len(to_process) >= 16000:
                        try:
                            buf = io.BytesIO()
                            with wave.open(buf, "wb") as wf:
                                wf.setnchannels(1)
                                wf.setsampwidth(2)
                                wf.setframerate(16000)
                                wf.writeframes(to_process)
                            buf.name = "chunk.wav"
                            buf.seek(0)
                            res = await asyncio.to_thread(client.audio.transcriptions.create, model="whisper-1", file=buf)
                            transcribed_text = (res.text or "").strip()
                        except Exception:
                            pass

                    # Output final immediately
                    if transcribed_text:
                        c_low = transcribed_text.lower().strip(' .,!?:;')
                        if c_low not in hallucinations and c_low != last_transcript.lower():
                            last_transcript = transcribed_text
                            await websocket.send_json({
                                "transcript": transcribed_text,
                                "final": True,
                                "engine": "live"
                            })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"error": f"Transcribe relay: {str(e)[:200]}"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass

@app.get("/api/status")
def get_status():
    return active_agent_status

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
