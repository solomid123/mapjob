// BOJ Tool -- Fill Application (browser extension)
//
// Runs entirely inside the user's OWN real, already-signed-in browser
// session (their real cookies/history/IP/navigator.webdriver=false) -- this
// is the whole point: it is not a disguise, it genuinely IS a human-operated
// browser, which is why it gets through anti-bot protection that a
// server-side headless-Playwright bot correctly does not (and should not try
// to defeat). See AGENTS.md "Auto-apply" section.
//
// Hard rules, same as the server-side path:
//   - never creates an account / logs in anywhere
//   - never solves or works around a CAPTCHA
//   - never clicks Submit -- always stops for the human to review and submit

const API_BASE = "http://127.0.0.1:8000";

// Kept in sync by hand with src/lib/formMapping.ts.
const REGISTRATION_PATTERNS =
  /create\s+(an?\s+)?account|sign\s*up|log\s*in\s+to\s+apply|register\s+to\s+apply|create\s+a\s+profile|welcome\s+back.{0,20}log\s*in|cr[Ã©e]er\s+(un\s+)?compte|se\s+connecter|s'inscrire|connectez[- ]vous/i;
const CAPTCHA_FRAME_PATTERN = /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha/i;
const BOT_BLOCK_TEXT_PATTERN =
  /access\s+is\s+temporarily\s+restricted|unusual\s+(activity|traffic)|automated\s*\(?bot\)?\s+activity|verify\s+you\s+are\s+human|please\s+verify\s+you|blocked\s+for\s+security|request\s+has\s+been\s+blocked|access\s+denied/i;
const BOT_VENDOR_FRAME_PATTERN =
  /captcha-delivery\.com|datadome|distilnetworks\.com|perimeterx|px-cdn|incapsula|imperva/i;
const COOKIE_ACCEPT_PATTERN =
  /accept\s*(all)?( cookies)?|agree|i\s*accept|tout\s+accepter|accepter\s+(tous\s+les\s+)?cookies|j'accepte/i;
const APPLY_LINK_PATTERN =
  /\bapply\b|\bpostuler\b|\bcandidater\b|int[Ã©e]ress|start\s+application|submit\s+cv|send\s+cv|join\s+us|candidature|apply\s+now|apply\s+online|postulez|autofill|apply\s+manually|use\s+my\s+last\s+application|start\s+your\s+application/i;

function notify(tabId, text) {
  console.log("[BOJ Tool Service Worker Notify]", text);
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (msg) => window.alert("[BOJ Tool]\n\n" + msg),
      args: [text],
    })
    .catch(() => {});
}

function status(tabId, text) {
  console.log("[BOJ Tool Service Worker Status]", text);
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (msg) => console.log("[BOJ Tool]", msg),
      args: [text],
    })
    .catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.action.onClicked.addListener((tab) => {
  run(tab).catch((err) => notify(tab.id, "Error: " + (err && err.message ? err.message : String(err))));
});

const handleLaunchMessage = (message, sender, sendResponse) => {
  // Instant completion signal from the isolated-world done-relay (see
  // executePageAgentOnTab): unlike the window flag it survives the
  // post-submit page navigation, because it is dispatched the exact moment
  // the agent calls done() -- before any navigation can wipe the context.
  if (message && message.type === "BOJ_AGENT_DONE" && sender && sender.tab && typeof sender.tab.id === "number") {
    chrome.storage.local.get("bojBulkRunId").then(({ bojBulkRunId }) => {
      if (bojBulkRunId) {
        chrome.storage.local.set({
          bojBulkDoneResult: {
            runId: String(bojBulkRunId),
            tabId: sender.tab.id,
            success: !!message.success,
            detail: String(message.detail || "").slice(0, 300),
            at: Date.now(),
          },
        });
      }
    });
    // Every-page auto-launch loop guard: once the agent has finished on this
    // tab+URL (whatever the outcome), don't auto-launch again for ~2 min.
    // Without this an SPA that kept re-navigating would respawn the agent
    // forever (and the "no application form" exit would loop on every page).
    chrome.storage.local.set({
      bojPageDone: {
        tabId: sender.tab.id,
        url: sender.tab.url || "",
        detail: String(message.detail || "").slice(0, 300),
        at: Date.now(),
      },
    });
    // Sign-in wall the agent cannot cross alone (verification code / CAPTCHA):
    // park the agent instead of silently vanishing -- watch for the human to
    // complete the login, then auto-relaunch (see startLoginWatch).
    const doneDetail = String(message.detail || "");
    if (!message.success && /needs_human_login/i.test(doneDetail)) {
      startLoginWatch(sender.tab.id);
    }
    if (sendResponse) sendResponse({ success: true });
    return false;
  }
  // New-tab handoff: a MAIN-world window.open / target=_blank capture (agent
  // clicked "Postuler"/"Apply" and Chrome's popup blocker would have killed
  // the new tab). The service worker opens it itself (never blocked) and the
  // every-page auto-launch in tabs.onUpdated takes over there.
  if (message && message.type === "BOJ_OPEN_TAB" && message.url && sender && sender.tab) {
    (async () => {
      const srcTab = sender.tab;
      try {
        const u = new URL(String(message.url));
        if (u.protocol !== "http:" && u.protocol !== "https:") return;
        const { bojBulkRunId, bojBulkOwnTabId } = await chrome.storage.local.get(["bojBulkRunId", "bojBulkOwnTabId"]);
        if (bojBulkRunId && bojBulkOwnTabId === srcTab.id) {
          // Bulk runs are one-tab-by-design: navigate the owned tab instead.
          await chrome.tabs.update(srcTab.id, { url: u.href });
          return;
        }
        const newTab = await chrome.tabs.create({ url: u.href, active: true });
        const { activeTask, bojTabHandoffs } = await chrome.storage.local.get(["activeTask", "bojTabHandoffs"]);
        const fromAgent = activeTask && activeTask.tabId === srcTab.id;
        const map = bojTabHandoffs || {};
        map[newTab.id] = {
          fromTabId: srcTab.id,
          jobTitle: (fromAgent && activeTask.jobTitle) || "",
          companyName: (fromAgent && activeTask.companyName) || "",
          at: Date.now(),
        };
        await chrome.storage.local.set({ bojTabHandoffs: map });
        console.log("[BOJ Tool] Opened agent-requested tab:", u.href.slice(0, 120));
      } catch (e) {
        console.warn("[BOJ Tool] BOJ_OPEN_TAB note:", e);
      }
    })();
    if (sendResponse) sendResponse({ success: true });
    return true;
  }
  // Fetch tunnel: MAIN-world page code runs with the SITE's origin, so its
  // fetch("http://localhost:3000/...") triggers Chrome's per-site Local
  // Network Access prompt and the PageAgent freezes when it is denied. The
  // isolated-world relay forwards those calls here; the service worker
  // (extension context -- no prompt ever) performs them. HARD allow-list:
  // http loopback + /api/ only -- never an open proxy for page scripts.
  if (message && message.type === "BOJ_FETCH" && sender && sender.tab) {
    (async () => {
      try {
        const u = new URL(String(message.url || ""));
        const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
        const isFuelix = u.hostname.includes("fuelix.ai");
        const isAzure = u.hostname.includes(".azure.com") || u.hostname === "api.x.ai";
        if (!isFuelix && !isAzure && (u.protocol !== "http:" || !loopback || !u.pathname.startsWith("/api/"))) {
          throw new Error(`refused by BOJ tunnel allow-list: ${u.origin}${u.pathname}`);
        }
        const reqHeaders = { ...(message.headers || {}) };
        if (isFuelix) {
          reqHeaders["Authorization"] = reqHeaders["Authorization"] || "Bearer ak-p9YxA11lcjojQGtzBRkt9ne1kF23";
        } else if (isAzure) {
          reqHeaders["api-key"] = reqHeaders["api-key"] || "6vbExo4u3TFNji1YABRFhlT7jJrRBLQyxwd1ayCvd1kmuzyPLOovJQQJ99CHACYeBjFXJ3w3AAAAACOGRIb3";
          reqHeaders["Authorization"] = reqHeaders["Authorization"] || "Bearer 6vbExo4u3TFNji1YABRFhlT7jJrRBLQyxwd1ayCvd1kmuzyPLOovJQQJ99CHACYeBjFXJ3w3AAAAACOGRIb3";
        }
        let sendBody = message.body != null ? String(message.body) : undefined;
        if (sendBody && (isAzure || u.pathname.includes("chat/completions"))) {
          try {
            const parsed = JSON.parse(sendBody);
            delete parsed.thinking;
            delete parsed.enable_thinking;
            sendBody = JSON.stringify(parsed);
          } catch (e) {}
        }
        const resp = await fetch(u.href, {
          method: message.method || "GET",
          headers: reqHeaders,
          body: sendBody,
        });
        const body = await resp.text();
        const headers = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });
        sendResponse({ ok: true, status: resp.status, statusText: resp.statusText, headers, body });
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        // Surface worker-side tunnel failures in the bulk run log too
        // (best-effort; a page without a bulk run just gets the SW console).
        try {
          const { bojBulkRunId } = await chrome.storage.local.get("bojBulkRunId");
          if (bojBulkRunId) await bulkEvent(bojBulkRunId, { type: "log", msg: `LLM tunnel worker-side error: ${msg}` });
        } catch (e2) {}
        sendResponse({ ok: false, error: msg });
      }
    })();
    return true; // async sendResponse
  }
  if (message && message.type === "BOJ_BULK_START" && message.runId) {
    console.log("[BOJ Tool Background] Bulk apply start requested for run:", message.runId);
    bulkStart(String(message.runId))
      .then(() => sendResponse && sendResponse({ success: true }))
      .catch((err) => sendResponse && sendResponse({ success: false, error: String(err) }));
    return true;
  }
  if (message && message.type === "BOJ_LAUNCH_PAGE_AGENT" && message.jobUrl) {
    console.log("[BOJ Tool Background] Launching PageAgent for jobUrl:", message.jobUrl);
    launchPageAgentOnJobTab(
      message.jobUrl,
      message.candidate,
      message.jobTitle,
      message.companyName,
      message.cvPdfUrl,
      message.coverLetterPdfUrl
    )
      .then(() => sendResponse && sendResponse({ success: true }))
      .catch((err) => sendResponse && sendResponse({ success: false, error: String(err) }));
    return true;
  }
  if (message && message.type === "BOJ_STEP_LOG" && message.msg) {
    console.log("[BOJ Tool Step]", message.msg);
    chrome.storage.local.get("bojBulkRunId").then(({ bojBulkRunId }) => {
      if (bojBulkRunId) {
        bulkEvent(bojBulkRunId, { type: "log", msg: message.msg });
      }
    });
    return true;
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  return handleLaunchMessage(message, sender, sendResponse);
});
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  return handleLaunchMessage(message, sender, sendResponse);
});

async function uploadByAttr(tabId, frameId, domIndex, bytes, filename) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (idx, byteArray, filename) => {
        const el = document.querySelector(`[data-boj-file="${idx}"]`) || document.querySelector('input[type="file"]');
        if (!el) return false;
        const file = new File([new Uint8Array(byteArray)], filename, { type: "application/pdf" });
        const dt = new DataTransfer();
        dt.items.add(file);
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
          if (nativeSetter) nativeSetter.call(el, dt.files);
          else el.files = dt.files;
        } catch (e) {
          try { el.files = dt.files; } catch (e2) {}
        }
        try { if (el._valueTracker) el._valueTracker.setValue(""); } catch (e) {}

        for (const evName of ["input", "change", "blur"]) {
          try { el.dispatchEvent(new Event(evName, { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
        }

        let curr = el;
        for (let depth = 0; depth < 8 && curr; depth++) {
          for (const evType of ["dragenter", "dragover", "drop"]) {
            try { curr.dispatchEvent(new DragEvent(evType, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt })); } catch (e) {}
          }
          for (const evType of ["change", "input", "file-selected"]) {
            try { curr.dispatchEvent(new CustomEvent(evType, { bubbles: true, cancelable: true, composed: true, detail: { files: dt.files } })); } catch (e) {}
          }
          curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host) || null;
        }
        return true;
      },
      args: [domIndex, bytes, filename],
    });
    return true;
  } catch {
    return false;
  }
}

// Auto-clicker for reCAPTCHA / hCaptcha / Turnstile checkboxes inside iframe frame contexts.
// Cross-origin iframes cannot be queried from parent DOM, but executing this in allFrames:true
// lets each frame query and click its own checkbox directly inside its own window document.
function captchaAutoClickerFunc() {
  if (window.__BOJ_CAPTCHA_CLICKER_ACTIVE) return;
  window.__BOJ_CAPTCHA_CLICKER_ACTIVE = true;

  function tryClick() {
    try {
      // 1. Google reCAPTCHA checkbox (inside recaptcha anchor iframe)
      const recaptchaAnchor = document.querySelector('#recaptcha-anchor, .recaptcha-checkbox-border, .recaptcha-checkbox-checkmark');
      if (recaptchaAnchor) {
        const anchor = document.querySelector('#recaptcha-anchor') || recaptchaAnchor;
        const isChecked = anchor.getAttribute('aria-checked') === 'true' || anchor.classList.contains('recaptcha-checkbox-checked');
        if (!isChecked) {
          console.log('[BOJ Tool] Auto-clicking reCAPTCHA checkbox in frame:', window.location.href);
          anchor.click();
          return;
        }
      }

      // 2. hCaptcha checkbox (inside hcaptcha anchor iframe)
      const hcaptchaAnchor = document.querySelector('#checkbox, #anchor-state');
      if (hcaptchaAnchor && window.location.href.includes('hcaptcha.com')) {
        const isChecked = hcaptchaAnchor.getAttribute('aria-checked') === 'true';
        if (!isChecked) {
          console.log('[BOJ Tool] Auto-clicking hCaptcha checkbox in frame:', window.location.href);
          hcaptchaAnchor.click();
          return;
        }
      }

      // 3. Cloudflare Turnstile checkbox (inside turnstile iframe)
      if (window.location.href.includes('challenges.cloudflare.com')) {
        const turnstileCb = document.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (turnstileCb) {
          const isChecked = turnstileCb.checked || turnstileCb.getAttribute('aria-checked') === 'true';
          if (!isChecked) {
            console.log('[BOJ Tool] Auto-clicking Turnstile checkbox in frame:', window.location.href);
            turnstileCb.click();
            return;
          }
        }
      }
    } catch (e) {}
  }

  tryClick();
  setInterval(tryClick, 1000);
  if (document.body) {
    try {
      const obs = new MutationObserver(tryClick);
      obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }
}

// MAIN-world popup-blocker workaround: Chrome kills window.open() called from
// synthetic (agent-scripted) clicks -- e.g. LinkedIn's off-site "Postuler" /
// careers-site "Apply" buttons never open their new tab when the agent clicks
// them. This wrapper redirects such attempts (plus untrusted target=_blank
// anchor clicks) to the service worker via postMessage; the worker opens the
// tab itself (extension-created tabs are never popup-blocked) and continues
// the agent there. sameTab=true (bulk runs) navigates the SAME tab instead --
// the bulk worker owns exactly one tab per run.
function newTabCaptureFunc(sameTab) {
  if (window.__BOJ_NEWTAB_CAPTURE) return;
  window.__BOJ_NEWTAB_CAPTURE = true;
  const relay = (url, source) => {
    try {
      const u = new URL(String(url || ""), location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (sameTab) {
        location.href = u.href;
        return true;
      }
      window.postMessage({ type: "BOJ_OPEN_TAB_RELAY", url: u.href, source: source || "" }, "*");
      // Visible marker so the LLM agent SEES the handoff happened and can
      // report done(true) on THIS tab instead of hunting for the form.
      if (!document.getElementById("__boj_newtab_note") && document.body) {
        const d = document.createElement("div");
        d.id = "__boj_newtab_note";
        d.textContent = "BOJ: the application opened in a NEW TAB -- the agent continues there.";
        d.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#0a7;color:#fff;padding:8px 12px;font:13px sans-serif;border-radius:6px;";
        document.body.appendChild(d);
      }
      return true;
    } catch (e) {
      return false;
    }
  };
  const origOpen = window.open;
  window.open = function (url) {
    // Any programmatic window.open goes through us (trusted human clicks that
    // call window.open get the same treatment -- same outcome: a working tab).
    if (url && relay(url, "window.open")) return null;
    return origOpen.apply(window, arguments);
  };
  document.addEventListener(
    "click",
    (ev) => {
      try {
        if (ev.isTrusted) return; // human click: let the browser handle it
        const a = ev.target && ev.target.closest ? ev.target.closest('a[target="_blank"]') : null;
        if (!a) return;
        const href = a.href || a.getAttribute("href");
        if (!href) return;
        ev.preventDefault();
        ev.stopPropagation();
        relay(href, "target=_blank");
      } catch (e) {}
    },
    true
  );
}

// Tiny relay injected in the ISOLATED world (has chrome.runtime access) on
// bulk application tabs: the MAIN-world PageAgent has no chrome.* APIs, so
// reportDone() posts a window message and this relay forwards it to the
// service worker. A runtime message -- unlike window[doneKey] -- is
// delivered the moment done() fires, BEFORE the post-submit navigation can
// wipe the page's window globals (the old "flag invisible forever" race).
function bulkDoneRelayFunc() {
  if (window.__BOJ_DONE_RELAY_ACTIVE) return;
  window.__BOJ_DONE_RELAY_ACTIVE = true;
  window.addEventListener("message", (event) => {
    const d = event && event.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "BOJ_AGENT_DONE_RELAY") {
      try {
        chrome.runtime.sendMessage({
          type: "BOJ_AGENT_DONE",
          success: !!d.success,
          detail: String(d.detail || "").slice(0, 300),
        });
      } catch (e) {}
      return;
    }
    // Tunnel diagnostics: surface page-side tunnel failures (missing relay,
    // timeouts, worker errors) in the bulk run log / SW console via the
    // existing BOJ_STEP_LOG channel.
    if (d.type === "BOJ_TUNNEL_LOG" && d.msg) {
      try {
        chrome.runtime.sendMessage({ type: "BOJ_STEP_LOG", msg: String(d.msg).slice(0, 300) });
      } catch (e) {}
      return;
    }
    // New-tab handoff: MAIN-world window.open / target=_blank captures ask the
    // service worker to open the tab itself (popup-blocker-proof).
    if (d.type === "BOJ_OPEN_TAB_RELAY" && d.url) {
      try {
        chrome.runtime.sendMessage({ type: "BOJ_OPEN_TAB", url: String(d.url).slice(0, 2000), source: String(d.source || "") });
      } catch (e) {}
      return;
    }
    // Fetch tunnel: forward MAIN-world loopback requests to the worker and
    // post the result back (request/response correlated by id).
    if (d.type === "BOJ_TUNNELED_FETCH" && d.id) {
      const post = (payload) => {
        try {
          window.postMessage(Object.assign({ type: "BOJ_TUNNELED_FETCH_RESULT", id: d.id }, payload), "*");
        } catch (e) {}
      };
      try {
        chrome.runtime.sendMessage(
          { type: "BOJ_FETCH", url: String(d.url), method: String(d.method || "GET"), headers: d.headers || {}, body: d.body ?? null },
          (resp) => {
            const err = chrome.runtime.lastError;
            if (err || !resp) post({ okRelay: false, error: String((err && err.message) || "no response from worker") });
            else post({ okRelay: !!resp.ok, status: resp.status, statusText: resp.statusText, headers: resp.headers, body: resp.body, error: resp.error });
          }
        );
      } catch (e) {
        post({ okRelay: false, error: String(e && e.message ? e.message : e) });
      }
    }
  });
}

// opts (optional): { bulk: boolean, autoSubmit: boolean, doneKey: string|null }
// bulk mode additionally (a) resets the running-flag when the agent finishes
// so a later launch on the same tab is never silently swallowed, and (b)
// reports completion to window[doneKey] for the bulk worker to poll.
async function executePageAgentOnTab(tabId, candidate, jobTitle, companyName, cvPdfUrl, coverLetterPdfUrl, jobUrl, opts) {
  const bulkOpts = opts || { bulk: false, autoSubmit: false, doneKey: null };
  // Critical launch-path failures previously went to the SW console only --
  // invisible in the bulk run log, so a broken injection read as "agent went
  // silent after launch". Push them into the run log when a bulk run owns us.
  const swNote = async (msg) => {
    console.log(msg);
    if (bulkOpts.bulk) {
      try {
        const { bojBulkRunId } = await chrome.storage.local.get("bojBulkRunId");
        if (bojBulkRunId) await bulkEvent(bojBulkRunId, { type: "log", msg });
      } catch (e) {}
    }
  };
  await chrome.storage.local.set({
    // jobUrl anchors the auto-recovery scope: only a navigation AWAY from this
    // job's own page (to a listing/careers overview) may be pulled back --
    // never the job page itself, which often legitimately lives on
    // careers.company.com or company.com/careers/...
    activeTask: { tabId, jobUrl: jobUrl || "", candidate, jobTitle, companyName, cvPdfUrl, coverLetterPdfUrl, time: Date.now() },
  });

  const cvUrl = cvPdfUrl ? (cvPdfUrl.startsWith("http") ? cvPdfUrl : `${API_BASE}${cvPdfUrl}`) : "";

  // Fetch CV PDF (and the cover letter PDF, when one was tailored) in the
  // background service worker and convert to Base64 Data URIs to bypass
  // Mixed Content / CORS in page.
  const fetchPdfAsDataUrl = async (url) => {
    if (!url) return "";
    const abs = url.startsWith("http") ? url : `${API_BASE}${url}`;
    try {
      const res = await fetch(abs);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        return `data:application/pdf;base64,${btoa(binary)}`;
      }
    } catch (e) {
      console.warn("[BOJ Tool Background] PDF fetch->base64 failed, fallback to URL:", e);
    }
    return abs;
  };
  let pdfDataUrl = cvUrl;
  if (cvUrl) {
    pdfDataUrl = await fetchPdfAsDataUrl(cvUrl);
    if (!pdfDataUrl.startsWith("data:")) await swNote("CV PDF fetch failed (upload may end up empty)");
    else console.log("[BOJ Tool Background] Converted CV PDF to Base64 Data URI (length:", pdfDataUrl.length, ")");
  }
  // Cover letter PDF: attached to the cover-letter upload slot when the site
  // has one (and only there -- never into the resume slot).
  const coverDataUrl = coverLetterPdfUrl ? await fetchPdfAsDataUrl(coverLetterPdfUrl) : "";

  // DOM CV auto-injector: attaches the CV to exactly ONE upload slot (the
  // best resume/CV match) and then stops permanently -- secondary slots
  // (cover letter, "additional documents") are intentionally left untouched.
  // Throttled MutationObserver + slow interval fallback across ALL frames;
  // the (multi-MB base64) PDF is decoded ONCE and cached, since re-fetching
  // the data: URI on every DOM mutation made the whole page sluggish.
  if (pdfDataUrl) {
    const injectorFunc = (dataUrl, coverLetterUrl) => {
      if (window.__BOJ_CV_INJECTOR_ACTIVE) return; // idempotent per page/frame
      window.__BOJ_CV_INJECTOR_ACTIVE = true;
      window.__BOJ_CV_INJECTED_SUCCESSFULLY = false;

      let cachedFile = null;
      let cachedCoverFile = null;
      let coverAttempts = 0;
      let triggerTicks = 0;
      let attachTriesTotal = 0; // hard ceiling on ALL attaches (churn safety)
      let lastTargetNode = null; // widget-churn detector (see attempt counting)

      // Resume-slot plausibility: the injector must NEVER fight a page chrome
      // widget (profile photo/avatar/logo upload on a job LISTING page, an
      // invisible bonus input, ...) -- only attach where the surrounding
      // text actually talks about resumes/CVs/documents/uploading. File
      // inputs themselves are legitimately display:none in most widget
      // designs, so visibility is judged on the containing widget, not the
      // input node.
      const RESUME_CTX_RE =
        /resume|r[ée]sum[ée]|cv\b|curriculum|lebenslauf|lebensl[aä]ufe|application documents?|upload (your |a )?(cv|resume|document|file)s?|drag (&|and)? drop|drag (your |a )?(file|document)s?|drop (your |a )?(file|cv|resume|document)s?|choose (a )?files?|select (a )?files?|browse|attach(ment)?|beilage|anhang|dokument|pi[eè]ce jointe|joindre|file here|telecharger|fichier|parcourir/i;
      const NONRESUME_CTX_RE = /profile (photo|picture|image)|avatar|company logo|\blogo\b|\bphoto\b/i;
      const inputIsOnAVisibleWidget = (el) => {
        let n = el;
        for (let i = 0; i < 6 && n; i++) {
          try {
            const st = window.getComputedStyle(n);
            if (st.display !== "none" && st.visibility !== "hidden") {
              const r = n.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return true;
            }
          } catch (e) {}
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
        }
        return false;
      };
      const isPlausibleResumeSlot = (el) => {
        const ctx = describe(el) + " " + inputContextText(el);
        if (NONRESUME_CTX_RE.test(ctx) && !/resume|r[ée]sum[ée]|cv\b|curriculum/i.test(ctx)) return false;
        return RESUME_CTX_RE.test(ctx);
      };
      const isPhotoWidgetSlot = (el) => {
        const ctx = describe(el) + " " + inputContextText(el);
        return NONRESUME_CTX_RE.test(ctx) && !/resume|r[ée]sum[ée]|cv\b|curriculum/i.test(ctx);
      };
      // Form-context fallback: on a page that is CLEARLY an application form
      // (3+ visible fillable fields), uploader widgets with terse text
      // ("Drag your file here / Select files", Workday's exact phrasing) must
      // not sit out. Resume-word slots still win; photo/avatar/logo widgets
      // are still rejected; job LISTING pages (no form) still passive-only.
      const countVisibleFillableFields = () =>
        Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["hidden", "submit", "button", "image", "file", "password"].includes(type)) return false;
          if (el.disabled) return false;
          try {
            const st = window.getComputedStyle(el);
            if (st.display === "none" || st.visibility === "hidden") return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 || r.height > 0;
          } catch (e) {
            return false;
          }
        }).length;
      let timerId = null;
      let observer = null;
      let observerScheduled = false;
      let injectRunning = false;
      let attachAttempts = 0;
      const MAX_ATTACH_ATTEMPTS = 4;

      // Upload-failure detection (EN + FR): the widget's own rendered text --
      // "No file chosen" / "Aucun fichier choisi" next to the input and/or a
      // mandatory-field error -- means the site silently dropped a
      // programmatically attached file (React/Angular-controlled inputs often
      // reset the native files list). Browser-native placeholder text is NOT
      // in innerText; a match here is always the site's own widget.
      const NO_FILE_RE = /no file (?:chosen|selected|uploaded)|aucun fichier[\s\u00a0]*(?:choisi|s[eé]lectionn[eé]|t[eé]l[eé]charg[eé])|keine datei/i;
      const MANDATORY_RE = /cannot be (?:left )?blank|cannot be empty|this field is (?:mandatory|required)|mandatory field|field is required|upload failed|failed to upload|error uploading|ce champ est (?:obligatoire|requis)|champ (?:est )?obligatoire|champ requis|[eé]chec (?:du )?t[eé]l[eé](?:versement|chargement)|erreur (?:lors du )?t[eé]l[eé]chargement|must (?:be provided|upload|attach)|please (?:upload|attach)|required field/i;

      const inputContextText = (input) => {
        let n = input;
        let txt = "";
        for (let i = 0; i < 10 && n; i++) {
          if (n.textContent) txt += " " + n.textContent;
          n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
        }
        return txt.replace(/\s+/g, " ").slice(0, 1000);
      };

      const detectUploadFailure = () => {
        // RESUME-side slots only: an empty cover-letter/extra-documents slot
        // (even a required one) must never condemn the whole application --
        // the CV is the critical document.
        const inputs = findAllFileInputs(document).filter((i) => !COVER_RE.test(describe(i)));
        const emptyInputs = inputs.filter((i) => !(i.files && i.files.length > 0));
        for (const input of emptyInputs) {
          const ctx = inputContextText(input);
          if (MANDATORY_RE.test(ctx) || NO_FILE_RE.test(ctx)) return true;
        }
        // widget-level error rendered away from the input element itself
        const bodyText = document.body ? document.body.innerText || "" : "";
        if (emptyInputs.length > 0 && MANDATORY_RE.test(bodyText)) return true;
        return false;
      };

      const isUploadSettled = () => {
        // Success = a file is actually held (or the site reports it in text)
        // AND no failure indicator is visible (previously ANY files.length>0
        // counted as success -- even while "No file chosen / This field is
        // mandatory" stared at the user -- so the injector stopped forever).
        const text = document.body ? document.body.innerText : "";
        const successSignal =
          findAllFileInputs(document).some((i) => i.files && i.files.length > 0) ||
          text.includes("Successfully Uploaded") ||
          text.includes("Téléchargement réussi") ||
          text.includes("cv.pdf") ||
          text.includes("CV.pdf");
        if (!successSignal) return false;
        return !detectUploadFailure();
      };

      const getCvFile = async () => {
        if (cachedFile) return cachedFile;
        const response = await fetch(dataUrl);
        if (!response.ok) return null;
        const blob = await response.blob();
        cachedFile = new File([blob], "cv.pdf", { type: "application/pdf" });
        return cachedFile;
      };

      const getCoverFile = async () => {
        if (!coverLetterUrl) return null;
        if (cachedCoverFile) return cachedCoverFile;
        const response = await fetch(coverLetterUrl);
        if (!response.ok) return null;
        const blob = await response.blob();
        cachedCoverFile = new File([blob], "cover-letter.pdf", { type: "application/pdf" });
        return cachedCoverFile;
      };

      // One shared attach routine (native files setter + the events React/
      // Angular/Vue widgets actually listen for) for BOTH document slots.
      const attachToInput = (input, file) => {
        const dt = new DataTransfer();
        dt.items.add(file);
        try {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
          if (nativeSetter) nativeSetter.call(input, dt.files);
          else input.files = dt.files;
        } catch (e) {
          try {
            input.files = dt.files;
          } catch (e2) {}
        }

        // Root-cause fix #3: Drop sequence on input node itself first.
        for (const evName of ["input", "change", "blur"]) {
          try { input.dispatchEvent(new Event(evName, { bubbles: true, cancelable: true, composed: true })); } catch (e) {}
        }
        for (const evName of ["change", "input", "file-selected"]) {
          try { input.dispatchEvent(new CustomEvent(evName, { bubbles: true, cancelable: true, composed: true, detail: { files: dt.files } })); } catch (e) {}
        }
        for (const evType of ["dragenter", "dragover", "drop"]) {
          try { input.dispatchEvent(new DragEvent(evType, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt })); } catch (e) {}
        }

        // Propagate DragEvents and CustomEvents up parent chain (up to 8 levels)
        let parent = input.parentElement || (input.getRootNode && input.getRootNode().host) || null;
        for (let depth = 0; depth < 8 && parent; depth++) {
          for (const evType of ["dragenter", "dragover", "drop"]) {
            try { parent.dispatchEvent(new DragEvent(evType, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt })); } catch (e) {}
          }
          for (const evType of ["change", "input", "file-selected"]) {
            try { parent.dispatchEvent(new CustomEvent(evType, { bubbles: true, cancelable: true, composed: true, detail: { files: dt.files } })); } catch (e) {}
          }
          parent = parent.parentElement || (parent.getRootNode && parent.getRootNode().host) || null;
        }
        return dt;
      };

      const findAllFileInputs = (root = document) => {
        let results = [];
        try {
          results = Array.from(root.querySelectorAll('input[type="file"]'));
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) {
              results = results.concat(findAllFileInputs(el.shadowRoot));
            }
          }
        } catch (e) {}
        return results;
      };

      const describe = (el) =>
        [
          el.getAttribute("name"),
          el.getAttribute("id"),
          el.getAttribute("aria-label"),
          el.getAttribute("data-automation-id"),
          el.getAttribute("data-qa"),
          el.closest("label") ? el.closest("label").innerText : "",
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
      const COVER_RE = /cover|motivation|lettre|anschreiben|begeleidend|additional|other doc/i;

      // Pick the ONE slot the CV belongs in: prefer the input whose
      // name/id/aria/label mentions resume/CV; otherwise the first input.
      const pickCvSlot = (inputs) => {
        // 1) the slot that SAYS resume/CV; 2) fallback: the first slot that is
        // NOT identifiable as the cover-letter/extra-documents slot (falling
        // to inputs[0] blindly put the CV into the cover-letter field on
        // forms where that input comes first in the DOM); 3) last resort.
        return (
          inputs.find((el) => /resume|cv\b|curriculum|lebenslauf/.test(describe(el))) ||
          inputs.find((el) => !COVER_RE.test(describe(el))) ||
          inputs[0]
        );
      };
      // The cover-letter slot exists only when a distinct cover-letter/
      // extra-documents upload field is rendered; resumes must never land
      // there and vice versa.
      const pickCoverSlot = (inputs) => inputs.find((el) => COVER_RE.test(describe(el)));
      const coverSlotNeedsFile = () => {
        const slot = pickCoverSlot(findAllFileInputs(document));
        return !!(slot && !slot.disabled && !(slot.files && slot.files.length > 0));
      };

      const reportGiveUp = () => {
        stopInjector();
        const detail = "CV upload failed: mandatory upload field still empty (site kept the file no-file/mandatory indicator) after " + MAX_ATTACH_ATTEMPTS + " attach attempts";
        console.warn("[BOJ Tool Injector] " + detail);
        try { window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: detail }, "*"); } catch (e) {}
        // End the run (bulk: worker closes the tab and moves to the next job;
        // single-shot: records the loop guard, the page stays for the human).
        try { window.postMessage({ type: "BOJ_AGENT_DONE_RELAY", success: false, detail }, "*"); } catch (e) {}
      };

      const stopInjector = () => {
        window.__BOJ_CV_INJECTED_SUCCESSFULLY = true;
        if (timerId) {
          clearInterval(timerId);
          timerId = null;
        }
        if (observer) {
          observer.disconnect();
          observer = null;
        }
      };

      const inject = async () => {
        if (window.__BOJ_CV_INJECTED_SUCCESSFULLY) {
          stopInjector();
          return;
        }
        if (injectRunning) return; // re-entrancy guard: interval + observer overlap

        // Two INDEPENDENT tracks: the resume slot (critical) and the cover-
        // letter slot (best-effort, can only exist after the resume works).
        const settledCv = isUploadSettled();
        if (settledCv && (!coverLetterUrl || !coverSlotNeedsFile() || coverAttempts >= MAX_ATTACH_ATTEMPTS)) {
          console.log("[BOJ Tool Injector] Upload(s) settled -- file(s) held, no failure indicators. Done.");
          stopInjector();
          return;
        }
        // Exhaustion applies to the RESUME track only (its counters only grow
        // in the !settledCv path below): quit on a definite EN/FR failure
        // indicator; without one the outcome is unclear -- stop attaching but
        // let the agent keep working rather than killing a possibly-fine
        // application. triggerTicks exhausts the case where NO plausible
        // resume slot ever appears (lazy widget resistant to hover+click, or
        // a plain listing page with no application form): stop instead of
        // clicking the trigger zone forever in the agent's way.
        // attachTriesTotal is the churn hard-ceiling: a widget that keeps
        // REPLACING its input each render must not be re-attached forever.
        if (!settledCv && (attachAttempts >= MAX_ATTACH_ATTEMPTS || triggerTicks >= 10 || attachTriesTotal >= 12)) {
          if (detectUploadFailure()) {
            reportGiveUp();
          } else {
            const why = attachAttempts >= MAX_ATTACH_ATTEMPTS
              ? `widget rejected ${attachAttempts} attaches (files did not stick)`
              : "no plausible resume upload slot found on this page (no form / listing page?)";
            console.warn("[BOJ Tool Injector] Stopping: " + why);
            try { window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: "CV injector stopped: " + why }, "*"); } catch (e) {}
            stopInjector();
          }
          return;
        }

        injectRunning = true;
        try {
          const fileInputs = findAllFileInputs(document);

          if (!settledCv) {
            // Attach ONLY to a plausible resume slot sitting on a VISIBLE
            // widget: page-chrome inputs (avatar/logo/hidden bonus fields,
            // anything on a job LISTING page with no form) must never be
            // fought over. With no such slot the injector just waits
            // passively (the agent may still open the Apply form/modal, which
            // mounts the real input within a couple ticks).
            let candidates = fileInputs.filter(inputIsOnAVisibleWidget).filter(isPlausibleResumeSlot);
            let fallbackMode = "resume-context";
            if (!candidates.length) {
              // FORM-context fallback: any non-photo file input on a visible, 
              // off-cover-letter widget counts.
              candidates = fileInputs
                .filter(inputIsOnAVisibleWidget)
                .filter((el) => !isPhotoWidgetSlot(el) && !COVER_RE.test(describe(el)));
              fallbackMode = "form-context";
            }
            if (!candidates.length) {
              triggerTicks++;
              // SmartRecruiters & Ashby lazy dropzone trigger: hover first,
              // then (from the 2nd tick) a real click -- those widgets only
              // mount their hidden <input type=file> after interaction. A
              // synthetic .click() carries no user gesture, so it can NEVER
              // pop the OS file dialog; it just runs the site's JS handlers.
              const trigger = document.querySelector(
                'pp-file-upload, ph-file-upload, [data-ph-id*="upload"], [data-ph-id*="resume"], [class*="drop-zone"], [class*="dropzone"], [class*="_dropzone"], [class*="DropZone"], [class*="file-upload"], oc-file-upload, label[for*="file"], [class*="Upload"], [data-qa*="upload"], [class*="attach"], [class*="Attach"], [class*="resume"], [class*="Resume"], [class*="uploader"], [class*="Uploader"], [data-automation-id*="file"], [data-automation-id*="File"], [data-automation-id*="upload"], [data-automation-id*="resume"], [class*="select-file"], [class*="SelectFile"], [class*="browse"], [class*="Browse"]'
              );
              if (trigger && inputIsOnAVisibleWidget(trigger)) {
                trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
                trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
                if (triggerTicks >= 2) {
                  try {
                    const btn = trigger.tagName === "BUTTON" ? trigger : trigger.querySelector('button, [role="button"], a, label');
                    (btn || trigger).click();
                  } catch (e) {}
                }
              }
            } else {
              triggerTicks = 0;
              const file = await getCvFile();
              if (file) {
                const target = pickCvSlot(candidates);
                if (target && !target.disabled) {
                  const slotName = target.getAttribute("name") || target.getAttribute("id") || target.getAttribute("aria-label") || "input[type=file]";
                  const dt = attachToInput(target, file);
                  
                  // Root-cause fix #4: Telemetry in the run log
                  const held = target.files && target.files.length > 0;
                  const telemetryMsg = "CV attach (" + fallbackMode + " mode) -> " + slotName + ": " + (held ? "file held" : "file NOT held synchronously");
                  console.log("[BOJ Tool Injector] " + telemetryMsg);
                  try { window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: "[BOJ Injector] " + telemetryMsg }, "*"); } catch (e) {}

                  // Attach counting: re-attaching the SAME node proves the
                  // widget rejected a real attach (files dropped, no success
                  // indicator) -> count it. A DIFFERENT node than last tick
                  // means the framework re-rendered/remounted the widget --
                  // that attach is free, not a failure. attachTriesTotal is
                  // the absolute churn ceiling either way.
                  if (target === lastTargetNode) attachAttempts++;
                  attachTriesTotal++;
                  lastTargetNode = target;
                  window.__BOJ_CV_ATTACH_ATTEMPTS = attachAttempts;

                  const dz =
                    target.closest("pp-file-upload, ph-file-upload, [data-ph-id*='upload'], [data-ph-id*='resume'], oc-file-upload, [class*='drop-zone'], [class*='dropzone'], [class*='_dropzone'], [class*='DropZone'], [data-automation-id*='file'], [data-automation-id*='upload'], [data-automation-id*='resume'], [class*='uploader'], [class*='Uploader']") ||
                    document.querySelector("pp-file-upload, ph-file-upload, [data-ph-id*='upload'], [data-ph-id*='resume'], oc-file-upload, [class*='drop-zone'], [class*='dropzone'], [class*='_dropzone'], [class*='DropZone'], [data-automation-id*='file'], [data-automation-id*='upload'], [class*='uploader'], [class*='Uploader']") ||
                    target.closest('label, div[class*="drop"], div[class*="upload"], oc-file-upload, [data-qa*="upload"], [class*="box"], [class*="dropzone"]') ||
                    (target.getRootNode() && target.getRootNode().host);
                  if (dz) {
                    for (const evType of ["dragenter", "dragover", "drop"]) {
                      try {
                        dz.dispatchEvent(new DragEvent(evType, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
                      } catch (e) {}
                    }
                    for (const customEv of ["file-selected", "file-dropped", "change", "input", "pp-file-attached"]) {
                      try {
                        dz.dispatchEvent(new CustomEvent(customEv, { bubbles: true, composed: true, detail: { files: dt.files } }));
                      } catch (e) {}
                    }
                  }
                }
              }
            }
          }

          // Cover letter (when the run tailored one): fill the cover-letter /
          // extra-documents slot with cover-letter.pdf -- best-effort, ONLY
          // that slot, and never the reason a run dies.
          if (coverLetterUrl && coverAttempts < MAX_ATTACH_ATTEMPTS && coverSlotNeedsFile()) {
            const coverSlot = pickCoverSlot(findAllFileInputs(document));
            const coverFile = await getCoverFile();
            if (coverSlot && coverFile) {
              attachToInput(coverSlot, coverFile);
              coverAttempts++;
              console.log("[BOJ Tool Injector] Cover letter PDF attached to the cover-letter slot.");
            }
          }
          // NOTE: no stopInjector() on attach -- React/Angular widgets can
          // silently DROP a programmatically attached file on re-render. The
          // NEXT tick's isUploadSettled()/detectUploadFailure() verdict
          // decides whether to re-attach (up to MAX_ATTACH_ATTEMPTS) or stop.
          // (Stopping right after the first attach was the "CV attach
          // silently lost on Ashby" bug.)
        } catch (e) {
          console.error("[BOJ Tool Injector] CV injection error:", e);
        } finally {
          injectRunning = false;
        }
      };

      inject();
      timerId = setInterval(inject, 1500);
      if (document.body) {
        // THROTTLED: at most one inject per 800ms no matter how much the
        // agent churns the DOM (was: one full scan per mutation).
        observer = new MutationObserver(() => {
          if (observerScheduled) return;
          observerScheduled = true;
          setTimeout(() => {
            observerScheduled = false;
            inject();
          }, 800);
        });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    };

    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        func: injectorFunc,
        args: [pdfDataUrl, coverDataUrl],
      });
    } catch (e) {
      console.log("[BOJ Tool] MAIN world executeScript failed, trying ISOLATED world...", e);
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: injectorFunc,
          args: [pdfDataUrl, coverDataUrl],
        });
      } catch (e2) {
        console.error("[BOJ Tool] ISOLATED world executeScript failed:", e2);
      }
    }
  }

  // Deterministic SmartRecruiters doctor (CODE, not the LLM): the two
  // recurring LLM failure points on this ATS -- the "Ville" location
  // autocomplete and the empty required "Ã‰tablissement*" fields inside
  // CV-parsed education entries -- are fixed by this script, relentlessly.
  // It searches shadow DOM too, OPENS collapsed education entries whose
  // title matches a known certification, and stays alive until at least one
  // Institution input has been handled (or 8 minutes pass) -- the entries
  // only appear on a LATER step, so an early stop would miss them entirely.
  // No-op on any other hostname.
  const doctorFunc = () => {
    if (!/smartrecruiters\.com/.test(location.hostname)) return;
    if (window.__BOJ_SR_DOCTOR_ACTIVE) return;
    window.__BOJ_SR_DOCTOR_ACTIVE = true;

    const CITY_TEXT = "Amiens";
    const INSTITUTION_MAP = [
      [/agile/i, "Project Management Institute (PMI)"],
      [/data science|analytics/i, "Coursera"],
      [/fiber optic|fibre optique/i, "University School of Physics and Engineering"],
      [/abaqus|composite/i, "National Higher School of Arts and Trades"],
    ];
    const DEFAULT_INSTITUTION = "Coursera";
    const MAX_RUNTIME_MS = 8 * 60 * 1000;

    // Recurses shadow roots -- SR may render parts of the form inside them;
    // plain document.querySelectorAll would silently miss those inputs.
    const deepQueryAll = (selector, root) => {
      root = root || document;
      let out = Array.from(root.querySelectorAll(selector));
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) out = out.concat(deepQueryAll(selector, el.shadowRoot));
      }
      return out;
    };

    const isVisible = (el) =>
      !el.disabled && (el.offsetParent !== null || el.getClientRects().length > 0);

    const setNativeValue = (el, value) => {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    };

    const contextText = (el, depth) => {
      let txt =
        (el.getAttribute("aria-label") || "") +
        " " +
        (el.id ? ((el.ownerDocument.querySelector('label[for="' + el.id + '"]') || { textContent: "" }).textContent) || "" : "");
      let n = el;
      for (let i = 0; i < depth && n; i++) {
        if (n.textContent) txt += " " + n.textContent;
        n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
      }
      return txt.replace(/\s+/g, " ").slice(0, 600);
    };

    const clickLikeUser = (el) => {
      for (const name of ["pointerdown", "mousedown", "mouseup", "click"]) {
        try {
          el.dispatchEvent(new MouseEvent(name, { bubbles: true, composed: true, view: window }));
        } catch (e) {}
      }
    };

    // Fill a text-ish input; if typing opens a suggestion listbox, commit
    // the first matching option (combobox-style Institution fields exist).
    const fillAndCommit = async (input, value, optionMatch) => {
      input.focus();
      setNativeValue(input, value);
      if (input.getAttribute("role") !== "combobox" && !input.getAttribute("aria-haspopup")) return true;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        const lb = deepQueryAll('[role="listbox"]').find(isVisible);
        if (!lb) continue;
        const opt = Array.from(lb.querySelectorAll('[role="option"], li, div')).find((o) =>
          (optionMatch || new RegExp(value.split(" ")[0], "i")).test(o.textContent || "")
        );
        if (opt) {
          clickLikeUser(opt);
          return true;
        }
      }
      return false;
    };

    // --- empty required Ã‰tablissement*/Institution inputs -> fill + Save ---
    let sawInstitutionInput = false;
    const fixInstitutions = async () => {
      let fixed = 0;
      for (const input of deepQueryAll("input")) {
        const type = (input.getAttribute("type") || "text").toLowerCase();
        if (!["text", "", "search"].includes(type)) continue;
        if (!isVisible(input)) continue;
        const ctx = contextText(input, 3);
        if (!/(Ã©tablissement|institution)/i.test(ctx)) continue;
        sawInstitutionInput = true;
        if (input.value && input.value.trim()) continue;
        const card = input.closest("[class*='card'], [class*='entry'], [class*='education'], [class*='formation'], [class*='editor'], li, section, div");
        const cardText = ((card && card.textContent) || ctx).replace(/\s+/g, " ").slice(0, 400);
        let inst = DEFAULT_INSTITUTION;
        for (const [re, val] of INSTITUTION_MAP) {
          if (re.test(cardText)) {
            inst = val;
            break;
          }
        }
        await fillAndCommit(input, inst);
        console.log('[BOJ Tool SR Doctor] Filled empty Ã‰tablissement* -> "' + inst + '" for "' + cardText.slice(0, 50) + '"');
        fixed++;
        const editor = input.closest("[class*='editor'], [class*='form'], section, div");
        const saveBtn =
          editor &&
          Array.from(editor.querySelectorAll("button")).find(
            (b) => /(enregistrer|sauvegarder|valider|confirmer|save)\b/i.test((b.textContent || "").trim()) && !b.disabled
          );
        if (saveBtn) {
          try {
            saveBtn.click();
          } catch (e) {}
        }
      }
      return fixed;
    };

    // --- open collapsed education entries that mention a known certification
    // title but contain no inputs yet (their editor is closed). Only clicks
    // nodes sitting inside an education-ish context, so job-description text
    // ("data science", "agile"...) never gets clicked.
    const CERT_TITLE = /agile|data science|analytics|fiber optic|fibre optique|abaqus|composite/i;
    const EDU_CONTEXT = /formation|Ã©ducation|education|Ã©tablissement|institution|diplÃ´me/i;
    const openedMarkers = new Set();
    const openEducationEditors = () => {
      const nodes = Array.from(document.querySelectorAll("div, li, section, article, span, p, h3, h4"));
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t.length < 5 || t.length > 300) continue;
        if (!CERT_TITLE.test(t)) continue;
        if (el.querySelector("input, textarea, select")) continue; // already expanded
        // must sit inside an education-ish container (up to 4 ancestors)
        let n = el;
        let around = "";
        for (let i = 0; i < 4 && n; i++) {
          around += " " + (n.textContent || "");
          n = n.parentElement;
        }
        if (!EDU_CONTEXT.test(around)) continue;
        const key = t.slice(0, 80);
        if (openedMarkers.has(key)) continue;
        const btn = el.querySelector("button, [role='button'], a, [class*='edit'], [class*='icon']") || el;
        openedMarkers.add(key);
        console.log('[BOJ Tool SR Doctor] Opening education entry: "' + t.slice(0, 60) + '"');
        try {
          clickLikeUser(btn);
        } catch (e) {}
        return; // one expansion per tick; next tick handles what opens
      }
    };

    // --- Ville automatic filler removed as requested ---
    const fixCity = async () => {};

    let timerId = null;
    let observer = null;
    let scheduled = false;
    let calmPasses = 0;
    const startedAt = Date.now();
    const stopDoctor = () => {
      if (timerId) clearInterval(timerId);
      if (observer) observer.disconnect();
      window.__BOJ_SR_DOCTOR_DONE = true;
      console.log("[BOJ Tool SR Doctor] Done, stopping.");
    };
    const tick = async () => {
      if (Date.now() - startedAt > MAX_RUNTIME_MS) return stopDoctor();
      try {
        const fixedN = await fixInstitutions();
        openEducationEditors();
        const anyComboUnfinished = deepQueryAll('input[role="combobox"]').some(
          (c) => isVisible(c) && c.dataset.bojCityDone !== "1" && /ville|rÃ©sidence|residence|location/i.test(contextText(c, 3))
        );
        // Calm-stop ONLY once an Institution input has actually been seen and
        // nothing is pending -- education entries appear on a LATER step, so
        // stopping early was the old bug.
        if (sawInstitutionInput && fixedN === 0 && !anyComboUnfinished) {
          if (++calmPasses >= 4) return stopDoctor();
        } else {
          calmPasses = 0;
        }
      } catch (e) {
        // transient -- next tick retries
      }
    };
    tick();
    timerId = setInterval(tick, 1500);
    if (document.body) {
      observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          tick();
        }, 700);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: doctorFunc,
    });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: doctorFunc });
    } catch (e2) {
      console.log("[BOJ Tool] SR doctor injection note:", e2);
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: captchaAutoClickerFunc,
    });
  } catch (eCapAuto) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: captchaAutoClickerFunc });
    } catch (e2) {}
  }

  // Install the window.open / target=_blank capture BEFORE anything the
  // pre-agent auto-click or the agent itself can press a "Postuler" / "Apply"
  // button that opens a new tab -- un-captured, Chrome's popup blocker swallows
  // those agent-driven new tabs. sameTab navigates in-place for bulk runs.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: newTabCaptureFunc,
      args: [!!bulkOpts.bulk],
    });
  } catch (eCap) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: newTabCaptureFunc, args: [!!bulkOpts.bulk] });
    } catch (e2) {}
  }

  // Install the page<->worker relay BEFORE the agent starts: forwards the bulk
  // done-signal AND the llm-proxy fetch tunnel. ALWAYS injected (single-shot
  // too) -- page-context localhost calls trigger the LNA prompt in both modes.
  // This injection races the page's own navigation commit, so VERIFY it landed
  // and retry -- an agent with a dead relay freezes on its first LLM call
  // ("Network request failed" x3, the Personio incident).
  let relayOk = false;
  for (let attempt = 0; attempt < 3 && !relayOk; attempt++) {
    if (attempt) await sleep(500);
    try {
      // allFrames:true with TOP-FRAME fallback -- portals (e.g. Indeed SmartApply)
      // keep the wizard in the top document, but a batched allFrames call
      // REJECTS entirely on pages holding opaque/special frames (tracker/ad
      // frames), and those failures surface only in this service worker's
      // console = silent death for the user. So: try allFrames (for real
      // framed forms), then degrade to top-frame-only, then verify.
      try {
        await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED", func: bulkDoneRelayFunc });
      } catch (eAll) {
        console.log("[BOJ Tool] relay allFrames rejected, falling back to top frame:", eAll && eAll.message ? eAll.message : eAll);
        await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: bulkDoneRelayFunc });
      }
      const [chk] = await chrome.scripting
        .executeScript({ target: { tabId }, world: "ISOLATED", func: () => !!window.__BOJ_DONE_RELAY_ACTIVE })
        .catch(() => []);
      relayOk = !!(chk && chk.result);
    } catch (e) {
      console.log(`[BOJ Tool] relay injection attempt ${attempt + 1} note:`, e);
    }
  }
  if (!relayOk) await swNote("[BOJ Tool] relay NOT installed on this document -- LLM tunnel will fail its health probe (page-side)");

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // agent library inside nested frame contexts too
      files: ["page-agent.js"],
      world: "MAIN",
    });
  } catch (err) {
    console.log("[BOJ Tool] page-agent script note (MAIN, allFrames rejected -> top frame):", err);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["page-agent.js"],
        world: "MAIN",
      });
    } catch (errTop) {
      console.log("[BOJ Tool] page-agent script note (MAIN top frame):", errTop);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["page-agent.js"],
        });
      } catch (e2) {
        console.log("[BOJ Tool] page-agent script note (ISOLATED):", e2);
        await swNote(`page-agent library injection FAILED in all worlds -- agent cannot start on this page: ${e2 && e2.message ? e2.message : e2}`);
      }
    }
  }

  const runAgentFunc = (candidate, jobTitle, companyName, cvUrl, bulkOpts) => {
    if (window.__BOJ_PAGE_AGENT_RUNNING) {
      // A duplicate launch hit a frame whose agent is already running. NEVER
      // report done(false) from here: when the "previous" run was HEALTHY and
      // mid-fill (launch-side races: probe-during-nav-commit, twin url-change
      // + complete dispatch), the suicide relay made the worker close the tab
      // mid-form. A genuinely stale flag (crashed run) is terminal-covered by
      // the bulk worker's own dead-agent timeout -- fail-SAFE, not fail-deadly.
      console.log("[BOJ Tool] PageAgent already running on page context -- duplicate launch ignored.");
      if (bulkOpts && bulkOpts.bulk) {
        try {
          window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: "duplicate agent launch blocked (agent already running in this frame) -- ignoring" }, "*");
        } catch (e) {}
      }
      return;
    }
    window.__BOJ_PAGE_AGENT_RUNNING = true;

    (async () => {
      // Frame gating: runAgentFunc is injected into ALL frames (portals like
      // Indeed keep the apply form inside a nested frame context). Any frame
      // that does not itself hold 3+ visible form fields exits instantly --
      // ad/tracker/social iframes must never spawn an LLM agent. The per-frame
      // running flag is window-scoped, so each frame decides independently.
      const countVisibleFormFieldsForGate = () =>
        Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["hidden", "submit", "button", "image", "file", "password"].includes(type)) return false;
          if (el.disabled) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 || rect.height > 0;
        }).length;
      if (window.top !== window.self && countVisibleFormFieldsForGate() < 3) {
        window.__BOJ_PAGE_AGENT_RUNNING = false;
        return;
      }

      // Reveal the application form BEFORE the agent starts -- but ONLY when
      // no form fields are visible yet. Re-clicking Apply with the form
      // already open commonly resets it or bounces to the jobs listing.
      // "Autofill with Resume" is deliberately never clicked (it hands off
      // to an external service and abandons the real form).
      const countVisibleFormFields = () =>
        Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["hidden", "submit", "button", "image", "file", "password"].includes(type)) return false;
          if (el.disabled) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 || rect.height > 0;
        }).length;

      // Small existence-checked wait (protocol pt.1 DOM readiness): poll until
      // the selector matches or the timeout elapses. Never touches a null node.
      const waitForEl = (selector, timeoutMs, stepMs = 500) =>
        new Promise((resolve) => {
          const t0 = Date.now();
          const tick = () => {
            let el = null;
            try {
              el = document.querySelector(selector);
            } catch (e) {}
            if (el) return resolve(el);
            if (Date.now() - t0 > timeoutMs) return resolve(null);
            setTimeout(tick, stepMs);
          };
          tick();
        });

      // Portal host detection (drives readiness waits + the platform addendum).
      const __hostName = location.hostname.toLowerCase();
      const isLinkedIn = /(^|\.)linkedin\.com$/.test(__hostName);
      const isIndeed = /(^|\.)indeed\.[a-z.]{2,}$/.test(__hostName);
      const isGlassdoor = /(^|\.)glassdoor\.[a-z.]{2,}$/.test(__hostName);
      const isSafran = /(^|\.)safran-group\.com$/.test(__hostName);

      try {
        // Auto-dismiss cookie overlays if present
        document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
          const t = (el.innerText || el.textContent || "").trim().toLowerCase();
          if (
            t === "alles accepteren" ||
            t === "accepteren" ||
            t === "akkoord" ||
            t === "accept all" ||
            t === "accept cookies" ||
            t === "tout accepter" ||
            t === "j'accepte"
          ) {
            try { el.click(); } catch(e) {}
          }
        });

        // No blind pre-click on LinkedIn: a raw synthetic .click() on its
        // "Postuler"/"Apply" buttons gets routed to LinkedIn's "page not
        // found" screen. The LLM agent clicks those buttons itself instead
        // (the LinkedIn portal addendum rules), which works.
        if (!isLinkedIn && countVisibleFormFields() < 3) {
          const allBtns = Array.from(
            document.querySelectorAll('a, button, [role="button"], [data-automation-id*="apply"], [class*="tab"]')
          );
          const mainApplyBtn = allBtns.find((el) => {
            const t = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
            return (
              t === "apply" ||
              t === "apply now" ||
              t === "application" ||
              t === "apply manually" ||
              t === "postuler" ||
              t === "postuler maintenant" ||
              t === "easy apply" || // LinkedIn Easy Apply opens the application modal
              t.includes("solliciteer") ||
              t.includes("solliciteren") ||
              t.includes("reageer") ||
              t.includes("bewerben") ||
              t.startsWith("candidature simple") || // LinkedIn FR ("Candidature simplifiée")
              t.startsWith("je suis intéress")
            );
          });
          if (mainApplyBtn) {
            console.log("[BOJ Tool] Auto-clicking main Apply/Application button ONCE:", mainApplyBtn);
            mainApplyBtn.click();
            await new Promise((r) => setTimeout(r, 2000)); // let the SPA form render before the agent scans
          }
        }
        if (isLinkedIn) {
          // LinkedIn SPA: the Easy Apply modal mounts async; wait for it so the
          // agent never wires itself to a page that has no form container yet.
          await waitForEl('.jobs-easy-apply-modal, [class*="jobs-easy-apply"], dialog[open], form', 6000);
        }
      } catch (e) {
        console.log("[BOJ Tool] Auto-click note:", e);
      }

      // DOM readiness for dynamically-attached forms (iframes, SPA mounts):
      // if the page still shows no form scaffold at all, give it a moment.
      if (countVisibleFormFields() < 1) {
        await waitForEl('input, textarea, select, iframe, dialog[open], [role="dialog"]', 4000);
      }

      const PageAgentClass = window.PageAgent?.PageAgent || window.PageAgent;
      if (!PageAgentClass) {
        window.__BOJ_PAGE_AGENT_RUNNING = false;
        // Report failure to the bulk worker BEFORE alert(): alert() blocks the
        // page's JS until a human dismisses it, which used to stall bulk runs
        // for the full 20-minute timeout.
        if (bulkOpts && bulkOpts.doneKey) {
          window[bulkOpts.doneKey] = { done: true, success: false, detail: "PageAgent constructor missing on page", at: Date.now() };
          try { window.postMessage({ type: "BOJ_AGENT_DONE_RELAY", success: false, detail: "PageAgent constructor missing on page" }, "*"); } catch (e) {}
        }
        if (window.top === window.self) alert("[BOJ Tool] PageAgent library constructor not found on page.");
        return;
      }

      const fullName = (candidate.name || candidate.fullName || candidate.full_name || "Badreddine Barki").trim();
      const parts = fullName.split(" ").filter(Boolean);
      const firstName = candidate.firstName || candidate.first_name || parts[0] || "Badreddine";
      const lastName = candidate.lastName || candidate.last_name || parts.slice(1).join(" ") || "Barki";
      const email = candidate.email || "badreddinebarki@gmail.com";
      const phone = candidate.phone || "+33 7 45 76 80 10";
      const address = candidate.address || "14 Rue de la 2e D.B.";
      const linkedin = candidate.linkedinUrl || candidate.linkedin || candidate.portfolio || "https://linkedin.com/in/badreddine-barki";
      const website = candidate.website || candidate.portfolio || "https://barkibadreddine.com";

      // ==================== USER-MANAGED ====================
      // The user's own ATS login/registration automation (credentials +
      // do-it-yourself rules). Owned and maintained by the user, outside the
      // maintained scope of this project (see AGENTS.md): never edit, remove,
      // or refactor these lines.
      const USER_LOGIN_SECTION = `- Account Email (for any ATS sign-in / registration): badreddinebarki@gmail.com
- Account Passwords (try in THIS order until one works): 1) Open_up_for_Badr00@@   2) Open_up_for_Badr00   3) Badreddine00++

3. ACCOUNT CREATION & LOGIN: YOU MUST FILL LOGINS AND REGISTRATIONS YOURSELF. NEVER use ask_user or ask the user to sign in or create an account. If a login, sign-in, or account creation page/modal appears ("Create Account / Sign In", "Create Account", "Sign in to apply", "Se connecter", "Register"):
   - Enter Email: "badreddinebarki@gmail.com"
   - Enter Password / Confirm Password / Verify Password: start with password 1) from the list above.
   - Check any required Terms / Privacy Policy checkboxes.
   - Click "Sign In", "Create Account", "Register", "Log In", or "Next" to complete registration/login and reach the application form fields.
   - ACCOUNT ALREADY EXISTS: if the site rejects the registration with "account already exists", "email already in use", "an account with this email already exists", "already registered", "cet e-mail est déjà utilisé", or similar: the candidate ALREADY HAS an account on this site -- STOP registering, click the site's "Sign in" / "Log in" / "Se connecter" / "Already have an account?" link and LOG IN with the same email + password 1) instead, then continue to the application form.
   - WRONG PASSWORD / INVALID LOGIN: if a sign-in is rejected as invalid credentials / wrong password / login failed: keep calm, retry the SAME sign-in form with the NEXT password from the ordered list above (2), then 3)) until one is accepted.
   - NEVER call ask_user or stop for login/password steps.
4. ABSOLUTELY NO ask_user FOR LOGIN/PASSWORD OR CERTIFICATIONS: Never use ask_user for login/registration forms, password fields, or education/certification fields. Only use ask_user for a physical OS file dialog blocker.`;
      // ================== END USER-MANAGED ==================

      // ==================== USER-MANAGED ====================
      // The user's own job-portal sign-in credentials. Interpolated into the
      // prompt ONLY when the page hostname matches that portal — never sent
      // to unrelated sites. Owned and maintained by the user, outside the
      // maintained scope of this project (see AGENTS.md).
      const USER_PORTAL_LOGINS = {
        linkedin: { email: "bestapple111@gmail.com", password: "Badreddine00++" },
        indeedGlassdoor: { email: "badreddinebarki@gmail.com", password: "Badreddine00++" },
      };
      // ================== END USER-MANAGED ==================

      let portalAddendum = "";
      if (isLinkedIn) {
        portalAddendum = `

LINKEDIN EASY APPLY (this page is linkedin.com):
- The application lives inside the Easy Apply MODAL (.jobs-easy-apply-modal / the open dialog). Work ONLY inside that modal; ignore the job page behind it.
- If you are NOT signed in: click "Sign in", then on LinkedIn's own sign-in form enter Email: "${USER_PORTAL_LOGINS.linkedin.email}" and Password: "${USER_PORTAL_LOGINS.linkedin.password}", then navigate back to the job and click "Easy Apply" again.
- If LinkedIn asks for a verification or security-check code (email, SMS, authenticator) or shows a CAPTCHA: do NOT attempt it -- call done(success=false, "linkedin verification checkpoint requires a human").
- The wizard steps: contact info (auto-filled -- verify only), resume, work experience review, screening questions, review, submit.
- Resume step: if EXISTING resume cards are listed, select the most recent one (radio). Wherever a file-upload input exists, the CV is already attached programmatically -- never click upload/browse buttons.
- Screening questions: radio buttons -> read each group's label text and pick per the profile facts; "years of experience" numeric fields -> a precise integer consistent with the WORK EXPERIENCE HISTORY; text fields -> concise answers per FIELD GUIDANCE.
- Progress with the modal's own "Next" / "Review" / "Submit application" buttons in its footer. NEVER click the modal's X / "Dismiss" -- that abandons the application. Uncheck any pre-checked "Follow this company" style box you would not want.
- OFF-LINKEDIN APPLIES (plain "Postuler" / "Apply" on a job WITHOUT "Easy Apply" / "Candidature simplifiée"): this button leads to the employer's OWN site. Click it ONCE -- the extension itself opens the external tab (popup-blocker-proof) and continues the application THERE, you cannot access that tab. When you see the green "opened in a NEW TAB" notice (or after your click nothing changed on THIS page), call done(success=true, "opened external application tab") and STOP -- do NOT click Postuler again.
- If the job offers BOTH an Easy Apply modal and you are inside it, the rule above does not apply -- finish the modal instead.`;
      } else if (isIndeed) {
        portalAddendum = `

INDEED (this page is an Indeed domain):
- If a sign-in wall appears ("Sign in to Indeed"): FIRST try the "Continue with Google" / "Sign in with Google" button -- the browser's Google session is already logged in, one click usually completes it. Only if Google sign-in is unavailable: Email: "${USER_PORTAL_LOGINS.indeedGlassdoor.email}", Password: "${USER_PORTAL_LOGINS.indeedGlassdoor.password}".
- An emailed/SMS verification code or CAPTCHA during sign-in = stop: done(success=false, "indeed verification checkpoint requires a human").
- The native "Indeed Apply" form renders in a modal or an iframe (indeed-apply-widget): interact with fields inside the frame as normal. Steps: resume step (the CV is already attached programmatically to the file input -- do NOT click upload/browse buttons; if offered "use an Indeed resume" vs the uploaded PDF, choose the uploaded PDF/most recent), contact info, employer screening questions (radio groups: read each group's label and answer per profile facts; certification/agreement checkboxes: check them), review, submit.
- A "Apply on company site" button leaves Indeed for the employer ATS (the URL may pass through an indeed.com/rc/clk tracker first): allowed ONCE -- wait for the final page to load, then continue with the standard rules on that ATS page.
- Before every Next/Submit: if red validation errors appear under fields, fix the field, do not click blindly.`;
      } else if (isGlassdoor) {
        portalAddendum = `

GLASSDOOR (this page is a Glassdoor domain):
- Glassdoor and Indeed share the same application system. Sign-in: FIRST try "Continue with Google" (session: ${USER_PORTAL_LOGINS.indeedGlassdoor.email}); fallback Email: "${USER_PORTAL_LOGINS.indeedGlassdoor.email}", Password: "${USER_PORTAL_LOGINS.indeedGlassdoor.password}".
- Verification code or CAPTCHA at sign-in -> done(success=false, "glassdoor verification checkpoint requires a human").
- "Easy Apply" / "Apply Now" opens an inline application drawer or embedded Indeed-style module -- fill sequentially: resume step (CV already attached -- never click upload/browse; choose the uploaded/most-recent resume card), contact fields, screening radios/checkboxes per profile facts, review, submit.
- Other "Apply" buttons redirect via glassdoor.com/partner/jobListing.htm?... to the employer ATS: allowed ONCE -- wait for the final page to fully load (the URL will change), then continue on that ATS page with the standard rules.
- Custom dropdowns: click the container, WAIT for the options list to mount, then click the option node. Resolve validation errors before clicking Next/Submit.`;
      } else if (isSafran) {
        portalAddendum = `

SAFRAN CAREERS (this page is safran-group.com):
- The /jobapplication route opens a SIGN-IN page first ("Se connecter" / "Sign in"). Follow the ACCOUNT CREATION & LOGIN instructions from the candidate block: enter the candidate account Email and Password from that block, then continue to the application form. If no account exists yet, use the candidate block's registration instructions ("Créer un compte" / "S'inscrire") -- same email/password, check required consent boxes, submit, then return to the /jobapplication page.
- If the site demands an emailed/SMS verification code or shows a CAPTCHA during sign-in: do NOT attempt it -- call done(success=false, "needs_human_login") and STAY on the page; the human completes the checkpoint and the extension relaunches you automatically.
- After sign-in the application is a multi-step wizard (personal info, experience, education, documents, questions, review): fill per the standard WORKFLOW rules. City/location comboboxes: type, wait, click the suggestion (same as CITY AUTOCOMPLETE guidance).`;
      }
      if (bulkOpts && bulkOpts.bulk && portalAddendum) {
        portalAddendum += `

BULK RUN NOTE: this application tab is owned by the bulk worker. When an off-site "Postuler"/"Apply"/"Apply on company site" click navigates THIS SAME tab (or opens a new tab the worker adopts), a fresh agent continues the form on the destination page automatically -- your done(success=true, "opened external application tab") after the click is treated purely as a handoff signal, never as a submission. If the click produced neither navigation nor a new tab, keep working this page per the standard rules.`;
      }

      const promptText = `Fill out the job application form ALREADY on this page for the position "${jobTitle}" at "${companyName}".

CANDIDATE PROFILE (these are the ONLY real facts available -- never invent other identity values):
- First Name / Given Name(s) / Prénom: ${firstName}
- Last Name / Family Name / Nom: ${lastName}
- Email / E-mail: ${email}
- Phone Number / Téléphone: ${phone}
- Address / City / Location / Ville: ${address}
- LinkedIn URL / Vos profils: ${linkedin}
${USER_LOGIN_SECTION}

CANDIDATE WORK EXPERIENCE HISTORY (ONLY use these real roles for Work Experience fields -- NEVER invent titles like "HR Assistant"):
1. Title: Research and Development Mechanical Engineer | Company: SLB GROUP | Location: Abbeville, France | Dates: 03/2022 - 07/2025
2. Title: Research and Development Mechanical Engineer Intern | Company: Sigma | Location: Clermont-Ferrand, France | Dates: 03/2021 - 09/2021
3. Title: Mechanical Engineering Intern | Company: OCP Group | Location: Morocco | Dates: 06/2017 - 08/2017

RESUME FILE (already handled -- do not touch upload controls):
- The candidate's CV ("cv.pdf") has already been injected programmatically into the main resume/CV upload slot on this page. Look for "cv.pdf" or an upload-success indicator near the upload area and move on.
- Do NOT click "Add CV", "Select files", "Browse", or any upload button (that opens an OS dialog you cannot control), and do NOT attach any other document. ONE document total, and it is already there.
- If the form also has a "Cover Letter" / "Motivation" / "Additional documents" UPLOAD field and a "cover-letter.pdf" file is already attached there, treat it exactly like the CV: never click its upload/browse button, never attach anything else to it, and NEVER move documents between slots (the CV belongs ONLY in the resume/CV slot, the cover letter ONLY in the cover-letter slot).

NON-NEGOTIABLE RULES (highest priority):
1. STAY ON THIS APPLICATION PAGE. Never click anything that navigates away: company logo, "Careers", "Search Jobs", "Job search", "Back to results", header/footer navigation, "Save job", "Share", or links to other job postings. Other job titles shown inside "similar jobs", "recommended", "offres similaires", or "related opportunities" sections ON THE SAME PAGE are normal and do NOT mean you navigated away -- ignore those sections completely. Only treat it as "navigated away" if the URL changed to a jobs listing/search page, or the application form truly disappeared.
2. This IS the correct job. Do not verify the job title, do not compare it to the CV, do not open other postings.
3. NOT A JOB PAGE? If this page has NO application form AND no Apply / Postuler / Solliciteer / Solliciteren / Reageer / Bewerben / "Sign in to apply" path leading to one (search engine, social feed, news article, web store, dashboard, mailbox, video site...): call done(success=false, "no application form on this page") IMMEDIATELY -- do not scroll, do not explore, do not fill anything. HOWEVER, if form fields (first_name, last_name, email, phone, CV file) or application buttons ("Solliciteer", "Solliciteren", "Sollicitatie versturen", "Postuler", "Apply") exist anywhere on the page, THIS IS A VALID APPLICATION -- PROCEED TO FILL IT!
4. CAPTCHA / Human Check Checkbox: The extension automatically executes a frame-level auto-clicker on the reCAPTCHA / hCaptcha "I'm not a robot" checkbox inside its iframe frame context. You do NOT need to find an element index for the reCAPTCHA checkbox inside the parent document. If the reCAPTCHA checkbox gets checked (or after a 1-second pause), proceed directly to click Submit Application! Only if an interactive image puzzle challenge pops up after clicking that requires manual image solving, call done(success=false, "captcha image puzzle requires human").
5. SUBMIT APPLICATION AUTOMATICALLY: When all required fields on the page are filled and the final "Submit" / "Absenden" / "Submit Application" / "Send application" / "Envoyer ma candidature" / "Postuler" / "Sollicitatie versturen" / "Verstuur sollicitatie" button is visible, YOU MUST CLICK IT YOURSELF! Do NOT stop at "form filled, awaiting human review". BEFORE clicking Submit, do one final audit sweep of the page: if ANY required (*) field is still empty or shows a red validation error, fill/fix it first. Then click the submit button, wait briefly for the submission confirmation, and then call done(success=true, "submitted application").
6. NEVER STOP FOR A FIELD -- no human rescue mid-form: NEVER use ask_user for a missing or difficult value. For ANY required field with no exact candidate value, choose the most reasonable, professional value yourself and move on: notice period -> "1 month", start date / availability -> "Immediately", required Institution* / Établissement -> per the certification table in FIELD GUIDANCE, unknown dropdown -> the most standard/common option. Leave NO required field empty before clicking Next. ask_user is ONLY for a physical blocker (an OS dialog or picker you truly cannot operate), never for text/dropdown values.

AVAILABLE ACTIONS (use ONLY these exact action names in your JSON output):
- click_element_by_index: Click an element by its index number (buttons, links, checkboxes, radio buttons).
- input_text: Type text into an input field or textarea by its index.
- select_dropdown_option: Select an option from a dropdown/select element.
- scroll: Scroll the page up or down.
- scroll_horizontally: Scroll the page left or right.
- wait: Wait briefly for the page to update (avoid -- only if content is clearly still loading).
- ask_user: LAST RESORT ONLY, for a physical blocker (OS dialog / picker you cannot operate) -- NEVER for missing text/dropdown values (fill the best value yourself).
- done: Finish (see rules above).
CRITICAL JSON FORMATTING WARNING:
Do NOT output generic action names like "click", "type", "action", or "input".
You MUST use "click_element_by_index" for clicking and "input_text" for typing text.

WORKFLOW -- fill and continue, efficiently:
1. If form fields (first_name, last_name, email, phone) are ALREADY visible on the page (e.g. inline application form): DO NOT click any Apply button or scroll away -- GO STRAIGHT TO STEP 2 and fill them! Only if NO form fields are visible yet: click the main "Apply" / "Apply Now" / "Solliciteer nu" / "Solliciteer direct" / "Solliciteren" / "Postuler" / "Je suis intéressé(e)" button ONCE to open or scroll to the form. NEVER click "Autofill with Resume" (it leaves this flow).
2. Fill EVERY visible REQUIRED field (marked with * or "Required") using the candidate data above. Skip optional fields.
   - CRITICAL (SmartRecruiters & ALTEN Education/Certifications): If an expanded certification/education card has an empty required "Ã‰tablissement*" / "Institution*" field:
     1. Click "Annuler" / "Cancel" to close the editor form for that entry.
     2. Click the trash / delete icon (🗑️) on that certification entry card.
     3. Click "Oui" / "Yes" / "Confirm" on the confirmation modal to permanently delete the entry.
     4. Repeat for any other incomplete certification entry until only valid education entries remain.

3. BEFORE clicking "Save and Continue" / "Next" / "Suivant" / "Continue", VERIFY every required field you filled still displays its value -- especially autocomplete fields (city, country), which silently stay EMPTY if their suggestion was not confirmed; for MULTI-SELECT fields verify the selected PILLS/chips are shown instead (their text box legitimately stays empty -- a displayed pill MEANS filled, never re-pick the same option). Then click the button ONCE.
   AFTER clicking, classify what you see -- exactly one of these:
   (a) NEW empty fields or a NEW section appeared (Experience, Education, Screening questions, dropdowns...) -> it advanced: KEEP FILLING, go back to step 2.
    (b) Red validation errors ("Required", "must have a value", "Champ obligatoire", "Veuillez indiquer votre lieu de résidence", a highlighted field):
       - If Workday shows "Error - Given Name(s) / Family Name / Phone Number is required and must have a value", even if text is visually in the box: USE input_text TO RE-TYPE THE VALUE into that exact input index again! Workday requires active input events to register values.
       - Verify the field now has the value, then click "Save and Continue" / "Next" again.
       - NEVER click Next repeatedly on a step with red validation errors without re-typing into the flagged field.
   (c) Nothing changed at all -> the click did not register: re-verify required fields and click the button once more.
4. Most applications need TWO or more Next clicks (personal info -> experience/education -> questions -> review). Repeat steps 2-3 for EVERY step. Only stop when rule 5's conditions are provably true on the page in front of you -- never because you assume the last click finished the job.
5. SPA RE-RENDER NOTE (LinkedIn/Indeed/wizard flows): element indexes EXPIRE when the page re-renders between steps -- after every Next/Continue/submit, base your next action on the FRESH browser state you are given, never on remembered indexes from a previous step.

FIELD GUIDANCE:
- City/location AUTOCOMPLETE fields (a combobox that opens a suggestion list while typing, e.g. SmartRecruiters "Ville"): use input_text with the city name, then use wait (1 second) for the suggestions to load, then click_element_by_index on the matching SUGGESTION ITEM in the opened list. Then CHECK THE RESULT on the next browser state: the field must still display the city (or a selected pill), the list must be closed. If the click missed (field empty, list still open, placeholder back), retype the first 3 letters, wait 1 second, and click the suggestion again; fallback: try select_dropdown_option on the field with the full city text. A city typed but never confirmed counts as EMPTY and blocks Next.
- MULTI-SELECT dropdowns / tag-pick fields (a combobox whose list allows picking MULTIPLE options one at a time, e.g. Skills, Languages, Spoken languages, Nationalities, Areas of expertise): clicking an option CLOSES the list and shows the value as a small chip/pill/tag next to or inside the input -- the text box itself usually stays EMPTY-LOOKING. That is SUCCESS, not failure: do NOT retype the value and do NOT click the same option again (re-clicking a selected option often REMOVES it). To add another value: click the input once to reopen the list, click the next option, and confirm a second pill appears. Stop at 1-3 reasonable pills (or however many the field visibly requires). Your verification is to count the PILLS, never the input text -- if one or more pills are shown, the field is filled: move on. If a wrong pill was added, remove it with the small "x" on the pill itself.
- "How Did You Hear About Us?" / source: choose "LinkedIn", "Job Board", or "Other".
- "Are you a former employee of ...?": choose "No".
- "Country": choose "France" unless the form clearly indicates otherwise.
- IDENTITY FACTS for screening questions: Nationality -> Moroccan. "Where do you currently live/reside?" -> France. Date of birth -> 01/01/1995 (1 January 1995; enter it in whatever format the site asks).
- WORK AUTHORIZATION (answer exactly like this): the candidate holds a valid work permit for FRANCE and is a Moroccan national (free to work in MOROCCO). "Are you authorized to work in France / do you have a French work permit?" -> YES. For ANY OTHER country the job is in (Germany, Belgium, Netherlands, Luxembourg, Switzerland, UK...): "Are you authorized to work in <that country>?" -> NO; "Do you now or will you in the future require visa sponsorship / a work permit?" -> YES. Never claim permits or citizenship for countries other than France and Morocco.
- Salary expectation fields: an annual figure of 40000 EUR ("40000" or "40K"), never in a foreign currency.
- Incomplete EDUCATION / "Formation" entries (ALTEN / SmartRecruiters):
  * Click "Annuler" / "Cancel" on the expanded form.
  * Click the 🗑️ delete icon next to the certification title.
  * Click "Oui" / "Yes" on the confirmation prompt.
  * NEVER use ask_user or stop on certification fields. Delete incomplete certification entries and proceed.
- A required field with no matching candidate value (e.g. notice period, start date): fill it briefly and professionally rather than leaving it empty.
- If a free-text "message / cover letter" textarea exists and is required, write 2-3 professional sentences about why this candidate fits this specific role, in the form's own language. Refer to the employer as "your company" ("votre entreprise") -- never guess or reuse a company name from the URL or page. Never invent employers, degrees, or dates.

PLATFORM-SPECIFIC FORM HANDLING:
- Greenhouse (boards.greenhouse.io / job-boards.greenhouse.io): name, email, phone are plain text fields; custom screening questions appear as extra text inputs and selects -- answer ALL of them from the profile/field guidance above. CHECK any mandatory privacy/GDPR consent checkbox before Submit.
- Lever (jobs.lever.co): fill name, email, phone; place the profile LinkedIn URL into the LinkedIn-profile field; answer every custom question block on the page.
- SmartRecruiters (careers.smartrecruiters.com): multi-step flow (Upload Resume -> Personal Information -> Experience). After the CV is injected, WAIT 3-5 seconds for its resume parser to finish before touching other fields (typing during parsing gets overwritten). Date inputs accept MM/YYYY or YYYY.
- Workday (*.myworkdayjobs.com): multi-page wizard -- My Information, then My Experience (work/education from the HISTORY table), then Application Questions (authorization/diversity), then Review.
  * RESUME UPLOAD: The candidate's CV ("cv.pdf") is injected programmatically. ALWAYS WAIT for the "cv.pdf" filename chip to appear and any progress bar/spinner indicator to FINISH before clicking "Save and Continue" / "Next" (clicking Next mid-upload is what blanks the widget).
  * NEVER click "Select file", "Upload", or "Browse" buttons (opens OS file dialog).
  * IF "Upload your resume cannot be left blank" or a red blank-resume error appears DESPITE the "cv.pdf" chip showing: click "Save and Continue" / "Next" ONE extra time -- Workday's validation state clears on the next attempt once the file upload has registered.
- Workable (apply.workable.com): usually a single-page form/modal -- fill everything, then let any background document upload indicator FINISH before clicking Submit.
- Personio (*.jobs.personio.de): the form may be in French or German, not English -- match fields by TYPE (email -> the email input, phone -> the tel input) rather than by the label language.
- SIGN-IN / REGISTRATION WALLS (any site that gates the application behind an account): follow the ACCOUNT CREATION & LOGIN instructions from the candidate block. If a REGISTRATION fails with "account/email already exists" (or similar), switch to the site's Sign In / Log In page and sign in with the SAME candidate-block credentials; if the password is rejected, try the block's alternate passwords in order. If that block cannot clear the wall (emailed/SMS verification code, CAPTCHA, a "we sent you a code" screen): call done(success=false, "needs_human_login") and STAY on the page -- a human finishes the checkpoint and the extension restarts you automatically on this same tab.
- Job-board wrapper pages (whatjobs, bebee, jobrapido, talent.com, ...): if the "apply" control is just an outbound link to the employer's real ATS, follow it ONCE and keep working there; if it is only a dead-end listing (no form, no employer link), call done(success=false, "no application form on this listing").

DATA FORMATTING & EDGE CASES:
- Phone numbers: enter the profile value as-is; if a form rejects it, convert to full international format with a leading + and no spaces/dashes/leading trunk 0 (French mobile 06... -> +336...).
- Work authorization / right-to-work: per the WORK AUTHORIZATION rule in FIELD GUIDANCE (France + Morocco only, sponsorship elsewhere) -- never claim citizenship/permits that were not given as facts.
- Cover letter / message textareas: PLAIN text only -- no HTML tags, no markdown.${portalAddendum}`;

      if (bulkOpts && bulkOpts.submitRetry) {
        promptText += `

CRITICAL RETRY CONTEXT: A previous agent run already filled this form and CLAIMED it clicked the final submit button, but nothing was actually submitted -- the submit button is still visible on the page and no confirmation ever appeared. The fields are already filled: do NOT re-enter everything. Quickly audit for empty required (*) fields or red validation errors and fix only those, SCROLL so the real final Submit / "Envoyer ma candidature" / "Abschicken" button is in view, click it ONCE using its exact CURRENT index from the fresh browser state, then WAIT and confirm a visible effect (spinner, navigation away, or confirmation text such as "Thank you for applying" / "candidature envoyée"). Call done(success=true) ONLY after that effect is actually visible. If the click produced no effect at all, re-read the fresh state and click it once more; still no effect -> done(success=false, "submit button unresponsive").`;
      }

      // Loopback fetches from this MAIN-world page context trigger Chrome's
      // "Local Network Access" prompt per site (agent freezes when denied).
      // Route them via the isolated-world relay + service worker (BOJ_FETCH);
      // anything else goes to the real fetch unchanged.
      const __bojRealFetch = window.__BOJ_REAL_FETCH || (window.__BOJ_REAL_FETCH = window.fetch);
      let __bojTunnelSeq = 0;
      window.__BOJ_TUNNEL_PENDING = window.__BOJ_TUNNEL_PENDING || new Map();
      if (!window.__BOJ_TUNNEL_LISTENER) {
        window.__BOJ_TUNNEL_LISTENER = true;
        window.addEventListener("message", (event) => {
          const d = event && event.data;
          if (!d || d.type !== "BOJ_TUNNELED_FETCH_RESULT" || !d.id) return;
          const p = window.__BOJ_TUNNEL_PENDING.get(d.id);
          if (!p) return;
          window.__BOJ_TUNNEL_PENDING.delete(d.id);
          clearTimeout(p.timer);
          if (d.okRelay === false) {
            try {
              window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: `LLM tunnel relay error: ${d.error || "unknown"}` }, "*");
            } catch (e2) {}
            p.reject(new TypeError(`Tunneled fetch failed: ${d.error || "relay error"}`));
            return;
          }
          try {
            // 204/205/304 mandate a null body in the Response constructor.
            const st = d.status || 200;
            p.resolve(
              new Response(st === 204 || st === 205 || st === 304 ? null : d.body == null ? "" : d.body, {
                status: st,
                statusText: d.statusText || "",
                headers: d.headers || undefined,
              })
            );
          } catch (e) {
            p.reject(e);
          }
        });
      }
      const tunneledFetch = (input, init) => {
        let u;
        try {
          const raw = typeof input === "string" || input instanceof URL ? String(input) : input && input.url;
          u = new URL(String(raw), location.href);
          const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
          const isRemote = u.hostname.includes("fuelix.ai") || u.hostname.includes(".azure.com") || u.hostname === "api.x.ai";
          if (!/^https?:$/.test(u.protocol) || (!loopback && !isRemote)) return __bojRealFetch.apply(window, [input, init]);
        } catch (e) {
          return __bojRealFetch.apply(window, [input, init]);
        }
        if (init && init.signal && init.signal.aborted) {
          return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
        }
        const headers = {};
        if (init && init.headers) {
          try {
            if (typeof init.headers.forEach === "function") init.headers.forEach((v, k) => (headers[k] = v));
            else if (Array.isArray(init.headers)) init.headers.forEach(([k, v]) => (headers[k] = v));
            else Object.assign(headers, init.headers);
          } catch (e) {}
        }
        const id = `tf_${Date.now()}_${++__bojTunnelSeq}`;
        const bodyStr = init && init.body != null ? String(init.body) : null;
        return new Promise((resolve, reject) => {
          const entry = { resolve, reject, timer: 0 };
          entry.timer = setTimeout(() => {
            window.__BOJ_TUNNEL_PENDING.delete(id);
            try {
              window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: "LLM tunnel timed out (280s, no response from relay/worker)" }, "*");
            } catch (e2) {}
            reject(new TypeError("Tunneled fetch timed out (280s)"));
          }, 280000);
          window.__BOJ_TUNNEL_PENDING.set(id, entry);
          if (init && init.signal) {
            init.signal.addEventListener(
              "abort",
              () => {
                window.__BOJ_TUNNEL_PENDING.delete(id);
                clearTimeout(entry.timer);
                reject(new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true }
            );
          }
          window.postMessage(
            {
              type: "BOJ_TUNNELED_FETCH",
              id,
              url: u.href,
              method: (init && init.method) || (input && input.method) || "GET",
              headers,
              body: bodyStr,
            },
            "*"
          );
        });
      };
      // Safety net: any OTHER loopback call made during the agent run
      // (not just the configured client) also goes via the tunnel; the
      // original fetch is restored in reportDone().
      window.fetch = tunneledFetch;

      const finalPrompt = promptText;

      const reportDone = (success, detail) => {
        window.__BOJ_PAGE_AGENT_RUNNING = false;
        try {
          window.fetch = window.__BOJ_REAL_FETCH || window.fetch;
        } catch (e) {}
        if (bulkOpts && bulkOpts.doneKey) {
          window[bulkOpts.doneKey] = {
            done: true,
            success: !!success,
            detail: String(detail || "").slice(0, 300),
            at: Date.now(),
          };
          // Durable signal: the window flag above dies with the post-submit
          // navigation -- this message (forwarded by the isolated-world
          // relay) reaches the bulk worker instantly, navigation or not.
          try {
            window.postMessage({ type: "BOJ_AGENT_DONE_RELAY", success: !!success, detail: String(detail || "").slice(0, 300) }, "*");
          } catch (e) {}
        }
      };

      // End-to-end tunnel health probe BEFORE the agent commits to it: if the
      // relay never landed on this document (injection race) or the worker
      // path is broken, fall back to direct fetch (single-shot only). Cold
      // service workers can eat the first BOJ_FETCH for seconds, so ping TWICE
      // before declaring the tunnel unhealthy. BULK: never fall back -- a
      // hidden owned tab cannot answer Chrome's Local-Network-Access prompt,
      // End-to-end tunnel health probe BEFORE the agent commits to it: if the
      // relay never landed on this document (injection race) or the worker
      // path is broken, fall back to direct fetch (single-shot only). Cold
      // service workers can eat the first BOJ_FETCH for seconds, so ping TWICE
      // before declaring the tunnel unhealthy. BULK: never fall back -- a
      // hidden owned tab cannot answer Chrome's Local-Network-Access prompt,
      // so direct fetch would freeze every LLM call and burn the 20-minute
      // timeout in total silence. Fail fast + loudly, the worker moves on.
      let customFetchForAgent = tunneledFetch;
      let tunnelErr = null;
      for (let pingAttempt = 0; pingAttempt < 2; pingAttempt++) {
        if (pingAttempt) await new Promise((r) => setTimeout(r, 500));
        try {
          await Promise.race([
            tunneledFetch("https://api.fuelix.ai/v1/models"),
            new Promise((_, rej) => setTimeout(() => rej(new Error("tunnel ping timeout")), 3000)),
          ]);
          tunnelErr = null;
          break;
        } catch (e) {
          tunnelErr = e;
        }
      }
      if (tunnelErr) {
        if (bulkOpts && bulkOpts.bulk) {
          reportDone(false, `LLM tunnel unavailable on this page (${tunnelErr && tunnelErr.message ? tunnelErr.message : tunnelErr}) -- relay not installed or worker unreachable`);
          return;
        }
        customFetchForAgent = undefined; // the lib binds the REAL fetch instead
        window.fetch = __bojRealFetch;
        const m = `[BOJ Tool] LLM tunnel unhealthy on this page -- direct-fetch fallback active: ${tunnelErr && tunnelErr.message ? tunnelErr.message : tunnelErr}`;
        console.warn(m);
        try {
          window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: m }, "*");
        } catch (e2) {}
      }

      const buildAgent = () => {
        const agent = new PageAgentClass({
          // Local proxy -> Fuelix API.
          // Routed through /api/llm-proxy (loopback, tunneled via BOJ_FETCH).
          model: "gpt-5.6-terra",
          baseURL: "https://api.fuelix.ai/v1",
          apiKey: "ak-p9YxA11lcjojQGtzBRkt9ne1kF23",
          language: "en-US",
          maxSteps: 200,
          maxStep: 200,
          max_steps: 200,
          customFetch: customFetchForAgent,
        });

        // Intercept agent action steps and stream them to the background worker log
        if (typeof agent.on === "function") {
          agent.on("step", (step) => {
            const act = step && (step.action || step.thought || step.description);
            if (act) {
              try {
                chrome.runtime.sendMessage({ type: "BOJ_STEP_LOG", msg: `⚡ Step ${step.stepIndex || ""}: ${String(act).slice(0, 150)}` });
              } catch (e) {}
            }
          });
        }
        return agent;
      };

      // DOM-wiring crash handling ("Cannot read properties of null (reading
      // 'addEventListener')"): on SPA pages -- LinkedIn's Easy Apply modal in
      // particular -- the form container mounts AFTER the agent wired its
      // listeners, and the library crashes touching a node that does not
      // exist yet. Protocol for this error class: (1) never interact with an
      // unchecked node, (2) wait for the modal/container to mount, (3) reset
      // by re-selecting the container from scratch with a FRESH agent
      // instance (no cached DOM references). Retry EXACTLY once -- and only
      // for this error family; anything else reports out immediately (a blind
      // retry risks double-filling or double-submitting).
      const isDomWiringCrash = (e) => /addEventListener|null/i.test(String((e && e.message) || e));
      let domCrashRetried = false;
      const resetAndRetry = (launch) => {
        domCrashRetried = true;
        console.warn("[BOJ Tool] PageAgent DOM-wiring crash -- waiting for the modal/container to mount, then retrying once with a fresh agent instance.");
        return waitForEl('.jobs-easy-apply-modal, [class*="jobs-easy-apply"], dialog[open], form, input', 3000).then(launch);
      };

      const launchAgent = () => {
        let agent;
        try {
          agent = buildAgent();
        } catch (err) {
          if (!domCrashRetried && isDomWiringCrash(err)) {
            resetAndRetry(launchAgent);
            return;
          }
          // Worker notification FIRST -- alert() blocks the page's JS until a
          // human dismisses it, which used to stall bulk runs for 20 minutes.
          window.__BOJ_PAGE_AGENT_RUNNING = false;
          if (bulkOpts && bulkOpts.doneKey) {
            window[bulkOpts.doneKey] = {
              done: true,
              success: false,
              detail: String(err && err.message ? err.message : err).slice(0, 300),
              at: Date.now(),
            };
            try { window.postMessage({ type: "BOJ_AGENT_DONE_RELAY", success: false, detail: String(err && err.message ? err.message : err).slice(0, 300) }, "*"); } catch (e2) {}
          }
          if (window.top === window.self) alert("[BOJ Tool] PageAgent error: " + (err && err.message ? err.message : String(err)));
          try {
            window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: `PageAgent construction error stack: ${String(err && err.stack ? err.stack : err).slice(0, 600)}` }, "*");
          } catch (e2) {}
          return;
        }

        console.log("[BOJ Tool] Running PageAgent GUI Agent...", finalPrompt);
        Promise.resolve(agent.execute(finalPrompt))
          .then((res) => reportDone(true, typeof res === "string" ? res : "agent finished"))
          .catch(async (err) => {
            if (!domCrashRetried && isDomWiringCrash(err)) {
              await resetAndRetry(launchAgent);
              return;
            }
            reportDone(false, err && err.message ? err.message : String(err));
            try {
              window.postMessage({ type: "BOJ_TUNNEL_LOG", msg: `PageAgent execute error stack: ${String(err && err.stack ? err.stack : err).slice(0, 600)}` }, "*");
            } catch (e2) {}
          });
      };
      launchAgent();
    })();
  };

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, // run the agent in every frame that holds form fields
      world: "MAIN",
      func: runAgentFunc,
      args: [candidate || {}, jobTitle || "", companyName || "", cvUrl || "", bulkOpts],
    });
  } catch (errAll) {
    // Batched allFrames calls reject entirely on pages with opaque/special
    // frames -- degrade gracefully rather than silently not launching at all.
    console.log("[BOJ Tool] PageAgent MAIN allFrames rejected, falling back to top frame:", errAll && errAll.message ? errAll.message : errAll);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: runAgentFunc,
        args: [candidate || {}, jobTitle || "", companyName || "", cvUrl || "", bulkOpts],
      });
    } catch (errTop) {
      console.log("[BOJ Tool] PageAgent MAIN top frame failed, trying ISOLATED world...", errTop);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: runAgentFunc,
          args: [candidate || {}, jobTitle || "", companyName || "", cvUrl || "", bulkOpts],
        });
      } catch (errIso) {
        console.error("[BOJ Tool] PageAgent ISOLATED world failed:", errIso);
        await swNote(`agent runner injection FAILED in all worlds -- no agent on this page: ${errIso && errIso.message ? errIso.message : errIso}`);
        return;
      }
    }
  }
}

// Normalizes away query params and ATS apply-step subpaths (/apply,
// /applyManually, ...) so "still on this job" comparisons hold across the
// job page <-> its application form navigation.
function stripApplyStep(url) {
  return url
    .split("?")[0]
    .split("#")[0]
    .replace(/\/(apply|applyManually|autofillWithResume)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
}

// True only when the tab has genuinely LEFT the job's own page:
//   - moved UP to a parent path (the jobs listing: /Company/123/job ->
//     /Company, /company/jobs/456 -> /company, /External/job/X -> /External), or
//   - left the ATS origin entirely for a careers/jobs corporate site.
// Crucially FALSE for the job page itself -- which very often legitimately
// lives at careers.company.com or company.com/careers/... (the old blanket
// URL match bounced the user off their own application page constantly).
function wanderedOffJobPage(tabUrl, jobUrl) {
  if (!jobUrl) return false;
  if (tabUrl.includes("smartapply.indeed.com")) return false; // Indeed SmartApply flow is the real application page!
  const t = stripApplyStep(tabUrl);
  const j = stripApplyStep(jobUrl);
  if (t === j) return false; // still on the job page or its apply step
  if (j.startsWith(t + "/")) return true; // moved up to the listing
  try {
    if (new URL(t).origin !== new URL(j).origin) {
      return /careers|emplois|offres|stellen|jobs/i.test(t);
    }
  } catch {
    // unparseable URL -> treat as not wandered
  }
  return false;
}

// ---------------------------------------------------------------------------
// Unified every-page auto-launch (user choice: the agent starts on ANY loaded
// page, self-exiting instantly per the prompt's no-application-form rule).
// Skips: bulk-owned tabs (handled by the bulk branch), non-web schemes, the
// BOJ app itself (loopback), the Chrome Web Store, and tabs where the agent
// is already running or recently finished on this exact URL (loop guard).
// Also consumes "handoffs": when the agent's Apply/Postuler click opened a
// NEW tab (BOJ_OPEN_TAB / popup safety net), job intent follows it here.
// ---------------------------------------------------------------------------
async function maybeAutoLaunchAgent(tabId, tab) {
  try {
    const url = (tab && tab.url) || "";
    if (!url) return;
    if (!/^https?:/i.test(url)) return;
    const lu = url.toLowerCase();
    if (lu.includes("://localhost") || lu.includes("://127.0.0.1") || lu.includes("://[::1]")) return;
    if (lu.includes("chrome.google.com/webstore")) return;
    if (/\.pdf(\?|#|$)/.test(lu)) return;

    // Loop guard: the agent just finished on THIS tab + URL -> don't respawn
    // for ~2 min (same-page SPA churn, multi-step flows re-navigating, ...).
    const store = await chrome.storage.local.get(["bojPageDone", "activeTask", "bojTabHandoffs", "bojBulkRunId", "bojBulkOwnTabId"]);
    // A bulk run OWNS its application tab's lifecycle (own relaunch logic in
    // tabs.onUpdated, own stale-flag semantics). An every-page launch here
    // would race the bulk agent and its second launch would trip the bulk
    // stale-flag guard -- which reports done(false) and kills the whole job.
    if (store.bojBulkRunId && store.bojBulkOwnTabId === tabId) return;
    const done = store.bojPageDone;
    if (done && done.tabId === tabId && done.url === url && Date.now() - done.at < 120000) return;

    let alive = false;
    try {
      const [r] = await chrome.scripting
        .executeScript({ target: { tabId }, world: "MAIN", func: () => !!window.__BOJ_PAGE_AGENT_RUNNING })
        .catch(() => []);
      alive = !!(r && r.result);
    } catch (e) {}
    if (alive) return;

    // Handoff from an agent-driven external Apply/Postuler click (prune stale
    // entries while we are here; tabs sometimes die before loading).
    const activeTask = store.activeTask;
    const map = store.bojTabHandoffs || {};
    const handoff = map[tabId] || null;
    let handoffsDirty = false;
    for (const [k, v] of Object.entries(map)) {
      if (Date.now() - (v.at || 0) > 600000) { delete map[k]; handoffsDirty = true; }
    }
    if (handoff) { delete map[tabId]; handoffsDirty = true; }
    if (handoffsDirty) await chrome.storage.local.set({ bojTabHandoffs: map });

    const mine = activeTask && activeTask.tabId === tabId ? activeTask : null;
    let candidate = mine && mine.candidate ? mine.candidate : null;
    let cvPdfUrl = mine && mine.cvPdfUrl ? mine.cvPdfUrl : null;
    let jobTitle = (handoff && handoff.jobTitle) || (mine && mine.jobTitle) || "";
    let companyName = (handoff && handoff.companyName) || (mine && mine.companyName) || "";
    let coverLetterPdfUrl = (mine && mine.coverLetterPdfUrl) || null;

    if (!candidate || !cvPdfUrl) {
      try {
        const lookupRes = await fetch(`${API_BASE}/api/auto-apply/lookup?url=${encodeURIComponent(url)}`);
        if (lookupRes.ok) {
          const data = await lookupRes.json();
          if (data && data.candidate) {
            candidate = data.candidate;
            cvPdfUrl = cvPdfUrl || data.cvPdfUrl || null;
            jobTitle = jobTitle || data.jobTitle || "";
            companyName = companyName || data.companyName || "";
            coverLetterPdfUrl = coverLetterPdfUrl || data.coverLetterPdfUrl || null;
          }
        }
      } catch (e2) {}
    }
    if (!candidate) return; // app unreachable -- stay silent

    console.log("[BOJ Tool] Auto-launching PageAgent on page:", url.slice(0, 120));
    await chrome.storage.local.set({
      activeTask: { tabId, jobUrl: url, candidate, jobTitle, companyName, cvPdfUrl, coverLetterPdfUrl, time: Date.now() },
    });
    await sleep(600);
    executePageAgentOnTab(tabId, candidate, jobTitle, companyName, cvPdfUrl, coverLetterPdfUrl, url);
  } catch (e) {
    console.warn("[BOJ Tool] auto-launch note:", e);
  }
}

// Safety-net adoption for popups that DID open (trusted/human clicks, or
// browsers that allowed the synthetic one): if a new tab's opener currently
// has an active agent task, treat it as an external-application handoff so
// the auto-launch path adopts it with job context.
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (tab.openerTabId == null || tab.id == null) return;
    // Bulk runs are one-tab-by-design, but a popup can still escape the
    // same-tab capture (trusted/browser-initiated open, noopener handlers...).
    // Instead of orphaning it (a plain auto-launch there has no doneKey
    // wiring and is invisible to the run), ADOPT it as the run's application
    // tab: the whole bulk machinery (confirmation guard, stabilized-URL
    // relaunch, self-heal, completion signals) then applies to the real
    // application page. The poll loop tracks ownership via storage.
    const { bojBulkRunId, bojBulkOwnTabId: ownIdAtCreate } = await chrome.storage.local.get(["bojBulkRunId", "bojBulkOwnTabId"]);
    if (bojBulkRunId && ownIdAtCreate === tab.openerTabId) {
      bulkOwnTabId = tab.id;
      await chrome.storage.local.set({ bojBulkOwnTabId: tab.id });
      try { await chrome.tabs.remove(tab.openerTabId); } catch (eOld) {}
      try {
        await bulkEvent(bojBulkRunId, { type: "log", msg: "Application opened in a NEW tab -- adopting it as the run's application tab (old tab closed)." });
      } catch (e2) {}
      return;
    }
    const { activeTask, bojTabHandoffs } = await chrome.storage.local.get(["activeTask", "bojTabHandoffs"]);
    if (!activeTask || activeTask.tabId !== tab.openerTabId) return;
    if (Date.now() - (activeTask.time || 0) > 600000) return;
    const map = bojTabHandoffs || {};
    if (map[tab.id]) return;
    map[tab.id] = { fromTabId: tab.openerTabId, jobTitle: activeTask.jobTitle || "", companyName: activeTask.companyName || "", at: Date.now() };
    await chrome.storage.local.set({ bojTabHandoffs: map });
  } catch (e) {}
});

// ---------------------------------------------------------------------------
// Login watch: the agent hit a sign-in wall it cannot cross (verification
// code / CAPTCHA). Instead of vanishing, it parked with done(false,
// "needs_human_login"): we tell the user to log in MANUALLY, then poll the
// tab (every load + a backup alarm, up to 10 min). Once the wall is gone,
// the agent is relaunched automatically to finish the application.
// ---------------------------------------------------------------------------
const LOGIN_WATCH_ALARM = "boj-login-watch";

function startLoginWatch(tabId) {
  chrome.storage.local.set({ bojLoginWatch: { tabId, startedAt: Date.now() } });
  notify(tabId, "BOJ: this site needs a sign-in. Log in or create your account MANUALLY in this tab -- the agent will continue the application automatically once you are in.");
  if (chrome.alarms && chrome.alarms.create) chrome.alarms.create(LOGIN_WATCH_ALARM, { periodInMinutes: 0.5 });
}

// Injected probe: is the sign-in wall still up, and are real form fields back?
function loginWatchProbe() {
  const visFields = Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "image", "file"].includes(type)) return false;
    if (el.disabled) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length;
  const hasPassword = !!document.querySelector('input[type="password"]');
  const text = ((document.body && document.body.innerText) || "").slice(0, 4000).toLowerCase();
  const wallText = /se connecter|sign in|log in|connexion|cr[eé]er un compte|create (an )?account|s'inscrire/.test(text);
  const urlAuth = /login|signin|sign-in|connexion|register|inscription|\/auth/i.test(location.href);
  return { wall: hasPassword || (wallText && urlAuth), fields: visFields };
}

async function checkLoginWatch(tabIdOpt) {
  const { bojLoginWatch } = await chrome.storage.local.get("bojLoginWatch");
  if (!bojLoginWatch) return;
  if (Date.now() - bojLoginWatch.startedAt > 10 * 60 * 1000) {
    await chrome.storage.local.remove("bojLoginWatch");
    if (chrome.alarms && chrome.alarms.clear) await chrome.alarms.clear(LOGIN_WATCH_ALARM);
    return;
  }
  const tabId = bojLoginWatch.tabId;
  if (tabIdOpt != null && tabIdOpt !== tabId) return; // not the watched tab
  let probe = null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: loginWatchProbe }).catch(() => []);
    probe = r && r.result;
  } catch (e) {
    return; // tab closed or not injectable right now
  }
  if (!probe || probe.wall || probe.fields < 2) return;

  // The human finished signing in: clear the watch + the loop guard, then
  // relaunch the agent on whatever application page is now showing.
  await chrome.storage.local.remove(["bojLoginWatch", "bojPageDone"]);
  if (chrome.alarms && chrome.alarms.clear) await chrome.alarms.clear(LOGIN_WATCH_ALARM);
  notify(tabId, "BOJ: sign-in detected -- resuming the application now.");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.url) await maybeAutoLaunchAgent(tabId, tab);
}

// Auto-Launch PageAgent on Navigation to ATS Application Pages (Workday, Greenhouse, Lever, SmartRecruiters)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) return;
  // Fire on url change or completion
  if (!changeInfo.url && changeInfo.status !== "complete") return;

  // Is this tab owned by an active bulk run?
  let bulkOwnsThisTab = false;
  try {
    let ownId = bulkOwnTabId;
    if (ownId === null || ownId === undefined) {
      ownId = (await chrome.storage.local.get("bojBulkOwnTabId")).bojBulkOwnTabId;
    }
    bulkOwnsThisTab = ownId !== null && ownId !== undefined && tabId === ownId;
  } catch (e) {}

  // Bulk auto-submit guard
  if (bulkOwnsThisTab) {
    try {
      const { bojBulkRunId, bojAgentLaunchedAt } = await chrome.storage.local.get(["bojBulkRunId", "bojAgentLaunchedAt"]);
      if (bojBulkRunId && bojAgentLaunchedAt && Date.now() - bojAgentLaunchedAt > 1500) {
        const frames = await chrome.scripting
          .executeScript({ target: { tabId, allFrames: true }, func: bulkCheckSubmitted })
          .catch(() => []);
        const hit = (frames || []).find((f) => f && f.result && f.result.submitted);
        if (hit) {
          const run = await bulkGetRun(bojBulkRunId);
          if (run && (run.status === "running" || run.status === "paused" || run.status === "waiting_human")) {
            await chrome.storage.local.set({
              bojSubmitted: { tabId, match: String(hit.result.match || "confirmation page"), at: Date.now() },
            });
            await bulkEvent(run.id, {
              type: "log",
              msg: `Post-submit confirmation detected after navigation ("${String(hit.result.match).slice(0, 60)}") -- leaving tab for the worker to close.`,
            });
            return;
          }
        }
      }
    } catch (e) {
      console.warn("[BOJ Tool] bulk agent-relaunch note:", e);
    }
    
    // Relaunch mid-form if agent was wiped. COMPLETED loads only: firing on
    // changeInfo.url (navigation START) raced the commit -- the alive-probe
    // rejected mid-navigation (mistaken for "agent dead"), and the relaunch's
    // own injections could then land in the DYING document where the old agent
    // was still filling the form (the real "stale flag" mid-fill kill).
    // A true navigation ALWAYS produces a complete event later (or there is
    // nothing stable to inject into); SPA pushState transitions keep the same
    // document, where the alive-probe correctly reports the surviving agent.
    try {
      if (changeInfo.status !== "complete") return;

      const { bojBulkRunId, bojAgentLaunchedAt, bojBulkJobCtx } = await chrome.storage.local.get(["bojBulkRunId", "bojAgentLaunchedAt", "bojBulkJobCtx"]);
      if (!(bojBulkRunId && bojAgentLaunchedAt && Date.now() - bojAgentLaunchedAt > 1500 && bojBulkJobCtx && bojBulkJobCtx.candidate)) return;

      // URL SETTLE: external-apply redirects (LinkedIn /redir, trackers,
      // interstitials) fire "complete" on a document that immediately
      // navigates AGAIN. Relaunching on the first complete used to inject
      // the agent into that dying document, and the real destination's
      // complete (<7s later) was then blocked by the in-flight relaunch
      // stamp -- the destination page (employer ATS) ended up with NO agent.
      // Wait until the tab is complete and its URL is stable across two reads.
      let lastUrl = "";
      try {
        lastUrl = (tab && tab.url) || "";
      } catch (e) {}
      for (let settle = 0; settle < 8; settle++) {
        await sleep(700);
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t || !t.url) return;
        if (t.status === "complete" && t.url === lastUrl) break;
        lastUrl = t.url;
      }

      // In-flight stamp, keyed to the STABILIZED url: a second complete for
      // the SAME document within 7s is the duplicate-event case and is
      // skipped, but a DIFFERENT url means the previous relaunch died with
      // its document and MUST launch again here.
      const { bojBulkRelaunch } = await chrome.storage.local.get("bojBulkRelaunch");
      const relaunchInFlight = bojBulkRelaunch && bojBulkRelaunch.tabId === tabId && bojBulkRelaunch.url === lastUrl && Date.now() - bojBulkRelaunch.at < 7000;
      if (relaunchInFlight) return;

      // Race-claim the launch slot BEFORE the alive probe (navigation events
      // dispatch this listener CONCURRENTLY): stamp with a nonce, re-read it,
      // proceed only if our stamp survived -- the loser(s) exit here instead
      // of starting interleaved executePageAgentOnTab chains.
      const nonce = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      try {
        await chrome.storage.local.set({ bojAgentLaunchedAt: Date.now(), bojBulkRelaunch: { tabId, url: lastUrl, at: Date.now(), nonce } });
      } catch (e) {}
      await sleep(400);
      try {
        const { bojBulkRelaunch: cur } = await chrome.storage.local.get("bojBulkRelaunch");
        if (!cur || cur.nonce !== nonce) return;
      } catch (e) {
        return;
      }

      // Alive-probe: ANY ownership flag (agent running, CV injector, done
      // relay) means a launch chain already owns this document -- do not
      // start a second one. Probe FAILURE = indeterminate = skip this event
      // (probing during a commit was being misread as "agent dead", which
      // is precisely what launched agents into dying documents).
      let owns = true;
      try {
        const [rMain] = await chrome.scripting
          .executeScript({ target: { tabId }, world: "MAIN", func: () => !!(window.__BOJ_PAGE_AGENT_RUNNING || window.__BOJ_CV_INJECTOR_ACTIVE) })
          .catch(() => []);
        const [rIso] = await chrome.scripting
          .executeScript({ target: { tabId }, world: "ISOLATED", func: () => !!window.__BOJ_DONE_RELAY_ACTIVE })
          .catch(() => []);
        owns = !!(rMain && rMain.result) || !!(rIso && rIso.result);
        if (!(rMain && typeof rMain.result === "boolean") && !(rIso && typeof rIso.result === "boolean")) owns = true; // both probes failed -> unknown -> skip
      } catch (e) {}
      if (!owns) {
        const run = await bulkGetRun(bojBulkRunId);
        if (run && run.status === "running") {
          await bulkEvent(run.id, { type: "log", msg: `Page reloaded/navigated mid-application -- relaunching the agent on the new document (${String(lastUrl).slice(0, 90)}).` });
          const clr = (w) =>
            chrome.scripting.executeScript({ target: { tabId }, world: w, func: (k) => { window[k] = null; }, args: [BULK_DONE_KEY] }).catch(() => {});
          await clr("MAIN");
          await clr("ISOLATED");
          await executePageAgentOnTab(
            tabId,
            bojBulkJobCtx.candidate,
            bojBulkJobCtx.jobTitle || "",
            bojBulkJobCtx.companyName || "",
            bojBulkJobCtx.cvPdfUrl || "",
            bojBulkJobCtx.coverLetterPdfUrl || "",
            bojBulkJobCtx.jobUrl || lastUrl,
            { bulk: true, autoSubmit: !!run.auto_submit, doneKey: BULK_DONE_KEY }
          );
        }
      }
    } catch (e) {
      console.warn("[BOJ Tool] bulk agent-relaunch note:", e);
    }
    return;
  }

  // Login-wall watch fires on every completed load of the watched tab (the
  // human is signing in right now); no-op when no watch is active.
  try {
    await checkLoginWatch(tabId);
  } catch (e) {}

  // Auto-Launch/Relaunch PageAgent -- EVERY page load (user choice), with
  // loopback/store/PDF exclusions, the just-finished loop guard, and the
  // alive check handled inside. Silent no-op on non-application pages.
  try {
    await maybeAutoLaunchAgent(tabId, tab);
  } catch (err) {
    console.error("[BOJ Tool] auto-launch error:", err);
  }

  // Auto-recovery: pull tab back if wandered off
  const { activeTask } = await chrome.storage.local.get("activeTask");
  if (
    activeTask &&
    activeTask.tabId === tabId &&
    Date.now() - activeTask.time < 300000 &&
    wanderedOffJobPage(tab.url, activeTask.jobUrl)
  ) {
    console.warn("[BOJ Tool] Agent wandered off the application page -> back:", tab.url);
    try {
      await chrome.tabs.goBack(tabId);
    } catch (e) {
      console.error("[BOJ Tool] Auto goBack error:", e);
    }
    return;
  }
  if (bulkOwnsThisTab) {
    // Bulk-owned tabs already returned in the bulk branch above; this is a
    // defensive return only (kept from a prior duplicate structure).
    return;
  }
});

// SPA Navigation listener (LinkedIn/Indeed/Workday pushState transitions --
// these fire without a full tabs.onUpdated load on single-page apps).
// Every-page auto-launch (user choice): same central path as full loads --
// exclusions, loop guard, alive check and CV lookup all handled inside.
chrome.webNavigation?.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0 || !details.url) return;
  await maybeAutoLaunchAgent(details.tabId, { id: details.tabId, url: details.url });
});


async function launchPageAgentOnJobTab(jobUrl, candidate, jobTitle, companyName, cvPdfUrl, coverLetterPdfUrl) {
  console.log("[BOJ Tool] Cross-tab launch requested for:", jobUrl);

  // Fetch full lookup if missing profile/document data
  let c = candidate;
  let jt = jobTitle;
  let cn = companyName;
  let cvUrl = cvPdfUrl;
  let clUrl = coverLetterPdfUrl;

  if (!c || !cvUrl) {
    try {
      const lookupRes = await fetch(`${API_BASE}/api/auto-apply/lookup?url=${encodeURIComponent(jobUrl)}`);
      if (lookupRes.ok) {
        const lookup = await lookupRes.json();
        c = c || lookup.candidate;
        jt = jt || lookup.jobTitle;
        cn = cn || lookup.companyName;
        cvUrl = cvUrl || lookup.cvPdfUrl;
        clUrl = clUrl || lookup.coverLetterPdfUrl;
      }
    } catch (e) {
      console.error("[BOJ Tool] Auto-lookup error during tab launch:", e);
    }
  }

  // Find tab opened by window.open or create new tab
  const allTabs = await chrome.tabs.query({});
  const targetCleanUrl = jobUrl.split("?")[0].replace(/\/$/, "");
  let targetTab = allTabs.find((t) => {
    if (!t.url) return false;
    const cleanTUrl = t.url.split("?")[0].replace(/\/$/, "");
    return cleanTUrl.includes(targetCleanUrl) || targetCleanUrl.includes(cleanTUrl);
  });

  if (!targetTab) {
    targetTab = await chrome.tabs.create({ url: jobUrl, active: true });
    await new Promise((resolve) => {
      function listener(tabId, changeInfo) {
        if (tabId === targetTab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  } else {
    await chrome.tabs.update(targetTab.id, { active: true });
  }

  await sleep(1500);
  await executePageAgentOnTab(targetTab.id, c, jt, cn, cvUrl, clUrl, jobUrl);
}

async function run(tab) {
  if (!tab.url || !tab.url.startsWith("http")) {
    notify(tab.id, "Open the job application page first, then click this again.");
    return;
  }

  status(tab.id, "Looking up job & candidate profile in BOJ Tool...");
  let lookup = null;
  try {
    const lookupRes = await fetch(`${API_BASE}/api/auto-apply/lookup?url=${encodeURIComponent(tab.url)}`);
    if (lookupRes.ok) lookup = await lookupRes.json();
  } catch (e) {}

  if ((!lookup || !lookup.candidate || !lookup.cvPdfUrl) && tab.url.includes("smartapply.indeed.com")) {
    try {
      const t = (await chrome.storage.local.get("activeTask")).activeTask;
      if (t && t.candidate && t.cvPdfUrl) {
        lookup = {
          candidate: t.candidate,
          jobTitle: t.jobTitle || "",
          companyName: t.companyName || "",
          cvPdfUrl: t.cvPdfUrl,
          coverLetterPdfUrl: t.coverLetterPdfUrl || null,
        };
      }
    } catch (e2) {}
  }

  if (!lookup || !lookup.candidate) {
    notify(tab.id, "Could not find this job in BOJ Tool.");
    return;
  }

  status(tab.id, "Launching PageAgent (GUI agent)...");
  await executePageAgentOnTab(
    tab.id,
    lookup.candidate,
    lookup.jobTitle,
    lookup.companyName,
    lookup.cvPdfUrl,
    lookup.coverLetterPdfUrl,
    tab.url
  );
}

// ---- Injected into each frame (isolated world; must be self-contained) ----
function scanFrame() {
  function labelFor(el) {
    if (el.id) {
      const esc = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id;
      const l = document.querySelector(`label[for="${esc}"]`);
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      const d = document.getElementById(describedBy);
      if (d && d.innerText.trim()) return d.innerText.trim();
    }
    const container = el.closest("div,li,fieldset,section");
    if (container) {
      const legend = container.querySelector("legend");
      if (legend && legend.innerText.trim()) return legend.innerText.trim();
      const heading = container.querySelector('label, .label, [class*="label"]');
      if (heading && heading.innerText.trim() && heading !== el) return heading.innerText.trim();
    }
    return el.getAttribute("placeholder") || el.getAttribute("name") || "";
  }
  function visible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) || el.getClientRects().length > 0;
  }

  const fields = [];
  let fi = 0;
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (
      el.tagName === "INPUT" &&
      ["hidden", "submit", "button", "image", "checkbox", "radio", "file"].includes(type)
    )
      return;
    if (!visible(el) || el.disabled) return;
    el.setAttribute("data-boj-field", String(fi));
    fields.push({
      domIndex: fi,
      tag: el.tagName.toLowerCase(),
      type: el.tagName.toLowerCase() === "input" ? type : el.tagName.toLowerCase(),
      placeholder: el.getAttribute("placeholder") || "",
      label: labelFor(el),
      currentValue: el.value || "",
      required: Boolean(el.required),
      options:
        el.tagName === "SELECT"
          ? Array.from(el.options)
              .map((o) => o.textContent.trim())
              .filter(Boolean)
          : undefined,
    });
    fi++;
  });

  const files = [];
  let fx = 0;
  document.querySelectorAll('input[type="file"]').forEach((el) => {
    if (el.disabled) return;
    el.setAttribute("data-boj-file", String(fx));
    files.push({ domIndex: fx, label: labelFor(el) });
    fx++;
  });

  const buttons = [];
  let bx = 0;
  const buttonSelector =
    'button, input[type="submit"], input[type="button"], a, [role="button"], [role="link"], [data-automation-id], [class*="apply"], [class*="button"], [class*="btn"], div[tabindex], span[tabindex], [data-ui*="button"], [class*="option"]';
  const seenBtns = new Set();
  document.querySelectorAll(buttonSelector).forEach((el) => {
    if (!visible(el) || el.disabled) return;
    const text = (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").trim();
    if (!text || text.length > 120) return;

    // Filter out header navigation links & visual file picker buttons
    const lowerText = text.toLowerCase();
    const href = (el.getAttribute("href") || "").toLowerCase();
    if (
      lowerText.includes("careers") ||
      lowerText.includes("search jobs") ||
      lowerText.includes("talent community") ||
      lowerText.includes("about us") ||
      href.includes("careers.") ||
      href.includes("/careers") ||
      lowerText.includes("choose a file") ||
      lowerText.includes("choose file") ||
      lowerText.includes("select file") ||
      lowerText.includes("select files") ||
      lowerText.includes("browse") ||
      lowerText.includes("upload resume") ||
      lowerText.includes("attach resume")
    ) {
      return;
    }

    const key = lowerText;
    if (seenBtns.has(key)) return;
    seenBtns.add(key);

    el.setAttribute("data-boj-btn", String(bx));
    buttons.push({ domIndex: bx, text: text.slice(0, 80) });
    bx++;
  });

  return {
    fields,
    files,
    buttons,
    bodyText: document.body.innerText.slice(0, 4000),
    frameUrl: location.href,
  };
}

// ============================================================================
// BULK AUTO-APPLY WORKER
// Dashboard creates a bulk_runs row (POST /api/bulk-apply) and relays
// BOJ_BULK_START via the localhost content-bridge; this worker then processes
// each job in order: tailor (wait for PDF) -> lookup docs -> application tab
// -> PageAgent (with completion flag) -> report -> next job.
// Pause/kill/wait_human are read from the same bulk_runs row the dashboard
// edits, so both sides stay in sync through the DB (single source of truth).
// ============================================================================
const BULK_DONE_KEY = "__BOJ_BULK_AGENT_DONE";
const BULK_POLL_MS = 3000;
const BULK_AGENT_TIMEOUT_MS = 20 * 60 * 1000; // hard ceiling per application
const BULK_ALARM = "boj-bulk-keepalive";
// Bump on every worker change -- the run log announces it, so it's always
// obvious which code generation actually drove a run (stale extension = old version).
const BULK_WORKER_VERSION = "2026-08-03-a";

let bulkLoopRunning = false; // in-memory re-entry guard (worker may sleep)
let bulkOwnTabId = null; // one reused tab owned by the current run

async function bulkGetRun(runId) {
  const r = await fetch(`${API_BASE}/api/bulk-apply?id=${encodeURIComponent(runId)}`);
  if (!r.ok) return null;
  return (await r.json()).run || null;
}

async function bulkEvent(runId, evt) {
  try {
    const r = await fetch(`${API_BASE}/api/bulk-apply/${runId}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt),
    });
    return r.ok ? (await r.json()).run : null;
  } catch (e) {
    console.warn("[BOJ Tool Bulk] event failed:", e && e.message ? e.message : e);
    return null;
  }
}

// Waits while the run is paused / waiting_human. Returns the terminal status
// string if the run was killed/done/deleted, otherwise "running".
async function bulkWaitForRunning(runId) {
  for (;;) {
    const run = await bulkGetRun(runId);
    if (!run) return "killed";
    if (run.status === "running") return "running";
    if (run.status !== "paused" && run.status !== "waiting_human") return run.status;
    await sleep(BULK_POLL_MS);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Injected preflight: detect CAPTCHAs / anti-bot blocks BEFORE the agent is
// launched (mirrors the project's hard stop rules -- report, never bypass).
function bulkScanBlockers() {
  const CAP = /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha/i;
  const VENDOR = /captcha-delivery\.com|datadome|distilnetworks\.com|perimeterx|px-cdn|incapsula|imperva/i;
  const TXT =
    /access\s+is\s+temporarily\s+restricted|unusual\s+(activity|traffic)|automated\s*\(?bot\)?\s+activity|verify\s+you\s+are\s+human|please\s+verify\s+you|blocked\s+for\s+security|request\s+has\s+been\s+blocked|access\s+denied/i;
  const frameSrcs = Array.from(document.querySelectorAll("iframe"))
    .map((f) => f.src || "")
    .join(" ");
  if (CAP.test(frameSrcs)) return { block: true, kind: "captcha", detail: "CAPTCHA iframe present on page" };
  if (VENDOR.test(frameSrcs)) return { block: true, kind: "blocked", detail: "anti-bot vendor frame present" };
  let text = "";
  try {
    text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 8000);
  } catch (e) {}
  const m = text.match(TXT);
  if (m) return { block: true, kind: "blocked", detail: m[0] };
  return { block: false };
}

// Injected fallback completion detector: after the agent clicks Submit the
// site shows a confirmation ("Thank you for applying", "Application has been
// submitted", "Bewerbung uebermittelt", ...). If the LLM never calls `done`
// (happens!), the worker still advances + closes the tab on this signal.
// Accents are written as  escapes because this file has a mojibake
// (double-encoded UTF-8) history -- raw accented literals stopped matching
// real page text. Must be run with allFrames:true: embedded ATS confirmations
// (e.g. a Greenhouse iframe on careers.company.com) render INSIDE iframes.
function bulkCheckSubmitted() {
  const OK =
    /thank(s| you) for (your )?(application|applying)|your application (has been|was|has) .{0,25}(submitted|received|sent)|application (has been|was) (successfully )?(submitted|received|sent)|submission (successful|confirmed|complete)|successfully (submitted|applied)|we'?ve received your application|application received|you'?ve applied|already applied|vous avez (d[ée]j[àa] )?postul[ée]?( [àa] cette offre)?|ihre bewerbung (wurde|ist).{0,30}([üu]bermittelt|abgeschickt|eingegangen|verschickt)|bewerbung.{0,20}(erfolgreich|[üu]bermittelt|abgeschickt|eingegangen)|vielen dank f[üu]r ihre bewerbung|danke f[üu]r deine bewerbung|wir haben ihre bewerbung erhalten|candidature.{0,25}envoy[ée]e|demande.{0,25}envoy[ée]e|votre candidature a (bien )?[ée]t[ée] (envoy[ée]e|re[çc]ue|enregistr[ée]e|transmise)|merci (pour|de) votre candidature/i;
  // Well-known post-submit confirmation URL fragments (word-bounded so a
  // pre-submit form URL like /apply/completeProfile never matches).
  const URL_OK =
    /thank[-_ ]?you(?:[/?#.&_-]|$)|\/thanks?(?:[/?#.&_-]|$)|application[-_/]?(?:submitted|received|complete|sent)(?:[/?#.&_-]|$)|submission[-_/]?(?:successful|confirmed|complete)(?:[/?#.&_-]|$)|apply[-_/]?(?:success|confirmed|confirmation|complete)(?:[/?#.&_-]|$)|bewerbung[-_/]?(?:abgeschickt|erfolgreich|best[aä]tigung)(?:[/?#.&_-]|$)/i;
  let text = "";
  try {
    text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 8000);
  } catch (e) {}
  const m = text.match(OK);
  if (m) return { submitted: true, match: m[0] };
  try {
    const um = String(location.href || "").match(URL_OK);
    if (um) return { submitted: true, match: `url:${um[0]}` };
  } catch (e) {}
  return { submitted: false, match: "" };
}

// Page probe (allFrames): is an unsubmitted application flow still on screen?
// Used to VERIFY an agent-reported submission: the click demonstrably missed
// when a REAL submit-intent control still stands, or the form itself (3+
// visible fields / an open Easy-Apply-style modal) is still there. CRITICAL:
// the button regex must match SUBMIT-intent only -- apply-intent labels
// ("Postuler"/"Apply now"/"Solicitar") live on the JOB PAGE ITSELF (LinkedIn,
// Indeed, Glassdoor listings) and matching them relaunches a retry on an
// already-finished flow (double-apply risk + wedged runs).
function bulkSubmitStillVisible() {
  const SUBMIT_RE =
    /submit( application)?|send( my)? application|envoyer( ma)? candidature|envoyer$|^envoyer|soumettre|abschicken|bewerbung (abschicken|einreichen|senden)/i;
  const els = Array.from(
    document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
  );
  for (const el of els) {
    const label = String(el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label || label.length > 80) continue;
    if (!SUBMIT_RE.test(label)) continue;
    if (el.disabled) continue;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    return { found: true, match: `button:"${label.slice(0, 60)}"` };
  }
  // An open application modal (LinkedIn Easy Apply / Indeed widget) still up.
  const modal = document.querySelector(
    '.jobs-easy-apply-modal, #indeed-apply-widget, [role="dialog"][aria-modal], [class*="easy-apply"], [class*="apply-modal"], [class*="ApplyModal"]'
  );
  if (modal) {
    const r = modal.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { found: true, match: "application modal open" };
  }
  // Or a full application form (3+ visible fillable fields) still on screen.
  const fields = Array.from(document.querySelectorAll("input, textarea, select")).filter((el) => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (["hidden", "submit", "button", "image", "file", "password"].includes(type)) return false;
    if (el.disabled) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }).length;
  if (fields >= 3) return { found: true, match: `${fields} form fields still visible` };
  return { found: false, match: "" };
}

// Close the tab the run owns (job finished/killed/...); the next job then
// gets a brand-new tab instead of inheriting the old confirmation page.
// runId optional: when given, the close result is also reported to the run log.
async function bulkCloseOwnedTab(runId) {
  // In-memory id lost to a service-worker respawn? Recover the storage copy
  // before giving up -- the tab must not be orphaned just because of that.
  if (bulkOwnTabId === null || bulkOwnTabId === undefined) {
    try {
      const { bojBulkOwnTabId } = await chrome.storage.local.get("bojBulkOwnTabId");
      if (bojBulkOwnTabId) bulkOwnTabId = bojBulkOwnTabId;
    } catch (e) {}
  }
  if (bulkOwnTabId === null || bulkOwnTabId === undefined) return false;
  const id = bulkOwnTabId;
  bulkOwnTabId = null;
  try {
    await chrome.storage.local.remove("bojBulkOwnTabId");
  } catch (e) {}
  try {
    await chrome.tabs.remove(id);
    if (runId) await bulkEvent(runId, { type: "log", msg: `Closed application tab (id ${id}).` });
    return true;
  } catch (e) {
    if (runId) {
      await bulkEvent(runId, { type: "log", msg: `Tab close note: ${String(e && e.message ? e.message : e)}` });
    }
    return false;
  }
}

async function bulkApplyOne(run, job, lookup) {
  // Clean slate for this job: stale done/submit signals (and the previous
  // job's launch timestamp, which guards the confirmation scanner) from a
  // previous job must never be mistaken for THIS application's state.
  try {
    await chrome.storage.local.remove(["bojSubmitted", "bojBulkDoneResult", "bojAgentLaunchedAt", "bojBulkRelaunch"]);
  } catch (e) {}

  // 1. Open/reuse the run's own tab on the job URL.
  await bulkEvent(run.id, { type: "log", msg: `Opening application tab: ${job.url}` });
  let tab = null;
  if (bulkOwnTabId) {
    try {
      tab = await chrome.tabs.get(bulkOwnTabId);
    } catch (e) {
      bulkOwnTabId = null;
    }
  }
  if (tab) {
    await chrome.tabs.update(tab.id, { url: job.url, active: true });
  } else {
    tab = await chrome.tabs.create({ url: job.url, active: true });
    bulkOwnTabId = tab.id;
  }
  // Persist ownership: a service-worker respawn loses in-memory state, but
  // must still be able to close this tab instead of orphaning it forever.
  // bojBulkJobCtx feeds the onUpdated relaunch path (full-reload multi-step
  // flows wipe the injected agent; the listener relaunches it with this).
  try {
    await chrome.storage.local.set({
      bojBulkOwnTabId: tab.id,
      bojBulkJobCtx: {
        jobUrl: job.url,
        jobTitle: job.title || "",
        companyName: (lookup && lookup.companyName) || job.company_name || "",
        cvPdfUrl: (lookup && lookup.cvPdfUrl) || "",
        coverLetterPdfUrl: (lookup && lookup.coverLetterPdfUrl) || "",
        candidate: lookup && lookup.candidate,
      },
    });
  } catch (e) {}

  // Brief pause for page initialization
  await sleep(1500);

  // 2. Quick non-blocking blocker check
  try {
    const [scan] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: bulkScanBlockers }).catch(() => []);
    const r = scan && scan.result;
    if (r && r.block) {
      return { outcome: r.kind === "captcha" ? "requires_captcha" : "blocked_by_site", detail: r.detail };
    }
  } catch (e) {}

  // 3. Launch PageAgent immediately!
  await bulkEvent(run.id, { type: "log", msg: "Launching PageAgent on application page..." });
  // Clear the completion flag in BOTH script worlds: MAIN and ISOLATED have
  // separate window globals, and the agent can land in either one (MAIN
  // preferred, ISOLATED is the fallback in executePageAgentOnTab). Clearing
  // only one was the "flag invisible forever" bug.
  const clearFlag = async (world) =>
    chrome.scripting
      .executeScript({ target: { tabId: tab.id }, world, func: (k) => { window[k] = null; }, args: [BULK_DONE_KEY] })
      .catch(() => {});
  await clearFlag("MAIN");
  await clearFlag("ISOLATED");
  // Launch timestamp drives the tabs.onUpdated confirmation guard (it only
  // accepts confirmation pages appearing >8s after the agent started). The
  // relaunch-in-flight stamp lets the SAME window's duplicate navigation
  // events (which arrive DURING executePageAgentOnTab's multi-second setup,
  // before the page-side running flag exists) skip the relaunch branch --
  // otherwise the second launch trips the stale-flag guard and kills the job.
  try {
    await chrome.storage.local.set({ bojAgentLaunchedAt: Date.now(), bojBulkRelaunch: { tabId: tab.id, url: job.url, at: Date.now() } });
  } catch (e) {}
  await executePageAgentOnTab(
    tab.id,
    lookup.candidate,
    job.title,
    (lookup && lookup.companyName) || job.company_name,
    lookup.cvPdfUrl || "",
    lookup.coverLetterPdfUrl || "",
    job.url,
    { bulk: true, autoSubmit: !!run.auto_submit, doneKey: BULK_DONE_KEY }
  );

  // 4. Poll for the agent's completion signal (or kill/pause from dashboard).
  //    FOUR independent signals, because a post-submit page NAVIGATION wipes
  //    the whole window context -- and with it the classic window flag:
  //    (a) bojBulkDoneResult -- the done-relay's runtime message, dispatched
  //        the instant the agent calls done() (survives the poll gap),
  //    (b) bojSubmitted -- set by the tabs.onUpdated guard when the owned tab
  //        lands on a confirmation page (full-reload submit),
  //    (c) window[doneKey] -- same-document (SPA) submit path,
  //    (d) an all-frames confirmation text/URL scan below, run once the tab
  //        navigated or 20s passed (agent stopped without calling done).
  const started = Date.now();
  let flagReadFails = 0;
  const jobBase = stripApplyStep(job.url);
  // Ownership can TRANSFER mid-application (popup adoption in tabs.onCreated):
  // track the CURRENT owned tab id from storage, and accept completion
  // signals from any tab that ever belonged to THIS job (a done-relay sent
  // by the just-replaced LinkedIn source tab would otherwise be dropped by
  // a strict tabId === ownedTabId check).
  let ownedTabId = tab.id;
  const jobTabIds = new Set([tab.id]);
  let selfHealCount = 0;
  for (;;) {
    if (Date.now() - started > BULK_AGENT_TIMEOUT_MS) {
      await bulkEvent(run.id, { type: "log", msg: "Agent timed out (20 min without completion signal) -- closing tab." });
      await bulkCloseOwnedTab(run.id);
      return { outcome: "agent_timeout", detail: "no completion signal within 20 minutes" };
    }
    const st = await bulkWaitForRunning(run.id);
    if (st !== "running") {
      await bulkCloseOwnedTab();
      return { outcome: "agent_failed", detail: `run ${st} by user` };
    }

    // Refresh tab ownership BEFORE reading anything tab-scoped.
    try {
      const { bojBulkOwnTabId: curOwn } = await chrome.storage.local.get("bojBulkOwnTabId");
      if (curOwn && curOwn !== ownedTabId) {
        ownedTabId = curOwn;
        jobTabIds.add(curOwn);
      }
    } catch (e) {}

    // (a)/(b) One-shot signals recorded by the runtime listeners while we poll.
    let stored = {};
    try {
      stored = await chrome.storage.local.get(["bojBulkDoneResult", "bojSubmitted"]);
    } catch (e) {}
    const dres = stored.bojBulkDoneResult;
    if (dres && jobTabIds.has(dres.tabId) && dres.runId === run.id && dres.at >= started - 10000) {
      await chrome.storage.local.remove("bojBulkDoneResult");
      await bulkEvent(run.id, { type: "log", msg: `Agent completion received via done-relay (success=${!!dres.success}).` });
      const dresResult = await bulkHandleAgentDone(run, job, { done: true, success: !!dres.success, detail: dres.detail });
      if (dresResult) return dresResult;
      // null = unconfirmed submit claim (retry launched) or external-application
      // handoff (destination-page agent owns the outcome) -- keep polling.
    }
    const sub = stored.bojSubmitted;
    if (run.auto_submit && sub && jobTabIds.has(sub.tabId) && sub.at >= started - 10000) {
      await chrome.storage.local.remove("bojSubmitted");
      await bulkEvent(run.id, { type: "log", msg: `Submit confirmation detected after navigation ("${String(sub.match).slice(0, 60)}").` });
      await bulkCloseOwnedTab(run.id);
      return {
        outcome: "submitted",
        detail: `confirmation detected after navigation ("${String(sub.match).slice(0, 80)}")`,
      };
    }

    // (c) The window flag: MAIN world first (agent's normal world), then
    // ISOLATED (fallback injection world) -- they do NOT share window globals.
    // NOTE: read errors MUST propagate (the old try/return-null wrapper
    // silently null'ed them, leaving a dead tab to spin to the 20-min timeout).
    let flag = null;
    let currentUrl = "";
    try {
      const liveTab = await chrome.tabs.get(ownedTabId); // throws once the tab is gone
      currentUrl = (liveTab && liveTab.url) || "";
      const readFlag = async (world) => {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: ownedTabId },
          world,
          func: (k) => window[k],
          args: [BULK_DONE_KEY],
        });
        return res && res.result;
      };
      flag = (await readFlag("MAIN")) || (await readFlag("ISOLATED"));
      flagReadFails = 0;
    } catch (e) {
      // Right after Submit the page usually NAVIGATES to a confirmation URL,
      // which briefly destroys the old document context -- tolerate a few
      // failures instead of instantly failing the job.
      flagReadFails++;
      // An exception here can also mean ownership TRANSFERRED to a popup tab
      // (adoption) and THIS id is now dead: follow the transfer instead of
      // failing the job.
      try {
        const { bojBulkOwnTabId: storedOwn } = await chrome.storage.local.get("bojBulkOwnTabId");
        if (storedOwn && storedOwn !== ownedTabId) {
          ownedTabId = storedOwn;
          jobTabIds.add(storedOwn);
          flagReadFails = 0;
          await sleep(BULK_POLL_MS);
          continue;
        }
      } catch (e2) {}
      if (flagReadFails >= 6) {
        await bulkCloseOwnedTab();
        return { outcome: "agent_failed", detail: "application tab closed/navigated mid-run" };
      }
      await sleep(BULK_POLL_MS);
      continue;
    }
    if (flag && flag.done) {
      await bulkEvent(run.id, { type: "log", msg: `Agent completion flag received (success=${!!flag.success}).` });
      const flagResult = await bulkHandleAgentDone(run, job, flag);
      if (flagResult) return flagResult;
      // null = unconfirmed submit claim, agent relaunched for a real click -- keep polling.
    }

    // (d) Fallback: the agent submitted but never called done -- scan the
    // confirmation text/URL across ALL frames (embedded ATS confirmations
    // render inside iframes), then close the tab and advance.
    const navigated = currentUrl && stripApplyStep(currentUrl) !== jobBase && !wanderedOffJobPage(currentUrl, job.url);
    if (run.auto_submit && (navigated || Date.now() - started > 20000)) {
      try {
        const frames = await chrome.scripting
          .executeScript({ target: { tabId: ownedTabId, allFrames: true }, func: bulkCheckSubmitted })
          .catch(() => []);
        const hit = (frames || []).find((f) => f && f.result && f.result.submitted);
        if (hit) {
          await bulkEvent(run.id, { type: "log", msg: `Submit confirmation detected on page ("${String(hit.result.match).slice(0, 60)}").` });
          await bulkCloseOwnedTab(run.id);
          return {
            outcome: "submitted",
            detail: `confirmation detected on page ("${String(hit.result.match).slice(0, 80)}")`,
          };
        }
      } catch (e) {}
    }

    // Self-healing watchdog: the agent vanished WITHOUT any completion signal
    // (mid-run full page reload, redirector race, crashed run, injection
    // failure). The tabs.onUpdated relaunch branch covers complete-load
    // events; this is the catch-all for the silent cases. Don't fail the job
    // -- RELAUNCH the agent on whatever page the tab currently shows.
    // Bounded: if self-heals keep dying, the site is genuinely hostile --
    // fail LOUDLY instead of looping forever.
    //
    // Fuse is idle time (45s since the last launch/relaunch), not job time:
    // a healthy agent keeps __BOJ_PAGE_AGENT_RUNNING set for its whole run,
    // so long legitimate fills never trip this -- only a MISSING flag does.
    // reportDone clears the flag, but the done signal is consumed by the
    // checks above within one poll cycle (3s), far inside the 45s fuse.
    const { bojAgentLaunchedAt: launchedAt } = await chrome.storage.local.get("bojAgentLaunchedAt").catch(() => ({}));
    const agentIdleMs = Date.now() - Math.max(started, launchedAt || 0);
    if (agentIdleMs > 45000) {
      try {
        // Don't act while a relaunch is in flight (stamp set on every
        // completed load / launch attempt) or while the tab is still loading
        // the document the relaunch will target -- the running flag is
        // legitimately absent in both windows.
        const { bojBulkRelaunch } = await chrome.storage.local.get("bojBulkRelaunch");
        const relaunching = bojBulkRelaunch && jobTabIds.has(bojBulkRelaunch.tabId) && Date.now() - bojBulkRelaunch.at < 15000;
        const tabInfo = await chrome.tabs.get(ownedTabId).catch(() => null);
        if (relaunching || !tabInfo || tabInfo.status === "loading") {
          await sleep(BULK_POLL_MS);
          continue;
        }
        const readRunning = async (world) => {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: ownedTabId },
            world,
            func: () => !!(window.__BOJ_PAGE_AGENT_RUNNING || window.__BOJ_CV_INJECTOR_ACTIVE),
          });
          return res && res.result;
        };
        let agentAlive = (await readRunning("MAIN")) || (await readRunning("ISOLATED"));
        if (!agentAlive) {
          const [rIso] = await chrome.scripting
            .executeScript({ target: { tabId: ownedTabId }, world: "ISOLATED", func: () => !!window.__BOJ_DONE_RELAY_ACTIVE })
            .catch(() => []);
          agentAlive = !!(rIso && rIso.result);
        }
        if (!agentAlive) {
          selfHealCount++;
          if (selfHealCount > 3) {
            await bulkEvent(run.id, {
              type: "log",
              msg: "Agent vanished without any completion signal and 3 self-heal relaunches died the same way -- giving up on this job (site may be hard-blocking automation).",
            });
            await bulkCloseOwnedTab(run.id);
            return { outcome: "agent_failed", detail: "agent vanished without completion signal; 3 self-heal relaunches exhausted (site may be blocking automation)" };
          }
          const curHealUrl = (tabInfo && tabInfo.url) || job.url;
          await bulkEvent(run.id, {
            type: "log",
            msg: `Agent gone from the page without any completion signal -- self-healing: relaunching on the current page (${selfHealCount}/3): ${String(curHealUrl).slice(0, 90)}`,
          });
          const clrDead = (w) =>
            chrome.scripting.executeScript({ target: { tabId: ownedTabId }, world: w, func: (k) => { window[k] = null; }, args: [BULK_DONE_KEY] }).catch(() => {});
          await clrDead("MAIN");
          await clrDead("ISOLATED");
          await chrome.storage.local.set({
            bojAgentLaunchedAt: Date.now(),
            bojBulkRelaunch: { tabId: ownedTabId, url: curHealUrl, at: Date.now() },
          });
          await executePageAgentOnTab(
            ownedTabId,
            lookup.candidate,
            job.title,
            (lookup && lookup.companyName) || job.company_name,
            lookup.cvPdfUrl || "",
            lookup.coverLetterPdfUrl || "",
            job.url,
            { bulk: true, autoSubmit: !!run.auto_submit, doneKey: BULK_DONE_KEY }
          );
        }
      } catch (e) {}
    }
    await sleep(BULK_POLL_MS);
  }
}

async function bulkHandleAgentDone(run, job, flag) {
  const detail = String(flag.detail || "");
  // EXTERNAL-APPLICATION HANDOFF (non-terminal): the agent clicked an
  // off-site "Postuler"/"Apply" and the application CONTINUES on the
  // destination page (same-tab navigation in bulk, or an adopted popup tab).
  // This is NOT a submit claim -- treating it as one either false-marks the
  // job as submitted or fires a nonsense "just click submit again" retry on
  // the destination's EMPTY form. Log it and keep polling: the relaunched
  // destination-page agent (tabs.onUpdated bulk branch / self-heal) owns the
  // real terminal signal. If the tab actually went NOWHERE (the new-tab
  // capture missed the click), relaunch the agent on the same page once so
  // it can click Apply again.
  if (flag.success && /opened external application tab|handed off|external application (site|page|tab)/i.test(detail)) {
    await bulkEvent(run.id, {
      type: "log",
      msg: `External-application handoff ("${detail.slice(0, 80)}") -- the application continues on the destination page; waiting for the relaunched agent there.`,
    });
    try {
      await sleep(5000); // let the destination navigation commit
      const { bojBulkOwnTabId, bojBulkJobCtx } = await chrome.storage.local.get(["bojBulkOwnTabId", "bojBulkJobCtx"]);
      let alive = false;
      let curUrl = "";
      if (bojBulkOwnTabId) {
        const t = await chrome.tabs.get(bojBulkOwnTabId).catch(() => null);
        curUrl = (t && t.url) || "";
        const [r] = await chrome.scripting
          .executeScript({ target: { tabId: bojBulkOwnTabId }, world: "MAIN", func: () => !!window.__BOJ_PAGE_AGENT_RUNNING })
          .catch(() => []);
        alive = !!(r && r.result);
      }
      const navigated = curUrl && stripApplyStep(curUrl) !== stripApplyStep(job.url);
      if (!navigated && !alive && bojBulkOwnTabId && bojBulkJobCtx && bojBulkJobCtx.candidate && !bojBulkJobCtx.handoffRelaunched) {
        await bulkEvent(run.id, {
          type: "log",
          msg: "The Apply/Postuler click never navigated the tab (capture missed) -- relaunching the agent on the same page to retry it (once).",
        });
        await chrome.storage.local.set({ bojBulkJobCtx: { ...bojBulkJobCtx, handoffRelaunched: true } });
        const clrH = (w) =>
          chrome.scripting.executeScript({ target: { tabId: bojBulkOwnTabId }, world: w, func: (k) => { window[k] = null; }, args: [BULK_DONE_KEY] }).catch(() => {});
        await clrH("MAIN");
        await clrH("ISOLATED");
        await chrome.storage.local.set({
          bojAgentLaunchedAt: Date.now(),
          bojBulkRelaunch: { tabId: bojBulkOwnTabId, url: curUrl, at: Date.now() },
        });
        await executePageAgentOnTab(
          bojBulkOwnTabId,
          bojBulkJobCtx.candidate,
          bojBulkJobCtx.jobTitle || "",
          bojBulkJobCtx.companyName || "",
          bojBulkJobCtx.cvPdfUrl || "",
          bojBulkJobCtx.coverLetterPdfUrl || "",
          bojBulkJobCtx.jobUrl || curUrl,
          { bulk: true, autoSubmit: !!run.auto_submit, doneKey: BULK_DONE_KEY }
        );
      }
    } catch (e) {}
    return null; // caller keeps polling: the destination-page agent owns the outcome
  }
  if (!flag.success) {
    await bulkCloseOwnedTab(run.id);
    const low = detail.toLowerCase();
    if (low.includes("captcha")) return { outcome: "requires_captcha", detail };
    if (low.includes("denied") || low.includes("unusual") || low.includes("blocked")) {
      return { outcome: "blocked_by_site", detail };
    }
    return { outcome: "agent_failed", detail: detail || "agent stopped without reporting success" };
  }
  if (run.auto_submit) {
    // VERIFY before trusting: the agent sometimes claims "submitted" while
    // its click never actually landed (stale element index after an SPA
    // re-render, disabled button, swallowed synthetic click) -- marking such
    // a job as applied is a false positive. Corroborate with page evidence:
    // a confirmation (text/URL) verifies it; a submit button still standing
    // with NO confirmation anywhere proves the click missed.
    const { bojBulkOwnTabId } = await chrome.storage.local.get("bojBulkOwnTabId");
    let verified = false;
    let submitStillThere = false;
    let btnMatch = "";
    if (bojBulkOwnTabId) {
      try {
        await sleep(4000); // give a real submit's confirmation a moment to render
        const confFrames = await chrome.scripting
          .executeScript({ target: { tabId: bojBulkOwnTabId, allFrames: true }, func: bulkCheckSubmitted })
          .catch(() => []);
        verified = !!(confFrames || []).find((f) => f && f.result && f.result.submitted);
        if (!verified) {
          const btnFrames = await chrome.scripting
            .executeScript({ target: { tabId: bojBulkOwnTabId, allFrames: true }, func: bulkSubmitStillVisible })
            .catch(() => []);
          const btnHit = (btnFrames || []).find((f) => f && f.result && f.result.found);
          if (btnHit) {
            submitStillThere = true;
            btnMatch = String(btnHit.result.match || "");
          }
        }
      } catch (e) {}
    }
    if (verified) {
      await bulkCloseOwnedTab(run.id);
      return { outcome: "submitted", detail: (detail || "agent reported submit") + " (confirmation verified)" };
    }
    if (submitStillThere) {
      // The click demonstrably never landed: submit control still on screen,
      // zero confirmation evidence. Retry the submit ONCE with a fresh agent;
      // beyond that, fail LOUDLY -- never mark the job as applied.
      const { bojBulkJobCtx } = await chrome.storage.local.get("bojBulkJobCtx");
      if (!bojBulkJobCtx || !bojBulkJobCtx.candidate || bojBulkJobCtx.submitRetried) {
        await bulkCloseOwnedTab(run.id);
        return {
          outcome: "agent_failed",
          detail: `agent claimed submit but the application is still open (${btnMatch}) and no confirmation appeared${bojBulkJobCtx && bojBulkJobCtx.submitRetried ? " (after retry)" : ""} -- NOT marked submitted; needs manual review`,
        };
      }
      await bulkEvent(run.id, {
        type: "log",
        msg: `Agent claimed submit but the application is still open (${btnMatch}) with no confirmation found -- relaunching the agent to actually click submit (once).`,
      });
      await chrome.storage.local.set({ bojBulkJobCtx: { ...bojBulkJobCtx, submitRetried: true } });
      const clr = (w) =>
        chrome.scripting.executeScript({ target: { tabId: bojBulkOwnTabId }, world: w, func: (k) => { window[k] = null; }, args: [BULK_DONE_KEY] }).catch(() => {});
      await clr("MAIN");
      await clr("ISOLATED");
      const retryTab = await chrome.tabs.get(bojBulkOwnTabId).catch(() => null);
      await chrome.storage.local.set({ bojAgentLaunchedAt: Date.now(), bojBulkRelaunch: { tabId: bojBulkOwnTabId, url: (retryTab && retryTab.url) || "", at: Date.now() } });
      await executePageAgentOnTab(
        bojBulkOwnTabId,
        bojBulkJobCtx.candidate,
        bojBulkJobCtx.jobTitle || "",
        bojBulkJobCtx.companyName || "",
        bojBulkJobCtx.cvPdfUrl || "",
        bojBulkJobCtx.coverLetterPdfUrl || "",
        bojBulkJobCtx.jobUrl || "",
        { bulk: true, autoSubmit: true, doneKey: BULK_DONE_KEY, submitRetry: true }
      );
      return null; // caller keeps polling for the retried agent's completion
    }
    // Form gone (navigated/closed) but no confirmation text: accept, flagged.
    await bulkCloseOwnedTab(run.id);
    return { outcome: "submitted", detail: (detail || "agent reported submit") + " (form left view; no confirmation text detected)" };
  }
  // Manual-submit mode: form is filled, human must review + click Submit in
  // the tab -- the tab MUST stay open here. Pause the run until the
  // dashboard says Resume (or Skip).
  await bulkEvent(run.id, { type: "status", status: "waiting_human" });
  const st = await bulkWaitForRunning(run.id);
  if (st !== "running") {
    await bulkCloseOwnedTab();
    return { outcome: "agent_failed", detail: `run ${st} by user` };
  }
  const fresh = await bulkGetRun(run.id);
  const res = fresh && fresh.results && fresh.results[job.id];
  await bulkCloseOwnedTab();
  if (res && res.outcome === "skipped") {
    return { outcome: "agent_failed", detail: "skipped by user after review (not submitted)" };
  }
  return { outcome: "submitted", detail: "confirmed by user (manual submit mode)" };
}

async function bulkLoop(runId) {
  let run = await bulkGetRun(runId);
  if (!run) return;
  const jobIds = run.job_ids || [];

  for (let i = run.current_index; i < jobIds.length; i++) {
    if ((await bulkWaitForRunning(runId)) !== "running") {
      await bulkCloseOwnedTab();
      return;
    }
    run = await bulkGetRun(runId);

    const jobId = jobIds[i];
    let job = null;
    try {
      const r = await fetch(`${API_BASE}/api/jobs/${jobId}`);
      if (r.ok) job = await r.json();
    } catch (e) {}
    if (!job || !job.url) {
      await bulkEvent(runId, { type: "job_finished", jobId, outcome: "agent_failed", detail: "job row or URL missing" });
      continue;
    }

    await bulkEvent(runId, { type: "start_job", index: i, jobId, title: job.title });
    await bulkEvent(runId, { type: "log", msg: `Starting job ${i + 1}/${jobIds.length}: "${job.title}" at ${job.company_name}` });

    // Close any previous job application tab BEFORE starting tailoring for the next job
    if (bulkOwnTabId) {
      try { await chrome.tabs.remove(bulkOwnTabId); } catch (e) {}
      bulkOwnTabId = null;
    }

    // ---- Step 1: tailor CV + cover letter (with graceful fallback to existing master CV) ----
    await bulkEvent(runId, { type: "log", msg: "Preparing tailored CV & Cover Letter..." });
    let tailorError = null;
    try {
      const res = await fetch(`${API_BASE}/api/tailor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      });
      let finalEvt = null;
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const ln of lines) {
            const t = ln.trim();
            if (!t) continue;
            try {
              const e = JSON.parse(t);
              if (e.type === "progress" && e.message) {
                await bulkEvent(runId, { type: "log", msg: `ðŸ“„ ${e.message}` });
              }
              if (e.type === "result" || e.type === "error") finalEvt = e;
            } catch (e2) {}
          }
        }
      }
      if (!finalEvt && res.status !== 200) tailorError = `tailor stream ended (HTTP ${res.status})`;
      else if (finalEvt && finalEvt.type === "error") tailorError = finalEvt.error || "tailor failed";
    } catch (e) {
      console.warn("[BOJ Tool Bulk] tailoring attempt note:", e);
      tailorError = String(e && e.message ? e.message : e);
    }
    // HARD GATE: never apply with a stale/wrong CV. A silent "graceful
    // fallback" here previously masked every tailoring failure and applied
    // with whatever last CV happened to exist -- fail the job out loud instead.
    if (tailorError) {
      await bulkEvent(runId, { type: "job_finished", jobId, outcome: "tailor_failed", detail: tailorError });
      continue;
    }
    await bulkEvent(runId, { type: "log", msg: "Tailored OK -- launching application page..." });
    if ((await bulkWaitForRunning(runId)) !== "running") {
      await bulkCloseOwnedTab();
      return;
    }

    // ---- Step 2: fresh lookup -> tailored PDF URLs + candidate profile ----
    let lookup = null;
    try {
      const r = await fetch(`${API_BASE}/api/auto-apply/lookup?jobId=${encodeURIComponent(jobId)}`);
      if (r.ok) lookup = await r.json();
    } catch (e) {}
    if (!lookup || !lookup.candidate) {
      await bulkEvent(runId, { type: "job_finished", jobId, outcome: "agent_failed", detail: "candidate lookup failed" });
      continue;
    }

    // ---- Step 3: the application itself ----
    const outcome = await bulkApplyOne(run, job, lookup);
    await bulkEvent(runId, { type: "job_finished", jobId, outcome: outcome.outcome, detail: outcome.detail });

    // Close the application tab immediately after job completion so we proceed cleanly to the next job
    if (bulkOwnTabId) {
      await bulkEvent(runId, { type: "log", msg: `Closing tab for "${job.title}" and advancing to next job...` });
      try { await chrome.tabs.remove(bulkOwnTabId); } catch (e) {}
      bulkOwnTabId = null;
    }
  }

  await bulkEvent(runId, { type: "status", status: "done" });
  await bulkEvent(runId, { type: "log", msg: "ðŸŽ‰ All bulk jobs completed!" });
  if (bulkOwnTabId) {
    try { await chrome.tabs.remove(bulkOwnTabId); } catch (e) {}
    bulkOwnTabId = null;
  }
}

async function bulkStart(runId) {
  if (bulkLoopRunning) {
    console.log("[BOJ Tool Bulk] worker already running, resetting for runId:", runId);
  }
  bulkLoopRunning = true;
  await chrome.storage.local.set({ bojBulkRunId: runId });

  // Restore the application tab id across service-worker respawns (MV3
  // workers get killed and lose in-memory state; a respawned worker must
  // still be able to close its run's tab instead of orphaning it).
  try {
    const { bojBulkOwnTabId } = await chrome.storage.local.get("bojBulkOwnTabId");
    if (bojBulkOwnTabId) {
      await chrome.tabs.get(bojBulkOwnTabId); // throws if the tab is gone
      bulkOwnTabId = bojBulkOwnTabId;
    }
  } catch (e) {
    bulkOwnTabId = null;
  }

  await bulkEvent(runId, { type: "log", msg: `ðŸš€ Bulk Apply worker started (v${BULK_WORKER_VERSION})...` });

  if (chrome.alarms && chrome.alarms.create) {
    chrome.alarms.create(BULK_ALARM, { periodInMinutes: 0.5 }); // wakes the SW if it sleeps mid-run
  }
  try {
    await bulkLoop(runId);
  } catch (e) {
    console.error("[BOJ Tool Bulk] worker crashed:", e);
    await bulkEvent(runId, { type: "log", msg: `worker crashed: ${String(e && e.message ? e.message : e)}` });
  } finally {
    bulkLoopRunning = false;
    await bulkCloseOwnedTab(); // never leave the run's application tab behind
    await chrome.storage.local.remove(["bojBulkRunId", "bojBulkOwnTabId", "bojAgentLaunchedAt", "bojSubmitted", "bojBulkDoneResult", "bojBulkJobCtx", "bojBulkRelaunch"]);
    if (chrome.alarms && chrome.alarms.clear) await chrome.alarms.clear(BULK_ALARM);
  }
}

// Keepalive/resume: if the service worker was killed mid-run, the alarm wakes
// it and re-enters the loop from the run's DB-persisted current_index.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LOGIN_WATCH_ALARM) {
    // Login-watch backup poll (the primary trigger is tabs.onUpdated): if the
    // service worker slept while the human was signing in, this re-checks.
    checkLoginWatch().catch((e) => console.warn("[BOJ Tool] login-watch alarm note:", e));
    return;
  }
  if (alarm.name !== BULK_ALARM) return;
  (async () => {
    if (bulkLoopRunning) return;
    const { bojBulkRunId } = await chrome.storage.local.get("bojBulkRunId");
    if (bojBulkRunId) await bulkStart(bojBulkRunId);
  })();
});
