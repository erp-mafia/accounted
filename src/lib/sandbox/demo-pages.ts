/**
 * The example-data demo pages under /sandbox (wiki, agenter) exist for
 * building and reviewing UI without signing in. They answer in development
 * and on preview deployments, and 404 everywhere else. SANDBOX_DEMO_PAGES=true
 * opens them on an installation that wants them.
 */
export function demoPagesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.SANDBOX_DEMO_PAGES === 'true') return true
  if (env.NODE_ENV === 'development') return true
  return env.VERCEL_ENV === 'preview'
}
