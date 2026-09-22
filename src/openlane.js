import JSZip from 'jszip'
import openlaneCSS from './openlane.css?inline'

;(function () {
  const LOG = '[OL Downloader]'
  let downloadBtnInjected = false

  /* ── Selectors ─────────────────────────────────────────
   * The gallery is a Tailwind/shadcn dialog, and its utility classes churn
   * with every restyle.  Anchor on, in priority order:
   *   1. ARIA roles / labels          (least likely to change)
   *   2. data-slot component attrs
   *   3. semantic tags + text content
   * Never anchor on Tailwind classes.  If the button stops appearing, check
   * the console for "[OL Downloader]" warnings and update this block.
   */
  const SELECTORS = {
    closeBtn: 'button[aria-label="Close gallery"]',
    dialog: '[role="dialog"]',
    galleryHeading: 'aside h2',
    sidebar: 'aside',
    section: 'aside section',
    sectionHeading: 'h3',
    image: 'button img[src]',
    video: 'button video[src]',
    header: 'header',
    // Vehicle detail page (behind the gallery): VIN lives in a copy button
    // whose text is split across nodes ("2T3BFREV3<strong>GW528122</strong>").
    vinCopyBtn: 'button[aria-label="Copy VIN"]',
    // Legacy detail page: VIN attribute on ignite-photo-carousel-v2-<hash>
    vinAttr: '[vin]',
  }
  const GALLERY_HEADING_RE = /photo gallery/i
  const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/
  const VIN_TEXT_RE = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/

  let warnedAnchorMissing = false

  /* ── Locate the gallery dialog ──────────────────────────────
   * Primary: the "Close gallery" button's enclosing dialog.
   * Fallback: any dialog whose sidebar heading reads "Photo Gallery".
   * Returns { dialog, closeBtn } — closeBtn is null on the fallback path.
   */
  function findGallery() {
    const closeBtn = document.querySelector(SELECTORS.closeBtn)
    const viaClose = closeBtn && closeBtn.closest(SELECTORS.dialog)
    if (viaClose) return { dialog: viaClose, closeBtn }

    for (const dialog of document.querySelectorAll(SELECTORS.dialog)) {
      const heading = dialog.querySelector(SELECTORS.galleryHeading)
      if (heading && GALLERY_HEADING_RE.test(heading.textContent)) {
        return { dialog, closeBtn: null }
      }
    }
    return null
  }

  /* ── Vehicle title + VIN for the ZIP filename ────────────── */
  function getVehicleName(dialog) {
    const header = dialog.querySelector(SELECTORS.header)
    const titleEl = header && header.firstElementChild
    const name = titleEl ? titleEl.textContent.replace(/\s+/g, ' ').trim() : ''
    return name || 'vehicle'
  }

  // The VIN is rendered on the vehicle detail page's initial load, not in the
  // gallery.  Cache it per URL as soon as it appears so it's still available
  // if the page content is unmounted or hidden once the gallery opens.
  let cachedVin = null // { path, vin }

  function readVinFromPage() {
    for (const el of document.querySelectorAll(SELECTORS.vinCopyBtn)) {
      const vin = el.textContent.replace(/\s+/g, '').toUpperCase()
      if (VIN_RE.test(vin)) return vin
    }
    for (const el of document.querySelectorAll(SELECTORS.vinAttr)) {
      const vin = (el.getAttribute('vin') || '').trim().toUpperCase()
      if (VIN_RE.test(vin)) return vin
    }
    return null
  }

  function captureVin() {
    if (cachedVin && cachedVin.path === location.pathname) return
    const vin = readVinFromPage()
    if (vin) {
      cachedVin = { path: location.pathname, vin }
      console.log(LOG, `Captured VIN ${vin}`)
    }
  }

  function findVin(dialog) {
    const live = readVinFromPage()
    if (live) return live
    if (cachedVin && cachedVin.path === location.pathname) return cachedVin.vin

    // Fallback: scan page text outside the gallery for a VIN pattern.  Check
    // element text (not single text nodes) since the VIN may be split across
    // nodes, e.g. "2T3BFREV3<strong>GW528122</strong>".
    for (const el of document.body.querySelectorAll('*')) {
      if (dialog.contains(el) || el.children.length > 3) continue
      const m = el.textContent.toUpperCase().match(VIN_TEXT_RE)
      if (m) return m[0]
    }
    console.warn(LOG, 'VIN not found on page — ZIP name will omit it')
    return null
  }


  /* ── Inject styles ──────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('ol-dl-styles')) return
    const style = document.createElement('style')
    style.id = 'ol-dl-styles'
    style.textContent = openlaneCSS
    document.head.appendChild(style)
  }

  /* ── Parse gallery categories + media URLs ───────────────
   * Sidebar sections are <section><h3>N condition images</h3>…buttons…</section>.
   * Each thumbnail button embeds the full-size <img src> (or <video src>), so
   * the URL itself serves as the media id.
   */
  function parseGalleryData(dialog) {
    const categories = []
    const mediaUrls = {}

    dialog.querySelectorAll(SELECTORS.section).forEach(section => {
      const heading = section.querySelector(SELECTORS.sectionHeading)
      if (!heading) return
      const labelText = heading.textContent.trim()
      const label = labelText.toLowerCase()

      let type = null
      let mediaType = 'image'
      if (label.includes('condition image')) type = 'condition'
      else if (label.includes('overview image')) type = 'overview'
      else if (label.includes('video')) { type = 'video'; mediaType = 'video' }
      else return

      const ids = []
      const selector = mediaType === 'video' ? SELECTORS.video : SELECTORS.image
      section.querySelectorAll(selector).forEach(el => {
        const url = el.currentSrc || el.src
        if (!url || mediaUrls[url]) return
        ids.push(url)
        mediaUrls[url] = { url, mediaType }
      })
      categories.push({ type, label: labelText, ids, mediaType })
    })

    return { categories, mediaUrls }
  }

  /* ── Build selection panel ──────────────────────────────── */
  function buildSelectionPanel(modal, categories, mediaUrls) {
    // Remove any leftover panel from a previous modal — the panel lives on
    // document.body, so it isn't cleaned up when the Openlane modal closes.
    const existing = document.querySelector('.ol-dl-panel')
    if (existing) existing.remove()

    const panel = document.createElement('div')
    panel.className = 'ol-dl-panel'

    const header = document.createElement('div')
    header.className = 'ol-dl-panel-header'
    header.innerHTML = '<span>Select media to download</span>'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'ol-dl-panel-close'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', () => panel.remove())
    header.appendChild(closeBtn)
    panel.appendChild(header)

    const body = document.createElement('div')
    body.className = 'ol-dl-panel-body'

    categories.forEach(cat => {
      if (cat.ids.length === 0) return

      const section = document.createElement('div')
      section.className = 'ol-dl-section'

      const sectionHeader = document.createElement('div')
      sectionHeader.className = 'ol-dl-section-header'

      const selectAll = document.createElement('input')
      selectAll.type = 'checkbox'
      selectAll.checked = true
      selectAll.className = 'ol-dl-select-all'

      const sectionLabel = document.createElement('span')
      sectionLabel.textContent = cat.label

      sectionHeader.appendChild(selectAll)
      sectionHeader.appendChild(sectionLabel)
      section.appendChild(sectionHeader)

      const grid = document.createElement('div')
      grid.className = 'ol-dl-grid'

      cat.ids.forEach((id, i) => {
        const item = document.createElement('label')
        item.className = 'ol-dl-item'

        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = true
        cb.dataset.imgIndex = id
        cb.dataset.category = cat.type
        cb.dataset.mediaType = cat.mediaType

        const thumb = document.createElement('div')
        thumb.className = 'ol-dl-thumb'
        const media = mediaUrls[id]
        if (media && media.mediaType === 'image') {
          thumb.style.backgroundImage = `url(${media.url})`
        } else if (media && media.mediaType === 'video') {
          thumb.classList.add('ol-dl-thumb-video')
        }

        const num = document.createElement('span')
        num.className = 'ol-dl-num'
        num.textContent = i + 1

        item.appendChild(cb)
        item.appendChild(thumb)
        item.appendChild(num)
        grid.appendChild(item)
      })

      // Select-all toggle
      selectAll.addEventListener('change', () => {
        grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          cb.checked = selectAll.checked
        })
      })
      // Update select-all when individual checkboxes change
      grid.addEventListener('change', () => {
        const cbs = grid.querySelectorAll('input[type="checkbox"]')
        selectAll.checked = Array.from(cbs).every(cb => cb.checked)
        selectAll.indeterminate = !selectAll.checked && Array.from(cbs).some(cb => cb.checked)
      })

      section.appendChild(grid)
      body.appendChild(section)
    })

    panel.appendChild(body)

    // Download button
    const footer = document.createElement('div')
    footer.className = 'ol-dl-panel-footer'

    const dlBtn = document.createElement('button')
    dlBtn.className = 'ol-dl-download-btn'
    dlBtn.textContent = 'Download Selected'
    dlBtn.addEventListener('click', () => downloadSelected(modal, panel, mediaUrls))
    footer.appendChild(dlBtn)
    panel.appendChild(footer)

    // Overlay the gallery sidebar (not the full screen).  The sidebar itself
    // scrolls, so host the panel in its parent and match the sidebar's box —
    // otherwise the panel would scroll away with the thumbnails.  Fall back
    // to body if the sidebar isn't found for some reason.
    const sidebar = modal.querySelector(SELECTORS.sidebar)
    const host = sidebar && sidebar.parentElement
    if (host) {
      if (getComputedStyle(host).position === 'static') {
        host.style.position = 'relative'
      }
      Object.assign(panel.style, {
        top: `${sidebar.offsetTop}px`,
        left: `${sidebar.offsetLeft}px`,
        width: `${sidebar.offsetWidth}px`,
        height: `${sidebar.offsetHeight}px`,
        right: 'auto',
        bottom: 'auto',
      })
      host.appendChild(panel)
    } else {
      document.body.appendChild(panel)
    }
  }

  /* ── Download selected media as ZIP ─────────────────────── */
  async function downloadSelected(modal, panel, mediaUrls) {
    const checked = panel.querySelectorAll('.ol-dl-grid input[type="checkbox"]:checked')
    if (checked.length === 0) return

    const dlBtn = panel.querySelector('.ol-dl-download-btn')
    const originalText = dlBtn.textContent
    dlBtn.disabled = true
    dlBtn.textContent = 'Fetching media…'

    const vehicleName = getVehicleName(modal)
    const vin = findVin(modal)
    const vinSuffix = vin ? vin.slice(-6) : ''

    const zip = new JSZip()
    let completed = 0
    let added = 0
    const categoryCounters = {}

    const CATEGORY_ORDER = { overview: 0, condition: 1, video: 2 }
    const sorted = Array.from(checked).sort((a, b) =>
      (CATEGORY_ORDER[a.dataset.category] ?? 99) - (CATEGORY_ORDER[b.dataset.category] ?? 99)
    )

    // Base date used to stamp each file with a sequentially later timestamp.
    // This guarantees ascending order (overview → condition → video, 1…N within
    // each category) when the ZIP is viewed sorted by "last modified".
    const BASE_DATE = new Date('2000-01-01T00:00:00')
    let fileSeq = 0

    for (const cb of sorted) {
      const index = cb.dataset.imgIndex
      const category = cb.dataset.category
      const media = mediaUrls[index]
      if (!media || !media.url) {
        console.warn(LOG, `No URL found for media index ${index}`)
        completed++
        dlBtn.textContent = `Fetching media… (${completed}/${checked.length})`
        continue
      }

      categoryCounters[category] = (categoryCounters[category] || 0) + 1
      try {
        const resp = await fetch(media.url)
        if (!resp.ok) {
          console.error(LOG, `Fetch failed for media ${index}: HTTP ${resp.status}`)
          completed++
          dlBtn.textContent = `Fetching media… (${completed}/${checked.length})`
          continue
        }
        const buf = await resp.arrayBuffer()
        if (buf.byteLength === 0) {
          console.warn(LOG, `Empty response for media ${index}`)
          completed++
          dlBtn.textContent = `Fetching media… (${completed}/${checked.length})`
          continue
        }
        const contentType = resp.headers.get('content-type') || ''
        let ext
        if (media.mediaType === 'video') {
          ext = contentType.includes('webm') ? 'webm' : 'mp4'
        } else {
          ext = contentType.includes('png') ? 'png' : 'jpg'
        }
        const filename = `${category}_${categoryCounters[category]}.${ext}`
        const fileDate = new Date(BASE_DATE.getTime() + fileSeq * 1000)
        fileSeq++
        zip.file(filename, buf, { date: fileDate })
        added++
        console.log(LOG, `Added ${filename} (${buf.byteLength} bytes)`)
      } catch (err) {
        console.error(LOG, `Failed to fetch media ${index}:`, err)
      }

      completed++
      dlBtn.textContent = `Fetching media… (${completed}/${checked.length})`
    }

    if (added === 0) {
      console.error(LOG, 'No images were successfully fetched — skipping ZIP')
      dlBtn.textContent = originalText
      dlBtn.disabled = false
      return
    }

    dlBtn.textContent = 'Creating ZIP…'
    console.log(LOG, `Generating ZIP with ${added} files…`)

    try {
      const base64 = await zip.generateAsync({ type: 'base64' })
      const dataUrl = 'data:application/zip;base64,' + base64

      // Use chrome.downloads API if available (bypasses CSP blob: restrictions)
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage(
          { action: 'download', url: dataUrl, filename: `${vehicleName} ${vinSuffix}.zip` },
          (resp) => {
            if (chrome.runtime.lastError) {
              console.error(LOG, 'Download message failed:', chrome.runtime.lastError)
              fallbackDownload(dataUrl, vehicleName, vinSuffix)
            }
          }
        )
      } else {
        fallbackDownload(dataUrl, vehicleName, vinSuffix)
      }
    } catch (err) {
      console.error(LOG, 'Failed to generate ZIP:', err)
    }

    dlBtn.textContent = originalText
    dlBtn.disabled = false
  }

  function fallbackDownload(dataUrl, vehicleName, vinSuffix = '') {
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `${vehicleName} ${vinSuffix}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  /* ── Inject download button into gallery header ──────────── */
  function injectDownloadButton({ dialog, closeBtn }) {
    if (dialog.querySelector('.ol-dl-btn')) return

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ol-dl-btn'
    btn.title = 'Download gallery images'
    btn.setAttribute('aria-label', 'Download gallery images')
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`

    btn.addEventListener('click', () => {
      const { categories, mediaUrls } = parseGalleryData(dialog)
      if (categories.length === 0) {
        console.warn(LOG, 'No media categories found — gallery sidebar selectors may have changed')
        return
      }
      console.log(LOG, `Found ${Object.keys(mediaUrls).length} media URLs`)
      buildSelectionPanel(dialog, categories, mediaUrls)
    })

    if (closeBtn && closeBtn.parentElement) {
      // Sit right next to the close button
      closeBtn.parentElement.insertBefore(btn, closeBtn)
    } else {
      // Anchor missing — still offer the feature via a floating button
      if (!warnedAnchorMissing) {
        console.warn(LOG, 'Close-button anchor not found — selectors may have changed; using floating button')
        warnedAnchorMissing = true
      }
      btn.classList.add('ol-dl-btn--floating')
      dialog.appendChild(btn)
    }
    console.log(LOG, 'Download button injected')
  }

  /* ── Observe for gallery modal ──────────────────────────── */
  function checkForGallery() {
    captureVin()
    const gallery = findGallery()
    if (gallery) {
      injectDownloadButton(gallery)
    } else {
      // Gallery is gone — drop any leftover selection panel so it doesn't
      // overlay the next page.
      const stalePanel = document.querySelector('.ol-dl-panel')
      if (stalePanel) stalePanel.remove()
    }
  }

  function observeGalleryModal() {
    const observer = new MutationObserver(checkForGallery)
    observer.observe(document.body, { childList: true, subtree: true })
    console.log(LOG, 'Observing for gallery modal')

    // Also check immediately in case the gallery is already open
    checkForGallery()
  }

  function getAccessToken() {
    try {
      // 1. Fetch raw string from page's localStorage
      const rawData = window.localStorage.getItem('dmp-okta-token');
      if (!rawData) return null;

      // 2. Parse JSON
      const parsedData = JSON.parse(rawData);

      // 3. Return accessToken
      return parsedData?.accessToken || null;
    } catch (error) {
      console.error('Failed to extract token:', error);
      return null;
    }
  }

  /**
   * Sends the extracted access token to the local Django receiver via the
   * background script. A content script fetch here would run under the
   * page's https://app.openlane.ca origin and get blocked as mixed content
   * — only the privileged background context can reach http://127.0.0.1.
   * @param {string} token - The OAuth/Okta access token.
   * @returns {Promise<boolean>} - Resolves to true if the request succeeded.
   */
  async function sendTokenToLoopback(token) {
    if (!token) {
      console.error('No token provided to sendTokenToLoopback.');
      return false;
    }

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'PUSH_OPENLANE_TOKEN', token }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        });
      });

      if (response && response.ok) {
        console.log('Successfully transmitted token to loopback receiver.');
        return true;
      } else {
        console.error(`Failed to send token. Server responded with status: ${response && response.status}`);
        return false;
      }
    } catch (error) {
      console.error('Network error connecting to local Django receiver:', error);
      return false;
    }
  }

  /* ── Init ───────────────────────────────────────────────── */
  function init() {
    injectStyles()
    observeGalleryModal()

    console.log(LOG, 'Initialized')

    const accessToken = getAccessToken();
    console.log('Access Token:', accessToken);
    if (accessToken) {
      sendTokenToLoopback(accessToken);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
