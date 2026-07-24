/**
 * Tests for the nightly Stripe balance-transaction sync cron: auth, config
 * short-circuit, per-connection processing with capability gating, and
 * isolated per-connection failures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const verifyCronSecret = vi.fn<(request: Request) => Response | null>(() => null)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (request: Request) => verifyCronSecret(request),
}))

const connectionsResult: { data: unknown; error: unknown } = { data: null, error: null }
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'order', 'limit']) {
        chain[method] = vi.fn(() => chain)
      }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(connectionsResult).then(resolve)
      return chain
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

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/extensions/stripe/transactions/cron')
}

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
  verifyCronSecret.mockReturnValue(null)
  connectionsResult.data = null
  connectionsResult.error = null
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
  vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_123')
  vi.mocked(hasCapability).mockResolvedValue(true)
  vi.mocked(syncStripeBalanceTransactions).mockResolvedValue({
    fetched: 3,
    imported: 2,
    duplicates: 1,
    linked: 1,
    errors: 0,
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

    const response = await GET(cronRequest())

    expect(response.status).toBe(401)
    expect(vi.mocked(syncStripeBalanceTransactions)).not.toHaveBeenCalled()
  })

  it('no-ops when Stripe Connect is not configured', async () => {
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', '')

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json).toEqual({ message: 'Stripe Connect not configured', processed: 0 })
  })

  it('no-ops when no connection has transaction sync enabled', async () => {
    connectionsResult.data = []

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(json.processed).toBe(0)
    expect(vi.mocked(syncStripeBalanceTransactions)).not.toHaveBeenCalled()
  })

  it('syncs entitled connections and aggregates totals', async () => {
    connectionsResult.data = [
      makeConnection('conn-1', 'company-1'),
      makeConnection('conn-2', 'company-2'),
    ]

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(vi.mocked(syncStripeBalanceTransactions)).toHaveBeenCalledTimes(2)
    expect(json.processed).toBe(2)
    expect(json.imported).toBe(4)
    expect(json.linked).toBe(2)
    expect(json.results).toEqual([
      { connectionId: 'conn-1', imported: 2, duplicates: 1, linked: 1, status: 'synced' },
      { connectionId: 'conn-2', imported: 2, duplicates: 1, linked: 1, status: 'synced' },
    ])
  })

  it('skips connections whose company lacks the stripe_payments capability', async () => {
    connectionsResult.data = [
      makeConnection('conn-1', 'company-1'),
      makeConnection('conn-2', 'company-2'),
    ]
    vi.mocked(hasCapability).mockImplementation(async (_sb, companyId) =>
      companyId !== 'company-1',
    )

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(vi.mocked(syncStripeBalanceTransactions)).toHaveBeenCalledTimes(1)
    expect(json.processed).toBe(1)
    expect(json.results[0].connectionId).toBe('conn-2')
  })

  it('isolates a failing connection and keeps processing the rest', async () => {
    connectionsResult.data = [
      makeConnection('conn-1', 'company-1'),
      makeConnection('conn-2', 'company-2'),
    ]
    vi.mocked(syncStripeBalanceTransactions)
      .mockRejectedValueOnce(new Error('stripe boom'))
      .mockResolvedValueOnce({ fetched: 1, imported: 1, duplicates: 0, linked: 0, errors: 0 })

    const response = await GET(cronRequest())
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.processed).toBe(2)
    expect(json.results).toEqual([
      { connectionId: 'conn-1', imported: 0, duplicates: 0, linked: 0, status: 'error' },
      { connectionId: 'conn-2', imported: 1, duplicates: 0, linked: 0, status: 'synced' },
    ])
  })
})
