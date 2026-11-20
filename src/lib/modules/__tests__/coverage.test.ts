/**
 * Every operation and every v1 endpoint belongs to exactly one module, and
 * the OpenAPI document says which. A new operation with an unclaimed id
 * prefix, or a v1 route under an unclaimed path segment, fails here until
 * lib/modules/manifest.ts names its module.
 */
import { describe, expect, it } from 'vitest'
import { ALL_OPERATIONS, OPERATIONS } from '@/lib/operations/registry'
import { endpointModule, generateOpenApiSpec, listEndpoints } from '@/lib/api/v1/registry'
// Side-effect import: every v1 route file registers its endpoint.
import '@/lib/api/v1/load-routes'
import { MODULES } from '../manifest'
import { getModule, moduleForOperationId, moduleForV1Path } from '../resolve'

describe('operations', () => {
  it('reach every served operation through ALL_OPERATIONS (dark ones included)', () => {
    const all = new Set(ALL_OPERATIONS.map((op) => op.id))
    expect(OPERATIONS.filter((op) => !all.has(op.id)).map((op) => op.id)).toEqual([])
  })

  it('resolve to a module by their id prefix', () => {
    const unresolved = ALL_OPERATIONS.filter((op) => !moduleForOperationId(op.id)).map((op) => op.id)
    expect(
      unresolved,
      'add the prefix before the first dot to a module operationPrefixes in lib/modules/manifest.ts',
    ).toEqual([])
  })

  it('live under a v1 path owned by the same module as their id', () => {
    const mismatches = ALL_OPERATIONS.filter((op) => op.http)
      .map((op) => ({ id: op.id, path: op.http!.path, byId: moduleForOperationId(op.id), byPath: moduleForV1Path(op.http!.path) }))
      .filter((r) => r.byId !== r.byPath)
      .map((r) => `${r.id} (${r.byId}) at ${r.path} (${r.byPath})`)
    expect(mismatches).toEqual([])
  })
})

describe('v1 endpoints', () => {
  const endpoints = listEndpoints()

  it('are registered (the route loader ran)', () => {
    expect(endpoints.length).toBeGreaterThan(100)
  })

  it('each resolve to a module', () => {
    const unresolved = endpoints.filter((e) => !endpointModule(e)).map((e) => `${e.method} ${e.path}`)
    expect(
      unresolved,
      'claim the path segment in a module v1Segments in lib/modules/manifest.ts',
    ).toEqual([])
  })

  it('carry their operation module when operation-backed, and that module also owns the path', () => {
    const backed = endpoints.filter((e) => e.module)
    expect(backed.length).toBeGreaterThan(0)
    for (const e of backed) {
      expect(e.module, `${e.method} ${e.path}`).toBe(moduleForOperationId(e.operation))
      expect(moduleForV1Path(e.path), `${e.method} ${e.path}`).toBe(e.module)
    }
  })
})

describe('OpenAPI module tags', () => {
  const spec = generateOpenApiSpec('https://unit.test')
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op: op as Record<string, unknown> })),
  )

  it('tags every operation with exactly one module, mirrored in x-module', () => {
    expect(operations.length).toBe(listEndpoints().length)
    for (const { key, op } of operations) {
      const tags = op.tags as string[] | undefined
      expect(tags, key).toHaveLength(1)
      const mod = getModule(tags![0])
      expect(mod, `${key}: ${tags![0]}`).toBeDefined()
      expect(op['x-module'], key).toBe(mod!.id)
      expect(op['x-jurisdictions'], key).toBeUndefined()
    }
  })

  it('declares each used module once as a top-level experimental tag, in manifest order, with its summary and display name', () => {
    const used = new Set(operations.map(({ op }) => (op.tags as string[])[0]))
    expect(spec.tags.map((t) => t.name)).toEqual(MODULES.filter((m) => used.has(m.id)).map((m) => m.id))
    for (const tag of spec.tags) {
      const mod = getModule(tag.name)!
      expect(tag.description).toBe(mod.summary)
      expect(tag['x-display-name']).toBe(mod.name)
      expect(tag['x-experimental']).toBe(true)
    }
  })

  it('tags a generated and a hand-written endpoint as their module', () => {
    const op = (path: string, method: string) => (spec.paths[path] as Record<string, Record<string, unknown>>)[method]
    // Generated from the arsredovisning.* operations, under a ledger path segment.
    expect(op('/api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/narrative', 'post').tags).toEqual(['year-end'])
    // Hand-written routes resolve by path.
    expect(op('/api/v1/companies/{companyId}/fiscal-periods/{id}/arsredovisning/pdf', 'get').tags).toEqual(['year-end'])
    expect(op('/api/v1/companies/{companyId}/invoices', 'get').tags).toEqual(['invoicing'])
    expect(op('/api/v1/health', 'get').tags).toEqual(['platform'])
    expect(op('/api/v1/companies/{companyId}/salary-runs', 'get').tags).toEqual(['payroll'])
  })
})
