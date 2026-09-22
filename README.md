# Nexlane DMS Extension

A browser extension (Chrome MV3 + Firefox MV2) that adds dealer workflow tools to the
sites Nexlane DMS users work in every day:

- **Facebook Marketplace / Messenger** — filter your Marketplace chats by the listing
  they're about, using the listings on your own selling page.
- **Openlane (`app.openlane.ca`)** — download a vehicle's photo gallery as a ZIP, and hand
  your Openlane session token to a locally running Nexlane service.

Both features ship in one extension, built from a shared `src/` folder with Vite + CRXJS.

---

## How it works

### 1. Marketplace chat filter (`src/content.js`)

Runs on `facebook.com/marketplace/*`, `facebook.com/messages/*` and `messenger.com/*`.

```
Selling page tab                          Chat page tab
────────────────                          ─────────────
/marketplace/you/selling                  Messenger / Marketplace inbox
  │ auto-scrolls until every card loads     │
  │ scrapes listing names + "Listed on"     │  "Filters inactive — Open your
  ▼                                         │   selling page to load listings."
chrome.storage.local ──────────────────────▶│
  mp_filter_listings_v1  (listings)         ▼
  mp_filter_session_v1   (timestamp)      Dropdown activates
```

1. **Open the chat page.** A filter bar is injected under the chat sidebar header. Until
   listings are loaded it shows *"Filters inactive — Open your selling page to load
   listings."* with a link.
2. **Open your selling page** (`/marketplace/you/selling`), in the same tab or a new one.
   The extension scrolls the page until all listing cards have loaded, reads each
   listing's title (skipping action buttons like "Mark as sold …" / "Share …"), and saves
   them to extension storage. A blue badge confirms how many listings were saved.
3. **The chat page activates.** In Chrome this happens immediately (`storage.onChanged`);
   in Firefox within ~1.5 s (a heartbeat polls storage, since `onChanged` doesn't fire in
   Firefox content scripts).
4. **Pick a filter.** Chats that don't match are hidden instantly — no scrolling or
   reloading.

**Dropdown options**

| Option | Shows |
|---|---|
| All listings | Every chat, unfiltered |
| My Listings (N) | Chats for any of your selling listings |
| *Listing title (count)* | Only chats about that listing |
| Buying Listings (count) | Chats where you're the buyer, plus a search box to narrow them |

**How chats are matched:** Marketplace thread titles look like `Name · Listing Title`.
The extension takes the part after `·` and matches it (case- and whitespace-insensitive,
allowing for FB's truncated titles) against your saved selling listings. The dropdown
only ever offers listings that exist on your selling page — never names guessed from
chat titles. When you open a chat, the extension also detects from the chat panel
whether you're selling or buying, which picks up sold items no longer on the selling
page.

**Session gating:** Saved listings are only used for **8 hours** after your last visit to
the selling page. After that the filter goes back to "inactive" until you visit it
again, so the dropdown never silently runs on stale listings.

### 2. Openlane gallery downloader (`src/openlane.js`)

Runs on `app.openlane.ca/*`.

1. Open a vehicle and its **photo gallery**. A download button appears next to the
   gallery's close button.
2. Click it to open a selection panel grouped by category (overview, condition, video).
   Choose the photos/videos you want.
3. The extension fetches the selected media and builds a ZIP named
   `<Vehicle name> <last 6 of VIN>.zip`. Files are ordered overview → condition → video,
   and timestamped so they also sort in that order by date modified.

The download goes through the background script (`chrome.downloads`) to avoid the page's
CSP restrictions on `blob:` URLs.

### 3. Openlane token relay (`src/openlane.js` → `src/background.js`)

On page load, the extension reads your Openlane access token from the page's
`localStorage` (`dmp-okta-token`) and sends it to a local Nexlane service at
`http://127.0.0.1:8000/openlane/token`. This lets the local Nexlane market guide call
Openlane as you. The request goes through the background script, since an HTTPS page
can't call an HTTP loopback address directly (mixed content).

If nothing is listening on port 8000 the push just fails and logs an error — the rest of
the extension is unaffected.

---

## Installation & development

Built with **Vite** + **CRXJS** (HMR on Chrome) and **web-ext** (auto-reload on Firefox).

```bash
npm install
```

### Chrome (with HMR)

```bash
npm run dev
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select
`dist-chrome/`. Edits to `src/` reload the extension and any open Facebook tabs
automatically.

### Firefox (with auto-reload)

```bash
npm run dev:firefox
```

Builds once, then runs Vite in watch mode alongside `web-ext`, which launches Firefox with
the extension loaded and reloads it whenever `dist-firefox/` changes.

> **First run:** set the `firefox` binary path in `web-ext-config.mjs` if yours isn't at
> the default location.

### Production builds

```bash
npm run build
```

```bash
npm run build:firefox
```

Output goes to `dist-chrome/` (MV3) or `dist-firefox/` (MV2). To install a build manually:

- **Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** → `dist-chrome/`
- **Firefox:** `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** →
  `dist-firefox/manifest.json`

---

## Project structure

```
nexlane-dms-ext/
├── src/
│   ├── content.js           # Marketplace chat filter (content script)
│   ├── styles.css           # Filter bar styles
│   ├── openlane.js          # Openlane gallery downloader + token relay (content script)
│   ├── openlane.css         # Download button / selection panel styles
│   └── background.js        # Downloads, token relay, dev tab reloading
├── manifest.chrome.js       # Chrome MV3 manifest (CRXJS)
├── manifest.firefox.js      # Firefox MV2 manifest
├── vite.config.js           # Picks manifest + output dir from BROWSER env var
├── web-ext-config.mjs       # Firefox binary path + web-ext defaults
├── test/                    # Static HTML snapshots for local testing
├── dist-chrome/             # Chrome build output (generated, gitignored)
└── dist-firefox/            # Firefox build output (generated, gitignored)
```

---

## Troubleshooting

Both features depend on the DOM of sites we don't control, so a site redesign is the most
likely cause of breakage. Open DevTools (F12) → Console and look for the log prefixes:

| Prefix | Feature |
|---|---|
| `[MP Filter]` | Marketplace chat filter |
| `[OL Downloader]` | Openlane downloader, token relay, background script |

**Filter bar missing or says "inactive"**
- Visit your selling page again (the 8-hour window may have expired).
- Make sure the selling page finished scrolling and showed the blue "listings saved" badge.
- Refresh the chat page.

**A listing is missing from the dropdown**
- It must appear on your selling page. Sold/removed items only show up after you open a
  chat about them.

**Openlane download button missing**
- Check the console for `[OL Downloader]` warnings about selectors. If the header anchor
  isn't found, the button falls back to a floating position inside the gallery.

**Firefox: "Can't read and change data on this site"**
- Go to `about:addons` → **Nexlane DMS Extension** → **Permissions** and allow the
  Facebook / Openlane sites.

---

## Privacy & permissions

- Runs only on Facebook Marketplace/Messenger, Messenger.com and Openlane.
- Marketplace listing names are stored locally in extension storage and never leave your
  browser.
- The Openlane access token is sent **only** to `127.0.0.1:8000` on your own machine —
  never to a remote server.
- Openlane media is fetched from Openlane's own CDN and saved to your Downloads folder.
