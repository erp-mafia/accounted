/**
 * Tests for POST /api/billing/checkout.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking
 * auth/company, the Stripe client, and the service-role Supabase client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

// Keep sandboxBlockedResponse real; stub only the DB-backed guardSandbox so the
// route's company_settings read doesn't need a live supabase mock.
const guardSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return { ...actual, guardSandbox: (...args: unknown[]) => guardSandboxMock(...args) }
})

const customersCreate = vi.fn()
const sessionsCreate = vi.fn()
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    customers: { create: customersCreate },
    checkout: { sessions: { create: sessionsCreate } },
  }),
  priceIdForPlan: vi.fn().mockReturnValue('price_123'),
}))

import { POST } from '../checkout/route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  guardSandboxMock.mockResolvedValue(null)
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'u@example.com', is_anonymous: false },
    supabase: {},
    error: null,
  })
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
})
