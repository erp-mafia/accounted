import { registerObservabilitySink } from '@/lib/observability'
import { postHogSink } from '@/lib/analytics/posthog-observability'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'

let ensured = false

/**
 * Turn lib/observability from a no-op into PostHog Error Tracking, once per
 * process. Gated, so with no token (core, CI, self-hosted) the sink stays the
 * no-op and PostHog is never constructed and never contacted. Note the SDK is
 * still BUNDLED in those builds: the imports are static, so the bytes ship even
 * though nothing initialises. Making that a true zero would mean dynamic
 * imports at every posthog call site, which is a deliberate non-goal here.
 *
 * Its own module, apart from lib/init, so the root layout can wire error
 * reporting for every server render without loading every extension.
 * ensureInitialized() calls it too, so API routes keep the same sink.
 *
 * Covers what instrumentation.ts's onRequestError cannot: error-level lines
 * written through createLogger() for errors that were caught and handled.
 */
export function ensureObservability(): void {
  if (ensured) return
  ensured = true
  if (isAnalyticsEnabled()) registerObservabilitySink(postHogSink)
}
