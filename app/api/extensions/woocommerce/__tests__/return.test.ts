import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({
  resolveRequestAppOrigin: vi.fn(async () => 'http://localhost:3000'),
}))

import { GET } from '../return/route'
import { resolveRequestAppOrigin } from '@/lib/domains/trusted-app-origin'
import { createServiceClient, createClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createQueuedMockSupabase } from '@/tests/helpers'

const STATE = '123e4567-e89b-12d3-a456-426614174000'
const BASE = 'http://localhost:3000'
const CONNECTED = `${BASE}/import?mode=woocommerce&woocommerce_connected=true`

function makeReturnRequest(params: Record<string, string>): Request {
  const url = new URL(`${BASE}/api/extensions/woocommerce/return`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url.toString())
}

function mockServiceClient() {
  const queued = createQueuedMockSupabase()
  vi.mocked(createServiceClient).mockResolvedValue(
    queued.supabase as unknown as Awaited<ReturnType<typeof createServiceClient>>,
  )
  return queued
}

function mockSession(userId: string | null) {
  const getUser = vi
    .fn()
    .mockResolvedValue({ data: { user: userId ? { id: userId } : null }, error: null })
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)
  return getUser
}

const ROW = (status: 'pending' | 'active', ageMs = 0) => ({
  id: 'conn-1',
  user_id: 'user-1',
  status,
  created_at: new Date(Date.now() - ageMs).toISOString(),
})

const ACTIVATED = {
  id: 'conn-1',
  company_id: 'company-1',
  user_id: 'user-1',
  store_url: 'https://shop.example.se',
}

describe('GET /api/extensions/woocommerce/return', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_APP_URL', BASE)
    vi.mocked(extensionRegistry.get).mockReturnValue(
      { id: 'woocommerce' } as ReturnType<typeof extensionRegistry.get>,
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses with 503 when the extension is disabled', async () => {
    vi.mocked(extensionRegistry.get).mockReturnValue(undefined)
    const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))
    expect(res.status).toBe(503)
  })

  it('redirects to the brand host the browser arrived on, resolved through the trusted-origin helper', async () => {
    const { enqueue } = mockServiceClient()
    mockSession('user-1')
    vi.mocked(resolveRequestAppOrigin).mockResolvedValueOnce('https://app.testbrand.example')
    enqueue({ data: ROW('pending') })
    enqueue({ data: null }) // browser_confirmed_at update
    enqueue({ data: ACTIVATED }) // activateIfComplete

    const request = makeReturnRequest({ success: '1', user_id: STATE })
    const res = await GET(request)

    expect(resolveRequestAppOrigin).toHaveBeenCalledWith(request, { onLookupFailure: 'canonical' })
    expect(res.headers.get('location')).toBe(
      'https://app.testbrand.example/import?mode=woocommerce&woocommerce_connected=true',
    )
  })

  it('sends a denial back to the brand host too', async () => {
    const { enqueue } = mockServiceClient()
    vi.mocked(resolveRequestAppOrigin).mockResolvedValueOnce('https://app.testbrand.example')
    enqueue({ data: null })

    const res = await GET(makeReturnRequest({ success: '0', user_id: STATE }))

    expect(res.headers.get('location')).toBe(
      'https://app.testbrand.example/import?mode=woocommerce&woocommerce_error=denied',
    )
  })

  it('closes the pending row and reports the denial when the store says no', async () => {
    const { supabase, enqueue, findCall } = mockServiceClient()
    enqueue({ data: null })

    const res = await GET(makeReturnRequest({ success: '0', user_id: STATE }))

    expect(res.headers.get('location')).toBe(
      `${BASE}/import?mode=woocommerce&woocommerce_error=denied`,
    )
    const update = findCall('woocommerce_connections', 'update')?.[0] as Record<string, unknown>
    // The callback may already have staged keys AND the store's metadata for
    // this state (WooCommerce re-serves the approval page); a denial takes
    // all of it back.
    expect(update).toMatchObject({
      status: 'error',
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
      store_name: null,
      currency: null,
      prices_include_tax: null,
      wc_version: null,
      key_permissions: null,
    })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  describe('approved leg (success=1)', () => {
    it('hands a row the pre-gate callback activated over to its initiator and consumes the state', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      const getUser = mockSession('user-1')
      enqueue({ data: ROW('active') }) // lookup by oauth_state
      enqueue({ data: null }) // consume update

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe(CONNECTED)
      expect(getUser).toHaveBeenCalledTimes(1)
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(1)
      expect(updates[0][0]).toEqual({ oauth_state: null })
    })

    it('records the initiator confirmation and activates a pending row whose keys are staged', async () => {
      const { enqueue, findCalls, calls } = mockServiceClient()
      const getUser = mockSession('user-1')
      enqueue({ data: ROW('pending') }) // lookup by oauth_state
      enqueue({ data: null }) // browser_confirmed_at update
      enqueue({ data: ACTIVATED }) // activateIfComplete: keys already staged

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(CONNECTED)
      expect(getUser).toHaveBeenCalledTimes(1)
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(2)
      expect(Object.keys(updates[0][0] as object)).toEqual(['browser_confirmed_at'])
      expect(updates[1][0]).toMatchObject({
        status: 'active',
        transaction_sync_enabled: true,
        oauth_state: null,
      })
      // Activation is conditional on both signals, scoped to this pending row.
      const notCalls = calls.filter((c) => c.method === 'not').map((c) => c.args)
      expect(notCalls).toContainEqual(['consumer_key_encrypted', 'is', null])
      expect(notCalls).toContainEqual(['browser_confirmed_at', 'is', null])
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'woocommerce.connected',
          payload: expect.objectContaining({ connectionId: 'conn-1', companyId: 'company-1' }),
        }),
      )
    })

    it('records the confirmation and waits (no connected toast) when the keys have not landed yet', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      mockSession('user-1')
      enqueue({ data: ROW('pending') })
      enqueue({ data: null }) // browser_confirmed_at update
      enqueue({ data: null }) // activateIfComplete: no keys yet, zero rows

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(`${BASE}/import?mode=woocommerce`)
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(2)
      expect(Object.keys(updates[0][0] as object)).toEqual(['browser_confirmed_at'])
      // The state is left on the row: the late callback still needs it.
      expect(updates[0][0]).not.toHaveProperty('oauth_state')
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it('parks an expired pending row with its keys wiped instead of confirming it', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      mockSession('user-1')
      enqueue({ data: ROW('pending', 16 * 60_000) })
      enqueue({ data: null }) // expire update

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(
        `${BASE}/import?mode=woocommerce&woocommerce_error=expired`,
      )
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(1)
      expect(updates[0][0]).toMatchObject({
        status: 'error',
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
        // The store's name and settings the callback staged go too.
        store_name: null,
        currency: null,
        prices_include_tax: null,
        wc_version: null,
      })
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it('parks the row and reports a conflict when the store is already actively connected', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      mockSession('user-1')
      enqueue({ data: ROW('pending') })
      enqueue({ data: null }) // browser_confirmed_at update
      enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
      enqueue({ data: null }) // park update

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(
        `${BASE}/import?mode=woocommerce&woocommerce_error=conflict`,
      )
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(3)
      expect(updates[2][0]).toMatchObject({ status: 'error', consumer_key_encrypted: null })
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it('revokes a row the pre-gate callback already activated when a different user completes the handshake', async () => {
      const { enqueue, findCalls, calls } = mockServiceClient()
      mockSession('user-2')
      enqueue({ data: ROW('active') })
      enqueue({ data: null }) // revoke update

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.status).toBe(307)
      expect(res.headers.get('location')).toBe(
        `${BASE}/import?mode=woocommerce&woocommerce_error=wrong_user`,
      )
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(1)
      // The store's keys the callback stored for the wrong company are gone,
      // the state is consumed, and the row says why.
      expect(updates[0][0]).toMatchObject({
        status: 'error',
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
      })
      expect(String((updates[0][0] as Record<string, unknown>).error_message)).toContain(
        'annat användarkonto',
      )
      // Scoped to this row, never a blanket update.
      const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
      expect(eqCalls).toContainEqual(['id', 'conn-1'])
    })

    it('closes a still-pending row when a different user completes it, so the late callback cannot stage or activate it', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      mockSession('user-2')
      enqueue({ data: ROW('pending') })
      enqueue({ data: null })

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(
        `${BASE}/import?mode=woocommerce&woocommerce_error=wrong_user`,
      )
      const updates = findCalls('woocommerce_connections', 'update')
      expect(updates).toHaveLength(1)
      expect(updates[0][0]).toMatchObject({
        status: 'error',
        oauth_state: null,
        consumer_key_encrypted: null,
        consumer_secret_encrypted: null,
      })
      expect(updates[0][0]).not.toHaveProperty('browser_confirmed_at')
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it('sends an anonymous browser to /login with the return URL preserved and touches nothing', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      mockSession(null)
      enqueue({ data: ROW('active') })

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.status).toBe(307)
      const location = new URL(res.headers.get('location') || '')
      expect(location.origin).toBe(BASE)
      expect(location.pathname).toBe('/login')
      expect(location.searchParams.get('next')).toBe(
        `/api/extensions/woocommerce/return?success=1&user_id=${STATE}`,
      )
      expect(findCalls('woocommerce_connections', 'update')).toHaveLength(0)
    })

    it('does not consult the session when no row carries the state (already consumed or unknown)', async () => {
      const { enqueue, findCalls } = mockServiceClient()
      const getUser = mockSession('user-2')
      enqueue({ data: null, error: { message: 'no rows', code: 'PGRST116' } })

      const res = await GET(makeReturnRequest({ success: '1', user_id: STATE }))

      expect(res.headers.get('location')).toBe(CONNECTED)
      expect(getUser).not.toHaveBeenCalled()
      expect(findCalls('woocommerce_connections', 'update')).toHaveLength(0)
    })

    it('redirects without a database round trip when the state is missing or not a uuid', async () => {
      const { supabase } = mockServiceClient()

      const res1 = await GET(makeReturnRequest({ success: '1' }))
      const res2 = await GET(makeReturnRequest({ success: '1', user_id: 'not-a-uuid' }))

      expect(res1.headers.get('location')).toBe(CONNECTED)
      expect(res2.headers.get('location')).toBe(CONNECTED)
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
