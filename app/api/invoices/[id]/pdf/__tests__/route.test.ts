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
