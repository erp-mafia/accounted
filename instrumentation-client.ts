import posthog from 'posthog-js'
import { isAnalyticsEnabled, warnIfAnalyticsMisconfigured } from '@/lib/analytics/enabled'
import { purgeLegacyAnalyticsStorage } from '@/lib/analytics/purge-legacy-storage'

// Clear anything Recapt left on the device. Runs unconditionally, BEFORE the
// analytics gate: a browser carrying `__recapt_record_engine` must get cleaned
// up even on a build where PostHog itself is switched off.
purgeLegacyAnalyticsStorage()

/**
 * Hostnames that get the X-POSTHOG-DISTINCT-ID / X-POSTHOG-SESSION-ID headers,
 * which is what lets a server error captured in instrumentation.ts link back
 * to this user's session replay.
 *
 * Deliberately our own origin only. Listing a Supabase or third-party host
 * here would leak PostHog identifiers to them. PostHog matches on hostname
 * alone, so no protocol and no port ('localhost', never 'localhost:3000').
 */
function tracingHosts(): string[] {
  const hosts = ['localhost', '127.0.0.1']
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (appUrl) {
    try {
      hosts.push(new URL(appUrl).hostname)
    } catch {
      // Malformed NEXT_PUBLIC_APP_URL: skip rather than break init.
    }
  }
  return hosts
}

/**
 * Client-side PostHog initialisation.
 *
 * This file is the ONLY place posthog.init() is called. Next.js 15.3+ runs
 * `instrumentation-client` before hydration, which is what PostHog's own
 * Next.js guidance requires; deliberately NOT combined with a
 * <PostHogProvider> wrapper, which their example calls out as a mistake.
 *
 * Three choices here are deliberate and worth not "fixing":
 *
 * 1. `api_host: '/rl'` routes every request through the same-origin rewrite
 *    in next.config.ts. That keeps PostHog first-party, so the strict CSP
 *    needs no third-party hosts at all (`connect-src 'self'` already covers
 *    it) and ad blockers have nothing to match on. The path must stay in the
 *    proxy.ts matcher exclusion or middleware bounces it to /login.
 *
 * 2. `persistence: 'memory'` stores nothing on the device. That is what lets
 *    us run analytics without a cookie-consent banner. The cost is that an
 *    anonymous visitor's identity does not survive a hard reload; everything
 *    post-login is unaffected because AnalyticsIdentify re-identifies on
 *    every dashboard load. Note that surveys still write their own
 *    `seenSurvey_*` flags straight to localStorage, bypassing this setting:
 *    that is functional UI state ("don't ask again"), not tracking.
 *
 * 3. Mask-by-default text masking. `maskTextSelector: '*'` routes EVERY text
 *    node through `maskTextFn`, which masks unless a `data-ph-unmask`
 *    ancestor opts the node back in. This is an accounting app: org numbers
 *    (which for a sole proprietorship ARE the owner's personal identity
 *    number), customer names, balances and invoice amounts are rendered as
 *    ordinary text, and PostHog masks inputs but NOT text by default.
 *    Replays are for seeing WHERE a user gets stuck, never WHAT their books
 *    say.
 *
 *    `data-ph-unmask` is for static chrome only (nav labels, headings,
 *    button text from i18n). User data nested inside an unmasked container
 *    (active company name, user email, badge counts) gets `data-ph-mask`,
 *    which wins because `closest()` finds the NEAREST tagged ancestor: when
 *    both attributes land on the same element, mask still wins.
 *    Anything untagged stays masked, so a forgotten tag fails safe.
 *
 *    The shared form label primitive (`components/ui/label.tsx`) carries
 *    `data-ph-unmask` by default, so replays show WHICH field a user is
 *    filling in while `maskAllInputs` keeps the typed value hidden. A call
 *    site whose label text is user data (e.g. user-defined dimension names)
 *    must add `data-ph-mask`.
 */
function maskText(text: string): string {
  return text.replace(/\S/g, '*')
}
if (warnIfAnalyticsMisconfigured() && isAnalyticsEnabled()) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    api_host: '/rl',
    ui_host: 'https://eu.posthog.com',
    defaults: '2026-05-30',
    // Only create person profiles for users we actually identify: logged-out
    // visitors stay anonymous and cheap.
    person_profiles: 'identified_only',
    persistence: 'memory',
    capture_exceptions: true,
    tracing_headers: tracingHosts(),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      maskTextFn: (text: string, element?: HTMLElement): string => {
        const tagged = element?.closest('[data-ph-unmask],[data-ph-mask]')
        if (!tagged || tagged.hasAttribute('data-ph-mask')) {
          return maskText(text)
        }
        return text
      },
    },
    debug: process.env.NODE_ENV === 'development',
  })
}
