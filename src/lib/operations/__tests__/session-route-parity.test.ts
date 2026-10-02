/**
 * Ratchet for "everything you can do in the product is doable via the API".
 *
 * Every dashboard (session-cookie) write route must have an entry in
 * SESSION_ROUTE_PARITY, every entry must still point at a real route, every
 * `by` reference must name a real public door, and the number of gaps must
 * equal GAP_CEILING exactly.
 */
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { V1_ENDPOINT_SCOPES } from '@/lib/auth/scopes'
import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { FIRST_PARTY_EXTENSIONS } from '@/lib/extensions/_generated/extension-list'
import { GAP_CEILING, SESSION_ROUTE_PARITY } from '../session-route-parity'

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
const API_ROOT = path.resolve(__dirname, '../../../app/api')
const V1_ROOT = path.join(API_ROOT, 'v1')
const EXT_PREFIX = '/api/extensions/ext/'
/** The extension dispatcher; its routes are enumerated from the extensions. */
const EXT_DISPATCHER_DIR = path.join(API_ROOT, 'extensions', 'ext', '[...path]')

/** Next.js directory segments to a manifest path: [id] -> :id, [...p] -> :p*, (group) dropped. */
function toRoutePath(dir: string): string {
  const rel = path.relative(API_ROOT, dir)
  const segments = rel
    .split(path.sep)
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s))
    .map((s) =>
      s
        .replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*')
        .replace(/^\[\.\.\.(.+)\]$/, ':$1*')
        .replace(/^\[(.+)\]$/, ':$1'),
    )
  return '/api' + (segments.length > 0 ? '/' + segments.join('/') : '')
}

/**
 * Write methods a route module exports. Handles every export shape used for
 * route handlers:
 *   export const POST = ...            export async function POST(...)
 *   export function POST(...)          export const { POST, PUT } = ...
 *   export { POST } from '...'         export { handler as POST, PUT }
 */
function exportedWriteMethods(source: string): string[] {
  const found = new Set<string>()
  for (const method of WRITE_METHODS) {
    const direct = new RegExp(`^\\s*export\\s+(?:const|let|var|(?:async\\s+)?function)\\s+${method}\\b`, 'm')
    if (direct.test(source)) found.add(method)
  }
  const braceExports = /^\s*export\s+(?:const|let|var)?\s*\{([^}]*)\}/gm
  for (const match of source.matchAll(braceExports)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.split(':').pop()?.trim()
      if (name && (WRITE_METHODS as readonly string[]).includes(name)) found.add(name)
    }
  }
  return [...found]
}

function walkRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (full === V1_ROOT || full === EXT_DISPATCHER_DIR) continue
      walkRouteFiles(full, out)
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      out.push(full)
    }
  }
  return out
}

function sessionFileRouteKeys(): string[] {
  const keys: string[] = []
  for (const file of walkRouteFiles(API_ROOT)) {
    const routePath = toRoutePath(path.dirname(file))
    for (const method of exportedWriteMethods(readFileSync(file, 'utf8'))) {
      keys.push(`${method} ${routePath}`)
    }
  }
  return keys
}

/** Extension routes as served by the dispatcher, for the extensions this build loads. */
function extensionRouteKeys(): string[] {
  const keys: string[] = []
  for (const extension of FIRST_PARTY_EXTENSIONS) {
    for (const route of extension.apiRoutes ?? []) {
      if (!(WRITE_METHODS as readonly string[]).includes(route.method)) continue
      keys.push(`${route.method} ${EXT_PREFIX}${extension.id}${route.path}`)
    }
  }
  return keys
}

function extensionIdOf(key: string): string | null {
  const routePath = key.slice(key.indexOf(' ') + 1)
  if (!routePath.startsWith(EXT_PREFIX)) return null
  return routePath.slice(EXT_PREFIX.length).split('/')[0] ?? null
}

describe('session route parity manifest', () => {
  const fileKeys = sessionFileRouteKeys()
  const extKeys = extensionRouteKeys()
  const liveKeys = new Set([...fileKeys, ...extKeys])
  const loadedExtensionIds = new Set(FIRST_PARTY_EXTENSIONS.map((e) => e.id))
  const manifestKeys = Object.keys(SESSION_ROUTE_PARITY)

  it('finds session write routes on disk (walker sanity check)', () => {
    expect(fileKeys.length).toBeGreaterThan(100)
    expect(fileKeys).toContain('POST /api/supplier-invoices/:id/approve')
  })

  it('parses every handler export shape', () => {
    expect(exportedWriteMethods('export const POST = withRouteContext(')).toEqual(['POST'])
    expect(exportedWriteMethods('export async function DELETE(req: Request) {')).toEqual(['DELETE'])
    expect(exportedWriteMethods("export { PUT } from './other'")).toEqual(['PUT'])
    expect(exportedWriteMethods('export { handler as PATCH, GET }')).toEqual(['PATCH'])
    expect(exportedWriteMethods('export const { POST, GET } = handlers').sort()).toEqual(['POST'])
    expect(exportedWriteMethods('export const GET = x\nconst POST = y')).toEqual([])
  })

  it('has an API decision for every dashboard write route', () => {
    const missing = [...liveKeys].filter((key) => !(key in SESSION_ROUTE_PARITY)).sort()
    expect(
      missing,
      'New dashboard write with no API decision: add it to SESSION_ROUTE_PARITY ' +
        '(src/lib/operations/session-route-parity.ts) as covered, gap, ui-only or machine.',
    ).toEqual([])
  })

  it('has no stale entries', () => {
    const stale = manifestKeys
      .filter((key) => !liveKeys.has(key))
      // An extension this build does not load (e.g. CI's zero-extension core
      // build) cannot prove its routes stale.
      .filter((key) => {
        const extId = extensionIdOf(key)
        return extId === null || loadedExtensionIds.has(extId)
      })
      .sort()
    expect(stale, 'SESSION_ROUTE_PARITY entries with no route behind them: delete them.').toEqual([])
  })

  it('points every covered entry at a real public door', () => {
    const doors = new Set([...Object.keys(V1_ENDPOINT_SCOPES), ...Object.keys(TOOL_SCOPE_MAP)])
    const unknown: string[] = []
    const empty: string[] = []
    for (const [key, entry] of Object.entries(SESSION_ROUTE_PARITY)) {
      if (entry.status !== 'covered') continue
      if (entry.by.length === 0) empty.push(key)
      for (const door of entry.by) {
        if (!doors.has(door)) unknown.push(`${key} -> ${door}`)
      }
    }
    expect(empty, 'covered entries need at least one `by` door').toEqual([])
    expect(unknown, '`by` must name a V1_ENDPOINT_SCOPES key or a TOOL_SCOPE_MAP tool').toEqual([])
  })

  it('gives every ui-only and machine entry a reason', () => {
    const bare = Object.entries(SESSION_ROUTE_PARITY)
      .filter(([, e]) => (e.status === 'ui-only' || e.status === 'machine') && e.reason.trim() === '')
      .map(([key]) => key)
    expect(bare).toEqual([])
  })

  it('keeps the gap count at GAP_CEILING exactly', () => {
    const gaps = Object.values(SESSION_ROUTE_PARITY).filter((e) => e.status === 'gap').length
    expect(
      gaps,
      gaps < GAP_CEILING
        ? `Gap closed: lower GAP_CEILING from ${GAP_CEILING} to ${gaps}.`
        : `New gap(s): ${gaps} gaps but GAP_CEILING is ${GAP_CEILING}. Prefer adding the API door; ` +
            'if the gap is deliberate, raise GAP_CEILING in the same diff so review sees it.',
    ).toBe(GAP_CEILING)
  })
})
