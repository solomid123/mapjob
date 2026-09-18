import React from 'react';
import {
  X, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, ShieldAlert, ChevronRight,
} from 'lucide-react';
import type { BrowserApplyRun } from '../services/directAtsApi';
import { browserApplyScreenshotUrl, readableFailure } from '../services/directAtsApi';
import { progressPhrase, progressTrail, outcomeSentence } from '../services/applyProgress';

interface ApplyReviewPanelProps {
  run: BrowserApplyRun;
  /** True while the real submission is in flight, so the button cannot double-fire. */
  isSubmitting: boolean;
  onSubmitForReal: () => void;
  onClose: () => void;
}

/** The status where the form is filled and waiting on a human decision. */
const AWAITING_APPROVAL = 'DRY_RUN_COMPLETED';

/**
 * Status colour, in the dark palette the rest of the app moved to.
 *
 * These were `bg-emerald-50` / `bg-amber-50` / `bg-rose-50` on a white card --
 * the last surface still wearing the old light theme, which is exactly why
 * this panel looked like it belonged to a different product. Tints now, at the
 * same weight as the fills everywhere else: a wash of the hue over glass, a
 * hairline of it at the edge, and the text at full saturation so it still
 * carries at 13px.
 */
const EDGE_EMERALD = 'shadow-[inset_0_0_0_0.5px_rgba(52,211,153,0.28)]';
const EDGE_AMBER = 'shadow-[inset_0_0_0_0.5px_rgba(251,191,36,0.28)]';
const EDGE_SKY = 'shadow-[inset_0_0_0_0.5px_rgba(56,189,248,0.28)]';
const EDGE_ROSE = 'shadow-[inset_0_0_0_0.5px_rgba(251,113,133,0.28)]';

const TONE: Record<string, { wash: string; text: string; Icon: typeof CheckCircle2 }> = {
  APPLIED: { wash: `bg-emerald-400/10 ${EDGE_EMERALD}`, text: 'text-emerald-300', Icon: CheckCircle2 },
  SUBMITTED_UNVERIFIED: { wash: `bg-amber-400/10 ${EDGE_AMBER}`, text: 'text-amber-300', Icon: AlertTriangle },
  DRY_RUN_COMPLETED: { wash: `bg-sky-400/10 ${EDGE_SKY}`, text: 'text-sky-300', Icon: CheckCircle2 },
  NEEDS_CHECKPOINT: { wash: `bg-amber-400/10 ${EDGE_AMBER}`, text: 'text-amber-300', Icon: ShieldAlert },
  WAITING_FOR_HUMAN: { wash: `bg-amber-400/10 ${EDGE_AMBER}`, text: 'text-amber-300', Icon: ShieldAlert },
  FAILED: { wash: `bg-rose-400/10 ${EDGE_ROSE}`, text: 'text-rose-300', Icon: AlertTriangle },
  SKIPPED: { wash: 'bg-white/[0.06]', text: 'text-[rgba(235,235,245,0.62)]', Icon: CheckCircle2 },
};

const NEUTRAL_TONE = { wash: 'bg-white/[0.06]', text: 'text-[#f5f5f7]', Icon: Loader2 };

/**
 * Why a checkpoint happened, in the candidate's terms, plus what to do about
 * it. A CAPTCHA is never solved on their behalf: the browser is already open
 * on screen, so the honest instruction is to go and finish it there.
 */
const CHECKPOINT_HELP: Record<string, string> = {
  CAPTCHA:
    'The site asked for a "prove you are human" check. That is yours to answer, not something this app will fake. The browser window is open, so solve it there and the filled form is waiting underneath.',
  SUBMIT_BUTTON_NOT_FOUND:
    'The form was filled but no submit button could be found on the page, so it may be behind another step. The browser is open on that page.',
  NO_CV: 'No CV file was found on disk, so there was nothing to attach.',
  FORM_UNAVAILABLE:
    "The employer's own application form is down — their page says so and offers a reload, which this already tried. Nothing is wrong with your details or this listing. Worth another go in a few minutes.",
  NO_FORM_FOUND:
    'No application form could be reached on that page — it is probably behind a login, a redirect, or an apply button this app did not recognise. Nothing was filled and nothing was sent. The browser is open there if you want to carry on by hand.',
  INCOMPLETE_FORM:
    'Nothing was sent. The form has required fields that only you can answer, and submitting without them would just be rejected.',
  ALREADY_APPLIED: 'There is already an application from you on record for this listing.',
};

/**
 * Login walls, which are a one-time fix rather than a dead end. The browser
 * keeps a persistent profile, so signing in once in the window that is already
 * open carries the session into every future run on that site.
 */
function checkpointHelp(reason: string): string {
  if (reason.startsWith('LOGIN_REQUIRED:')) {
    const portal = reason.slice('LOGIN_REQUIRED:'.length) || 'That site';
    return `${portal} will not show the application form until you are signed in. The Chrome window is open on it — log in there once and this run can be retried. The session is remembered, so every later ${portal} job goes straight through.`;
  }
  return CHECKPOINT_HELP[reason] || '';
}

/**
 * The raw failure, folded away.
 *
 * It is worth keeping -- it is the only thing that says which driver call
 * died -- but it is worth keeping *closed*. A person watching their own
 * application run is not the audience for a stack frame.
 */
const TechnicalDetail: React.FC<{ trace: string }> = ({ trace }) => (
  <details className="group mt-2">
    <summary className="inline-flex items-center gap-1 cursor-pointer list-none text-[11.5px] font-medium text-[rgba(235,235,245,0.42)] hover:text-[rgba(235,235,245,0.62)] transition-colors duration-150">
      <ChevronRight className="w-3 h-3 transition-transform duration-200 group-open:rotate-90" />
      Technical detail
    </summary>
    <pre className="mt-2 max-h-40 overflow-auto custom-scrollbar rounded-xl bg-black/30 p-3 text-[11px] leading-relaxed text-[rgba(235,235,245,0.42)] whitespace-pre-wrap break-words font-mono">
      {trace}
    </pre>
  </details>
);

/**
 * The live view of the employer's browser window.
 *
 * Two things were wrong with the old one. It went blank between frames --
 * every frame is a new URL, and an `img` whose `src` changes empties itself
 * until the next picture decodes, so a stream of frames read as a flicker
 * rather than as video. And before the first frame existed it showed a line of
 * grey text in an empty box, which on a slow employer site is the longest and
 * least reassuring minute of the run.
 *
 * So: each frame is fetched as a blob and swapped in only once it is decoded,
 * which makes the sequence continuous rather than a flicker; frame n-1 is
 * revoked as frame n goes up, so a long run does not leave a heap of
 * full-size bitmaps behind it; and until the first one arrives, the stage
 * shows a pulse, so the emptiness reads as "not yet" rather than "nothing is
 * happening".
 */
const LiveView: React.FC<{ src: string; live: boolean; caption: string; placeholder: string }> = ({
  src, live, caption, placeholder,
}) => {
  const [shown, setShown] = React.useState('');
  // The object URL currently on screen. Kept in a ref rather than state
  // because revoking is cleanup, not rendering, and it must happen exactly
  // once per frame no matter how the component re-renders.
  const showing = React.useRef('');

  React.useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const abort = new AbortController();

    (async () => {
      try {
        // Fetched as a blob rather than handed to an `img` as a URL, so the
        // frame is an object this code owns and can destroy. Frame n-1 is
        // revoked the moment frame n is on screen: every frame is a distinct
        // URL (`?seq=N`), so without this a three-minute run leaves a couple
        // of hundred full-size bitmaps alive behind the panel.
        const res = await fetch(src, { signal: abort.signal, cache: 'no-store' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        const previous = showing.current;
        showing.current = next;
        setShown(next);
        if (previous) URL.revokeObjectURL(previous);
      } catch {
        // An aborted or failed frame is not an error worth showing: the next
        // poll brings another one, and the last good frame stays up meanwhile.
      }
    })();

    return () => { cancelled = true; abort.abort(); };
  }, [src]);

  // The last frame goes with the panel.
  React.useEffect(() => () => {
    if (showing.current) URL.revokeObjectURL(showing.current);
    showing.current = '';
  }, []);

  return (
    <figure className="space-y-2.5">
      <div className="relative rounded-2xl overflow-hidden bg-black/35 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1)]">
        {shown ? (
          <img
            src={shown}
            alt="The employer's application form, as it stands in the browser right now"
            className="w-full block"
          />
        ) : (
          <div className="aspect-video flex flex-col items-center justify-center gap-3 px-8 text-center">
            {/* The pulse says "still going". A finished run that never
                produced a frame is not still going, so it gets a dead dot. */}
            <span className="relative flex w-2.5 h-2.5">
              {live && (
                <span className="absolute inline-flex w-full h-full rounded-full bg-sky-400/60 animate-ping" />
              )}
              <span
                className={`relative inline-flex w-2.5 h-2.5 rounded-full ${
                  live ? 'bg-sky-400' : 'bg-white/25'
                }`}
              />
            </span>
            <p className="text-[13px] text-[rgba(235,235,245,0.62)] max-w-sm leading-snug">
              {placeholder}
            </p>
          </div>
        )}

        {/* The broadcast tally. Only while frames are actually arriving. */}
        {live && shown && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/55 backdrop-blur-md px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-white">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
            Live
          </span>
        )}
      </div>
      {/* Only when there is something to caption. "The form as it stands in
          the browser right now" under an empty stage is a caption for a
          picture that does not exist. */}
      {shown && (
        <figcaption className="text-[12.5px] text-[rgba(235,235,245,0.42)]">{caption}</figcaption>
      )}
    </figure>
  );
};

export const ApplyReviewPanel: React.FC<ApplyReviewPanelProps> = ({
  run,
  isSubmitting,
  onSubmitForReal,
  onClose,
}) => {
  const shot = browserApplyScreenshotUrl(run);
  const tone = TONE[run.status] || NEUTRAL_TONE;
  const missing = run.missing_required || [];
  const steps = run.steps || [];

  // Escape closes it, like every other sheet in the app.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // An application with empty required fields gets rejected by the form, so
  // there is nothing to approve: the honest move is to withhold the button and
  // say what is missing, rather than let it be sent and fail.
  const canSubmit = run.status === AWAITING_APPROVAL && run.dry_run && missing.length === 0 && !isSubmitting;
  const help = run.reason ? checkpointHelp(run.reason) : '';
  const isWaitingOnYou = run.status === 'WAITING_FOR_HUMAN';

  // The headline, and separately the evidence. The server translates its own
  // driver failures now, but this is the last gate before a stack frame could
  // reach a person, so it stays.
  const readable = readableFailure(run.message);
  const trace = run.detail || readable.trace;

  // While it runs, the headline is two or three words. `run.message` is the
  // newest backend log line, which means it was printing whole tracking URLs
  // across three wrapped lines of the modal. An ending is a sentence, because
  // an ending has something to say.
  const headline = run.done || isWaitingOnYou
    ? outcomeSentence(readable.text)
    : progressPhrase(readable.text);

  // The rail under it: the same lines, as phrases, de-duplicated.
  const trail = progressTrail(steps);

  return (
    <div
      className="fixed inset-0 z-[6000] flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="ic-popover w-full max-w-3xl max-h-[92vh] flex flex-col rounded-[26px] overflow-hidden animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-label={`Application to ${run.company}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 shrink-0 border-b border-white/[0.08]">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold tracking-[-0.02em] text-[#f5f5f7] truncate">
              {run.job_title || 'Application'}
            </h2>
            <p className="text-[13px] text-[rgba(235,235,245,0.62)] truncate">
              {run.company}
              {run.ats ? ` · ${run.ats}` : ''}
              {run.elapsed ? ` · ${run.elapsed}s` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ic-fill shrink-0 w-8 h-8 rounded-full flex items-center justify-center cursor-pointer text-[rgba(235,235,245,0.62)] hover:text-[#f5f5f7]"
            title="Close"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`mx-6 mt-4 shrink-0 flex items-start gap-3 px-4 py-3 rounded-2xl ${tone.wash}`}>
          {run.done || isWaitingOnYou ? (
            <tone.Icon className={`w-5 h-5 shrink-0 mt-0.5 ${tone.text}`} />
          ) : (
            <Loader2 className="w-5 h-5 shrink-0 mt-0.5 text-[rgba(235,235,245,0.62)] animate-spin" />
          )}
          <div className="min-w-0">
            <p className={`text-[14px] font-semibold leading-snug ${run.done || isWaitingOnYou ? tone.text : 'text-[#f5f5f7]'}`}>
              {headline}
            </p>
            {/* The run has not failed and has not stalled -- it is paused, on
                purpose, and it will pick itself back up. Saying so is the
                difference between a person going to the browser window and a
                person closing this panel. */}
            {isWaitingOnYou && (
              <p className="text-[13px] text-amber-200/80 mt-1 leading-snug">
                A Chrome window is open with the site's "prove you are human" check on it. Answer it
                there and this carries on filling the form by itself. The check is yours to pass --
                this app will not pretend to be you.
              </p>
            )}
            {help && <p className="text-[13px] text-[rgba(235,235,245,0.62)] mt-1 leading-snug">{help}</p>}
            {!help && run.reason && (
              <p className="text-[12.5px] text-[rgba(235,235,245,0.42)] mt-1 break-words">{run.reason}</p>
            )}
            {run.fields_filled > 0 && (
              <p className="text-[12.5px] text-[rgba(235,235,245,0.62)] mt-1">
                {run.fields_filled} field{run.fields_filled === 1 ? '' : 's'} filled from your profile
                {run.resume_attached ? ', CV attached' : ''}.
              </p>
            )}
            {/* Said plainly, because an application with no CV on it is
                usually a wasted one, and the frame below will show it. */}
            {run.done && run.status === AWAITING_APPROVAL && !run.resume_attached && (
              <p className="text-[12.5px] font-semibold text-amber-300 mt-1">
                Your CV is not on this form -- the upload did not take. You can drop it in yourself in
                the open browser window.
              </p>
            )}
            {trace && <TechnicalDetail trace={trace} />}
          </div>
        </div>

        {/* What the form still wants. These are answers about the candidate
            that no profile holds, so they are theirs to type. */}
        {missing.length > 0 && (
          <div className={`mx-6 mt-3 shrink-0 px-4 py-3 rounded-2xl bg-amber-400/10 ${EDGE_AMBER}`}>
            <p className="text-[13.5px] font-semibold text-amber-300">
              {missing.length} required field{missing.length === 1 ? '' : 's'} still need you
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((label) => (
                <li
                  key={label}
                  className="px-2 py-0.5 rounded-full bg-white/[0.08] text-[12px] font-medium text-amber-200"
                >
                  {label}
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] text-amber-200/70 mt-2 leading-snug">
              The Chrome window is open on this form with everything else already filled. Answer these
              there and submit it yourself -- sending it half-empty would only get it rejected.
            </p>
          </div>
        )}

        {/* What it is doing, while it does it -- as a rail of phrases, not a
            log. This was the backend's own step list rendered verbatim, which
            meant a wrapped tracking URL twice over and lines like "Configuring
            browser with anti-detect and session parameters...". Nobody
            watching their own application needs either. Each line maps to two
            or three words, consecutive repeats collapse, and only the last
            few are kept: enough to see it moving, which is the whole job. */}
        {trail.length > 0 && (
          <div className="mx-6 mt-3 shrink-0 rounded-2xl bg-black/20 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.08)] px-4 py-3">
            <ol className="space-y-1.5">
              {trail.map((phrase, i) => {
                const isTip = i === trail.length - 1;
                const active = isTip && !run.done;
                return (
                  <li
                    key={`${i}-${phrase}`}
                    className={`flex items-center gap-2.5 text-[13px] leading-none transition-opacity duration-300 ${
                      active
                        ? 'text-[#f5f5f7] font-medium'
                        : 'text-[rgba(235,235,245,0.42)]'
                    }`}
                  >
                    <span className="relative flex w-1.5 h-1.5 shrink-0">
                      {active && (
                        <span className="absolute inline-flex w-full h-full rounded-full bg-sky-400/70 animate-ping" />
                      )}
                      <span
                        className={`relative inline-flex w-1.5 h-1.5 rounded-full ${
                          active ? 'bg-sky-400' : 'bg-white/25'
                        }`}
                      />
                    </span>
                    {phrase}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
          <LiveView
            src={shot}
            live={!run.done}
            caption={
              run.done
                ? 'The form as it stands in the browser right now. Read it before you send it.'
                : 'Live from the browser window, updating as the form is filled.'
            }
            placeholder={
              run.done
                ? 'The run ended before there was anything to show.'
                : 'Warming up the live view...'
            }
          />
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-white/[0.08] flex items-center justify-between gap-3">
          <a
            href={run.job_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-[rgba(235,235,245,0.62)] underline underline-offset-2 hover:text-[#f5f5f7] transition-colors duration-150"
          >
            Open the listing
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="ic-press-wide px-4 py-2.5 rounded-xl text-[14px] font-medium text-[#f5f5f7] bg-white/[0.08] hover:bg-white/[0.14] cursor-pointer"
            >
              {canSubmit ? 'Not now' : 'Close'}
            </button>

            {/* The only control in the app that sends anything to an employer.
                It appears only after a filled form has been shown, and it names
                who is about to receive it. */}
            {(canSubmit || isSubmitting) && (
              <button
                type="button"
                onClick={onSubmitForReal}
                disabled={isSubmitting}
                className="ic-press-wide inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-semibold text-white bg-[#0a84ff] hover:bg-[#3b9bff] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Submit to {run.company}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
