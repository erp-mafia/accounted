/**
 * The guard behind "off closes the start paths only": every write door of a
 * switchable package (dashboard routes, extension routes, v1 endpoints,
 * operations and the pending types approvals commit) is classified as start
 * or continue in lib/modules/package-doors.ts, every start door is reached
 * by a gate, and no continue door is caught by one. The MCP server's own
 * tools are checked in src/extensions/general/mcp-server/__tests__/
 * package-doors.test.ts.
 */
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { listEndpoints } from '@/lib/api/v1/registry'
import '@/lib/api/v1/load-routes'
import { ALL_OPERATIONS } from '@/lib/operations/registry'
import { SESSION_ROUTE_PARITY } from '@/lib/operations/session-route-parity'
import { PENDING_OPERATION_TYPES } from '@/lib/pending-operations/risk-tiers'
import { moduleForOperationId, moduleForV1Path } from '../resolve'
import { PACKAGES, packageForModule } from '../packages'
import {
  EXTENSION_PACKAGES,
  PACKAGE_DOORS,
  packageForSessionRoute,
  packagesWithStartDoors,
  SESSION_SEGMENT_PACKAGES,
  startPackageForKey,
  startPackageForPendingType,
  startPackageForSessionRequest,
  startPackageForV1Endpoint,
} from '../package-doors'

const API_ROOT = path.resolve(__dirname, '../../../app/api')
const ROUTE_KEY = /^(POST|PUT|PATCH|DELETE) \/api\//
const EXT_PREFIX = '/api/extensions/ext/'

const entries = Object.entries(PACKAGE_DOORS).flatMap(([pkg, doors]) => [
  ...doors.start.map((key) => ({ pkg, key, kind: 'start' as const })),
  ...doors.continue.map((key) => ({ pkg, key, kind: 'continue' as const })),
])
const classified = new Map(entries.map((e) => [e.key, e]))
const isV1Key = (key: string) => ROUTE_KEY.test(key) && key.includes(' /api/v1/')
const isSessionKey = (key: string) => ROUTE_KEY.test(key) && !key.includes(' /api/v1/')

/** Dashboard write routes that are user doors (machine endpoints are not). */
const sessionDoors = Object.entries(SESSION_ROUTE_PARITY)
  .filter(([, entry]) => entry.status !== 'machine')
  .map(([key]) => key)

/** A concrete request path for a route key: every :param becomes a sample value. */
function concrete(key: string): { method: string; pathname: string } {
  const [method, pattern] = key.split(' ')
  return { method, pathname: pattern.replace(/:[A-Za-z_]+\*?/g, 'sample-0001') }
}

/** Route files by their route key path (/api/invoices/:id/convert), as the parity test derives them. */
function routeFiles(dir = API_ROOT, out = new Map<string, string>()): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'v1' && dir === API_ROOT) continue
      routeFiles(full, out)
    } else if (entry.name === 'route.ts') {
      const rel = path.relative(API_ROOT, path.dirname(full))
      const segments = rel
        .split(path.sep)
        .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
        .map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1'))
      out.set('/api/' + segments.join('/'), full)
    }
  }
  return out
}

describe('package door classification', () => {
  it('classifies every door once, with a well-formed key', () => {
    const seen = new Map<string, number>()
    for (const e of entries) seen.set(e.key, (seen.get(e.key) ?? 0) + 1)
    expect([...seen].filter(([, n]) => n > 1).map(([key]) => key)).toEqual([])
    const malformed = entries
      .map((e) => e.key)
      .filter((key) => !ROUTE_KEY.test(key) && !/^(op|mcp|pending):[a-z0-9_.-]+$/.test(key))
    expect(malformed).toEqual([])
  })

  it('names a start door for every switchable package and only for those', () => {
    const switchable = PACKAGES.filter((p) => p.switchable).map((p) => p.id).sort()
    expect(Object.keys(PACKAGE_DOORS).sort()).toEqual(switchable)
    expect(packagesWithStartDoors().sort()).toEqual(switchable)
  })

  it('places every dashboard route segment and every extension, so a new one is decided before it ships', () => {
    const unplaced = sessionDoors.filter((key) => {
      const routePath = key.slice(key.indexOf(' ') + 1)
      if (routePath.startsWith(EXT_PREFIX)) {
        return !Object.hasOwn(EXTENSION_PACKAGES, routePath.slice(EXT_PREFIX.length).split('/')[0])
      }
      return !Object.hasOwn(SESSION_SEGMENT_PACKAGES, routePath.split('/')[2])
    })
    expect(
      unplaced,
      'A dashboard route under a new /api/<segment> or a new extension: place it in SESSION_SEGMENT_PACKAGES or EXTENSION_PACKAGES (lib/modules/package-doors.ts).',
    ).toEqual([])
  })

  it('classifies every dashboard write route of a switchable package as start or continue', () => {
    const missing = sessionDoors.filter((key) => packageForSessionRoute(key) !== null && !classified.has(key))
    expect(
      missing,
      'A write route of a switchable package with no decision: add it to PACKAGE_DOORS as start (refused while the package is off) or continue.',
    ).toEqual([])
  })

  it('classifies every v1 write endpoint of a switchable package, an operation door by its operation', () => {
    const operationIds = new Set(ALL_OPERATIONS.map((op) => op.id))
    const missing: string[] = []
    for (const endpoint of listEndpoints()) {
      if (endpoint.method === 'GET') continue
      const moduleId = endpoint.module ?? moduleForV1Path(endpoint.path)
      const pkg = moduleId ? packageForModule(moduleId) : null
      if (!pkg || pkg === 'bookkeeping') continue
      const key = operationIds.has(endpoint.operation) ? `op:${endpoint.operation}` : `${endpoint.method} ${endpoint.path}`
      if (!classified.has(key)) missing.push(key)
    }
    expect(missing).toEqual([])
  })

  it('classifies every write operation of a switchable package', () => {
    const missing = ALL_OPERATIONS.filter((op) => {
      if (op.kind !== 'write') return false
      const moduleId = moduleForOperationId(op.id)
      const pkg = moduleId ? packageForModule(moduleId) : null
      return pkg !== null && pkg !== 'bookkeeping' && !classified.has(`op:${op.id}`)
    }).map((op) => op.id)
    expect(missing).toEqual([])
  })

  it('has no stale entry: every key names a live door', () => {
    const sessionKeys = new Set(sessionDoors)
    const v1Keys = new Set(listEndpoints().map((e) => `${e.method} ${e.path}`))
    const operationIds = new Set(ALL_OPERATIONS.map((op) => op.id))
    const pendingTypes = new Set<string>(PENDING_OPERATION_TYPES)
    const stale = entries
      .map((e) => e.key)
      .filter((key) => {
        if (isSessionKey(key)) return !sessionKeys.has(key)
        if (isV1Key(key)) return !v1Keys.has(key)
        if (key.startsWith('op:')) return !operationIds.has(key.slice(3))
        if (key.startsWith('pending:')) return !pendingTypes.has(key.slice(8))
        return false // mcp: checked by the MCP server's own test
      })
    expect(stale).toEqual([])
  })
})

describe('package start gates reach every start door', () => {
  it('serves every start dashboard route through withRouteContext or the extension dispatcher', () => {
    const files = routeFiles()
    const ungated: string[] = []
    for (const e of entries) {
      if (e.kind !== 'start' || !isSessionKey(e.key)) continue
      const routePath = e.key.slice(e.key.indexOf(' ') + 1)
      if (routePath.startsWith(EXT_PREFIX)) continue // the dispatcher gates by the route key
      const file = files.get(routePath)
      const method = e.key.split(' ')[0]
      const wrapped = new RegExp(`export const ${method} = withRouteContext\\b`)
      if (!file || !wrapped.test(readFileSync(file, 'utf8'))) ungated.push(e.key)
    }
    expect(ungated, 'a start route outside withRouteContext would skip the gate').toEqual([])
  })

  it('matches each start route by its concrete path, and no continue route at all', () => {
    for (const e of entries) {
      if (!isSessionKey(e.key)) continue
      const { method, pathname } = concrete(e.key)
      const expected = e.kind === 'start' ? e.pkg : null
      expect(startPackageForSessionRequest(method, pathname), e.key).toBe(expected)
    }
    // Every other dashboard route too (Bokföring's, the platform's).
    for (const key of sessionDoors) {
      if (classified.get(key)?.kind === 'start') continue
      const { method, pathname } = concrete(key)
      expect(startPackageForSessionRequest(method, pathname), key).toBeNull()
    }
  })

  it('reaches every start v1 endpoint and operation through the endpoint the v1 wrapper gates', () => {
    for (const endpoint of listEndpoints()) {
      if (endpoint.method === 'GET') continue
      const viaOp = startPackageForKey(`op:${endpoint.operation}`)
      const viaPath = startPackageForKey(`${endpoint.method} ${endpoint.path}`)
      expect(startPackageForV1Endpoint(endpoint), `${endpoint.method} ${endpoint.path}`).toBe(viaOp ?? viaPath)
    }
    // A start operation with a v1 binding is registered, so withApiV1 sees it.
    const registered = new Set(listEndpoints().map((e) => e.operation))
    for (const op of ALL_OPERATIONS) {
      if (startPackageForKey(`op:${op.id}`) && op.http) expect(registered.has(op.id), op.id).toBe(true)
    }
  })

  it('refuses at approval every pending type a start operation stages, and no other operation type', () => {
    for (const op of ALL_OPERATIONS) {
      const pendingType = op.mcp?.stage?.pendingType
      if (!pendingType) continue
      const expected = startPackageForKey(`op:${op.id}`)
      expect(startPackageForPendingType(pendingType, op.id), op.id).toBe(expected)
    }
  })

  it('never gates Bokföring, the platform or the switch itself', () => {
    for (const key of [
      'POST /api/bookkeeping/journal-entries',
      'POST /api/transactions/:id/categorize',
      'POST /api/pending-operations/:id/commit',
      'POST /api/documents',
    ]) {
      const { method, pathname } = concrete(key)
      expect(startPackageForSessionRequest(method, pathname), key).toBeNull()
    }
    expect(startPackageForPendingType('enable_package')).toBeNull()
    expect(startPackageForPendingType('disable_package')).toBeNull()
    expect(startPackageForPendingType('create_voucher')).toBeNull()
  })
})
