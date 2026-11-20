export default {
  rule: 'posthog-sdk-import',
  says: 'Only lib/analytics/client.ts loads the PostHog browser SDK, after the page and only once analytics starts; every other module goes through captureAnalyticsEvent, analyticsReady or loadedAnalytics.',
  home: 'src/lib/analytics/client.ts: initAnalytics',
  why: 'Ten modules imported posthog-js statically, so its 62 kB sat in the first load of every page, the login page and the pages of people who switched analytics off included, although consent decided only whether it started.',
  match: [
    // import posthog from 'posthog-js', import { x } from 'posthog-js/react'.
    // `import type` is erased at build time and loads nothing.
    /^\s*import\s+(?!type\b)[^'"]*\bfrom\s+['"]posthog-js(?:\/[^'"]*)?['"]/,
    // A bare side-effect import.
    /^\s*import\s+['"]posthog-js(?:\/[^'"]*)?['"]/,
    // A re-export that is not type-only.
    /^\s*export\s+(?!type\b)[^'"]*\bfrom\s+['"]posthog-js(?:\/[^'"]*)?['"]/,
    // import('posthog-js'), require('posthog-js').
    /\b(?:import|require)\(\s*['"]posthog-js(?:\/[^'"]*)?['"]\s*\)/,
  ],
  sanctioned: ['lib/analytics/client.ts'],
  allowed: {},
}
