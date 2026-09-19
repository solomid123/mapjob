import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Building2, FileText, Loader2, Plus,
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
  dry_run: number;
  sent_at: string | null;
  company?: string;
  contact_name?: string;
  email?: string;
  created_at: string;
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
  { id: 'pipeline', label: 'Pipeline', icon: RefreshCw, hint: 'What the engine is doing, live' },
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
  <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] px-4 py-3.5">
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

export const OutreachPage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [section, setSection] = useState<Section>('dashboard');
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
  const [engine, setEngine] = useState<'fast' | 'deep' | 'people'>('fast');
  const [hunting, setHunting] = useState(false);
  const consoleRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    loadOverview();
    loadDocuments();
    fetch(`${BACKEND}/api/outreach/events?limit=200`)
      .then((r) => r.json())
      .then((d) => setEvents(d.events || []))
      .catch(() => undefined);
  }, [loadOverview, loadDocuments]);

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
    if (fast && !hunt.city.trim()) {
      setError('Name a city to sweep.');
      return;
    }
    if (!fast && !hunt.profession.trim() && !hunt.company.trim()) {
      setError('Say what role you are looking for, or name a company.');
      return;
    }
    setError('');
    setHunting(true);
    const route = engine === 'fast' ? 'harvest' : engine === 'people' ? 'contacts' : 'discover';
    try {
      const res = await fetch(`${BACKEND}/api/outreach/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fast
          ? { city: hunt.city, keyword: hunt.keyword, limit: hunt.limit }
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

          <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] px-4 py-3">
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

          <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] px-4 py-3">
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
          <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] p-3.5">
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
                    : 'A few employers, researched down to whatever mailbox they publish'}
              </span>

              {/* The choice is breadth or depth, so it is one control, not a
                  settings page. */}
              <div className="ml-auto flex rounded-lg bg-white/[0.06] border border-white/[0.09] p-0.5">
                {([
                  ['fast', 'Sweep', 'Hundreds of published addresses. Free.'],
                  ['deep', 'Research', 'Whatever mailbox the company publishes.'],
                  ['people', 'People', 'Finds the person, builds their address from the company naming pattern, proves it by SMTP. Slowest and dearest.'],
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
                    max={engine === 'fast' ? 800 : 20}
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
                          : engine === 'people' ? 'Find people' : 'Find leads'
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
            <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] p-3.5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
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

          <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] overflow-hidden">
            <div className="hidden md:grid grid-cols-[1.4fr_1.2fr_1.4fr_0.7fr_76px] gap-3 px-4 py-2.5 border-b border-white/[0.09] text-[11.5px] uppercase tracking-wide text-[rgba(235,235,245,0.52)]">
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
                  className="grid grid-cols-1 md:grid-cols-[1.4fr_1.2fr_1.4fr_0.7fr_76px] gap-1 md:gap-3 px-4 py-2.5 border-b border-white/[0.07] last:border-0 hover:bg-white/[0.04] transition-colors"
                >
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
                        : 'no address yet'}
                    </span>
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

    if (section === 'pipeline') {
      return (
        <div
          ref={consoleRef}
          className="ic-panel rounded-2xl bg-[rgba(10,11,14,0.86)] p-4 h-full overflow-y-auto custom-scrollbar font-mono text-[12.5px] leading-relaxed"
        >
          {events.length === 0 ? (
            <p className="text-[rgba(235,235,245,0.42)]">
              Waiting for the first run. This console is live: every step writes here as it happens.
            </p>
          ) : (
            events.map((ev) => (
              <div key={ev.id} className="flex gap-2.5">
                <span className="text-[rgba(235,235,245,0.32)] tabular-nums shrink-0">
                  {ev.created_at.slice(11, 19)}
                </span>
                <span className="text-sky-300/80 shrink-0 w-[84px] truncate">{ev.phase}</span>
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
      );
    }

    return (
      <div className="ic-panel rounded-2xl bg-[rgba(16,18,22,0.72)] overflow-hidden">
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
          docs.map((d) => (
            <div key={d.id} className="px-4 py-3 border-b border-white/[0.07] last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold text-[#f5f5f7] truncate">
                  {d.subject || '(no subject)'}
                </span>
                <span
                  className={`shrink-0 text-[11px] font-semibold px-2 py-[2px] rounded-full ${
                    d.sent_at && !d.dry_run
                      ? 'bg-emerald-400/15 text-emerald-200'
                      : 'bg-white/[0.08] text-[rgba(235,235,245,0.62)]'
                  }`}
                >
                  {d.sent_at && !d.dry_run ? 'Sent' : 'Dry run'}
                </span>
              </div>
              <p className="text-[12.5px] text-[rgba(235,235,245,0.52)]">
                {d.company || 'Unknown company'}
                {d.email ? ' - ' + d.email : ''}
                {d.pdf_path ? ' - dossier attached' : ''}
              </p>
            </div>
          ))
        )}
      </div>
    );
  };

  const active = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  return (
    <div className="flex-1 w-full max-w-[1760px] mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-150">
      <div className="ic-tile is-static relative w-full h-full rounded-[22px] overflow-hidden flex">

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
