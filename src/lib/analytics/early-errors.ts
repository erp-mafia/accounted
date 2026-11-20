/**
 * Errors the browser raises before PostHog starts, held in memory until it does.
 *
 * PostHog starts in AnalyticsIdentify's effect (lib/analytics/client.ts),
 * which runs after the page has hydrated. Next.js reports a hydration
 * mismatch (React error #418) through window.reportError during hydration,
 * so from 2026-10-22, when the start moved out of instrumentation-client.ts,
 * those errors reached no one: PostHog showed zero #418 a day while the Hem
 * greeting mismatch was still live in production.
 *
 * instrumentation-client.ts calls bufferEarlyErrors() before hydration;
 * initAnalytics() drains the buffer right after posthog.init and sends each
 * error on with captureException. Nothing leaves the browser and nothing is
 * written to the device before then, so the consent rule in client.ts holds:
 * where PostHog never starts (opted out, public and auth pages, self-hosted),
 * the buffer is simply dropped with the page.
 */

/** Enough for one page's start-up; a page throwing more than this is not short of reports. */
export const MAX_EARLY_ERRORS = 20

export interface EarlyError {
  error: unknown
  /** location.pathname when it was raised. Never the query string, which can carry an org number. */
  pathname: string
}

let buffer: EarlyError[] | null = null
let target: Window | null = null

function push(error: unknown): void {
  if (!buffer || buffer.length >= MAX_EARLY_ERRORS) return
  buffer.push({ error, pathname: target?.location.pathname ?? '' })
}

function onError(event: ErrorEvent): void {
  push(event.error ?? event.message)
}

function onRejection(event: PromiseRejectionEvent): void {
  push(event.reason)
}

/** Start holding uncaught errors and rejections raised in `win`. Idempotent. */
export function bufferEarlyErrors(win: Window): void {
  if (buffer) return
  buffer = []
  target = win
  win.addEventListener('error', onError)
  win.addEventListener('unhandledrejection', onRejection)
}

/**
 * Stop holding errors and return those raised on `pathname`, the page PostHog
 * starts on (the hydration errors of that very page). Errors from an earlier
 * page in the same tab, such as the login page before a client-side
 * navigation, are dropped: nobody had analytics on there.
 */
export function drainEarlyErrors(pathname: string): unknown[] {
  const held = buffer ?? []
  if (target) {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
  buffer = null
  target = null
  return held.filter((e) => e.pathname === pathname).map((e) => e.error)
}
