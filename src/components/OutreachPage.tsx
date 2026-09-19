import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Building2, FileText, Loader2, MailCheck, Plus,
  RefreshCw, Search, Send, ShieldCheck, Trash2, Users, X,
} from 'lucide-react';

const BACKEND =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined'
    ? `http://${window.location.hostname || 'localhost'}:8000`
    : 'http://localhost:8000');

/**
 * The outreach workspace: find an employer, find the person, prove the
 * address, write the letter, build the dossier, send it, remember that you
 * did.
 *
 * Built as one page with an inner menu rather than four modals, because every
 * step reads the same ledger -- a prospect is a row that moves through stages,
 * and the sections are four windows onto that one table, not four features.
 */

export type Stage = 'new' | 'verified' | 'letter' | 'dossier' | 'sent' | 'replied' | 'failed';

export interface Prospect {
  id: number;
  company: string;
  contact_name: string;
  role: string;
  email: string;
  email_status: 'unknown' | 'guessed' | 'valid' | 'risky' | 'invalid';
  verify_reason?: string;
  verify_score?: number;
  verified_at?: string;
  source_url?: string;
  email_kind?: string;
  phone?: string;
  street?: string;
  postcode?: string;
  website: string;
  city: string;
  source: string;
  stage: Stage;
  notes: string;
  created_at: string;
  updated_at: string;
}

interface PipelineEvent {
  id: number;
  prospect_id: number | null;
  level: string;
  phase: string;
  message: string;
  created_at: string;
}

interface DocumentRow {
  id: number;
  prospect_id: number | null;
  subject: string;
  body: string;
  pdf_path: string;
  letter_path?: string;
  cv_path?: string;
  language?: string;
  dry_run: number;
  sent_at: string | null;
  message_id?: string;
  company?: string;
  contact_name?: string;
  email?: string;
  created_at: string;
}

/** What a bulk run would do, asked before it is started. */
interface SendPreview {
  ready: number;
  sent_today: number;
  remaining_today: number;
  cap: number;
  companies: string[];
  mailbox: { ok: boolean; how: string; address: string; reason: string };
}

interface CampaignState {
  running: boolean;
  dry_run: boolean;
  done: number;
  total: number;
  sent: number;
  drafted: number;
  failed: number;
  skipped: number;
  error: string;
}

interface Capability {
  ready: boolean;
  env: string;
  label: string;
  detail: string;
}

type Section = 'dashboard' | 'prospects' | 'pipeline' | 'documents';

const SECTIONS: { id: Section; label: string; icon: React.ElementType; hint: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: Activity, hint: 'What is connected and what it has done' },
  { id: 'prospects', label: 'Prospects', icon: Users, hint: 'Every employer and contact on file' },
  // Sending, and only sending. The tab used to narrate everything the app did,
  // which meant the four lines about letters going out were buried under two
  // hundred about company websites being read.
  { id: 'pipeline', label: 'Pipeline', icon: Send, hint: 'Applications going out, live' },
  { id: 'documents', label: 'Documents', icon: FileText, hint: 'What was written, and to whom' },
];

/** The colour of a stage, kept in one place so the table and the cards agree. */
const STAGE_TINT: Record<string, string> = {
  new: 'bg-white/[0.12] text-[#f5f5f7]',
  verified: 'bg-sky-400/15 text-sky-200',
  letter: 'bg-violet-400/15 text-violet-200',
  dossier: 'bg-amber-400/15 text-amber-200',
  sent: 'bg-emerald-400/15 text-emerald-200',
  replied: 'bg-emerald-400/25 text-emerald-100',
  failed: 'bg-rose-400/15 text-rose-200',
};

const EMAIL_TINT: Record<string, string> = {
  unknown: 'text-[rgba(235,235,245,0.42)]',
  guessed: 'text-amber-200',
  valid: 'text-emerald-200',
  risky: 'text-amber-200',
  invalid: 'text-rose-200',
};

const StatCard: React.FC<{ label: string; value: number | string; sub?: string }> = ({
  label, value, sub,
}) => (
  <div className="ic-glass rounded-2xl px-4 py-3.5">
    <p className="text-[12px] tracking-[-0.01em] text-[rgba(235,235,245,0.62)]">{label}</p>
    <p className="mt-1 text-[26px] font-semibold tracking-[-0.03em] text-[#f5f5f7] tabular-nums">
      {value}
    </p>
    {sub ? <p className="text-[11.5px] text-[rgba(235,235,245,0.42)]">{sub}</p> : null}
  </div>
);

/**
 * One integration, and whether it can run.
 *
 * Names the variable to set and never the value in it: this is a web page, and
 * a status row that shows the first six characters of a key to look helpful
 * has published the key.
 */
const CapabilityRow: React.FC<{ cap: Capability }> = ({ cap }) => (
  <div className="flex items-start gap-3 py-2.5 border-b border-white/[0.07] last:border-0">
    <span
      className={`mt-[5px] w-2 h-2 rounded-full shrink-0 ${
        cap.ready ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-white/25'
      }`}
    />
    <div className="min-w-0 flex-1">
      <p className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#f5f5f7]">{cap.label}</p>
      <p className="text-[12px] text-[rgba(235,235,245,0.52)]">{cap.detail}</p>
    </div>
    <span
      className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        cap.ready ? 'bg-emerald-400/15 text-emerald-200' : 'bg-white/[0.08] text-[rgba(235,235,245,0.62)]'
      }`}
      title={cap.ready ? 'Configured' : `Set ${cap.env} in .env`}
    >
      {cap.ready ? 'Connected' : 'Needs ' + cap.env}
    </span>
  </div>
);

const StagePill: React.FC<{ stage: string }> = ({ stage }) => (
  <span
    className={`inline-flex items-center px-2 py-[2px] rounded-full text-[11px] font-semibold capitalize ${
      STAGE_TINT[stage] || STAGE_TINT.new
    }`}
  >
    {stage}
  </span>
);

const EMPTY_DRAFT = {
  company: '', contact_name: '', role: '', email: '', city: '', website: '', notes: '',
};

/**
 * Which section the page is on, kept in the address bar.
 *
 * A reload used to land back on the Dashboard no matter where you were. That
 * is not a small annoyance in a workspace that is watched for an hour: you
 * refresh to see whether a run has moved and you lose your place, every time.
 * The section goes in the URL rather than in storage so the back button, a
 * duplicated tab and a bookmark all behave the way they look like they should.
 */
const readSection = (): Section => {
  if (typeof window === 'undefined') return 'dashboard';
  const view = new URLSearchParams(window.location.search).get('view') || '';
  return (['dashboard', 'prospects', 'pipeline', 'documents'] as const)
    .includes(view as Section) ? (view as Section) : 'dashboard';
};

/**
 * The watermark that hides everything logged before Clear was pressed.
 *
 * Also has to survive a reload, and for a sharper reason than convenience:
 * clearing is the only way to make that console readable, and a Clear that
 * comes undone the moment you refresh is not a Clear, it is a scroll.
 */
const CLEARED_KEY = 'mapjob.outreach.clearedBefore';

const readCleared = (): number => {
  if (typeof window === 'undefined') return 0;
  const raw = Number(window.localStorage.getItem(CLEARED_KEY) || 0);
  return Number.isFinite(raw) ? raw : 0;
};

export const OutreachPage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [section, setSection] = useState<Section>(readSection);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [caps, setCaps] = useState<Record<string, Capability>>({});
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [showAdd, setShowAdd] = useState(false);
  const [hunt, setHunt] = useState({
    profession: '', city: '', company: '', count: 8, keyword: '', limit: 60,
  });
  /*
   * Three engines, because the three jobs are different jobs.
   *
   * Sweep reads employers' own websites: a whole city in one go, nothing to
   * pay, hundreds of published addresses an hour, and no name attached to
   * most of them. Research spends a model on a handful of companies and comes
   * back with whatever mailbox they printed. People goes after the mailbox
   * nobody printed: it finds the person who reads applications, works out how
   * the company spells addresses, and has the company's own mail server
   * confirm the one that person must have. Slowest, dearest, and the only one
   * that reaches a named human at a firm with nothing but a web form.
   */
  const [engine, setEngine] = useState<'fast' | 'deep' | 'people' | 'agentur'>('fast');
  const [hunting, setHunting] = useState(false);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  /*
   * The send campaign.
   *
   * `live` is a separate piece of state from the button that starts the run,
   * and it resets itself every time this page mounts. A toggle that remembers
   * "yes, really send" across a reload is a toggle that eventually sends two
   * hundred letters because somebody clicked the wrong thing.
   */
  const [sendRole, setSendRole] = useState('');
  // The rows a send has been clicked on, waiting for the one question that
  // decides whether mail leaves. Null means nothing is being asked.
  const [ask, setAsk] = useState<number[] | null>(null);
  const askRef = useRef<HTMLDivElement | null>(null);
  const [sendPreview, setSendPreview] = useState<SendPreview | null>(null);
  const [campaign, setCampaign] = useState<CampaignState | null>(null);
  const [openDoc, setOpenDoc] = useState<DocumentRow | null>(null);
  const [docPart, setDocPart] = useState<'pack' | 'letter' | 'cv'>('letter');
  // Which application is a click away from being thrown out. Held rather than
  // acted on, because a delete here can destroy the only copy of what an
  // employer received and a mis-click should not be able to do that.
  const [docDoomed, setDocDoomed] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState('');

  /**
   * The ticked rows, and the console's high-water mark.
   *
   * `picked` is a Set of prospect ids rather than a flag on each row, because
   * the table is paged: a selection stored in the rows would be thrown away by
   * the next page load, and a selection that silently shrinks when you page
   * away is worse than one that does not exist.
   *
   * `clearedBefore` is how the console is emptied: a millisecond watermark,
   * and the console shows what arrived after it. The events themselves are not
   * deleted -- the dashboard reads the same log, and the record of what the
   * pipeline did is not the operator's scratch pad. It is a number rather than
   * the ISO string the server sends because those two strings do not compare:
   * the server ends its timestamps with `+00:00` and the browser with `Z`.
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [clearedBefore, setClearedBefore] = useState(readCleared);
  const [rowBusy, setRowBusy] = useState<number | null>(null);

  // Remember where we are, and what was cleared, across a reload.
  useEffect(() => {
    const url = new URL(window.location.href);
    if ((url.searchParams.get('view') || 'dashboard') === section) return;
    if (section === 'dashboard') url.searchParams.delete('view');
    else url.searchParams.set('view', section);
    // Replace, not push: flicking between four sections should not bury the
    // page the user arrived from under four entries of back button.
    window.history.replaceState(window.history.state, '', url.toString());
  }, [section]);

  useEffect(() => {
    if (clearedBefore) window.localStorage.setItem(CLEARED_KEY, String(clearedBefore));
    else window.localStorage.removeItem(CLEARED_KEY);
  }, [clearedBefore]);

  const loadOverview = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/api/outreach/overview`);
      if (!res.ok) throw new Error(`Backend answered ${res.status}`);
      const data = await res.json();
      setStats(data.stats || {});
      setCaps(data.capabilities || {});
      setError('');
    } catch (err) {
      // Named plainly rather than swallowed: with the bridge down every panel
      // on this page is empty, and "0 prospects" would be a lie about the data
      // rather than the truth about the connection.
      setError('The automation service is not answering on port 8000.');
    }
  }, []);

  const loadProspects = useCallback(async (nextPage: number, search: string) => {
    setBusy(true);
    try {
      const params = new URLSearchParams({ page: String(nextPage), page_size: '20' });
      if (search.trim()) params.set('query', search.trim());
      const res = await fetch(`${BACKEND}/api/outreach/prospects?${params}`);
      const data = await res.json();
      setProspects(data.items || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
    } catch {
      setProspects([]);
    } finally {
      setBusy(false);
    }
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/api/outreach/documents`);
      const data = await res.json();
      setDocs(data.documents || []);
    } catch {
      setDocs([]);
    }
  }, []);

  const loadSendPreview = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/api/outreach/campaign/preview`);
      setSendPreview(await res.json());
    } catch {
      setSendPreview(null);
    }
  }, []);

  useEffect(() => {
    loadOverview();
    loadDocuments();
    loadSendPreview();
    fetch(`${BACKEND}/api/outreach/events?limit=200`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events || []))
      .catch(() => undefined);
  }, [loadOverview, loadDocuments, loadSendPreview]);

  // Search is debounced, page changes are not: typing should not fire a query
  // per keystroke, and a click on "next" should not wait a quarter second.
  useEffect(() => {
    const id = window.setTimeout(() => loadProspects(page, query), query ? 250 : 0);
    return () => window.clearTimeout(id);
  }, [page, query, loadProspects]);

  /**
   * The pipeline console, open for the whole visit rather than while its tab
   * is on screen. A log you only receive while watching it is not a log.
   */
  useEffect(() => {
    const source = new EventSource(`${BACKEND}/api/outreach/stream`);
    source.onmessage = (ev) => {
      try {
        const parsed: PipelineEvent = JSON.parse(ev.data);
        setEvents((prev) => [...prev, parsed].slice(-400));
      } catch {
        /* keep-alive frames are not events */
      }
    };
    source.onerror = () => undefined;
    return () => source.close();
  }, []);

  useEffect(() => {
    const el = consoleRef.current;
    if (el && section === 'pipeline') el.scrollTop = el.scrollHeight;
  }, [events, section]);

  const addProspect = async () => {
    if (!draft.company.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`${BACKEND}/api/outreach/prospects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(String(res.status));
      setDraft({ ...EMPTY_DRAFT });
      setShowAdd(false);
      setPage(1);
      await Promise.all([loadProspects(1, query), loadOverview()]);
    } catch {
      setError('That prospect could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const enrichProspect = async (id: number) => {
    setError('');
    setHunting(true);
    try {
      const res = await fetch(`${BACKEND}/api/outreach/prospects/${id}/enrich`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || 'That lookup could not be started.');
      }
    } catch (err) {
      setHunting(false);
      setError(err instanceof Error ? err.message : 'That lookup could not be started.');
    }
  };

  const removeProspect = async (id: number) => {
    await fetch(`${BACKEND}/api/outreach/prospects/${id}`, { method: 'DELETE' });
    await Promise.all([loadProspects(page, query), loadOverview()]);
  };

  /**
   * Start a search and then leave it alone.
   *
   * The research runs on the server for a minute or two, so the page does not
   * hold a request open waiting for it -- it starts the run, and the pipeline
   * console narrates. This poll exists only to know when to reload the table.
   */
  const startHunt = async () => {
    const fast = engine === 'fast';
    const board = engine === 'agentur';
    if (fast && !hunt.city.trim()) {
      setError('Name a city to sweep.');
      return;
    }
    if (board && !hunt.profession.trim()) {
      setError('Say what the board should search for.');
      return;
    }
    if (!fast && !board && !hunt.profession.trim() && !hunt.company.trim()) {
      setError('Say what role you are looking for, or name a company.');
      return;
    }
    setError('');
    setHunting(true);
    // A new search means the last run's sending log is history. The Pipeline
    // tab is about what is going out now, so it starts empty rather than with
    // yesterday's forty lines above today's first one.
    setClearedBefore(Date.now());
    const route = engine === 'fast' ? 'harvest'
      : engine === 'people' ? 'contacts'
        : engine === 'agentur' ? 'agentur' : 'discover';
    try {
      const res = await fetch(`${BACKEND}/api/outreach/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The board speaks its own two words, `was` and `wo`, and they are
        // passed through as typed: a search that works on the website works
        // here, which is the point of using its API rather than reading it.
        body: JSON.stringify(fast
          ? { city: hunt.city, keyword: hunt.keyword, limit: hunt.limit }
          : board
            ? { was: hunt.profession, wo: hunt.city, umkreis: 25,
                count: hunt.count, skip_agencies: true }
            : hunt),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || 'The search could not be started.');
      }
    } catch (err) {
      setHunting(false);
      setError(err instanceof Error ? err.message : 'The search could not be started.');
    }
  };

  /** Prove the addresses on file. Same single-flight lane as a search. */
  const startVerify = async () => {
    setError('');
    setHunting(true);
    try {
      const res = await fetch(`${BACKEND}/api/outreach/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 200, smtp: true }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || 'The check could not be started.');
      }
    } catch (err) {
      setHunting(false);
      setError(err instanceof Error ? err.message : 'The check could not be started.');
    }
  };

  /**
   * Start the bulk run.
   *
   * `asLive` is passed explicitly rather than read from state at the moment of
   * the click, so the two buttons cannot be confused for one another by a
   * stale render: "Draft them" always drafts, whatever the toggle says.
   *
   * `ids` is who. There is no run without one: the app does not decide who to
   * write to any more, the table does, which is why the send controls live
   * over the table and this page only reports.
   */
  const startCampaign = async (asLive: boolean, ids: number[]) => {
    setError('');
    try {
      const res = await fetch(`${BACKEND}/api/outreach/campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: sendRole, dry_run: !asLive, limit: ids.length, ids,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.detail || 'The campaign could not be started.');
      }
      setSection('pipeline');
      setCampaign({
        running: true, dry_run: !asLive, done: 0, total: ids.length,
        sent: 0, drafted: 0, failed: 0, skipped: 0, error: '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The campaign could not be started.');
    }
  };

  /**
   * One row's send button, and the bulk bar above the table.
   *
   * This used to read a switch kept somewhere else on the page -- tick "really
   * send" first, then click the arrow. It was wrong twice over. It is a mode,
   * so the same click did two different things depending on a box you could
   * not see while looking at the row; and the mode defaults to off and resets
   * on every reload, so the honest description of that button was "drafts,
   * usually". Clicking send and getting a draft is not a safety feature, it is
   * the button lying.
   *
   * So the question moved onto the click. Nothing is sent and nothing is
   * drafted until the strip below says which company, at which address, from
   * which mailbox, and the answer is given there. A decision you cannot forget
   * having made, because you make it every time.
   */
  const sendRows = (ids: number[]) => {
    if (!ids.length) return;
    setAsk(ids);
    // Re-ask the server how much of the day is left. The strip quotes that
    // number while somebody decides, and a stale one is worse than none: it is
    // a figure being relied on that is quietly wrong.
    loadSendPreview();
    // The question lives above the table, and the row that was clicked may be
    // eighty rows down. A confirmation nobody can see reads as a dead button.
    window.requestAnimationFrame(() => {
      askRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  };

  const doSend = async (ids: number[], asLive: boolean) => {
    setAsk(null);
    setRowBusy(ids.length === 1 ? ids[0] : -1);
    try {
      await startCampaign(asLive, ids);
      setPicked(new Set());
    } finally {
      setRowBusy(null);
    }
  };

  const removeRows = async (ids: number[]) => {
    if (!ids.length) return;
    await fetch(`${BACKEND}/api/outreach/prospects/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setPicked(new Set());
    await Promise.all([loadProspects(page, query), loadOverview(), loadSendPreview()]);
  };

  /**
   * Throw an application away.
   *
   * The confirm step is upstream of this, in the strip that names what is
   * being lost. By the time this runs the question has been answered, so it
   * gets on with it and reopens the next document rather than leaving the
   * reader looking at a blank panel where the one they deleted used to be.
   */
  const removeDocs = async (ids: number[]) => {
    if (!ids.length) return;
    setDocDoomed(null);
    try {
      const res = await fetch(`${BACKEND}/api/outreach/documents/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) throw new Error('The application could not be deleted.');
      if (openDoc && ids.includes(openDoc.id)) setOpenDoc(null);
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The delete failed.');
    }
  };

  /**
   * Prove the sending works, on yourself.
   *
   * The only way to learn whether a real send works is to do one, and the
   * alternative to this button is learning it on a stranger: a real employer
   * as the first test of a token, an attachment and a letter that might render
   * in the wrong language. This sends the same thing down the same path to the
   * mailbox it comes from, so the first person to see a broken application is
   * the person who can fix it.
   */
  const sendTestToSelf = async () => {
    setError('');
    setTestNote('');
    setTesting(true);
    try {
      const res = await fetch(`${BACKEND}/api/outreach/campaign/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: sendRole }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'The test did not send.');
      setTestNote(`Sent to ${data.to}. Open your inbox - the letter and the CV `
        + 'are attached exactly as an employer would get them.');
      await Promise.all([loadDocuments(), loadSendPreview(),
        loadProspects(page, query)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test did not send.');
    } finally {
      setTesting(false);
    }
  };

  const togglePick = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const stopCampaign = async () => {
    try {
      await fetch(`${BACKEND}/api/outreach/campaign/cancel`, { method: 'POST' });
    } catch {
      /* if the server is gone the run is gone with it */
    }
  };

  // While a run is in flight the progress bar needs a number, and the
  // documents list needs to grow as the letters are written.
  useEffect(() => {
    if (!campaign?.running) return undefined;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND}/api/outreach/campaign/status`);
        const state: CampaignState = await res.json();
        setCampaign(state);
        if (!state.running) {
          // The table too: a run moves every prospect it touched to `dossier`
          // or `sent`, and a stage column still saying `new` after the letter
          // went out is the table lying about what happened.
          await Promise.all([loadDocuments(), loadOverview(), loadSendPreview(),
            loadProspects(page, query)]);
          if (state.error) setError(state.error);
        }
      } catch {
        /* the server is restarting; the next tick will say so */
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [campaign?.running, loadDocuments, loadOverview, loadSendPreview,
      loadProspects, page, query]);

  /** Call off a run in flight. It stops after the company it is reading. */
  const stopHunt = async () => {
    try {
      await fetch(`${BACKEND}/api/outreach/discover/cancel`, { method: 'POST' });
    } catch {
      /* if the server is gone the run is gone with it */
    }
  };

  useEffect(() => {
    if (!hunting) return undefined;
    const id = window.setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND}/api/outreach/discover/status`);
        const state = await res.json();
        // A sweep fills the table for twenty minutes. Reloading it as it goes
        // is the difference between watching it work and waiting for it.
        setPage(1);
        await Promise.all([loadProspects(1, query), loadOverview()]);
        if (!state.running) {
          setHunting(false);
          if (state.error) setError(state.error);
        }
      } catch {
        /* the server is restarting; the next tick will say so */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [hunting, query, loadProspects, loadOverview]);

  // What the search is doing right now, in the search panel, so the answer to
  // "is this thing working" does not require changing tabs.
  const huntLine = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].phase === 'discovery' || events[i].phase === 'harvest') {
        return events[i].message;
      }
    }
    return '';
  }, [events]);

  /**
   * What the Pipeline console shows: sending, and nothing else.
   *
   * Everything the app does writes to one log -- discovery, harvesting, the
   * board reader, the verifier -- and showing all of it here buried the four
   * lines that matter under two hundred that do not. Those other phases each
   * have their own place already: the search narrates into its own panel, and
   * the dashboard keeps the full history. This tab answers one question, which
   * is whether the letters are going out.
   */
  const sendLog = useMemo(
    // The second's grace is not sloppiness: the server stamps its events to
    // whole seconds, so an event written at 56.9 carries 56.0 and a watermark
    // taken at 56.5 would hide the line the user just caused.
    () => events.filter((ev) => ev.phase === 'campaign'
      && Date.parse(ev.created_at) >= clearedBefore - 1000),
    [events, clearedBefore],
  );

  const connected = useMemo(
    () => Object.values(caps).filter((c) => c.ready).length,
    [caps],
  );

  const sectionBody = () => {
    if (section === 'dashboard') {
      return (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Prospects" value={stats.prospects ?? 0} />
            <StatCard label="Emails sent" value={stats.emails_sent ?? 0} sub="For real, not dry runs" />
            <StatCard label="Pending" value={stats.pending ?? 0} sub="Not yet sent" />
            <StatCard label="Verified addresses" value={stats.verified_addresses ?? 0} />
            <StatCard label="Dry runs" value={stats.dry_runs ?? 0} />
            <StatCard label="Dossiers" value={stats.dossiers ?? 0} sub="PDFs assembled" />
          </div>

          <div className="ic-glass rounded-2xl px-4 py-3">
            <div className="flex items-baseline justify-between gap-3 pb-1">
              <h3 className="ic-title text-[15px] text-[#f5f5f7]">Integrations</h3>
              <span className="text-[12px] text-[rgba(235,235,245,0.52)]">
                {connected} of {Object.keys(caps).length || 6} connected
              </span>
            </div>
            {Object.entries(caps).map(([key, cap]) => (
              <CapabilityRow key={key} cap={cap} />
            ))}
            <p className="pt-3 text-[12px] leading-relaxed text-[rgba(235,235,245,0.42)]">
              Keys belong in the project's .env file, pasted straight in. Nothing on
              this page ever displays one, and a key sent through a chat window has
              to be treated as burnt and rotated.
            </p>
          </div>

          <div className="ic-glass rounded-2xl px-4 py-3">
            <h3 className="ic-title text-[15px] text-[#f5f5f7] pb-1">Latest activity</h3>
            {events.length === 0 ? (
              <p className="py-2 text-[13px] text-[rgba(235,235,245,0.42)]">
                Nothing has run yet.
              </p>
            ) : (
              events.slice(-6).reverse().map((ev) => (
                <div key={ev.id} className="flex items-center gap-2.5 py-1.5 border-b border-white/[0.07] last:border-0">
                  <span className="text-[11px] tabular-nums text-[rgba(235,235,245,0.42)] shrink-0">
                    {ev.created_at.slice(11, 19)}
                  </span>
                  <span className="text-[11px] uppercase tracking-wide text-[rgba(235,235,245,0.52)] shrink-0">
                    {ev.phase}
                  </span>
                  <span className="text-[13px] text-[#f5f5f7] truncate">{ev.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      );
    }

    if (section === 'prospects') {
      // Ready means Google actually answered when we asked, not that an
      // address is configured. A token can be revoked from a phone; the send
      // button must not offer to do something the mailbox will refuse.
      const mailboxReady = Boolean(sendPreview?.mailbox?.ok);
      const allPicked = prospects.length > 0 && prospects.every((p) => picked.has(p.id));
      // Who the pending question is about. Resolved from the rows on screen so
      // the strip can name them instead of counting them.
      const askRows = (ask || []).map((id) => prospects.find((p) => p.id === id));
      const askNames = askRows.map((p, i) => p?.company || `prospect ${ask?.[i]}`);
      const askTo = askRows.length === 1 ? (askRows[0]?.email || '') : '';

      return (
        <div className="space-y-3">

          {/*
            * Finding leads is the first step of the pipeline, so it sits on top
            * of the list it fills rather than behind a button somewhere else.
            * Two fields do the work: the role you want and where you want it.
            * Naming a company narrows the search to that company's own branches
            * and subsidiaries -- and to nothing else, which is the part that
            * takes enforcing.
            */}
          <div className="ic-glass rounded-2xl p-3.5">
            <div className="flex items-center gap-2 pb-2.5">
              <Search className="w-4 h-4 text-[#0a84ff]" />
              <h4 className="text-[13.5px] font-semibold tracking-[-0.01em] text-[#f5f5f7]">
                Find leads
              </h4>
              <span className="hidden lg:inline text-[12px] text-[rgba(235,235,245,0.45)]">
                {engine === 'fast'
                  ? 'Every employer in a city, read off their own websites'
                  : engine === 'people'
                    ? 'The person who reads applications, and their address proved by the company mail server'
                    : engine === 'agentur'
                      ? 'German federal job board, through its own API: addresses and telephone numbers as the employer printed them'
                      : 'A few employers, researched down to whatever mailbox they publish'}
              </span>

              {/* The choice is breadth or depth, so it is one control, not a
                  settings page. */}
              <div className="ml-auto flex rounded-lg bg-white/[0.06] border border-white/[0.09] p-0.5">
                {([
                  ['fast', 'Sweep', 'Hundreds of published addresses. Free.'],
                  ['deep', 'Research', 'Whatever mailbox the company publishes.'],
                  ['people', 'People', 'Finds the person, builds their address from the company naming pattern, proves it by SMTP. Slowest and dearest.'],
                  ['agentur', 'Agentur', 'The Bundesagentur fuer Arbeit job board, through its public API. Employers print their own address and telephone number in the listing. Free, fast, Germany only. Staffing agencies are dropped.'],
                ] as const).map(([key, label, tip]) => (
                  <button
                    key={key}
                    type="button"
                    title={tip}
                    onClick={() => setEngine(key)}
                    className={`px-2.5 py-1 rounded-[7px] text-[12px] font-medium transition-colors cursor-pointer ${
                      engine === key
                        ? 'bg-white/[0.14] text-[#f5f5f7]'
                        : 'text-[rgba(235,235,245,0.52)] hover:text-[#f5f5f7]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
              {(engine === 'fast' ? ([
                ['city', 'City to sweep', 'Osnabrueck'],
                ['keyword', 'Kind of employer (optional)', 'Pflege, Bau, Hotel'],
              ] as const) : engine === 'agentur' ? ([
                ['profession', 'What the board calls it', 'Ausbildung-Kaufmann/-frau Bueromanagement'],
                ['city', 'City', 'Berlin'],
              ] as const) : ([
                ['profession', 'Role you want', 'Kauffrau fuer Bueromanagement'],
                ['city', 'City', 'Osnabrueck'],
                ['company', 'Company (optional)', 'Lidl'],
              ] as const)).map(([field, label, hint]) => (
                <label key={field} className="block">
                  <span className="block pb-1 text-[11.5px] text-[rgba(235,235,245,0.52)]">{label}</span>
                  <input
                    value={(hunt as unknown as Record<string, string>)[field]}
                    onChange={(e) => setHunt({ ...hunt, [field]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !hunting) startHunt(); }}
                    placeholder={hint}
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.09] text-[13px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.32)] outline-none focus:border-white/25"
                  />
                </label>
              ))}
              <div className="flex items-end gap-2">
                <label className="block w-[92px]">
                  <span className="block pb-1 text-[11.5px] text-[rgba(235,235,245,0.52)]">How many</span>
                  <input
                    type="number"
                    min={1}
                    max={engine === 'fast' ? 800 : engine === 'agentur' ? 200 : 20}
                    value={engine === 'fast' ? hunt.limit : hunt.count}
                    onChange={(e) => setHunt(engine === 'fast'
                      ? { ...hunt, limit: Number(e.target.value) || 60 }
                      : { ...hunt, count: Number(e.target.value) || 8 })}
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.09] text-[13px] text-[#f5f5f7] outline-none focus:border-white/25"
                  />
                </label>
                <button
                  type="button"
                  onClick={hunting ? stopHunt : startHunt}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold transition-colors cursor-pointer ${
                    hunting
                      ? 'bg-white/[0.10] hover:bg-white/[0.16] text-[#f5f5f7]'
                      : 'bg-[#0a84ff] hover:bg-[#3b9bff] text-white'
                  }`}
                >
                  {hunting
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Stop</>
                    : <><Building2 className="w-4 h-4" /> {
                        engine === 'fast' ? 'Sweep city'
                          : engine === 'people' ? 'Find people'
                            : engine === 'agentur' ? 'Read the board' : 'Find leads'
                      }</>}
                </button>
              </div>
            </div>

            {hunting || huntLine ? (
              <p className="pt-2.5 text-[12px] text-[rgba(235,235,245,0.52)] flex items-center gap-2">
                {hunting ? <Activity className="w-3.5 h-3.5 text-[#0a84ff] shrink-0" /> : null}
                <span className="truncate">
                  {huntLine || 'Reading company websites'}
                  {hunting ? ' - rows appear as they are found' : ''}
                </span>
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[rgba(235,235,245,0.42)]" />
              <input
                value={query}
                onChange={(e) => { setPage(1); setQuery(e.target.value); }}
                placeholder="Search company, contact, address or city"
                className="w-full pl-9 pr-3 py-2.5 rounded-xl bg-white/[0.06] border border-white/[0.09] text-[13.5px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.42)] outline-none focus:border-white/25"
              />
            </div>
            {/* Proving the addresses is the step between having a list and
                being allowed to write to it, so it sits with the list. */}
            <button
              type="button"
              onClick={startVerify}
              disabled={hunting}
              title="Ask each mailbox server whether the address exists, before anything is sent to it"
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] disabled:opacity-40 text-[#f5f5f7] text-[13px] font-semibold transition-colors"
            >
              <ShieldCheck className="w-4 h-4" /> Check addresses
            </button>
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-[#0a84ff] hover:bg-[#3b9bff] text-white text-[13px] font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> Add prospect
            </button>
          </div>

          {showAdd && (
            <div className="ic-glass rounded-2xl p-3.5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
              {([
                ['company', 'Company *'], ['contact_name', 'Contact person'], ['role', 'Their role'],
                ['email', 'Email address'], ['city', 'City'], ['website', 'Website'],
              ] as const).map(([field, label]) => (
                <label key={field} className="block">
                  <span className="block pb-1 text-[11.5px] text-[rgba(235,235,245,0.52)]">{label}</span>
                  <input
                    value={(draft as Record<string, string>)[field]}
                    onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.09] text-[13px] text-[#f5f5f7] outline-none focus:border-white/25"
                  />
                </label>
              ))}
              <div className="sm:col-span-2 xl:col-span-3 flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setDraft({ ...EMPTY_DRAFT }); }}
                  className="px-3.5 py-2 rounded-xl bg-white/[0.08] text-[13px] text-[#f5f5f7] hover:bg-white/[0.14] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!draft.company.trim() || busy}
                  onClick={addProspect}
                  className="px-3.5 py-2 rounded-xl bg-[#0a84ff] hover:bg-[#3b9bff] disabled:opacity-40 text-white text-[13px] font-semibold transition-colors"
                >
                  Save prospect
                </button>
              </div>
            </div>
          )}

          {/*
            * The send bar.
            *
            * This is where an application starts, because this is where the
            * employers are: you read the row, you tick it, you send to it. The
            * two things the letter needs that a row cannot tell you -- what
            * you are asking for, and whether this is real -- live here, in
            * sight of the table, rather than on the page that reports results.
            */}
          <div ref={askRef} className="ic-glass rounded-2xl px-3.5 py-3 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <Send className="w-4 h-4 text-[#0a84ff] shrink-0" />
              <input
                value={sendRole}
                onChange={(e) => setSendRole(e.target.value)}
                placeholder="What you are asking for - Ausbildung Kaufmann fuer Bueromanagement"
                className="flex-1 min-w-[240px] rounded-xl bg-white/[0.06] px-3 py-1.5 text-[13px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.3)] outline-none focus:bg-white/[0.09]"
              />
              {/* The rehearsal that is not a rehearsal. It really sends, which
                * is the point: a dry run proves the letter and proves nothing
                * about the mailbox, the token or the attachments. Addressed to
                * the account it leaves from, so the experiment is on the user
                * and not on a company they wanted to work for. */}
              <button
                type="button"
                onClick={sendTestToSelf}
                disabled={!sendPreview?.mailbox?.ok || testing || Boolean(campaign?.running)}
                title={sendPreview?.mailbox?.ok
                  ? `Really send one application to ${sendPreview?.mailbox?.address}, so you can see what an employer would get`
                  : 'The mailbox is not connected yet'}
                className="rounded-xl px-3 py-1.5 text-[12.5px] font-medium bg-white/[0.07] text-[rgba(235,235,245,0.82)] hover:bg-white/[0.12] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors inline-flex items-center gap-1.5"
              >
                {testing
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <MailCheck className="w-3.5 h-3.5" />}
                {testing ? 'Sending' : 'Test on myself'}
              </button>
            </div>

            {testNote ? (
              <p className="ic-row-in text-[12px] text-emerald-200/90">{testNote}</p>
            ) : null}

            {/*
              * The question, and the only place an answer to it exists.
              *
              * It names the company, the address and the mailbox, because
              * "send for real?" is not a question anybody can answer -- send
              * what, to whom, from where. Both answers are offered as buttons
              * of equal weight and neither is focused by default, so nothing
              * here can be got through by hitting return twice.
              */}
            {ask ? (
              <div className="ic-row-in rounded-xl bg-[#0a84ff]/[0.1] ring-1 ring-inset ring-[#0a84ff]/30 px-3 py-2.5 space-y-2">
                <p className="text-[13px] text-[#f5f5f7]">
                  {ask.length === 1 ? (
                    <>
                      Send a real application to{' '}
                      <span className="font-semibold">{askNames[0]}</span>
                      {askTo ? <> at <span className="font-semibold">{askTo}</span></> : null}?
                    </>
                  ) : (
                    <>
                      Send{' '}
                      <span className="font-semibold tabular-nums">{ask.length}</span>{' '}
                      real applications - {askNames.slice(0, 3).join(', ')}
                      {ask.length > 3 ? ` and ${ask.length - 3} more` : ''}?
                    </>
                  )}
                </p>
                <p className="text-[11.5px] text-[rgba(235,235,245,0.62)]">
                  {mailboxReady
                    ? <>They leave from <span className="text-[#f5f5f7]">{sendPreview?.mailbox?.address}</span>
                        {ask.length > 1 ? ', one every 40 seconds' : ''}. Mail cannot be unsent.
                        {' '}{sendPreview?.sent_today ?? 0} of {sendPreview?.cap ?? 40} used today.</>
                    : 'The mailbox is not connected, so only a draft is possible right now.'}
                </p>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={() => doSend(ask, true)}
                    disabled={!mailboxReady}
                    className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold bg-[#0a84ff] text-white hover:bg-[#0a84ff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors inline-flex items-center gap-2"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {ask.length === 1 ? 'Send it for real' : `Send all ${ask.length} for real`}
                  </button>
                  <button
                    type="button"
                    onClick={() => doSend(ask, false)}
                    className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold bg-white/[0.1] text-[#f5f5f7] hover:bg-white/[0.16] cursor-pointer transition-colors"
                  >
                    Just write {ask.length === 1 ? 'the letter' : 'the letters'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAsk(null)}
                    className="rounded-xl px-2.5 py-1.5 text-[12.5px] text-[rgba(235,235,245,0.52)] hover:text-[#f5f5f7] cursor-pointer transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : picked.size === 0 ? (
              <p className="text-[11.5px] text-[rgba(235,235,245,0.42)]">
                Send from any row, or tick several and send them together. Each send asks
                once, by name, before anything leaves - one every 40 seconds, up to{' '}
                {sendPreview?.cap ?? 40} a day. {sendPreview?.sent_today ?? 0} sent in the
                last 24 hours.
              </p>
            ) : (
              <div className="ic-row-in flex flex-wrap items-center gap-2.5">
                <span className="text-[13px] text-[#f5f5f7]">
                  <span className="tabular-nums font-semibold">{picked.size}</span> selected
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="text-[12.5px] text-[rgba(235,235,245,0.52)] hover:text-[#f5f5f7] transition-colors cursor-pointer"
                >
                  Clear
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => sendRows([...picked])}
                  disabled={rowBusy !== null || Boolean(campaign?.running)}
                  className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold inline-flex items-center gap-2 bg-[#0a84ff] text-white hover:bg-[#0a84ff]/90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  title={`Send ${picked.size} application${picked.size === 1 ? '' : 's'}`}
                >
                  <Send className="w-3.5 h-3.5" />
                  Send {picked.size}
                </button>
                <button
                  type="button"
                  onClick={() => removeRows([...picked])}
                  className="rounded-xl px-3.5 py-1.5 text-[13px] font-semibold bg-rose-500/15 text-rose-200 hover:bg-rose-500/25 cursor-pointer transition-colors inline-flex items-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete {picked.size}
                </button>
              </div>
            )}
          </div>

          <div className="ic-glass rounded-2xl overflow-hidden">
            <div className="hidden md:grid grid-cols-[28px_1.4fr_1.2fr_1.4fr_0.7fr_104px] gap-3 px-4 py-2.5 border-b border-white/[0.09] text-[11.5px] uppercase tracking-wide text-[rgba(235,235,245,0.52)]">
              <input
                type="checkbox"
                checked={allPicked}
                ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !allPicked; }}
                onChange={() => setPicked(allPicked
                  ? new Set()
                  : new Set(prospects.map((p) => p.id)))}
                title="Select everything on this page"
                className="accent-[#0a84ff] w-3.5 h-3.5 cursor-pointer self-center"
              />
              <span>Company</span><span>Contact</span><span>Address</span><span>Stage</span><span />
            </div>
            {prospects.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Building2 className="w-6 h-6 mx-auto mb-2 text-[rgba(235,235,245,0.32)]" />
                <p className="text-[13.5px] text-[rgba(235,235,245,0.62)]">
                  {query ? 'Nothing matches that search.' : 'No prospects yet.'}
                </p>
              </div>
            ) : (
              prospects.map((p) => (
                <div
                  key={p.id}
                  className={`grid grid-cols-1 md:grid-cols-[28px_1.4fr_1.2fr_1.4fr_0.7fr_104px] gap-1 md:gap-3 px-4 py-2.5 border-b border-white/[0.07] last:border-0 transition-colors ${
                    picked.has(p.id) ? 'bg-[#0a84ff]/[0.12]' : 'hover:bg-white/[0.05]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    onChange={() => togglePick(p.id)}
                    className="accent-[#0a84ff] w-3.5 h-3.5 cursor-pointer self-center justify-self-start"
                  />
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-[#f5f5f7] truncate">{p.company}</p>
                    <p className="text-[12px] text-[rgba(235,235,245,0.42)] truncate">{p.city || p.website}</p>
                  </div>
                  <div className="min-w-0 text-[13px] text-[rgba(235,235,245,0.62)] truncate">
                    {p.contact_name || '--'}
                    {p.role ? <span className="text-[rgba(235,235,245,0.42)]"> - {p.role}</span> : null}
                  </div>
                  {/* The verdict lives on the address, and its reason lives in
                    * the tooltip: "risky" on its own is a shrug, and the
                    * operator has to be able to tell a catch-all domain from a
                    * mail server that was simply having a bad morning. */}
                  <div
                    className={`min-w-0 text-[13px] flex items-center gap-1.5 ${EMAIL_TINT[p.email_status] || ''}`}
                    title={p.verify_reason
                      ? `${p.email_status}: ${p.verify_reason}`
                      : p.email ? 'not checked yet' : ''}
                  >
                    {/* An address is a claim until you can see where it came
                      * from. When the page it was read off is known, the
                      * address links to it, so checking one is a click rather
                      * than a search. */}
                    <span className="truncate">
                      {p.email
                        ? (p.source_url
                            ? <a
                                href={p.source_url}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline underline-offset-2"
                              >{p.email}</a>
                            : p.email)
                        : p.phone
                          // No mailbox, but a telephone number the employer
                          // printed itself. For an apprenticeship that is not
                          // a consolation prize: a two-minute call reaches the
                          // person a hundred emails do not.
                          ? <a
                              href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}
                              className="hover:underline underline-offset-2"
                            >{p.phone}</a>
                          : 'no address yet'}
                    </span>
                    {!p.email && p.phone ? (
                      <span className="shrink-0 px-1 rounded text-[10px] uppercase tracking-wide bg-sky-400/15 text-sky-200/90">
                        phone
                      </span>
                    ) : null}
                    {/* Where the address came from, never left to be inferred
                      * from a colour. "Guess" is an address this app built out
                      * of a person's name that no mail server has confirmed;
                      * it looks exactly like a real one, which is precisely
                      * why it has to say so. */}
                    {p.email_kind === 'inferred' ? (
                      <span className="shrink-0 px-1 rounded text-[10px] uppercase tracking-wide bg-amber-400/15 text-amber-200/90">
                        guess
                      </span>
                    ) : p.email_kind === 'pattern' ? (
                      <span
                        className="shrink-0 px-1 rounded text-[10px] uppercase tracking-wide bg-emerald-400/15 text-emerald-200/90"
                        title="Built from the company naming pattern and accepted by its mail server"
                      >
                        proved
                      </span>
                    ) : null}
                  </div>
                  <div><StagePill stage={p.stage} /></div>
                  <div className="justify-self-start md:justify-self-end flex items-center gap-0.5">
                    {/* Write to this one company. The same run the bulk button
                      * starts, with a queue of one -- so the rules about
                      * guessed addresses, second letters and the daily cap are
                      * the same rules, decided in the same place on the server.
                      * Disabled when there is nothing to write to, and the
                      * tooltip says which of the two it would do. */}
                    <button
                      type="button"
                      onClick={() => sendRows([p.id])}
                      disabled={!p.email || p.stage === 'sent'
                        || p.email_status === 'invalid'
                        || rowBusy !== null || Boolean(campaign?.running)}
                      title={!p.email
                        ? 'No address to write to'
                        : p.email_status === 'invalid'
                          ? 'The mail server said there is no such mailbox'
                          : p.stage === 'sent'
                            ? 'Already written to'
                            : `Send an application to ${p.company}`}
                      className={`p-1.5 rounded-lg hover:bg-white/[0.08] disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer transition-colors ${
                        ask?.includes(p.id)
                          ? 'text-[#0a84ff] bg-[#0a84ff]/15'
                          : 'text-[#0a84ff] hover:text-[#3b9bff]'
                      }`}
                    >
                      <Send className="w-4 h-4" />
                    </button>
                    {/* Look this one company up again. The same reading a search
                      * does, for a row typed in by hand, or found before the
                      * contact stage existed, or whose careers page has moved. */}
                    <button
                      type="button"
                      onClick={() => enrichProspect(p.id)}
                      disabled={hunting}
                      title={p.email ? 'Look up this company again' : 'Find the contact and address'}
                      className="p-1.5 rounded-lg text-[rgba(235,235,245,0.42)] hover:text-[#0a84ff] hover:bg-white/[0.08] disabled:opacity-30 transition-colors cursor-pointer"
                    >
                      <Search className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeProspect(p.id)}
                      title="Remove this prospect"
                      className="p-1.5 rounded-lg text-[rgba(235,235,245,0.42)] hover:text-rose-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between text-[12.5px] text-[rgba(235,235,245,0.52)]">
            <span>{total} on file{busy ? ' - loading' : ''}</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1.5 rounded-lg bg-white/[0.08] disabled:opacity-30 hover:bg-white/[0.14] transition-colors"
              >
                Previous
              </button>
              <span className="px-2 tabular-nums">{page} / {pages}</span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                className="px-3 py-1.5 rounded-lg bg-white/[0.08] disabled:opacity-30 hover:bg-white/[0.14] transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      );
    }

    /*
     * Pipeline: a progress display, and nothing you can press.
     *
     * It used to carry the send panel -- the role, the count, the arm switch,
     * the two buttons -- which made the page that reports on a run also the
     * page that starts one. Choosing who to write to belongs where the people
     * are, in Prospects. This page answers "how is it going", and the only
     * control on it is Stop, which is a thing you want in one obvious place
     * when a run is already moving.
     */
    if (section === 'pipeline') {
      const running = Boolean(campaign?.running);
      const done = campaign?.done ?? 0;
      const total = campaign?.total ?? 0;
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const finished = !running && total > 0;

      return (
        <div className="flex flex-col gap-3 h-full min-h-0">

          <div className="ic-glass rounded-2xl p-4 shrink-0">
            {total === 0 && !running ? (
              <div className="flex items-center gap-3">
                <Send className="w-4 h-4 text-[rgba(235,235,245,0.35)] shrink-0" />
                <div>
                  <p className="text-[13.5px] text-[#f5f5f7]">Nothing running</p>
                  <p className="text-[12px] text-[rgba(235,235,245,0.45)]">
                    Pick the employers in Prospects and send from there. The progress shows up here.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 pb-2.5">
                  <span className="text-[19px] font-semibold tabular-nums text-[#f5f5f7]">
                    {done}
                    <span className="text-[rgba(235,235,245,0.4)] font-normal"> / {total}</span>
                  </span>
                  <span className="text-[13px] text-[rgba(235,235,245,0.62)]">
                    {running
                      ? (campaign?.dry_run ? 'writing letters' : 'sending applications')
                      : (campaign?.dry_run ? 'letters written' : 'applications sent')}
                  </span>
                  <div className="flex-1" />
                  {running ? (
                    <button
                      type="button"
                      onClick={stopCampaign}
                      className="rounded-xl px-4 py-1.5 text-[13px] font-semibold bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 cursor-pointer transition-colors"
                    >
                      Stop
                    </button>
                  ) : (
                    <span className="text-[12.5px] text-emerald-200">Finished</span>
                  )}
                </div>

                {/* A real send waits forty seconds between letters, so for most
                  * of a run this bar does not move. A bar that has not moved in
                  * forty seconds looks broken -- hence the sheen crossing it
                  * while the run is alive, and the stillness the moment it
                  * is not. */}
                <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden relative">
                  <div
                    className={`h-full rounded-full transition-[width] duration-500 relative overflow-hidden ${
                      campaign?.dry_run ? 'bg-amber-400/70' : 'bg-[#0a84ff]'
                    } ${running ? 'ic-sheen' : ''}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] tabular-nums">
                  {campaign?.sent ? <span className="text-emerald-200">{campaign.sent} sent</span> : null}
                  {campaign?.drafted ? <span className="text-amber-200">{campaign.drafted} drafted</span> : null}
                  {campaign?.failed ? <span className="text-rose-200">{campaign.failed} failed</span> : null}
                  {campaign?.skipped ? <span className="text-[rgba(235,235,245,0.52)]">{campaign.skipped} skipped</span> : null}
                  {finished ? (
                    <button
                      type="button"
                      onClick={() => setSection('documents')}
                      className="text-[#0a84ff] hover:underline underline-offset-2 cursor-pointer"
                    >
                      Read what went out
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>

          {/*
            * The sending log, and only the sending log.
            *
            * There is no phase column any more because there is only one phase
            * left in here. Searching, harvesting and verifying still write to
            * the same log on the server -- the dashboard shows it -- but this
            * tab exists to answer whether the letters are going out, and that
            * answer was unreadable underneath two hundred lines about company
            * websites.
            */}
          <div className="ic-glass-deep rounded-2xl flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
              <span className="text-[11.5px] uppercase tracking-wide text-[rgba(235,235,245,0.45)]">
                Sending log
              </span>
              {running ? (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[#0a84ff]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#0a84ff] ic-breathe" />
                  live
                </span>
              ) : null}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => {
                  setClearedBefore(Date.now());
                  // The tally above belongs to the run whose lines are being
                  // cleared. Leaving "2 / 2 Finished" sitting over an empty
                  // console is a figure with nothing behind it. A run still
                  // going keeps its counter -- that one is not history yet.
                  if (!running) setCampaign(null);
                }}
                disabled={sendLog.length === 0 && !finished}
                title="Empty this console. The record itself is kept."
                className="text-[12px] text-[rgba(235,235,245,0.45)] hover:text-[#f5f5f7] disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
              >
                Clear
              </button>
            </div>
            <div
              ref={consoleRef}
              className="px-4 pb-4 flex-1 min-h-0 overflow-y-auto custom-scrollbar font-mono text-[12.5px] leading-relaxed"
            >
              {sendLog.length === 0 ? (
                <p className="text-[rgba(235,235,245,0.42)]">
                  Nothing going out. Start a run above, or send from a row in Prospects.
                </p>
              ) : (
                sendLog.map((ev) => (
                  <div key={ev.id} className="flex gap-2.5 ic-row-in">
                    <span className="text-[rgba(235,235,245,0.32)] tabular-nums shrink-0">
                      {ev.created_at.slice(11, 19)}
                    </span>
                    <span
                      className={
                        ev.level === 'error' ? 'text-rose-300'
                          : ev.level === 'warn' ? 'text-amber-200'
                          : 'text-[rgba(235,235,245,0.82)]'
                      }
                    >
                      {ev.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      );
    }

    /*
     * Documents: what was written, and the paper that went with it.
     *
     * The list on the left, the application itself on the right. An entry that
     * cannot be opened and read is a log line, not a record -- the whole point
     * of keeping a dry run is that somebody looks at the letter before the
     * live run goes out.
     */
    const chosen = openDoc && docs.find((d) => d.id === openDoc.id) ? openDoc : docs[0] || null;
    const doomed = docs.find((d) => d.id === docDoomed) || null;
    const doomedWasSent = Boolean(doomed?.sent_at && !doomed?.dry_run);
    const draftCount = docs.filter((d) => !(d.sent_at && !d.dry_run)).length;

    return (
      <div className="flex flex-col lg:flex-row gap-3 h-full min-h-0">
        <div className="ic-glass rounded-2xl lg:w-[380px] shrink-0 min-h-0 flex flex-col overflow-hidden">
          <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.09]">
            <span className="text-[11.5px] uppercase tracking-wide text-[rgba(235,235,245,0.52)]">
              {docs.length} application{docs.length === 1 ? '' : 's'}
            </span>
            <div className="flex-1" />
            {/* Drafts only. A button that could wipe the record of everything
              * ever sent, sitting one pixel from a list you scroll, is a
              * disaster waiting for a tired evening. */}
            <button
              type="button"
              onClick={() => removeDocs(docs.filter((d) => !(d.sent_at && !d.dry_run))
                .map((d) => d.id))}
              disabled={draftCount === 0}
              title="Delete every draft. Applications that really went out are kept."
              className="rounded-lg px-2.5 py-1 text-[12px] bg-white/[0.05] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.09] disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              Clear {draftCount} draft{draftCount === 1 ? '' : 's'}
            </button>
          </div>

          {/*
            * The question, asked in one place and in full.
            *
            * Deleting a draft costs a regenerable PDF. Deleting a sent one
            * destroys the only indexed copy of what that employer actually
            * received -- so the strip says which of the two this is, by name,
            * before the red button appears.
            */}
          {doomed ? (
            <div className={`ic-row-in shrink-0 px-4 py-3 border-b border-white/[0.09] ${
              doomedWasSent ? 'bg-rose-500/[0.12]' : 'bg-white/[0.05]'
            }`}>
              <p className="text-[12.5px] text-[#f5f5f7]">
                Delete the application to{' '}
                <span className="font-semibold">{doomed.company || doomed.subject}</span>?
              </p>
              <p className="text-[11.5px] text-[rgba(235,235,245,0.62)] pt-0.5">
                {doomedWasSent
                  ? `This one really went out${doomed.sent_at ? ` on ${doomed.sent_at.slice(0, 10)}` : ''}. Deleting it throws away the letter, the PDF and the record of what they received - the company stays marked as written to, so this does not re-open it for a second application.`
                  : 'A draft. The letter and its PDF go; nothing was ever sent, and it can be written again.'}
              </p>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => removeDocs([doomed.id])}
                  className="rounded-lg px-2.5 py-1 text-[12px] font-semibold bg-rose-500/20 text-rose-100 hover:bg-rose-500/30 cursor-pointer transition-colors"
                >
                  Delete it
                </button>
                <button
                  type="button"
                  onClick={() => setDocDoomed(null)}
                  className="rounded-lg px-2.5 py-1 text-[12px] text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] cursor-pointer transition-colors"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : null}

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {docs.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <FileText className="w-6 h-6 mx-auto mb-2 text-[rgba(235,235,245,0.32)]" />
              <p className="text-[13.5px] text-[rgba(235,235,245,0.62)]">
                Nothing has been written yet.
              </p>
              <p className="text-[12.5px] text-[rgba(235,235,245,0.42)]">
                Letters and dossiers are kept here, sent or not, so a dry run can be read afterwards.
              </p>
            </div>
          ) : (
            docs.map((d) => {
              const on = chosen?.id === d.id;
              return (
                // A row inside a row: the entry opens the application, the
                // trash throws it away. Two jobs cannot be one button, and a
                // button cannot live inside a button, so the outer element is
                // a div and the readable part keeps the click.
                <div
                  key={d.id}
                  className={`group relative border-b border-white/[0.07] last:border-0 transition-colors ${
                    on ? 'bg-white/[0.09]' : 'hover:bg-white/[0.04]'
                  } ${docDoomed === d.id ? 'ring-1 ring-inset ring-rose-400/40' : ''}`}
                >
                <button
                  type="button"
                  onClick={() => { setOpenDoc(d); setDocPart('letter'); }}
                  className="w-full text-left px-4 py-3 pr-10 cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[13.5px] font-semibold text-[#f5f5f7] truncate">
                      {d.company || d.subject || '(no subject)'}
                    </span>
                    <span
                      className={`shrink-0 text-[11px] font-semibold px-2 py-[2px] rounded-full ${
                        d.sent_at && !d.dry_run
                          ? 'bg-emerald-400/15 text-emerald-200'
                          : 'bg-white/[0.08] text-[rgba(235,235,245,0.62)]'
                      }`}
                    >
                      {d.sent_at && !d.dry_run ? 'Sent' : 'Draft'}
                    </span>
                    {d.language ? (
                      <span className="shrink-0 px-1 rounded text-[10px] uppercase tracking-wide bg-white/[0.08] text-[rgba(235,235,245,0.62)]">
                        {d.language}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-[12.5px] text-[rgba(235,235,245,0.52)] truncate">
                    {d.email || 'no address'}
                  </p>
                  <p className="text-[11.5px] text-[rgba(235,235,245,0.36)] truncate">
                    {(d.sent_at || d.created_at || '').slice(0, 16).replace('T', ' ')}
                    {d.pdf_path ? ' - CV and letter attached' : ''}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setDocDoomed(docDoomed === d.id ? null : d.id)}
                  title="Delete this application"
                  className="absolute top-2.5 right-2 rounded-lg p-1.5 text-[rgba(235,235,245,0.42)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-rose-500/20 hover:text-rose-200 cursor-pointer transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                </div>
              );
            })
          )}
          </div>
        </div>

        <div className="ic-glass rounded-2xl flex-1 min-h-0 flex flex-col overflow-hidden">
          {!chosen ? (
            <div className="flex-1 flex items-center justify-center text-[13px] text-[rgba(235,235,245,0.42)]">
              Pick an application to read it.
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-white/[0.07]">
                <p className="text-[13.5px] font-semibold text-[#f5f5f7]">{chosen.subject}</p>
                <p className="text-[12.5px] text-[rgba(235,235,245,0.52)]">
                  To {chosen.email || 'nobody yet'}
                  {chosen.contact_name ? ` - ${chosen.contact_name}` : ''}
                  {chosen.sent_at && !chosen.dry_run
                    ? ` - sent ${chosen.sent_at.slice(0, 16).replace('T', ' ')}`
                    : ' - not sent'}
                </p>
                <div className="flex gap-1.5 pt-2">
                  {([['letter', 'Cover letter'], ['cv', 'CV'], ['pack', 'Both, as one PDF']] as const)
                    .map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setDocPart(id)}
                        className={`rounded-lg px-2.5 py-1 text-[12px] cursor-pointer transition-colors ${
                          docPart === id
                            ? 'bg-white/[0.14] text-[#f5f5f7]'
                            : 'bg-white/[0.05] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.09]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  <a
                    href={`${BACKEND}/api/outreach/documents/${chosen.id}/pdf?part=${docPart}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto rounded-lg px-2.5 py-1 text-[12px] bg-white/[0.05] text-[rgba(235,235,245,0.62)] hover:bg-white/[0.09] cursor-pointer transition-colors"
                  >
                    Open in a tab
                  </a>
                  <button
                    type="button"
                    onClick={() => setDocDoomed(chosen.id)}
                    title="Delete this application"
                    className="rounded-lg px-2.5 py-1 text-[12px] bg-white/[0.05] text-[rgba(235,235,245,0.62)] hover:bg-rose-500/20 hover:text-rose-200 cursor-pointer transition-colors inline-flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </div>

              {/*
                * The browser's own PDF viewer in an iframe. A bundled renderer
                * would be another megabyte of JavaScript to show a file the
                * browser already knows how to show, and this one prints.
                */}
              <iframe
                key={`${chosen.id}-${docPart}`}
                title="Application PDF"
                src={`${BACKEND}/api/outreach/documents/${chosen.id}/pdf?part=${docPart}#view=FitH`}
                className="flex-1 min-h-[320px] w-full bg-[rgba(10,11,14,0.6)]"
              />

              <details className="shrink-0 border-t border-white/[0.07] px-4 py-2">
                <summary className="text-[12.5px] text-[rgba(235,235,245,0.62)] cursor-pointer">
                  The email itself
                </summary>
                <pre className="mt-2 max-h-[180px] overflow-y-auto custom-scrollbar whitespace-pre-wrap text-[12.5px] leading-relaxed text-[rgba(235,235,245,0.82)] font-sans">
                  {chosen.body}
                </pre>
              </details>
            </>
          )}
        </div>
      </div>
    );
  };

  const active = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  return (
    <div className="flex-1 w-full max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-150">
      {/* The shell is glass too, and deliberately thinner than the panels
        * inside it: two sheets of the same darkness stacked make an opaque
        * wall, and the point of the wallpaper is that it is still there. */}
      <div className="ic-shell relative w-full h-full rounded-[22px] overflow-hidden flex">

        {/*
          * The inner menu.
          *
          * Four sections rather than four modals: the dashboard counts the
          * rows the prospects table lists, the pipeline narrates what is being
          * done to them and the documents are what came out. Leaving the page
          * to see the next step would mean leaving the thing being worked on.
          */}
        <nav className="hidden md:flex w-[248px] shrink-0 flex-col border-r border-white/10 bg-[rgba(10,11,14,0.35)]">
          <div className="px-5 py-3.5 border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#0a84ff]/15 text-[#0a84ff] flex items-center justify-center shrink-0">
                <Send className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="ic-title text-[15px] text-[#f5f5f7] truncate">Outreach</h3>
                <p className="ic-caption text-[11.5px] text-[rgba(235,235,245,0.52)] truncate">
                  {connected} of {Object.keys(caps).length || 6} services ready
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-2.5 space-y-1">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const on = s.id === section;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 flex items-start gap-3 cursor-pointer transition-colors ${
                    on ? 'bg-white/[0.1]' : 'hover:bg-white/[0.05]'
                  }`}
                >
                  <Icon
                    className={`w-[18px] h-[18px] mt-[1px] shrink-0 ${
                      on ? 'text-[#0a84ff]' : 'text-[rgba(235,235,245,0.52)]'
                    }`}
                  />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold tracking-[-0.01em] text-[#f5f5f7]">
                      {s.label}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-[rgba(235,235,245,0.45)]">
                      {s.hint}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="px-4 py-3 border-t border-white/10">
            <p className="text-[11.5px] leading-snug text-[rgba(235,235,245,0.42)]">
              Keys live in the project's .env file. This page reports whether one is
              set, never what it says.
            </p>
          </div>
        </nav>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between gap-3 shrink-0">
            <div className="min-w-0">
              <h3 className="ic-title text-[16px] text-[#f5f5f7] truncate">{active.label}</h3>
              <p className="ic-caption text-[12px] text-[rgba(235,235,245,0.62)] truncate">
                {active.hint}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => { loadOverview(); loadProspects(page, query); loadDocuments(); }}
                className="ic-fill w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
                title="Refresh"
              >
                {busy
                  ? <Loader2 className="w-4 h-4 animate-spin text-[rgba(235,235,245,0.62)]" />
                  : <RefreshCw className="w-4 h-4 text-[rgba(235,235,245,0.62)]" />}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="ic-fill w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
                title="Close"
              >
                <X className="w-4 h-4 text-[rgba(235,235,245,0.62)]" />
              </button>
            </div>
          </div>

          {/* The menu is a column on a desktop and a row on a phone: four
            * labels fit across a phone, and the hints do not, so below `md`
            * they are dropped rather than wrapped. */}
          <div className="md:hidden flex items-center gap-1.5 px-4 py-2 border-b border-white/10 overflow-x-auto no-scrollbar">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-semibold cursor-pointer ${
                  s.id === section ? 'bg-white/[0.12] text-[#f5f5f7]' : 'text-[rgba(235,235,245,0.62)]'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {error ? (
            <div className="mx-4 mt-3 rounded-xl bg-rose-400/12 border border-rose-300/20 px-3.5 py-2 flex items-center justify-between gap-3">
              <span className="text-[12.5px] text-rose-100">{error}</span>
              <button
                type="button"
                onClick={() => setError('')}
                className="text-rose-200/70 hover:text-rose-100 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : null}

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
            {sectionBody()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OutreachPage;
