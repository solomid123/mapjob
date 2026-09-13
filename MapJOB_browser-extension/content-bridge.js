// Injected into http://localhost/* and http://127.0.0.1/* to bridge web app messages to extension
const bojBridgeAlive = () =>
  typeof chrome !== "undefined" && chrome.runtime && !!chrome.runtime.id;

// Presence handshake: the web app PINGs before handing us work (bulk start /
// page-agent launch). No PONG = bridge not injected on this tab (extension
// disabled/missing/tab predates the extension), PONG alive=false = injected
// but the extension context died (extension reload) -> tab must be refreshed.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "BOJ_EXT_PING") {
    window.postMessage({ type: "BOJ_EXT_PONG", token: event.data.token, alive: bojBridgeAlive() }, "*");
    return;
  }
});

// One-shot READY broadcast (covers passive UI indicators); the PING/PONG above
// is the authoritative check, since this fires before the app's listener may
// be mounted.
try {
  window.postMessage({ type: "BOJ_EXT_BRIDGE_READY", alive: bojBridgeAlive() }, "*");
} catch (e) {}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data && event.data.type === "BOJ_EXT_PING") return; // handled above

  // Check if extension context is alive before accessing chrome API
  if (!bojBridgeAlive()) {
    if (event.data && (event.data.type === "BOJ_BULK_START" || event.data.type === "BOJ_LAUNCH_PAGE_AGENT")) {
      // Informational recovery guidance (this tab holds a dead context after an
      // extension reload) — NOT a malfunction: keep it out of chrome://extensions
      // "Errors" (console.warn entries get collected there and alarm the user).
      // The alert() below is the user-facing recovery hint.
      console.log("[BOJ Bridge] Extension context invalidated. Please hard-reload this tab (F5).");
      alert("[BOJ Tool] Extension was reloaded. Please refresh (F5) this tab to reconnect!");
    }
    return;
  }

  // Bulk-apply: dashboard hands the created run id to the extension worker.
  if (event.data && event.data.type === "BOJ_BULK_START" && event.data.runId) {
    console.log("[BOJ Tool Extension Bridge] Received bulk start from web app:", event.data);
    try {
      chrome.runtime.sendMessage(event.data, () => {
        if (chrome.runtime.lastError) {
          console.log("[BOJ Bridge] Background notification handled.");
        }
      });
    } catch (err) {
      console.warn("[BOJ Tool Extension Bridge] Extension context note:", err);
    }
    return;
  }

  if (event.data && event.data.type === "BOJ_LAUNCH_PAGE_AGENT" && event.data.jobUrl) {
    console.log("[BOJ Tool Extension Bridge] Received launch request from web app:", event.data);
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({
          activeTask: {
            jobUrl: event.data.jobUrl,
            candidate: event.data.candidate,
            jobTitle: event.data.jobTitle,
            companyName: event.data.companyName,
            cvPdfUrl: event.data.cvPdfUrl,
            coverLetterPdfUrl: event.data.coverLetterPdfUrl,
            time: Date.now(),
          },
        });
      }
      chrome.runtime.sendMessage(event.data, () => {
        // Catch lastError if background worker was sleeping
        if (chrome.runtime.lastError) {
          console.log("[BOJ Bridge] Background notification handled.");
        }
      });
    } catch (err) {
      console.warn("[BOJ Tool Extension Bridge] Extension context note:", err);
    }
  }
});
