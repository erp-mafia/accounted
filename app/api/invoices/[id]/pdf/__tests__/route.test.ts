import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeCompanySettings,
  makeCustomer,
  makeInvoice,
} from '@/tests/helpers'
import { contentDispositionFilename } from '@/lib/api/content-disposition'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const renderToBufferMock = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderToBufferMock(...args),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue('mock-pdf-element'),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
  SHOW_SWISH_ON_INVOICE: false,
}))

import { GET } from '../route'
import { InvoicePDF } from '@/lib/invoices/pdf-template'

describe('GET /api/invoices/[id]/pdf', () => {
  const user = { id: 'user-1', email: 'owner@example.test' }
  const customer = makeCustomer({ name: 'Kund ÅÄÖ AB' })
  const company = makeCompanySettings({ company_name: 'Oppy Sverige', bankgiro: '123-4567' })
  const invoice = makeInvoice({
    id: 'invoice-1',
    invoice_number: '2621',
    invoice_date: '2026-07-21',
    customer,
    items: [],
  })

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

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf'),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 404 when the invoice does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await GET(
      createMockRequest('/api/invoices/missing/pdf'),
      createMockRouteParams({ id: 'missing' }),
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns a descriptive UTF-8 filename for the PDF download', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf'),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(200)
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('Oppy Sverige x Kund ÅÄÖ AB Faktura nr 2621 20260721.pdf')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('forces a download by default', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf'),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/)
  })

  it('serves the PDF inline for in-browser review on ?disposition=inline (#1190)', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf', {
        searchParams: { disposition: 'inline' },
      }),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toMatch(/^inline;/)
    // The filename still travels with it, so the browser viewer's own save
    // action produces the same name as the download button would.
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('Oppy Sverige x Kund ÅÄÖ AB Faktura nr 2621 20260721.pdf')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('keeps the download behaviour for an unknown disposition value', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf', {
        searchParams: { disposition: 'evil' },
      }),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.headers.get('Content-Disposition')).toMatch(/^attachment;/)
  })

  it('returns 400 before rendering when a foreign payment account is missing', async () => {
    enqueue({ data: { ...invoice, currency: 'EUR' }, error: null })
    enqueue({ data: { ...company, invoice_payment_accounts: {} }, error: null })

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf'),
      createMockRouteParams({ id: 'invoice-1' }),
    )
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  // The in-app preview probes before pointing a tab at the inline URL, so a
  // refusal is shown as a message in the app instead of as raw JSON in the tab.
  describe('?probe=1', () => {
    it('answers 204 without rendering when the PDF would be served', async () => {
      enqueue({ data: invoice, error: null })
      enqueue({ data: company, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', {
          searchParams: { disposition: 'inline', probe: '1' },
        }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(204)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })

    it('returns the same refusal envelope the render would', async () => {
      enqueue({ data: { ...invoice, currency: 'EUR' }, error: null })
      enqueue({ data: { ...company, invoice_payment_accounts: {} }, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', {
          searchParams: { disposition: 'inline', probe: '1' },
        }),
        createMockRouteParams({ id: 'invoice-1' }),
      )
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.error.code).toBe('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')
      expect(body.error.details.currency).toBe('EUR')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })

    it('ignores any other probe value and renders', async () => {
      enqueue({ data: invoice, error: null })
      enqueue({ data: company, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', {
          searchParams: { probe: 'yes' },
        }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(200)
      expect(renderToBufferMock).toHaveBeenCalledTimes(1)
    })
  })

  // #1693: the betalningsbekräftelse variant. Same render, refused unless the
  // faktura is fully paid, named as a payment confirmation, archive untouched.
  describe('?variant=paid', () => {
    const paidInvoice = {
      ...invoice,
      status: 'paid',
      paid_amount: 12500,
      remaining_amount: 0,
      paid_at: '2026-08-17T12:00:00+00:00',
    }

    it('returns 401 when the caller is not authenticated', async () => {
      requireAuthMock.mockResolvedValue({
        user: null,
        supabase: mockSupabase,
        error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
      })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', { searchParams: { variant: 'paid' } }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(401)
    })

    it('returns 404 when the invoice does not exist', async () => {
      enqueue({ data: null, error: { message: 'not found' } })

      const response = await GET(
        createMockRequest('/api/invoices/missing/pdf', { searchParams: { variant: 'paid' } }),
        createMockRouteParams({ id: 'missing' }),
      )

      expect(response.status).toBe(404)
    })

    it.each(['sent', 'partially_paid', 'overdue', 'draft'])(
      'returns 409 without rendering when the invoice is %s',
      async (status) => {
        enqueue({ data: { ...invoice, status }, error: null })

        const response = await GET(
          createMockRequest('/api/invoices/invoice-1/pdf', { searchParams: { variant: 'paid' } }),
          createMockRouteParams({ id: 'invoice-1' }),
        )
        const body = await response.json()

        expect(response.status).toBe(409)
        expect(body.error.code).toBe('INVOICE_PAYMENT_CONFIRMATION_NOT_PAID')
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
        expect(renderToBufferMock).not.toHaveBeenCalled()
      },
    )

    it('refuses a paid credit note', async () => {
      enqueue({ data: { ...paidInvoice, credited_invoice_id: 'orig-1' }, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', { searchParams: { variant: 'paid' } }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(409)
    })

    it('renders the paid invoice and names the file as a betalningsbekräftelse', async () => {
      enqueue({ data: paidInvoice, error: null })
      enqueue({ data: company, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', { searchParams: { variant: 'paid' } }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe('application/pdf')
      expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
        .toBe('Betalningsbekraftelse-2621.pdf')
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      // The template gets the row as stored (status paid), so it is the one
      // that stamps BETALD; the route does not fake a status.
      expect(InvoicePDF).toHaveBeenCalledWith(
        expect.objectContaining({ invoice: expect.objectContaining({ status: 'paid' }) }),
      )
      // Never a document-archive read: the paid copy is always a fresh render.
      expect(mockSupabase.from).not.toHaveBeenCalledWith('invoice_deliveries')
      expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
    })

    it('keeps the invoice filename for an unknown variant value', async () => {
      enqueue({ data: paidInvoice, error: null })
      enqueue({ data: company, error: null })

      const response = await GET(
        createMockRequest('/api/invoices/invoice-1/pdf', { searchParams: { variant: 'evil' } }),
        createMockRouteParams({ id: 'invoice-1' }),
      )

      expect(response.status).toBe(200)
      expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
        .toBe('Oppy Sverige x Kund ÅÄÖ AB Faktura nr 2621 20260721.pdf')
    })
  })

  it('marks PDF generation errors as private and non-cacheable', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: company, error: null })
    renderToBufferMock.mockRejectedValueOnce(new Error('render failed'))

    const response = await GET(
      createMockRequest('/api/invoices/invoice-1/pdf'),
      createMockRouteParams({ id: 'invoice-1' }),
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
