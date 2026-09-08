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

const limitResult = vi.fn()
vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: vi.fn(() => ({
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

const isZettleConfigured = vi.fn(() => true)
vi.mock('@/extensions/general/zettle/lib/credentials', () => ({
  isZettleConfigured: (...args: unknown[]) => isZettleConfigured(...args),
}))

const syncZettlePurchases = vi.fn()
vi.mock('@/extensions/general/zettle/lib/order-sync', () => ({
  syncZettlePurchases: (...args: unknown[]) => syncZettlePurchases(...args),
}))

const hasCapability = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({
  hasCapability: (...args: unknown[]) => hasCapability(...args),
}))

const CONNECTION = { id: 'conn-1', company_id: 'company-1' }

async function callRoute() {
  const { GET } = await import('../route')
  return GET(new Request('https://example.test/api/extensions/zettle/orders/cron'))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  verifyCronSecret.mockReturnValue(null)
  registryGet.mockReturnValue({ id: 'zettle' })
  isZettleConfigured.mockReturnValue(true)
  hasCapability.mockResolvedValue(true)
  limitResult.mockResolvedValue({ data: [CONNECTION], error: null })
  syncZettlePurchases.mockResolvedValue({
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

describe('GET /api/extensions/zettle/orders/cron', () => {
  it('returns 503 when the extension is disabled', async () => {
    registryGet.mockReturnValue(null)
    const res = await callRoute()
    expect(res.status).toBe(503)
    expect(syncZettlePurchases).not.toHaveBeenCalled()
  })

  it('syncs entitled active connections', async () => {
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(syncZettlePurchases).toHaveBeenCalled()
    const body = await res.json()
    expect(body.processed).toBe(1)
    expect(body.inserted).toBe(2)
  })
})
