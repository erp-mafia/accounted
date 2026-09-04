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
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockResolvedValue(
      supabase as unknown as Awaited<ReturnType<typeof createServiceClient>>,
    )
    enqueue({
      data: {
        id: 'conn-1',
        company_id: 'company-1',
        user_id: 'user-1',
        store_url: 'https://shop.example.se',
      },
    })
    enqueue({ data: null }) // markError update
    vi.mocked(testConnectionAndFetchStoreInfo).mockRejectedValue(new Error('403'))

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(502)
    const errorUpdate = findCall('woocommerce_connections', 'update')?.[0] as Record<
      string,
      unknown
    >
    expect(errorUpdate.status).toBe('error')
    // The probe ran against the STORED store_url, not anything the caller sent.
    expect(vi.mocked(testConnectionAndFetchStoreInfo).mock.calls[0][0]).toMatchObject({
      storeUrl: 'https://shop.example.se',
      consumerKey: 'ck_new',
    })
  })

  it('encrypts the keys, activates the row and emits the audit event', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    vi.mocked(createServiceClient).mockResolvedValue(
      supabase as unknown as Awaited<ReturnType<typeof createServiceClient>>,
    )
    enqueue({
      data: {
        id: 'conn-1',
        company_id: 'company-1',
        user_id: 'user-1',
        store_url: 'https://shop.example.se',
      },
    })
    enqueue({
      data: {
        id: 'conn-1',
        company_id: 'company-1',
        user_id: 'user-1',
        store_url: 'https://shop.example.se',
      },
    }) // activation update
    vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue({
      name: 'Testbutiken',
      currency: 'SEK',
      prices_include_tax: true,
      wc_version: '9.9.5',
    })

    const res = await POST(makeCallbackRequest(VALID_BODY))
    expect(res.status).toBe(200)

    const updates = findCalls('woocommerce_connections', 'update')
    const activation = updates[0][0] as Record<string, string | boolean | null>
    expect(activation.status).toBe('active')
    expect(activation.transaction_sync_enabled).toBe(true)
    // The state survives activation on purpose: this POST has no browser
    // session, so the browser leg (../return) binds the completion to the
    // initiator by looking the row up with this same state and consumes it
    // there. Replay is blocked by the status 'pending' scope instead.
    expect(activation).not.toHaveProperty('oauth_state')
    expect(activation.store_name).toBe('Testbutiken')
    // Secrets never stored in plaintext, and they decrypt back.
    expect(String(activation.consumer_key_encrypted)).not.toContain('ck_new')
    expect(decryptCredential(String(activation.consumer_key_encrypted))).toBe('ck_new')
    expect(decryptCredential(String(activation.consumer_secret_encrypted))).toBe('cs_new')

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'woocommerce.connected' }),
    )
  })
})
