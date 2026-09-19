import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Building2, FileText, Loader2, Plus,
  RefreshCw, Search, Send, Trash2, Users, X,
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

  const removeProspect = async (id: number) => {
    await fetch(`${BACKEND}/api/outreach/prospects/${id}`, { method: 'DELETE' });
    await Promise.all([loadProspects(page, query), loadOverview()]);
  };

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
            <div className="hidden md:grid grid-cols-[1.4fr_1.2fr_1.4fr_0.7fr_40px] gap-3 px-4 py-2.5 border-b border-white/[0.09] text-[11.5px] uppercase tracking-wide text-[rgba(235,235,245,0.52)]">
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
                  className="grid grid-cols-1 md:grid-cols-[1.4fr_1.2fr_1.4fr_0.7fr_40px] gap-1 md:gap-3 px-4 py-2.5 border-b border-white/[0.07] last:border-0 hover:bg-white/[0.04] transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-[#f5f5f7] truncate">{p.company}</p>
                    <p className="text-[12px] text-[rgba(235,235,245,0.42)] truncate">{p.city || p.website}</p>
                  </div>
                  <div className="min-w-0 text-[13px] text-[rgba(235,235,245,0.62)] truncate">
                    {p.contact_name || '--'}
                    {p.role ? <span className="text-[rgba(235,235,245,0.42)]"> - {p.role}</span> : null}
                  </div>
                  <div className={`min-w-0 text-[13px] truncate ${EMAIL_TINT[p.email_status] || ''}`}>
                    {p.email || 'no address yet'}
                  </div>
                  <div><StagePill stage={p.stage} /></div>
                  <button
                    type="button"
                    onClick={() => removeProspect(p.id)}
                    title="Remove this prospect"
                    className="justify-self-start md:justify-self-end p-1.5 rounded-lg text-[rgba(235,235,245,0.42)] hover:text-rose-200 hover:bg-white/[0.08] transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
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
