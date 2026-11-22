import type { CaptureResult, PostHog } from 'posthog-js'
import { redact } from '@/lib/observability/redact'
import { drainEarlyErrors } from './early-errors'
import { isAnalyticsEnabled } from './enabled'
import { replayMaskText } from './replay-masking'

/**
 * Browser PostHog, started only for a signed-in person.
 *
 * Product analytics in the browser (PostHog analytics, masked session replay,
 * surveys) is on for a signed-in person unless they switched it off under
 * Inställningar, Konto (user_preferences.analytics_consent = false; null, never
 * asked, is on). Switched off, nothing here runs: no posthog.init, so no
 * request leaves the browser and nothing is read from or written to the
 * device. The public and auth pages never start it.
 *
 * identifySignedInPerson() (lib/analytics/identify.ts, from AnalyticsIdentify
 * in the dashboard and onboarding layouts) calls initAnalytics() right before
 * identify. isAnalyticsActive() is true from that call, but the SDK arrives
 * later (choice 5 below), so nothing calls the SDK directly: a capture goes
 * through captureAnalyticsEvent(), other work through analyticsReady() or
 * loadedAnalytics(). An SDK called before posthog.init drops the call with
 * an "initialize first" console error. scripts/checks/one-definition/
 * posthog-sdk-import.mjs keeps every other module from importing it.
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
 * 3. Deny-by-default replay masking. Replays
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
 *
 * 5. The SDK is loaded when analytics starts, not with the page. It is about
 *    62 kB compressed (222 kB of script), and it sat in the first load of
 *    every page, the login page and every page of a person who switched
 *    analytics off included (scripts/perf/README.md, "Page budgets"). Now
 *    initAnalytics() marks analytics as started at once and fetches the SDK
 *    in the background; everything that talks to PostHog goes through
 *    analyticsReady() or loadedAnalytics() below, so an event captured
 *    while the SDK loads waits behind posthog.init instead of being lost.
 *    A person who never consents never downloads it: the one-definition
 *    rule above keeps every other module from importing it.
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
// Set by stopAnalytics(): an SDK still loading when consent is withdrawn is
// never initialised.
let stopped = false
// The started SDK: settles once it has loaded and posthog.init has run, and
// resolves null when it could not load (blocked, offline) or consent was
// withdrawn first. Set by the first initAnalytics() of the tab.
let ready: Promise<PostHog | null> | null = null
// The same SDK once ready has settled with it, for the synchronous readers.
let loaded: PostHog | null = null
// The SDK could not load or start: analytics stays silent for this page
// load, and Support stops waiting for it (lib/support/conversations.ts).
let failed = false

/**
 * Start PostHog in this browser. Call only for a signed-in person who has not
 * switched analytics off. Idempotent; returns whether analytics now runs.
 */
export function initAnalytics(): boolean {
  if (typeof window === 'undefined') return false
  if (started) return true
  if (!isAnalyticsEnabled()) return false
  started = true
  // The page the errors held before the start belong to (early-errors.ts),
  // read now: a client-side navigation may move on while the SDK loads.
  const pathname = window.location.pathname
  ready = import('posthog-js').then(
    ({ default: posthog }) => {
      if (stopped) return null
      try {
        posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
          api_host: '/rl',
          ui_host: 'https://eu.posthog.com',
          defaults: '2026-05-30',
          // Only create person profiles for users we actually identify.
          person_profiles: 'identified_only',
          persistence: 'memory',
          capture_exceptions: true,
          // Every exception event is redacted before it leaves the browser,
          // whichever path raised it (redactExceptionEvent below).
          before_send: redactExceptionEvent,
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
      } catch {
        // An SDK that throws in init is treated as one that did not load:
        // nothing is sent through it for the rest of this page load.
        failed = true
        return null
      }
      try {
        // Errors this page raised before the start, hydration mismatches above
        // all, which happen before AnalyticsIdentify's effect can run
        // (lib/analytics/early-errors.ts).
        for (const error of drainEarlyErrors(pathname)) {
          posthog.captureException(error, { before_analytics_start: true })
        }
      } catch {
        // The held errors are a best-effort report; the started SDK still
        // takes the identify and the events queued behind it.
      }
      // Set last: a synchronous reader sees the SDK only once it has started.
      loaded = posthog
      return posthog
    },
    () => {
      // The SDK did not load (an ad blocker, a dropped connection): analytics
      // stays silent for this page load, as it does without consent.
      failed = true
      return null
    },
  )
  return true
}

/**
 * The started SDK, once it has loaded; null while it loads, when it could not
 * load, and whenever analytics does not run in this browser. For the
 * synchronous readers (is Support available, which ticket is current).
 */
export function loadedAnalytics(): PostHog | null {
  return isAnalyticsActive() ? loaded : null
}

/**
 * True once the SDK has failed to load or to start in this page load: the
 * readers that wait for it (Support) can stop waiting.
 */
export function analyticsLoadFailed(): boolean {
  return failed
}

/**
 * Resolves with the started SDK once it has loaded and posthog.init has run,
 * or null when analytics does not run in this browser or the SDK could not
 * load. Work queued on it runs in the order it was queued, after init.
 */
export function analyticsReady(): Promise<PostHog | null> {
  return isAnalyticsActive() && ready ? ready : Promise.resolve(null)
}

/**
 * Capture one product event when analytics runs, after the SDK has loaded.
 * Never throws and never affects the caller.
 */
export function captureAnalyticsEvent(event: string, properties?: Record<string, unknown>): void {
  if (!isAnalyticsActive()) return
  void analyticsReady().then((posthog) => {
    try {
      posthog?.capture(event, properties)
    } catch {
      // Telemetry must never affect the flow that reported it.
    }
  })
}

/**
 * Report an error that a React error boundary caught (AppErrorBoundary under
 * app/error.tsx, app/(dashboard)/error.tsx, app/global-error.tsx) to PostHog
 * Error Tracking, when analytics runs.
 *
 * Without this such an error reached no one: in production Next.js hands an
 * error caught by an explicit boundary to console.error only (onCaughtError
 * in next/dist/client/react-client-callbacks), and capture_exceptions above
 * captures uncaught errors and rejections, not console output.
 *
 * The error itself goes to the SDK, which parses its frames, and before_send
 * (redactExceptionEvent below) redacts the message and the frames, as for
 * every exception from the browser. Redacting it here first replaced the
 * whole stack with [REDACTED] whenever the message held a number shaped like
 * a personnummer, an organisationsnummer included. An error with a digest is
 * left out: it was thrown in a server render, onRequestError
 * (instrumentation.ts) already captured it on the server with its real
 * message, and the browser holds only a generic copy.
 *
 * `autoReload` is true when the boundary reloads the page at once (its
 * one-shot recovery), so the person never saw the fallback; an error that
 * healed that way reads differently from one that stayed on screen.
 * Never throws and never affects the boundary that reported it.
 */
export function captureBoundaryError(error: unknown, boundary: string, autoReload = false): void {
  if (!isAnalyticsActive()) return
  try {
    if (hasServerDigest(error)) return
  } catch {
    // A value whose digest cannot be read is not sent; the boundary has
    // already logged it to the console.
    return
  }
  void analyticsReady().then((posthog) => {
    try {
      posthog?.captureException(error, { error_boundary: boundary, auto_reload: autoReload })
    } catch {
      // Telemetry must never affect the boundary that reported it.
    }
  })
}

/** Next.js sets `digest` on an error from a server render, which the server has captured. */
function hasServerDigest(error: unknown): boolean {
  return typeof error === 'object' && error !== null && typeof (error as { digest?: unknown }).digest === 'string'
}

/**
 * The properties of an exception event that carry what the error said: each
 * error's type, message, frames and mechanism ($exception_list), the steps
 * the SDK may record before it ($exception_steps), and the message copy some
 * capture paths add ($exception_message).
 */
const EXCEPTION_PAYLOAD_PROPERTIES = ['$exception_list', '$exception_steps', '$exception_message'] as const

/**
 * posthog.init's before_send. An exception event leaves the browser only
 * redacted with lib/observability/redact.ts, whichever path raised it: the
 * SDK's own capture of uncaught errors and rejections (capture_exceptions),
 * the errors held before the start (early-errors.ts) and captureBoundaryError.
 * All three end in the SDK's capture('$exception') after it has turned the
 * thrown value into $exception_list, so this hook is the one place each of
 * them passes. redact() is idempotent, so an error captureBoundaryError has
 * already redacted comes out the same. An exception that cannot be redacted
 * is dropped rather than sent; every other event passes unchanged.
 */
export function redactExceptionEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== '$exception') return event
  try {
    const properties = { ...event.properties }
    for (const key of EXCEPTION_PAYLOAD_PROPERTIES) {
      if (properties[key] !== undefined) properties[key] = redact(properties[key])
    }
    return { ...event, properties }
  } catch {
    // Nothing of an exception that could not be redacted leaves the browser.
    return null
  }
}

/**
 * The person withdrew consent in this tab: stop recording and drop the
 * identity, then the caller reloads, and PostHog stays unstarted from then
 * on. Deliberately not opt_out_capturing(): that writes an opt-out flag to
 * the device, and the stored consent already keeps PostHog from starting.
 */
export function stopAnalytics(): void {
  if (!started) return
  stopped = true
  if (!loaded) return
  try {
    loaded.stopSessionRecording()
    loaded.reset()
  } catch {
    // best-effort: the reload that follows ends it either way
  }
}

/** Whether PostHog runs in this browser: enabled for the deployment AND started on consent. */
export function isAnalyticsActive(): boolean {
  return started && isAnalyticsEnabled()
}
