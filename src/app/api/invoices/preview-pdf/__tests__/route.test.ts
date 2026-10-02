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
import { EXPORT_NOTICE_SV } from '@/lib/invoices/vat-rules'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const renderToBufferMock = vi.fn()
const fetchExchangeRateMock = vi.fn()

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

const prepareInvoicePdfRenderMock = vi.fn(async (company: unknown) => ({ branding: {}, company }))
vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: (...args: [unknown]) => prepareInvoicePdfRenderMock(...args),
}))

vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/currency/riksbanken')>()),
  fetchExchangeRate: (...args: unknown[]) => fetchExchangeRateMock(...args),
}))

import { POST } from '../route'
import type { InvoiceItem } from '@/types'
import type { InvoicePdfInvoice } from '@/lib/invoices/pdf-template'

const CUSTOMER_ID = '6f1c2a3e-0000-4000-8000-000000000001'
const ORIGINAL_ID = '6f1c2a3e-0000-4000-8000-000000000002'
const CASH_ACCOUNT_ID = '6f1c2a3e-0000-4000-8000-000000000003'

interface RenderProps {
  invoice: InvoicePdfInvoice
  items: InvoiceItem[]
  originalInvoiceNumber?: string
  customer: { id: string; name: string }
}

/** The props the route handed to the PDF template on the last render. */
function lastRenderProps(): RenderProps {
  const call = invoicePdfMock.mock.calls.at(-1)
  if (!call) throw new Error('InvoicePDF was not called')
  return call[0] as RenderProps
}

function previewRequest(body: unknown) {
  return POST(
    createMockRequest('/api/invoices/preview-pdf', { method: 'POST', body }),
    createMockRouteParams({}),
  )
}

describe('POST /api/invoices/preview-pdf', () => {
  const user = { id: 'user-1', email: 'owner@example.test' }
  const customer = makeCustomer({ id: CUSTOMER_ID, name: 'Kund ÅÄÖ AB' })
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
    fetchExchangeRateMock.mockResolvedValue(null)
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await previewRequest(validBody)

    expect(response.status).toBe(401)
  })

  it.each([
    ['a quantity that is not a number', { ...validBody, items: [{ ...validBody.items[0], quantity: 'två' }] }],
    ['an impossible date', { ...validBody, invoice_date: '2026-13-45' }],
    ['a customer id that is not a uuid', { ...validBody, customer_id: 'customer-1' }],
    ['an unknown document type', { ...validBody, document_type: 'receipt' }],
  ])('returns 400 for %s, before reading or rendering anything', async (_label, body) => {
    const response = await previewRequest(body)

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockSupabase.from).not.toHaveBeenCalled()
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  it('returns 404 when the customer does not exist', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: null, error: { message: 'not found' } })

    const response = await previewRequest(validBody)
    const body = await response.json()

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('INVOICE_CUSTOMER_NOT_FOUND')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  it('returns a descriptive UTF-8 filename for the PDF preview', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })

    const response = await previewRequest(validBody)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('X-Invoice-Missing')).toBeNull()
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('Oppy Sverige x Kund ÅÄÖ AB Faktura nr 2621 20260721.pdf')
  })

  it('reports the page count of the rendered PDF', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })
    renderToBufferMock.mockResolvedValue(Buffer.from(
      '%PDF-1.3\n1 0 obj << /Type /Pages /Count 2 >> endobj\n'
      + '2 0 obj << /Type /Page /Parent 1 0 R >> endobj\n'
      + '3 0 obj << /Type /Page /Parent 1 0 R >> endobj\n',
      'latin1',
    ))

    const response = await previewRequest(validBody)

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Invoice-Page-Count')).toBe('2')
  })

  it('passes valid_until through for a quote and names the file Offert', async () => {
    enqueue({ data: { ...company, bankgiro: null }, error: null })
    enqueue({ data: customer, error: null })

    const response = await previewRequest({
      ...validBody,
      invoice_number: 'OF-001',
      document_type: 'quote',
      due_date: '2026-08-20',
      valid_until: '2026-08-20',
    })

    // No payment account is needed for a quote: it is never a payment request.
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Invoice-Missing')).toBeNull()
    expect(contentDispositionFilename(response.headers.get('Content-Disposition')))
      .toBe('Oppy Sverige x Kund ÅÄÖ AB Offert nr OF-001 20260721.pdf')
    const { invoice } = lastRenderProps()
    expect(invoice.document_type).toBe('quote')
    expect(invoice.valid_until).toBe('2026-08-20')
  })

  it('leaves valid_until null on non-quote documents', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })

    const response = await previewRequest({ ...validBody, valid_until: '2026-08-20' })

    expect(response.status).toBe(200)
    expect(lastRenderProps().invoice.valid_until).toBeNull()
  })

  // The editor previews a form that is still being filled in: what is not
  // there yet renders as a placeholder and is named in X-Invoice-Missing,
  // instead of a 400 that would blank the preview.
  describe('a half-filled draft', () => {
    it('renders a draft without rows with one placeholder row and reports the rows missing', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...validBody, items: [] })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBe('rows')
      const { invoice, items } = lastRenderProps()
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ line_type: 'text', description: 'Inga rader ännu', line_total: 0 })
      expect(invoice.total).toBe(0)
    })

    it('words the placeholder row in the customer\'s language', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: { ...customer, language: 'en' }, error: null })

      const response = await previewRequest({ ...validBody, items: undefined })

      expect(response.status).toBe(200)
      expect(lastRenderProps().items[0].description).toBe('No rows yet')
    })

    it('renders a draft without a customer with the sample customer, reading no customer row', async () => {
      enqueue({ data: company, error: null })

      const response = await previewRequest({ ...validBody, customer_id: '' })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBe('customer')
      expect(lastRenderProps().customer.name).toBe('Exempel AB')
      expect(findCall('customers', 'select')).toBeUndefined()
    })

    it('names every gap, in the order the editor shows them', async () => {
      enqueue({ data: { ...company, bankgiro: null }, error: null })

      const response = await previewRequest({ invoice_number: null, items: [] })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBe('customer,rows,payee')
    })

    it('renders a foreign-currency draft the company has no account for, and reports the payee missing', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...validBody, currency: 'EUR' })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBe('payee')
      expect(renderToBufferMock).toHaveBeenCalledTimes(1)
      // The render is told not to refuse a draft without a payee.
      expect(prepareInvoicePdfRenderMock).toHaveBeenCalledWith(
        expect.anything(),
        'EUR',
        expect.objectContaining({ paymentAccountRequired: false, payee: null }),
      )
    })

    it('reports the payee missing when the only method stored does not print (Swish hidden)', async () => {
      enqueue({
        data: { ...company, bankgiro: null, swish: '1231234567', invoice_show_swish: false },
        error: null,
      })
      enqueue({ data: customer, error: null })

      const response = await previewRequest(validBody)

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBe('payee')
    })
  })

  // R12: the preview is the real render, from every field the write path
  // uses (lib/invoices/build-invoice-write.ts).
  describe('parity with the write path', () => {
    it('carries the delivery date, the öresavrundning override and the QR choice', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({
        ...validBody,
        delivery_date: '2026-07-01',
        ore_rounding: false,
        qr_mode: 'none',
      })

      expect(response.status).toBe(200)
      const { invoice } = lastRenderProps()
      expect(invoice.delivery_date).toBe('2026-07-01')
      expect(invoice.ore_rounding).toBe(false)
      expect(invoice.qr_mode).toBe('none')
      expect(response.headers.get('X-Invoice-Qr')).toBe('none:mode_none')
    })

    it('inherits the company öresavrundning when the draft states none', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      await previewRequest(validBody)

      expect(lastRenderProps().invoice.ore_rounding).toBeNull()
    })

    it('keeps text rows out of the amounts', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({
        ...validBody,
        items: [
          validBody.items[0],
          { line_type: 'text', description: 'Avser juli', quantity: 3, unit: 'st', unit_price: 999 },
          // A row being typed: cleared number fields arrive as null.
          { description: '', quantity: null, unit: 'st', unit_price: null },
        ],
      })

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(items[1]).toMatchObject({ line_type: 'text', description: 'Avser juli', line_total: 0, vat_amount: 0 })
      expect(items[2]).toMatchObject({ line_type: 'product', quantity: 0, unit_price: 0, line_total: 0 })
      expect(invoice.subtotal).toBe(14000)
      expect(invoice.total).toBe(17500)
    })

    it('applies the invoice\'s own VAT treatment: goods exported to Norway', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({
        ...validBody,
        vat_treatment: 'export',
        delivery_country: 'NO',
        items: [{ description: 'Maskin', quantity: 1, unit: 'st', unit_price: 50000 }],
      })

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(items[0].vat_rate).toBe(0)
      expect(invoice).toMatchObject({
        vat_treatment: 'export',
        moms_ruta: '36',
        reverse_charge_text: EXPORT_NOTICE_SV,
        vat_treatment_override: 'export',
        delivery_country: 'NO',
        total: 50000,
      })
    })

    it('refuses a VAT treatment the stated facts do not support, like the write path', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...validBody, vat_treatment: 'export' })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.error.code).toBe('INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })

    it('states no VAT for a seller outside the VAT register', async () => {
      enqueue({ data: { ...company, vat_registered: false }, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest(validBody)

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(items[0].vat_rate).toBe(0)
      expect(invoice).toMatchObject({ vat_treatment: 'exempt', vat_amount: 0, total: 14000, reverse_charge_text: null })
    })

    it('prints the chosen bank account', async () => {
      enqueue({ data: { ...company, bankgiro: null }, error: null })
      enqueue({
        data: {
          id: CASH_ACCOUNT_ID,
          ledger_account: '1930',
          enabled: true,
          invoice_payee: true,
          bank_name: 'SEB',
          clearing_number: null,
          account_number: null,
          bankgiro: '5050-1055',
          plusgiro: null,
          swish: null,
          payee_iban: null,
          bic: null,
          bank_code: null,
          foreign_account_number: null,
        },
        error: null,
      })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...validBody, payment_cash_account_id: CASH_ACCOUNT_ID })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBeNull()
      const { invoice } = lastRenderProps()
      expect(invoice.payment_cash_account_id).toBe(CASH_ACCOUNT_ID)
      expect(invoice.payment_details).toMatchObject({ bankgiro: '5050-1055', bank_name: 'SEB' })
      expect(prepareInvoicePdfRenderMock).toHaveBeenCalledWith(
        expect.anything(),
        'SEK',
        expect.objectContaining({ payee: expect.objectContaining({ bankgiro: '5050-1055' }) }),
      )
    })

    it('returns 400 for a chosen account that cannot be printed', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: null, error: null })

      const response = await previewRequest({ ...validBody, payment_cash_account_id: CASH_ACCOUNT_ID })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.error.code).toBe('INVOICE_PAYEE_ACCOUNT_INVALID')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })

    it('states the SEK amounts of a foreign-currency draft at the rate of its taxable date', async () => {
      const eurCompany = {
        ...company,
        invoice_payment_accounts: { EUR: { iban: 'SE4550000000058398257466', bic: 'ESSESESS' } },
      }
      enqueue({ data: eurCompany, error: null })
      enqueue({ data: customer, error: null })
      fetchExchangeRateMock.mockResolvedValue({ currency: 'EUR', rate: 11.0234, date: '2026-06-30' })

      const response = await previewRequest({
        ...validBody,
        currency: 'EUR',
        delivery_date: '2026-07-01',
        items: [{ description: 'Workshop', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 }],
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Missing')).toBeNull()
      expect(response.headers.get('X-Invoice-Exchange-Rate')).toBe('11.0234')
      expect(response.headers.get('X-Invoice-Exchange-Rate-Date')).toBe('2026-06-30')
      // The taxable event is the delivery date when it is set (ML 8 kap.).
      const [currency, date] = fetchExchangeRateMock.mock.calls[0] as [string, Date]
      expect(currency).toBe('EUR')
      expect(date.toISOString().slice(0, 10)).toBe('2026-07-01')
      expect(lastRenderProps().invoice).toMatchObject({
        exchange_rate: 11.0234,
        exchange_rate_date: '2026-06-30',
        total: 1250,
        total_sek: 13779.25,
        vat_amount_sek: 2755.85,
      })
    })

    it('renders a foreign-currency draft without SEK amounts when no rate can be fetched', async () => {
      enqueue({ data: { ...company, invoice_payment_accounts: { EUR: { iban: 'SE4550000000058398257466' } } }, error: null })
      enqueue({ data: customer, error: null })
      fetchExchangeRateMock.mockRejectedValue(new Error('Riksbanken 429'))

      const response = await previewRequest({ ...validBody, currency: 'EUR' })

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Exchange-Rate')).toBeNull()
      expect(lastRenderProps().invoice).toMatchObject({ exchange_rate: null, total_sek: null })
    })
  })

  // The credit page previews the kreditfaktura before it exists: the one
  // POST /api/invoices creates (lib/invoices/build-credit-note.ts).
  describe('credit note preview', () => {
    const original = makeInvoice({
      id: ORIGINAL_ID,
      customer_id: CUSTOMER_ID,
      invoice_number: '1043',
      status: 'sent',
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
    })
    const originalItems: InvoiceItem[] = [
      {
        id: 'item-2',
        invoice_id: ORIGINAL_ID,
        sort_order: 1,
        description: 'Resa',
        quantity: 1,
        unit: 'st',
        unit_price: 2000,
        line_total: 2000,
        vat_rate: 25,
        vat_amount: 500,
        created_at: '2026-07-01T00:00:00Z',
      },
      {
        id: 'item-1',
        invoice_id: ORIGINAL_ID,
        sort_order: 0,
        description: 'Arbete',
        quantity: 8,
        unit: 'tim',
        unit_price: 1000,
        line_total: 8000,
        vat_rate: 25,
        vat_amount: 2000,
        created_at: '2026-07-01T00:00:00Z',
      },
    ]

    it('renders the kreditfaktura of the invoice with its reason as the note', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: { ...original, items: originalItems }, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ credited_invoice_id: ORIGINAL_ID, notes: 'Fel antal timmar.' })

      expect(response.status).toBe(200)
      const { invoice, items, originalInvoiceNumber } = lastRenderProps()
      expect(originalInvoiceNumber).toBe('1043')
      expect(invoice).toMatchObject({
        invoice_number: 'KR-1043',
        credited_invoice_id: ORIGINAL_ID,
        subtotal: -10000,
        vat_amount: -2500,
        total: -12500,
        notes: 'Fel antal timmar.',
      })
      expect(items.map((item) => [item.description, item.quantity, item.line_total])).toEqual([
        ['Arbete', -8, -8000],
        ['Resa', -1, -2000],
      ])
      expect(response.headers.get('X-Invoice-Missing')).toBeNull()
      expect(contentDispositionFilename(response.headers.get('Content-Disposition'))).toContain('Kreditfaktura nr KR-1043')
    })

    it('prints the default reason when none is given', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: { ...original, items: originalItems }, error: null })
      enqueue({ data: customer, error: null })

      await previewRequest({ credited_invoice_id: ORIGINAL_ID, notes: '  ' })

      expect(lastRenderProps().invoice.notes).toBe('Krediterar faktura 1043')
    })

    it('returns 404 when the invoice to credit is not the company\'s', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: null, error: { message: 'not found' } })

      const response = await previewRequest({ credited_invoice_id: ORIGINAL_ID })
      const body = await response.json()

      expect(response.status).toBe(404)
      expect(body.error.code).toBe('INVOICE_CREDIT_ORIGINAL_NOT_FOUND')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })

    it('returns 400 for a document that is not a faktura', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: { ...original, document_type: 'quote', items: originalItems }, error: null })

      const response = await previewRequest({ credited_invoice_id: ORIGINAL_ID })
      const body = await response.json()

      expect(response.status).toBe(400)
      expect(body.error.code).toBe('INVOICE_CREDIT_NOT_INVOICE')
    })
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

      const response = await previewRequest(rutBody)

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

    it('carries the bostadsrätt fields from the claim card onto the deduction rows', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({
        ...rutBody,
        deduction_housing_designation: '',
        deduction_apartment_number: '1102',
        deduction_brf_org_number: '769600-1234',
        items: [{ ...rutBody.items[0], deduction_type: 'rot', work_type: 'MALNING' }],
      })

      expect(response.status).toBe(200)
      expect(lastRenderProps().items[0]).toMatchObject({
        apartment_number: '1102',
        brf_org_number: '769600-1234',
        housing_designation: null,
      })
    })

    it('uses the deduction base inkl. moms at the rate the line is rendered with', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      // Skatteverket worked example: 18 000 kr arbetskostnad = 22 500 kr inkl.
      // moms, ROT 30% = 6 750 kr.
      const response = await previewRequest({
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
      })

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

      const response = await previewRequest({ ...rutBody, deduction_personnummer: '' })

      expect(response.status).toBe(200)
      // The 10-digit kundkort value is expanded to 12 digits before masking,
      // so the mask carries the full birth date.
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBe('19900101-XXXX')
    })

    it('masks a 10-digit typed personnummer with the full birth date', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...rutBody, deduction_personnummer: '900101-2385' })

      expect(response.status).toBe(200)
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBe('19900101-XXXX')
    })

    it('shows no personnummer for a half-typed value that does not expand', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest({ ...rutBody, deduction_personnummer: '1990' })

      expect(response.status).toBe(200)
      expect(lastRenderProps().invoice.deduction_personnummer_masked).toBeNull()
    })

    it('leaves a non-deduction invoice unchanged', async () => {
      enqueue({ data: company, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest(validBody)

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

      const response = await previewRequest({ ...rutBody, document_type: 'proforma' })

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      expect(invoice.deduction_total).toBe(0)
      expect(invoice.deduction_personnummer_masked).toBeNull()
      expect(items[0]).toMatchObject({ deduction_type: null, deduction_amount: 0, work_type: null })
    })

    it('does not compute a deduction for a seller that is not VAT registered on VAT-free labor', async () => {
      enqueue({ data: { ...company, vat_registered: false }, error: null })
      enqueue({ data: customer, error: null })

      const response = await previewRequest(rutBody)

      expect(response.status).toBe(200)
      const { invoice, items } = lastRenderProps()
      // Base is the line total inkl. moms; with no output VAT the base is the
      // bare 2 000 kr, RUT 50% = 1 000.
      expect(items[0].vat_rate).toBe(0)
      expect(items[0].deduction_amount).toBe(1000)
      expect(invoice.deduction_total).toBe(1000)
    })
  })

  describe('payment QR code (one per invoice)', () => {
    // A bankgiro with a valid check digit and an org number: auto prints the
    // bank-app code to a business customer.
    const qrCompany = makeCompanySettings({
      company_name: 'Oppy Sverige',
      org_number: '5566778899',
      bankgiro: '5050-1055',
    })

    async function preview(body: Record<string, unknown>) {
      enqueue({ data: qrCompany, error: null })
      enqueue({ data: customer, error: null })
      return previewRequest(body)
    }

    it('renders through the one entry point and names the resolved code in X-Invoice-Qr', async () => {
      const response = await preview(validBody)

      expect(response.status).toBe(200)
      expect(response.headers.get('X-Invoice-Qr')).toBe('bank_app')
      const props = invoicePdfMock.mock.calls.at(-1)?.[0] as { paymentQr: { kind: string; vector?: unknown } }
      expect(props.paymentQr).toMatchObject({ kind: 'bank_app', vector: expect.any(Object) })
    })

    it('applies the draft\'s qr_mode and reports why it prints none', async () => {
      const response = await preview({ ...validBody, qr_mode: 'swish' })

      expect(response.status).toBe(200)
      // The company has no Swish number: an explicit swish never falls back.
      expect(response.headers.get('X-Invoice-Qr')).toBe('none:no_swish')
      expect(lastRenderProps().invoice.qr_mode).toBe('swish')
      expect((invoicePdfMock.mock.calls.at(-1)?.[0] as { paymentQr: unknown }).paymentQr).toBeNull()
    })

    it('inherits the company default when qr_mode is null or empty', async () => {
      for (const qrMode of [null, '']) {
        const response = await preview({ ...validBody, qr_mode: qrMode })
        expect(response.headers.get('X-Invoice-Qr')).toBe('bank_app')
        expect(lastRenderProps().invoice.qr_mode).toBeNull()
      }
    })

    // The settings preview (InvoicePreviewCard) renders for a real customer
    // and must send a sample number: without one the bank-app code has no
    // reference and the preview beside "QR-kod på fakturan" shows none.
    it('builds the bank-app code for a real customer only when a number is sent', async () => {
      const withoutNumber = { ...validBody, invoice_number: undefined }

      const unnumbered = await preview(withoutNumber)
      expect(unnumbered.headers.get('X-Invoice-Qr')).toBe('none:no_invoice_number')
      expect(lastRenderProps().invoice.invoice_number).toBeNull()

      const sampled = await preview({ ...withoutNumber, invoice_number: '1' })
      expect(sampled.headers.get('X-Invoice-Qr')).toBe('bank_app')
      expect(lastRenderProps().invoice.invoice_number).toBe('1')
    })

    it('returns 400 for a qr_mode that is not a mode, before rendering', async () => {
      const response = await previewRequest({ ...validBody, qr_mode: 'all_three' })

      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(renderToBufferMock).not.toHaveBeenCalled()
    })
  })

  it('marks preview generation errors as private and non-cacheable', async () => {
    enqueue({ data: company, error: null })
    enqueue({ data: customer, error: null })
    renderToBufferMock.mockRejectedValueOnce(new Error('render failed'))

    const response = await previewRequest(validBody)

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
