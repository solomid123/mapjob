import { API_BASE } from '../services/apiBase';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash, Clock, ExternalLink, FileText, RefreshCw, Search } from 'lucide-react';
import {
  canDisplayPdfInline, documentUrl, fetchApplications, fetchDocuments,
  type ApplicationRecord, type TailoredDocument,
} from '../services/tailorApi';

/**
 * What was actually sent.
 *
 * The apply panel only knows about the run it is watching and forgets even that
 * when it closes, so "did that one go through, and with which CV?" had no
 * answer anywhere. This is that answer: the ledger on the left, the exact PDF
 * that went with it on the right.
 *
 * Applications made before tailoring existed have no documents of their own.
 * They say so and show the standard CV, rather than showing it silently and
 * letting it be mistaken for something written for that employer.
 *
 * Two rules the hard way:
 *
 * - This is a record of applications, not of attempts. Of 86 runs in the
 *   ledger, 58 were cancelled, errored or never reached a form; showing them
 *   all made a page of "Untitled role" that buried the 28 that went out. Only
 *   the ones that were sent are listed, with a switch for the rest.
 *
 * - Nothing here may put a file in Downloads. A PDF in an iframe is downloaded
 *   rather than displayed by a browser set to "always download PDF files", so
 *   simply opening this tab saved three copies of the CV. The frame shows the
 *   PDF where the browser will render one -- it is the document that was sent
 *   -- and the HTML it was printed from where the browser would save it
 *   instead.
 */

const PANEL = 'ic-panel rounded-[20px] bg-[rgba(16,18,22,0.72)] backdrop-blur-2xl';

const BACKEND_URL = API_BASE;

function outcomeLook(record: ApplicationRecord) {
  if (record.confirmed) return { icon: CheckCircle2, tint: 'text-emerald-400', label: 'Confirmed' };
  if (record.sent) return { icon: Clock, tint: 'text-amber-300', label: 'Sent · unconfirmed' };
  return { icon: CircleSlash, tint: 'text-[rgba(235,235,245,0.35)]', label: record.outcome || 'Not sent' };
}

function stamp(record: ApplicationRecord): string {
  if (!record.at) return '';
  const date = new Date(record.at);
  if (Number.isNaN(date.getTime())) return record.at;
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function HistoryPane() {
  const [records, setRecords] = useState<ApplicationRecord[]>([]);
  const [docs, setDocs] = useState<TailoredDocument[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [kind, setKind] = useState<'cv' | 'letter'>('cv');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** Sent applications only, until asked for the attempts as well. */
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [applications, documents] = await Promise.all([
        fetchApplications(200),
        fetchDocuments().catch(() => [] as TailoredDocument[]),
      ]);
      setRecords(applications);
      setDocs(documents);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the application history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const byJob = useMemo(() => {
    const map = new Map<string, TailoredDocument>();
    docs.forEach((d) => map.set(d.job_id, d));
    return map;
  }, [docs]);

  /**
   * An application counts as sent if the run said so, or if the outcome the
   * ledger recorded is one of the two that mean a form went in. A cancelled
   * run, an error and a "not_sent" are attempts, and attempts live behind the
   * switch.
   */
  const wentOut = (r: ApplicationRecord) =>
    Boolean(r.sent || r.confirmed) || ['applied', 'sent_unconfirmed'].includes(r.outcome || '');

  const sentCount = useMemo(() => records.filter(wentOut).length, [records]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = showAll ? records : records.filter(wentOut);
    return needle
      ? base.filter((r) => `${r.company} ${r.job_title}`.toLowerCase().includes(needle))
      : base;
  }, [records, query, showAll]);

  const key = (record: ApplicationRecord) => `${record.job_id || record.url}-${record.epoch}`;
  const current = shown.find((r) => key(r) === selected) || shown[0];
  const doc = current?.job_id ? byJob.get(current.job_id) : undefined;

  // The PDF is what the employer received, down to the page breaks, so that is
  // what this shows -- the same preview as the tailoring pane, not a web page
  // that happens to have the same words on it.
  //
  // The HTML it was printed from is the understudy, for a browser set to
  // "always download PDF files": there, a PDF in a frame lands in Downloads and
  // leaves a white rectangle, which is how three copies of the CV got saved by
  // opening this tab. `inline=1` is still needed on the standard CV even where
  // PDFs do display, or it is sent as an attachment and the frame gives up.
  const showsPdf = canDisplayPdfInline();
  const htmlUrl = documentUrl(kind === 'cv' ? doc?.files?.cv_html : doc?.files?.letter_html);
  const pdfUrl = doc
    ? documentUrl(kind === 'cv' ? doc.files?.cv_pdf : doc.files?.letter_pdf)
    : `${BACKEND_URL}/cv.pdf?inline=1`;
  const previewUrl = htmlUrl || (showsPdf ? pdfUrl : undefined);

  return (
    <div className="h-full w-full flex gap-3 min-h-0">

      <div className={`${PANEL} w-full md:w-[380px] xl:w-[420px] shrink-0 flex flex-col min-h-0 overflow-hidden`}>
        <div className="shrink-0 px-3.5 pt-3 pb-2.5 border-b border-white/[0.09]">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-medium text-[#f5f5f7]">Applied</h2>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="ml-auto mr-1 px-2.5 h-7 rounded-full text-[11.5px] text-[rgba(235,235,245,0.55)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
              title={showAll
                ? 'Show only the applications that were sent'
                : 'Also show runs that were cancelled or did not reach a form'}
            >
              {showAll ? `Sent only (${sentCount})` : 'Show attempts'}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="p-1.5 -mr-1 rounded-full text-[rgba(235,235,245,0.5)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 cursor-pointer"
              title="Read the ledger again"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2 px-2.5 h-8 rounded-full bg-white/[0.06] border border-white/[0.08]">
            <Search className="w-3.5 h-3.5 text-[rgba(235,235,245,0.4)] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by employer or role"
              className="flex-1 min-w-0 bg-transparent text-[12.5px] text-[#f5f5f7] placeholder:text-[rgba(235,235,245,0.32)] focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
          {error && (
            <p role="alert" className="m-2 rounded-xl bg-rose-500/12 border border-rose-400/20 px-3 py-2 text-[12px] text-rose-200">
              {error}
            </p>
          )}
          {!loading && shown.length === 0 && !error && (
            <p className="px-2 py-6 text-[12.5px] leading-relaxed text-[rgba(235,235,245,0.45)]">
              {showAll || records.length === 0
                ? 'Nothing has been applied to yet. Every run lands here afterwards — the ones that went through and the ones that did not.'
                : 'No application has gone out yet. Runs that were cancelled or never reached a form are under “Show attempts”.'}
            </p>
          )}
          {shown.map((record) => {
            const look = outcomeLook(record);
            const Icon = look.icon;
            const on = key(record) === (current ? key(current) : '');
            const has = record.job_id ? byJob.has(record.job_id) : false;
            return (
              <button
                key={key(record)}
                type="button"
                onClick={() => setSelected(key(record))}
                className={`w-full text-left px-3 py-2.5 rounded-[14px] border transition-colors duration-150 cursor-pointer ${
                  on ? 'bg-white/[0.09] border-white/[0.14]' : 'bg-transparent border-transparent hover:bg-white/[0.05]'
                }`}
              >
                <div className="flex items-start gap-2">
                  <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${look.tint}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-[#f5f5f7] truncate">{record.job_title || 'Untitled role'}</p>
                    <p className="text-[11.5px] text-[rgba(235,235,245,0.5)] truncate">{record.company}</p>
                    <div className="mt-1 flex items-center gap-2 text-[10.5px] text-[rgba(235,235,245,0.38)]">
                      <span>{stamp(record)}</span>
                      {record.engine && <span>{record.engine}</span>}
                      {record.dry_run && <span className="text-amber-200/70">rehearsal</span>}
                      {has && <FileText className="w-3 h-3 text-emerald-400/70" />}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* THE PDF. An iframe, because the browser already has a PDF viewer and a
        * bundled one would be a megabyte of JavaScript to show a file the
        * machine can open by itself. */}
      <div className={`${PANEL} hidden md:flex flex-1 min-w-0 flex-col min-h-0 overflow-hidden`}>
        {!current ? (
          <div className="flex-1 grid place-items-center p-8 text-center">
            <p className="text-[13px] text-[rgba(235,235,245,0.45)] max-w-sm leading-relaxed">
              Choose an application to see exactly what was sent with it.
            </p>
          </div>
        ) : (
          <>
            <div className="shrink-0 px-4 pt-3.5 pb-3 border-b border-white/[0.09]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[15px] text-[#f5f5f7] truncate">{current.job_title}</h3>
                  <p className="text-[12px] text-[rgba(235,235,245,0.5)] truncate">
                    {current.company} · {outcomeLook(current).label}
                  </p>
                </div>
                {current.url && (
                  <a
                    href={current.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="shrink-0 px-2.5 h-8 rounded-full text-[12px] text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Listing
                  </a>
                )}
              </div>

              <div className="mt-2.5 flex items-center justify-between gap-1">
                <div className="flex items-center gap-1 min-w-0">
                  {(['cv', 'letter'] as const).map((which) => (
                    <button
                      key={which}
                      type="button"
                      disabled={!doc && which === 'letter'}
                      onClick={() => setKind(which)}
                      className={`px-3 h-7 rounded-full text-[12px] transition-colors duration-200 ${
                        kind === which
                          ? 'bg-white/[0.12] text-[#f5f5f7] cursor-pointer'
                          : !doc && which === 'letter'
                            ? 'text-[rgba(235,235,245,0.22)] cursor-not-allowed'
                            : 'text-[rgba(235,235,245,0.48)] hover:text-[#f5f5f7] hover:bg-white/[0.06] cursor-pointer'
                      }`}
                    >
                      {which === 'cv' ? 'CV' : 'Cover letter'}
                    </button>
                  ))}
                  <span className="ml-2 text-[11px] text-[rgba(235,235,245,0.38)] truncate">
                    {doc
                      ? `Tailored for this advert · ${doc.language?.toUpperCase()} · ${doc.bullets_kept} of ${doc.bullets_available} bullets`
                      : 'Standard CV — this application was made before tailoring existed'}
                  </span>
                </div>
                {previewUrl && (
                  <a
                    href={previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2.5 h-7 rounded-full text-[11.5px] font-medium text-[rgba(235,235,245,0.65)] hover:text-[#f5f5f7] hover:bg-white/[0.08] transition-colors duration-200 flex items-center gap-1.5 shrink-0"
                    title="Open document in a new tab to view or print (Ctrl+P)"
                  >
                    <ExternalLink className="w-3 h-3" /> Open / Print
                  </a>
                )}
              </div>
            </div>

            {current.message && (
              <p className="mx-4 mt-3 rounded-xl bg-white/[0.05] border border-white/[0.07] px-3 py-2 text-[11.5px] leading-relaxed text-[rgba(235,235,245,0.62)] max-h-24 overflow-y-auto custom-scrollbar">
                {current.message}
              </p>
            )}

            <div className="flex-1 min-h-0 p-3">
              {previewUrl ? (
                <iframe
                  key={`${key(current)}-${kind}`}
                  src={previewUrl}
                  title="The document that was sent"
                  className="w-full h-full rounded-[14px] border border-white/[0.08] bg-white"
                />
              ) : (
                // This browser downloads PDFs instead of showing them, and this
                // application predates the HTML documents. Opening it is the
                // person's decision, not something that happens to them.
                <div className="h-full grid place-items-center rounded-[14px] border border-white/[0.08] bg-white/[0.03] p-8 text-center">
                  <div className="max-w-xs space-y-3">
                    <p className="text-[13px] leading-relaxed text-[rgba(235,235,245,0.55)]">
                      Your browser saves PDFs rather than showing them, so this one is
                      not opened for you.
                    </p>
                    <a
                      href={pdfUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 px-3 h-8 rounded-full bg-white/[0.1] hover:bg-white/[0.16] text-[12.5px] text-[#f5f5f7] transition-colors duration-200"
                    >
                      <ExternalLink className="w-3.5 h-3.5" /> Open the PDF
                    </a>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
