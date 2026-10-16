import type { Instrumentation } from 'next'
// Imported by exact path rather than through the `@/lib/observability` barrel:
// this file's module graph is loaded in every runtime Next boots, and the
// predicate is a dependency-free pure function.
import { isClientDisconnectError } from '@/lib/observability/is-client-disconnect'

/**
 * Loads lib/init (the core event handlers and every enabled extension) for
 * this server process, and is the only module in the app that imports it.
 *
 * Next.js runs register() once per server process before the first request
 * is handled, but never during `next build`. It registers the loader that
 * whenInitialized() (lib/initialized.ts) waits for, and does not start it:
 * the load still runs on first use (the first event emitted or registry read),
 * as it has since 2026-10-11, so a request that neither emits nor reads a
 * registry loads no extension and a cold start pays nothing for them. A failed
 * load is retried by the next caller. startInitializing() exists for a later
 * opt-in once cold-start latency with a background load has been measured. Because lib/init is reached from here and not through the event bus,
 * a route, page or server action no longer compiles lib/init and every
 * extension into its own graph (`npm run check:guards`: static-init-import,
 * lazy-init-reach).
 *
 * Node.js runtime only: the edge build of this file never sees lib/init.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerInitLoader } = await import('@/lib/initialized')
    registerInitLoader(() => import('@/lib/init').then((m) => m.ensureInitialized()))
  }
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
