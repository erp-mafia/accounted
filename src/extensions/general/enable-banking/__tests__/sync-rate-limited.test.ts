import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { StoredAccount } from '../types'

vi.mock('../lib/jwt', () => ({
  getAuthorizationHeader: () => 'Bearer test-token',
}))

vi.mock('../lib/sync', () => ({
  syncAccountTransactions: vi.fn(),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  requireCapability: vi.fn().mockResolvedValue(null),
}))

// The cooldown hold crosses companies (shared consent), so the handler takes
// a service-role client for it. Record what it writes and how it is scoped.
const serviceWrites: { payload: Record<string, unknown>; filters: Record<string, unknown> }[] = []
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(async () => ({
    from: () => {
      const write = { payload: {} as Record<string, unknown>, filters: {} as Record<string, unknown> }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      chain.update = (payload: Record<string, unknown>) => {
        write.payload = payload
        serviceWrites.push(write)
        return chain
      }
      chain.eq = (column: string, value: unknown) => {
        write.filters[column] = value
        return chain
      }
      chain.lt = () => chain
      chain.then = (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(onFulfilled)
      return chain
    },
  })),
}))

import { AspspUnavailableError, SessionExpiredError, REAUTH_REQUIRED_MESSAGE } from '../lib/api-client'
import { DAILY_QUOTA_COOLDOWN_MS } from '../lib/sync-lease'
import { SYNC_COOLDOWN_MS } from '@/lib/bank-sync/trigger-sync-contract'
import { enableBankingExtension } from '../index'
import { syncAccountTransactions } from '../lib/sync'

const syncRoute = enableBankingExtension.apiRoutes?.find(
  r => r.method === 'POST' && r.path === '/sync'
)
if (!syncRoute) {
  throw new Error('POST /sync route not registered on enable-banking extension')
}

function makeContext(connection: Record<string, unknown>, updateSpy: Mock): ExtensionContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq', 'gte', 'lt', 'limit', 'order']) chain[m] = vi.fn(() => chain)
  chain.single = vi.fn().mockResolvedValue({ data: connection, error: null })
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  chain.update = vi.fn((payload: unknown) => {
    updateSpy(payload)
    return chain
  })
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(onFulfilled)

  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'enable-banking',
    requestId: 'req_test',
    supabase: {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        updateSpy(name === 'persist_bank_sync_result'
          ? { p_completed_at: args.p_completed_at, p_accounts: args.p_accounts, p_session_id: args.p_session_id }
          : { p_status: args.p_status, p_message: args.p_message, p_session_id: args.p_session_id })
        return { data: name === 'persist_bank_sync_result' ? { applied: true } : true, error: null }
      }),
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null }) },
      from: vi.fn(() => chain),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
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
    bank_name: 'Svea Bank',
    status: 'active',
    session_id: 'sess-shared',
    last_synced_at: '2026-09-19T05:00:00.000Z',
    sync_lease_until: '1970-01-01T00:00:00.000Z',
    accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }] as StoredAccount[],
    ...overrides,
  }
}

const SVEA_BODY = '{"code":429,"message":"limit for SE4550000000058398257466","error":"ASPSP_RATE_LIMIT_EXCEEDED"}'
const sveaLimit = () =>
  new AspspUnavailableError(429, SVEA_BODY, 'rate-limited', '2026-05-23', { dailyQuota: true })

/** Writes other than the ordinary 15-minute lease hold the route always makes. */
const rowWrites = (updateSpy: Mock) =>
  updateSpy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((p) => !('sync_lease_until' in p))

describe('POST /sync (enable-banking): bank rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    serviceWrites.length = 0
  })

  it("answers Svea's 429 ASPSP_RATE_LIMIT_EXCEEDED as 429 BANK_RATE_LIMITED, not 500 or 503", async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(sveaLimit())
    const ctx = makeContext(makeConnection(), vi.fn())

    const before = Date.now()
    const res = await syncRoute.handler(makeRequest(), ctx)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body).toMatchObject({ code: 'BANK_RATE_LIMITED', retryable: true, connection_id: 'conn-1' })
    // Both languages, worded as "at the earliest", never as the bank's reset.
    expect(body.error).toMatch(/^Banken begränsar just nu .* Försök igen tidigast /)
    expect(body.error).toContain('Anslutningen behöver inte förnyas.')
    expect(body.error_en).toContain('at the earliest')
    expect(new Date(body.next_allowed_at).getTime()).toBeGreaterThanOrEqual(before + DAILY_QUOTA_COOLDOWN_MS)
    expect(body.retry_after_seconds).toBe(DAILY_QUOTA_COOLDOWN_MS / 1000)
    expect(res.headers.get('Retry-After')).toBe(String(body.retry_after_seconds))
  })

  it('keeps the connection as it is: no status flip, no error_message, no last_synced_at', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(sveaLimit())
    const updateSpy = vi.fn()
    const ctx = makeContext(makeConnection(), updateSpy)

    await syncRoute.handler(makeRequest(), ctx)

    expect(rowWrites(updateSpy)).toEqual([])
  })

  it('holds the cooldown on every connection of the shared consent, through the service-role client', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(sveaLimit())
    const ctx = makeContext(makeConnection(), vi.fn())

    const res = await syncRoute.handler(makeRequest(), ctx)
    const body = await res.json()

    expect(serviceWrites).toEqual([
      { payload: { sync_lease_until: body.next_allowed_at }, filters: { session_id: 'sess-shared' } },
    ])
  })

  it('records a rate_limited failure event with the provider code and timing, never the body', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(sveaLimit())
    const ctx = makeContext(makeConnection(), vi.fn())

    await syncRoute.handler(makeRequest(), ctx)

    expect(ctx.emit).toHaveBeenCalledTimes(1)
    const event = (ctx.emit as Mock).mock.calls[0][0]
    expect(event).toMatchObject({
      type: 'bank_connection.sync_failed',
      payload: {
        errorClass: 'rate_limited',
        trigger: 'manual',
        status: 'active',
        httpStatus: 429,
        ebCode: 'ASPSP_RATE_LIMIT_EXCEEDED',
        cooldownSeconds: DAILY_QUOTA_COOLDOWN_MS / 1000,
      },
    })
    expect(JSON.stringify(event)).not.toContain('SE45')
    expect(JSON.stringify((ctx.log.warn as Mock).mock.calls)).not.toContain('SE45')
  })

  it('is blocked by a held cooldown without calling the bank (also one a sibling company or the cron set)', async () => {
    const until = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    const updateSpy = vi.fn()
    const ctx = makeContext(makeConnection({ sync_lease_until: until }), updateSpy)

    const res = await syncRoute.handler(makeRequest(), ctx)
    const body = await res.json()

    expect(res.status).toBe(429)
    expect(body).toMatchObject({ code: 'BANK_RATE_LIMITED', next_allowed_at: until })
    expect(syncAccountTransactions).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(serviceWrites).toHaveLength(0)
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('is never blocked by the ordinary 15-minute lease of a recent cron or agent sync', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockResolvedValue({ imported: 1, duplicates: 0, errors: 0 })
    const ctx = makeContext(
      makeConnection({ sync_lease_until: new Date(Date.now() + SYNC_COOLDOWN_MS - 1000).toISOString() }),
      vi.fn()
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(syncAccountTransactions).toHaveBeenCalledTimes(1)
  })

  it('syncs normally once the cooldown has expired', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockResolvedValue({ imported: 3, duplicates: 0, errors: 0 })
    const updateSpy = vi.fn()
    const ctx = makeContext(
      makeConnection({ sync_lease_until: new Date(Date.now() - 1000).toISOString() }),
      updateSpy
    )

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ p_completed_at: expect.any(String) }))
  })

  it('an expired session still follows the reconnect flow', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(new SessionExpiredError(401, 'SESSION_EXPIRED'))
    const updateSpy = vi.fn()
    const ctx = makeContext(makeConnection(), updateSpy)

    const res = await syncRoute.handler(makeRequest(), ctx)
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body).toMatchObject({ code: 'SESSION_EXPIRED', reauth_required: true })
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ p_status: 'expired', p_message: REAUTH_REQUIRED_MESSAGE, p_session_id: 'sess-shared' }))
    expect(serviceWrites).toHaveLength(0)
  })

  it('a bank that is merely unavailable still answers 503 BANK_UNAVAILABLE', async () => {
    ;(syncAccountTransactions as unknown as Mock).mockRejectedValue(
      new AspspUnavailableError(400, '{"error":"ASPSP_ERROR"}', 'ladder-exhausted', '2026-08-01')
    )
    const ctx = makeContext(makeConnection(), vi.fn())

    const res = await syncRoute.handler(makeRequest(), ctx)

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'BANK_UNAVAILABLE' })
    expect(serviceWrites).toHaveLength(0)
  })
})
