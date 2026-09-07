import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Trash2, Sparkles, MonitorUp, Square,
  Maximize2, RefreshCw, Copy, Check, Loader2, ScanEye,
  ArrowLeft, Clock,
} from 'lucide-react';
import {
  createInterviewSession,
  recordTranscriptLine,
  recordInterviewQA,
  finishInterviewSession,
} from '../services/supabase';

interface InterviewHelperModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TranscriptLine {
  id: number;
  text: string;
  final: boolean;
  ts: string;
}

interface AnswerCard {
  id: number;
  question: string;
  answer: string;
  model: string;
  ts: string;
}

const BACKEND = 'http://127.0.0.1:8000';
const SESSION_SECONDS = 30 * 60;

function nowTs(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function heuristicAnswer(question: string): string {
  return (
    `Bonne question${question ? ` — « ${question.slice(0, 90)} »` : ''}. ` +
    'Chez SLB puis Technip Energies, sur un sujet similaire : ' +
    'Situation — dimensionnement sous chargement thermomécanique sévère ; ' +
    'Tâche — livrer une conception CAO 3D (CATIA / SolidWorks / Creo) justifiée par FEA Abaqus / Ansys ; ' +
    'Action — modèle paramétrique, convergence de maillage, corrélation essais, cotation GPS ISO ; ' +
    'Résultat — dossier validé en revue, zéro reprise en industrialisation.'
  );
}

export const InterviewHelperModal: React.FC<InterviewHelperModalProps> = ({ isOpen, onClose }) => {
  const [sharing, setSharing] = useState(false);
  const [shareLabel, setShareLabel] = useState('');
  const [connected, setConnected] = useState(false);
  type Engine = 'live' | 'whisper' | 'google' | 'gemini' | 'assemblyai' | 'browser';
  const [engine, setEngine] = useState<Engine | null>(null);
  const [enginePref, setEnginePref] = useState<Engine>('live');
  const [hasAudioInput, setHasAudioInput] = useState(false);
  const [audioActive, setAudioActive] = useState(false);
  const [engineNote, setEngineNote] = useState('');
  const [lang, setLang] = useState<'fr' | 'en'>('fr');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [answers, setAnswers] = useState<AnswerCard[]>([]);
  const [manual, setManual] = useState('');
  const [thinking, setThinking] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const recogRef = useRef<any>(null);
  const relayWsRef = useRef<WebSocket | null>(null);
  const detachPcmRef = useRef<(() => void) | null>(null);
  const relaySessionRef = useRef(0);
  const geminiAttemptsRef = useRef(0);
  const enginePrefRef = useRef<Engine>('live');
  const lineId = useRef(1);
  const answerId = useRef(1);
  const autoScrollRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const answersEndRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  autoScrollRef.current = autoScroll;

  const handleLangChange = useCallback((newLang: 'fr' | 'en') => {
    setLang(newLang);
    if (relayWsRef.current && relayWsRef.current.readyState === WebSocket.OPEN) {
      relayWsRef.current.send(JSON.stringify({ type: 'set_lang', lang: newLang }));
    }
    if (recogRef.current) {
      try {
        recogRef.current.lang = newLang === 'fr' ? 'fr-FR' : 'en-US';
      } catch { /* noop */ }
    }
  }, []);

  const pushLine = useCallback((text: string, fin: boolean) => {
    const clean = text.trim();
    if (!clean) return;
    const ts = nowTs();
    setLines((prev) => {
      if (!fin) {
        const last = prev[prev.length - 1];
        if (last && !last.final) {
          return [...prev.slice(0, -1), { ...last, text: clean, ts }];
        }
        return [...prev, { id: lineId.current++, text: clean, final: false, ts }];
      }
      const last = prev[prev.length - 1];
      if (last && !last.final) {
        return [...prev.slice(0, -1), { ...last, text: clean, final: true, ts }];
      }
      return [...prev, { id: lineId.current++, text: clean, final: true, ts }];
    });

    if (fin && sessionIdRef.current) {
      void recordTranscriptLine(sessionIdRef.current, clean, true, 'interviewer');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    if (autoScroll) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      answersEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [lines, answers, isOpen, autoScroll]);

  const stopAudioGraph = useCallback(() => {
    try { processorRef.current?.disconnect(); } catch { /* noop */ }
    processorRef.current = null;
    try { audioCtxRef.current?.close(); } catch { /* noop */ }
    audioCtxRef.current = null;
    try { wsRef.current?.close(); } catch { /* noop */ }
    wsRef.current = null;
    try { recogRef.current?.stop(); } catch { /* noop */ }
    recogRef.current = null;
  }, []);

  const stopTranscription = useCallback(() => {
    relaySessionRef.current += 1; // invalidates any pending Gemini auto-reconnect
    try { detachPcmRef.current?.(); } catch { /* noop */ }
    detachPcmRef.current = null;
    try { relayWsRef.current?.close(); } catch { /* noop */ }
    relayWsRef.current = null;
    stopAudioGraph();
  }, [stopAudioGraph]);

  const ensureAudioInput = useCallback(async (stream: MediaStream) => {
    if (stream.getAudioTracks().length > 0) return;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getAudioTracks().forEach((t) => stream.addTrack(t));
      (streamRef as any).micStream = mic;
      setEngineNote('Tab has no audio — using microphone instead.');
    } catch {
      setEngineNote("⚠️ No tab audio found. Tip: When sharing, check 'Also share tab audio' in Chrome.");
    }
  }, []);

  const attachPcmGraph = useCallback((stream: MediaStream, onChunk: (b64: string) => void) => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      setHasAudioInput(false);
      setEngineNote("⚠️ No tab audio found! When sharing in Chrome, please check 'Also share tab audio' in the share dialog.");
      return () => {};
    }
    setHasAudioInput(true);

    try {
      const audioStream = new MediaStream(audioTracks);
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new Ctx({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      const src = ctx.createMediaStreamSource(audioStream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      processorRef.current = proc;

      let speechTimer: ReturnType<typeof setTimeout> | null = null;

      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          sum += s * s;
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const rms = Math.sqrt(sum / input.length);
        if (rms > 0.001) {
          setAudioActive(true);
          if (speechTimer) clearTimeout(speechTimer);
          speechTimer = setTimeout(() => setAudioActive(false), 450);
        }

        let bin = '';
        const bytes = new Uint8Array(pcm.buffer);
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
        }
        onChunk(btoa(bin));
      };

      src.connect(proc);
      const silencer = ctx.createGain();
      silencer.gain.value = 0;
      proc.connect(silencer);
      silencer.connect(ctx.destination);

      return () => {
        if (speechTimer) clearTimeout(speechTimer);
        try { proc.disconnect(); } catch { /* noop */ }
        try { silencer.disconnect(); } catch { /* noop */ }
        try { src.disconnect(); } catch { /* noop */ }
        try { ctx.close(); } catch { /* noop */ }
        if (processorRef.current === proc) processorRef.current = null;
        if (audioCtxRef.current === ctx) audioCtxRef.current = null;
      };
    } catch (err) {
      console.error('attachPcmGraph error:', err);
      return () => {};
    }
  }, []);

  const startBrowserSpeech = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setEngineNote('Native Chrome speech unavailable. Please use AI Live Tab Relay or use Chrome/Edge.');
      return;
    }
    try {
      try { recogRef.current?.stop(); } catch { /* noop */ }
      const recog = new SR();
      recog.continuous = true;
      recog.interimResults = true;
      recog.lang = lang === 'fr' ? 'fr-FR' : 'en-US';
      recog.onresult = (ev: any) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const res = ev.results[i];
          if (res.isFinal) {
            pushLine(res[0].transcript, true);
          } else {
            interim += res[0].transcript;
          }
        }
        if (interim) pushLine(interim, false);
      };
      recog.onerror = (err: any) => {
        if (err.error === 'not-allowed') {
          setEngineNote('⚠️ Microphone blocked. Allow microphone permission in browser address bar.');
        }
      };
      recog.onend = () => {
        try { if (recogRef.current === recog) recog.start(); } catch { /* noop */ }
      };
      recogRef.current = recog;
      recog.start();
      setEngine('browser');
      setConnected(true);
      setEngineNote('⚡ Chrome Native Realtime Active (0ms word-by-word streaming).');
    } catch {
      setEngineNote('Could not start Chrome speech. Use AI Live Tab Relay.');
    }
  }, [lang, pushLine]);

  const startAssemblyAI = useCallback(async (stream: MediaStream) => {
    // Try AssemblyAI realtime via short-lived backend token; fall back to browser speech.
    let token = '';
    try {
      const r = await fetch(`${BACKEND}/api/assembly/token`);
      if (r.ok) token = (await r.json()).token || '';
    } catch { /* backend offline -> fallback */ }
    if (!token) {
      startBrowserSpeech();
      return;
    }

    try {
      await ensureAudioInput(stream);
      const ws = new WebSocket(
        `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true&token=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;
      let gotTranscript = false;

      ws.onopen = () => setEngineNote('AssemblyAI realtime connected.');
      ws.onerror = () => {
        if (!gotTranscript) {
          try { ws.close(); } catch { /* noop */ }
          startBrowserSpeech();
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const t = (msg.type || '').toLowerCase();
          if (t === 'turn' && msg.transcript) {
            gotTranscript = true;
            setEngine('assemblyai');
            pushLine(msg.transcript, Boolean(msg.end_of_turn));
          } else if (t === 'partialtranscript' && msg.text) {
            gotTranscript = true;
            setEngine('assemblyai');
            pushLine(msg.text, false);
          } else if (t === 'finaltranscript' && msg.text) {
            gotTranscript = true;
            setEngine('assemblyai');
            pushLine(msg.text, true);
          } else if (msg.text && (t.includes('partial') || t.includes('final'))) {
            gotTranscript = true;
            setEngine('assemblyai');
            pushLine(msg.text, t.includes('final'));
          }
        } catch { /* non-JSON keepalive */ }
      };
      ws.onclose = () => {
        if (!gotTranscript) startBrowserSpeech();
      };

      detachPcmRef.current?.();
      detachPcmRef.current = attachPcmGraph(stream, (b64) => {
        const open = wsRef.current;
        if (open && open.readyState === WebSocket.OPEN) open.send(JSON.stringify({ audio_data: b64 }));
      });
    } catch {
      startBrowserSpeech();
    }
  }, [pushLine, startBrowserSpeech, ensureAudioInput, attachPcmGraph]);

  const startGeminiRelay = useCallback(async (stream: MediaStream) => {
    // Gemini 3.5 Transcribe Live via the local backend relay (API key never hits the browser).
    // Auto-renews the session (Gemini caps Live sessions at ~10 min).
    const session = ++relaySessionRef.current;
    geminiAttemptsRef.current = 0;
    try {
      await ensureAudioInput(stream);
    } catch {
      setEngineNote('Microphone/tab audio unavailable.');
      startBrowserSpeech();
      return;
    }
    if (relaySessionRef.current !== session) return;

    const wsUrl = `${BACKEND.replace(/^http/, 'ws')}/ws/transcribe?lang=${lang}`;
    const connect = () => {
      if (relaySessionRef.current !== session) return;
      const ws = new WebSocket(wsUrl);
      relayWsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setEngine('whisper');
        setEngineNote('🟢 AI Live Transcribe connected. Listening to audio...');
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.transcript) {
            setEngine(msg.engine || 'whisper');
            pushLine(msg.transcript, Boolean(msg.final));
          } else if (msg.status === 'live') {
            setEngine(msg.engine || 'whisper');
            setEngineNote(`🟢 AI Live Speech Active (${msg.engine || 'Whisper-1'}). Streaming tab audio.`);
          } else if (msg.error) {
            setEngineNote(`Notice: ${msg.error}`);
          }
        } catch { /* noop */ }
      };
      ws.onclose = () => {
        if (relaySessionRef.current !== session) return;
        setTimeout(() => { if (relaySessionRef.current === session) connect(); }, 2000);
      };
    };

    detachPcmRef.current?.();
    detachPcmRef.current = attachPcmGraph(stream, (b64) => {
      const open = relayWsRef.current;
      if (open && open.readyState === WebSocket.OPEN) open.send(JSON.stringify({ audio_data: b64 }));
    });
    connect();
  }, [attachPcmGraph, ensureAudioInput, lang, pushLine, startBrowserSpeech]);

  const startEngine = useCallback(async (stream: MediaStream | null, pref: Engine) => {
    if (!sessionIdRef.current) {
      void createInterviewSession('Interview Session', 'Mechanical Engineer', lang).then((id) => {
        sessionIdRef.current = id;
      });
    }
    if (pref === 'browser') {
      startBrowserSpeech();
    } else if (stream) {
      if (pref === 'live' || pref === 'whisper' || pref === 'google' || pref === 'gemini') await startGeminiRelay(stream);
      else if (pref === 'assemblyai') await startAssemblyAI(stream);
      else startBrowserSpeech();
    } else {
      startBrowserSpeech();
    }
  }, [startAssemblyAI, startGeminiRelay, startBrowserSpeech, lang]);

  const stopSharing = useCallback(() => {
    if (sessionIdRef.current) {
      void finishInterviewSession(sessionIdRef.current, SESSION_SECONDS - secondsLeft);
      sessionIdRef.current = null;
    }
    stopTranscription();
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const mic = (streamRef as any).micStream as MediaStream | undefined;
      mic?.getTracks().forEach((t) => t.stop());
    } catch { /* noop */ }
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setSharing(false);
    setConnected(false);
    setEngine(null);
  }, [stopTranscription, secondsLeft]);

  const startSharing = useCallback(async () => {
    setError('');
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      const track = stream.getVideoTracks()[0];
      setShareLabel(track?.label || 'Shared tab');
      setSharing(true);
      setSecondsLeft(SESSION_SECONDS);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopSharing());
      await startEngine(stream, enginePrefRef.current);
      setConnected(true);
    } catch {
      setError('Tab share was cancelled or is not supported in this browser. Use Chrome/Edge.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEngine]);

  const exitAll = useCallback(() => {
    stopSharing();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    onClose();
  }, [stopSharing, onClose]);

  // Session countdown while sharing
  useEffect(() => {
    if (!isOpen || !sharing) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [isOpen, sharing]);

  // Cleanup on unmount / close
  useEffect(() => {
    if (!isOpen) {
      stopSharing();
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const askAI = useCallback(async (explicitQuestion?: string) => {
    const q = (explicitQuestion ?? '').trim() || currentQuestion();
    if (!q && lines.length === 0 && !explicitQuestion) {
      setError('No transcript yet — share the Meet tab, then click AI Answer.');
      return;
    }
    setThinking(true);
    setError('');
    const tail = lines.slice(-8).map((l) => l.text).join('\n');
    try {
      const r = await fetch(`${BACKEND}/api/interview/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q || tail.slice(-500), transcript: tail, lang }),
      });
      if (!r.ok) throw new Error(`backend ${r.status}`);
      const data = await r.json();
      pushAnswer(q || 'Live transcript', data.answer || heuristicAnswer(q), data.model || 'fuelix');
    } catch {
      pushAnswer(q || 'Live transcript', heuristicAnswer(q), 'offline heuristic');
      setEngineNote((n) => n || 'Answer backend offline — showing CV-grounded heuristic. Start api_server.py for Fuelix.');
    } finally {
      setThinking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lang]);

  const currentQuestion = (): string => {
    const finals = lines.filter((l) => l.final);
    const last = finals[finals.length - 1] || lines[lines.length - 1];
    return last ? last.text : '';
  };

  const pushAnswer = (question: string, answer: string, model: string) => {
    setAnswers((prev) => [...prev, { id: answerId.current++, question, answer, model, ts: nowTs() }]);
    if (sessionIdRef.current) {
      void recordInterviewQA(sessionIdRef.current, question, answer, model);
    }
  };

  const sendManual = useCallback(() => {
    const q = manual.trim();
    if (!q || thinking) return;
    setManual('');
    void askAI(q);
  }, [manual, thinking, askAI]);

  // Space shortcut = AI Answer (like Parakeet), ignored while typing
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        void askAI();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, askAI]);

  const analyzeScreen = useCallback(async () => {
    if (!videoRef.current || !sharing) {
      setError('Share the tab first, then Analyze Screen.');
      return;
    }
    setAnalyzing(true);
    try {
      const v = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 1280;
      canvas.height = v.videoHeight || 720;
      canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.7);
      const r = await fetch(`${BACKEND}/api/interview/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image, question: currentQuestion() }),
      });
      const data = r.ok ? await r.json() : { analysis: '' };
      pushAnswer('Screen analysis', data.analysis || 'Could not analyze the screen.', 'vision');
    } catch {
      pushAnswer('Screen analysis', 'Could not analyze the screen.', 'vision');
    } finally {
      setAnalyzing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing]);

  const copyAnswer = async (a: AnswerCard) => {
    try {
      await navigator.clipboard.writeText(a.answer);
      setCopiedId(a.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch { /* clipboard blocked */ }
  };

  if (!isOpen) return null;

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="flex-1 w-full max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-150">
      <div className="bg-white w-full h-full rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between bg-white shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-50 text-[#FF385C] flex items-center justify-center font-black shadow-2xs">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-gray-900 text-base leading-tight">Interview Copilot</h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live Assistant
                </span>
              </div>
              <p className="text-xs text-gray-500">
                {sharing ? `Sharing: ${shareLabel || 'Tab Audio'} · ` : 'Share your interview/Meet tab to transcribe in real-time · '}
                <span className="font-semibold text-gray-700">
                  {engine === 'browser' ? '⚡ Chrome Instant (0ms)' : engine === 'live' ? '⚡ AI Live Tab Relay' : engine === 'whisper' ? 'Whisper-1 AI' : connected ? 'Listening...' : 'Ready'}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-bold text-gray-800 bg-gray-50 px-3 py-1.5 rounded-xl border border-gray-200">
              <Clock className="w-3.5 h-3.5 text-gray-500" />
              <span>{mm}:{ss}</span>
            </div>
            <div className="flex items-center border border-gray-200 rounded-xl overflow-hidden text-xs font-bold bg-white shadow-2xs">
              <button
                type="button"
                onClick={() => handleLangChange('fr')}
                className={`px-3 py-1.5 transition cursor-pointer ${lang === 'fr' ? 'bg-[#FF385C] text-white font-extrabold' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                FR
              </button>
              <button
                type="button"
                onClick={() => handleLangChange('en')}
                className={`px-3 py-1.5 transition cursor-pointer ${lang === 'en' ? 'bg-[#FF385C] text-white font-extrabold' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                EN
              </button>
            </div>
            <button
              type="button"
              onClick={exitAll}
              className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-rose-50 text-gray-700 hover:text-rose-600 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Jobs
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 px-4 py-2 rounded-xl bg-red-50 border border-red-100 text-xs font-medium text-red-700 shrink-0">
            {error}
          </div>
        )}
        {engineNote && (
          <div className="mx-5 mt-2 px-4 py-1.5 rounded-xl bg-amber-50 border border-amber-100 text-[11px] font-medium text-amber-800 shrink-0">
            {engineNote}
          </div>
        )}

        {/* Split body */}
        <div className="grid grid-cols-1 lg:grid-cols-2 min-h-0 flex-1">
          {/* Left: shared tab + transcript */}
          <div className="p-4 border-r border-gray-100 flex flex-col min-h-0 bg-white">
            <div className="relative rounded-2xl overflow-hidden bg-[#2b2144] aspect-video shrink-0">
              <video ref={videoRef} muted playsInline className="w-full h-full object-contain bg-[#2b2144]" />
              {!sharing && (
                <button
                  onClick={() => void startSharing()}
                  className="absolute inset-0 m-auto w-fit h-fit px-6 py-3 rounded-2xl bg-white/95 text-gray-900 text-sm font-extrabold shadow-lg hover:bg-white transition flex items-center gap-2"
                >
                  <MonitorUp className="w-4 h-4 text-[#FF385C]" />
                  Share Meet tab
                </button>
              )}
              {sharing && (
                <div className="absolute top-2 left-2 flex gap-2">
                  <button
                    onClick={() => videoRef.current?.requestFullscreen().catch(() => undefined)}
                    className="px-3 py-1.5 rounded-lg bg-white/90 text-xs font-bold text-gray-800 hover:bg-white transition flex items-center gap-1.5"
                  >
                    <Maximize2 className="w-3.5 h-3.5" /> Fullscreen
                  </button>
                  <button
                    onClick={() => { stopSharing(); void startSharing(); }}
                    className="px-3 py-1.5 rounded-lg bg-white/90 text-xs font-bold text-gray-800 hover:bg-white transition flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Change Tab
                  </button>
                  <button
                    onClick={stopSharing}
                    className="px-3 py-1.5 rounded-lg bg-emerald-800/90 text-xs font-bold text-white hover:bg-emerald-900 transition flex items-center gap-1.5"
                  >
                    <Square className="w-3.5 h-3.5" /> Stop sharing
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mt-3 shrink-0 flex-wrap">
              <span className="font-extrabold text-gray-900">Transcript</span>
              {sharing && hasAudioInput && (
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-0.5 rounded-full border transition-all ${
                  audioActive 
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-300 ring-2 ring-emerald-100' 
                    : 'bg-gray-50 text-gray-600 border-gray-200'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${audioActive ? 'bg-emerald-500 animate-pulse' : 'bg-gray-400'}`} />
                  <span>{audioActive ? 'Tab Audio Active' : 'Tab Audio Connected'}</span>
                </span>
              )}
              {sharing && !hasAudioInput && (
                <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-300">
                  <span>⚠️ No Tab Audio Shared</span>
                </span>
              )}
              <select
                value={enginePref}
                onChange={(e) => {
                  const v = e.target.value as Engine;
                  setEnginePref(v);
                  enginePrefRef.current = v;
                  if (connected) {
                    stopTranscription();
                    void startEngine(streamRef.current, v).then(() => setConnected(true));
                  }
                }}
                className="px-2.5 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-gray-700 bg-white shadow-2xs"
                aria-label="Transcription engine"
                title="Transcription engine"
              >
                <option value="live">⚡ AI Live Tab Audio (Ultra-Fast Instant Streaming)</option>
                <option value="whisper">Whisper-1 AI (Batch High-Accuracy)</option>
                <option value="browser">🎙️ Microphone Only (WebSpeech - Cannot hear shared tab)</option>
              </select>
              <button
                onClick={() => {
                  if (connected) {
                    stopTranscription();
                    setConnected(false);
                    setEngine(null);
                  } else {
                    void startEngine(streamRef.current, enginePrefRef.current).then(() => setConnected(true));
                  }
                }}
                className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition flex items-center gap-1.5 cursor-pointer"
              >
                {connected ? <MicOff className="w-3.5 h-3.5 text-rose-500" /> : <Mic className="w-3.5 h-3.5 text-emerald-600" />}
                {connected ? 'Disconnect' : 'Connect'}
              </button>
              <button
                onClick={() => setLines([])}
                className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
              <div className="ml-auto flex items-center gap-2 text-xs font-bold text-gray-700">
                AutoScroll
                <button
                  role="switch"
                  aria-checked={autoScroll}
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`w-9 h-5 rounded-full transition relative ${autoScroll ? 'bg-gray-900' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${autoScroll ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              </div>
            </div>

            <div className="mt-2 flex-1 min-h-[160px] overflow-y-auto border-t border-gray-100 pt-3 space-y-2 pr-1">
              {lines.length === 0 && (
                <p className="text-sm text-gray-400 italic py-2">
                  {connected ? 'Listening to speech from shared tab...' : 'Share your interview tab to begin instant transcription.'}
                </p>
              )}
              {lines.map((l) => (
                <div key={l.id} className="text-[15px] leading-relaxed py-0.5">
                  <span className={l.final ? 'text-gray-900 font-medium' : 'text-emerald-700 font-semibold italic'}>
                    {l.text}
                  </span>
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Right: AI answers */}
          <div className="flex flex-col min-h-0 bg-white">
            <div className="flex-1 min-h-[200px] overflow-y-auto p-5 space-y-4">
              {answers.length === 0 && (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center gap-2 text-slate-500">
                  <p className="text-[15px]">No messages yet.</p>
                  <p className="text-[15px]">Click "AI Answer" to start!</p>
                </div>
              )}
              {answers.map((a) => (
                <div key={a.id} className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-[#FF385C]">
                      {a.model} · {a.ts}
                    </span>
                    <button
                      onClick={() => void copyAnswer(a)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-200/60 transition"
                      aria-label="Copy answer"
                    >
                      {copiedId === a.id ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  {a.question && a.question !== 'Live transcript' && a.question !== 'Screen analysis' && (
                    <p className="text-xs font-bold text-gray-500 mb-1.5">Q: {a.question}</p>
                  )}
                  {a.question === 'Screen analysis' && (
                    <p className="text-xs font-bold text-gray-500 mb-1.5 flex items-center gap-1">
                      <ScanEye className="w-3.5 h-3.5" /> On screen:
                    </p>
                  )}
                  <p className="text-sm text-gray-900 leading-relaxed whitespace-pre-wrap">{a.answer}</p>
                </div>
              ))}
              {thinking && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin text-[#FF385C]" /> Generating answer from your CV...
                </div>
              )}
              <div ref={answersEndRef} />
            </div>

            <div className="p-4 border-t border-gray-100 shrink-0 space-y-3">
              <div className="flex gap-2">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendManual(); }}
                  placeholder="Type a manual message..."
                  className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 text-sm outline-none focus:border-gray-900 transition"
                />
                <button
                  onClick={sendManual}
                  disabled={!manual.trim() || thinking}
                  className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-bold text-gray-500 hover:bg-gray-50 transition disabled:opacity-40"
                >
                  Send
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void askAI()}
                  disabled={thinking}
                  className="flex-1 px-4 py-3 rounded-xl bg-gray-500 hover:bg-gray-600 text-white text-sm font-extrabold transition flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {thinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  AI Answer (Space)
                </button>
                <button
                  onClick={() => void analyzeScreen()}
                  disabled={analyzing || !sharing}
                  className="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm font-bold text-gray-800 hover:bg-gray-50 transition flex items-center justify-center gap-2 disabled:opacity-40"
                >
                  {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <MonitorUp className="w-4 h-4" />}
                  Analyze Screen
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
