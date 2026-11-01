/**
 * Tests for the nightly Stripe balance-transaction sync cron, now run by the
 * shared runWebshopOrderCron: auth, the extension gate, config short-circuit,
 * candidates ordered by the feed cursor, capability gating that does not
 * starve the entitled rows, and isolated per-connection failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logMock = vi.hoisted(() => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  log.child.mockImplementation(() => log)
  return log
})
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const verifyCronSecret = vi.fn<(request: Request) => Response | null>(() => null)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (request: Request) => verifyCronSecret(request),
}))

const registryGet = vi.fn()
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => registryGet(...args) },
}))

// The candidate query chain ends in .range(); each call is one page.
const orderCalls: unknown[][] = []
const rangeResult = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: (...args: unknown[]) => {
              orderCalls.push(args)
              return { range: (...rangeArgs: unknown[]) => rangeResult(...rangeArgs) }
            },
          }),
        }),
      }),
    }),
  })),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: vi.fn(),
}))

vi.mock('@/extensions/general/stripe/lib/transaction-sync', () => ({
  syncStripeBalanceTransactions: vi.fn(),
}))

import { hasCapability } from '@/lib/entitlements/has-capability'
import { syncStripeBalanceTransactions } from '@/extensions/general/stripe/lib/transaction-sync'
import { GET } from '../route'
import { createCronRequest } from '@/tests/helpers'

function makeConnection(id: string, companyId: string) {
  return {
    id,
    company_id: companyId,
    user_id: 'user-1',
    stripe_account_id: `acct_${id}`,
    status: 'active',
    transaction_sync_enabled: true,
    last_balance_txn_synced_at: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  orderCalls.length = 0
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockReturnValue({ id: 'stripe' })
  rangeResult.mockResolvedValue({ data: [], error: null })
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
  vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_123')
  vi.mocked(hasCapability).mockResolvedValue(true)
  vi.mocked(syncStripeBalanceTransactions).mockResolvedValue({
    fetched: 3,
    imported: 2,
    duplicates: 1,
    errors: 0,
    foreignCurrency: 0,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/extensions/stripe/transactions/cron', () => {
  it('rejects requests without a valid cron secret', async () => {
    verifyCronSecret.mockReturnValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))

    expect(response.status).toBe(401)
    expect(vi.mocked(syncStripeBalanceTransactions)).not.toHaveBeenCalled()
  })

  it('answers 200 skipped when the extension is not enabled', async () => {
    registryGet.mockReturnValue(undefined)

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ skipped: true, reason: 'extension_disabled', processed: 0 })
    expect(rangeResult).not.toHaveBeenCalled()
  })

  it('no-ops when Stripe Connect is not configured', async () => {
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', '')

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toEqual({ message: 'Stripe Connect not configured', processed: 0 })
  })

  it('no-ops when no connection has transaction sync enabled', async () => {
    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    const json = await response.json()

    expect(json.processed).toBe(0)
    expect(vi.mocked(syncStripeBalanceTransactions)).not.toHaveBeenCalled()
  })

  it('orders the candidates by the feed cursor, oldest first', async () => {
    rangeResult.mockResolvedValueOnce({ data: [makeConnection('conn-1', 'company-1')], error: null })

    await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))

    expect(orderCalls[0]).toEqual(['last_balance_txn_synced_at', { ascending: true, nullsFirst: true }])
  })

  it('syncs entitled connections and counts imported rows', async () => {
    rangeResult.mockResolvedValueOnce({
      data: [makeConnection('conn-1', 'company-1'), makeConnection('conn-2', 'company-2')],
      error: null,
    })

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(vi.mocked(syncStripeBalanceTransactions)).toHaveBeenCalledTimes(2)
    expect(json.processed).toBe(2)
    expect(json.inserted).toBe(4)
    expect(json.results).toEqual([
      { connectionId: 'conn-1', inserted: 2, updated: 0, status: 'synced' },
      { connectionId: 'conn-2', inserted: 2, updated: 0, status: 'synced' },
    ])
  })

  it('reaches entitled connections behind a front of more than 50 non-entitled ones', async () => {
    // Before the shared runner the cron read 50 rows and skipped these, so
    // the entitled connection behind them never synced.
    const front = Array.from({ length: 60 }, (_, i) => makeConnection(`free-${i}`, `free-company-${i}`))
    rangeResult.mockResolvedValueOnce({ data: [...front, makeConnection('paid', 'paid-company')], error: null })
    vi.mocked(hasCapability).mockImplementation(async (_sb, companyId) => companyId === 'paid-company')

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    const json = await response.json()

    expect(vi.mocked(syncStripeBalanceTransactions)).toHaveBeenCalledTimes(1)
    expect(json.results).toEqual([{ connectionId: 'paid', inserted: 2, updated: 0, status: 'synced' }])
  })

  it('marks a connection Stripe reports as revoked', async () => {
    rangeResult.mockResolvedValueOnce({ data: [makeConnection('conn-1', 'company-1')], error: null })
    vi.mocked(syncStripeBalanceTransactions).mockResolvedValueOnce({
      fetched: 0, imported: 0, duplicates: 0, errors: 0, foreignCurrency: 0, revoked: true,
    })

    const json = await (await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))).json()

    expect(json.results).toEqual([{ connectionId: 'conn-1', inserted: 0, updated: 0, status: 'revoked' }])
  })

  it('isolates a failing connection and keeps processing the rest', async () => {
    rangeResult.mockResolvedValueOnce({
      data: [makeConnection('conn-1', 'company-1'), makeConnection('conn-2', 'company-2')],
      error: null,
    })
    vi.mocked(syncStripeBalanceTransactions)
      .mockRejectedValueOnce(new Error('stripe boom'))
      .mockResolvedValueOnce({ fetched: 1, imported: 1, duplicates: 0, errors: 0, foreignCurrency: 0 })

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.processed).toBe(2)
    expect(json.results).toEqual([
      { connectionId: 'conn-1', inserted: 0, updated: 0, status: 'error' },
      { connectionId: 'conn-2', inserted: 1, updated: 0, status: 'synced' },
    ])
  })

  it('reports rows the sync could not import as an error, not as a clean sync', async () => {
    rangeResult.mockResolvedValueOnce({ data: [makeConnection('conn-1', 'company-1')], error: null })
    vi.mocked(syncStripeBalanceTransactions).mockResolvedValueOnce({ fetched: 4, imported: 2, duplicates: 0, errors: 2, foreignCurrency: 0 })

    const response = await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))

    expect(response.status).toBe(200)
    expect(logMock.error).toHaveBeenCalledWith('stripe sync left rows unwritten', {
      connectionId: 'conn-1',
      companyId: 'company-1',
      errors: 2,
    })
    expect(logMock.info).toHaveBeenCalledWith('stripe order sync summary', expect.objectContaining({ rowErrors: 2 }))
  })

  it('logs no error for a clean sync', async () => {
    rangeResult.mockResolvedValueOnce({ data: [makeConnection('conn-1', 'company-1')], error: null })
    await GET(createCronRequest('/api/extensions/stripe/transactions/cron'))
    expect(logMock.error).not.toHaveBeenCalled()
  })
})
