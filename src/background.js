// Background service worker
//
// The `activate` event fires on every service worker startup — including after
// CRXJS triggers chrome.runtime.reload() on each HMR cycle. We use it to
// reload any open tabs that have the content script injected.

const CONTENT_SCRIPT_HOSTS = [
  'facebook.com/marketplace',
  'facebook.com/messages',
  'messenger.com/marketplace/',
]

function reloadMatchingTabs() {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab.url && CONTENT_SCRIPT_HOSTS.some((h) => tab.url.includes(h))) {
          chrome.tabs.reload(tab.id)
        }
      }
      resolve()
    })
  })
}

// Handle download requests from content scripts (bypasses CSP blob: restrictions)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'download' && msg.url && msg.filename) {
    chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[OL Downloader] Download failed:', chrome.runtime.lastError)
      } else {
        console.log('[OL Downloader] Download started:', downloadId)
      }
    })
    sendResponse({ ok: true })
    return
  }

  // Relay for the openlane.js content script: content scripts run in the
  // page's origin and are subject to ordinary mixed-content blocking, so an
  // https://app.openlane.ca page can't fetch() http://127.0.0.1. Only this
  // privileged background context gets the host_permissions bypass.
  if (msg.type === 'PUSH_OPENLANE_TOKEN' && msg.tokenBlob) {
    // Pushed verbatim — the backend now parses Okta's own token-storage
    // shape (access/id/refresh) directly, so no re-wrapping here.
    fetch('http://127.0.0.1:8000/openlane/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.tokenBlob),
    })
      .then((response) => {
        console.log('[OL Downloader] Token push status:', response.status)
        sendResponse({ ok: response.ok, status: response.status })
      })
      .catch((err) => {
        console.error('[OL Downloader] Token push failed:', err)
        sendResponse({ ok: false, error: String(err) })
      })
    return true // keep the message channel open for the async response
  }
})

self.addEventListener('activate', (event) => {
  console.log('[MP Filter] SW activate → reloading tabs')
  event.waitUntil(reloadMatchingTabs())
})

// During development, CRXJS only restarts the service worker when background.js
// itself changes (which fires `activate`). Changes to content.js go through a
// separate hot-update path and do NOT restart the SW.
//
// To cover that case we listen for the custom 'reload-tabs' event that
// vite.config.js emits via `server.ws.send()` on every content.js / styles.css
// hot update.  `import.meta.hot` is `undefined` in production builds so this
// block is dead-code-eliminated by Rollup.
if (import.meta.hot) {
  import.meta.hot.on('reload-tabs', () => {
    console.log('[MP Filter] content-script HMR → reloading tabs')
    reloadMatchingTabs()
  })
}
