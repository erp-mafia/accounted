import { describe, it, expect, vi, beforeEach } from 'vitest'

// Entitlement gate passes in these tests; the gate itself is covered by
// capability-gate.test.ts.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn() }
})

const { mockStartAuthorization, mockGetPreferredAuthMethod } = vi.hoisted(() => ({
  mockStartAuthorization: vi.fn(),
  mockGetPreferredAuthMethod: vi.fn(),
}))

vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return {
    ...actual,
    startAuthorization: (...args: unknown[]) => mockStartAuthorization(...args),
    getPreferredAuthMethod: (...args: unknown[]) => mockGetPreferredAuthMethod(...args),
  }
})

import { enableBankingExtension } from '../index'
import { requireCapability } from '@/lib/entitlements/has-capability'
import type { ExtensionContext } from '@/lib/extensions/types'

interface RecordedCall {
  method: string
  args: unknown[]
}

interface RecordedChain {
  _calls: RecordedCall[]
  [key: string]: unknown
}

function makeChain(result: { data?: unknown; error?: unknown }): RecordedChain {
  const calls: RecordedCall[] = []
  const chain: Record<string, unknown> = { _calls: calls }
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update', 'delete', 'insert']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push({ method: m, args })
      return chain
    })
  }
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.single = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null })
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? null, error: result.error ?? null })
  return chain as RecordedChain
}

function makeContext(fromImpl: (table: string) => unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
      },
      from: vi.fn(fromImpl),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
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

function connectRoute() {
  const route = enableBankingExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === '/connect',
  )
  expect(route, 'POST /connect must be registered').toBeDefined()
  return route!
}

function makeConnectRequest() {
  return new Request('https://test.local/api/extensions/ext/enable-banking/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aspsp_name: 'Nordea', aspsp_country: 'SE', psu_type: 'business' }),
  })
}

describe('POST /connect never-activated row cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    mockGetPreferredAuthMethod.mockResolvedValue(undefined)
    mockStartAuthorization.mockResolvedValue({
      url: 'https://bank.example/auth',
      authorization_id: 'auth-1',
    })
  })

  it('deletes stale pending and error zombies instead of parking them in error', async () => {
    const chains: RecordedChain[] = []
    let call = 0
    const ctx = makeContext(() => {
      call++
      let chain: RecordedChain
      if (call === 1) {
        // Latest pending row is stale (45s > 30s threshold): not a live attempt.
        chain = makeChain({
          data: { id: 'stale-1', created_at: new Date(Date.now() - 45_000).toISOString() },
        })
      } else if (call === 2) {
        // The sweep: returns the deleted never-activated rows.
        chain = makeChain({ data: [{ id: 'stale-1' }, { id: 'old-error' }] })
      } else {
        // Insert of the fresh connection row.
        chain = makeChain({ data: { id: 'new-conn' } })
      }
      chains.push(chain)
      return chain
    })

    const response = await connectRoute().handler(makeConnectRequest(), ctx)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { connection_id: string; authorization_url: string }
    expect(body.connection_id).toBe('new-conn')
    expect(body.authorization_url).toBe('https://bank.example/auth')

    // The sweep DELETEs never-activated rows: stale pendings and error rows
    // from failed attempts, guarded so established connections (session_id or
    // accounts_data present) are untouched.
    const sweep = chains[1]
    const methods = sweep._calls.map((c) => c.method)
    expect(methods).toContain('delete')
    const inCall = sweep._calls.find((c) => c.method === 'in')
    expect(inCall?.args).toEqual(['status', ['pending', 'error']])
    const isCalls = sweep._calls.filter((c) => c.method === 'is')
    expect(isCalls.map((c) => c.args)).toEqual(
      expect.arrayContaining([
        ['session_id', null],
        ['accounts_data', null],
      ]),
    )

    // Nothing gets parked as status='error' anymore: no update on any chain.
    for (const chain of chains) {
      expect(chain._calls.some((c) => c.method === 'update')).toBe(false)
    }
  })

  it('still rejects a duplicate connect while a recent pending attempt is live', async () => {
    const chains: RecordedChain[] = []
    const ctx = makeContext(() => {
      // Latest pending row is 5s old: the user is mid-redirect at the bank.
      const chain = makeChain({
        data: { id: 'live-1', created_at: new Date(Date.now() - 5_000).toISOString() },
      })
      chains.push(chain)
      return chain
    })

    const response = await connectRoute().handler(makeConnectRequest(), ctx)

    expect(response.status).toBe(409)
    // No sweep while an attempt is live: the live pending row must survive.
    for (const chain of chains) {
      expect(chain._calls.some((c) => c.method === 'delete')).toBe(false)
    }
    expect(mockStartAuthorization).not.toHaveBeenCalled()
  })

  it('sweeps error zombies even when no pending row exists', async () => {
    const chains: RecordedChain[] = []
    let call = 0
    const ctx = makeContext(() => {
      call++
      let chain: RecordedChain
      if (call === 1) {
        chain = makeChain({ data: null })
      } else if (call === 2) {
        chain = makeChain({ data: [{ id: 'old-error' }] })
      } else {
        chain = makeChain({ data: { id: 'new-conn' } })
      }
      chains.push(chain)
      return chain
    })

    const response = await connectRoute().handler(makeConnectRequest(), ctx)

    expect(response.status).toBe(200)
    const sweep = chains[1]
    expect(sweep._calls.some((c) => c.method === 'delete')).toBe(true)
  })
})
