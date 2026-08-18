import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force the capability gate to run but stub requireCapability so entitlement
// is controlled per test. Mirrors the stripe/woocommerce suites.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

// Never let a unit test reach a real Shopify host: the credential probe is
// mocked, the pure helpers (normalizeShopDomain) stay real.
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, testConnectionAndFetchShopInfo: vi.fn() }
})

// The sync engine has its own suite; here it only needs to be callable.
vi.mock('../lib/order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-sync')>()
  return { ...actual, syncShopifyOrders: vi.fn() }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))

import { shopifyExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { testConnectionAndFetchShopInfo } from '../lib/api-client'
import { syncShopifyOrders } from '../lib/order-sync'
import { decryptCredential } from '../lib/credentials'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = shopifyExtension.apiRoutes?.find(
    (r) => r.method === method && r.path === path,
  )
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/shopify/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'shopify',
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

const VALID_CONNECT_BODY = {
  shop_domain: 'minbutik.myshopify.com',
  client_id: 'client-id',
  client_secret: 'client-secret',
}

describe('shopify extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
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
          { id: 'c1', status: 'active', shop_domain: 'minbutik.myshopify.com' },
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
      expect(testConnectionAndFetchShopInfo).not.toHaveBeenCalled()
    })

    it('returns 403 capability_blocked when not entitled', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      vi.mocked(requireCapability).mockResolvedValue(
        capabilityBlockedResponse(CAPABILITY.shopify_sync),
      )
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', VALID_CONNECT_BODY),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
    })

    it('rejects a non-myshopify.com domain with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { ...VALID_CONNECT_BODY, shop_domain: 'https://minbutik.se' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('rejects missing client credentials with 400', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { shop_domain: 'minbutik.myshopify.com', client_id: 'x' }),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('returns 409 when an active connection already exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [{ id: 'conn-0', status: 'active' }] })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', VALID_CONNECT_BODY),
        makeContext(supabase),
      )
      expect(res.status).toBe(409)
      expect(testConnectionAndFetchShopInfo).not.toHaveBeenCalled()
    })

    it('rejects with 400 when the credential probe fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      vi.mocked(testConnectionAndFetchShopInfo).mockRejectedValue(new Error('401'))
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', VALID_CONNECT_BODY),
        makeContext(supabase),
      )
      expect(res.status).toBe(400)
    })

    it('verifies, encrypts and activates on the happy path', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connection
      enqueue({ data: { id: 'conn-1', shop_domain: 'minbutik.myshopify.com' } }) // insert
      vi.mocked(testConnectionAndFetchShopInfo).mockResolvedValue({
        name: 'Testbutiken',
        currency: 'SEK',
      })
      const ctx = makeContext(supabase)
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', { ...VALID_CONNECT_BODY, shop_domain: 'MinButik' }),
        ctx,
      )
      expect(res.status).toBe(200)
      const inserted = findCall('shopify_connections', 'insert')?.[0] as Record<
        string,
        string
      >
      expect(inserted.status).toBe('active')
      expect(inserted.shop_name).toBe('Testbutiken')
      // The bare handle was normalized before probing and storing.
      expect(inserted.shop_domain).toBe('minbutik.myshopify.com')
      // Secrets never stored in plaintext, and they decrypt back.
      expect(inserted.client_id_encrypted).not.toContain('client-id')
      expect(decryptCredential(inserted.client_id_encrypted)).toBe('client-id')
      expect(decryptCredential(inserted.client_secret_encrypted)).toBe('client-secret')
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'shopify.connected' }),
      )
    })
  })

  describe('POST /sync', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('returns 404 without an active connection', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: null })
      const res = await findRoute('POST', '/sync').handler(
        makeRequest('POST'),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('runs the sync on the service client and returns the summary', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { id: 'conn-1', status: 'active' } })
      vi.mocked(syncShopifyOrders).mockResolvedValue({
        fetched: 3,
        refundsFetched: 1,
        inserted: 4,
        updated: 0,
        unchanged: 0,
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
      expect(vi.mocked(syncShopifyOrders).mock.calls[0][0]).toEqual({ service: true })
    })
  })

  describe('POST /transaction-sync', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/transaction-sync').handler(
        makeRequest('POST', { enabled: true }),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

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
      expect(findCall('shopify_connections', 'update')?.[0]).toEqual({
        transaction_sync_enabled: false,
      })
    })
  })

  describe('DELETE /disconnect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

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

    it('revokes (never deletes), drops credentials and emits the audit event', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [{ id: 'conn-1', status: 'active', shop_domain: 'minbutik.myshopify.com' }],
      })
      enqueue({ data: null }) // update
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        ctx,
      )
      expect(res.status).toBe(200)
      const updated = findCall('shopify_connections', 'update')?.[0] as Record<
        string,
        unknown
      >
      expect(updated.status).toBe('revoked')
      expect(updated.client_id_encrypted).toBeNull()
      expect(updated.client_secret_encrypted).toBeNull()
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'shopify.disconnected' }),
      )
    })
  })
})
