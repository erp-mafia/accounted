import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force the capability gate to run but stub requireCapability so entitlement
// is controlled per test. Mirrors the stripe/enable-banking suites.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

// Never let a unit test reach a real WooCommerce host: the credential probe
// is mocked, the pure helpers (normalizeStoreUrl) stay real.
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, testConnectionAndFetchStoreInfo: vi.fn() }
})

// The sync engine has its own suite; here it only needs to be callable.
vi.mock('../lib/order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-sync')>()
  return { ...actual, syncWooCommerceOrders: vi.fn() }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))

import { woocommerceExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { testConnectionAndFetchStoreInfo } from '../lib/api-client'
import { syncWooCommerceOrders } from '../lib/order-sync'
import { decryptCredential } from '../lib/credentials'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = woocommerceExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path,
  )
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/woocommerce/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'woocommerce',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const USER = { id: 'user-1', is_anonymous: false }

describe('woocommerce extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.stubEnv('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('GET /status', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('prefers the active connection and reports configured', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [
          { id: 'c2', status: 'revoked' },
          { id: 'c1', status: 'active', store_url: 'https://shop.example.se' },
        ],
      })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.configured).toBe(true)
      expect(body.connection.id).toBe('c1')
    })
  })

  describe('POST /connect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('blocks anonymous (sandbox) users before any external call', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-1', is_anonymous: true } },
        error: null,
      })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.sandbox_blocked).toBe(true)
    })

    it('returns 403 capability_blocked when not entitled', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      vi.mocked(requireCapability).mockResolvedValue(
        capabilityBlockedResponse(CAPABILITY.woocommerce_sync),
      )
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'https://shop.example.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
    })

    it('rejects an invalid or http store URL with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'http://insecure.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('stages a pending row and returns the wc-auth authorize URL', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } }) // guardSandbox
      enqueue({ data: [] }) // no existing active/pending
      enqueue({ data: { id: 'conn-1' } }) // insert pending
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { store_url: 'Shop.Example.se/' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.url).toMatch(/^https:\/\/shop\.example\.se\/wc-auth\/v1\/authorize\?/)
      expect(body.url).toContain('scope=read')
      expect(body.url).toContain(
        encodeURIComponent('http://localhost:3000/api/extensions/woocommerce/callback'),
      )
      const inserted = findCall('woocommerce_connections', 'insert')?.[0] as Record<
        string,
        unknown
      >
      expect(inserted.store_url).toBe('https://shop.example.se')
      expect(inserted.status).toBe('pending')
      expect(inserted.oauth_state).toBeTruthy()
    })
  })

  describe('POST /manual-connect', () => {
    it('rejects missing keys with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', { store_url: 'https://shop.example.se', consumer_key: 'ck_x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('rejects with 400 when the credential probe fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      vi.mocked(testConnectionAndFetchStoreInfo).mockRejectedValue(new Error('401'))
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {
          store_url: 'https://shop.example.se',
          consumer_key: 'ck_x',
          consumer_secret: 'cs_y',
        }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('verifies, encrypts and activates on the happy path', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      enqueue({ data: { id: 'conn-1', store_url: 'https://shop.example.se' } }) // insert
      vi.mocked(testConnectionAndFetchStoreInfo).mockResolvedValue({
        name: 'Testbutiken',
        currency: 'SEK',
        prices_include_tax: true,
        wc_version: '9.9.5',
      })
      const ctx = makeContext(supabase)
      const res = await findRoute('POST', '/manual-connect').handler(
        makeRequest('POST', {
          store_url: 'https://shop.example.se',
          consumer_key: 'ck_x',
          consumer_secret: 'cs_y',
        }),
        ctx,
      )
      expect(res.status).toBe(200)
      const inserted = findCall('woocommerce_connections', 'insert')?.[0] as Record<
        string,
        string
      >
      expect(inserted.status).toBe('active')
      expect(inserted.store_name).toBe('Testbutiken')
      // Secrets never stored in plaintext, and they decrypt back.
      expect(inserted.consumer_key_encrypted).not.toContain('ck_x')
      expect(decryptCredential(inserted.consumer_key_encrypted)).toBe('ck_x')
      expect(decryptCredential(inserted.consumer_secret_encrypted)).toBe('cs_y')
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'woocommerce.connected' }),
      )
    })
  })

  describe('POST /sync', () => {
    it('returns 404 without an active connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('runs the sync on the service client and returns the summary', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1', status: 'active' }] })
      vi.mocked(syncWooCommerceOrders).mockResolvedValue({
        fetched: 3,
        refundsFetched: 1,
        inserted: 4,
        updated: 0,
        unchanged: 0,
        removed: 0,
        frozenFlagged: 0,
        crossMarked: 0,
        errors: 0,
      })
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.transactions.inserted).toBe(4)
      expect(vi.mocked(syncWooCommerceOrders).mock.calls[0][0]).toEqual({ service: true })
    })
  })

  describe('POST /transaction-sync', () => {
    it('rejects a non-boolean enabled with 400', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: 'yes' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('persists the toggle for the active connection', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [{ id: 'conn-1' }] })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: false }),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      expect(findCall('woocommerce_connections', 'update')?.[0]).toEqual({
        transaction_sync_enabled: false,
      })
    })
  })

  describe('DELETE /disconnect', () => {
    it('returns 404 when no connection exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('revokes (never deletes) and emits the audit event', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [{ id: 'conn-1', status: 'active', store_url: 'https://shop.example.se' }],
      })
      enqueue({ data: null }) // update
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        ctx,
      )
      expect(res.status).toBe(200)
      const updated = findCall('woocommerce_connections', 'update')?.[0] as Record<
        string,
        unknown
      >
      expect(updated.status).toBe('revoked')
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'woocommerce.disconnected' }),
      )
    })
  })
})
