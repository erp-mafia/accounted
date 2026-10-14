import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

// The /sync handler is driven without the network: the JWT signer and the
// sync orchestrator are stubbed, so the test can prove nothing was called.
vi.mock('../lib/jwt', () => ({ getAuthorizationHeader: () => 'Bearer test-token' }))
vi.mock('../lib/sync', () => ({ syncAccountTransactions: vi.fn() }))
vi.mock('../lib/sync-lease', async () => {
  const actual = await vi.importActual<typeof import('../lib/sync-lease')>('../lib/sync-lease')
  return { ...actual, holdSyncLease: vi.fn().mockResolvedValue(undefined), applyRateLimitCooldown: vi.fn().mockResolvedValue(null) }
})
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: vi.fn().mockResolvedValue({ brand: null, lookupFailed: false }),
}))

import { ENABLE_BANKING_SUNSET_MESSAGE } from '@/lib/bank-feed/switch-campaign'
import { PROVIDER_CREDENTIALS_REFUSED_MESSAGE, ProviderCredentialError } from '../lib/api-client'
import { enableBankingExtension } from '../index'
import { syncAccountTransactions } from '../lib/sync'
import { holdSyncLease } from '../lib/sync-lease'

const syncRoute = enableBankingExtension.apiRoutes!.find((r) => r.method === 'POST' && r.path === '/sync')!

function makeContext(connection: Record<string, unknown>, updateSpy: Mock): ExtensionContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const method of ['select', 'eq', 'neq', 'gte', 'limit', 'order', 'delete', 'in', 'is']) chain[method] = vi.fn(() => chain)
  chain.single = vi.fn().mockResolvedValue({ data: connection, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.update = vi.fn((payload: unknown) => {
    updateSpy(payload)
    return chain
  })
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      updateSpy({ rpc: name, ...args })
      return { data: name === 'persist_bank_sync_result' ? { applied: true } : true, error: null }
    }),
    from: vi.fn(() => chain),
  }
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: supabase as never,
    emit: vi.fn().mockResolvedValue(undefined),
    settings: { get: vi.fn(), set: vi.fn(), getAll: vi.fn() } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    services: {} as never,
  }
}

const request = () =>
  new Request('http://localhost/api/extensions/ext/enable-banking/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connection_id: 'conn-1' }),
  })

const activeRow = {
  id: 'conn-1',
  company_id: 'company-1',
  status: 'active',
  bank_name: 'Swedbank',
  session_id: 'sess-1',
  accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] as StoredAccount[],
}

describe('POST /sync (enable-banking): the Enable Banking sunset', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  it('answers 410 ENABLE_BANKING_SUNSET with the Swedish sentence and the switch link, without a provider call or a write', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2026-01-01')
    const updateSpy = vi.fn()

    const res = await syncRoute.handler(request(), makeContext(activeRow, updateSpy))

    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      error: ENABLE_BANKING_SUNSET_MESSAGE,
      code: 'ENABLE_BANKING_SUNSET',
      retryable: false,
      connection_id: 'conn-1',
      switch_url: '/settings/connections?bank_connect_switch=conn-1',
    })
    expect(syncAccountTransactions).not.toHaveBeenCalled()
    expect(holdSyncLease).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('syncs as before while the deadline is ahead', async () => {
    vi.stubEnv('OPENPAYMENTS_SWITCH_DEADLINE', '2099-01-01')
    ;(syncAccountTransactions as unknown as Mock).mockResolvedValue({ imported: 1, duplicates: 0, errors: 0 })

    const res = await syncRoute.handler(request(), makeContext(activeRow, vi.fn()))

    expect(res.status).toBe(200)
    expect(syncAccountTransactions).toHaveBeenCalledTimes(1)
  })

  it('answers a retryable 503 and leaves the row alone when Enable Banking refuses the application credentials', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(new ProviderCredentialError(401, '{"error":"Unauthorized"}'))
    const updateSpy = vi.fn()

    const res = await syncRoute.handler(request(), makeContext(activeRow, updateSpy))

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: PROVIDER_CREDENTIALS_REFUSED_MESSAGE,
      code: 'BANK_PROVIDER_UNAVAILABLE',
      retryable: true,
      connection_id: 'conn-1',
    })
    // No status flip, no error_message: the consent is not the problem.
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
