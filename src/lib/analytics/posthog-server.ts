import 'server-only'
import { PostHog } from 'posthog-node'
import { isAnalyticsEnabled } from './enabled'

/**
 * Server-side PostHog client (posthog-node).
 *
 * posthog-js is browser-only, so anything captured from a route handler, a
 * server component or the onRequestError hook goes through here.
 *
 * `flushAt: 1` / `flushInterval: 0` are NOT tuning: Vercel functions are torn
 * down per invocation, and the SDK's default batching would let the process
 * die before the enqueued event is sent. With these set, every capture sends
 * on its own, and callers must still `await flushAnalytics()` before
 * returning or the send races the teardown.
 *
 * Returns null when analytics is off (self-hosted, or no token), so callers
 * degrade to a no-op instead of throwing.
 */
let client: PostHog | null = null

export function getPostHogServer(): PostHog | null {
  if (!isAnalyticsEnabled()) return null
  if (!client) {
    client = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
      // Server-side traffic is not ad-blocked, so it talks to PostHog
      // directly rather than through the /rl same-origin rewrite (which only
      // exists in the browser's Next.js routing anyway). This is the only
      // reader of NEXT_PUBLIC_POSTHOG_HOST; the EU default keeps it optional.
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
      enableExceptionAutocapture: true,
    })
  }
  return client
}

/** Await this before a request handler returns, or the send is dropped. */
export async function flushAnalytics(): Promise<void> {
  if (!client) return
  try {
    await client.flush()
  } catch {
    // Telemetry must never fail a real request.
  }
}
