import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  expireStaleHandshakes: vi.fn(),
  syncWooCommerceOrders: vi.fn(),
  hasCapability: vi.fn(),
  registryGet: vi.fn(),
}))

vi.mock('@/lib/supabase/service-client', () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}))
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: mocks.registryGet },
}))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: mocks.hasCapability }))
vi.mock('@/extensions/general/woocommerce/lib/order-sync', () => ({
  syncWooCommerceOrders: mocks.syncWooCommerceOrders,
}))
vi.mock('@/extensions/general/woocommerce/lib/connect', () => ({
  expireStaleHandshakes: mocks.expireStaleHandshakes,
}))
vi.mock('@/lib/observability', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

import { GET } from '../route'
import { createQueuedMockSupabase } from '@/tests/helpers'

function request() {
  return new Request('https://app.testbrand.example/api/extensions/woocommerce/orders/cron', {
    headers: { authorization: 'Bearer test-cron-secret' },
  })
}

describe('GET /api/extensions/woocommerce/orders/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'test-cron-secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.testbrand.example')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    vi.stubEnv('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    mocks.registryGet.mockReturnValue({ id: 'woocommerce' })
    mocks.expireStaleHandshakes.mockResolvedValue({ expired: 0, error: null })
    mocks.hasCapability.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sweeps stale handshakes before it selects the active connections to sync', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    mocks.createServiceRoleClient.mockReturnValue(supabase)
    enqueue({ data: [] }) // active connections
    mocks.expireStaleHandshakes.mockImplementation(async () => {
      // Nothing has been read from the connections table yet.
      expect(calls.filter((c) => c.table === 'woocommerce_connections')).toHaveLength(0)
      return { expired: 2, error: null }
    })

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect(mocks.expireStaleHandshakes).toHaveBeenCalledWith(supabase)
    // Only ACTIVE rows with the feed on are ever handed to the sync.
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['status', 'active'])
    expect(eqCalls).toContainEqual(['transaction_sync_enabled', true])
    expect(mocks.syncWooCommerceOrders).not.toHaveBeenCalled()
  })

  it('still syncs when the sweep fails: a pending row cannot sync either way', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    mocks.createServiceRoleClient.mockReturnValue(supabase)
    mocks.expireStaleHandshakes.mockResolvedValue({
      expired: 0,
      error: { code: '57014', message: 'canceled' },
    })
    const connection = { id: 'conn-1', company_id: 'company-1', status: 'active' }
    enqueue({ data: [connection] })
    mocks.syncWooCommerceOrders.mockResolvedValue({
      inserted: 3,
      updated: 0,
      revoked: false,
      deadlineReached: false,
    })

    const res = await GET(request())

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ processed: 1, inserted: 3 })
    expect(mocks.syncWooCommerceOrders).toHaveBeenCalledWith(
      supabase,
      connection,
      expect.anything(),
      expect.any(Number),
    )
  })
})
