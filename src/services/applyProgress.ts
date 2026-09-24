/**
 * Run progress, in words a person would use.
 *
 * The backend writes its log for whoever is debugging it: full target URLs
 * with their tracking parameters, "Configuring browser with anti-detect and
 * session parameters...", the signed-in account's email address. All of that
 * was being rendered verbatim in the apply panel, so watching an application
 * meant reading a machine's diary -- three lines of query string wrapped
 * across a modal, twice, because the same URL is both the headline and the
 * newest log line.
 *
 * This maps each line to two or three words. It is deliberately a lookup
 * rather than a summariser: anything unrecognised falls back to a generic
 * phrase instead of an improvised one, because the failure mode of guessing
 * here is leaking exactly the URLs and addresses this exists to keep out.
 */

/** Anything that must never reach the screen, whatever else happens. */
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;

function scrub(line: string): string {
  return line.replace(URL_RE, '').replace(EMAIL_RE, '').replace(/\s+/g, ' ').trim();
}

/**
 * First match wins, so order matters: the specific lines come before the
 * catch-alls that would also match them.
 */
const RULES: Array<[RegExp, string]> = [
  // Opening moves
  [/starting autonomous ai application engine/i, 'Getting started'],
  [/rehearsal mode/i, 'Rehearsal mode'],
  [/resolved direct employer portal/i, 'Found the employer'],
  [/configuring browser/i, 'Preparing browser'],
  [/using the saved browser profile/i, 'Restoring session'],
  [/no saved browser profile/i, 'No saved session'],
  [/saved google sign-in has lapsed/i, 'Session expired'],
  [/opening browser window/i, 'Opening browser'],
  [/navigating to employer portal/i, 'Loading the page'],
  [/new page loaded/i, 'New page'],

  // Writing the CV for this advert, which happens before the browser opens and
  // is the longest silent stretch of a run if it is not narrated.
  [/read the (en|fr) master/i, 'Reading your CV'],
  [/^kept \d+ bullets/i, 'Choosing what to show'],
  [/^cv printed/i, 'Printing your CV'],
  [/^letter printed/i, 'Writing your letter'],
  [/cv tailored for this advert/i, 'CV written for this job'],
  [/tailoring skipped|sending the standard cv|sending the standard one|sending the master as it is/i,
    'Using your standard CV'],

  // Getting to the form
  [/mounting pageagent core/i, 'Waking the agent'],
  [/clicked application button/i, 'Opening the form'],
  [/dismissed cookie consent banner/i, 'Cookies dismissed'],
  [/listing has expired|expired or was removed/i, 'Listing expired'],

  // Accounts
  [/sign-?in page/i, 'Signing in'],
  [/reading this page in/i, 'Reading the form'],
  [/signing in as|logging in with the account/i, 'Signing in'],
  [/trying the google sign-in/i, 'Trying Google'],
  [/creating a candidate account/i, 'Creating account'],
  [/account created on .* and remembered/i, 'Account created'],
  [/already has an account here/i, 'Account exists'],
  [/using the account created here/i, 'Known account'],
  [/that password was not accepted|did not carry through/i, 'Password refused'],
  [/could not complete registration|did not let us in/i, 'Sign-up failed'],
  [/tracked as:/i, 'Recorded'],
  [/back on the employer/i, 'Back on track'],
  [/apply without an account/i, 'No account needed'],
  [/already signed in/i, 'Already signed in'],
  [/requires an account|asked for an account/i, 'Account required'],
  [/^signed in\.?$/i, 'Signed in'],
  [/saved this session/i, 'Session saved'],
  [/ran out of time before every sign-in/i, 'Could not sign in'],
  [/wants an emailed code|emailed code cannot be/i, 'Emailed code needed'],
  [/waiting for the verification email/i, 'Checking your email'],
  [/verification code received/i, 'Code received'],
  [/no code arrived/i, 'No code arrived'],

  // The form itself
  [/attached resume|attached cv/i, 'CV attached'],
  [/^left .* empty/i, 'Question skipped'],
  // The cloud engine narrates its own steps, in the model's words rather than
  // the backend's, so there is no fixed vocabulary to match on. These read the
  // verb out of the sentence and stop before it, which is all the rail has room
  // for anyway -- and they sit above the catch-all below, which is what a line
  // falls to when none of them fit.
  [/waiting for a cloud browser/i, 'Waiting for a browser'],
  [/^agent[:.].*\b(captcha|robot check)/i, 'CAPTCHA in the way'],
  [/^agent[:.].*\b(cannot apply|no application|not a job|not an application)/i, 'Nothing to apply to'],
  [/^agent[:.].*\b(sign|log)\s?(in|ging in)|^agent[:.].*\bconnexion/i, 'Signing in'],
  [/^agent[:.].*\b(upload|attach)/i, 'Attaching your CV'],
  [/^agent[:.].*\b(submit|send|envoy)/i, 'Sending it'],
  [/^agent[:.].*\b(fill|answer|complete|type)/i, 'Filling the form'],
  [/^agent[:.].*\b(inspect|read|review|check)/i, 'Reading the form'],
  [/^agent[:.].*\b(open|load|navigat|go to)/i, 'Loading the page'],
  [/^agent[:.]/i, 'Filling the form'],
  [/agent note/i, 'Filling the form'],
  [/stopped to ask/i, 'Needs your answer'],

  // Endings
  [/sending your application|sending your approved/i, 'Sending it'],
  [/form filled and left for your review/i, 'Ready for review'],
  [/submitted & verified|application submitted/i, 'Application sent'],
  [/portal barrier/i, 'Blocked by the site'],
  [/application incomplete|not sent, or not confirmed/i, 'Not completed'],
  [/application recorded/i, 'Saved to your history'],
  [/receipt emailed/i, 'Receipt sent'],
  [/cancelled by user/i, 'Cancelled'],
  [/review window closed/i, 'Review expired'],
  [/browser window was closed/i, 'Browser closed'],
];

/** Two or three words for one log line. */
export function progressPhrase(line: string): string {
  const raw = (line || '').trim();
  if (!raw) return 'Working on it';
  for (const [pattern, phrase] of RULES) {
    if (pattern.test(raw)) return phrase;
  }
  // Unrecognised. A short line with nothing sensitive left in it can speak for
  // itself; anything longer is a sentence written for a log file.
  const clean = scrub(raw).replace(/[.…]+$/, '');
  const words = clean.split(' ').filter(Boolean);
  if (clean && words.length <= 3 && clean.length <= 24) {
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  return 'Working on it';
}

/**
 * The trail of phrases behind the run, newest last.
 *
 * Consecutive repeats collapse, because six "Filling the form" lines in a row
 * is one thing happening, not six. `limit` keeps the rail short enough to read
 * at a glance rather than scroll.
 *
 * Two, not five. Five phrases is a changelog, and a changelog under a live
 * video of the same events is the events told twice. What is wanted here is
 * where it is now and the one step it came from -- enough to see it moving,
 * short enough to take in without reading.
 */
export function progressTrail(steps: string[], limit = 2): string[] {
  const out: string[] = [];
  for (const step of steps || []) {
    const phrase = progressPhrase(step);
    if (phrase !== out[out.length - 1]) out.push(phrase);
  }
  return out.slice(-limit);
}

/**
 * A finished run's own sentence, with any URL or address taken out of it.
 *
 * Endings are written for the candidate already, so unlike the progress lines
 * they are worth reading in full -- they say what happened and what to do. All
 * they need is the scrubbing.
 */
export function outcomeSentence(message: string): string {
  const clean = scrub(message || '');
  return clean || 'The run finished.';
}
