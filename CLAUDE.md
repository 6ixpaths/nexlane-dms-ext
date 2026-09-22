# Nexlane DMS Extension — CLAUDE.md

## Project Overview

**Nexlane DMS Extension** (repo: `nexlane-dms-ext`) is a browser extension (Chrome MV3 +
Firefox MV2) with two feature sets:

1. **Marketplace chat filter** (`src/content.js`) — injects a filter dropdown into the
   Facebook Messenger/Marketplace chat sidebar. The dropdown is populated exclusively from
   listings scraped off the user's own selling page, letting them filter chats by listing name.
2. **Openlane tools** (`src/openlane.js`) — adds a ZIP download button to the
   `app.openlane.ca` photo gallery, and relays the user's Openlane access token to a local
   Nexlane service (`http://127.0.0.1:8000/openlane/token`) via `src/background.js`.

Most of this file documents the Marketplace chat filter.

Built with **Vite** + **CRXJS** for streamlined development with HMR (Hot Module Replacement)
on Chrome and efficient builds for both browsers.

## File Structure

```
nexlane-dms-ext/
├── src/
│   ├── content.js             # Marketplace chat filter (content script)
│   ├── styles.css             # Injected CSS for the filter bar
│   ├── openlane.js            # Openlane gallery downloader + token relay (content script)
│   ├── openlane.css           # Injected CSS for the Openlane download UI
│   └── background.js          # Downloads, token relay to 127.0.0.1, dev tab reloading
├── manifest.chrome.js         # Chrome MV3 manifest (CRXJS config)
├── manifest.firefox.js        # Firefox MV2 manifest (plain object)
├── vite.config.js             # Vite build config (conditionally loads manifests)
├── web-ext-config.mjs         # Firefox binary path + web-ext run defaults
├── package.json               # Dependencies: vite, @crxjs/vite-plugin, web-ext, concurrently
├── test/                      # Static HTML snapshots for local testing (no extension APIs needed)
├── dist-chrome/               # Chrome build output (generated, gitignored)
├── dist-firefox/              # Firefox build output (generated, gitignored)
├── icon48.png
├── icon128.png
└── CLAUDE.md                  # This file
```

## Build System

### Vite + CRXJS

- **Chrome dev server** (`npm run dev`): Uses CRXJS plugin with HMR for instant reloads
- **Firefox dev server** (`npm run dev:firefox`): Standard Vite bundling (HMR not applicable to MV2)
- **Conditional manifest loading**: `BROWSER` env var controls which manifest is used
- **Shared source**: Single `src/` folder builds to both Chrome MV3 and Firefox MV2

## User Flow

1. User opens the Facebook Messenger/chat page → sees "Filters inactive — Open your selling
   page to load listings." with a clickable link.
2. User opens their selling page (`/marketplace/you/selling`) — same tab or new tab.
3. The content script scrapes listing names from that page and stores them in
   `chrome.storage.local`.  A blue badge briefly appears confirming the count.
4. The chat page activates the dropdown (immediately via `storage.onChanged` on Chrome;
   within ~1.5 s via heartbeat polling on Firefox).
5. User selects a listing from the dropdown → chats are shown/hidden instantly, no scrolling.

## Architecture

### content.js (single IIFE, no build step)

Key sections in order:

| Section | Purpose |
|---|---|
| Constants / SELECTORS | CSS selectors for FB DOM elements; ACTION_PREFIXES to strip action buttons |
| State | Module-level flags (`sellingPageVisitedThisSession`, `storedSellingListings`, etc.) |
| `_storage` resolver | Returns `browser.storage.local`, `chrome.storage.local`, or a `window.sessionStorage` shim for the test page |
| `markSellingPageVisited()` | URL-based (no DOM needed); idempotent; writes timestamp to `_storage` |
| `tryScrapeSellingPage()` | DOM-based scraper; runs on heartbeat until selling-page DOM is hydrated |
| `captureOpenChatListing()` | Detects selling/buying role from the open chat panel; supplements stored data |
| `buildSellSetLower()` | Returns lowercased Set of selling names; `null` if session flag not set |
| `getUniqueListings()` | Intersects thread listings with stored selling names → dropdown options |
| `applyFilter(listing)` | Shows/hides thread rows in the chat grid |
| `createFilterUI()` | Injects filter bar + status element into the thread list |
| `refreshListings()` | Rebuilds dropdown options; toggles info vs dropdown |
| `init()` | Reads stored data + session flag in parallel; calls `tryInject()` |
| `storage.onChanged` listener | Cross-tab activation for Chrome |
| Heartbeat (`setInterval`) | Scrapes selling page + polls session flag every 1.5 s (Firefox cross-tab fix) |
| URL observer | SPA navigation detection; resets scrape state; re-checks session flag |

### Storage Schema

Two keys in `chrome.storage.local`:

```json
// STORAGE_KEY = "mp_filter_listings_v1"
{
  "selling": [{ "name": "My Listing Title", "listedOn": "2/9" }],
  "buying":  ["Some item I'm buying"],
  "savedAt": 1700000000000
}

// SESSION_FLAG_KEY = "mp_filter_session_v1"
1700000000000   // Unix timestamp (ms); 8-hour TTL gates the dropdown
```

### Session Flag Logic

`chrome.storage.session` is **not** reliably accessible from content scripts in either
browser. Instead, a `Date.now()` timestamp is stored in `chrome.storage.local` with an
8-hour TTL, approximating "browser session" semantics.

The flag gates `buildSellSetLower()` and `refreshListings()` so the dropdown never
auto-populates from stale data — the user must visit the selling page each session.

Three paths restore the flag in a chat-page tab:
1. `init()` — reads and checks TTL on page load / extension install.
2. `storage.onChanged` ("local" area) — fires immediately in Chrome when another tab sets it.
3. Heartbeat poll — fires every 1.5 s in Firefox (where `storage.onChanged` does not fire in
   content scripts).

## Facebook DOM Selectors (may break with FB updates)

| Selector | Purpose |
|---|---|
| `div[aria-label="Thread list"]` | Container for the whole chat sidebar |
| `div[aria-label="Chats"][role="grid"]` | The scrollable list of threads |
| `a[href*="/marketplace/t/"]` | Individual thread links |
| `span.x1lliihq.x193iq5w…` | Thread title span (contains "Name · Listing Title") |
| `div[role="button"][aria-label]` | Listing cards on selling page (scraper searches the whole document, scoped by URL via `isSellingPage()` rather than a wrapping container selector — FB has changed the container's aria-label/role before) |

If the extension stops working, the most likely cause is Facebook changing one of these
selectors. Check the browser console for `[MP Filter]` log lines to diagnose.

## Development Workflow

### Chrome (with HMR)

```bash
npm run dev
```

1. Vite dev server starts on port 5173 (or next available)
2. Open `chrome://extensions` → Enable Developer Mode
3. Click **Load unpacked** → select the `dist-chrome/` folder
4. Edit `src/content.js` or `src/styles.css` → changes **instantly reload** the extension via HMR
5. No manual reload needed!

### Firefox (with auto-reload via web-ext)

```bash
npm run dev:firefox
```

1. Does an initial `build:firefox` to populate `dist/`
2. Starts two parallel processes via `concurrently`:
   - **Vite** in `--watch` mode — rebuilds `dist/` on every source file change
   - **web-ext** — launches Firefox with the extension loaded, watches `dist/` and **automatically reloads the extension + re-injects the content script** whenever Vite writes a new build
3. Firefox opens automatically — no manual loading required
4. Edit `src/content.js` or `src/styles.css` → Firefox reflects the change within ~1 second

**Note:** No in-place HMR (MV2 limitation), but the full reload cycle is effectively instant.

**Firefox binary path:** Configured in `web-ext-config.mjs`. Update the `firefox` key if your Firefox is installed at a different path (see comments in the file for common paths).

### Production Builds

```bash
npm run build        # Chrome MV3  → dist-chrome/
npm run build:firefox # Firefox MV2 → dist-firefox/
```

## vite.config.js — Build Configuration

The config conditionally applies build settings based on `BROWSER` env var:

- **Chrome**: Uses `crx()` plugin from CRXJS for automatic HMR + service worker setup
- **Firefox**: Uses custom `firefoxPlugin` to write `manifest.json` and copy `styles.css` after each build; Rollup outputs `content.js` as IIFE to `dist/`
- **CORS**: Both `chrome-extension://` and `moz-extension://` origins allowed for HMR

## web-ext-config.mjs

Configures `web-ext run` defaults (used by `npm run dev:firefox`):

- **`run.firefox`** — path to the Firefox binary; update this if Firefox is installed elsewhere
- **`run.startUrl`** — opens `about:debugging` on launch so the extension is visible immediately

`web-ext` is not used for production builds — only during development.

## CSS Handling

Styles are imported as inline CSS in `src/content.js`:
```javascript
import stylesCSS from './styles.css?inline'
```

The `injectStyles()` function in the IIFE injects the CSS into `document.head` on page load.

## Development Notes

- **Content script bundling**: `src/content.js` is a self-contained IIFE that bundles all logic
- **Debounce**: The MutationObserver on the chat grid debounces at 300 ms to avoid
  redundant re-renders while threads lazy-load
- **`captureOpenChatListing()`** supplements storage with any open-chat selling listings
  the scraper may have missed (e.g., sold items no longer on the selling page). It does
  **not** add thread-parsed listings to the dropdown unless they also appear in stored
  selling data
- **`getUniqueListings()`** intersects thread names with stored selling names — the
  dropdown never shows thread names that aren't in the stored selling list
- **`normalizeSelling(arr)`** converts legacy `string` entries in storage to
  `{ name, listedOn: null }` objects for backward compatibility
- **ACTION_PREFIXES** must stay in sync with Facebook's aria-label patterns for selling-page
  action buttons (e.g., "Mark as sold ", "Share ", "More options for ")
