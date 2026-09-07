import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: vi.fn() } }))
vi.mock('@/extensions/general/woocommerce/lib/api-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/extensions/general/woocommerce/lib/api-client')>()
  return { ...actual, testConnectionAndFetchStoreInfo: vi.fn() }
})

import { POST } from '../callback/route'
import { createServiceClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events/bus'
import { extensionRegistry } from '@/lib/extensions/registry'
import { testConnectionAndFetchStoreInfo } from '@/extensions/general/woocommerce/lib/api-client'
import { decryptCredential } from '@/extensions/general/woocommerce/lib/credentials'
import { createQueuedMockSupabase } from '@/tests/helpers'

const STATE = '123e4567-e89b-12d3-a456-426614174000'

function makeCallbackRequest(body: unknown): Request {
  return new Request('https://test.local/api/extensions/woocommerce/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const PENDING_ROW = {
  id: 'conn-1',
  company_id: 'company-1',
  user_id: 'user-1',
  store_url: 'https://shop.example.se',
  created_at: new Date().toISOString(),
  consumer_key_encrypted: null as string | null,
}

const STORE_INFO = {
  name: 'Testbutiken',
  currency: 'SEK',
  prices_include_tax: true,
  wc_version: '9.9.5',
}

function mockServiceClient() {
  const queued = createQueuedMockSupabase()
  vi.mocked(createServiceClient).mockResolvedValue(
    queued.supabase as unknown as Awaited<ReturnType<typeof createServiceClient>>,
  )
  return queued
}

const VALID_BODY = {
  key_id: 1,
  user_id: STATE,
  consumer_key: 'ck_new',
  consumer_secret: 'cs_new',
  key_permissions: 'read',
}

describe('POST /api/extensions/woocommerce/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    vi.mocked(extensionRegistry.get).mockReturnValue(
      { id: 'woocommerce' } as ReturnType<typeof extensionRegistry.get>,
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses with 503 when the extension is disabled', async () => {
    vi.mocked(extensionRegistry.get).mockReturnValue(undefined)
    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('EXTENSION_DISABLED')
  })

  it('rejects a non-JSON body with 400', async () => {
    const res = await POST(makeCallbackRequest('not json'))
    expect(res.status).toBe(400)
  })

  it('rejects a missing or non-UUID state with 400', async () => {
    const res = await POST(
      makeCallbackRequest({ ...VALID_BODY, user_id: 'not-a-uuid' }),
    )
    expect(res.status).toBe(400)

    const res2 = await POST(makeCallbackRequest({ user_id: STATE }))
    expect(res2.status).toBe(400)
  })

  it('returns 404 for an unknown or already-consumed state', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockResolvedValue(
      supabase as unknown as Awaited<ReturnType<typeof createServiceClient>>,
    )
    enqueue({ data: null, error: { message: 'no rows', code: 'PGRST116' } })
    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(404)
  })

  it('marks the row error and returns 502 when the credential probe fails', async () => {
    const { enqueue, findCall } = mockServiceClient()
    enqueue({ data: PENDING_ROW })
    enqueue({ data: null }) // markError update
    vi.mocked(testConnectionAndFetchStoreInfo).mockRejectedValue(new Error('403'))

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(502)
    const errorUpdate = findCall('woocommerce_connections', 'update')?.[0] as Record<
      string,
      unknown
    >
    expect(errorUpdate).toMatchObject({
      status: 'error',
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
    })
    // The probe ran against the STORED store_url, not anything the caller sent.
    expect(vi.mocked(testConnectionAndFetchStoreInfo).mock.calls[0][0]).toMatchObject({
      storeUrl: 'https://shop.example.se',
      consumerKey: 'ck_new',
    })
  })

  it('stages the verified keys but leaves the row pending until the browser confirms', async () => {
    const { enqueue, findCalls, calls } = mockServiceClient()
    enqueue({ data: PENDING_ROW })
    enqueue({ data: { id: 'conn-1' } }) // stage update
    enqueue({ data: null }) // activateIfComplete: browser signal missing, zero rows
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue(STORE_INFO)

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, activated: false })

    const updates = findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(2)
    const staged = updates[0][0] as Record<string, string | boolean | null>
    // Keys and store info are staged; nothing here says 'active' or turns
    // the feed on, and the state stays so the return leg can find the row.
    expect(staged).not.toHaveProperty('status')
    expect(staged).not.toHaveProperty('transaction_sync_enabled')
    expect(staged).not.toHaveProperty('oauth_state')
    expect(staged.store_name).toBe('Testbutiken')
    // Secrets never stored in plaintext, and they decrypt back.
    expect(String(staged.consumer_key_encrypted)).not.toContain('ck_new')
    expect(decryptCredential(String(staged.consumer_key_encrypted))).toBe('ck_new')
    expect(decryptCredential(String(staged.consumer_secret_encrypted))).toBe('cs_new')

    // The activation attempt is the conditional one: pending + both signals.
    const activation = updates[1][0] as Record<string, unknown>
    expect(activation.status).toBe('active')
    const notCalls = calls.filter((c) => c.method === 'not').map((c) => c.args)
    expect(notCalls).toContainEqual(['consumer_key_encrypted', 'is', null])
    expect(notCalls).toContainEqual(['consumer_secret_encrypted', 'is', null])
    expect(notCalls).toContainEqual(['browser_confirmed_at', 'is', null])

    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('activates and emits when the browser confirmed before the keys arrived', async () => {
    const { enqueue, findCalls } = mockServiceClient()
    enqueue({ data: PENDING_ROW })
    enqueue({ data: { id: 'conn-1' } }) // stage update
    enqueue({
      data: {
        id: 'conn-1',
        company_id: 'company-1',
        user_id: 'user-1',
        store_url: 'https://shop.example.se',
      },
    }) // activateIfComplete: both signals present
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue(STORE_INFO)

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, activated: true })

    const updates = findCalls('woocommerce_connections', 'update')
    const activation = updates[1][0] as Record<string, unknown>
    expect(activation).toMatchObject({
      status: 'active',
      transaction_sync_enabled: true,
      oauth_state: null,
    })
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'woocommerce.connected',
        payload: expect.objectContaining({ connectionId: 'conn-1', companyId: 'company-1' }),
      }),
    )
  })

  it('answers a duplicate POST for a state that already holds keys with 200 and touches nothing', async () => {
    const { enqueue, findCalls } = mockServiceClient()
    enqueue({ data: { ...PENDING_ROW, consumer_key_encrypted: 'enc:already' } })

    const res = await POST(makeCallbackRequest({ ...VALID_BODY, consumer_key: 'ck_forged' }))
    // 200, not 4xx: WooCommerce deletes its key and shows a store-side error
    // on any non-200, and a distinct status would tell whoever holds the
    // state whether the merchant has approved yet.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, activated: false })
    expect(testConnectionAndFetchStoreInfo).not.toHaveBeenCalled()
    expect(findCalls('woocommerce_connections', 'update')).toHaveLength(0)
  })

  it('stages keys for a slow approval past the handshake TTL instead of refusing (WooCommerce wp_dies on non-200)', async () => {
    const { enqueue, findCalls } = mockServiceClient()
    enqueue({
      data: { ...PENDING_ROW, created_at: new Date(Date.now() - 45 * 60_000).toISOString() },
    })
    enqueue({ data: { id: 'conn-1' } }) // stage update
    enqueue({ data: null }) // activateIfComplete: browser not confirmed
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue(STORE_INFO)

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(200)
    const updates = findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(2)
    expect(updates[0][0]).not.toHaveProperty('status')
  })

  it('parks the row and returns 409 when activation hits the one-active-per-store index', async () => {
    const { enqueue, findCalls } = mockServiceClient()
    enqueue({ data: PENDING_ROW })
    enqueue({ data: { id: 'conn-1' } }) // stage update
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })
    enqueue({ data: null }) // markError update
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue(STORE_INFO)

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(409)
    const updates = findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(3)
    // Parking wipes the staged secrets AND the store metadata the probe read.
    expect(updates[2][0]).toMatchObject({
      status: 'error',
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
      store_name: null,
      currency: null,
    })
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it('returns 404 when the row left pending between lookup and staging', async () => {
    const { enqueue } = mockServiceClient()
    enqueue({ data: PENDING_ROW })
    enqueue({ data: null }) // stage update matched zero rows
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue(STORE_INFO)

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(404)
    expect(eventBus.emit).not.toHaveBeenCalled()
  })
})
