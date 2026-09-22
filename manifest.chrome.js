import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest(({ mode }) => ({
  manifest_version: 3,
  name: 'Nexlane DMS Extension',
  version: '1.0.0',
  description: 'Facebook Marketplace chat filtering and Openlane gallery tools for Nexlane DMS',
  permissions: ["storage", "tabs", "downloads"],
  host_permissions: [
    "https://www.facebook.com/*",
    "https://www.messenger.com/*",
    "https://app.openlane.ca/*",
    "https://pub-us.kar-media.com/*"
  ],
  background: {
    service_worker: 'src/background.js',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [
        "https://www.facebook.com/marketplace/*",
        "https://www.facebook.com/messages/*",
        "https://www.messenger.com/*"
      ],
      js: ["src/content.js"],
      run_at: "document_idle"
    },
    {
      matches: ["https://app.openlane.ca/*"],
      js: ["src/openlane.js"],
      run_at: "document_idle"
    }
  ],
  // Allow the CRXJS HMR service worker to load scripts from the Vite dev server
  ...(mode === 'development' && {
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval' http://localhost:* http://127.0.0.1:*; object-src 'self'"
    }
  }),
}))
