/**
 * A v1 route's scope is its own endpoint definition's. withApiV1 reads it
 * from the registry by the handler's operation id on every request, so there
 * is no second map to keep in step (V1_ENDPOINT_SCOPES and its parity test
 * are gone: the inbox-items stamp route shipped registered but unmapped and
 * answered 404 to valid keys, which is the drift a second copy invites).
 *
 * What still needs pinning: every route file is loaded by load-routes.ts (the
 * spec and these checks see only what it imports), and every handler a route
 * file exports has an endpoint for its operation id and method. A handler
 * without one fails closed (NOT_FOUND), which this catches before a caller.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getEndpointForOperation, listEndpoints } from '../registry'
// Side-effect import: populates the registry from every route file.
import '../load-routes'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const V1_APP_DIR = join(REPO_ROOT, 'app', 'api', 'v1')

/** The OpenAPI document is generated from the registry and serves itself unwrapped. */
const ROUTE_FILES_WITHOUT_ENDPOINT = new Set<string>(['app/api/v1/openapi.json/route.ts'])

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

const routeFiles = walkRouteFiles(V1_APP_DIR).map((full) => full.slice(REPO_ROOT.length).replace(/^\/+/, ''))

/** `export const POST = withApiV1<...>('invoices.create', ...)`: method and operation id. */
function wrappedHandlers(source: string): Array<{ method: string; operation: string }> {
  const out: Array<{ method: string; operation: string }> = []
  const re = /export const (GET|POST|PATCH|PUT|DELETE)\s*=\s*withApiV1\b[\s\S]*?\(\s*['"]([^'"]+)['"]/g
  for (const m of source.matchAll(re)) out.push({ method: m[1], operation: m[2] })
  return out
}

describe('v1 route scopes come from the endpoint definitions', () => {
  it('imports every app/api/v1 route file from load-routes.ts', () => {
    const loader = readFileSync(join(REPO_ROOT, 'lib', 'api', 'v1', 'load-routes.ts'), 'utf8')
    const notLoaded = routeFiles
      .filter((rel) => !ROUTE_FILES_WITHOUT_ENDPOINT.has(rel))
      .filter((rel) => !loader.includes(`'@/${rel.replace(/\.ts$/, '')}'`))
    expect(notLoaded).toEqual([])
  })

  it('has an endpoint, with a declared scope, behind every withApiV1 handler', () => {
    const problems: string[] = []
    let handlers = 0
    for (const rel of routeFiles) {
      for (const { method, operation } of wrappedHandlers(readFileSync(join(REPO_ROOT, rel), 'utf8'))) {
        handlers++
        const endpoint = getEndpointForOperation(operation, method)
        if (!endpoint) problems.push(`${rel}: ${method} ${operation} has no endpoint (answers NOT_FOUND)`)
        else if (endpoint.scope === undefined) problems.push(`${rel}: ${method} ${operation} declares no scope`)
      }
    }
    expect(problems).toEqual([])
    // The scan must see the hand-written routes, or it proves nothing.
    expect(handlers).toBeGreaterThan(100)
  })

  it('declares every endpoint scope explicitly, and only the health check is public', () => {
    const endpoints = listEndpoints()
    expect(endpoints.filter((e) => e.scope === undefined).map((e) => e.operation)).toEqual([])
    expect(endpoints.filter((e) => e.scope === null).map((e) => `${e.method} ${e.path}`)).toEqual(['GET /api/v1/health'])
    // The withdrawal takes no scope because ownership is its gate: only the
    // key that staged a pending operation can take it back
    // (lib/pending-operations/withdraw.ts).
    expect(
      endpoints
        .filter((e) => e.scope === 'authenticated')
        .map((e) => `${e.method} ${e.path}`)
        .sort(),
    ).toEqual(['GET /api/v1/api-key', 'POST /api/v1/companies/:companyId/pending-operations/:id/withdraw'])
  })

  it.each([
    ['companies.list', 'GET', 'companies:read'],
    ['customers.get', 'GET', 'customers:read'],
    ['customers.delete', 'DELETE', 'customers:write'],
    // Registered but once missing from the separate scope map: 404 with a valid key.
    ['inbox-items.stamp', 'POST', 'documents:write'],
    ['health.check', 'GET', null],
    ['api-key.get', 'GET', 'authenticated'],
  ] as const)('reads %s %s as %s', (operation, method, scope) => {
    expect(getEndpointForOperation(operation, method)?.scope).toBe(scope)
  })

  it('finds nothing for another method or an unknown operation', () => {
    expect(getEndpointForOperation('companies.list', 'DELETE')).toBeUndefined()
    expect(getEndpointForOperation('mystery.endpoint', 'GET')).toBeUndefined()
  })

  it('names each operation once per method', () => {
    const seen = new Map<string, number>()
    for (const e of listEndpoints()) seen.set(`${e.method} ${e.operation}`, (seen.get(`${e.method} ${e.operation}`) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1).map(([key]) => key)).toEqual([])
  })
})
