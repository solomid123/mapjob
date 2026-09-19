import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Briefcase, Building2, Check, FileText, Languages,
  Loader2, NotebookPen, Paperclip, Sparkles, Trash2, X,
} from 'lucide-react';

/**
 * What the copilot is told about an interview before it starts.
 *
 * Everything here is optional except the role: an answer improves with each
 * field, but a session should never be blocked behind a form when the call is
 * about to start.
 */
export interface InterviewContext {
  jobTitle: string;
  company: string;
  jobDescription: string;
  notes: string;
  lang: 'fr' | 'en';
  docs: ParsedDoc[];
}

/** One document the employer asked to be read, already turned into text. */
export interface ParsedDoc {
  filename: string;
  chars: number;
  pages: number;
  truncated: boolean;
  text: string;
}

export const emptyInterviewContext = (): InterviewContext => ({
  jobTitle: '',
  company: '',
  jobDescription: '',
  notes: '',
  lang: 'fr',
  docs: [],
});

/** The documents as one blob for the prompt, each under its own filename. */
export const documentsText = (ctx: InterviewContext): string =>
  ctx.docs.map((d) => `--- ${d.filename} ---\n${d.text}`).join('\n\n');

interface InterviewSetupProps {
  backend: string;
  onStart: (ctx: InterviewContext) => void;
  onCancel: () => void;
}

type StepId = 'role' | 'company' | 'description' | 'lang' | 'notes' | 'docs';

const STEPS: {
  id: StepId;
  icon: React.ComponentType<{ className?: string }>;
  question: string;
  hint: string;
  optional: boolean;
}[] = [
  {
    id: 'role',
    icon: Briefcase,
    question: 'What role are you interviewing for?',
    hint: 'The exact title on the posting. Every answer gets aimed at it.',
    optional: false,
  },
  {
    id: 'company',
    icon: Building2,
    question: 'Which company?',
    hint: 'An answer that names their own product beats a generically good one.',
    optional: true,
  },
  {
    id: 'description',
    icon: FileText,
    question: 'Paste the job description',
    hint: 'Their words are the vocabulary the interviewer will use.',
    optional: true,
  },
  {
    id: 'lang',
    icon: Languages,
    question: 'Which language will the interview be in?',
    hint: 'Transcription and answers both follow this.',
    optional: false,
  },
  {
    id: 'notes',
    icon: NotebookPen,
    question: 'Anything else worth knowing?',
    hint: 'Who you are meeting, which round, a project to push, a salary floor.',
    optional: true,
  },
  {
    id: 'docs',
    icon: Paperclip,
    question: 'Did they send anything to read first?',
    hint: 'PDF, DOCX, TXT or MD. It is read once and kept for this session only.',
    optional: true,
  },
];

export const InterviewSetup: React.FC<InterviewSetupProps> = ({ backend, onStart, onCancel }) => {
  const [step, setStep] = useState(0);
  const [ctx, setCtx] = useState<InterviewContext>(emptyInterviewContext);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // The cursor lands in the field on every step: this is a form you should be
  // able to fill in with the keyboard alone, at speed, minutes before a call.
  useEffect(() => {
    const t = setTimeout(() => fieldRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [step]);

  const value =
    current.id === 'role' ? ctx.jobTitle
      : current.id === 'company' ? ctx.company
        : current.id === 'description' ? ctx.jobDescription
          : current.id === 'notes' ? ctx.notes
            : '';

  const setValue = (v: string) => {
    setCtx((c) => ({
      ...c,
      ...(current.id === 'role' ? { jobTitle: v }
        : current.id === 'company' ? { company: v }
          : current.id === 'description' ? { jobDescription: v }
            : current.id === 'notes' ? { notes: v }
              : {}),
    }));
  };

  /** A required step with nothing in it is the only thing that blocks. */
  const blocked = !current.optional && current.id === 'role' && !ctx.jobTitle.trim();

  const back = useCallback(() => {
    if (step === 0) onCancel();
    else setStep((s) => s - 1);
  }, [step, onCancel]);

  const next = useCallback(() => {
    if (blocked) return;
    if (isLast) onStart(ctx);
    else setStep((s) => s + 1);
  }, [blocked, isLast, onStart, ctx]);

  const parseFiles = useCallback(async (files: FileList | File[]) => {
    setUploadError('');
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append('file', file);
        const r = await fetch(`${backend}/api/interview/context/parse`, { method: 'POST', body });
        if (!r.ok) {
          // FastAPI puts the reason in `detail`, and it is written for a person.
          let why = `Could not read ${file.name}`;
          try { why = (await r.json()).detail || why; } catch { /* not JSON */ }
          setUploadError(why);
          continue;
        }
        const doc: ParsedDoc = await r.json();
        setCtx((c) => ({ ...c, docs: [...c.docs.filter((d) => d.filename !== doc.filename), doc] }));
      }
    } catch {
      setUploadError('The reader is offline — start api_server.py, or skip this step.');
    } finally {
      setUploading(false);
    }
  }, [backend]);

  const Icon = current.icon;

  return (
    <div
      className="flex-1 w-full flex flex-col h-[calc(100vh-80px)] overflow-hidden animate-in fade-in duration-200"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); back(); }
      }}
    >
      {/* Progress: one segment per question, filled as they are passed. It is
          the only thing on screen that says how much is left, so it stays at
          the top rather than moving with the card. */}
      <div className="w-full max-w-[760px] mx-auto px-6 pt-6 shrink-0">
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1 flex-1 rounded-full transition-all duration-300 ease-apple-out ${
                i < step ? 'bg-[#0a84ff]' : i === step ? 'bg-[#0a84ff]/70' : 'bg-white/15'
              }`}
            />
          ))}
        </div>
        <div className="mt-2.5 flex items-center justify-between">
          <span className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
            New session · {step + 1} of {STEPS.length}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="ic-caption text-[12px] font-medium text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition-colors duration-200 cursor-pointer flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
        </div>
      </div>

      {/* The question itself, one per screen, with nothing beside it. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full max-w-[760px] mx-auto px-6 py-8">
          <div key={current.id} className="animate-airbnb-pop">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-full bg-[#0a84ff]/15 text-[#0a84ff] flex items-center justify-center shrink-0">
                <Icon className="w-[18px] h-[18px]" />
              </span>
              {current.optional && (
                <span className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                  Optional
                </span>
              )}
            </div>

            <h1 className="ic-title mt-4 text-[32px] sm:text-[38px] leading-[1.08] text-[#f5f5f7]">
              {current.question}
            </h1>
            <p className="ic-body mt-2.5 text-[15px] text-[rgba(235,235,245,0.62)]">
              {current.hint}
            </p>

            <div className="mt-7">
              {(current.id === 'role' || current.id === 'company') && (
                <input
                  ref={fieldRef as React.RefObject<HTMLInputElement>}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } }}
                  placeholder={current.id === 'role' ? 'Ingénieur Mécanique R&D' : 'Technip Energies'}
                  className="w-full bg-transparent border-0 border-b border-white/15 focus:border-[#0a84ff] outline-none px-0 py-3 text-[24px] sm:text-[28px] ic-title text-[#f5f5f7] placeholder:text-white/20 transition-colors duration-200"
                />
              )}

              {(current.id === 'description' || current.id === 'notes') && (
                <textarea
                  ref={fieldRef as React.RefObject<HTMLTextAreaElement>}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  // Enter is a newline here: the whole point of the field is
                  // several lines of pasted text. Cmd/Ctrl+Enter advances.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); next(); }
                  }}
                  rows={current.id === 'description' ? 10 : 5}
                  placeholder={
                    current.id === 'description'
                      ? 'Paste the posting here — responsibilities, requirements, the lot.'
                      : 'Second round with the head of engineering. They care about fatigue analysis.'
                  }
                  className="ic-tile is-static w-full rounded-2xl px-4 py-3.5 text-[15px] leading-relaxed ic-body text-[#f5f5f7] placeholder:text-white/25 outline-none focus:shadow-[0_0_0_2px_#0a84ff] resize-none transition-shadow duration-200"
                />
              )}

              {current.id === 'lang' && (
                <div className="grid grid-cols-2 gap-3 max-w-[420px]">
                  {([
                    { id: 'fr' as const, name: 'Français', sub: 'fr-FR' },
                    { id: 'en' as const, name: 'English', sub: 'en-US' },
                  ]).map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => setCtx((c) => ({ ...c, lang: l.id }))}
                      className={`ic-tile ${ctx.lang === l.id ? 'is-selected' : ''} rounded-2xl px-4 py-4 text-left cursor-pointer`}
                    >
                      <span className="block ic-title text-[17px] text-[#f5f5f7]">{l.name}</span>
                      <span className="block ic-caption text-[12px] text-[rgba(235,235,245,0.42)] mt-0.5">{l.sub}</span>
                    </button>
                  ))}
                </div>
              )}

              {current.id === 'docs' && (
                <div>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      if (e.dataTransfer.files?.length) void parseFiles(e.dataTransfer.files);
                    }}
                    onClick={() => fileRef.current?.click()}
                    className={`ic-tile is-static rounded-2xl px-6 py-10 text-center cursor-pointer transition-shadow duration-200 ${
                      dragging ? 'shadow-[0_0_0_2px_#0a84ff]' : ''
                    }`}
                  >
                    <input
                      ref={fileRef}
                      type="file"
                      multiple
                      accept=".pdf,.docx,.txt,.md,.csv,.rtf"
                      className="hidden"
                      onChange={(e) => { if (e.target.files?.length) void parseFiles(e.target.files); e.target.value = ''; }}
                    />
                    {uploading ? (
                      <span className="inline-flex items-center gap-2 ic-body text-[15px] text-[rgba(235,235,245,0.62)]">
                        <Loader2 className="w-4 h-4 animate-spin text-[#0a84ff]" /> Reading…
                      </span>
                    ) : (
                      <>
                        <Paperclip className="w-5 h-5 mx-auto text-[rgba(235,235,245,0.42)]" />
                        <p className="ic-body mt-2.5 text-[15px] text-[#f5f5f7]">
                          Drop a file here, or click to choose
                        </p>
                        <p className="ic-caption mt-1 text-[12px] text-[rgba(235,235,245,0.42)]">
                          PDF, DOCX, TXT, MD · up to 20 MB
                        </p>
                      </>
                    )}
                  </div>

                  {uploadError && (
                    <p className="ic-body mt-3 text-[13px] text-[#ff6b6b]">{uploadError}</p>
                  )}

                  {ctx.docs.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {ctx.docs.map((d) => (
                        <div
                          key={d.filename}
                          className="ic-tile is-static rounded-xl px-4 py-3 flex items-center gap-3"
                        >
                          <FileText className="w-4 h-4 text-[#0a84ff] shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="ic-body text-[14px] text-[#f5f5f7] truncate">{d.filename}</p>
                            <p className="ic-caption text-[11.5px] text-[rgba(235,235,245,0.42)]">
                              {d.pages ? `${d.pages} page${d.pages > 1 ? 's' : ''} · ` : ''}
                              {d.chars.toLocaleString()} characters read
                              {d.truncated ? ' · trimmed to the first 40,000' : ''}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCtx((c) => ({ ...c, docs: c.docs.filter((x) => x.filename !== d.filename) }));
                            }}
                            className="ic-fill w-7 h-7 rounded-full flex items-center justify-center cursor-pointer shrink-0"
                            title={`Forget ${d.filename}`}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-[rgba(235,235,245,0.62)]" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* What the copilot has, on the last step only: a session is about
                to start on this, and it should not be a surprise. */}
            {isLast && (
              <div className="mt-8 ic-tile is-static rounded-2xl px-5 py-4">
                <p className="ic-caption text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(235,235,245,0.42)]">
                  The copilot will know
                </p>
                <ul className="mt-2.5 space-y-1.5">
                  {[
                    ctx.jobTitle && `Role — ${ctx.jobTitle}`,
                    ctx.company && `Company — ${ctx.company}`,
                    ctx.jobDescription && `Job description — ${ctx.jobDescription.trim().length.toLocaleString()} characters`,
                    ctx.notes && `Your notes — ${ctx.notes.trim().length.toLocaleString()} characters`,
                    ctx.docs.length > 0 && `${ctx.docs.length} document${ctx.docs.length > 1 ? 's' : ''} — ${ctx.docs.reduce((n, d) => n + d.chars, 0).toLocaleString()} characters`,
                    `Interview in ${ctx.lang === 'fr' ? 'French' : 'English'}`,
                  ].filter(Boolean).map((line) => (
                    <li key={String(line)} className="ic-body text-[14px] text-[#f5f5f7] flex items-start gap-2">
                      <Check className="w-3.5 h-3.5 mt-[3px] text-[#0a84ff] shrink-0 stroke-[2.5]" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Navigation, welded to the bottom so it is in the same place on every
          question and never has to be hunted for. */}
      <div className="shrink-0 w-full max-w-[760px] mx-auto px-6 pb-7 pt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={back}
          className="ic-press px-4 py-2.5 rounded-full flex items-center gap-1.5 cursor-pointer ic-body text-[14px] font-medium text-[#f5f5f7]"
        >
          <ArrowLeft className="w-4 h-4" />
          {step === 0 ? 'Back to jobs' : 'Back'}
        </button>

        <div className="ml-auto flex items-center gap-3">
          {current.optional && !value.trim() && !(current.id === 'docs' && ctx.docs.length > 0) && (
            <button
              type="button"
              onClick={next}
              className="ic-body text-[14px] font-medium text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7] transition-colors duration-200 cursor-pointer"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            onClick={next}
            disabled={blocked}
            className="px-6 py-2.5 rounded-full bg-[#0a84ff] hover:bg-[#3395ff] disabled:opacity-40 disabled:hover:bg-[#0a84ff] text-white ic-body text-[14px] font-semibold flex items-center gap-2 cursor-pointer disabled:cursor-not-allowed transition-colors duration-200"
          >
            {isLast && <Sparkles className="w-4 h-4" />}
            {isLast ? 'Start session' : 'Continue'}
            {!isLast && <ArrowRight className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};
