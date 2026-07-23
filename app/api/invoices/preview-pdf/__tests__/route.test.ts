import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
} from '@/tests/helpers'
import { contentDispositionFilename } from '@/lib/api/content-disposition'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const renderToBufferMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderToBufferMock(...args),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue('mock-pdf-element'),
}))

vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: vi.fn(async (company: unknown) => ({ branding: {}, company })),
  buildSwishQrDataUrl: vi.fn().mockResolvedValue(null),
  buildPaymentLinkQrDataUrl: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

describe('POST /api/invoices/preview-pdf', () => {
  const user = { id: 'user-1', email: 'owner@example.test' }
  const customer = makeCustomer({ id: 'customer-1', name: 'Kund ÅÄÖ AB' })
  const company = makeCompanySettings({ company_name: 'Oppy Sverige', bankgiro: '123-4567' })
  const validBody = {
    customer_id: customer.id,
    invoice_number: '2621',
    invoice_date: '2026-07-21',
    due_date: '2026-08-20',
    currency: 'SEK',
    items: [{
      description: 'Konsulttjänst',
      quantity: 1,
      unit: 'st',
      unit_price: 14000,
      vat_rate: 25,
    }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
    renderToBufferMock.mockResolvedValue(Buffer.from('pdf-bytes'))
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: validBody }),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 when invoice rows are missing', async () => {
    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', {
        method: 'POST',
        body: { ...validBody, items: [] },
      }),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns 404 when the customer does not exist', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: validBody }),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns a descriptive UTF-8 filename for the PDF preview', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: validBody }),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('Oppy Sverige x Kund ÅÄÖ AB Faktura nr 2621 20260721.pdf')
  })

  it('returns 400 when a foreign payment account is missing', async () => {
    enqueue({ data: company, error: null })

    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', {
        method: 'POST',
        body: { ...validBody, currency: 'EUR' },
      }),
      createMockRouteParams({}),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(renderToBufferMock).not.toHaveBeenCalled()
    expect(mockSupabase.from).not.toHaveBeenCalledWith('customers')
  })

  it('marks preview generation errors as private and non-cacheable', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })
    renderToBufferMock.mockRejectedValueOnce(new Error('render failed'))

    const response = await POST(
      createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: validBody }),
      createMockRouteParams({}),
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
