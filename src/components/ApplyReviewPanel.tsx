import React from 'react';
import { X, Loader2, CheckCircle2, AlertTriangle, ExternalLink, Send, ShieldAlert } from 'lucide-react';
import type { BrowserApplyRun } from '../services/directAtsApi';
import { browserApplyScreenshotUrl } from '../services/directAtsApi';

interface ApplyReviewPanelProps {
  run: BrowserApplyRun;
  /** True while the real submission is in flight, so the button cannot double-fire. */
  isSubmitting: boolean;
  onSubmitForReal: () => void;
  onClose: () => void;
}

/** The status where the form is filled and waiting on a human decision. */
const AWAITING_APPROVAL = 'DRY_RUN_COMPLETED';

const TONE: Record<string, { ring: string; text: string; Icon: typeof CheckCircle2 }> = {
  APPLIED: { ring: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-800', Icon: CheckCircle2 },
  SUBMITTED_UNVERIFIED: { ring: 'bg-amber-50 border-amber-200', text: 'text-amber-900', Icon: AlertTriangle },
  DRY_RUN_COMPLETED: { ring: 'bg-sky-50 border-sky-200', text: 'text-sky-900', Icon: CheckCircle2 },
  NEEDS_CHECKPOINT: { ring: 'bg-amber-50 border-amber-200', text: 'text-amber-900', Icon: ShieldAlert },
  WAITING_FOR_HUMAN: { ring: 'bg-amber-50 border-amber-200', text: 'text-amber-900', Icon: ShieldAlert },
  FAILED: { ring: 'bg-rose-50 border-rose-200', text: 'text-rose-800', Icon: AlertTriangle },
  SKIPPED: { ring: 'bg-gray-50 border-gray-200', text: 'text-gray-700', Icon: CheckCircle2 },
};

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

export const ApplyReviewPanel: React.FC<ApplyReviewPanelProps> = ({
  run,
  isSubmitting,
  onSubmitForReal,
  onClose,
}) => {
  const shot = browserApplyScreenshotUrl(run);
  const tone = TONE[run.status] || { ring: 'bg-gray-50 border-gray-200', text: 'text-gray-800', Icon: Loader2 };
  const missing = run.missing_required || [];
  const steps = run.steps || [];

  // Keep the newest line in view, so a long run reads like a feed rather than
  // something the reader has to chase with the scrollbar.
  const logRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  // An application with empty required fields gets rejected by the form, so
  // there is nothing to approve: the honest move is to withhold the button and
  // say what is missing, rather than let it be sent and fail.
  const canSubmit = run.status === AWAITING_APPROVAL && run.dry_run && missing.length === 0 && !isSubmitting;
  const help = run.reason ? checkpointHelp(run.reason) : '';
  const isWaitingOnYou = run.status === 'WAITING_FOR_HUMAN';

  return (
    <div className="fixed inset-0 z-[6000] flex items-center justify-center bg-black/50 p-4 animate-airbnb-pop">
      <div
        className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-white rounded-3xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={`Application to ${run.company}`}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold text-[#222222] truncate">{run.job_title || 'Application'}</h2>
            <p className="text-[13px] text-[#717171] truncate">
              {run.company}
              {run.ats ? ` • ${run.ats}` : ''}
              {run.elapsed ? ` • ${run.elapsed}s` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 p-2 -mr-2 rounded-full hover:bg-gray-100 transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className={`mx-6 mt-4 shrink-0 flex items-start gap-3 px-4 py-3 rounded-2xl border ${tone.ring}`}>
          {run.done || isWaitingOnYou ? (
            <tone.Icon className={`w-5 h-5 shrink-0 mt-0.5 ${tone.text}`} />
          ) : (
            <Loader2 className="w-5 h-5 shrink-0 mt-0.5 text-gray-700 animate-spin" />
          )}
          <div className="min-w-0">
            <p className={`text-[14px] font-semibold ${run.done || isWaitingOnYou ? tone.text : 'text-gray-800'}`}>
              {run.message}
            </p>
            {/* The run has not failed and has not stalled — it is paused, on
                purpose, and it will pick itself back up. Saying so is the
                difference between a person going to the browser window and a
                person closing this panel. */}
            {isWaitingOnYou && (
              <p className="text-[13px] text-amber-900 mt-1 leading-snug">
                A Chrome window is open with the site's "prove you are human" check on it. Answer it
                there and this carries on filling the form by itself. The check is yours to pass —
                this app will not pretend to be you.
              </p>
            )}
            {help && <p className="text-[13px] text-gray-700 mt-1 leading-snug">{help}</p>}
            {!help && run.reason && <p className="text-[12.5px] text-gray-600 mt-1 break-words">{run.reason}</p>}
            {run.fields_filled > 0 && (
              <p className="text-[12.5px] text-gray-600 mt-1">
                {run.fields_filled} field{run.fields_filled === 1 ? '' : 's'} filled from your profile
                {run.resume_attached ? ', CV attached' : ''}.
              </p>
            )}
            {/* Said plainly, because an application with no CV on it is
                usually a wasted one, and the screenshot above will show it. */}
            {run.done && run.status === AWAITING_APPROVAL && !run.resume_attached && (
              <p className="text-[12.5px] font-semibold text-amber-800 mt-1">
                Your CV is not on this form — the upload did not take. You can drop it in yourself in
                the open browser window.
              </p>
            )}
          </div>
        </div>

        {/* What the form still wants. These are answers about the candidate
            that no profile holds, so they are theirs to type. */}
        {missing.length > 0 && (
          <div className="mx-6 mt-3 shrink-0 px-4 py-3 rounded-2xl border border-amber-200 bg-amber-50">
            <p className="text-[13.5px] font-semibold text-amber-900">
              {missing.length} required field{missing.length === 1 ? '' : 's'} still need you
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {missing.map((label) => (
                <li
                  key={label}
                  className="px-2 py-0.5 rounded-full bg-white border border-amber-200 text-[12px] font-medium text-amber-900"
                >
                  {label}
                </li>
              ))}
            </ul>
            <p className="text-[12.5px] text-amber-900/80 mt-2 leading-snug">
              The Chrome window is open on this form with everything else already filled. Answer these
              there and submit it yourself — sending it half-empty would only get it rejected.
            </p>
          </div>
        )}

        {/* What it is doing, while it does it. A run takes the better part of
            a minute; before this there was a spinner and one word, and the
            honest complaint was that you could not tell it apart from a hang.
            Refusals show up here too, which is the point: "left Salary
            Expectation empty" is the app explaining itself rather than quietly
            skipping a field. */}
        {steps.length > 0 && (
          <div className="mx-6 mt-3 shrink-0 rounded-2xl border border-gray-200 bg-gray-50/70 overflow-hidden">
            <div
              ref={logRef}
              className="max-h-40 overflow-y-auto custom-scrollbar px-4 py-3 space-y-1"
            >
              {steps.map((step, i) => {
                const skipped = /^left .* empty/i.test(step);
                const isLast = i === steps.length - 1;
                return (
                  <p
                    key={`${i}-${step.slice(0, 24)}`}
                    className={`text-[12.5px] leading-snug flex gap-2 ${
                      skipped ? 'text-amber-800' : 'text-gray-700'
                    }`}
                  >
                    <span
                      className={`shrink-0 mt-[6px] w-1.5 h-1.5 rounded-full ${
                        skipped ? 'bg-amber-500' : isLast && !run.done ? 'bg-sky-500 animate-pulse' : 'bg-gray-300'
                      }`}
                      aria-hidden
                    />
                    <span className="min-w-0 break-words">{step}</span>
                  </p>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
          {shot ? (
            <figure className="space-y-2">
              <img
                src={shot}
                alt={`The application form for ${run.company}, filled in and not yet submitted`}
                className="w-full rounded-2xl border border-gray-200 shadow-sm"
              />
              <figcaption className="text-[12.5px] text-[#717171]">
                {run.done
                  ? 'The form as it stands in the browser right now. Read it before you send it.'
                  : 'Live from the browser window, updating as the form is filled.'}
              </figcaption>
            </figure>
          ) : (
            <div className="h-40 flex items-center justify-center text-[13.5px] text-[#717171] text-center px-6">
              {run.done
                ? 'No screenshot was captured for this run.'
                : 'A Chrome window is opening on the employer’s form. The live view appears here.'}
            </div>
          )}
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
          <a
            href={run.job_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-[#222222] underline underline-offset-2 hover:text-black"
          >
            Open the listing
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-[14px] font-semibold text-[#222222] hover:bg-gray-100 transition"
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
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-[14px] font-bold text-white bg-[#E31C5F] hover:bg-[#c81852] disabled:opacity-60 disabled:cursor-not-allowed transition active:scale-95"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Submitting…
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
