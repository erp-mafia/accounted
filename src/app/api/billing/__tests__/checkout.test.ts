/**
 * Tests for POST /api/billing/checkout.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking
 * auth/company, the Stripe client, and the service-role Supabase client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase: serviceSupabase, enqueue, reset } = createQueuedMockSupabase()
// The user-scoped client: the company identity is read under RLS. Left empty,
// every read resolves to no row and nothing is prefilled.
const {
  supabase: userSupabase,
  enqueue: enqueueUser,
  reset: resetUser,
} = createQueuedMockSupabase()

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

// Keep sandboxBlockedResponse real; stub only the DB-backed guardSandbox so the
// route's company_settings read doesn't need a live supabase mock.
const guardSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return { ...actual, guardSandbox: (...args: unknown[]) => guardSandboxMock(...args) }
})

const customersCreate = vi.fn()
const customersUpdate = vi.fn()
const listTaxIds = vi.fn()
const createTaxId = vi.fn()
const sessionsCreate = vi.fn()
const subscriptionsList = vi.fn()
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    customers: { create: customersCreate, update: customersUpdate, listTaxIds, createTaxId },
    checkout: { sessions: { create: sessionsCreate } },
    subscriptions: { list: subscriptionsList },
  }),
  priceIdForPlan: vi.fn().mockReturnValue('price_123'),
}))

import { POST } from '../checkout/route'

const routeParams = { params: Promise.resolve({}) }

// The trusted-origin resolver reads the brands table; pin one registered
// brand host so the return-URL tests exercise the real resolver logic.
const resolveBrandResultByHostMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/branding/resolve', () => ({
  resolveBrandResultByHost: (...args: unknown[]) => resolveBrandResultByHostMock(...args),
}))

const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  resetUser()
  customersUpdate.mockResolvedValue({})
  listTaxIds.mockResolvedValue({ data: [] })
  createTaxId.mockResolvedValue({})
  subscriptionsList.mockResolvedValue({ data: [] })
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.accounted.test'
  resolveBrandResultByHostMock.mockImplementation(async (host: string) => ({
    brand: host === 'portal.brand.test' ? { domain: host } : null,
    lookupFailed: false,
  }))
  guardSandboxMock.mockResolvedValue(null)
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'u@example.com', is_anonymous: false },
    supabase: userSupabase,
    error: null,
  })
})

afterEach(() => {
  if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL
  else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
})

describe('POST /api/billing/checkout', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const res = await POST(req, routeParams)
    expect(res.status).toBe(401)
  })

  it('blocks an anonymous (demo) user with 403 and never touches Stripe', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'anon-1', email: null, is_anonymous: true },
      supabase: {},
      error: null,
    })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ sandbox_blocked?: boolean }>(
      await POST(req, routeParams),
    )

    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(customersCreate).not.toHaveBeenCalled()
    expect(sessionsCreate).not.toHaveBeenCalled()
    // The cheap identity check short-circuits before the DB-backed guard.
    expect(guardSandboxMock).not.toHaveBeenCalled()
  })

  it('blocks a sandbox company with 403 and never touches Stripe', async () => {
    const { sandboxBlockedResponse } = await import('@/lib/sandbox/guard')
    guardSandboxMock.mockResolvedValue(sandboxBlockedResponse())

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: { plan: 'monthly' } })
    const { status, body } = await parseJsonResponse<{ sandbox_blocked?: boolean }>(
      await POST(req, routeParams),
    )

    expect(status).toBe(403)
    expect(body.sandbox_blocked).toBe(true)
    expect(guardSandboxMock).toHaveBeenCalledWith(expect.anything(), 'company-1')
    expect(customersCreate).not.toHaveBeenCalled()
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('rejects an unknown plan with 400', async () => {
    const req = createMockRequest('/api/billing/checkout', {
      method: 'POST',
      body: { plan: 'weekly' },
    })

    const { status } = await parseJsonResponse(await POST(req, routeParams))

    expect(status).toBe(400)
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  it('reuses an existing Stripe customer and returns the checkout URL', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: null }) // no trial grant
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', {
      method: 'POST',
      body: { plan: 'yearly' },
    })

    const { status, body } = await parseJsonResponse<{ url: string }>(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(body.url).toBe('https://stripe.test/session')
    expect(customersCreate).not.toHaveBeenCalled()
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        client_reference_id: 'company-1',
      })
    )
    // No trial grant → billing starts immediately, no Stripe trial.
    expect(sessionsCreate.mock.calls[0][0].subscription_data.trial_end).toBeUndefined()
  })

  // crm#1373: Stripe lets a customer hold any number of subscriptions, so a
  // second checkout started a second subscription that charged alongside the
  // first. One subscription per company, asked of Stripe itself.
  describe('one subscription per company', () => {
    it('refuses (409) a checkout for a company that already pays, and opens no session', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: 'sub_monthly' } })
      enqueue({ data: null }) // no trial grant
      subscriptionsList.mockResolvedValue({
        data: [{ id: 'sub_monthly', status: 'active', metadata: { company_id: 'company-1' } }],
      })

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: { plan: 'yearly' } })
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(
        await POST(req, routeParams),
      )

      expect(status).toBe(409)
      expect(body.error.code).toBe('SUBSCRIPTION_EXISTS')
      expect(body.error.message).toContain('Hantera abonnemang')
      expect(subscriptionsList).toHaveBeenCalledWith({ customer: 'cus_existing', limit: 100 })
      expect(sessionsCreate).not.toHaveBeenCalled()
      expect(customersUpdate).not.toHaveBeenCalled()
    })

    it('refuses while the webhook has not mirrored a subscription paid a moment ago', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: null } })
      enqueue({ data: null }) // no trial grant
      subscriptionsList.mockResolvedValue({
        data: [{ id: 'sub_just_paid', status: 'trialing', metadata: { company_id: 'company-1' } }],
      })

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: { plan: 'monthly' } })
      const { status } = await parseJsonResponse(await POST(req, routeParams))

      expect(status).toBe(409)
      expect(sessionsCreate).not.toHaveBeenCalled()
    })

    it('lets a company whose subscription ended subscribe again', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: 'sub_old' } })
      enqueue({ data: null }) // no trial grant
      subscriptionsList.mockResolvedValue({ data: [] }) // Stripe lists no live subscription
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: { plan: 'monthly' } })
      const { status } = await parseJsonResponse(await POST(req, routeParams))

      expect(status).toBe(200)
      expect(sessionsCreate).toHaveBeenCalledTimes(1)
    })

    it('lets an owner retry after an unpaid first attempt', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing', stripe_subscription_id: 'sub_3ds' } })
      enqueue({ data: null }) // no trial grant
      subscriptionsList.mockResolvedValue({
        data: [{ id: 'sub_3ds', status: 'incomplete', metadata: { company_id: 'company-1' } }],
      })
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
      const { status } = await parseJsonResponse(await POST(req, routeParams))

      expect(status).toBe(200)
    })

    it('asks Stripe nothing extra for a company without a customer yet', async () => {
      enqueue({ data: null }) // no subscription row
      enqueue({ data: null }) // no trial grant
      enqueue({ data: null }) // upsert result
      customersCreate.mockResolvedValue({ id: 'cus_new' })
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
      const { status } = await parseJsonResponse(await POST(req, routeParams))

      expect(status).toBe(200)
      expect(subscriptionsList).not.toHaveBeenCalled()
    })

    it('fails (500) without a session when the customer lookup errors', async () => {
      enqueue({ data: null, error: { message: 'boom' } }) // subscription row read fails
      enqueue({ data: null }) // no trial grant

      const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
      const res = await POST(req, routeParams)

      expect(res.status).toBe(500)
      expect(customersCreate).not.toHaveBeenCalled()
      expect(sessionsCreate).not.toHaveBeenCalled()
    })
  })

  it('enables automatic VAT, tax-id collection and address capture on the session', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: null }) // no trial grant
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: { plan: 'monthly' } })
    await POST(req, routeParams)

    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        billing_address_collection: 'required',
        customer_update: { name: 'auto', address: 'auto' },
      }),
    )
  })

  it('creates a Stripe customer when none exists yet', async () => {
    enqueue({ data: null }) // no existing subscription row
    enqueue({ data: null }) // no trial grant
    enqueue({ data: null }) // upsert result
    customersCreate.mockResolvedValue({ id: 'cus_new' })
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ url: string }>(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(body.url).toBe('https://stripe.test/session')
    expect(customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { company_id: 'company-1' } })
    )
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_new' })
    )
  })

  it('defers the first charge to the trial end when the trial has >48h left', async () => {
    const trialEnd = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString()
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: { expires_at: trialEnd } }) // active trial grant
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status } = await parseJsonResponse(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: expect.objectContaining({
          metadata: { company_id: 'company-1' },
          trial_end: Math.floor(new Date(trialEnd).getTime() / 1000),
        }),
      })
    )
  })

  it('bills immediately when the trial is inside the 48h Stripe floor', async () => {
    const trialEnd = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: { expires_at: trialEnd } }) // trial ends tomorrow
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status } = await parseJsonResponse(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(sessionsCreate.mock.calls[0][0].subscription_data.trial_end).toBeUndefined()
  })

  it('bills immediately when the trial has already expired', async () => {
    const trialEnd = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: { expires_at: trialEnd } }) // lapsed trial
    sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status } = await parseJsonResponse(await POST(req, routeParams))

    expect(status).toBe(200)
    expect(sessionsCreate.mock.calls[0][0].subscription_data.trial_end).toBeUndefined()
  })

  it('fails closed (500, no Stripe session) when the trial lookup errors', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
    enqueue({ data: null, error: { message: 'boom' } }) // trial lookup fails

    const req = createMockRequest('/api/billing/checkout', { method: 'POST', body: {} })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await POST(req, routeParams),
    )

    expect(status).toBe(500)
    expect(body.error.code).toBe('TRIAL_LOOKUP_FAILED')
    expect(sessionsCreate).not.toHaveBeenCalled()
  })

  describe('return URLs', () => {
    function checkoutFrom(url: string) {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })
      return POST(createMockRequest(url, { method: 'POST', body: {} }), routeParams)
    }

    it('returns to the canonical app when checkout starts there', async () => {
      const { status } = await parseJsonResponse(
        await checkoutFrom('https://app.accounted.test/api/billing/checkout'),
      )

      expect(status).toBe(200)
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: 'https://app.accounted.test/settings/billing?success=1',
          cancel_url: 'https://app.accounted.test/settings/billing?canceled=1',
        }),
      )
    })

    it('returns to a registered white-label host when checkout starts there', async () => {

      const { status } = await parseJsonResponse(
        await checkoutFrom('https://portal.brand.test/api/billing/checkout'),
      )

      expect(status).toBe(200)
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: 'https://portal.brand.test/settings/billing?success=1',
          cancel_url: 'https://portal.brand.test/settings/billing?canceled=1',
        }),
      )
    })

    it('falls back to the canonical app for an unregistered or spoofed host', async () => {

      const { status } = await parseJsonResponse(
        await checkoutFrom('https://portal.brand.test.attacker.test/api/billing/checkout'),
      )

      expect(status).toBe(200)
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: 'https://app.accounted.test/settings/billing?success=1',
          cancel_url: 'https://app.accounted.test/settings/billing?canceled=1',
        }),
      )
    })
  })

  // Stripe Checkout speaks the app's language, not the browser's.
  describe('locale', () => {
    function checkoutWithCookie(cookie?: string) {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })
      return POST(
        createMockRequest('/api/billing/checkout', {
          method: 'POST',
          body: { plan: 'monthly' },
          ...(cookie ? { headers: { cookie } } : {}),
        }),
        routeParams,
      )
    }

    it('opens in English when the app is in English', async () => {
      const { status } = await parseJsonResponse(
        await checkoutWithCookie('gnubok-company-id=company-1; gnubok-locale=en'),
      )

      expect(status).toBe(200)
      expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }))
    })

    it('opens in Swedish when the app is in Swedish', async () => {
      await checkoutWithCookie('gnubok-locale=sv')
      expect(sessionsCreate).toHaveBeenCalledWith(expect.objectContaining({ locale: 'sv' }))
    })

    it('falls back to Swedish without a locale cookie or with an unsupported one', async () => {
      await checkoutWithCookie()
      await checkoutWithCookie('gnubok-locale=de')

      expect(sessionsCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({ locale: 'sv' }))
      expect(sessionsCreate).toHaveBeenNthCalledWith(2, expect.objectContaining({ locale: 'sv' }))
    })
  })

  // PH 191: the logged-in company's identity goes onto the Stripe customer, so
  // Checkout does not ask for it again and the receipt carries it.
  describe('company identity prefill', () => {
    const ADDRESS = { line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm', country: 'SE' }

    function companyRows(kind: 'ab' | 'ef') {
      if (kind === 'ab') {
        enqueueUser({ data: { name: 'Bolaget AB', org_number: '5566778899', entity_type: 'aktiebolag' } })
        enqueueUser({
          data: {
            entity_type: 'aktiebolag',
            company_name: 'Bolaget AB',
            org_number: '5566778899',
            address_line1: 'Storgatan 1',
            address_line2: null,
            postal_code: '111 22',
            city: 'Stockholm',
            country: 'SE',
            vat_registered: true,
            vat_number: 'SE556677889901',
          },
        })
      } else {
        enqueueUser({ data: { name: 'Firma Test', org_number: '198001019994', entity_type: 'enskild_firma' } })
        enqueueUser({
          data: {
            entity_type: 'enskild_firma',
            company_name: 'Firma Test',
            org_number: '198001019994',
            address_line1: 'Storgatan 1',
            address_line2: null,
            postal_code: '111 22',
            city: 'Stockholm',
            country: 'SE',
            vat_registered: false,
            vat_number: null,
          },
        })
      }
    }

    function checkout() {
      sessionsCreate.mockResolvedValue({ url: 'https://stripe.test/session' })
      return POST(createMockRequest('/api/billing/checkout', { method: 'POST', body: {} }), routeParams)
    }

    it('creates the customer with the payer email, then adds name, address, org number and VAT id of a momsregistrerat AB', async () => {
      enqueue({ data: null }) // no subscription row
      enqueue({ data: null }) // no trial grant
      enqueue({ data: null }) // upsert result
      customersCreate.mockResolvedValue({ id: 'cus_new' })
      companyRows('ab')

      const { status } = await parseJsonResponse(await checkout())

      expect(status).toBe(200)
      expect(customersCreate).toHaveBeenCalledWith({ email: 'u@example.com', metadata: { company_id: 'company-1' } })
      expect(customersUpdate).toHaveBeenCalledWith('cus_new', {
        name: 'Bolaget AB',
        business_name: 'Bolaget AB',
        address: ADDRESS,
        tax: { validate_location: 'immediately' },
        invoice_settings: { custom_fields: [{ name: 'Org.nr', value: '556677-8899' }] },
      })
      // A just-created customer has no tax IDs to look up.
      expect(listTaxIds).not.toHaveBeenCalled()
      expect(createTaxId).toHaveBeenCalledWith(
        'cus_new',
        { type: 'eu_vat', value: 'SE556677889901' },
        { idempotencyKey: 'customer-tax-id:cus_new:SE556677889901' },
      )

      const session = sessionsCreate.mock.calls[0][0]
      expect(session.customer).toBe('cus_new')
      // Nothing to tick or type: no tax ID form, address taken from the customer.
      expect(session.tax_id_collection).toBeUndefined()
      expect(session.billing_address_collection).toBe('auto')
      expect(session.customer_update).toEqual({ name: 'never', address: 'never' })
      expect(session.automatic_tax).toEqual({ enabled: true })
    })

    it('updates a reused customer instead of creating one, and adds the VAT id only when it has none', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      companyRows('ab')

      const { status } = await parseJsonResponse(await checkout())

      expect(status).toBe(200)
      expect(customersCreate).not.toHaveBeenCalled()
      expect(customersUpdate).toHaveBeenCalledWith('cus_existing', expect.objectContaining({ name: 'Bolaget AB' }))
      expect(listTaxIds).toHaveBeenCalledWith('cus_existing', { limit: 1 })
      expect(createTaxId).toHaveBeenCalledWith(
        'cus_existing',
        { type: 'eu_vat', value: 'SE556677889901' },
        { idempotencyKey: 'customer-tax-id:cus_existing:SE556677889901' },
      )
      expect(sessionsCreate.mock.calls[0][0].customer).toBe('cus_existing')
    })

    it('keeps a tax ID the reused customer already has', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      companyRows('ab')
      listTaxIds.mockResolvedValue({ data: [{ id: 'txi_1', type: 'eu_vat', value: 'SE556677889901' }] })

      await checkout()

      expect(createTaxId).not.toHaveBeenCalled()
      expect(sessionsCreate.mock.calls[0][0].tax_id_collection).toBeUndefined()
    })

    it('adds no tax ID for an enskild firma without a VAT number and still lets Checkout collect one', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      companyRows('ef')

      await checkout()

      expect(listTaxIds).not.toHaveBeenCalled()
      expect(createTaxId).not.toHaveBeenCalled()
      // The owner's personnummer never goes on the invoice.
      expect(customersUpdate).toHaveBeenCalledWith('cus_existing', {
        name: 'Firma Test',
        business_name: 'Firma Test',
        address: ADDRESS,
        tax: { validate_location: 'immediately' },
      })
      const session = sessionsCreate.mock.calls[0][0]
      expect(session.tax_id_collection).toEqual({ enabled: true })
      expect(session.billing_address_collection).toBe('auto')
      expect(session.customer_update).toEqual({ name: 'auto', address: 'never' })
    })

    it('opens Checkout as before when the Stripe prefill fails', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      companyRows('ab')
      customersUpdate.mockRejectedValue(new Error('customer_tax_location_invalid'))

      const { status } = await parseJsonResponse(await checkout())

      expect(status).toBe(200)
      expect(createTaxId).not.toHaveBeenCalled()
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tax_id_collection: { enabled: true },
          billing_address_collection: 'required',
          customer_update: { name: 'auto', address: 'auto' },
        }),
      )
    })

    it('opens Checkout as before, touching no customer, when the company read fails', async () => {
      enqueue({ data: { stripe_customer_id: 'cus_existing' } }) // subscription row
      enqueue({ data: null }) // no trial grant
      enqueueUser({ data: null, error: { message: 'boom' } })
      enqueueUser({ data: null })

      const { status } = await parseJsonResponse(await checkout())

      expect(status).toBe(200)
      expect(customersUpdate).not.toHaveBeenCalled()
      expect(sessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tax_id_collection: { enabled: true },
          billing_address_collection: 'required',
          customer_update: { name: 'auto', address: 'auto' },
        }),
      )
    })
  })
})
