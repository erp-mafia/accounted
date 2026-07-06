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
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', email: 'u@example.com' },
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
    enqueue({ data: { stripe_customer_id: 'cus_existing' } })
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
  })

  it('creates a Stripe customer when none exists yet', async () => {
    enqueue({ data: null }) // no existing subscription row
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
})
