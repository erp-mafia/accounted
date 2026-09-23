import type { Instrumentation } from 'next'
// Imported by exact path rather than through the `@/lib/observability` barrel:
// this file's module graph is loaded in every runtime Next boots, and the
// predicate is a dependency-free pure function.
import { isClientDisconnectError } from '@/lib/observability/is-client-disconnect'

export async function register() {
  // Instrumentation hook: currently a no-op.
  // Add runtime-specific setup here if needed.
}

/**
 * Server-side error capture for PostHog Error Tracking.
 *
 * Next.js calls this for every uncaught error in a route handler, server
 * component or server action. Client-side exceptions are handled separately
 * by `capture_exceptions` in instrumentation-client.ts.
 *
 * posthog-node is imported lazily inside the handler rather than at module
 * scope: `register()` runs in every runtime Next.js boots, and pulling a
 * Node-only SDK into that graph unconditionally is how instrumentation files
 * break edge/build-time compilation. A dynamic import keeps the cost on the
 * error path only.
 *
 * The distinct id comes from the `X-POSTHOG-DISTINCT-ID` header that
 * posthog-js attaches to same-origin fetches (see `tracing_headers` in
 * instrumentation-client.ts), which is what links a server error back to the
 * user's session replay. Absent that header the error is still captured, just
 * unattributed.
 *
 * A client that navigated away mid-stream is filtered out first: see
 * `isClientDisconnectError`. Next reports those through this hook even though
 * the response itself succeeded, and they are not exceptions. Next still
 * writes its own stderr line for them, so they stay visible in Vercel's
 * runtime-error table; what this drops is the false entry in Error Tracking
 * and the awaited flush it would cost a healthy request.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (isClientDisconnectError(err)) return

  try {
    const { getPostHogServer, flushAnalytics } = await import('@/lib/analytics/posthog-server')
    const posthog = getPostHogServer()
    if (!posthog) return

    const headers = request.headers as Record<string, string | string[] | undefined> | undefined
    const raw = headers?.['x-posthog-distinct-id']
    const distinctId = Array.isArray(raw) ? raw[0] : raw

    posthog.captureException(err instanceof Error ? err : new Error(String(err)), distinctId, {
      path: request.path,
      method: request.method,
    })
    // Vercel tears the function down per invocation: without the awaited
    // flush the enqueued event is silently dropped.
    await flushAnalytics()
  } catch {
    // Telemetry must never turn a handled error into a second failure.
  }
}
