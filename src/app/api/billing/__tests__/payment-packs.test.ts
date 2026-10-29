/**
 * Tests for GET and POST /api/billing/payment-packs (issue #132).
 *
 * Through the real withRouteContext wrapper, with auth, the company, the
 * Stripe client and both Supabase clients mocked. The Stripe side of a
 * change (now or at the period end) is lib/stripe/payment-packs.ts's own
 * unit; here: who may buy, what is refused before Stripe is asked, and that
 * an increase reaches the cap at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const COMPANY = 'company-1'

const user = createTableMockSupabase()
const service = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => service.supabase,
}))

const guardSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return {
    ...actual,
    guardSandbox: (...args: unknown[]) => guardSandboxMock(...args),
    isSandboxCompany: vi.fn().mockResolvedValue(false),
  }
})

const subscriptionsRetrieve = vi.fn()
const subscriptionsUpdate = vi.fn()
const pricesRetrieve = vi.fn()
const schedulesCreate = vi.fn()
const schedulesUpdate = vi.fn()
const schedulesRelease = vi.fn()
vi.mock('@/lib/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/client')>()),
  getStripe: () => ({
    subscriptions: { retrieve: subscriptionsRetrieve, update: subscriptionsUpdate },
    prices: { retrieve: pricesRetrieve },
    subscriptionSchedules: { create: schedulesCreate, update: schedulesUpdate, release: schedulesRelease, retrieve: vi.fn() },
  }),
}))

import { GET, POST } from '../payment-packs/route'

const routeParams = { params: Promise.resolve({}) }

function liveSubscription(packs: number) {
  return {
    id: 'sub_1',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    items: {
      data: [
        ...(packs > 0 ? [{ id: 'si_pack', price: { id: 'price_pack' }, quantity: packs, current_period_end: 1_793_000_000 }] : []),
        { id: 'si_plan', price: { id: 'price_month', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1, current_period_end: 1_793_000_000 },
      ],
    },
  }
}

function signedInAs(role: string) {
  user.setTable('company_members', { data: { role } })
}

function post(body: unknown) {
  return POST(createMockRequest('/api/billing/payment-packs', { method: 'POST', body }), routeParams)
}

beforeEach(() => {
  vi.clearAllMocks()
  user.reset()
  service.reset()
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_x')
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_month')
  vi.stubEnv('STRIPE_PRICE_YEARLY', 'price_year')
  vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', 'price_pack')
  // Bank payments open to every company: the pilot switch, not the plan read.
  vi.stubEnv('OPENPAYMENTS_COMPANY_IDS', '*')
  guardSandboxMock.mockResolvedValue(null)
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'owner@example.com', is_anonymous: false },
    supabase: user.supabase,
    error: null,
  })
  signedInAs('owner')
  service.setTable('company_subscriptions', { data: { stripe_subscription_id: 'sub_1', status: 'active' } })
  service.setTable('company_bank_payment_allowances', { data: { monthly_payments: null, purchased_packs: 1 } })
  user.setTable('company_bank_payment_allowances', { data: null })
  pricesRetrieve.mockResolvedValue({ id: 'price_pack', currency: 'sek', unit_amount: 19900, recurring: { interval: 'month', interval_count: 1 } })
})

afterEach(() => vi.unstubAllEnvs())

describe('POST /api/billing/payment-packs', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await post({ packs: 1 })
    expect(res.status).toBe(401)
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('refuses everyone but the owner with 403, before Stripe is asked', async () => {
    for (const role of ['admin', 'member', 'viewer']) {
      signedInAs(role)
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post({ packs: 1 }))
      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.message).toBe('Bara företagets ägare kan köpa fler betalningar.')
    }
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('returns 400 for a body that is not a whole number of packs within the limit', async () => {
    for (const body of [{}, { packs: -1 }, { packs: 1.5 }, { packs: 101 }, { packs: '2' }]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('refuses with 409 PAYMENT_PACKS_NOT_OFFERED while no pack price is set (self-host, or before the founder creates it)', async () => {
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', '')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ packs: 1 }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_PACKS_NOT_OFFERED')
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('refuses with 409 when the company has no subscription, or Stripe says it is not active (a trial)', async () => {
    service.setTable('company_subscriptions', { data: null })
    const none = await parseJsonResponse<{ error: { code: string } }>(await post({ packs: 1 }))
    expect(none.status).toBe(409)
    expect(none.body.error.code).toBe('PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE')
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()

    service.setTable('company_subscriptions', { data: { stripe_subscription_id: 'sub_1', status: 'active' } })
    subscriptionsRetrieve.mockResolvedValue({ ...liveSubscription(0), status: 'trialing' })
    const trial = await parseJsonResponse<{ error: { code: string } }>(await post({ packs: 1 }))
    expect(trial.status).toBe(409)
    expect(trial.body.error.code).toBe('PAYMENT_PACKS_SUBSCRIPTION_NOT_ACTIVE')
    expect(subscriptionsUpdate).not.toHaveBeenCalled()
  })

  it('blocks a demo (anonymous) user before anything else', async () => {
    requireAuthMock.mockResolvedValue({ user: { id: 'anon', is_anonymous: true }, supabase: user.supabase, error: null })
    const res = await post({ packs: 1 })
    expect(res.status).toBe(403)
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('raises the packs now, charged now, and writes the new count to the cap at once', async () => {
    subscriptionsRetrieve.mockResolvedValue(liveSubscription(0))
    subscriptionsUpdate.mockResolvedValue(liveSubscription(1))

    const { status, body } = await parseJsonResponse<{ data: { included_payments: number; scheduled: unknown } }>(await post({ packs: 1 }))

    expect(status).toBe(200)
    expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_1', {
      items: [{ price: 'price_pack', quantity: 1 }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
    })
    // The webhook's own write, with the quantity Stripe returned.
    expect(service.payloads('company_bank_payment_allowances', 'upsert')).toEqual([{ company_id: COMPANY, purchased_packs: 1 }])
    expect(body.data).toEqual({ included_payments: 110, scheduled: null })
  })

  it('answers 402 and changes nothing when the card is declined', async () => {
    subscriptionsRetrieve.mockResolvedValue(liveSubscription(0))
    subscriptionsUpdate.mockRejectedValue(Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', statusCode: 402 }))

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ packs: 2 }))

    expect(status).toBe(402)
    expect(body.error.code).toBe('PAYMENT_PACKS_PAYMENT_FAILED')
    expect(service.payloads('company_bank_payment_allowances', 'upsert')).toEqual([])
  })
})

describe('GET /api/billing/payment-packs', () => {
  it('lets the owner of an active subscription buy, with the price and the breakdown of the cap', async () => {
    user.setTable('company_bank_payment_allowances', { data: { monthly_payments: null, purchased_packs: 2 } })
    subscriptionsRetrieve.mockResolvedValue(liveSubscription(2))

    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await GET(createMockRequest('/api/billing/payment-packs'), routeParams))

    expect(status).toBe(200)
    expect(body.data).toEqual({
      offered: true,
      can_buy: true,
      pack_size: 100,
      max_packs: 100,
      base_payments: 10,
      packs: 2,
      included_payments: 210,
      pack_price_ex_vat: 199,
      scheduled: null,
      period_end: new Date(1_793_000_000 * 1000).toISOString(),
    })
  })

  it('shows a member the packs but not the purchase, and never asks Stripe', async () => {
    signedInAs('member')
    user.setTable('company_bank_payment_allowances', { data: { monthly_payments: 40, purchased_packs: 1 } })

    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await GET(createMockRequest('/api/billing/payment-packs'), routeParams))

    expect(body.data).toMatchObject({ offered: true, can_buy: false, base_payments: 40, packs: 1, included_payments: 140, pack_price_ex_vat: null })
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
    expect(pricesRetrieve).not.toHaveBeenCalled()
  })

  it('offers nothing while the pack price is unset, so the pay dialogs keep Begär fler', async () => {
    vi.stubEnv('STRIPE_PRICE_PAYMENTS_PACK', '')

    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await GET(createMockRequest('/api/billing/payment-packs'), routeParams))

    expect(body.data).toMatchObject({ offered: false, can_buy: false, included_payments: 10 })
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })
})
