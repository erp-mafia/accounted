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

const invoicePdfMock = vi.fn().mockReturnValue('mock-pdf-element')
vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: (...args: unknown[]) => invoicePdfMock(...args),
}))

vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: vi.fn(async (company: unknown) => ({ branding: {}, company })),
  buildSwishQrDataUrl: vi.fn().mockResolvedValue(null),
  buildPaymentLinkQrDataUrl: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'
import type { InvoiceItem } from '@/types'
import type { InvoicePdfInvoice } from '@/lib/invoices/pdf-template'

/** The invoice + items the route handed to the PDF template on the last render. */
function lastRenderProps(): { invoice: InvoicePdfInvoice; items: InvoiceItem[] } {
  const call = invoicePdfMock.mock.calls.at(-1)
  if (!call) throw new Error('InvoicePDF was not called')
  return call[0] as { invoice: InvoicePdfInvoice; items: InvoiceItem[] }
}

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

  // ROT/RUT (issue #1686): the preview must state the same avdrag row, info
  // box and "Att betala" as the invoice the write path creates. The PDF
  // template reads invoice.deduction_total / deduction_personnummer_masked
  // and the per-item deduction fields, so those are what the route must carry.
  describe('ROT/RUT deduction', () => {
    const rutBody = {
      ...validBody,
      document_type: 'invoice',
      deduction_personnummer: '19900101-2385',
      deduction_housing_designation: 'Stockholm Kvarteret 1:2',
      items: [
        {
          description: 'Städning',
          quantity: 4,
          unit: 'tim',
          unit_price: 500,
          vat_rate: 25,
          deduction_type: 'rut',
          labor_hours: 4,
          work_type: 'STAD',
        },
        {
          description: 'Rengöringsmedel',
          quantity: 1,
          unit: 'st',
          unit_price: 200,
          vat_rate: 25,
        },
      ],
    }

    it('computes deduction_total from the posted items and carries the per-item fields', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: rutBody }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      // 4 x 500 = 2 000 exkl. moms = 2 500 inkl. 25% moms; RUT = 50% = 1 250.
      expect(invoice.deduction_total).toBe(1250)
      expect(invoice.total).toBe(2750)
      // Masked like the stored-invoice PDF and the payroll roster: birth
      // date visible, last four hidden. Neither the plaintext nor the last
      // four digits reach the template.
      expect(invoice.deduction_personnummer_masked).toBe('19900101-XXXX')
      expect(invoice).not.toHaveProperty('deduction_personnummer_last4')
      expect(invoice).not.toHaveProperty('deduction_personnummer_encrypted')
      expect(items[0]).toMatchObject({
        deduction_type: 'rut',
        deduction_amount: 1250,
        labor_hours: 4,
        work_type: 'STAD',
        housing_designation: 'Stockholm Kvarteret 1:2',
      })
      expect(items[1]).toMatchObject({ deduction_type: null, deduction_amount: 0, housing_designation: null })
    })

    it('uses the deduction base inkl. moms at the rate the line is rendered with', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      // Skatteverket worked example: 18 000 kr arbetskostnad = 22 500 kr inkl.
      // moms, ROT 30% = 6 750 kr.
      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', {
          method: 'POST',
          body: {
            ...rutBody,
            items: [{
              description: 'Målning',
              quantity: 1,
              unit: 'st',
              unit_price: 18000,
              vat_rate: 25,
              deduction_type: 'rot',
              labor_hours: 30,
              work_type: 'MALNING',
            }],
          },
        }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(invoice.deduction_total).toBe(6750)
      expect(items[0].deduction_amount).toBe(6750)
    })

    it('falls back to the kundkort personnummer of an individual customer, like the write path', async () => {
      enqueue({ data: company, error: null })
      enqueue({
        data: makeCustomer({ id: customer.id, customer_type: 'individual', personal_number: '900101-2385' }),
        error: null,
      })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', {
          method: 'POST',
          body: { ...rutBody, deduction_personnummer: '' },
        }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      // The 10-digit kundkort value is expanded to 12 digits before masking,
      // so the mask carries the full birth date.
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBe('19900101-XXXX')
    })

    it('masks a 10-digit typed personnummer with the full birth date', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', {
          method: 'POST',
          body: { ...rutBody, deduction_personnummer: '900101-2385' },
        }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBe('19900101-XXXX')
    })

    it('shows no personnummer for a half-typed value that does not expand', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', {
          method: 'POST',
          body: { ...rutBody, deduction_personnummer: '1990' },
        }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBeNull()
    })

    it('leaves a non-deduction invoice unchanged', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: validBody }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(invoice.deduction_total).toBe(0)
      expect(invoice.deduction_personnummer_masked).toBeNull()
      expect(invoice.total).toBe(17500)
      expect(items[0]).toMatchObject({ deduction_type: null, deduction_amount: 0 })
    })

    it('ignores deduction fields on non-invoice document types, like the write path', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', {
          method: 'POST',
          body: { ...rutBody, document_type: 'proforma' },
        }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(invoice.deduction_total).toBe(0)
      expect(invoice.deduction_personnummer_masked).toBeNull()
      expect(items[0]).toMatchObject({ deduction_type: null, deduction_amount: 0, work_type: null })
    })

    it('does not compute a deduction for a seller that is not VAT registered on VAT-free labor', async () => {
      enqueue({ data: { ...company, vat_registered: false }, error: null })
      enqueue({ data: customer, error: null })

      const response = await POST(
        createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body: rutBody }),
        createMockRouteParams({}),
      )

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      // Base is the line total inkl. moms; with no output VAT the base is the
      // bare 2 000 kr, RUT 50% = 1 000.
      expect(items[0].vat_rate).toBe(0)
      expect(items[0].deduction_amount).toBe(1000)
      expect(invoice.deduction_total).toBe(1000)
    })
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
