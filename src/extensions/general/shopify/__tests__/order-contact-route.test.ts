import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

// Dispatcher seams (same set as the catch-all route's own suite), so the
// 401 case runs through the real auth chokepoint in front of this route.
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/mfa', () => ({
  shouldEnforceMfa: vi.fn(() => false),
  mfaStepUpApplies: vi.fn(() => false),
}))
vi.mock('@/lib/extensions/sectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/extensions/sectors')>()),
  requiredCapabilityForExtensionId: vi.fn(),
}))
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  requireCapability: vi.fn(),
}))

// Route seams: no real Shopify host, no real rate limiter, no sandbox lookup.
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, createShopifySession: vi.fn(), fetchOrderContact: vi.fn() }
})
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(),
}))
vi.mock('@/lib/auth/rate-limit-http', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/sandbox/guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sandbox/guard')>()),
  guardSandbox: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtensionId } from '@/lib/extensions/sectors'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { guardSandbox } from '@/lib/sandbox/guard'
import { GET as dispatch } from '@/app/api/extensions/ext/[...path]/route'
import { createShopifySession, fetchOrderContact, ShopifyApiError } from '../lib/api-client'
import { encryptCredential } from '../lib/credentials'
import { shopifyOrderContactRoute } from '../lib/order-contact-route'
import { shopifyExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

const ORDER_ID = '3f2a8c1e-5b7d-4e0a-9c6f-1a2b3c4d5e6f'

function makeContext(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
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
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** What the dispatcher hands the handler: the path param as `_id`. */
function routeRequest(id: string = ORDER_ID): Request {
  return new Request(
    `https://test.local/api/extensions/ext/shopify/orders/${id}/customer?_id=${encodeURIComponent(id)}`,
  )
}

function shopifyOrderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    platform: 'shopify',
    row_type: 'order',
    store_scope: 'minbutik.myshopify.com',
    platform_order_id: '1001',
    ...overrides,
  }
}

function connectionRow() {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    shop_domain: 'minbutik.myshopify.com',
    status: 'active',
    client_id_encrypted: encryptCredential('client-id'),
    client_secret_encrypted: encryptCredential('client-secret'),
  }
}

/** The service client the route reads the connection with. */
function serviceReturning(result: { data?: unknown; error?: unknown }) {
  const service = createQueuedMockSupabase()
  service.enqueue(result)
  vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(service.supabase as never)
  return service
}

async function call(supabase: unknown, request = routeRequest(), overrides: Partial<ExtensionContext> = {}) {
  return shopifyOrderContactRoute.handler(request, makeContext(supabase, overrides))
}

describe('GET /orders/:id/customer (Shopify order contact)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('SHOPIFY_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.mocked(requiredCapabilityForExtensionId).mockReturnValue(undefined)
    vi.mocked(guardSandbox).mockResolvedValue(null)
    vi.mocked(createShopifySession).mockResolvedValue({
      shopDomain: 'minbutik.myshopify.com',
      accessToken: 'token-1',
    })
    extensionRegistry.clear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is registered on the extension, write-gated, at the path the dialog calls', () => {
    const route = shopifyExtension.apiRoutes?.find(
      (r) => r.method === 'GET' && r.path === '/orders/:id/customer',
    )
    expect(route).toBe(shopifyOrderContactRoute)
    expect(shopifyOrderContactRoute.requireWrite).toBe(true)
  })

  it('returns 401 through the dispatcher when not authenticated, before any lookup', async () => {
    extensionRegistry.register({
      id: 'shopify',
      name: 'Shopify',
      version: '1.0.0',
      apiRoutes: [shopifyOrderContactRoute],
    })
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const request = createMockRequest(`/api/extensions/ext/shopify/orders/${ORDER_ID}/customer`)
    const response = await dispatch(request, {
      params: Promise.resolve({ path: ['shopify', 'orders', ORDER_ID, 'customer'] }),
    })

    expect(response.status).toBe(401)
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it('blocks a sandbox session before any external call', async () => {
    const { supabase } = createQueuedMockSupabase()
    const response = await call(supabase, routeRequest(), { isAnonymous: true })
    const { status, body } = await parseJsonResponse<{ sandbox_blocked?: boolean }>(response)
    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it('returns the capability block when the company lacks the Shopify feed', async () => {
    vi.mocked(requireCapability).mockResolvedValue(
      NextResponse.json({ error: 'blocked', capability_blocked: true }, { status: 403 }),
    )
    const { supabase } = createQueuedMockSupabase()
    const response = await call(supabase)
    expect(response.status).toBe(403)
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it('returns 400 for an id that is not a uuid', async () => {
    const { supabase } = createQueuedMockSupabase()
    const response = await call(supabase, routeRequest('1001'))
    expect(response.status).toBe(400)
  })

  it("returns 404 when the order is not one of the company's Shopify orders", async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    const response = await call(supabase)
    expect(response.status).toBe(404)
    // Scoped to the active company, never by id alone.
    expect(findCalls('webshop_orders', 'eq')).toEqual([
      ['id', ORDER_ID],
      ['company_id', 'company-1'],
    ])
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it.each([
    ['a WooCommerce order', { platform: 'woocommerce' }],
    ['a refund row', { row_type: 'refund' }],
  ])('returns 404 for %s', async (_label, overrides) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow(overrides) })
    const response = await call(supabase)
    expect(response.status).toBe(404)
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it("returns 404 when the order's store is no longer connected", async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow() })
    serviceReturning({ data: null })
    const response = await call(supabase)
    expect(response.status).toBe(404)
    expect(fetchOrderContact).not.toHaveBeenCalled()
  })

  it('answers with the billing contact and writes nothing', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow() })
    const service = serviceReturning({ data: connectionRow() })
    vi.mocked(fetchOrderContact).mockResolvedValue({
      name: 'Anna Andersson',
      company: 'Kund AB',
      email: 'kund@example.se',
      withheld: [],
    })

    const response = await call(supabase)
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(body).toEqual({
      name: 'Anna Andersson',
      company: 'Kund AB',
      email: 'kund@example.se',
      withheld: [],
    })
    // The order's own Shopify id, against the order's own store.
    expect(fetchOrderContact).toHaveBeenCalledWith(expect.anything(), '1001')
    expect(createShopifySession).toHaveBeenCalledWith({
      shopDomain: 'minbutik.myshopify.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
    })
    expect(service.findCall('shopify_connections', 'eq')).toEqual(['company_id', 'company-1'])
    expect(service.findCalls('shopify_connections', 'eq')).toContainEqual([
      'shop_domain',
      'minbutik.myshopify.com',
    ])
    // Read-only: the order row keeps carrying no names (crm#1032).
    const writes = [...calls, ...service.calls].filter((c) =>
      ['insert', 'update', 'upsert', 'delete'].includes(c.method),
    )
    expect(writes).toEqual([])
  })

  it('passes withheld fields through as nulls the dialog can explain', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow() })
    serviceReturning({ data: connectionRow() })
    vi.mocked(fetchOrderContact).mockResolvedValue({
      name: null,
      company: null,
      email: null,
      withheld: ['name', 'company', 'email'],
    })

    const { status, body } = await parseJsonResponse<{ withheld: string[]; name: unknown }>(
      await call(supabase),
    )

    expect(status).toBe(200)
    expect(body.name).toBeNull()
    expect(body.withheld).toEqual(['name', 'company', 'email'])
  })

  it('returns 404 when the store no longer has the order', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow() })
    serviceReturning({ data: connectionRow() })
    vi.mocked(fetchOrderContact).mockResolvedValue(null)

    const response = await call(supabase)
    expect(response.status).toBe(404)
  })

  it('returns 502 when Shopify fails, without touching the connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: shopifyOrderRow() })
    const service = serviceReturning({ data: connectionRow() })
    vi.mocked(fetchOrderContact).mockRejectedValue(new ShopifyApiError('Shopify API 503', 503))

    const response = await call(supabase)

    expect(response.status).toBe(502)
    expect(service.calls.filter((c) => c.method === 'update')).toEqual([])
  })
})
