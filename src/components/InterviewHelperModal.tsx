import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Trash2, Sparkles, MonitorUp, Square,
  Maximize2, RefreshCw, Copy, Check, Loader2, ScanEye,
  ArrowLeft, Clock, Tv, ChevronLeft, ChevronRight, Play, Pause,
  RotateCcw, X, Wand2, Minimize2,
} from 'lucide-react';
import {
  createInterviewSession,
  recordTranscriptLine,
  recordInterviewQA,
  finishInterviewSession,
} from '../services/supabase';
import {
  InterviewSetup,
  documentsText,
  type InterviewContext,
} from './InterviewSetup';

interface InterviewHelperModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TranscriptLine {
  id: number;
  /** Words the engine has committed. They will not change again. */
  text: string;
  /**
   * Words still being revised, shown in green just after the committed ones.
   *
   * A turn is only "final" when the speaker stops, which can be ten seconds of
   * talking. Holding the whole turn green until then makes the transcript look
   * like it is guessing, when in fact AssemblyAI locks each word within a word
   * or two of hearing it -- so the settled prefix lives in `text` and only the
   * genuinely unsettled tail stays green.
   */
  tail: string;
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

/** mm:ss, and hh:mm:ss once an interview has run past the hour. */
function clock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function nowTs(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Openings that make a sentence a question even when the transcript has no
 * question mark -- which is most of the time, because people trail off and
 * because a recogniser punctuates what it hears, not what was meant.
 */
const QUESTION_OPENERS = new RegExp(
  '^(?:'
  + 'pouvez|pourriez|parlez|dites|racontez|décrivez|expliquez|donnez|présentez|'
  + 'comment|pourquoi|quel|quelle|quels|quelles|combien|quand|où|qui|'
  + "qu'est|qu'|est-ce|avez|êtes|aviez|seriez|auriez|voulez|savez|connaissez|"
  // Not grammatically questions, but they are asked in the same breath and
  // the candidate is expected to answer them: missing one costs a silence.
  + "j'aimerais|jaimerais|je voudrais|je souhaiterais|dites-moi|parlez-moi|"
  + 'how|why|what|which|when|where|who|'
  + 'can|could|would|will|do|did|does|have|has|are|is|were|tell|describe|explain|'
  + "walk|give|talk|i'd like|i would like"
  + ')\\b',
  'i',
);

/**
 * Did the interviewer just ask something?
 *
 * Deliberately generous about what counts and strict about length: a missed
 * question costs a silence in a real interview, while a false positive costs
 * an answer nobody reads.
 *
 * Every clause is tested, not just the first: the question is routinely buried
 * after a preamble -- "Pour commencer, pouvez-vous vous présenter" only becomes
 * one at the comma. Short fragments are ignored so a stray "so," or "et" cannot
 * carry a match.
 */
export function looksLikeQuestion(text: string): boolean {
  const s = text.trim();
  if (s.length < 12) return false;
  if (s.includes('?')) return true;
  return s
    .split(/[.!;:,]+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 10)
    .some((c) => QUESTION_OPENERS.test(c));
}

/**
 * Strips the markdown emphasis the model sprinkles into answers.
 *
 * Nobody says "asterisk asterisk" out loud, and the teleprompter is read
 * aloud. The characters are removed rather than rendered as bold because
 * emphasis someone else chose is a distraction at reading size.
 */
function spoken(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$)/g, '$1$2');
}

/**
 * How long the room has to stay quiet before hands-free treats a question as
 * finished. Long enough to survive the gap between two words, short enough
 * that the answer is arriving while the recruiter is still drawing breath.
 */
const HANDS_FREE_SILENCE_MS = 450;

/**
 * How long the transcript has to stop changing as well. The microphone knows
 * the room went quiet before the transcriber has finished writing what was
 * said in it; this is the grace the words get to catch up.
 */
const HANDS_FREE_SETTLE_MS = 250;

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
  type Engine = 'google' | 'gemini' | 'assemblyai' | 'browser';
  const [engine, setEngine] = useState<Engine | null>(null);
  const [enginePref, setEnginePref] = useState<Engine>('google');
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
  /**
   * What this interview is about, answered before the call. Null means the
   * setup has not been done yet, and the setup is all that renders -- there is
   * no half-configured session, and nothing to transcribe before there is one.
   */
  const [ctx, setCtx] = useState<InterviewContext | null>(null);
  /**
   * A chronometer, not a countdown. An interview has no fixed length, and a
   * clock draining towards zero is a distraction during one; what is actually
   * useful is knowing you are twelve minutes in. Seconds are derived from a
   * start timestamp rather than accumulated, so a throttled background tab
   * cannot make the session look shorter than it was.
   */
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [error, setError] = useState('');

  // --- Teleprompter HUD ---------------------------------------------------
  // A translucent overlay that shows one answer at a large size in the middle
  // of the screen, so it can be read while looking at the interviewer rather
  // than down at a list of cards.
  const [teleprompterOpen, setTeleprompterOpen] = useState(false);
  /** How much of the call behind the HUD stays visible: 70%, 85% or 95% opaque. */
  const [hudOpacity, setHudOpacity] = useState<'low' | 'med' | 'high'>('low');
  const [promptFontSize, setPromptFontSize] = useState(36);
  /**
   * Auto-scroll inside the HUD, on from the moment an answer appears.
   *
   * It starts moving text under someone who is mid-sentence, which is why it
   * used to default off; but an answer that needs scrolling at all is one you
   * are already reading aloud, and reaching for a button mid-sentence costs
   * more than the occasional unwanted nudge. Space pauses it instantly.
   */
  const [tpAutoScroll, setTpAutoScroll] = useState(true);
  /**
   * Slower than reading speed on purpose: the text should arrive just under
   * where the eye already is, not race it.
   */
  const [scrollSpeed, setScrollSpeed] = useState(0.7);
  /** Which answer the HUD is showing; null means "the newest one". */
  const [activeAnswerIdx, setActiveAnswerIdx] = useState<number | null>(null);
  const [autoOpenTeleprompter, setAutoOpenTeleprompter] = useState(true);
  /**
   * Reading size. The full panel is for a question you are working through;
   * compact is a card in the corner, small enough to leave the interviewer's
   * face visible, which is what hands-free mode opens into.
   */
  const [hudSize, setHudSize] = useState<'compact' | 'full'>('full');
  /**
   * The answer hands-free is writing, shown on its own small screen over the
   * shared tab. Separate from the teleprompter on purpose: that one is being
   * read out loud, and a question answered in the background must not take it
   * over mid-sentence.
   */
  const [autoCardId, setAutoCardId] = useState<number | null>(null);
  /**
   * Reading size on that small screen. Its own number, not the
   * teleprompter's: this one sits over the call at a fraction of the size,
   * and a setting that suits one is wrong for the other.
   */
  const [autoFontSize, setAutoFontSize] = useState(17);
  /**
   * How much of the call shows through it. Its own setting, and it starts
   * mostly see-through: this pane sits on top of the person you are talking
   * to, and a solid slab over their face is worse than a slightly harder read.
   * Legibility comes from the blur behind the glass, not from hiding the video.
   */
  const [autoTint, setAutoTint] = useState<'sheer' | 'soft' | 'solid'>('soft');
  const handsFreeScrollRef = useRef<HTMLDivElement | null>(null);
  const AUTO_TINT: Record<'sheer' | 'soft' | 'solid', number> = { sheer: 0.4, soft: 0.66, solid: 0.9 };
  const nextTint = { sheer: 'soft', soft: 'solid', solid: 'sheer' } as const;
  const promptScrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * Hands-free: the copilot decides on its own that a question was just asked
   * and starts writing. Off by default -- it spends money and puts text on
   * screen without being asked, and both should be a deliberate choice.
   */
  const [autoAnswer, setAutoAnswer] = useState(false);
  /** When a voice was last heard, in ms. Hands-free fires on the silence after. */
  const lastVoiceAtRef = useRef(0);
  /** Whether an answer is already being written, read from inside the poller. */
  const thinkingRef = useRef(false);
  /** The live transcript, readable from the poller without re-subscribing. */
  const liveTextRef = useRef('');
  /** The previous partial's words, for spotting the prefix that has settled. */
  const prevPartialRef = useRef<string[]>([]);
  /** What hands-free last sent, so the same sentence is not answered twice. */
  const lastAskedRef = useRef('');
  /** When the transcript last changed, for the settling window above. */
  const lastTextChangeAtRef = useRef(0);
  /**
   * How many words of the turn in progress have already been answered and
   * taken off screen. The transcriber will resend the whole turn, formatted,
   * when the speaker stops; without this the question would reappear under
   * its own answer and be detected all over again.
   */
  const consumedWordsRef = useRef(0);
  /**
   * Lines an answer has already been built from: taken off the screen so the
   * next question arrives on a clean pane, kept here so the copilot still
   * remembers the conversation. An interview is one thread, and the second
   * question is usually about the answer to the first.
   */
  const memoryRef = useRef<string[]>([]);
  const [remembered, setRemembered] = useState(0);

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
  const enginePrefRef = useRef<Engine>('google');
  const lineId = useRef(1);
  const answerId = useRef(1);
  const autoScrollRef = useRef(true);
  /**
   * The answers given so far, readable from inside askAI without making it a
   * new function on every token. Hands-free fires from a poller that closes
   * over askAI, so a stale copy there would send a stale conversation.
   */
  const answersRef = useRef<AnswerCard[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const answersEndRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The same context, readable from callbacks that outlive their render. */
  const ctxRef = useRef<InterviewContext | null>(null);

  autoScrollRef.current = autoScroll;
  answersRef.current = answers;
  ctxRef.current = ctx;
  thinkingRef.current = thinking;

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
      const last = prev[prev.length - 1];
      // An engine that only reports whole utterances puts everything in the
      // green tail until it commits, which is the honest rendering for it.
      const line = fin
        ? { text: clean, tail: '', final: true }
        : { text: '', tail: clean, final: false };
      if (last && !last.final) {
        return [...prev.slice(0, -1), { ...last, ...line, ts }];
      }
      return [...prev, { id: lineId.current++, ...line, ts }];
    });

    if (fin && sessionIdRef.current) {
      void recordTranscriptLine(sessionIdRef.current, clean, true, 'interviewer');
    }
  }, []);

  /**
   * One live turn, split into the part the engine has locked and the part it
   * is still revising. Called on every message of a turn, several times a
   * second, so a word goes green and then white within a moment of being said
   * instead of the whole sentence flipping colour at the end.
   */
  const pushTurn = useCallback((committed: string, pending: string, ended: boolean) => {
    const head = committed.trim();
    const tail = pending.trim();
    if (!head && !tail) return;
    const ts = nowTs();
    setLines((prev) => {
      const last = prev[prev.length - 1];
      const line = { text: head, tail: ended ? '' : tail, final: ended, ts };
      if (last && !last.final) return [...prev.slice(0, -1), { ...last, ...line }];
      return [...prev, { id: lineId.current++, ...line }];
    });
    if (ended && head && sessionIdRef.current) {
      void recordTranscriptLine(sessionIdRef.current, head, true, 'interviewer');
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
    // The AssemblyAI socket used to be left open here, so switching engines
    // kept a paid stream running with nobody reading it. Terminate asks for
    // the closing summary and lets the session end cleanly at their end.
    try {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Terminate' }));
        ws.close(1000, 'client stopped');
      } else {
        ws?.close();
      }
    } catch { /* noop */ }
    wsRef.current = null;
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

  /**
   * Tap the shared tab's audio and hand out 16 kHz mono PCM.
   *
   * Both shapes go to the callback because the two transports want different
   * things: our own relay speaks JSON, so it takes the base64; AssemblyAI v3
   * takes the bytes themselves. Converting once here beats decoding base64
   * back into bytes fifty times a second.
   */
  const attachPcmGraph = useCallback((stream: MediaStream, onChunk: (b64: () => string, pcm: ArrayBuffer) => void) => {
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
      // 1024 samples at 16kHz is a 64ms frame. Every sample sits in this
      // buffer before anything is sent, so the frame length is a floor under
      // how late the transcriber can possibly be; AssemblyAI's own client
      // uses 50ms. Smaller than this and the main thread pays more in
      // callbacks than the latency is worth.
      const proc = ctx.createScriptProcessor(1024, 1, 1);
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
          // When the room last had a voice in it. Hands-free waits on this
          // rather than on the transcriber's end-of-turn, which arrives a
          // beat later and only after it has decided how to punctuate.
          lastVoiceAtRef.current = Date.now();
          setAudioActive(true);
          if (speechTimer) clearTimeout(speechTimer);
          speechTimer = setTimeout(() => setAudioActive(false), 450);
        }

        // Base64 only if the consumer actually wants it. AssemblyAI takes
        // the raw frame; encoding it anyway burned main-thread time sixteen
        // times a second for nothing.
        const b64 = () => {
          let bin = '';
          const bytes = new Uint8Array(pcm.buffer);
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
          }
          return btoa(bin);
        };
        onChunk(b64, pcm.buffer);
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

  const startBackendRelay = useCallback(async (stream: MediaStream, targetEngine: 'google' | 'gemini') => {
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

    const wsUrl = `${BACKEND.replace(/^http/, 'ws')}/ws/transcribe?lang=${lang}&engine=${targetEngine}`;
    const connect = () => {
      if (relaySessionRef.current !== session) return;
      const ws = new WebSocket(wsUrl);
      relayWsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setEngine(targetEngine);
        setEngineNote('');
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.transcript) {
            setEngine(targetEngine);
            pushLine(msg.transcript, Boolean(msg.final));
          } else if (msg.status === 'live') {
            setEngine(targetEngine);
          } else if (msg.error) {
            setEngineNote(`⚠️ ${msg.error}`);
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
      if (open && open.readyState === WebSocket.OPEN) open.send(JSON.stringify({ audio_data: b64() }));
    });
    connect();
  }, [attachPcmGraph, ensureAudioInput, lang, pushLine, startBrowserSpeech]);

  const startAssemblyAI = useCallback(async (stream: MediaStream) => {
    let token = '';
    try {
      const r = await fetch(`${BACKEND}/api/assembly/token`);
      const data = await r.json();
      token = data.token || '';
      if (!token) {
        setEngineNote(`⚠️ ${data.error || 'AssemblyAI API key not set'}. Using Google Speech instead.`);
        await startBackendRelay(stream, 'google');
        return;
      }
    } catch {
      setEngineNote('Backend offline. Falling back to Google Speech.');
      await startBackendRelay(stream, 'google');
      return;
    }

    try {
      await ensureAudioInput(stream);
      // encoding has to be stated: v3 defaults to pcm_s16le but says so only
      // in the docs, and a mismatch is silent -- a connected socket that
      // transcribes nothing. format_turns gives punctuated, cased turns.
      //
      // universal-3-6-pro is asked for by name because the socket otherwise
      // opens on 3-5-pro, and the newer model is both better and multilingual,
      // which a French interview needs. No language parameter: v3 ignores one,
      // the model detects the language itself. "balanced" is the latency/
      // accuracy trade AssemblyAI ships as the default for live speech.
      const ws = new WebSocket(
        'wss://streaming.assemblyai.com/v3/ws'
        + '?sample_rate=16000'
        + '&encoding=pcm_s16le'
        + '&format_turns=true'
        + '&speech_model=universal-3-6-pro'
        + '&mode=balanced'
        + `&token=${encodeURIComponent(token)}`
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      let gotTranscript = false;

      ws.onopen = () => {
        setConnected(true);
        setEngine('assemblyai');
        setEngineNote('');
      };
      ws.onerror = () => {
        if (!gotTranscript) {
          try { ws.close(); } catch { /* noop */ }
          void startBackendRelay(stream, 'google');
        }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const t = (msg.type || '').toLowerCase();
          if (t === 'turn' && msg.transcript) {
            gotTranscript = true;
            setEngine('assemblyai');
            // v3 marks each word final on its own, a beat after it is said.
            // Using them is what makes the transcript settle word by word;
            // without the array we can only colour the whole turn.
            const raw: { text: string; word_is_final?: boolean }[] =
              Array.isArray(msg.words) ? msg.words : [];
            const ended = Boolean(msg.end_of_turn);
            // Words hands-free already answered are not shown again: only
            // what has been said since the answer started belongs on screen.
            const words = raw.slice(consumedWordsRef.current);
            const spokenSoFar = words.map((w) => w.text).join(' ');

            if (words.length) {
              // Measured against this account: word_is_final stays false for
              // every word until the turn ends, so the flags alone would keep
              // a whole sentence green for as long as someone talks. Two
              // consecutive updates agreeing on a prefix is the real signal --
              // the transcriber has stopped revising those words -- so that is
              // what turns them white.
              const flagged = words.findIndex((w) => !w.word_is_final);
              const settledByFlag = flagged === -1 ? words.length : flagged;
              const prev = prevPartialRef.current;
              let agreed = 0;
              while (agreed < words.length && agreed < prev.length && words[agreed].text === prev[agreed]) agreed++;
              const settled = ended ? words.length : Math.max(settledByFlag, agreed);
              const head = words.slice(0, settled).map((w) => w.text).join(' ');
              const rest = words.slice(settled).map((w) => w.text).join(' ');
              prevPartialRef.current = ended ? [] : words.map((w) => w.text);
              // The formatted transcript (punctuation, casing) only exists at
              // the end of a turn, so it wins once the turn is over -- unless
              // part of it has already been answered and cleared away.
              const finalText = consumedWordsRef.current ? spokenSoFar : msg.transcript;
              pushTurn(ended ? finalText : head, ended ? '' : rest, ended);
            } else if (ended && !consumedWordsRef.current) {
              pushTurn(msg.transcript, '', true);
            }
            if (ended) { consumedWordsRef.current = 0; prevPartialRef.current = []; }
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
      ws.onclose = (ev) => {
        // 1000 is our own Terminate. Anything else without a single transcript
        // means the socket never worked, and the interview is happening now:
        // fall back rather than leave the transcript empty. The close reason
        // is surfaced because "4003 insufficient funds" is not a bug to debug.
        if (!gotTranscript && ev.code !== 1000) {
          if (ev.reason) setEngineNote(`AssemblyAI closed the session (${ev.code}): ${ev.reason}. Using Google Speech.`);
          void startBackendRelay(stream, 'google');
        }
      };

      // v3 takes raw PCM frames on the socket. The old client wrapped each
      // chunk as {"audio_data": "<base64>"}, which is the v2 shape: v3 reads
      // that JSON as audio, hears noise, and transcribes nothing.
      detachPcmRef.current?.();
      detachPcmRef.current = attachPcmGraph(stream, (_b64, pcm) => {
        const open = wsRef.current;
        if (open && open.readyState === WebSocket.OPEN) open.send(pcm);
      });
    } catch {
      void startBackendRelay(stream, 'google');
    }
  }, [pushLine, pushTurn, startBackendRelay, ensureAudioInput, attachPcmGraph]);

  const startEngine = useCallback(async (stream: MediaStream | null, pref: Engine) => {
    if (!sessionIdRef.current) {
      // The session is named after the interview it is for, so the history is
      // readable later; the setup guarantees a title exists by this point.
      void createInterviewSession(
        ctxRef.current?.company ? `${ctxRef.current.jobTitle} @ ${ctxRef.current.company}` : (ctxRef.current?.jobTitle || 'Interview Session'),
        ctxRef.current?.jobTitle || 'Mechanical Engineer',
        lang,
      ).then((id) => {
        sessionIdRef.current = id;
      });
    }
    if (pref === 'browser') {
      startBrowserSpeech();
    } else if (pref === 'assemblyai') {
      if (stream) await startAssemblyAI(stream);
      else startBrowserSpeech();
    } else if (pref === 'gemini') {
      if (stream) await startBackendRelay(stream, 'gemini');
      else startBrowserSpeech();
    } else {
      // Default: Google Speech (fastest, working, reliable)
      if (stream) await startBackendRelay(stream, 'google');
      else startBrowserSpeech();
    }
  }, [startAssemblyAI, startBackendRelay, startBrowserSpeech, lang]);

  /**
   * Stop the screen share. The session itself survives: the chronometer keeps
   * running and the transcript stays on screen, because picking a different
   * tab mid-interview is a normal thing to do and used to silently close the
   * recorded session.
   */
  const stopSharing = useCallback(() => {
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
  }, [stopTranscription]);

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
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void stopSharing());
      await startEngine(stream, enginePrefRef.current);
      setConnected(true);
    } catch {
      setError('Tab share was cancelled or is not supported in this browser. Use Chrome/Edge.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEngine]);

  /**
   * Close the session out: stop the share, write the real duration, and drop
   * back to the setup so the next interview starts from a clean brief rather
   * than inheriting the last one's company.
   */
  const endSession = useCallback(() => {
    if (sessionIdRef.current) {
      void finishInterviewSession(sessionIdRef.current, elapsed);
      sessionIdRef.current = null;
    }
    stopSharing();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    startedAtRef.current = null;
    setElapsed(0);
    setLines([]);
    setAnswers([]);
    setTeleprompterOpen(false);
    setCtx(null);
    memoryRef.current = [];
    setRemembered(0);
    setAutoAnswer(false);
    setAutoCardId(null);
  }, [stopSharing, elapsed]);

  const exitAll = useCallback(() => {
    endSession();
    onClose();
  }, [endSession, onClose]);

  // The chronometer runs for as long as the session exists, not only while a
  // tab is being shared: the session starts when you finish the setup, and
  // re-picking the shared tab mid-call should not reset the elapsed time.
  useEffect(() => {
    if (!isOpen || !ctx) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    if (timerRef.current) clearInterval(timerRef.current);
    const tick = () => {
      const from = startedAtRef.current;
      if (from !== null) setElapsed(Math.floor((Date.now() - from) / 1000));
    };
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [isOpen, ctx]);

  // Cleanup on unmount / close
  useEffect(() => {
    if (!isOpen) {
      stopSharing();
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const askAI = useCallback(async (explicitQuestion?: string, opts?: { handsFree?: boolean }) => {
    const handsFree = Boolean(opts?.handsFree);
    const q = (explicitQuestion ?? '').trim() || currentQuestion();
    if (!q && lines.length === 0 && !explicitQuestion) {
      setError('No transcript yet — share the Meet tab, then click AI Answer.');
      return;
    }
    setThinking(true);
    setError('');

    // What the copilot is told: the lines on screen plus the ones earlier
    // answers already consumed, so a follow-up question still lands in the
    // conversation it belongs to.
    const live = lines
      .map((l) => [l.text, l.tail].filter(Boolean).join(' ').trim())
      .filter(Boolean);
    const tail = [...memoryRef.current, ...live].slice(-14).join('\n');
    // A question that was answered is off the screen. Hands-free answers what
    // it heard before the speaker had finished the turn, so it clears the live
    // line too -- the transcriber resends that turn formatted a moment later,
    // and consumedWordsRef keeps the answered half from coming back.
    const consumed = handsFree ? lines : lines.filter((l) => l.final);

    const id = beginAnswer(q || 'Live transcript', handsFree);
    let model = 'fuelix';
    let streamed = false;
    try {
      // The brief goes with every question, not just the first: the backend
      // holds no session state, so an answer is only as informed as the
      // request that asked for it.
      const r = await fetch(`${BACKEND}/api/interview/answer/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q || tail.slice(-500),
          transcript: tail,
          lang,
          job_title: ctxRef.current?.jobTitle || '',
          company: ctxRef.current?.company || '',
          job_description: ctxRef.current?.jobDescription || '',
          notes: ctxRef.current?.notes || '',
          documents: ctxRef.current ? documentsText(ctxRef.current) : '',
          // Nobody is waiting on a reasoning model's best work here: the
          // recruiter has stopped talking and the silence is running.
          fast: handsFree,
          // What has already been said out loud. The backend keeps no session,
          // so without this every answer is written as if it were the first
          // one of the interview -- which is why the fourth still opened with
          // "Bonjour, je suis ingénieur avec 3,5 ans d'expérience".
          answered: answersRef.current
            .filter((a) => a.model && a.answer.trim())
            .slice(-4)
            .map((a) => ({ question: a.question, answer: a.answer })),
        }),
      });
      if (!r.ok || !r.body) throw new Error(`backend ${r.status}`);

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line; a partial one stays in the
        // buffer until the rest of it arrives.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          let msg: { model?: string; delta?: string; done?: boolean };
          try { msg = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (msg.model) model = msg.model;
          if (msg.delta) { streamed = true; appendAnswer(id, msg.delta); }
        }
      }
      if (!streamed) throw new Error('empty stream');
      finishAnswer(id, model, handsFree);
    } catch {
      if (streamed) {
        // The answer was cut off rather than never written: keep the words,
        // and say so, instead of throwing away a usable half-answer.
        finishAnswer(id, `${model} · interrupted`, handsFree);
      } else {
        replaceAnswer(id, heuristicAnswer(q), 'offline heuristic');
        finishAnswer(id, 'offline heuristic', handsFree);
        setEngineNote((n) => n || 'Answer backend offline — showing CV-grounded heuristic. Start api_server.py for Fuelix.');
      }
    } finally {
      setThinking(false);
      // The question has been answered, so its words leave the pane. They are
      // not lost: they move into the memory that every later answer is given.
      if (consumed.length) {
        memoryRef.current = [...memoryRef.current, ...consumed.map((l) => l.text)].slice(-40);
        setRemembered(memoryRef.current.length);
        const gone = new Set(consumed.map((l) => l.id));
        setLines((prev) => prev.filter((l) => !gone.has(l.id)));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, lang]);

  const currentQuestion = (): string => {
    const finals = lines.filter((l) => l.final);
    const last = finals[finals.length - 1] || lines[lines.length - 1];
    return last ? (last.text || last.tail) : '';
  };

  /** The transcript as it currently stands, answered part excluded. */
  useEffect(() => {
    const text = lines
      .map((l) => [l.text, l.tail].filter(Boolean).join(' ').trim())
      .filter(Boolean)
      .join(' ');
    if (text !== liveTextRef.current) {
      liveTextRef.current = text;
      lastTextChangeAtRef.current = Date.now();
    }
  }, [lines]);

  /**
   * Switching hands-free off clears its screen. A stale answer left floating
   * over the interviewer's face is worse than showing nothing at all.
   */
  useEffect(() => {
    if (!autoAnswer) setAutoCardId(null);
  }, [autoAnswer]);

  /**
   * Keep the newest words of the hands-free answer in view.
   *
   * The screen over the call is a few lines tall by design, so an answer
   * outgrows it within a sentence or two. Following the text is the whole
   * point of watching it arrive.
   */
  useEffect(() => {
    const el = handsFreeScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoCardId, answers]);

  /**
   * Hands-free mode: answer a question without being asked to.
   *
   * It waits on silence, not on the transcriber. Waiting for end-of-turn cost
   * a second and a half on its own, and waiting for the formatted final cost
   * more; the microphone already knows the room went quiet, which is the same
   * fact several seconds earlier. So: the last words heard look like a
   * question, and nobody has spoken for HANDS_FREE_SILENCE_MS -- go.
   *
   * Polled rather than driven by transcript updates, because the trigger is
   * the absence of input, and nothing arrives to fire an effect.
   */
  useEffect(() => {
    if (!autoAnswer) return;
    const id = setInterval(() => {
      if (thinkingRef.current) return;
      const text = liveTextRef.current.trim();
      if (text.length < 12 || text === lastAskedRef.current) return;
      if (Date.now() - lastVoiceAtRef.current < HANDS_FREE_SILENCE_MS) return;
      // The transcriber runs a beat behind the microphone, so the room can be
      // quiet while the last few words of the question are still in flight.
      // Once speech stops they land almost at once -- end-of-turn was measured
      // at 0.1s -- so a short settling window costs nothing and stops the
      // question being answered without its ending.
      if (Date.now() - lastTextChangeAtRef.current < HANDS_FREE_SETTLE_MS) return;
      if (!looksLikeQuestion(text)) {
        // Judged and rejected: do not re-judge it every 120ms.
        lastAskedRef.current = text;
        return;
      }
      lastAskedRef.current = text;
      consumedWordsRef.current += text.split(/\s+/).length;
      void askAI(text, { handsFree: true });
    }, 120);
    return () => clearInterval(id);
  }, [autoAnswer, askAI]);

  /**
   * Opens an empty answer card and points the teleprompter at it, before a
   * single word exists. The model takes several seconds to write; watching it
   * arrive beats watching a spinner when someone is waiting for you to speak.
   */
  const beginAnswer = (question: string, handsFree = false): number => {
    const id = answerId.current++;
    setAnswers((prev) => [...prev, { id, question, answer: '', model: '', ts: nowTs() }]);
    if (handsFree) {
      // Hands-free has its own small screen over the shared tab and leaves the
      // teleprompter alone: one of them is being read out loud, and an answer
      // nobody asked for must never replace it.
      setAutoCardId(id);
      return id;
    }
    setAnswers((prev) => { setActiveAnswerIdx(prev.length - 1); return prev; });
    if (autoOpenTeleprompter) setTeleprompterOpen(true);
    if (promptScrollRef.current) promptScrollRef.current.scrollTop = 0;
    // Nothing to scroll through yet, and scrolling text that is still growing
    // just chases the cursor. It is re-armed when the answer is complete.
    setTpAutoScroll(false);
    return id;
  };

  const appendAnswer = (id: number, delta: string) => {
    setAnswers((prev) => prev.map((a) => (a.id === id ? { ...a, answer: a.answer + delta } : a)));
  };

  const replaceAnswer = (id: number, answer: string, model: string) => {
    setAnswers((prev) => prev.map((a) => (a.id === id ? { ...a, answer, model } : a)));
  };

  const finishAnswer = (id: number, model: string, handsFree = false) => {
    setAnswers((prev) => {
      const card = prev.find((a) => a.id === id);
      if (card && sessionIdRef.current) {
        void recordInterviewQA(sessionIdRef.current, card.question, card.answer, model);
      }
      return prev.map((a) => (a.id === id ? { ...a, model } : a));
    });
    // Only the teleprompter scrolls itself, and only for an answer it is
    // actually showing. Hands-free lives elsewhere and stays out of it.
    if (!handsFree) setTpAutoScroll(true);
  };

  const pushAnswer = (question: string, answer: string, model: string) => {
    setAnswers((prev) => {
      const next = [...prev, { id: answerId.current++, question, answer, model, ts: nowTs() }];
      // Point the HUD at the answer that just arrived, not at whatever was
      // being read a moment ago.
      setActiveAnswerIdx(next.length - 1);
      return next;
    });
    if (autoOpenTeleprompter) setTeleprompterOpen(true);
    // A new answer starts at its beginning, however far down the last one was read.
    if (promptScrollRef.current) promptScrollRef.current.scrollTop = 0;
    // Re-arm the scroll. Reaching the bottom of the previous answer switched it
    // off, and without this every answer after the first would sit still.
    setTpAutoScroll(true);
    if (sessionIdRef.current) {
      void recordInterviewQA(sessionIdRef.current, question, answer, model);
    }
  };

  /**
   * Scrolls the HUD at a steady rate, in pixels per second rather than pixels
   * per frame, so the speed a candidate settles on reads the same on a 60Hz
   * laptop and a 144Hz monitor. The frame delta is capped at 100ms so a tab
   * that was briefly backgrounded does not lurch a paragraph forward on the
   * first frame back.
   */
  useEffect(() => {
    if (!tpAutoScroll || !teleprompterOpen) return;
    const el = promptScrollRef.current;
    if (!el) return;

    let raf: number;
    let last = performance.now();
    // Kept as a float: at 0.5x a frame moves less than a pixel, and rounding
    // that into scrollTop every frame rounds it away to a standstill.
    let pos = el.scrollTop;

    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const node = promptScrollRef.current;
      if (node) {
        // Someone grabbed the scrollbar: follow them rather than fight.
        if (Math.abs(node.scrollTop - pos) > 10) pos = node.scrollTop;
        pos += scrollSpeed * 36 * dt / 1000;
        const max = node.scrollHeight - node.clientHeight;
        if (max <= 0 || pos >= max - 2) {
          node.scrollTop = max > 0 ? max : 0;
          setTpAutoScroll(false);   // at the end there is nothing left to scroll
          return;
        }
        node.scrollTop = pos;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tpAutoScroll, teleprompterOpen, scrollSpeed]);

  const sendManual = useCallback(() => {
    const q = manual.trim();
    if (!q || thinking) return;
    setManual('');
    void askAI(q);
  }, [manual, thinking, askAI]);

  // Keyboard shortcuts, ignored while typing into a field.
  //
  // Space does two different things on purpose. With the HUD closed it asks for
  // an answer; with the HUD open it starts and stops the scroll, because that
  // is the thing a hand reaches for while reading, and asking for a second
  // answer mid-sentence would replace the text being read.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (teleprompterOpen) setTpAutoScroll((v) => !v);
        else void askAI();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        setTeleprompterOpen((v) => !v);
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setAutoAnswer((v) => !v);
      } else if (e.key === 'Escape' && teleprompterOpen) {
        // Only swallowed while the HUD is up, so Escape still closes the modal.
        e.preventDefault();
        setTeleprompterOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, askAI, teleprompterOpen]);

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

  // Nothing about the live session renders until there is a session. The setup
  // is the page, full width, one question at a time.
  if (!ctx) {
    return (
      <InterviewSetup
        backend={BACKEND}
        onStart={(c) => {
          setCtx(c);
          setLang(c.lang);
          startedAtRef.current = Date.now();
          setElapsed(0);
          setError('');
        }}
        onCancel={onClose}
      />
    );
  }

  const chrono = clock(elapsed);
  // The answer hands-free is writing, if it has not been dismissed. Looked up
  // by id rather than "the last card", so an answer typed by hand afterwards
  // does not hijack the screen over the call.
  const autoCard = autoCardId === null ? null : answers.find((a) => a.id === autoCardId) ?? null;

  return (
    <div className="flex-1 w-full max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-150">
      <div className="ic-tile is-static relative w-full h-full rounded-[22px] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between shrink-0 gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[#0a84ff]/15 text-[#0a84ff] flex items-center justify-center shrink-0">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                {/* The session is named after the job, not after the tool: on a
                    page you only open for one interview, the product name is
                    the least useful thing that could be in the title slot. */}
                <h3 className="ic-title text-[16px] text-[#f5f5f7] truncate">
                  {ctx.jobTitle}{ctx.company ? ` · ${ctx.company}` : ''}
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[0.08em] bg-[#30d158]/15 text-[#30d158] flex items-center gap-1 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#30d158] animate-pulse" />
                  Live
                </span>
              </div>
              <p className="ic-caption text-[12px] text-[rgba(235,235,245,0.62)] truncate">
                {sharing ? `Sharing ${shareLabel || 'tab audio'} · ` : 'Share the call tab to transcribe it live · '}
                <span className="text-[#f5f5f7]">
                  {engine === 'google' ? 'Google Speech' : engine === 'gemini' ? 'Gemini Live' : engine === 'assemblyai' ? 'AssemblyAI' : engine === 'browser' ? 'Chrome Speech (mic)' : connected ? 'Listening' : 'Ready'}
                </span>
                {ctx.docs.length > 0 && (
                  <span className="text-[rgba(235,235,245,0.42)]">
                    {` · ${ctx.docs.length} document${ctx.docs.length > 1 ? 's' : ''} in context`}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {/* Counting up, not down. */}
            <div className="ic-fill flex items-center gap-1.5 px-3 py-1.5 rounded-full ic-body text-[13px] font-semibold text-[#f5f5f7] tabular-nums">
              <Clock className="w-3.5 h-3.5 text-[rgba(235,235,245,0.62)]" />
              <span>{chrono}</span>
            </div>
            <div className="ic-segmented flex items-center rounded-full overflow-hidden text-[12px] font-semibold">
              <button
                type="button"
                onClick={() => handleLangChange('fr')}
                className={`ic-segmented-item px-3 py-1.5 cursor-pointer ${lang === 'fr' ? 'is-on' : ''}`}
              >
                FR
              </button>
              <button
                type="button"
                onClick={() => handleLangChange('en')}
                className={`ic-segmented-item px-3 py-1.5 cursor-pointer ${lang === 'en' ? 'is-on' : ''}`}
              >
                EN
              </button>
            </div>
            {/* Hands-free. It is a switch rather than a mode you enter,
                because it has to be turned off the instant it misfires. */}
            <button
              type="button"
              onClick={() => setAutoAnswer((v) => !v)}
              className={`ic-fill ${autoAnswer ? 'is-on' : ''} px-3 py-1.5 rounded-full ic-body text-[13px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer`}
              title={autoAnswer
                ? 'Hands-free is on: questions are answered as they are asked'
                : 'Hands-free: detect each question and answer it without asking (press A)'}
              aria-pressed={autoAnswer}
            >
              <Wand2 className={`w-3.5 h-3.5 ${autoAnswer ? 'text-[#0a84ff]' : ''}`} />
              <span>Hands-free</span>
              <span className={`w-1.5 h-1.5 rounded-full ${autoAnswer ? 'bg-[#30d158] animate-pulse' : 'bg-white/25'}`} />
            </button>
            <button
              type="button"
              onClick={() => setTeleprompterOpen((v) => !v)}
              className={`ic-fill ${teleprompterOpen ? 'is-on' : ''} px-3 py-1.5 rounded-full ic-body text-[13px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer`}
              title="Toggle the teleprompter over the call (press T)"
            >
              <Tv className="w-3.5 h-3.5" />
              <span>Teleprompter</span>
            </button>
            <button
              type="button"
              onClick={endSession}
              className="ic-fill px-3 py-1.5 rounded-full ic-body text-[13px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
              title="End this session and set up a new one"
            >
              <Square className="w-3.5 h-3.5" />
              End session
            </button>
            <button
              type="button"
              onClick={exitAll}
              className="ic-fill px-3 py-1.5 rounded-full ic-body text-[13px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to jobs
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 px-4 py-2 rounded-xl bg-[#ff453a]/12 ic-body text-[13px] text-[#ff8b82] shrink-0">
            {error}
          </div>
        )}
        {engineNote && (
          <div className="mx-5 mt-2 px-4 py-1.5 rounded-xl bg-[#ff9f0a]/12 ic-body text-[12px] text-[#ffc65c] shrink-0">
            {engineNote}
          </div>
        )}

        {/* Split body */}
        <div className="grid grid-cols-1 lg:grid-cols-2 min-h-0 flex-1">
          {/* Left: shared tab + transcript */}
          <div className="p-4 lg:border-r border-white/10 flex flex-col min-h-0">
            <div className="relative rounded-2xl overflow-hidden bg-black/45 aspect-video shrink-0 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)]">
              <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />
              {!sharing && (
                <button
                  onClick={() => void startSharing()}
                  className="absolute inset-0 m-auto w-fit h-fit px-6 py-3 rounded-full bg-[#0a84ff] hover:bg-[#3395ff] text-white ic-body text-[14px] font-semibold transition-colors duration-200 flex items-center gap-2 cursor-pointer"
                >
                  <MonitorUp className="w-4 h-4" />
                  Share the call tab
                </button>
              )}
              {sharing && (
                <div className="absolute top-2 left-2 flex gap-2">
                  <button
                    onClick={() => videoRef.current?.requestFullscreen().catch(() => undefined)}
                    className="ic-popover px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" /> Fullscreen
                  </button>
                  <button
                    onClick={() => { stopSharing(); void startSharing(); }}
                    className="ic-popover px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Change Tab
                  </button>
                  <button
                    onClick={stopSharing}
                    className="ic-popover px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" /> Stop sharing
                  </button>
                </div>
              )}

              {/* The hands-free screen, over the call itself.
                  It lives here rather than in the middle of the app because
                  this is where the eyes already are during an interview: the
                  answer has to be readable without looking away from the
                  person asking. */}
              {autoCard && (
                <div
                  className="absolute inset-x-2 bottom-2 max-h-[68%] flex flex-col rounded-xl overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200"
                  style={{
                    background: `rgba(10,14,28,${AUTO_TINT[autoTint]})`,
                    backdropFilter: 'blur(22px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(22px) saturate(150%)',
                    boxShadow: '0 12px 40px rgba(0,0,0,0.5), inset 0 0 0 0.5px rgba(255,255,255,0.16)',
                  }}
                >
                  <div className="px-3 py-2 flex items-center gap-2 border-b border-white/10 shrink-0">
                    <span className="px-2 py-0.5 rounded-full ic-caption text-[10px] font-semibold uppercase tracking-[0.08em] bg-[#0a84ff]/15 text-[#0a84ff] flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#0a84ff] animate-pulse" />
                      Hands-free
                    </span>
                    <span className="ic-caption text-[11px] text-[rgba(235,235,245,0.42)] truncate min-w-0 flex-1">
                      {autoCard.question}
                    </span>
                    <button
                      type="button"
                      onClick={() => setAutoTint((v) => nextTint[v])}
                      className="ic-fill px-2 h-6 rounded-full text-[#f5f5f7] cursor-pointer shrink-0 ic-caption text-[10px] font-semibold flex items-center justify-center"
                      title="How much of the call shows through"
                    >
                      {Math.round(AUTO_TINT[autoTint] * 100)}%
                    </button>
                    <button
                      type="button"
                      onClick={() => setAutoFontSize((v) => Math.max(13, v - 2))}
                      className="ic-fill w-6 h-6 rounded-full text-[#f5f5f7] cursor-pointer shrink-0 ic-caption text-[11px] font-semibold flex items-center justify-center"
                      title="Smaller"
                    >
                      A-
                    </button>
                    <button
                      type="button"
                      onClick={() => setAutoFontSize((v) => Math.min(30, v + 2))}
                      className="ic-fill w-6 h-6 rounded-full text-[#f5f5f7] cursor-pointer shrink-0 ic-caption text-[12px] font-semibold flex items-center justify-center"
                      title="Bigger"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      onClick={() => setAutoCardId(null)}
                      className="ic-fill w-6 h-6 rounded-full text-[#f5f5f7] cursor-pointer shrink-0 flex items-center justify-center"
                      title="Dismiss"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div
                    ref={handsFreeScrollRef}
                    className="flex-1 overflow-y-auto px-4 py-3 text-white font-medium leading-relaxed whitespace-pre-wrap select-text"
                    style={{
                      fontSize: `${autoFontSize}px`,
                      lineHeight: 1.5,
                      // The pane is see-through, so whatever is behind a given
                      // line is anyone's guess. The shadow is what keeps the
                      // words readable over a bright slide.
                      textShadow: '0 1px 4px rgba(0,0,0,0.75)',
                    }}
                  >
                    {autoCard.answer
                      ? spoken(autoCard.answer)
                      : (
                        <span className="inline-flex items-center gap-2 text-[rgba(235,235,245,0.62)]">
                          <Loader2 className="w-4 h-4 animate-spin text-[#0a84ff]" />
                          Writing the answer…
                        </span>
                      )}
                    {!autoCard.model && autoCard.answer && (
                      <span className="inline-block w-[0.5ch] ml-0.5 bg-[#0a84ff] animate-pulse align-middle" style={{ height: '1em' }} />
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mt-3 shrink-0 flex-wrap">
              <span className="ic-title text-[15px] text-[#f5f5f7]">Transcript</span>
              {sharing && hasAudioInput && (
                <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${
                  audioActive ? 'bg-[#30d158]/15 text-[#30d158]' : 'bg-white/10 text-[rgba(235,235,245,0.62)]'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${audioActive ? 'bg-[#30d158] animate-pulse' : 'bg-white/35'}`} />
                  <span>{audioActive ? 'Hearing the tab' : 'Tab audio connected'}</span>
                </span>
              )}
              {sharing && !hasAudioInput && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-[#ff9f0a]/15 text-[#ffc65c]">
                  <span>No tab audio shared</span>
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
                className="ic-fill px-2.5 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] [&>option]:bg-[#161c33] cursor-pointer outline-none"
                aria-label="Transcription engine"
                title="Transcription engine"
              >
                {/* Named for what they do to the transcript, not for the
                    vendor's product line: the choice is made seconds before a
                    call, and a model number is no help then. */}
                <option value="google">Google Speech — fastest</option>
                <option value="assemblyai">AssemblyAI — most accurate</option>
                <option value="gemini">Gemini Live — experimental</option>
                <option value="browser">Chrome — microphone only</option>
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
                className="ic-fill px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
              >
                {connected ? <MicOff className="w-3.5 h-3.5 text-[#ff453a]" /> : <Mic className="w-3.5 h-3.5 text-[#30d158]" />}
                {connected ? 'Disconnect' : 'Connect'}
              </button>
              <button
                onClick={() => {
                  // Clear means clear: the remembered lines go too, otherwise
                  // the copilot keeps quoting a conversation you just wiped.
                  setLines([]);
                  memoryRef.current = [];
                  setRemembered(0);
                }}
                className="ic-fill px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer"
                title="Forget the transcript, on screen and in the copilot's memory"
              >
                <Trash2 className="w-3.5 h-3.5" /> Clear
              </button>
              <div className="ml-auto flex items-center gap-2 ic-body text-[12px] font-medium text-[rgba(235,235,245,0.62)]">
                Auto-scroll
                <button
                  role="switch"
                  aria-checked={autoScroll}
                  onClick={() => setAutoScroll(!autoScroll)}
                  className={`w-9 h-5 rounded-full transition-colors duration-200 relative cursor-pointer ${autoScroll ? 'bg-[#0a84ff]' : 'bg-white/20'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${autoScroll ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              </div>
            </div>

            <div className="mt-2 flex-1 min-h-[160px] overflow-y-auto border-t border-white/10 pt-3 space-y-2 pr-1">
              {/* Answered lines leave the pane so the next question arrives on
                  a clean page. This says where they went -- a transcript that
                  silently empties itself looks like a bug. */}
              {remembered > 0 && (
                <div className="flex items-center gap-2 pb-1">
                  <span className="h-px flex-1 bg-white/10" />
                  <span className="ic-caption text-[11px] font-medium text-[rgba(235,235,245,0.42)] whitespace-nowrap">
                    {remembered} earlier line{remembered > 1 ? 's' : ''} answered · still remembered
                  </span>
                  <span className="h-px flex-1 bg-white/10" />
                </div>
              )}
              {lines.length === 0 && (
                <p className="ic-body text-[14px] text-[rgba(235,235,245,0.42)] py-2">
                  {connected
                    ? (remembered > 0 ? 'Listening for the next question...' : 'Listening to the shared tab...')
                    : 'Share the interview tab to start transcribing.'}
                </p>
              )}
              {lines.map((l) => (
                <div key={l.id} className="text-[15px] leading-relaxed py-0.5">
                  {/* Settled words in white, the tail the engine is still
                      revising in green, on the same line: the sentence builds
                      up word by word rather than turning over all at once. */}
                  {l.text && <span className="ic-body text-[#f5f5f7]">{l.text}</span>}
                  {l.tail && (
                    <span className="ic-body text-[#30d158] italic">{l.text ? ' ' : ''}{l.tail}</span>
                  )}
                </div>
              ))}
              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Right: AI answers */}
          <div className="flex flex-col min-h-0">
            <div className="flex-1 min-h-[200px] overflow-y-auto p-5 space-y-4">
              {answers.length === 0 && (
                <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-center gap-1.5">
                  <p className="ic-body text-[15px] text-[#f5f5f7]">Nothing asked yet.</p>
                  <p className="ic-body text-[14px] text-[rgba(235,235,245,0.42)]">
                    Press Space, or hit AI Answer, and the copilot answers the last question it heard.
                  </p>
                </div>
              )}
              {answers.map((a) => (
                <div key={a.id} className="rounded-2xl bg-white/[0.05] shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)] p-4">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="ic-caption text-[10px] font-semibold uppercase tracking-[0.08em] text-[#0a84ff]">
                      {a.model} · {a.ts}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setActiveAnswerIdx(answers.findIndex((x) => x.id === a.id));
                          setTeleprompterOpen(true);
                        }}
                        className="p-1.5 rounded-lg text-[rgba(235,235,245,0.42)] hover:text-[#0a84ff] hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                        title="View in Teleprompter"
                      >
                        <Tv className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => void copyAnswer(a)}
                        className="p-1.5 rounded-lg text-[rgba(235,235,245,0.42)] hover:text-[#f5f5f7] hover:bg-white/10 transition-colors duration-200 cursor-pointer"
                        aria-label="Copy answer"
                      >
                        {copiedId === a.id ? <Check className="w-4 h-4 text-[#30d158]" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  {a.question && a.question !== 'Live transcript' && a.question !== 'Screen analysis' && (
                    <p className="ic-caption text-[12px] font-medium text-[rgba(235,235,245,0.62)] mb-1.5">Q: {a.question}</p>
                  )}
                  {a.question === 'Screen analysis' && (
                    <p className="ic-caption text-[12px] font-medium text-[rgba(235,235,245,0.62)] mb-1.5 flex items-center gap-1">
                      <ScanEye className="w-3.5 h-3.5" /> On screen:
                    </p>
                  )}
                  <p className="ic-body text-[14.5px] text-[#f5f5f7] leading-relaxed whitespace-pre-wrap">{spoken(a.answer)}</p>
                </div>
              ))}
              {thinking && (
                <div className="flex items-center gap-2 ic-body text-[14px] text-[rgba(235,235,245,0.62)]">
                  <Loader2 className="w-4 h-4 animate-spin text-[#0a84ff]" /> Writing an answer from your CV and the brief...
                </div>
              )}
              <div ref={answersEndRef} />
            </div>

            <div className="p-4 border-t border-white/10 shrink-0 space-y-3">
              <div className="flex gap-2">
                <input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendManual(); }}
                  placeholder="Type a question yourself..."
                  className="ic-fill flex-1 px-4 py-2.5 rounded-full ic-body text-[14px] text-[#f5f5f7] placeholder:text-white/30 outline-none focus:shadow-[0_0_0_2px_#0a84ff] transition-shadow duration-200"
                />
                <button
                  onClick={sendManual}
                  disabled={!manual.trim() || thinking}
                  className="ic-fill px-5 py-2.5 rounded-full ic-body text-[14px] font-medium text-[#f5f5f7] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  Send
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void askAI()}
                  disabled={thinking}
                  className="flex-1 px-4 py-3 rounded-full bg-[#0a84ff] hover:bg-[#3395ff] text-white ic-body text-[14px] font-semibold transition-colors duration-200 flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
                >
                  {thinking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  AI answer (Space)
                </button>
                <button
                  type="button"
                  onClick={() => setTeleprompterOpen((v) => !v)}
                  className={`ic-fill ${teleprompterOpen ? 'is-on' : ''} flex-1 px-3 py-3 rounded-full ic-body text-[14px] font-medium text-[#f5f5f7] flex items-center justify-center gap-1.5 cursor-pointer`}
                  title="Toggle Transparent Teleprompter HUD (Press T)"
                >
                  <Tv className="w-4 h-4" />
                  <span>Teleprompter</span>
                </button>
                <button
                  onClick={() => void analyzeScreen()}
                  disabled={analyzing || !sharing}
                  className="ic-fill flex-1 px-4 py-3 rounded-full ic-body text-[14px] font-medium text-[#f5f5f7] flex items-center justify-center gap-2 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <MonitorUp className="w-4 h-4" />}
                  Read the screen
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* The teleprompter itself: one answer, large, floating over the call.
            The backdrop is pointer-events-none so the shared tab underneath
            stays clickable -- only the panel takes the mouse. */}
        {teleprompterOpen && (() => {
          const idx =
            activeAnswerIdx !== null && activeAnswerIdx >= 0 && activeAnswerIdx < answers.length
              ? activeAnswerIdx
              : answers.length - 1;
          const card = idx >= 0 ? answers[idx] : null;
          const compact = hudSize === 'compact';
          // Still being written: the card exists but has no model yet.
          const streaming = Boolean(card && !card.model);

          return (
            <div
              className={`absolute inset-0 z-50 flex p-3 sm:p-6 pointer-events-none animate-in fade-in zoom-in-95 duration-150 ${
                compact
                  ? 'items-end justify-end'
                  : 'items-center justify-center bg-black/10 backdrop-blur-[2px]'
              }`}
            >
              <div
                className={`ic-popover pointer-events-auto flex flex-col transition-all overflow-hidden ${
                  compact
                    ? 'w-full max-w-sm max-h-[46vh] rounded-2xl'
                    : 'w-full max-w-3xl max-h-[84vh] rounded-3xl'
                }`}
                // Inline, not a class: `.ic-popover` is plain CSS outside
                // Tailwind's layer, so a utility background loses to it and the
                // three opacity buttons would do nothing.
                style={{
                  // Compact ignores the transparency setting. A small card
                  // lands on top of buttons and text rather than on video, and
                  // at 60% the answer and whatever is underneath it become one
                  // illegible layer -- it hides so little that there is nothing
                  // to gain by being see-through.
                  background: compact
                    ? 'rgba(16,21,40,0.95)'
                    : hudOpacity === 'low'
                      ? 'rgba(24,30,52,0.6)'
                      : hudOpacity === 'high'
                        ? 'rgba(18,23,42,0.96)'
                        : 'rgba(22,28,49,0.84)',
                  boxShadow: compact ? '0 18px 50px rgba(0,0,0,0.5)' : undefined,
                }}
              >
                <div className={`border-b border-white/10 flex items-center justify-between gap-3 shrink-0 flex-wrap ${compact ? 'px-3 py-2' : 'px-5 py-3.5'}`}>
                  <div className="flex items-center gap-2.5">
                    <div className="px-2.5 py-1 rounded-full ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] bg-[#0a84ff]/15 text-[#0a84ff] flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#0a84ff] animate-pulse" />
                      {autoAnswer ? 'Hands-free' : 'Teleprompter'}
                    </div>
                    {answers.length > 1 && !compact && (
                      <div className="flex items-center gap-1 ic-fill rounded-full px-2.5 py-1 ic-body text-[12px] font-medium text-[#f5f5f7]">
                        <button
                          type="button"
                          disabled={idx <= 0}
                          onClick={() => setActiveAnswerIdx(Math.max(0, idx - 1))}
                          className="p-0.5 rounded-full hover:bg-white/10 disabled:opacity-30 cursor-pointer"
                          title="Previous answer"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="px-1 text-[11px]">{idx + 1}/{answers.length}</span>
                        <button
                          type="button"
                          disabled={idx >= answers.length - 1}
                          onClick={() => setActiveAnswerIdx(Math.min(answers.length - 1, idx + 1))}
                          className="p-0.5 rounded-full hover:bg-white/10 disabled:opacity-30 cursor-pointer"
                          title="Next answer"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setHudSize(compact ? 'full' : 'compact')}
                      className="ic-fill p-1.5 rounded-full text-[#f5f5f7] cursor-pointer"
                      title={compact ? 'Full size' : 'Shrink into the corner'}
                    >
                      {compact ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
                    </button>
                    {!compact && (<>
                    <div className="flex items-center ic-fill rounded-full overflow-hidden ic-body text-[12px] font-medium">
                      <button
                        type="button"
                        onClick={() => setPromptFontSize((v) => Math.max(16, v - 3))}
                        className="px-2.5 py-1 hover:bg-white/10 text-[#f5f5f7] transition-colors duration-200 cursor-pointer"
                        title="Smaller text"
                      >
                        A-
                      </button>
                      <span className="px-1.5 text-[11px] text-[rgba(235,235,245,0.62)] font-medium">{promptFontSize}px</span>
                      <button
                        type="button"
                        onClick={() => setPromptFontSize((v) => Math.min(36, v + 3))}
                        className="px-2.5 py-1 hover:bg-white/10 text-[#f5f5f7] transition-colors duration-200 cursor-pointer"
                        title="Larger text"
                      >
                        A+
                      </button>
                    </div>

                    <div className="flex items-center ic-fill rounded-full overflow-hidden ic-body text-[12px] font-medium">
                      {([
                        ['low', '70%', '70% transparency'],
                        ['med', '85%', '85% transparency'],
                        ['high', '95%', 'Almost solid'],
                      ] as const).map(([value, label, hint]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setHudOpacity(value)}
                          className={`px-2 py-1 transition-colors duration-200 cursor-pointer ${hudOpacity === value ? 'bg-[#0a84ff] text-white font-semibold' : 'text-[rgba(235,235,245,0.62)] hover:bg-white/10'}`}
                          title={hint}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setTpAutoScroll((v) => !v)}
                      className={`ic-fill ${tpAutoScroll ? 'is-on' : ''} px-3 py-1.5 rounded-full ic-body text-[12px] font-medium text-[#f5f5f7] flex items-center gap-1.5 cursor-pointer`}
                      title={tpAutoScroll ? 'Pause auto-scroll (Space)' : 'Start auto-scroll (Space)'}
                    >
                      {tpAutoScroll
                        ? <Pause className="w-3.5 h-3.5 fill-current" />
                        : <Play className="w-3.5 h-3.5 fill-current" />}
                      <span>{tpAutoScroll ? 'Pause' : 'Auto-scroll'}</span>
                    </button>

                    <div className="flex items-center ic-fill rounded-full overflow-hidden ic-body text-[12px] font-medium">
                      {[0.5, 0.7, 1, 1.5, 2].map((speed) => (
                        <button
                          key={speed}
                          type="button"
                          onClick={() => setScrollSpeed(speed)}
                          className={`px-2 py-1 transition-colors duration-200 cursor-pointer ${scrollSpeed === speed ? 'bg-[#0a84ff] text-white font-semibold' : 'text-[rgba(235,235,245,0.62)] hover:bg-white/10'}`}
                          title={`Set scroll speed to ${speed}x`}
                        >
                          {speed}x
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => { if (promptScrollRef.current) promptScrollRef.current.scrollTop = 0; }}
                      className="ic-fill p-1.5 rounded-full text-[#f5f5f7] cursor-pointer"
                      title="Scroll to beginning"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                    </>)}

                    <button
                      type="button"
                      onClick={() => setTeleprompterOpen(false)}
                      className="ic-fill p-1.5 rounded-full text-[#f5f5f7] cursor-pointer"
                      title="Close teleprompter (Esc or T)"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div
                  ref={promptScrollRef}
                  className={`flex-1 overflow-y-auto space-y-4 font-sans select-text ${compact ? 'p-4' : 'p-6 sm:p-8'}`}
                  // Compact is read in glances over the top of a video call,
                  // so it caps the size someone picked for the full panel
                  // rather than shrinking the panel around 36px text.
                  style={{ fontSize: `${compact ? Math.min(promptFontSize, 19) : promptFontSize}px`, lineHeight: 1.62 }}
                >
                  {thinking && !streaming && (
                    <div className="flex items-center gap-2.5 text-[#0a84ff] font-medium animate-pulse text-base sm:text-lg">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Writing your answer...
                    </div>
                  )}
                  {card ? (
                    <div className="space-y-4">
                      {card.question && card.question !== 'Live transcript' && (
                        <div className="pb-3 border-b border-white/12 text-[rgba(235,235,245,0.62)] font-medium text-sm sm:text-base">
                          <span className="text-[#0a84ff] uppercase tracking-[0.08em] font-semibold mr-2">Q:</span>
                          {card.question}
                        </div>
                      )}
                      <div className="text-[#f5f5f7] font-medium whitespace-pre-wrap leading-relaxed tracking-tight">
                        {spoken(card.answer)}
                        {/* Where the model is up to. Without it a pause
                            between tokens reads as a finished answer. */}
                        {streaming && (
                          <span className="inline-block w-[0.5ch] -mb-[0.1em] ml-0.5 bg-[#0a84ff] animate-pulse" style={{ height: '1em' }} />
                        )}
                      </div>
                    </div>
                  ) : !thinking && (
                    <div className="py-14 text-center text-[rgba(235,235,245,0.62)] space-y-2">
                      <p className="ic-title text-[#f5f5f7] text-lg">Nothing to read out yet</p>
                      <p className="text-sm">
                        {autoAnswer
                          ? 'Hands-free is on — the next question is answered here on its own.'
                          : 'Press Space, and the answer appears here at reading size.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* The shortcut legend is worth a strip of a full panel and a
                    quarter of a compact one, which is too much: at that size
                    every pixel is the answer. */}
                {!compact && (
                <div className="px-5 py-2.5 border-t border-white/10 flex items-center justify-between text-[11px] font-medium text-[rgba(235,235,245,0.62)] shrink-0">
                  <div className="flex items-center gap-4">
                    <span><strong className="text-[#f5f5f7]">Space</strong> for an answer</span>
                    <span><strong className="text-[#f5f5f7]">T</strong> toggles this</span>
                    <span><strong className="text-[#f5f5f7]">A</strong> hands-free</span>
                    <span><strong className="text-[#f5f5f7]">Esc</strong> dismisses</span>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none text-[rgba(235,235,245,0.62)] font-medium">
                    <input
                      type="checkbox"
                      checked={autoOpenTeleprompter}
                      onChange={(e) => setAutoOpenTeleprompter(e.target.checked)}
                      className="rounded accent-[#0a84ff] w-3.5 h-3.5 cursor-pointer"
                    />
                    <span>Auto-open on new answer</span>
                  </label>
                </div>
                )}
              </div>
            </div>
          );
        })()}

      </div>
    </div>
  );
};
