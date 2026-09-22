/**
 * Scope-map / registry parity guard.
 *
 * `withApiV1` resolves the required scope for a request from
 * `V1_ENDPOINT_SCOPES` (lib/auth/scopes.ts), NOT from the endpoint registry,
 * and answers NOT_FOUND when the map has no entry, before it even validates
 * the bearer token. So a route that registers itself but forgets the map
 * entry is live in the OpenAPI spec and the generated agent skill yet 404s
 * for every caller. That is exactly what happened to
 * POST .../inbox-items/{id}/stamp.
 *
 * This test pins the two sources to each other in both directions, checks
 * that every pattern points at a route file that exists, and that every v1
 * route file is imported by load-routes.ts (otherwise it is invisible to
 * this test and to the spec).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { V1_ENDPOINT_SCOPES, V1_PUBLIC_ENDPOINTS } from '@/lib/auth/scopes'
import { listEndpoints } from '../registry'
// Side-effect import: populates the ENDPOINTS registry from every route file.
import '../load-routes'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const V1_APP_DIR = join(REPO_ROOT, 'app', 'api', 'v1')

/**
 * Public endpoints that legitimately have no registry entry. The OpenAPI
 * document is generated FROM the registry, so it cannot register itself.
 */
const PUBLIC_WITHOUT_REGISTRY_ENTRY = new Set<string>(['GET /api/v1/openapi.json'])

/**
 * Route files under app/api/v1 that are not part of the registry. Same
 * exception as above, in file form.
 */
const ROUTE_FILES_WITHOUT_REGISTRY_ENTRY = new Set<string>(['app/api/v1/openapi.json/route.ts'])

function endpointKey(e: { method: string; path: string }): string {
  return `${e.method} ${e.path}`
}

/** `POST /api/v1/companies/:companyId/x/:id` to `app/api/v1/companies/[companyId]/x/[id]/route.ts`. */
function routeFileFor(pattern: string): string {
  const path = pattern.split(' ', 2)[1]
  return join('app', path.replace(/:([^/]+)/g, '[$1]'), 'route.ts')
}

function walkRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walkRouteFiles(full))
    else if (name === 'route.ts') out.push(full)
  }
  return out
}

const registered = listEndpoints()
const registeredByKey = new Map(registered.map((e) => [endpointKey(e), e]))

describe('V1_ENDPOINT_SCOPES <-> endpoint registry parity', () => {
  it('has a scope-map entry, with the same scope, for every registered non-public endpoint', () => {
    const problems = registered
      .filter((e) => e.scope !== null)
      .flatMap((e) => {
        const key = endpointKey(e)
        const mapped = V1_ENDPOINT_SCOPES[key]
        if (mapped === undefined) return [`${key}: registered with scope ${e.scope} but missing from V1_ENDPOINT_SCOPES (the wrapper answers 404)`]
        if (mapped !== e.scope) return [`${key}: registry says ${e.scope}, V1_ENDPOINT_SCOPES says ${mapped}`]
        return []
      })
    expect(problems).toEqual([])
  })

  it('lists every registered public (scope: null) endpoint in V1_PUBLIC_ENDPOINTS', () => {
    const problems = registered
      .filter((e) => e.scope === null)
      .map(endpointKey)
      .filter((key) => !V1_PUBLIC_ENDPOINTS.includes(key))
    expect(problems).toEqual([])
  })

  it('has a registered endpoint behind every V1_ENDPOINT_SCOPES entry', () => {
    const phantoms = Object.keys(V1_ENDPOINT_SCOPES).filter((key) => !registeredByKey.has(key))
    expect(phantoms).toEqual([])
  })

  it('has a registered public endpoint (or a documented exception) behind every V1_PUBLIC_ENDPOINTS entry', () => {
    const problems = V1_PUBLIC_ENDPOINTS.flatMap((key) => {
      if (PUBLIC_WITHOUT_REGISTRY_ENTRY.has(key)) return []
      const def = registeredByKey.get(key)
      if (!def) return [`${key}: in V1_PUBLIC_ENDPOINTS but not registered`]
      if (def.scope !== null) return [`${key}: in V1_PUBLIC_ENDPOINTS but registered with scope ${def.scope}`]
      return []
    })
    expect(problems).toEqual([])
  })

  it('points every scope-map and public pattern at a route file that exists', () => {
    const patterns = [...Object.keys(V1_ENDPOINT_SCOPES), ...V1_PUBLIC_ENDPOINTS]
    const missing = patterns.filter((key) => !existsSync(join(REPO_ROOT, routeFileFor(key))))
    expect(missing).toEqual([])
  })

  it('imports every app/api/v1 route file from load-routes.ts', () => {
    const loader = readFileSync(join(REPO_ROOT, 'lib', 'api', 'v1', 'load-routes.ts'), 'utf8')
    const notLoaded = walkRouteFiles(V1_APP_DIR)
      .map((full) => full.slice(REPO_ROOT.length).replace(/^\/+/, ''))
      .filter((rel) => !ROUTE_FILES_WITHOUT_REGISTRY_ENTRY.has(rel))
      .filter((rel) => !loader.includes(`'@/${rel.replace(/\.ts$/, '')}'`))
    expect(notLoaded).toEqual([])
  })
})
