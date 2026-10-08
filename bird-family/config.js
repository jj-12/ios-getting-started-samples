/*
 * Site configuration — the only file you should need to touch to turn on
 * analytics or change the public address of the site.
 *
 * Everything else that is "content" (names, dates, stories, photos) lives in
 * index.html and is marked with  <!-- EDIT: ... -->  comments.
 */
window.SITE_CONFIG = {
  // The address people will reach the site at once the domain is live.
  // Used for the "Share" section and the copy-link button.
  siteUrl: 'https://supportthebirdfamily.org/',

  analytics: {
    // Google Analytics 4.  Create a property at https://analytics.google.com,
    // add a "Web" data stream for supportthebirdfamily.org, then paste the
    // Measurement ID here (it looks like "G-XXXXXXXXXX").  Leave blank to
    // disable.  Nothing is loaded from Google until this is filled in.
    ga4MeasurementId: '',

    // Optional: Plausible (privacy-friendly, no cookie banner needed).
    // Set to the domain you registered with Plausible, e.g.
    // 'supportthebirdfamily.org'.  Leave blank to disable.
    plausibleDomain: '',

    // Respect the browser's "Do Not Track" / Global Privacy Control settings.
    respectDoNotTrack: true
  }
};
