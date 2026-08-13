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
    // index.ts resolves the pinned auth method (with metadata for logging)
    // through the details variant; both point at one mock for simplicity.
    getPreferredAuthMethod: (...args: unknown[]) => mockGetPreferredAuthMethod(...args),
    getPreferredAuthMethodDetails: (...args: unknown[]) => mockGetPreferredAuthMethod(...args),
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

describe('POST /connect auth-method pinning wired into startAuthorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    mockStartAuthorization.mockResolvedValue({
      url: 'https://bank.example/auth',
      authorization_id: 'auth-1',
    })
  })

  // Fresh-connect from() sequence: recent-pending check, zombie sweep, insert.
  // Explicit psu_type in the body skips the companies entity_type lookup.
  function makeFreshConnectContext() {
    let call = 0
    return makeContext(() => {
      call++
      if (call === 1) return makeChain({ data: null })
      if (call === 2) return makeChain({ data: [] })
      return makeChain({ data: { id: 'new-conn' } })
    })
  }

  function makeHandelsbankenRequest() {
    return new Request('https://test.local/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aspsp_name: 'Handelsbanken', aspsp_country: 'SE', psu_type: 'business' }),
    })
  }

  it('forwards the pinned method name into the auth_method argument (Handelsbanken corporate regression)', async () => {
    // The documented real Handelsbanken shape: Mobile BankID is a hidden
    // DECOUPLED method carrying NO psu_types restriction.
    mockGetPreferredAuthMethod.mockResolvedValue({
      name: 'BANKID',
      approach: 'DECOUPLED',
      hidden_method: true,
      title: 'Bank ID',
    })

    const ctx = makeFreshConnectContext()
    const response = await connectRoute().handler(makeHandelsbankenRequest(), ctx)
    expect(response.status).toBe(200)

    expect(mockGetPreferredAuthMethod).toHaveBeenCalledWith('Handelsbanken', 'SE', 'business')

    // startAuthorization(aspspName, aspspCountry, redirectUrl, state, psuType,
    // authMethod): the pinned method's NAME must land in the auth_method
    // position (index 5). This binds selection to the outgoing request: the
    // selection tests alone cannot catch a route that resolves 'BANKID' and
    // then starts a default REDIRECT authorization anyway.
    expect(mockStartAuthorization).toHaveBeenCalledTimes(1)
    const args = mockStartAuthorization.mock.calls[0]
    expect(args[0]).toBe('Handelsbanken')
    expect(args[1]).toBe('SE')
    expect(args[4]).toBe('business')
    expect(args[5]).toBe('BANKID')

    // A pinned method without psu_types applies to all PSU types: the log must
    // say '(all)', never '(aspsp default)', which would contradict
    // auth_method='BANKID' on the same line.
    expect(ctx.log.info).toHaveBeenCalledWith(
      '[enable-banking] Starting bank connection',
      expect.objectContaining({
        auth_method: 'BANKID',
        auth_method_psu_types: '(all)',
      }),
    )
  })

  it('passes undefined auth_method when no method is pinned (ASPSP default flow)', async () => {
    mockGetPreferredAuthMethod.mockResolvedValue(undefined)

    const ctx = makeFreshConnectContext()
    const response = await connectRoute().handler(makeHandelsbankenRequest(), ctx)
    expect(response.status).toBe(200)

    expect(mockStartAuthorization).toHaveBeenCalledTimes(1)
    const args = mockStartAuthorization.mock.calls[0]
    expect(args[5]).toBeUndefined()

    // Only the unpinned case logs the '(aspsp default)' sentinel.
    expect(ctx.log.info).toHaveBeenCalledWith(
      '[enable-banking] Starting bank connection',
      expect.objectContaining({
        auth_method: '(aspsp default)',
        auth_method_psu_types: '(aspsp default)',
      }),
    )
  })

  it('forwards the pinned method name on the reconnect path too', async () => {
    mockGetPreferredAuthMethod.mockResolvedValue({
      name: 'BANKID',
      approach: 'DECOUPLED',
      hidden_method: true,
      title: 'Bank ID',
    })

    let call = 0
    const ctx = makeContext(() => {
      call++
      if (call === 1) {
        // The existing connection loaded up front: reconnect derives the bank
        // identity and psu_type from this row. session_id null skips the
        // sibling check + revoke.
        return makeChain({
          data: {
            id: 'conn-1',
            bank_name: 'Handelsbanken',
            provider: 'handelsbanken-se',
            session_id: null,
            psu_type: 'business',
          },
        })
      }
      // CSRF-state staging update and the authorization_id follow-up write.
      return makeChain({ data: null })
    })

    const req = new Request('https://test.local/api/extensions/ext/enable-banking/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection_id: 'conn-1' }),
    })

    const response = await connectRoute().handler(req, ctx)
    expect(response.status).toBe(200)

    // The reconnect branch calls startAuthorization from its own call site:
    // the pinned name must reach the auth_method position there as well.
    expect(mockStartAuthorization).toHaveBeenCalledTimes(1)
    const args = mockStartAuthorization.mock.calls[0]
    expect(args[0]).toBe('Handelsbanken')
    expect(args[1]).toBe('SE')
    expect(args[4]).toBe('business')
    expect(args[5]).toBe('BANKID')
  })
})
