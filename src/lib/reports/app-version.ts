/**
 * Running software version, stamped on räkenskapsinformation that BFNAR 2013:2
 * p. 9.16 second paragraph wants dated: the behandlingshistorik report and the
 * systemdokumentation in the archive. Vercel inlines the commit SHA at build;
 * self-hosted builds without it report null rather than a made-up value.
 */
export function currentAppVersion(): string | null {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_ID || ''
  return sha ? sha.slice(0, 12) : null
}
