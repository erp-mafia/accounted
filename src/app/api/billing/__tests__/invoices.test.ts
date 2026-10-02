/**
 * Tests for GET /api/billing/invoices.
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

const isSandboxCompanyMock = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: (...args: unknown[]) => isSandboxCompanyMock(...args),
}))

const invoicesList = vi.fn()
const isStripeConfiguredMock = vi.fn()
vi.mock('@/lib/stripe/client', () => ({
  getStripe: () => ({ invoices: { list: invoicesList } }),
  isStripeConfigured: () => isStripeConfiguredMock(),
}))

import { GET } from '../invoices/route'

const routeParams = { params: Promise.resolve({}) }

function get() {
  return GET(createMockRequest('/api/billing/invoices'), routeParams)
}

function stripeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'in_1',
    number: 'ABC-0001',
    created: 1_767_225_600, // 2026-01-01T00:00:00Z
    amount_paid: 249875,
    amount_due: 249875,
    currency: 'sek',
    status: 'paid',
    description: null,
    lines: { data: [{ description: '1 × Accounted (at 1 999,00 kr / year)' }] },
    invoice_pdf: 'https://pay.stripe.test/in_1/pdf',
    hosted_invoice_url: 'https://invoice.stripe.test/in_1',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  isStripeConfiguredMock.mockReturnValue(true)
  isSandboxCompanyMock.mockResolvedValue(false)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', is_anonymous: false }, supabase: {}, error: null })
})

describe('GET /api/billing/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await get()
    expect(res.status).toBe(401)
    expect(invoicesList).not.toHaveBeenCalled()
  })

  it('returns an empty list when Stripe is not configured', async () => {
    isStripeConfiguredMock.mockReturnValue(false)

    const { status, body } = await parseJsonResponse<{ invoices: unknown[] }>(await get())

    expect(status).toBe(200)
    expect(body.invoices).toEqual([])
    expect(invoicesList).not.toHaveBeenCalled()
  })

  it('never contacts Stripe for a sandbox company', async () => {
    isSandboxCompanyMock.mockResolvedValue(true)
    enqueue({ data: { stripe_customer_id: 'cus_stray' } })

    const { status, body } = await parseJsonResponse<{ invoices: unknown[] }>(await get())

    expect(status).toBe(200)
    expect(body.invoices).toEqual([])
    expect(invoicesList).not.toHaveBeenCalled()
  })

  it('returns an empty list when the company has no Stripe customer', async () => {
    enqueue({ data: null })

    const { status, body } = await parseJsonResponse<{ invoices: unknown[] }>(await get())

    expect(status).toBe(200)
    expect(body.invoices).toEqual([])
    expect(invoicesList).not.toHaveBeenCalled()
  })

  it('maps the customer invoices to kronor and skips drafts and voided ones', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1' } })
    invoicesList.mockResolvedValue({
      data: [
        stripeInvoice(),
        stripeInvoice({ id: 'in_draft', status: 'draft' }),
        stripeInvoice({ id: 'in_void', status: 'void' }),
        stripeInvoice({
          id: 'in_open',
          number: null,
          status: 'open',
          amount_paid: 0,
          amount_due: 24875,
          description: 'Månadsabonnemang',
          invoice_pdf: null,
          hosted_invoice_url: null,
        }),
      ],
    })

    const { status, body } = await parseJsonResponse<{ invoices: Array<Record<string, unknown>> }>(await get())

    expect(status).toBe(200)
    expect(invoicesList).toHaveBeenCalledWith({ customer: 'cus_1', limit: 24 })
    expect(body.invoices).toEqual([
      {
        id: 'in_1',
        number: 'ABC-0001',
        created: '2026-01-01T00:00:00.000Z',
        amountPaid: 2498.75,
        currency: 'sek',
        status: 'paid',
        description: '1 × Accounted (at 1 999,00 kr / year)',
        pdfUrl: 'https://pay.stripe.test/in_1/pdf',
        hostedUrl: 'https://invoice.stripe.test/in_1',
      },
      {
        id: 'in_open',
        number: null,
        created: '2026-01-01T00:00:00.000Z',
        amountPaid: 248.75,
        currency: 'sek',
        status: 'open',
        description: 'Månadsabonnemang',
        pdfUrl: null,
        hostedUrl: null,
      },
    ])
  })

  it('answers with the canonical error envelope when Stripe fails', async () => {
    enqueue({ data: { stripe_customer_id: 'cus_1' } })
    invoicesList.mockRejectedValue(new Error('Stripe is down'))

    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await get())

    expect(status).toBeGreaterThanOrEqual(500)
    expect(body.error.code).toEqual(expect.any(String))
    expect(body.error.message).toEqual(expect.any(String))
  })
})
