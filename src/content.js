import stylesCSS from './styles.css?inline'

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────

  const SELECTORS = {
    threadList: 'div[aria-label="Thread list"]',
    chatGrid: 'div[aria-label="Chats"][role="grid"]',
    threadLink: 'a[href*="/marketplace/t/"]',
    sellingPageBtn: 'div[role="button"][aria-label]',
  };

  // Aria-label prefixes used by action buttons on the selling page.
  // These are NOT listing names and must be filtered out during scraping.
  const ACTION_PREFIXES = [
    "Mark as sold ",
    "Mark out of stock ",
    "Share ",
    "More options for ",
    "View insights for ",
    "Boost listings for ",
    "Boost listing for ",
  ];

  const SEPARATOR = " \u00b7 "; // " · "
  const STORAGE_KEY = "mp_filter_listings_v1";
  const BUYING_SCROLL_TARGET = 75; // DOM rows to load before applying buying filter
  // Stored in chrome.storage.local with a timestamp; 8-hour TTL approximates
  // "browser session" semantics without requiring chrome.storage.session
  // (which is not reliably accessible from content scripts).
  const SESSION_FLAG_KEY = "mp_filter_session_v1";


  // ── State ──────────────────────────────────────────────────────────────
  let filterContainer = null;
  let currentListing = null;
  let buyingSearchQuery = "";
  let debounceTimer = null;
  let isObserving = false;
  let hasScrapedSellingPage = false;

  // True only after tryScrapeSellingPage() succeeds in this content-script
  // instance.  Resets to false on every new page load / new tab.  This gates
  // all filter behaviour so the dropdown never auto-populates from previously
  // stored data — the user must visit the selling page each session first.
  let sellingPageVisitedThisSession = false;

  // null  = not loaded yet
  // []    = loaded, nothing stored
  // [...]  = loaded, selling listings available as { name, listedOn } objects
  let storedSellingListings = null;
  let sellingListingsLowerCase = null;  // Cached Set of lowercased listing names for fast lookups

  // ── Cross-browser storage ──────────────────────────────────────────────

  // Resolves to chrome.storage.local, browser.storage.local, or a
  // sessionStorage shim for the local test page (single-tab, no extension API).
  // Local storage persists across browser sessions and is shared across all
  // tabs, so listings scraped on the selling page are immediately available in
  // any messenger tab.  The dropdown only populates after the user visits the
  // selling page — it never auto-loads listings from thread names.
  const _storage = (() => {
    try {
      if (typeof browser !== "undefined" && browser.storage?.local)
        return browser.storage.local;
    } catch (_) {}
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local)
        return chrome.storage.local;
    } catch (_) {}
    // Test-page / older-browser shim
    const P = "__mpf_";
    return {
      get: (key) => {
        try {
          return Promise.resolve({
            [key]: JSON.parse(sessionStorage.getItem(P + key) || "null"),
          });
        } catch {
          return Promise.resolve({ [key]: null });
        }
      },
      set: (obj) => {
        Object.entries(obj).forEach(([k, v]) => {
          try { sessionStorage.setItem(P + k, JSON.stringify(v)); } catch (_) {}
        });
        return Promise.resolve();
      },
    };
  })();

  async function persistListings({ selling, buying }) {
    try {
      await _storage.set({ [STORAGE_KEY]: { selling, buying, savedAt: Date.now() } });
    } catch (e) {
      console.warn("[MP Filter] Could not persist listings:", e);
    }
  }

  async function readPersistedListings() {
    try {
      const result = await _storage.get(STORAGE_KEY);
      return result[STORAGE_KEY] || { selling: [], buying: [] };
    } catch {
      return { selling: [], buying: [] };
    }
  }

  // ── Utility ────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Converts legacy string entries in the selling array to
   * { name, listedOn: null } objects, for backward compatibility.
   */
  function normalizeSelling(arr) {
    if (!arr) return [];
    return arr.map((e) =>
      typeof e === "string" ? { name: e, listedOn: null } : e
    );
  }

  // ── Page detection ─────────────────────────────────────────────────────

  const IS_TEST = document.documentElement.dataset.mpFilterTest === "true";

  function isSellingPage() {
    const { hostname, pathname } = location;
    return (
      (hostname === "www.facebook.com" || IS_TEST) &&
      pathname.startsWith("/marketplace/you/selling")
    );
  }

  function isMessagingPage() {
    const { hostname, pathname } = location;
    // In test mode, act as messaging page for all paths EXCEPT the mock selling page
    if (IS_TEST) return !pathname.startsWith("/marketplace/you/selling");
    return (
      hostname === "www.messenger.com" ||
      (hostname === "www.facebook.com" && pathname.startsWith("/messages/"))
    );
  }

  // ── Session activation ─────────────────────────────────────────────────

  /**
   * Marks the selling page as visited for this browser session.
   * Called on URL detection — does NOT require the selling-page DOM to be
   * hydrated — so it succeeds even if the scraper hasn't run yet.
   * Idempotent: safe to call multiple times.
   */
  function markSellingPageVisited() {
    if (sellingPageVisitedThisSession) return;
    sellingPageVisitedThisSession = true;
    // Persist a timestamp so other tabs and page refreshes can restore the flag.
    // Uses chrome.storage.local — definitively accessible from all content scripts.
    _storage.set({ [SESSION_FLAG_KEY]: Date.now() }).catch(() => {});
    console.log("[MP Filter] Selling page detected — session flag set.");
  }

  // ── Selling-page scraper ───────────────────────────────────────────────

  /**
   * Runs once when listing cards are present on /marketplace/you/selling.
   *
   * The selling page renders listing cards as:
   *     <div role="button" aria-label="2016 Mazda Mazda3 GX">   ← listing card
   *       ... contains "Listed on 2/9" as a text node ...
   *     <div role="button" aria-label="Mark as sold 2016 Mazda Mazda3 GX">  ← action btn
   *
   * We grab every div[role="button"][aria-label] on the page (already scoped
   * to the selling page via isSellingPage() before this runs — no need to
   * additionally scope to a wrapping container, whose aria-label/role FB has
   * changed before and is otherwise not load-bearing), filter out
   * action-button prefixes, extract "Listed on X/Y" from each card,
   * de-duplicate, and persist to storage.
   */
  async function tryScrapeSellingPage() {
    if (hasScrapedSellingPage) return;

    const buttons = document.querySelectorAll(SELECTORS.sellingPageBtn);
    if (buttons.length === 0) return; // cards not rendered yet

    const listingMap = new Map(); // name (string) → listedOn (string|null)

    for (const btn of buttons) {
      const label = (btn.getAttribute("aria-label") || "").trim();
      if (label.length <= 2) continue;
      if (ACTION_PREFIXES.some((p) => label.startsWith(p))) continue;

      // Require the "Listed on" date as the positive signal that this button
      // is a real listing card. This eliminates:
      //   • UI chrome buttons inside the container (List View, Grid View,
      //     Filters, New message) — no "Listed on" text.
      //   • Thumbnail/image-wrapper buttons that share the listing's
      //     aria-label but have empty textContent — no "Listed on" text.
      //   • Any future action-button types Facebook adds that aren't yet
      //     in ACTION_PREFIXES — they will also lack "Listed on" text.
      const m = btn.textContent.match(/Listed on (\d+\/\d+(?:\/\d+)?)/);
      if (!m) continue; // not a listing card

      if (!listingMap.has(label)) {
        listingMap.set(label, m[1]);
      }
    }

    // If no listing cards passed the "Listed on" guard, the page is still
    // hydrating (only UI chrome buttons have rendered so far). Defer — do NOT
    // set the guard flag here, so the next heartbeat tick can retry.
    if (listingMap.size === 0) return;

    hasScrapedSellingPage = true;
    markSellingPageVisited(); // idempotent — may already be set via URL detection

    const selling = Array.from(listingMap.entries()).map(([name, listedOn]) => ({
      name,
      listedOn,
    }));
    storedSellingListings = selling;
    sellingListingsLowerCase = getSellingListingsLowercase();

    // Merge buying listings we may have captured via open-chat detection
    const existing = await readPersistedListings();
    await persistListings({ selling, buying: existing.buying || [] });

    console.log(
      `[MP Filter] Scraped ${selling.length} selling listing(s):`,
      selling
    );

    showSellingPageBadge(selling.length);
  }

  /** Brief confirmation badge injected on the selling page after scraping. */
  function showSellingPageBadge(count) {
    if (document.getElementById("mp-filter-badge")) return;
    const badge = document.createElement("div");
    badge.id = "mp-filter-badge";
    badge.textContent = `✓ Marketplace Filter: ${count} listing(s) saved`;
    Object.assign(badge.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      background: "#1877f2",
      color: "#fff",
      padding: "9px 16px",
      borderRadius: "20px",
      fontSize: "13px",
      fontFamily: "Segoe UI, Helvetica, Arial, sans-serif",
      zIndex: "99999",
      boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
    setTimeout(() => badge.remove(), 4000);
  }

  // ── Open-chat role detector ────────────────────────────────────────────

  /**
   * Inspects the active chat panel for the "View buyer profile" or
   * "View seller profile" link that Facebook Marketplace injects.
   *
   * "View buyer profile" → the current user is the SELLER.
   * "View seller profile" → the current user is the BUYER.
   *
   * Returns 'selling' | 'buying' | null (undetermined / non-marketplace chat).
   */
  // ── Thread parsing ─────────────────────────────────────────────────────

  /**
   * Structural fallback: find the "Buying" section divider inside the grid.
   * Used only when no stored selling listings are available.
   */
  function findBuyingBoundary(grid) {
    const walker = document.createTreeWalker(grid, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.children.length > 0) continue;
      const text = node.textContent.trim();
      if (/^Buying(\s*\(\d+\))?$/.test(text)) return node;
    }
    return null;
  }

  /**
   * Returns all { row, link } pairs from the chat grid.
   * When no stored listing data exists, threads that appear after the
   * "Buying" section divider are excluded via compareDocumentPosition.
   */
  function getThreadItems() {
    const grid = document.querySelector(SELECTORS.chatGrid);
    if (!grid) return [];

    // Use DOM boundary only as a structural fallback
    const buyingBoundary =
      !storedSellingListings || storedSellingListings.length === 0
        ? findBuyingBoundary(grid)
        : null;

    const links = grid.querySelectorAll(SELECTORS.threadLink);
    const items = [];
    const seen = new Set();

    for (const link of links) {
      const row = link.closest('div[role="row"]');
      if (!row || seen.has(row)) continue;
      seen.add(row);

      if (buyingBoundary) {
        // DOCUMENT_POSITION_FOLLOWING means the boundary comes AFTER the row → selling ✓
        const pos = row.compareDocumentPosition(buyingBoundary);
        if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      }

      items.push({ row, link });
    }
    return items;
  }

  function parseThreadName(item) {
    // Primary: aria-label on the thread link is stable across FB CSS changes.
    // Format: "Group chat: Name · Listing Title"
    const link = item.row.querySelector(SELECTORS.threadLink);
    if (link) {
      const label = link.getAttribute("aria-label") || "";
      const stripped = label.replace(/^Group chat:\s*/i, "").trim();
      if (stripped.includes(SEPARATOR)) return stripped;
    }
    // Fallback: scan all spans for the one containing the separator
    for (const span of item.row.querySelectorAll("span")) {
      const text = span.textContent.trim();
      if (text.includes(SEPARATOR)) return text;
    }
    return null;
  }

  function extractListingName(fullName) {
    if (!fullName) return null;
    const idx = fullName.indexOf(SEPARATOR);
    return idx === -1 ? null : fullName.substring(idx + SEPARATOR.length).trim();
  }

  /**
   * Builds a Set of lowercased selling listing names for case-insensitive
   * comparison. Returns null when no selling data is available.
   */
  function getSellingListingsLowercase() {
    if (!sellingPageVisitedThisSession) return null;
    if (!storedSellingListings || storedSellingListings.length === 0) return null;
    return new Set(storedSellingListings.map((l) => l.name.toLowerCase()));
  }

  /**
   * Returns sorted listing names (strings) for the dropdown — exclusively
   * from the selling-page scraper data stored in storedSellingListings.
   *
   * Threads are NOT used to build the dropdown option list; they are used
   * only for the per-listing chat counts rendered inside refreshListings().
   * This ensures the dropdown always reflects what is actually on the
   * user's selling page, never historical or accumulated chat data.
   */
  function getUniqueListings() {
    if (!sellingPageVisitedThisSession) return [];
    if (!storedSellingListings || storedSellingListings.length === 0) return [];
    return storedSellingListings.map((l) => l.name).sort();
  }

  /**
   * Returns listing names from threads that are NOT in storedSellingListings.
   * Captured for future "Buying" features.  Uses case-insensitive comparison.
   */
  function getBuyingListingsFromThreads() {
    const sellSetLower = sellingListingsLowerCase;
    if (!sellSetLower) return [];
    const grid = document.querySelector(SELECTORS.chatGrid);
    if (!grid) return [];

    const links = grid.querySelectorAll(SELECTORS.threadLink);
    const buying = new Set();
    const seen = new Set();

    for (const link of links) {
      const row = link.closest('div[role="row"]');
      if (!row || seen.has(row)) continue;
      seen.add(row);
      const listing = extractListingName(parseThreadName({ row }));
      if (listing && !sellSetLower.has(listing.toLowerCase())) buying.add(listing);
    }
    return Array.from(buying).sort();
  }

  // ── Buying / selling thread classifier ────────────────────────────────

  /**
   * Classifies a thread row as buying or selling using DOM structural signals.
   *
   * Signal 1 — img src URL (fastest; present as soon as the thumbnail loads):
   *   s133x133 = square crop (profile-sized thumbnail) = buying
   *   s296x100 = landscape crop (listing photo)        = selling
   *
   * Signal 2 — img count (user-confirmed from live DOM inspection):
   *   ≥ 2 <img> in the row = buying (listing thumbnail + seller profile overlay)
   *   1  <img> in the row  = selling (listing photo only)
   *
   * Signal 3 — structural overlay div inside the <a> element:
   *   div[data-visualcompletion="ignore"][style*="inset"] inside the link
   *   = buying (full-row click-overlay unique to buying thread cards)
   *
   * Returns true (buying) | false (selling) | null (inconclusive).
   * When null the caller should fall back to selling-set negation.
   */
  function isBuyingThread(row) {
    const link = row.querySelector('a[href*="/marketplace/t/"]');
    if (!link) return false; // not a marketplace thread

    // Signal 1: thumbnail image src URL aspect-ratio hint
    // s133x133 (square/profile crop) is a reliable buying signal.
    // s296x100 (landscape crop) is NOT a reliable selling signal — buying threads
    // can also use landscape product thumbnails, so we only use this as a
    // positive buying indicator, never as a negative one.
    const img = link.querySelector("img");
    if (img) {
      const src = img.getAttribute("src") || "";
      if (src.includes("s133x133")) return true;  // square  → buying
    }

    // Signal 2: total <img> count in the row
    if (row.querySelectorAll("img").length >= 2) return true;

    // Signal 3: full-row hover-overlay div inside <a> (buying-card specific)
    if (link.querySelector('[data-visualcompletion="ignore"][style*="inset"]')) {
      return true;
    }

    return null; // inconclusive — caller uses selling-set fallback
  }

  // ── Buying-filter scroll loader ────────────────────────────────────────

  /**
   * Scrolls the thread list upward to trigger Facebook's lazy loader until
   * BUYING_SCROLL_TARGET total thread rows are present in the DOM.
   * Called before the buying filter is applied so there's a meaningful pool
   * of buying chats to search through.
   * Bails early when the scroll container stops moving (list fully loaded).
   */
  async function scrollToLoadBuyingThreads() {
    const grid = document.querySelector(SELECTORS.chatGrid);
    const scrollEl = grid.parentElement.closest(':not(html, body)');
    const MAX_ATTEMPTS = 10;
    const getThreadCount = () =>
    new Set([...grid.querySelectorAll(SELECTORS.threadLink)].map(l => l.closest('[role="row"]'))).size;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (getThreadCount() >= BUYING_SCROLL_TARGET) break;

      const lastTop = scrollEl.scrollTop;
      scrollEl.scrollTop += 600;

      await new Promise(r => setTimeout(r, 350));

      // If we didn't actually move (hit the bottom)
      if (scrollEl.scrollTop === lastTop) break;
    }
  }

  // ── Filtering ──────────────────────────────────────────────────────────

  function filterListing(listing) {
    console.log("FILTERING LISTING");
    console.log(listing);
    currentListing = listing;
    const grid = document.querySelector(SELECTORS.chatGrid);

    if (!grid) return;

    const rows = [...new Set([...grid.querySelectorAll(SELECTORS.threadLink)].map(l => l.closest('div[role="row"]')))];
    let visibleCount = 0;

    rows.forEach(row => {
      if (!row) return;

      const rowName = extractListingName(parseThreadName({ row }))?.toLowerCase();
      const isBuyingDom = isBuyingThread(row);
      const query = buyingSearchQuery.trim().toLowerCase();

      let shouldShow = true;

      if (listing === "ALL_LISTINGS") {
        shouldShow = true;
      } else if (listing === "BUYING_LISTINGS") {
        const isBuying = isBuyingDom ?? (!rowName || !sellingListingsLowerCase?.has(rowName));
        shouldShow = isBuying && (!query || !!rowName?.includes(query));
      } else if (listing) {
        // Normalize both sides: collapse whitespace, trim, lowercase.
        // Handles invisible Unicode differences between the selling page
        // aria-label and the thread textContent.
        const normalize = str => str?.toLowerCase().trim().replace(/\s+/g, ' ') ?? '';
        const normalizedRow = normalize(rowName);
        const normalizedListing = normalize(listing);

        // Match if equal OR if one is a prefix of the other — covers cases
        // where Facebook truncates long listing titles in the thread UI.
        const nameMatches = normalizedRow === normalizedListing
          || normalizedListing.startsWith(normalizedRow)
          || normalizedRow.startsWith(normalizedListing);

        // Name match takes priority over isBuyingThread() classification.
        // The dropdown only contains selling listings, so a matching name
        // IS a selling thread — buying heuristics can misfire on threads
        // with square product thumbnails (s133x133 false positive).
        shouldShow = nameMatches;
      } else if (sellingListingsLowerCase) {
        shouldShow = !!rowName && sellingListingsLowerCase.has(rowName);
      }

      row.style.display = shouldShow ? "" : "none";
      if (shouldShow) visibleCount++;
    });

    updateFilterStatus(listing, visibleCount);
  }


  // Helper to keep the main function clean
  function updateFilterStatus(listing, count) {
    const q = buyingSearchQuery.trim();
    if (listing === "ALL_LISTINGS") {
      updateStatus(`Showing all ${count} chat(s)`);
    } else if (listing === "BUYING_LISTINGS") {
      updateStatus(q ? `Showing ${count} result(s) for "${q}"` : `Showing ${count} buying chat(s)`);
    } else if (listing) {
      updateStatus(`Showing ${count} chat(s) for "${listing}"`);
    } else {
      updateStatus(sellingListingsLowerCase ? `Showing ${count} selling chat(s)` : `Showing all ${count} chat(s)`);
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────


  function createFilterUI(threadList) {
    if (document.getElementById("mp-chat-filter")) return;

    const container = document.createElement("div");
    container.id = "mp-chat-filter";

    // Use innerHTML for the bulk of the structure
    container.innerHTML = `
        <div id="mp-chat-filter-row1">
            <span id="mp-chat-filter-info">
                Filters inactive — <a id="mp-chat-filter-info-link" href="https://www.facebook.com/marketplace/you/selling?state=LIVE&status%5B0%5D=IN_STOCK" target="_blank" rel="noopener noreferrer">Open your selling page</a> to load listings.
            </span>
            <select id="mp-chat-filter-select">
                <option value="ALL_LISTINGS">All listings</option>
            </select>
        </div>
        <div id="mp-chat-filter-search-row" style="display: none;">
            <div id="mp-chat-filter-search-wrap">
                <input id="mp-chat-filter-search" type="text" placeholder="Search buying chats…" autocomplete="off" spellcheck="false">
                <button id="mp-chat-filter-search-clear" type="button" aria-label="Clear search" style="display: none;">&times;</button>
            </div>
        </div>
        <p id="mp-chat-filter-status"></p>
    `;

    // Placement logic
    const header = threadList.querySelector("header");
    header?.nextSibling ? header.parentNode.insertBefore(container, header.nextSibling) : threadList.prepend(container);

    // Event Delegation / Scoped Selectors
    const select = container.querySelector("#mp-chat-filter-select");
    const searchInp = container.querySelector("#mp-chat-filter-search");
    const clearBtn = container.querySelector("#mp-chat-filter-search-clear");
    const searchRow = container.querySelector("#mp-chat-filter-search-row");

    select.onchange = async (e) => {
        const val = e.target.value;
        const isBuying = val === "BUYING_LISTINGS";
        searchRow.style.display = isBuying ? "" : "none";
        if (!isBuying) {
          buyingSearchQuery = "";
          const inp = document.getElementById("mp-chat-filter-search");
          if (inp) inp.value = "";
          const clr = document.getElementById("mp-chat-filter-search-clear");
          if (clr) clr.style.display = "none";
        }

        if (isBuying) {
          // Scroll to pre-load threads before filtering so the search pool is full
          await scrollToLoadBuyingThreads();
          filterListing("BUYING_LISTINGS");
        } else if (val === "ALL_LISTINGS") {
          filterListing("ALL_LISTINGS");
        } else {
          filterListing(val || null);
        }
    };

    searchInp.oninput = () => {
        buyingSearchQuery = searchInp.value;
        clearBtn.style.display = buyingSearchQuery ? "" : "none";
        filterListing("BUYING_LISTINGS");
    };

    clearBtn.onclick = () => {
        searchInp.value = buyingSearchQuery = "";
        clearBtn.style.display = "none";
        searchInp.focus();
        filterListing("BUYING_LISTINGS");
    };

    refreshListings();
  }

  function refreshListings() {

    console.log("REFRESHING LISTINGS LIKE A MADMAN");
    const select = document.getElementById("mp-chat-filter-select");
    const infoEl = document.getElementById("mp-chat-filter-info");
    if (!select) return;

    const hasData = sellingPageVisitedThisSession && storedSellingListings?.length > 0;
    const listings = getUniqueListings();
    const prevVal = select.value || currentListing || "";

    // 1. Toggle UI Visibility
    if (infoEl) infoEl.style.display = hasData ? "none" : "";
    select.style.display = hasData ? "" : "none";

    if (!hasData) {
      filterListing(null);
      return updateStatus("No listings loaded — visit your Marketplace selling page.");
    }

    // 2. Pre-calculate Counts (One pass for performance)
    const threads = getThreadItems();
    const sellSet = sellingListingsLowerCase;

    const normalize = str => str?.toLowerCase().trim().replace(/\s+/g, ' ') ?? '';

    const getCount = (listing) => threads.filter(({ row }) => {
      const rawName = extractListingName(parseThreadName({ row }));
      const nameLower = rawName?.toLowerCase();
      const isBuying = isBuyingThread(row) ?? (!nameLower || !sellSet?.has(nameLower));

      if (listing === "BUYING_LISTINGS") return isBuying;

      // Mirror filterListing() — normalize and use prefix matching so
      // truncated thread titles and whitespace differences still count.
      const normalizedRow = normalize(rawName);
      const normalizedListing = normalize(listing);
      return normalizedRow === normalizedListing
        || normalizedListing.startsWith(normalizedRow)
        || normalizedRow.startsWith(normalizedListing);
    }).length;

    // 3. Build Options via Template Strings
    const listOptions = listings.map(l => `<option value="${l}">${l} (${getCount(l)})</option>`).join('');

    select.innerHTML = `
      <option value="ALL_LISTINGS">All listings</option>
      <option value="">My Listings (${listings.length})</option>
      ${listOptions}
      <option value="BUYING_LISTINGS">Buying Listings (${getCount("BUYING_LISTINGS")})</option>
    `;

    // 4. Restore State & Apply Filter
    const match = listings.find(l => l.toLowerCase() === prevVal.toLowerCase()) ||
                  (["BUYING_LISTINGS", "", "ALL_LISTINGS"].includes(prevVal) ? prevVal : "ALL_LISTINGS");

    select.value = match;
    document.getElementById("mp-chat-filter-search-row").style.display = match === "BUYING_LISTINGS" ? "" : "none";
    filterListing(match === "ALL_LISTINGS" ? "ALL_LISTINGS" : match || null);
  
    updateStatus(`${threads.length} thread(s), ${listings.length} listing(s) · ${storedSellingListings.length} listed`);
  }

  function updateStatus(msg) {
    const status = document.getElementById("mp-chat-filter-status");
    if (status) status.textContent = msg;
  }

  // ── Selling page hydration observer ───────────────────────────────────

  /**
   * Scrolls the selling page down until all listing cards are loaded.
   * Facebook lazy-loads cards as you scroll — this ensures tryScrapeSellingPage()
   * sees the full list rather than just the first visible batch.
   * Stops when card count stops increasing (no new cards rendered) or the
   * scroll position doesn't change (true bottom reached).
   */
  async function scrollToLoadAllSellingListings() {
    // Configuration
    const SCROLL_DELAY = 1000; // Fallback wait when no loading indicator appears
    const MAX_STALE_RETRIES = 3; // Raised from 2 — slow connections need more patience

    const getCardCount = () => document.querySelectorAll(SELECTORS.sellingPageBtn).length;
    const isLoading = () => !!document.querySelector('[aria-label="Loading..."]');

    let staleCount = 0;
    let lastCount = 0;

    while (staleCount < MAX_STALE_RETRIES) {
      const previousHeight = document.body.scrollHeight;

      // 1. Perform the scroll
      window.scrollTo(0, document.body.scrollHeight);

      // 2. Brief pause so Facebook has time to render the loading indicator
      // before we check for it — without this the isLoading() check fires
      // before the loader has appeared and falls through to the fixed delay.
      await new Promise(r => setTimeout(r, 300));

      // 3. Wait for the loading indicator to clear if it appeared
      if (isLoading()) {
        const start = Date.now();
        while (isLoading() && Date.now() - start < 8000) {
          await new Promise(r => setTimeout(r, 200));
        }
      } else {
        // Loader never appeared — use fixed delay as fallback
        await new Promise(r => setTimeout(r, SCROLL_DELAY));
      }

      // 4. Check for progress — both card count and page height
      const newCount = getCardCount();
      const newHeight = document.body.scrollHeight;

      if (newCount > lastCount || newHeight > previousHeight) {
        console.log(`[MP Filter] Loaded more listings: ${newCount} total.`);
        lastCount = newCount;
        staleCount = 0;
      } else {
        staleCount++;
        console.log(`[MP Filter] No new listings. Attempt ${staleCount}/${MAX_STALE_RETRIES}.`);
      }
    }

    console.log(`[MP Filter] Finished loading all listings: ${lastCount} total.`);
  }

  /**
   * Watches for the selling-page DOM to hydrate (listing cards appear).
   * Once cards are detected, disconnects immediately then scrolls to load
   * all listing cards before handing off to the scraper.
   */
  function observeSellingPageHydration() {
    if (!isSellingPage() || hasScrapedSellingPage) return;

    const hydrationObserver = new MutationObserver(() => {
      // Check if listing cards have appeared (DOM hydrated)
      const buttons = document.querySelectorAll(SELECTORS.sellingPageBtn);
      if (buttons.length > 0) {
        // Disconnect immediately — scroll + scrape takes over from here.
        // Disconnecting before the async work prevents the observer from
        // re-firing on every DOM mutation during the scroll loop.
        hydrationObserver.disconnect();
        (async () => {
          await scrollToLoadAllSellingListings();
          await tryScrapeSellingPage();
        })();
      }
    });

    // Watch the whole document for listing cards to appear
    hydrationObserver.observe(document.body, { childList: true, subtree: true });
    console.log("[MP Filter] Watching for selling page DOM hydration...");
  }

  // ── Mutation observer (lazy-loaded threads) ───────────────────────────

  function observeNewThreads() {
    const grid = document.querySelector(SELECTORS.chatGrid);
    if (!grid || isObserving) return;
    isObserving = true;

    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("OBSERVING NEW THREADS");
        refreshListings();
        if (currentListing) filterListing(currentListing);

      }, 300);
    });

    observer.observe(grid, { childList: true, subtree: true });
  }

  // ── Robust threadList detection and filter injection ──────────────────

  /**
   * Ensures the filter UI is created when threadList is ready.
   * Uses a MutationObserver on the header to detect when the skeleton loader is done.
   * Disconnects the observer after injection (single-shot activation).
   */
  function doesThreadListExist() {
    const body = document.body;
    const threadList = document.querySelector(SELECTORS.threadList);

    // Set up observer to watch for header text changes (skeleton loader completing)
    const threadListObserver = new MutationObserver(() => {
      const headerEl = body.querySelector("header");
      console.log("IN THREAD OBSERVER");

      //const hasNonVirtualizedChild = threadList => !!threadList.querySelector('[data-virtualized="false"]');
      if (headerEl && headerEl.textContent.includes("Marketplace")) {
        console.log("[MP Filter] Header loaded, injecting filter UI...");
        const newThreadList = document.querySelector(SELECTORS.threadList);
        createFilterUI(newThreadList);
        observeNewThreads();
        threadListObserver.disconnect();
      }
    });

    threadListObserver.observe(body, { childList: true, subtree: true, characterData: true });
    console.log("[MP Filter] Watching header for skeleton loader to complete...");
  }

  /**
   * Injects the filter UI into the threadList (called once when DOM is ready).
   */
  function injectFilterUI(threadList) {
    if (document.getElementById("mp-chat-filter")) return;

    createFilterUI(threadList);
    observeNewThreads();
  }

  // ── Init ───────────────────────────────────────────────────────────────

  /**
   * Loads stored listing data and the cross-tab session flag in parallel.
   * Also immediately marks the session if the script loaded on the selling page
   * (e.g. user opened it in a new tab) — no DOM scrape required for activation.
   */
  function injectStyles() {
    if (!document.getElementById('mp-filter-styles')) {
      const style = document.createElement('style')
      style.id = 'mp-filter-styles'
      style.textContent = stylesCSS
      document.head.appendChild(style)
    }
  }

  async function init() {
    // Inject styles
    injectStyles()

    // On messaging pages, ensure filter UI is injected when threadList appears
    if (isMessagingPage()) {
      console.log("[MP Filter] Initializing filter injection on messaging page...");
      doesThreadListExist();
    }

    // URL-based detection fires before any async storage reads, so Tab A's
    // storage.onChanged listener receives the flag as early as possible.
    if (isSellingPage()) {
      markSellingPageVisited();
      // Watch for DOM hydration and trigger scraper when ready
      observeSellingPageHydration();
    }

    const [stored, flagData] = await Promise.all([
      readPersistedListings(),
      _storage.get(SESSION_FLAG_KEY).catch(() => ({})),
    ]);
    storedSellingListings = normalizeSelling(stored.selling);
    console.log(storedSellingListings);
    const flagTs = flagData[SESSION_FLAG_KEY];
    if (flagTs && (Date.now() - flagTs) < 8 * 3600 * 1000) {
      sellingPageVisitedThisSession = true;
      console.log("[MP Filter] Session flag restored — selling page visited this session.");
    }
    sellingListingsLowerCase = getSellingListingsLowercase();
    if (storedSellingListings.length > 0) {
      console.log(
        `[MP Filter] Loaded ${storedSellingListings.length} stored selling listing(s):`,
        storedSellingListings
      );
    }
  }

  init();

  // ── Cross-tab storage listener ─────────────────────────────────────────
  // chrome.storage.local.onChanged fires in all content scripts across all tabs.
  // We watch for two keys:
  //   SESSION_FLAG_KEY — another tab visited the selling page → activate dropdown
  //   STORAGE_KEY      — another tab finished scraping listings → refresh data
  try {
    const _sAPI = (typeof browser !== "undefined" && browser.storage?.onChanged)
      ? browser.storage
      : chrome.storage;
    _sAPI.onChanged.addListener((changes, area) => {
      if (area !== "local" || !isMessagingPage()) return;

      let needsRefresh = false;

      // Another tab visited the selling page — activate the filter
      if (changes[SESSION_FLAG_KEY]?.newValue && !sellingPageVisitedThisSession) {
        sellingPageVisitedThisSession = true;
        needsRefresh = true;
      }

      // Listing data updated by the scraper in another tab
      if (changes[STORAGE_KEY]?.newValue && sellingPageVisitedThisSession) {
        storedSellingListings = normalizeSelling(changes[STORAGE_KEY].newValue.selling);
        sellingListingsLowerCase = getSellingListingsLowercase()
        needsRefresh = true;
      }

      if (needsRefresh) {
        // If listing data wasn't in this change batch, re-read it from storage
        if (!changes[STORAGE_KEY]) {
          readPersistedListings().then((s) => {
            storedSellingListings = normalizeSelling(s.selling);
            sellingListingsLowerCase = getSellingListingsLowercase();
            refreshListings();
          }).catch(() => {});
        } else {
          sellingListingsLowerCase = getSellingListingsLowercase();
          refreshListings();
        }
      }
    });
  } catch (_) {}

  // ── Heartbeat ──────────────────────────────────────────────────────────
  // Minimal heartbeat: only polls the session flag for Firefox cross-tab activation.
  // Selling-page scraping is now event-driven via observeSellingPageHydration().
  // Filter injection is now event-driven via ensureFilterUIExists() with header observer.
  // Once the session flag is found, the guard short-circuits and no further reads occur.

  const heartbeat = setInterval(() => {
    if (!isMessagingPage() || sellingPageVisitedThisSession) return;
    console.log("in beatt");
    Promise.all([
      _storage.get(SESSION_FLAG_KEY),
      readPersistedListings(),
    ]).then(([flagData, stored]) => {
      const ts = flagData[SESSION_FLAG_KEY];
      if (ts && (Date.now() - ts) < 8 * 3600 * 1000) {
        storedSellingListings = normalizeSelling(stored.selling);
        sellingPageVisitedThisSession = true;
        sellingListingsLowerCase = getSellingListingsLowercase();
        clearInterval(heartbeat);  // ← Stop permanently, job is done
        console.log("[MP Filter] Session flag found via heartbeat — activating filter.");
        refreshListings();
      }
    }).catch(() => {});
  }, 1500);


  // ── SPA navigation via pushState interception ──────────────────────────
  // Instead of watching DOM mutations to detect URL changes (expensive),
  // intercept history.pushState() calls directly (efficient + explicit).
  // This catches all Facebook SPA navigations without polling overhead.

  const originalPushState = history.pushState;
  let lastPath = location.pathname;

  /**
   * Handles SPA navigation events (called when pathname changes).
   * Manages selling-page scraping, filter UI injection, and session flag updates.
   */
  function handleNavigation() {
    console.log("[MP Filter] Navigation detected:", location.pathname);

    // Allow re-scrape if user navigates away from the selling page
    if (!isSellingPage()) {
      hasScrapedSellingPage = false;
    }

    // On selling page: mark session and watch for DOM hydration
    if (isSellingPage()) {
      markSellingPageVisited();
      observeSellingPageHydration();
    }

    // On messaging page: ensure filter UI and re-check session flag
    // (in case another tab visited the selling page after this tab opened)
    if (isMessagingPage()) {
      doesThreadListExist();
      _storage.get(SESSION_FLAG_KEY)
        .then((d) => {
          const ts = d[SESSION_FLAG_KEY];
          if (ts && (Date.now() - ts) < 8 * 3600 * 1000 && !sellingPageVisitedThisSession) {
            sellingPageVisitedThisSession = true;
            console.log("[MP Filter] Session flag detected via navigation — activating filter.");
          }
        })
        .catch(() => {})
        .finally(() => {
          setTimeout(() => {
            refreshListings();
            filterListing(currentListing);
          }, 300);
        });
    }
  }

  // Intercept pushState to detect SPA navigation
  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      handleNavigation();
    }
  };

  // Also handle back/forward button navigation
  window.addEventListener('popstate', () => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      handleNavigation();
    }
  });
})();
