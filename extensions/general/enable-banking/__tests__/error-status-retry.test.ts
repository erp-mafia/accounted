import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

// Mock the JWT signer so api-client can be imported without real
// ENABLE_BANKING credentials.
vi.mock('../lib/jwt', () => ({
  getAuthorizationHeader: () => 'Bearer test-token',
}))

// Mock the sync orchestrator so the /sync handler tests can force success or
// failure without hitting the network.
vi.mock('../lib/sync', () => ({
  syncAccountTransactions: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

import { SYNC_FAILED_MESSAGE } from '../lib/api-client'
import { enableBankingExtension } from '../index'
import { syncAccountTransactions } from '../lib/sync'

const syncRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/sync'
)

if (!syncRoute) {
  throw new Error('POST /sync route not registered on enable-banking extension')
}

const RAW_EB_ERROR =
  'Failed to get transactions (400): {"code":400,"message":"Error interacting with ASPSP","detail":null,"error":"ASPSP_ERROR"}'

function makeContext(connection: Record<string, unknown>, updateSpy: Mock): ExtensionContext {
  // One universal chainable per from() call (same shape as the other /sync
  // handler tests): bank_connections terminates on single(), sie_imports /
  // company_members on maybeSingle(), and update() records its payload while
  // returning the chain so trailing .eq() calls resolve.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq = vi.fn(() => chain)
  chain.gte = vi.fn(() => chain)
  chain.limit = vi.fn(() => chain)
  chain.order = vi.fn(() => chain)
  chain.single = vi.fn().mockResolvedValue({ data: connection, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.update = vi.fn((payload: unknown) => {
    updateSpy(payload)
    return chain
  })

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: vi.fn(() => chain),
  }

  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: supabase as any,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    storage: {} as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    services: {} as never,
  }
}

function makeRequest(): Request {
  return new Request('http://localhost/api/extensions/ext/enable-banking/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: 'conn-1' }),
  })
}

function makeConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    bank_name: 'SEB',
    accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] as StoredAccount[],
    ...overrides,
  }
}

describe('POST /sync (enable-banking): retry from error status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows sync from status=error and restores active + clears error_message on success', async () => {
    // Regression: a transient ASPSP failure parked the connection in 'error',
    // but the old status gate rejected everything but 'active', so the UI's
    // "Försök igen" button always got 400 and the connection was stranded
    // until a full re-auth.
    ;(syncAccountTransactions as unknown as Mock).mockResolvedValue({
      imported: 0,
      duplicates: 0,
      errors: 0,
    })

    const updateSpy = vi.fn()
    const ctx = makeContext(
      makeConnection({ status: 'error', error_message: RAW_EB_ERROR }),
      updateSpy
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        error_message: null,
        last_synced_at: expect.any(String),
      })
    )
  })

  it('still rejects expired connections with 400 (re-auth required, not retry)', async () => {
    const updateSpy = vi.fn()
    const ctx = makeContext(makeConnection({ status: 'expired' }), updateSpy)

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/not active/i)
    expect(syncAccountTransactions).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('does not touch status for an active connection but clears a leftover error_message', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockResolvedValue({
      imported: 0,
      duplicates: 0,
      errors: 0,
    })

    const updateSpy = vi.fn()
    const ctx = makeContext(
      makeConnection({ status: 'active', error_message: RAW_EB_ERROR }),
      updateSpy
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(200)
    const payload = updateSpy.mock.calls[0][0]
    expect(payload).not.toHaveProperty('status')
    expect(payload).toMatchObject({ error_message: null })
  })

  it('maps a non-session failure to the Swedish user message and refreshes the stored error_message', async () => {
    // The raw Enable Banking body is an English JSON envelope: it belongs in
    // server logs, never in the toast or the settings panel.
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(new Error(RAW_EB_ERROR))

    const updateSpy = vi.fn()
    const ctx = makeContext(
      makeConnection({ status: 'error', error_message: RAW_EB_ERROR }),
      updateSpy
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe(SYNC_FAILED_MESSAGE)
    expect(body.error).not.toContain('ASPSP_ERROR')
    expect(updateSpy).toHaveBeenCalledWith({ error_message: SYNC_FAILED_MESSAGE })
  })
})
