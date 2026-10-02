/**
 * Whether responses may carry per-phase timing headers: the auth proxy's
 * `Server-Timing` (pages) and `X-Proxy-Timing` (/api), and the route
 * wrapper's `Server-Timing` (lib/api/with-route-context.ts).
 *
 * Those headers spell out how the request pipeline is built (an auth round
 * trip, a session check, company resolution, an MFA lookup) and how long each
 * step took, which an external scan reports as information disclosure.
 * Production therefore keeps only the structured log lines, which carry the
 * same numbers. Previews, local dev and tests keep the headers, and
 * EXPOSE_TIMING_HEADERS=true turns them back on anywhere for a debugging
 * session.
 *
 * Production means VERCEL_ENV=production on Vercel and NODE_ENV=production
 * everywhere else (a self-hosted `next start` or standalone server), the same
 * precedence lib/observability/sink.ts uses for its environment tag. Read on
 * every call, so the opt-in applies without a rebuild.
 */
export function shouldExposeTimingHeaders(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.EXPOSE_TIMING_HEADERS === 'true') return true
  return (env.VERCEL_ENV || env.NODE_ENV) !== 'production'
}
