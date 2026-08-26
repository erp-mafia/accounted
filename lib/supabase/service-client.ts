import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js'

/**
 * Auth options every server-side Supabase client MUST use.
 *
 * `autoRefreshToken` defaults to TRUE in supabase-js, and in a non-browser
 * environment @supabase/auth-js starts the refresh ticker unconditionally:
 *
 *   // in non-browser environments the refresh token ticker runs always
 *   this.startAutoRefresh()
 *
 * That is a `setInterval` firing every 30 s, stored on the client as
 * `autoRefreshTicker`. It calls `.unref()`, so the process can still exit and
 * nothing looks wrong in tests or on Vercel, where the process is short-lived
 * and torn down before the tickers accumulate. But `unref()` does NOT make a
 * timer collectable: it stays registered in the event loop's timer list and
 * remains a GC root for its callback, which closes over the GoTrueClient, the
 * SupabaseClient, and everything the surrounding request scope captured.
 *
 * A long-running self-hosted process therefore leaks one timer plus one entire
 * request graph (socket, IncomingMessage, ServerResponse, headers, cookies,
 * route context: roughly 100 kB) per client constructed. Observed in the wild
 * on 2026-08-13: a self-hosted instance died of "JavaScript heap out of memory"
 * after 42 h, the last 24 of them completely idle. A heap snapshot showed 445
 * retained request graphs and ~1050 Timeouts in the 30 000 ms bucket, retained
 * via `autoRefreshTicker`. The rate matched the traffic exactly: the Docker
 * healthcheck polls /api/health every 30 s (2 clients/min) and the webhook
 * dispatch cron runs every minute (1 client/min), so 3/min x 148 min = 444.
 *
 * `persistSession` is disabled for the same reason it always is on the server:
 * there is no browser storage to persist into, and a service-role client has no
 * user session to keep.
 */
export const SERVER_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
} as const

/**
 * Construct a server-side Supabase client that cannot leak a refresh ticker.
 *
 * Use this instead of importing `createClient` from '@supabase/supabase-js'
 * directly in any code that runs on the server (API routes, crons, extension
 * handlers, service-role helpers). `scripts/checks/no-new-antipatterns.mjs`
 * enforces it.
 *
 * The auth options are spread LAST, so a caller passing its own `auth` block
 * cannot accidentally re-enable the ticker.
 *
 * Browser clients are a different case and must keep the ticker: a signed-in
 * tab genuinely needs its access token refreshed. Those go through
 * `lib/supabase/client.ts`, which is unaffected.
 */
export function createServiceRoleClient(
  url: string,
  key: string,
  options?: SupabaseClientOptions<'public'>,
): SupabaseClient {
  return createClient(url, key, {
    ...options,
    auth: { ...options?.auth, ...SERVER_AUTH_OPTIONS },
  })
}
