/**
 * Tests for POST /api/billing/portal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceSupabase,
}))

// Keep sandboxBlockedResponse real; stub only the DB-backed guardSandbox.
const guardSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return { ...actual, guardSandbox: (...args: unknown[]) => guardSandboxMock(...args) }
})

// Stripe as it stood on 2026-11-02: one configuration, the account default,
// whose plan list still offered the pre-raise prices. The portal module is
// real, so these tests open the session the way production does.
const portalCreate = vi.fn()
const configurationsCreate = vi.fn()
const defaultConfiguration = {
  id: 'bpc_default',
  metadata: {},
  features: {
    subscription_update: {
      enabled: true,
      products: [{ product: 'prod_plan', prices: ['price_old_199', 'price_old_1999'] }],
    },
  },
}
vi.mock('@/lib/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/client')>()),
  getStripe: () => ({
    billingPortal: {
      sessions: { create: portalCreate },
      configurations: {
        list: () => (async function* () { yield defaultConfiguration })(),
        create: configurationsCreate,
      },
    },
    prices: { retrieve: async (id: string) => ({ id, product: 'prod_plan' }) },
  }),
}))

import { POST } from '../portal/route'

const routeParams = { params: Promise.resolve({}) }

// The trusted-origin resolver reads the brands table; pin one registered
// brand host so the return-URL tests exercise the real resolver logic.
const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

const originalEnv = {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  STRIPE_PRICE_MONTHLY: process.env.STRIPE_PRICE_MONTHLY,
  STRIPE_PRICE_YEARLY: process.env.STRIPE_PRICE_YEARLY,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
  process.env.STRIPE_PRICE_MONTHLY = 'price_249'
  process.env.STRIPE_PRICE_YEARLY = 'price_2388'
  configurationsCreate.mockResolvedValue({ id: 'bpc_checkout_prices' })
  resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
    brand: host === 'portal.brand.test' ? { domain: host } : null,
    lookupFailed: false,
  }))
  guardSandboxMock.mockResolvedValue(null)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', is_anonymous: false }, supabase: {}, error: null })
})

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('POST /api/billing/portal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/billing/portal', { method: 'POST', body: {} })
    const res = await POST(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('blocks an anonymous (demo) user with 403 and never touches Stripe', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'anon-1', is_anonymous: true },
      supabase: {},
      error: null,
    })

    const req = createMockRequest('/api/billing/portal', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ sandbox_blocked?: boolean }>(
      await POST(req, routeParams),
    )

    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(portalCreate).not.toHaveBeenCalled()
    expect(guardSandboxMock).not.toHaveBeenCalled()
  })

  it('blocks a sandbox company with 403 and never touches Stripe', async () => {
    const { sandboxBlockedResponse } = await import('@/lib/sandbox/guard')
    guardSandboxMock.mockResolvedValue(sandboxBlockedResponse())

    const req = createMockRequest('/api/billing/portal', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ sandbox_blocked?: boolean }>(
      await POST(req, routeParams),
    )

    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(guardSandboxMock).toHaveBeenCalledWith(expect.anything(), 'company-1')
    expect(portalCreate).not.toHaveBeenCalled()
  })

  it('returns 400 with NO_SUBSCRIPTION when the company has no Stripe customer', async () => {
    enqueue({ data: null })

    const req = createMockRequest('/api/billing/portal', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(req, routeParams)
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('NO_SUBSCRIPTION')
    expect(portalCreate).not.toHaveBeenCalled()
  })

  it('returns the portal URL for a company with a Stripe customer', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1' } })
    portalCreate.mockResolvedValue({ url: 'https://stripe.test/portal' })

    const req = createMockRequest('/api/billing/portal', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ url: string }>(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(body.url).toBe('https://stripe.test/portal')
    expect(portalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1' })
    )
  })

  // 2026-11-02: a customer on 249 a month switched to yearly in the portal and
  // was put on the old 1 999 a year, the default configuration's price.
  it('opens the portal on a configuration offering only the checkout prices, never the default one', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1' } })
    portalCreate.mockResolvedValue({ url: 'https://stripe.test/portal' })

    const { status } = await parseJsonResponse(
      await POST(createMockRequest('/api/billing/portal', { method: 'POST' }), routeParams),
    )

    expect(status).toBe(200)
    expect(portalCreate).toHaveBeenCalledWith(expect.objectContaining({ configuration: 'bpc_checkout_prices' }))
    expect(configurationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          subscription_update: expect.objectContaining({
            products: [expect.objectContaining({ prices: ['price_249', 'price_2388'] })],
          }),
        }),
      }),
    )
  })

  describe('return URL', () => {
    function portalFrom(url: string) {
      enqueue({ data: { stripe_customer_id: 'cus_1' } })
      portalCreate.mockResolvedValue({ url: 'https://stripe.test/portal' })
      return POST(createMockRequest(url, { method: 'POST' }), routeParams)
    }

    it('comes back to the canonical app when opened there', async () => {
      const { status } = await parseJsonResponse(
        await portalFrom('https://app.accounted.test/api/billing/portal'),
      )

      expect(status).toBe(200)
      expect(portalCreate).toHaveBeenCalledWith({
        customer: 'cus_1',
        return_url: 'https://app.accounted.test/settings/billing',
        locale: 'sv',
        configuration: 'bpc_checkout_prices',
      })
    })

    it('comes back to a registered white-label host when opened there', async () => {

      const { status } = await parseJsonResponse(
        await portalFrom('https://portal.brand.test/api/billing/portal'),
      )

      expect(status).toBe(200)
      expect(portalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ return_url: 'https://portal.brand.test/settings/billing' }),
      )
    })

    it('falls back to the canonical app for an unregistered or spoofed host', async () => {

      const { status } = await parseJsonResponse(
        await portalFrom('https://portal.brand.test.attacker.test/api/billing/portal'),
      )

      expect(status).toBe(200)
      expect(portalCreate).toHaveBeenCalledWith(
        expect.objectContaining({ return_url: 'https://app.accounted.test/settings/billing' }),
      )
    })
  })

  // Stripe's hosted portal speaks the app's language, not the browser's.
  describe('locale', () => {
    function portalWithCookie(cookie?: string) {
      enqueue({ data: { stripe_customer_id: 'cus_1' } })
      portalCreate.mockResolvedValue({ url: 'https://stripe.test/portal' })
      return POST(
        createMockRequest('/api/billing/portal', {
          method: 'POST',
          ...(cookie ? { headers: { cookie } } : {}),
        }),
        routeParams,
      )
    }

    it('opens in English when the app is in English', async () => {
      const { status } = await parseJsonResponse(
        await portalWithCookie('gnubok-company-id=company-1; gnubok-locale=en'),
      )

      expect(status).toBe(200)
      expect(portalCreate).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
    })

    it('opens in Swedish when the app is in Swedish', async () => {
      await portalWithCookie('gnubok-locale=sv')
      expect(portalCreate).toHaveBeenCalledWith(expect.objectContaining({ locale: 'sv' }))
    })

    it('falls back to Swedish without a locale cookie or with an unsupported one', async () => {
      await portalWithCookie()
      await portalWithCookie('gnubok-locale=de')

      expect(portalCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ locale: 'sv' }))
      expect(portalCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ locale: 'sv' }))
    })
  })
})
