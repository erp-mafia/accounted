/**
 * Tests for POST /api/billing/portal.
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

// Keep sandboxBlockedResponse real; stub only the DB-backed guardSandbox.
const guardSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/sandbox/guard')>()
  return { ...actual, guardSandbox: (...args: unknown[]) => guardSandboxMock(...args) }
})

const portalCreate = vi.fn()
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({
    billingPortal: { sessions: { create: portalCreate } },
  }),
}))

import { POST } from '../portal/route'

const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  guardSandboxMock.mockResolvedValue(null)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', is_anonymous: false }, supabase: {}, error: null })
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
})
