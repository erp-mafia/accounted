/**
 * Names a request that one session keeps repeating.
 *
 * On 2026-11-11 one session sent GET /import nine times a second for 80
 * minutes, and on 2026-10-31 another did the same somewhere. Neither could be
 * traced to its cause afterwards: the hosting logs keep no query string, and
 * Next.js strips the RSC and prefetch headers before the proxy runs, so a
 * document load, a client navigation and a prefetch all read as "page".
 *
 * The proxy counts requests per session, method and route on this instance
 * and, when one passes REPEAT_REPORT_THRESHOLD within a minute, writes one
 * line with what tells those apart: the Sec-Fetch headers the browser sets
 * itself, the page that sent the request, and the names (never the values)
 * of the query parameters. A bulk upload can cross the threshold too; the
 * line is a description, not an alarm.
 */

import { proxyRouteTemplate } from './proxy-timing'

const WINDOW_MS = 60_000
/** Five a second for a minute: a page load fans out a few dozen requests, a poller sends one every few seconds. */
export const REPEAT_REPORT_THRESHOLD = 300
const MAX_KEYS = 2_000

const counts = new Map<string, { since: number; count: number }>()

/**
 * Counts one request under `key`. Returns true exactly once per window, on
 * the request that reaches the threshold.
 */
export function reachesRepeatThreshold(key: string, now: number = Date.now()): boolean {
  let entry = counts.get(key)
  if (!entry || now - entry.since >= WINDOW_MS) {
    counts.delete(key)
    if (counts.size >= MAX_KEYS) {
      const oldest = counts.keys().next().value
      if (oldest !== undefined) counts.delete(oldest)
    }
    entry = { since: now, count: 0 }
    counts.set(key, entry)
  }
  entry.count += 1
  return entry.count === REPEAT_REPORT_THRESHOLD
}

interface RepeatedRequest {
  method: string
  url: URL
  headers: Pick<Headers, 'get'>
}

/** What tells a document load, a script's fetch and a prefetch apart, without any value a user typed. */
export function describeRepeatedRequest(request: RepeatedRequest): Record<string, unknown> {
  const { headers, url } = request
  let refererPath: string | null = null
  const referer = headers.get('referer')
  if (referer) {
    try {
      const parsed = new URL(referer)
      // As a route template: a referring page can carry a token in its path.
      refererPath = parsed.origin === url.origin ? proxyRouteTemplate(parsed.pathname) : parsed.origin
    } catch {
      // A referer that is not a URL says nothing about where the request came from.
      refererPath = null
    }
  }
  return {
    method: request.method,
    fetchDest: headers.get('sec-fetch-dest'),
    fetchMode: headers.get('sec-fetch-mode'),
    fetchSite: headers.get('sec-fetch-site'),
    purpose: headers.get('sec-purpose') ?? headers.get('purpose'),
    refererPath,
    queryKeys: Array.from(new Set(url.searchParams.keys())).sort(),
    userAgent: headers.get('user-agent')?.slice(0, 160) ?? null,
    windowSeconds: WINDOW_MS / 1000,
    count: REPEAT_REPORT_THRESHOLD,
  }
}

/** Test seam: forget every count. */
export function resetRepeatReportForTests(): void {
  counts.clear()
}
