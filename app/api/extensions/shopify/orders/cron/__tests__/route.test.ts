import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyCronSecret = vi.fn(() => null as unknown)
vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: (...args: unknown[]) => verifyCronSecret(...args),
}))

const registryGet = vi.fn()
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => registryGet(...args) },
}))

// The connection query chain ends in .limit(); resolve it there.
const limitResult = vi.fn()
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: (...args: unknown[]) => limitResult(...args),
            }),
          }),
        }),
      }),
    }),
  })),
}))

const isShopifyConfigured = vi.fn(() => true)
vi.mock('@/extensions/general/shopify/lib/credentials', () => ({
  isShopifyConfigured: (...args: unknown[]) => isShopifyConfigured(...args),
}))

const syncShopifyOrders = vi.fn()
vi.mock('@/extensions/general/shopify/lib/order-sync', () => ({
  syncShopifyOrders: (...args: unknown[]) => syncShopifyOrders(...args),
}))

const hasCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
}))

const CONNECTION = { id: 'conn-1', company_id: 'company-1' }

async function callRoute() {
  const { GET } = await import('../route')
  return GET(new Request('https://example.test/api/extensions/shopify/orders/cron'))
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockReturnValue({ id: 'shopify' })
  isShopifyConfigured.mockReturnValue(true)
  hasCapability.mockResolvedValue(true)
  limitResult.mockResolvedValue({ data: [CONNECTION], error: null })
  syncShopifyOrders.mockResolvedValue({
    fetched: 2,
    refundsFetched: 0,
    inserted: 2,
    updated: 0,
    unchanged: 0,
    frozenFlagged: 0,
    crossMarked: 0,
    errors: 0,
  })
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
})

describe('GET /api/extensions/shopify/orders/cron', () => {
  it('returns 401 when the cron secret is wrong', async () => {
    verifyCronSecret.mockReturnValue({ error: 'unauthorized' })
    const res = await callRoute()
    expect(res.status).toBe(401)
    expect(syncShopifyOrders).not.toHaveBeenCalled()
  })

  it('refuses with 503 when the extension is not enabled', async () => {
    registryGet.mockReturnValue(undefined)
    const res = await callRoute()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('EXTENSION_DISABLED')
  })

  it('no-ops when the encryption key is not configured', async () => {
    isShopifyConfigured.mockReturnValue(false)
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect((await res.json()).processed).toBe(0)
    expect(syncShopifyOrders).not.toHaveBeenCalled()
  })

  it('fails loudly when the connection query errors', async () => {
    limitResult.mockResolvedValue({ data: null, error: { message: 'boom', code: '500' } })
    const res = await callRoute()
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('syncs each eligible connection and reports the totals', async () => {
    limitResult.mockResolvedValue({
      data: [CONNECTION, { id: 'conn-2', company_id: 'company-2' }],
      error: null,
    })
    const res = await callRoute()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.processed).toBe(2)
    expect(body.inserted).toBe(4)
    expect(syncShopifyOrders).toHaveBeenCalledTimes(2)
    // Runs on the service client with a shared deadline.
    expect(syncShopifyOrders.mock.calls[0][0]).toBeTruthy()
    expect(typeof syncShopifyOrders.mock.calls[0][3]).toBe('number')
  })

  it('skips connections whose company is not entitled', async () => {
    hasCapability.mockResolvedValue(false)
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect((await res.json()).processed).toBe(0)
    expect(syncShopifyOrders).not.toHaveBeenCalled()
  })

  it('records a failed connection without aborting the run', async () => {
    limitResult.mockResolvedValue({
      data: [CONNECTION, { id: 'conn-2', company_id: 'company-2' }],
      error: null,
    })
    syncShopifyOrders
      .mockRejectedValueOnce(new Error('store on fire'))
      .mockResolvedValueOnce({
        fetched: 1,
        refundsFetched: 0,
        inserted: 1,
        updated: 0,
        unchanged: 0,
        frozenFlagged: 0,
        crossMarked: 0,
        errors: 0,
      })
    const res = await callRoute()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.processed).toBe(2)
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['error', 'synced'])
  })

  it('marks a revoked connection in the results', async () => {
    syncShopifyOrders.mockResolvedValue({
      fetched: 0,
      refundsFetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      frozenFlagged: 0,
      crossMarked: 0,
      errors: 0,
      revoked: true,
    })
    const body = await (await callRoute()).json()
    expect(body.results[0].status).toBe('revoked')
  })
})
