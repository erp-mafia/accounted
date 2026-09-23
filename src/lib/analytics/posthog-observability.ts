import type { ObservabilityContext, ObservabilityLevel, ObservabilitySink } from '@/lib/observability'
import { getPostHogServer, flushAnalytics } from './posthog-server'

/**
 * PostHog adapter for the provider-agnostic observability sink.
 *
 * Registering this is what makes `lib/observability` stop being a no-op: from
 * then on every `error`-level line written through `createLogger()`, plus
 * anything flagged `alert: true`, lands in PostHog Error Tracking already
 * correlated with the log line's request context. That is far broader
 * coverage than the `onRequestError` hook in instrumentation.ts, which only
 * sees errors that escape uncaught.
 *
 * Redaction: `lib/observability/sink.ts` redacts both the error and the
 * context before calling an adapter (and the logger has already redacted
 * once; redaction is idempotent). This adapter therefore forwards what it is
 * given and must never re-widen it by reaching for un-redacted sources.
 *
 * The interface requires captureException/captureMessage to be SYNCHRONOUS
 * and to never throw. posthog-node's capture enqueues synchronously and
 * sends afterwards, which fits: `flush()` is the drain the interface asks
 * for, and callers on serverless paths await it.
 */

/** PostHog Error Tracking has no severity axis, so level rides as a property. */
function toProperties(
  context: ObservabilityContext,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return { ...context, ...extra }
}

/**
 * `distinct_id` is a reserved context key set by the logger when a request
 * has an identified user. Without it PostHog would attribute the event to a
 * generated id per event, which fragments the error's person view.
 */
function distinctIdFrom(context: ObservabilityContext): string | undefined {
  const raw = context.distinct_id ?? context.user_id ?? context.userId
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

export const postHogSink: ObservabilitySink = {
  name: 'posthog',

  captureException(error: unknown, context: ObservabilityContext): void {
    try {
      const posthog = getPostHogServer()
      if (!posthog) return
      posthog.captureException(
        error instanceof Error ? error : new Error(String(error)),
        distinctIdFrom(context),
        toProperties(context)
      )
    } catch {
      // Contract: must not throw.
    }
  },

  captureMessage(message: string, level: ObservabilityLevel, context: ObservabilityContext): void {
    try {
      const posthog = getPostHogServer()
      if (!posthog) return
      const distinctId = distinctIdFrom(context)
      posthog.capture({
        // PostHog requires a distinct id; fall back to a stable server marker
        // rather than inventing a per-event id, which would create a new
        // person for every log line.
        distinctId: distinctId ?? 'server',
        event: '$log',
        properties: toProperties(context, { message, level }),
      })
    } catch {
      // Contract: must not throw.
    }
  },

  async flush(): Promise<boolean> {
    try {
      await flushAnalytics()
      return true
    } catch {
      // Contract: must never reject.
      return false
    }
  },
}
