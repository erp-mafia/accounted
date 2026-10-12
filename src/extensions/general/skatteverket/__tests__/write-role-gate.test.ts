/**
 * Every route that acts at Skatteverket for the company (VAT utkast, lås,
 * submit; AGI underlag, spara, lås, granskningsunderlag; the ombud system
 * connection) refuses a viewer before anything reaches Skatteverket. These
 * effects land outside our database, so RLS (current_user_can_write) is no
 * backstop: the role check in the route is the only gate.
 *
 * The list is derived from the registered routes, not hand-kept, so a new
 * mutating /declaration, /agi or /system-connection route without the gate
 * fails here. EXEMPT names the read-only POSTs and why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn(async () => null) }
})

import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

const ROLE_REFUSAL = 'Otillräcklig behörighet för att lämna uppgifter till Skatteverket för det här företaget.'

/** Read-only POSTs: they validate against Skatteverket but file nothing. */
const EXEMPT = new Set(['POST /declaration/validate'])

const SKV_WRITE_PREFIXES = ['/declaration/', '/agi/', '/system-connection']

const gatedRoutes = (skatteverketExtension.apiRoutes ?? []).filter(
  (r) =>
    r.method !== 'GET' &&
    SKV_WRITE_PREFIXES.some((p) => r.path.startsWith(p)) &&
    !EXEMPT.has(`${r.method} ${r.path}`),
)

function makeContext(role: string): ExtensionContext {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'like', 'order', 'limit', 'gte', 'lte', 'insert', 'update', 'upsert', 'delete']) {
      chain[m] = vi.fn(self)
    }
    const result = table === 'company_members'
      ? { data: { role }, error: null }
      : { data: null, error: null }
    chain.single = vi.fn(async () => result)
    chain.maybeSingle = vi.fn(async () => result)
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
    return chain
  })
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: { from, rpc: vi.fn(async () => ({ data: null, error: null })) } as any,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function makeRequest(method: string, path: string): Request {
  const url = `https://test.local/api/extensions/ext/skatteverket${path}?arbetsgivare=165560000000&period=202609&inlamningId=1`
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ periodType: 'monthly', year: 2026, period: 9, salaryRunId: 'run-1', inlamningId: 1 }),
  })
}

const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchSpy)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skatteverket write-role gate', () => {
  it('covers the filing routes', () => {
    const keys = gatedRoutes.map((r) => `${r.method} ${r.path}`)
    for (const key of [
      'POST /declaration/submit',
      'POST /declaration/draft',
      'PUT /declaration/lock',
      'POST /agi/submit',
      'POST /agi/send-for-signing',
      'POST /agi/granskningsunderlag',
      'POST /agi/lasUpp',
    ]) {
      expect(keys).toContain(key)
    }
  })

  it.each(gatedRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s refuses a viewer with 403 before reaching Skatteverket',
    async (_key, route) => {
      const res = await route.handler(makeRequest(route.method, route.path), makeContext('viewer'))
      expect(res.status).toBe(403)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toBe(ROLE_REFUSAL)
      expect(fetchSpy).not.toHaveBeenCalled()
    },
  )

  it.each(gatedRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s lets a member past the role gate',
    async (_key, route) => {
      // Past the gate the stubbed context fails in route-specific ways
      // (no token, no service client); anything but the refusal passes.
      const res = await route
        .handler(makeRequest(route.method, route.path), makeContext('member'))
        .catch(() => null)
      const body = (res ? await res.json().catch(() => ({})) : {}) as { error?: string }
      expect(body.error).not.toBe(ROLE_REFUSAL)
    },
  )
})
