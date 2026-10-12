import {
  registerObservabilitySink,
  type ObservabilityContext,
  type ObservabilityLevel,
  type ObservabilitySink,
} from '@/lib/observability'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'

let ensured = false

/**
 * The PostHog adapter (./posthog-observability), loaded on the first event it
 * has to ship: loading posthog-node costs a cold start a few hundred
 * milliseconds, which a request that logs no error should not pay. Until the
 * adapter has loaded, captures queue behind the load (synchronous and never
 * throwing, as the sink contract asks). flush() waits for the load and then
 * drains, so it still ships everything captured before it. A failed load
 * drops what it carried and the next capture tries again.
 */
export function createLazyPostHogSink(): ObservabilitySink {
  let loading: Promise<ObservabilitySink> | null = null
  const load = (): Promise<ObservabilitySink> =>
    (loading ??= import('@/lib/analytics/posthog-observability').then((m) => m.postHogSink))
  const ship = (send: (sink: ObservabilitySink) => void): void => {
    load().then(send, () => {
      loading = null
    })
  }

  return {
    name: 'posthog',
    captureException(error: unknown, context: ObservabilityContext): void {
      ship((sink) => sink.captureException(error, context))
    },
    captureMessage(message: string, level: ObservabilityLevel, context: ObservabilityContext): void {
      ship((sink) => sink.captureMessage(message, level, context))
    },
    async flush(timeoutMs?: number): Promise<boolean> {
      if (!loading) return true
      try {
        return await (await loading).flush(timeoutMs)
      } catch {
        // Contract: must never reject.
        return false
      }
    },
  }
}

/**
 * Turn lib/observability from a no-op into PostHog Error Tracking, once per
 * process. Gated, so with no token (core, CI, self-hosted) the sink stays the
 * no-op and PostHog is never constructed and never contacted.
 *
 * Its own module, apart from lib/init, so every server entry gets error
 * reporting without loading every extension: lib/server-baseline.ts (imported
 * by the route wrappers) and the root layout call it at module scope, and
 * ensureInitialized() calls it too.
 *
 * Covers what instrumentation.ts's onRequestError cannot: error-level lines
 * written through createLogger() for errors that were caught and handled.
 */
export function ensureObservability(): void {
  if (ensured) return
  ensured = true
  if (isAnalyticsEnabled()) registerObservabilitySink(createLazyPostHogSink())
}
