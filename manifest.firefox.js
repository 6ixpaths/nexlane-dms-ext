export default {
  manifest_version: 2,
  name: 'Nexlane DMS Extension',
  version: '1.0.0',
  description: 'Facebook Marketplace chat filtering and Openlane gallery tools for Nexlane DMS',
  permissions: [
    "storage",
    "downloads",
    "activeTab",
    "scripting",
    "https://pub-us.kar-media.com/*",
    "http://127.0.0.1:8000/*",
    "http://localhost:8000/*"
  ],
  background: {
    scripts: ["background.js"],
    persistent: false
  },
  content_scripts: [
    {
      matches: [
        "https://www.facebook.com/marketplace/*",
        "https://www.facebook.com/messages/*",
        "https://www.messenger.com/*"
      ],
      js: ["content.js"],
      run_at: "document_idle"
    },
    {
      matches: ["https://app.openlane.ca/*"],
      js: ["openlane.js"],
      run_at: "document_idle"
    }
  ],
}
