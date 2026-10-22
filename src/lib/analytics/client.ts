import posthog from 'posthog-js'
import { isAnalyticsEnabled } from './enabled'
import { replayMaskText } from './replay-masking'

/**
 * Browser PostHog, started only on the signed-in person's consent.
 *
 * Founder decision 2026-10-21: product analytics in the browser (PostHog
 * analytics, masked session replay, surveys) is a choice the person makes in
 * the acceptance prompt and can change under Inställningar → Konto. Until
 * they say yes nothing here runs: no posthog.init, so no request leaves the
 * browser and nothing is read from or written to the device (LEK 9 kap. 28 §
 * covers the access itself, not only cookies). The public and auth pages
 * never start it, because nobody has consented there.
 *
 * AnalyticsIdentify (dashboard layout) calls initAnalytics() when the stored
 * consent is true. Every other browser caller asks isAnalyticsActive(), which
 * is false until then, so a capture before consent is a no-op instead of
 * PostHog's "initialize first" console error.
 *
 * Choices that are deliberate and worth not "fixing":
 *
 * 1. `api_host: '/rl'` routes every request through the same-origin rewrite
 *    in next.config.ts. That keeps PostHog first-party, so the strict CSP
 *    needs no third-party hosts at all (`connect-src 'self'` already covers
 *    it) and ad blockers have nothing to match on. The path must stay in the
 *    proxy.ts matcher exclusion or middleware bounces it to /login.
 *
 * 2. `persistence: 'memory'` stores no analytics identity on the device, so a
 *    hard reload starts a fresh anonymous id; AnalyticsIdentify re-identifies
 *    on every dashboard load. Surveys still write their own `seenSurvey_*`
 *    flags and Support its `ph_conv_*` ticket id to localStorage: both only
 *    after consent, since nothing here starts before it.
 *
 * 3. Deny-by-default replay masking (founder-approved 2026-08-17). Replays
 *    exist so support can see WHERE a user gets stuck: layout, clicks and
 *    static chrome (headers, nav, labels, placeholders), never what the user
 *    typed or what their books say.
 *
 *    Inputs: `maskAllInputs: true` with NO `maskInputFn` means rrweb masks
 *    every input value to asterisks, no exceptions. Placeholder text is an
 *    attribute, not an input value, so it stays visible.
 *
 *    Text: `lib/analytics/replay-masking.ts` masks every text node unless
 *    it sits under chrome (`data-ph-unmask`, tagged on the shared UI
 *    primitives, or a `<th>`); chrome is still pattern-scrubbed for
 *    currency-shaped spans and person-/organisationsnummer. `data-ph-mask`
 *    force-masks a subtree and beats `data-ph-unmask`: the NEAREST tagged
 *    ancestor wins, and mask wins when both land on the same element.
 *
 * 4. In-app support works without analytics consent: with PostHog not
 *    started, Conversations is unavailable and the support dialog sends the
 *    message by e-mail to the support desk instead
 *    (lib/support/submit-feedback.ts), which turns it into the same ticket.
 *    A message the person writes to us is a service they asked for; it never
 *    needed the analytics SDK, so the SDK is not started for it.
 */

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

let started = false

/**
 * Start PostHog in this browser. Call only for a signed-in person whose stored
 * analytics consent is true. Idempotent; returns whether analytics now runs.
 */
export function initAnalytics(): boolean {
  if (typeof window === 'undefined') return false
  if (started) return true
  if (!isAnalyticsEnabled()) return false
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    api_host: '/rl',
    ui_host: 'https://eu.posthog.com',
    defaults: '2026-05-30',
    // Only create person profiles for users we actually identify.
    person_profiles: 'identified_only',
    persistence: 'memory',
    capture_exceptions: true,
    // Masks these query parameters in $current_url and the initial-URL person
    // properties: a sole trader's org number is the owner's personnummer
    // (#58). The flag also masks ad click ids (gclid, fbclid, ...).
    mask_personal_data_properties: true,
    custom_personal_data_properties: ['org_number', 'personnummer', 'personal_number'],
    tracing_headers: tracingHosts(),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      maskTextFn: replayMaskText,
    },
    debug: process.env.NODE_ENV === 'development',
  })
  started = true
  return true
}

/**
 * The person withdrew consent in this tab: stop recording and drop the
 * identity, then the caller reloads, and PostHog stays unstarted from then
 * on. Deliberately not opt_out_capturing(): that writes an opt-out flag to
 * the device, and the stored consent already keeps PostHog from starting.
 */
export function stopAnalytics(): void {
  if (!started) return
  try {
    posthog.stopSessionRecording()
    posthog.reset()
  } catch {
    // best-effort: the reload that follows ends it either way
  }
}

/** Whether PostHog runs in this browser: enabled for the deployment AND started on consent. */
export function isAnalyticsActive(): boolean {
  return started && isAnalyticsEnabled()
}
