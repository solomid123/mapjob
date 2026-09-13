# BOJ Tool — Fill Application (browser extension)

Runs inside **your own real, already-signed-in browser** — not a separate headless bot. That's
the whole reason this exists: sites can tell the difference between a real human's browser
(real cookies, real browsing history, real IP, `navigator.webdriver` false) and a server-side
automated one, and increasingly block the latter outright (confirmed live against SmartRecruiters/
DataDome, a Greenhouse reCAPTCHA embed, and Lever — see `AGENTS.md`). This extension doesn't
disguise anything; it genuinely is you, using your browser, with an assist.

**Hard rule: it never clicks Submit.** It fills the form and attaches your documents, then stops.
You review and submit yourself, every time.

Behavior notes:

- Stays on the job's own page. The agent is instructed to never open the careers listing or other
  postings; if a click still leads away, the extension pulls the tab back (scoped to that specific
  job URL — the job page itself is never bounced, even when it lives at `careers.company.com`).
- Attaches exactly **one** PDF (the tailored CV) to the single best-matching resume/CV upload
  slot — cover-letter/extra attachment slots are left alone.

## Install (unpacked, for personal use)

1. `npm run dev` in the main project (must be running on `http://localhost:3000` — this extension
   talks to your local BOJ Tool server, nothing external).
2. Chrome/Edge → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select this `browser-extension/` folder.
4. Pin the extension (puzzle-piece icon → pin) for easy access.

## Use

1. In BOJ Tool, generate + compile the CV (and cover letter) for a job as usual.
2. Open that job's real application page in your browser (the same URL BOJ Tool has on file, or
   wherever "Apply" takes you from there).
3. Click the extension icon.
4. It looks up the job by URL, scans the page (including iframes — Greenhouse/etc. often embed
   the real form in one), and:
   - Stops and tells you plainly if it hits a required account/login, a CAPTCHA, or a site's
     anti-bot block — it does not try to get past any of these.
   - Otherwise fills what it can from your real CV header (name/email/phone/address/LinkedIn/
     website) and attaches your tailored PDF(s), then alerts you with a summary.
5. **You review the filled form and click Submit yourself.**

## What it will not do

- Create an account or log in anywhere.
- Solve, click through, or otherwise handle a CAPTCHA.
- Submit the application.
- Send any of your data anywhere except your own `localhost:3000` BOJ Tool server (for the field
  values and file bytes).
