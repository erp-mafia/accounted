/**
 * Every query parameter a v1 route reads is registered in its endpoint's
 * `request.query`, and nothing is registered that the route never reads.
 *
 * The OpenAPI spec, the generated accounted-api skill and the docs.accounted.se
 * reference pages all publish `request.query`. Before #2515 the spec emitted
 * path parameters only, and routes parsed their filters inline, so every list
 * filter lived in prose. This test holds the registry and the parsers
 * together: it scans each route file for the parameters it reads (literal
 * `searchParams.get('x')` calls plus the shared helpers below) and compares
 * them with what the file's endpoints register.
 *
 * `dry_run` is excluded: the withApiV1 wrapper reads it, and the generator
 * advertises it on every dry-run-capable endpoint.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listEndpoints, queryParameters, type EndpointDefinition } from '../registry'
// Side-effect import: populates the ENDPOINTS registry from every route file.
import '../load-routes'

/** Shared helpers that read query parameters on a route's behalf. */
const HELPER_PARAMS: Array<[RegExp, string[]]> = [
  [/\bparsePaginationParams\(/, ['cursor', 'limit']],
  [/\bloadPeriodFromQuery\(/, ['period_id']],
  [/\bloadRangeFromQuery\(/, ['from_date', 'to_date']],
  [/\basOfAlias:\s*true\b/, ['as_of']],
  [/\bparseReportDateRange\(/, ['from_date', 'to_date']],
  [/\bparseExpand\(/, ['expand']],
  [/\bparseDimensionFilterParams\(/, ['dim_no', 'dim_code']],
]

const WRAPPER_PARAMS = new Set(['dry_run'])

function routeFile(path: string): string {
  const segments = path.replace(/^\//, '').replace(/:([^/]+)/g, '[$1]')
  return join(process.cwd(), 'app', segments, 'route.ts')
}

function paramsReadBy(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/searchParams\.(?:get|getAll|has)\(\s*['"]([^'"]+)['"]/g)) {
    names.add(match[1]!)
  }
  for (const [pattern, params] of HELPER_PARAMS) {
    if (pattern.test(source)) for (const p of params) names.add(p)
  }
  // A route that gates its query with assertKnownQueryParams(ALLOWED_PARAMS)
  // accepts exactly that list: anything else is a 400 before a helper reads
  // it (the balance sheet refuses from_date although loadRangeFromQuery
  // would read one).
  const allowlist = source.match(/ALLOWED_PARAMS\s*=\s*\[([^\]]*)\]/)
  if (allowlist && /\bassertKnownQueryParams\(/.test(source)) {
    const allowed = new Set([...allowlist[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!))
    for (const n of [...names]) if (!allowed.has(n)) names.delete(n)
    for (const n of allowed) names.add(n)
  }
  for (const p of WRAPPER_PARAMS) names.delete(p)
  return names
}

describe('v1 query parameters are registered', () => {
  const byFile = new Map<string, EndpointDefinition[]>()
  for (const ep of listEndpoints()) {
    const file = routeFile(ep.path)
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file)!.push(ep)
  }

  it('every parameter a route reads is registered, and every registered parameter is read', () => {
    const problems: string[] = []
    for (const [file, endpoints] of byFile) {
      const read = paramsReadBy(readFileSync(file, 'utf8'))
      const registered = new Set(
        endpoints.flatMap((ep) => queryParameters(ep).map((p) => p.name)).filter((n) => !WRAPPER_PARAMS.has(n)),
      )
      const label = endpoints.map((ep) => `${ep.method} ${ep.path}`).join(', ')
      const missing = [...read].filter((n) => !registered.has(n))
      const phantom = [...registered].filter((n) => !read.has(n))
      if (missing.length > 0) problems.push(`${label}: reads but does not register ${missing.join(', ')}`)
      if (phantom.length > 0) problems.push(`${label}: registers but never reads ${phantom.join(', ')}`)
    }
    expect(problems).toEqual([])
  })

  it('advertises dry_run exactly on the dry-run-capable endpoints', () => {
    for (const ep of listEndpoints()) {
      const hasDryRun = queryParameters(ep).some((p) => p.name === 'dry_run')
      expect(hasDryRun, `${ep.method} ${ep.path}`).toBe(ep.dryRunSupported)
    }
  })
})
