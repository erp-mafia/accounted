import posthog from 'posthog-js'
import { isAnalyticsEnabled, warnIfAnalyticsMisconfigured } from '@/lib/analytics/enabled'
import { purgeLegacyAnalyticsStorage } from '@/lib/analytics/purge-legacy-storage'
import { replayMaskInput, replayMaskText } from '@/lib/analytics/replay-masking'

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
 * 3. Pattern-based replay masking (founder-approved 2026-08-06, supersedes
 *    the 2026-07-27 mask-everything default that made replays wall-to-wall
 *    asterisks). Replays exist so support can see WHERE a user gets stuck
 *    and WHAT they typed while getting there; what stays unreadable is the
 *    content of their books. `lib/analytics/replay-masking.ts` masks
 *    currency-shaped text (every amount renders through `formatCurrency()`,
 *    so one pattern covers all surfaces including future code), person-/
 *    organisationsnummer (for an enskild firma the orgnr IS the owner's
 *    personnummer) in both text and typed input, and password inputs.
 *    Everything else, typed input included, is visible in the replay.
 *
 *    `data-ph-mask` force-masks a subtree (deliberate PII spots: danger-zone
 *    labels, user-defined dimension names, nav count bubbles) and
 *    `data-ph-unmask` exempts one from pattern masking; the NEAREST tagged
 *    ancestor wins, and mask wins when both land on the same element.
 *
 *    rrweb only calls `maskInputFn` on inputs flagged by `maskInputOptions`,
 *    so `maskAllInputs: true` stays set to flag every input and the function
 *    decides per value. posthog-js force-merges `password: true` into
 *    `maskInputOptions` on top of that.
 */
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
      maskInputFn: replayMaskInput,
      maskTextSelector: '*',
      maskTextFn: replayMaskText,
    },
    debug: process.env.NODE_ENV === 'development',
  })
}
